import { installGoogleFetchWall, uninstallGoogleFetchWall, resetGoogleFetch, route, callsMatching } from './support/googleFetch';
installGoogleFetchWall();
import { createFirm, testPool, request, as, tokenFor, type Firm } from '../support/setupInProcess';
import { connectGoogle, connectMicrosoft, seedMatterWithEvent, seedMapping } from './support/calendarWorld';

const googleService = require('../../src/modules/calendar/google/google.service');
const calendarEventsRepo = require('../../src/modules/calendar/calendarEvents.repository');
const strategy = require('../../src/modules/calendar/google/googleStrategy');
const outlookService = require('../../src/modules/calendar/outlook/outlook.service');
const { getAdapter } = require('../../src/modules/calendar/shared/calendarAdapters');
let firm: Firm;
beforeEach(async () => { resetGoogleFetch(); firm = await createFirm(); });
afterAll(uninstallGoogleFetchWall);

const event = (id: string, title: string) => ({
  id, summary: title, updated: '2030-01-01T00:00:00Z',
  start: { dateTime: '2026-11-10T14:00:00Z' }, end: { dateTime: '2026-11-10T15:00:00Z' },
});
const cursor = async (uid: string) => (await testPool.query(
  "select sync_cursor from user_oauth_tokens where user_id = $1 and provider = 'google'", [uid],
)).rows[0].sync_cursor;

test('Google labels the event zone without rewriting the whole calendar zone', async () => {
  const uid = await connectGoogle(firm);
  const { matterId, eventId } = await seedMatterWithEvent(firm, 'Zone hearing');
  route('/calendars/primary', { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
  route('/calendars/primary/events', { status: 200, json: { id: 'g-zone' } }, { method: 'POST' });
  const result = await googleService.createEventsFromEntity(getAdapter('matterEvent'), { lawFirmId: firm.id, matterId, id: eventId, title: 'Zone hearing', date: '2026-11-10T14:00:00Z' }, uid, 'Pacific/Auckland');
  expect(result).toHaveLength(1);
  const patches = callsMatching('/calendars/primary').filter((call) => call.method === 'PATCH');
  expect(patches).toHaveLength(0);
  expect(callsMatching('/events').find((call) => call.method === 'POST')?.body.start.timeZone).toBe('Pacific/Auckland');
});

test('Outlook uses the event zone without changing the mailbox preference', async () => {
  const uid = await connectMicrosoft(firm);
  const { matterId, eventId } = await seedMatterWithEvent(firm, 'Zone hearing');
  route('/me/mailboxSettings', { status: 200, json: {} }, { method: 'PATCH' });
  route('/me/events', { status: 200, json: { id: 'o-zone' } }, { method: 'POST' });
  const result = await outlookService.createEventsFromEntity(getAdapter('matterEvent'), { lawFirmId: firm.id, matterId, id: eventId, title: 'Zone hearing', date: '2026-11-10T14:00:00Z' }, uid, 'Pacific/Auckland');
  expect(result).toHaveLength(1);
  expect(callsMatching('/me/mailboxSettings').filter((call) => call.method === 'PATCH')).toHaveLength(0);
  expect(callsMatching('/me/events').find((call) => call.method === 'POST')?.body.start).toEqual({ dateTime: '2026-11-11T03:00:00', timeZone: 'New Zealand Standard Time' });
});

test('editing an imported Teams title preserves its online meeting body', async () => {
  const uid = await connectMicrosoft(firm);
  await testPool.query('update members set is_owner = true where law_firm_id = $1 and user_id = $2', [firm.id, uid]);
  const imported = require('../../src/modules/calendar/outlook/outlookStrategy').buildExternalEventData({
    id: 'teams-body', subject: 'Meeting', isOrganizer: true, isOnlineMeeting: true,
    body: { contentType: 'html', content: '<p>Agenda</p><div>Teams meeting: https://teams.microsoft.com/join/abc</div>' },
    onlineMeeting: { joinUrl: 'https://teams.microsoft.com/join/abc' }, attendees: [{ emailAddress: { address: 'guest@example.test' } }],
    start: { dateTime: '2026-11-10T14:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-10T15:00:00', timeZone: 'UTC' },
  });
  await calendarEventsRepo.upsert(firm.id, 'owned-teams', { ...imported, outlookId: 'teams-body', createdBy: uid });
  const row = (await testPool.query('select id from calendar_events where law_firm_id = $1', [firm.id])).rows[0];
  route('/me/events/teams-body', { status: 200, json: { isOnlineMeeting: true, body: { contentType: 'html', content: '<p>Agenda</p><div>Teams meeting: https://teams.microsoft.com/join/abc</div>' } } }, { method: 'GET' });
  route('/me/events/teams-body', { status: 200, json: { id: 'teams-body', changeKey: 'new-version' } }, { method: 'PATCH' });
  const response = await as(tokenFor({ uid })).put(`/api/lawfirms/${firm.id}/calendar-events/${row.id}`).send({ title: 'Rescheduled meeting', confirmNotifyAttendees: true });
  expect(response.status).toBe(200);
  const patch = callsMatching('/me/events/teams-body').find((call) => call.method === 'PATCH');
  expect(patch?.body.subject).toBe('Rescheduled meeting');
  expect(patch?.body.body).toBeUndefined();
});

test('Google private copies explicitly suppress guest email', async () => {
  const uid = await connectGoogle(firm);
  const { matterId, eventId } = await seedMatterWithEvent(firm, 'Private copy');
  route('/calendars/primary/events', { status: 200, json: { id: 'g-private' } }, { method: 'POST' });
  const result = await googleService.createEventsFromEntity(getAdapter('matterEvent'), { lawFirmId: firm.id, matterId, id: eventId, title: 'Private copy', date: '2026-11-10T14:00:00Z' }, uid);
  expect(result).toHaveLength(1);
  const create = callsMatching('/events').find((call) => call.method === 'POST');
  expect(new URL(create!.url).searchParams.get('sendUpdates')).toBe('none');
  expect(create!.body.attendees).toBeUndefined();
});

test('a failed inbound write preserves the Google cursor so the delta can be replayed', async () => {
  const uid = await connectGoogle(firm);
  route('syncToken=', { status: 200, json: { items: [event('failed-write', 'Retry me')], nextSyncToken: 'too-soon' } });
  const write = jest.spyOn(calendarEventsRepo, 'upsert').mockRejectedValueOnce(new Error('write unavailable'));
  try {
    await expect(googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id })).rejects.toThrow('write unavailable');
    expect(write).toHaveBeenCalled();
    expect(await cursor(uid)).toBe('token-seed');
  } finally { write.mockRestore(); }
  await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });
  expect(await cursor(uid)).toBe('too-soon');
  expect((await testPool.query('select title from calendar_events where law_firm_id = $1', [firm.id])).rows).toEqual([{ title: 'Retry me' }]);
});

test('a failed full recovery does not commit its Google baseline', async () => {
  const uid = await connectGoogle(firm);
  route('syncToken=', { status: 410 });
  route('maxResults=2500', { status: 200, json: { nextSyncToken: 'baseline' } });
  route('timeMin=', { status: 200, json: { items: [event('write-failure', 'Must replay')] } });
  const write = jest.spyOn(calendarEventsRepo, 'upsert').mockRejectedValue(new Error('storage unavailable'));
  try {
    await expect(googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id })).rejects.toThrow('storage unavailable');
    expect(write).toHaveBeenCalled();
    expect(await cursor(uid)).not.toBe('baseline');
  } finally { write.mockRestore(); }
});

test('colleagues importing the same Google invitation keep separate owned rows', async () => {
  const first = await connectGoogle(firm);
  const second = await connectGoogle(firm);
  route('syncToken=', { status: 200, json: { items: [{ ...event('shared-invite', 'Team meeting'), iCalUID: 'invite@example.test' }], nextSyncToken: 'after' } });
  await googleService.processWatchNotification({ userId: first, lawFirmId: firm.id });
  await googleService.processWatchNotification({ userId: second, lawFirmId: firm.id });
  const rows = (await testPool.query('select created_by from calendar_events where law_firm_id = $1 order by created_by', [firm.id])).rows;
  expect(rows.map((row) => row.created_by)).toEqual([first, second].sort());
});

test('HTML Google notes preserve text and join links for all three inbound builders', () => {
  const input = { ...event('html', 'Rich notes'), description: '<b>Agenda</b><br><a href="https://meet.google.com/abc">Join</a>' };
  const expected = 'Agenda\nJoin (https://meet.google.com/abc)';
  expect(strategy.buildTaskUpdateData(input, 'x').description).toBe(expected);
  expect(strategy.buildMappedEventUpdateData(input, 'x').notes).toBe(expected);
  expect(strategy.buildExternalEventData(input).notes).toBe(expected);
});

test('Google location changes reach the mapped matter event', async () => {
  const uid = await connectGoogle(firm);
  const { matterId, eventId } = await seedMatterWithEvent(firm, 'Hearing');
  await seedMapping({ externalEventId: 'location-edit', lawFirmId: firm.id, userId: uid, entityId: eventId, scopeId: matterId });
  route('syncToken=', { status: 200, json: { items: [{ ...event('location-edit', 'Hearing'), location: 'Courtroom 8' }], nextSyncToken: 'after' } });
  await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });
  expect(callsMatching('syncToken=')).toHaveLength(1);
  expect((await testPool.query('select location from events where id = $1', [eventId])).rows[0].location).toBe('Courtroom 8');
});

test('a verified Google delivery is durable before processing begins', async () => {
  const uid = await connectGoogle(firm);
  await testPool.query("insert into calendar_subscriptions (provider, id, user_id, law_firm_id, calendar_id, resource, secret, expiration) values ('google', 'audit-channel', $1, $2, 'primary', 'resource', 'secret', now() + interval '1 day')", [uid, firm.id]);
  let queued = 0;
  const process = jest.spyOn(googleService, 'processWatchNotification').mockImplementation(async () => {
    queued = (await testPool.query("select count(*)::int as n from calendar_sync_failures where kind = 'webhook' and user_id = $1", [uid])).rows[0].n;
    throw new Error('worker interrupted');
  });
  try {
    const response = await request().post('/api/webhooks/google-calendar').set({
      'x-goog-channel-id': 'audit-channel', 'x-goog-channel-token': 'secret', 'x-goog-resource-state': 'exists',
    });
    expect(response.status).toBe(200);
    expect(process).toHaveBeenCalled();
    expect(queued).toBe(1);
    expect((await testPool.query("select count(*)::int as n from calendar_sync_failures where kind = 'webhook' and user_id = $1", [uid])).rows[0].n).toBe(1);
  } finally { process.mockRestore(); }
});

test('verified Outlook deliveries are durable before their event is fetched', async () => {
  const uid = await connectGoogle(firm);
  await testPool.query("insert into calendar_subscriptions (provider, id, user_id, law_firm_id, resource, secret, expiration) values ('outlook', 'audit-outlook', $1, $2, 'me/events', 'secret', now() + interval '1 day')", [uid, firm.id]);
  const repoint = jest.spyOn(outlookService, 'repointStaleSubscription').mockResolvedValue(false);
  let queued = 0;
  const process = jest.spyOn(outlookService, 'processSubscriptionNotification').mockImplementation(async () => {
    queued = (await testPool.query("select count(*)::int as n from calendar_sync_failures where kind = 'webhook' and user_id = $1", [uid])).rows[0].n;
    throw new Error('worker interrupted');
  });
  try {
    const response = await request().post('/api/webhooks/outlook-calendar').send({ value: [{
      subscriptionId: 'audit-outlook', clientState: 'secret', changeType: 'updated', resourceData: { id: 'o-event' },
    }] });
    expect(response.status).toBe(202);
    expect(process).toHaveBeenCalled();
    expect(queued).toBe(1);
  } finally { process.mockRestore(); repoint.mockRestore(); }
});

test('expired-cursor recovery takes its baseline before the full read and commits it afterwards', async () => {
  const uid = await connectGoogle(firm);
  const order: string[] = [];
  route('syncToken=', { status: 410 });
  route('maxResults=2500&showDeleted=true', () => {
    order.push('baseline');
    return { status: 200, json: { items: [], nextSyncToken: 'baseline-token' } };
  });
  route('timeMin=', async () => {
    order.push('full');
    expect(await cursor(uid)).toBeNull();
    return { status: 200, json: { items: [event('recovered', 'Recovered')] } };
  });
  await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });
  expect(order).toEqual(['baseline', 'full']);
  expect(await cursor(uid)).toBe('baseline-token');
});

test('a capped Google delta resumes at the next page instead of rereading its first fifty pages', async () => {
  const uid = await connectGoogle(firm);
  route('syncToken=', (call, hit) => {
    if (hit < 50) return { status: 200, json: { items: [], nextPageToken: `page-${hit + 1}` } };
    expect(call.url).toContain('pageToken=page-50');
    return { status: 200, json: { items: [event('tail', 'After page fifty')], nextSyncToken: 'finished' } };
  });
  await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });
  expect(await cursor(uid)).toBe('token-seed');
  await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });
  expect(await cursor(uid)).toBe('finished');
  expect((await testPool.query('select title from calendar_events where law_firm_id = $1', [firm.id])).rows).toEqual([{ title: 'After page fifty' }]);
});

test('an unchanged pushed version is an echo but a new version immediately afterwards is a real edit', async () => {
  const uid = await connectGoogle(firm);
  const { matterId, eventId } = await seedMatterWithEvent(firm, 'Original');
  await seedMapping({ externalEventId: 'versioned', lawFirmId: firm.id, userId: uid, entityId: eventId, scopeId: matterId });
  await testPool.query("update calendar_mappings set pushed_version = 'v1' where external_event_id = 'versioned'");
  await testPool.query('update events set last_synced_to_google = now() where id = $1', [eventId]);
  route('syncToken=', [
    { status: 200, json: { items: [{ ...event('versioned', 'Echo'), etag: 'v1' }], nextSyncToken: 'after-echo' } },
    { status: 200, json: { items: [{ ...event('versioned', 'User edit'), etag: 'v2' }], nextSyncToken: 'after-edit' } },
  ]);
  await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });
  expect((await testPool.query('select title from events where id = $1', [eventId])).rows[0].title).toBe('Original');
  await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });
  expect((await testPool.query('select title from events where id = $1', [eventId])).rows[0].title).toBe('User edit');
});

test('the imported meeting feed carries organizer, RSVP, privacy, links and its original zone', async () => {
  const uid = await connectGoogle(firm);
  route('syncToken=', { status: 200, json: { items: [{
    ...event('meeting-details', 'Meeting'), visibility: 'private', status: 'tentative',
    organizer: { email: 'organizer@example.test', displayName: 'Organizer' },
    attendees: [{ email: 'guest@example.test', self: true, responseStatus: 'needsAction' }],
    hangoutLink: 'https://meet.google.com/abc', htmlLink: 'https://calendar.google.com/calendar/event?eid=abc',
    start: { dateTime: '2026-11-10T14:00:00Z', timeZone: 'America/New_York' },
  }], nextSyncToken: 'details' } });
  await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });
  const response = await as(tokenFor({ uid })).get(`/api/lawfirms/${firm.id}/calendar-events`);
  expect(response.status).toBe(200);
  expect(response.body.events).toHaveLength(1);
  expect(response.body.events[0]).toMatchObject({
    startTimeZone: 'America/New_York',
    meeting: {
      organizer: { email: 'organizer@example.test', displayName: 'Organizer' },
      attendees: [{ email: 'guest@example.test', responseStatus: 'needsAction', isSelf: true }],
      responseStatus: 'needsAction', status: 'tentative', isPrivate: true, isOrganizer: false,
      joinUrl: 'https://meet.google.com/abc', providerUrl: 'https://calendar.google.com/calendar/event?eid=abc',
    },
  });
});

test('provider edits durably fan out to assigned colleagues before advancing the cursor', async () => {
  const uid = await connectGoogle(firm);
  const colleague = await connectGoogle(firm);
  const { matterId, eventId } = await seedMatterWithEvent(firm, 'Original');
  for (const userId of [uid, colleague]) {
    await testPool.query('insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)', [firm.id, matterId, userId]);
    await testPool.query('insert into event_assignees (law_firm_id, event_id, user_id) values ($1, $2, $3)', [firm.id, eventId, userId]);
  }
  await seedMapping({ provider: 'google', externalEventId: 'edited-copy', lawFirmId: firm.id, userId: uid, entityId: eventId, scopeId: matterId });
  route('syncToken=', { status: 200, json: { items: [event('edited-copy', 'Provider update')], nextSyncToken: 'fanout-durable' } });
  await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });
  expect(await cursor(uid)).toBe('fanout-durable');
  const work = await testPool.query("select payload from calendar_sync_failures where kind = 'outbound' and user_id = $1", [colleague]);
  expect(work.rows).toHaveLength(1);
  expect(work.rows[0].payload.entityData.title).toBe('Provider update');
});

test('dedicated Google calendars are identified by stored id rather than display name', async () => {
  const uid = await connectGoogle(firm);
  route('/users/me/calendarList', { status: 200, json: { items: [{ id: 'unrelated', summary: 'Paralegix' }] } });
  route('/calendars', { status: 200, json: { id: 'dedicated-new', summary: 'Paralegix' } }, { method: 'POST' });
  const initialized = await googleService.initParalegixCalendar(uid, 'UTC');
  expect(initialized.calendar.id).toBe('dedicated-new');
  expect(callsMatching('/calendars').filter((call) => call.method === 'POST')).toHaveLength(1);
  expect(callsMatching('/users/me/calendarList')).toHaveLength(0);
});

test('failed imported meeting writes surface errors and retain durable retry work', async () => {
  const uid = await connectGoogle(firm);
  await testPool.query('update members set is_owner = true where law_firm_id = $1 and user_id = $2', [firm.id, uid]);
  await calendarEventsRepo.upsert(firm.id, 'owned-retry', { title: 'Imported', googleEventId: 'g-write-retry', start: '2026-11-10T14:00:00Z', createdBy: uid });
  const row = (await testPool.query('select id from calendar_events where law_firm_id = $1', [firm.id])).rows[0];
  route('/events/g-write-retry', { status: 503 }, { method: 'PATCH' });
  const updated = await as(tokenFor({ uid })).put(`/api/lawfirms/${firm.id}/calendar-events/${row.id}`).send({ title: 'Keep this edit' });
  expect(updated.status).toBe(503);
  expect((await testPool.query("select payload from calendar_sync_failures where kind = 'outbound' and user_id = $1", [uid])).rows[0].payload.entityData.title).toBe('Keep this edit');
  route('/events/g-write-retry', { status: 503 }, { method: 'DELETE' });
  const deleted = await as(tokenFor({ uid })).delete(`/api/lawfirms/${firm.id}/calendar-events/${row.id}`);
  expect(deleted.status).toBe(503);
  expect((await testPool.query('select title from calendar_events where id = $1', [row.id])).rows).toEqual([{ title: 'Keep this edit' }]);
  expect((await testPool.query("select payload from calendar_sync_failures where kind = 'outbound' and user_id = $1", [uid])).rows[0].payload.action).toBe('deleteEventsFromEntity');
});

test('a Google webhook lock timeout is retried instead of acknowledged as processed', async () => {
  const uid = await connectGoogle(firm);
  const locks = require('../../src/shared/database/advisoryLock');
  const held = jest.spyOn(locks, 'withLock').mockRejectedValueOnce(new locks.AdvisoryLockTimeoutError('CALENDAR_WEBHOOK', uid));
  try {
    await expect(googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id })).rejects.toBeInstanceOf(locks.AdvisoryLockTimeoutError);
    expect(await cursor(uid)).toBe('token-seed');
  } finally { held.mockRestore(); }
});

test('disconnect can remove mapped Paralegix copies while preserving other calendar entries', async () => {
  const uid = await connectGoogle(firm);
  const { matterId, eventId } = await seedMatterWithEvent(firm, 'Remove my copy');
  await seedMapping({ provider: 'google', externalEventId: 'g-disconnect-copy', lawFirmId: firm.id, userId: uid, entityId: eventId, scopeId: matterId });
  await calendarEventsRepo.upsert(firm.id, 'personal-import', { title: 'Personal meeting', googleEventId: 'g-personal', createdBy: uid, start: '2026-11-10T14:00:00Z' });
  route('/events/g-disconnect-copy', { status: 204 }, { method: 'DELETE' });
  route('oauth2.googleapis.com/revoke', { status: 200 }, { method: 'POST' });
  const result = await as(tokenFor({ uid })).post('/api/auth/unlink-google').send({ removeParalegixEvents: true });
  expect(result.status).toBe(200);
  expect(callsMatching('/events/').filter((call) => call.method === 'DELETE').map((call) => new URL(call.url).pathname.split('/').pop())).toEqual(['g-disconnect-copy']);
  expect((await testPool.query('select 1 from calendar_mappings where user_id = $1', [uid])).rowCount).toBe(0);
  expect((await testPool.query("select 1 from user_oauth_tokens where user_id = $1 and provider = 'google'", [uid])).rowCount).toBe(0);
});

test.each(['google', 'outlook'])('sync existing skips cancelled, completed and past saved events for %s', async (provider) => {
  const uid = provider === 'google' ? await connectGoogle(firm) : await connectMicrosoft(firm);
  await testPool.query('update members set is_owner = true where law_firm_id = $1 and user_id = $2', [firm.id, uid]);
  const ids: string[] = [];
  let matterId = '';
  for (const [title, status, date] of [['Cancelled', 'cancelled', '2030-11-10T14:00:00Z'], ['Completed', 'completed', '2030-11-10T14:00:00Z'], ['Past', 'upcoming', '2020-11-10T14:00:00Z'], ['Future', 'upcoming', '2030-11-10T14:00:00Z']]) {
    const seeded = await seedMatterWithEvent(firm, title, {}, uid);
    matterId = seeded.matterId;
    await testPool.query('update events set status = $1, date = $2 where id = $3', [status, date, seeded.eventId]);
    ids.push(seeded.eventId);
  }
  route('/calendars/primary/events', { status: 200, json: { id: 'g-future' } }, { method: 'POST' });
  route('/me/events', { status: 200, json: { id: 'o-future' } }, { method: 'POST' });
  const events = (await testPool.query('select id, matter_id from events where law_firm_id = $1', [firm.id])).rows.map((row) => ({ eventId: row.id, matterId: row.matter_id, lawFirmId: firm.id, title: 'Forged active state', date: '2030-11-10', status: 'upcoming' }));
  const response = await as(tokenFor({ uid })).post(`/api/${provider === 'google' ? 'google-calendar-sync/sync-events-to-google' : 'outlook-calendar-sync/sync-events-to-outlook'}`).send({ events });
  expect(response.status).toBe(200);
  expect(response.body.syncedCount).toBe(1);
  const copies = (await testPool.query('select entity_id from calendar_mappings where user_id = $1', [uid])).rows;
  expect(copies).toEqual([{ entity_id: ids[3] }]);
  void matterId;
});

test.each(['google', 'outlook'])('%s retries a rate limit without refreshing the grant', async (provider) => {
  const uid = provider === 'google' ? await connectGoogle(firm) : await connectMicrosoft(firm);
  await testPool.query('update members set is_owner = true where law_firm_id = $1 and user_id = $2', [firm.id, uid]);
  const path = provider === 'google' ? '/users/me/calendarList' : '/me/calendars';
  route(path, [{ status: 429, headers: { 'Retry-After': '0' } }, { status: 200, json: provider === 'google' ? { items: [{ id: 'primary', summary: 'My calendar' }] } : { value: [{ id: 'primary', name: 'My calendar' }] } }]);
  const response = await as(tokenFor({ uid })).get(`/api/${provider}-calendar-sync/calendars`);
  expect(response.status).toBe(200);
  expect(callsMatching(path)).toHaveLength(2);
  expect(callsMatching('oauth2.googleapis.com/token')).toHaveLength(0);
  expect(callsMatching('login.microsoftonline.com')).toHaveLength(0);
});

test('a timed task edited near midnight retains its saved day zone when Google omits the zone', async () => {
  const uid = await connectGoogle(firm);
  const task = (await testPool.query(`insert into tasks (id, law_firm_id, title, status, due_date, due_at, due_date_timezone, all_day, created_by)
    values (gen_random_uuid(), $1, 'Late call', 'open', '2026-11-10', '2026-11-11T04:30:00Z', 'America/New_York', false, $2) returning id`, [firm.id, uid])).rows[0];
  await require('../../src/modules/calendar/shared/calendarSync.repository').saveMapping({ provider: 'google', externalEventId: 'late-task', userId: uid, lawFirmId: firm.id, entityType: 'task', entityId: task.id, itemKey: 'dueDate' });
  route('syncToken=', { status: 200, json: { items: [{ ...event('late-task', 'Late call moved'), start: { dateTime: '2026-11-12T04:30:00Z' } }], nextSyncToken: 'midnight' } });
  await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });
  const saved = (await testPool.query('select due_date::text, due_date_timezone, due_at from tasks where id = $1', [task.id])).rows[0];
  expect(saved.due_date).toBe('2026-11-11');
  expect(saved.due_date_timezone).toBe('America/New_York');
  expect(saved.due_at.toISOString()).toBe('2026-11-12T04:30:00.000Z');
});

test('a durable retry removes a task completed after the write was queued', async () => {
  const uid = await connectGoogle(firm);
  await testPool.query('update members set is_owner = true where law_firm_id = $1 and user_id = $2', [firm.id, uid]);
  const task = (await testPool.query(`insert into tasks (id, law_firm_id, title, status, due_date, due_at, created_by)
    values (gen_random_uuid(), $1, 'Completed call', 'completed', '2030-11-10', '2030-11-10T14:00:00Z', $2) returning id`, [firm.id, uid])).rows[0];
  const repo = require('../../src/modules/calendar/shared/calendarSync.repository');
  await repo.saveMapping({ provider: 'google', externalEventId: 'completed-retry', userId: uid, lawFirmId: firm.id, entityType: 'task', entityId: task.id, itemKey: 'dueDate', calendarId: 'primary' });
  const work = await repo.recordOutboundWork({ provider: 'google', userId: uid, entityType: 'task', entityData: { id: task.id, lawFirmId: firm.id, title: 'Old state', status: 'open', dueDate: '2030-11-10T14:00:00Z' }, action: 'updateEventsFromEntity' });
  route('/calendars/primary/events/completed-retry', { status: 204 }, { method: 'DELETE' });
  await require('../../src/modules/calendar/shared/calendarOutboundRetry').dispatchOutboundWork(work.dedupeKey, { refreshEntity: true });
  expect(callsMatching('completed-retry').map((call) => call.method)).toEqual(['DELETE']);
  expect((await testPool.query('select external_event_id from calendar_mappings where entity_id = $1', [task.id])).rows).toEqual([]);
});

test('Google task changes queue the saved assignee instead of only its creator', async () => {
  const uid = await connectGoogle(firm);
  const colleague = await connectGoogle(firm);
  const task = (await testPool.query(`insert into tasks (id, law_firm_id, title, status, due_date, due_at, created_by)
    values (gen_random_uuid(), $1, 'Assigned call', 'open', '2030-11-10', '2030-11-10T14:00:00Z', $2) returning id`, [firm.id, uid])).rows[0];
  await testPool.query('insert into task_assignees (law_firm_id, task_id, user_id) values ($1,$2,$3)', [firm.id, task.id, colleague]);
  await require('../../src/modules/calendar/shared/calendarSync.repository').saveMapping({ provider: 'google', externalEventId: 'assigned-task', userId: uid, lawFirmId: firm.id, entityType: 'task', entityId: task.id, itemKey: 'dueDate' });
  route('syncToken=', { status: 200, json: { items: [event('assigned-task', 'Changed assigned call')], nextSyncToken: 'assigned' } });
  await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });
  const work = (await testPool.query("select user_id, payload from calendar_sync_failures where law_firm_id = $1 and kind = 'outbound' and user_id = $2", [firm.id, colleague])).rows;
  expect(work).toHaveLength(1);
  expect(work[0].payload.entityData.title).toBe('Changed assigned call');
});

test.each(['google', 'outlook'])('%s imports a changed hearing location and event time zone', async (provider) => {
  const uid = provider === 'google' ? await connectGoogle(firm) : await connectMicrosoft(firm);
  // A provider edit to a matter event is written only for a member who may edit it.
  await testPool.query('update members set is_owner = true where law_firm_id = $1 and user_id = $2', [firm.id, uid]);
  const { matterId, eventId } = await seedMatterWithEvent(firm, 'Moved hearing');
  await seedMapping({ provider: provider as 'google' | 'outlook', externalEventId: 'moved-venue', userId: uid, lawFirmId: firm.id, entityId: eventId, scopeId: matterId });
  const changed = provider === 'google'
    ? { ...event('moved-venue', 'Moved hearing'), location: 'Room 4', start: { dateTime: '2030-11-10T14:00:00Z', timeZone: 'Pacific/Auckland' } }
    : { id: 'moved-venue', subject: 'Moved hearing', lastModifiedDateTime: '2030-01-01T00:00:00Z', location: { displayName: 'Room 4' }, start: { dateTime: '2030-11-10T14:00:00', timeZone: 'UTC' }, originalStartTimeZone: 'New Zealand Standard Time' };
  if (provider === 'google') {
    route('syncToken=', { status: 200, json: { items: [changed], nextSyncToken: 'venue' } });
    await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });
  } else {
    await require('../../src/modules/calendar/shared/providerSyncEngine').createEngine(require('../../src/modules/calendar/outlook/outlookStrategy')).upsertExternalEvent(changed, firm.id, uid, null);
  }
  const row = (await testPool.query('select location, time_zone from events where id = $1', [eventId])).rows[0];
  expect(row.location).toBe('Room 4');
  expect(row.time_zone).toBe('Pacific/Auckland');
});

test('switching calendars durably moves an owned copy and catches up on missed changes', async () => {
  const uid = await connectGoogle(firm);
  const { matterId, eventId } = await seedMatterWithEvent(firm, 'Move my copy');
  await testPool.query('update events set created_by = $1 where id = $2', [uid, eventId]);
  await seedMapping({ externalEventId: 'old-calendar-copy', userId: uid, lawFirmId: firm.id, entityId: eventId, scopeId: matterId });
  await testPool.query("update users set preferences = '{\"googleCalendarTarget\":\"default\",\"paralegixGoogleCalendarId\":\"new-calendar\"}'::jsonb where id = $1", [uid]);
  await testPool.query("update user_oauth_tokens set app_calendar_id = 'new-calendar' where user_id = $1 and provider = 'google'", [uid]);
  const response = await as(tokenFor({ uid })).post(`/api/settings/user?lawFirmId=${firm.id}`).send({ preferences: { googleCalendarTarget: 'paralegix' } });
  expect(response.status).toBe(200);
  const repo = require('../../src/modules/calendar/shared/calendarSync.repository');
  const work = (await testPool.query("select dedupe_key from calendar_sync_failures where kind = 'outbound' and user_id = $1", [uid])).rows;
  expect(work).toHaveLength(1);
  route('/calendars/primary/events/old-calendar-copy', { status: 204 }, { method: 'DELETE' });
  route('/calendars/new-calendar/events', { status: 200, json: { id: 'new-calendar-copy' } }, { method: 'POST' });
  await require('../../src/modules/calendar/shared/calendarOutboundRetry').dispatchOutboundWork(work[0].dedupe_key, { refreshEntity: true });
  expect(callsMatching('old-calendar-copy').map((call) => call.method)).toEqual(['DELETE']);
  const mapping = await repo.findMappingForEntityItem({ provider: 'google', userId: uid, entityType: 'matterEvent', entityId: eventId, itemKey: 'event' });
  expect(mapping.externalEventId).toBe('new-calendar-copy');
  expect(mapping.calendarId).toBe('new-calendar');
  expect((await testPool.query("select payload->>'changeType' as change from calendar_sync_failures where kind = 'webhook' and user_id = $1", [uid])).rows).toEqual([{ change: 'catch_up' }]);
});

describe('the kinds of durable calendar work', () => {
  /**
   * Every kind the table accepts has a writer and a retry policy. Goes red if
   * a kind nothing writes or retries is allowed back in: a row of it would sit
   * in the queue with no sweep that ever reads it.
   */
  it('accepts the kinds the retry sweeps read and refuses an unused one', async () => {
    for (const kind of ['webhook', 'stop_channel', 'outbound']) {
      const accepted = await testPool.query(
        `insert into calendar_sync_failures (kind, dedupe_key) values ($1, $2)`, [kind, `kind-check-${kind}`],
      );
      expect(accepted.rowCount).toBe(1);
    }
    await expect(testPool.query(
      `insert into calendar_sync_failures (kind, dedupe_key) values ('notification', 'kind-check-notification')`,
    )).rejects.toMatchObject({ code: '23514', constraint: 'calendar_sync_failures_kind_check' });
  });
});
