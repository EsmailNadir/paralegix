import { installGoogleFetchWall, uninstallGoogleFetchWall, resetGoogleFetch, route, callsMatching } from './support/googleFetch';
installGoogleFetchWall();
import { createFirm, testPool, as, tokenFor, type Firm } from '../support/setupInProcess';
import { connectGoogle, connectMicrosoft, seedMatterWithEvent, seedMapping, describeNetworkWall } from './support/calendarWorld';

const calendarEventsRepo = require('../../src/modules/calendar/calendarEvents.repository');
const outbound = require('../../src/modules/calendar/shared/calendarOutboundRetry');
const syncRepo = require('../../src/modules/calendar/shared/calendarSync.repository');
let firm: Firm;
beforeEach(async () => { resetGoogleFetch(); firm = await createFirm(); });
afterAll(uninstallGoogleFetchWall);
describeNetworkWall();

test.each(['google', 'outlook'])('editing a source %s meeting never makes disconnect cleanup own it', async (provider) => {
  const uid = provider === 'google' ? await connectGoogle(firm) : await connectMicrosoft(firm);
  await testPool.query('update members set is_owner = true where law_firm_id = $1 and user_id = $2', [firm.id, uid]);
  await calendarEventsRepo.upsert(firm.id, 'personal-source', {
    title: 'Personal meeting', provider, createdBy: uid, start: '2026-11-10T14:00:00Z',
    ...(provider === 'google' ? { googleEventId: 'personal-source-id' } : { outlookId: 'personal-source-id' }),
  });
  const row = (await testPool.query('select id from calendar_events where law_firm_id = $1', [firm.id])).rows[0];
  route('/events/personal-source-id', { status: 200, json: { id: 'personal-source-id', etag: 'edited', changeKey: 'edited' } }, { method: 'PATCH' });
  const updated = await as(tokenFor({ uid })).put(`/api/lawfirms/${firm.id}/calendar-events/${row.id}`).send({ title: 'Edited personal meeting' });
  expect(updated.status).toBe(200);
  expect(callsMatching('/events/personal-source-id').find((call) => call.method === 'PATCH')?.body[provider === 'google' ? 'summary' : 'subject']).toBe('Edited personal meeting');

  const { matterId, eventId } = await seedMatterWithEvent(firm, 'Owned copy');
  await seedMapping({ provider: provider as 'google' | 'outlook', externalEventId: 'owned-copy-id', lawFirmId: firm.id, userId: uid, entityId: eventId, scopeId: matterId });
  route('/events/owned-copy-id', { status: 204 }, { method: 'DELETE' });
  route('/events/personal-source-id', { status: 204 }, { method: 'DELETE' });
  route('oauth2.googleapis.com/revoke', { status: 200 }, { method: 'POST' });
  const disconnected = await as(tokenFor({ uid })).post(`/api/auth/unlink-${provider === 'google' ? 'google' : 'microsoft'}`).send({ removeParalegixEvents: true });
  expect(disconnected.status).toBe(200);
  expect(callsMatching('/events/').filter((call) => call.method === 'DELETE').map((call) => new URL(call.url).pathname.split('/').pop())).toEqual(['owned-copy-id']);
  expect((await testPool.query('select 1 from calendar_mappings where user_id = $1', [uid])).rowCount).toBe(0);
});

test.each(['google', 'outlook'])('%s retains deletion work when its ownership lookup fails', async (provider) => {
  const uid = provider === 'google' ? await connectGoogle(firm) : await connectMicrosoft(firm);
  const { matterId, eventId } = await seedMatterWithEvent(firm, 'Delete safely');
  await seedMapping({ provider: provider as 'google' | 'outlook', externalEventId: 'lookup-copy', lawFirmId: firm.id, userId: uid, entityId: eventId, scopeId: matterId });
  const work = await syncRepo.recordOutboundWork({ provider, userId: uid, entityType: 'matterEvent', action: 'deleteEventsFromEntity', entityData: { lawFirmId: firm.id, matterId, id: eventId } });
  const realLookup = syncRepo.listMappingsForEntityUser;
  const lookup = jest.spyOn(syncRepo, 'listMappingsForEntityUser')
    .mockImplementationOnce(realLookup)
    .mockRejectedValueOnce(new Error('ownership lookup unavailable'));
  try {
    await expect(outbound.dispatchOutboundWork(work.dedupeKey)).rejects.toThrow('ownership lookup unavailable');
    expect(lookup).toHaveBeenCalledTimes(2);
    expect((await testPool.query("select attempts from calendar_sync_failures where kind = 'outbound' and dedupe_key = $1", [work.dedupeKey])).rows).toEqual([{ attempts: 1 }]);
    expect((await testPool.query('select 1 from calendar_mappings where external_event_id = $1', ['lookup-copy'])).rowCount).toBe(1);
  } finally { lookup.mockRestore(); }
  route('/events/lookup-copy', { status: 204 }, { method: 'DELETE' });
  await outbound.dispatchOutboundWork(work.dedupeKey);
  expect(callsMatching('/events/lookup-copy').filter((call) => call.method === 'DELETE')).toHaveLength(1);
  expect((await testPool.query("select 1 from calendar_sync_failures where kind = 'outbound' and dedupe_key = $1", [work.dedupeKey])).rowCount).toBe(0);
});

test.each(['queue', 'capabilities'])('a failed inbound fanout %s read keeps its cursor and queues the saved state when retried', async (failurePoint) => {
  const uid = await connectGoogle(firm);
  await testPool.query('update members set is_owner = true where law_firm_id = $1 and user_id = $2', [firm.id, uid]);
  const { matterId, eventId } = await seedMatterWithEvent(firm, 'Before inbound edit');
  await testPool.query('update events set created_by = $1 where id = $2', [uid, eventId]);
  // The trigger stamps updated_at on writes, so the first provider edit must
  // follow the existing row, and its retry must follow the committed edit.
  const current = (await testPool.query('select updated_at from events where id = $1', [eventId])).rows[0].updated_at;
  const modified = new Date(current.getTime() + 1).toISOString();
  await seedMapping({ externalEventId: 'fanout-source', lawFirmId: firm.id, userId: uid, entityId: eventId, scopeId: matterId });
  route('syncToken=', { status: 200, json: { items: [{ id: 'fanout-source', summary: 'Saved inbound edit', updated: modified,
    start: { dateTime: '2026-11-10T14:00:00Z' }, end: { dateTime: '2026-11-10T15:00:00Z' } }], nextSyncToken: 'fanout-committed' } });
  const persist = failurePoint === 'queue'
    ? jest.spyOn(syncRepo, 'recordOutboundWork').mockRejectedValueOnce(new Error('fanout queue unavailable'))
    : jest.spyOn(require('../../src/modules/calendar/shared/calendarTokens'), 'getOutboundSyncCapabilities').mockRejectedValueOnce(new Error('fanout queue unavailable'));
  try {
    await expect(require('../../src/modules/calendar/google/google.service').processWatchNotification({ userId: uid, lawFirmId: firm.id })).rejects.toThrow('fanout queue unavailable');
    expect(persist).toHaveBeenCalled();
    expect((await testPool.query("select sync_cursor from user_oauth_tokens where user_id = $1 and provider = 'google'", [uid])).rows[0].sync_cursor).toBe('token-seed');
    expect((await testPool.query('select title from events where id = $1', [eventId])).rows[0].title).toBe('Saved inbound edit');
    expect((await testPool.query('select updated_at from events where id = $1', [eventId])).rows[0].updated_at.getTime()).toBeGreaterThan(new Date(modified).getTime());
  } finally { persist.mockRestore(); }
  await require('../../src/modules/calendar/google/google.service').processWatchNotification({ userId: uid, lawFirmId: firm.id });
  expect((await testPool.query("select payload from calendar_sync_failures where kind = 'outbound' and user_id = $1", [uid])).rows[0].payload.entityData.title).toBe('Saved inbound edit');
  expect((await testPool.query("select sync_cursor from user_oauth_tokens where user_id = $1 and provider = 'google'", [uid])).rows[0].sync_cursor).toBe('fanout-committed');
});

test.each(['PUT', 'DELETE'])('%s queues both linked calendars even when Google fails first', async (method) => {
  const uid = await connectGoogle(firm);
  await testPool.query('update members set is_owner = true where law_firm_id = $1 and user_id = $2', [firm.id, uid]);
  await testPool.query(`insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, is_sync_to_provider, meta)
    values ($1, 'microsoft', 'microsoft-access', 'microsoft-refresh', true, '{"outlookTimezone":"America/New_York"}')`, [uid]);
  await calendarEventsRepo.upsert(firm.id, 'linked-source', {
    title: 'Linked meeting', provider: 'google', createdBy: uid, start: '2026-11-10T14:00:00Z', googleEventId: 'google-linked', outlookId: 'outlook-linked',
  });
  const row = (await testPool.query('select id from calendar_events where law_firm_id = $1', [firm.id])).rows[0];
  const providerMethod = method === 'PUT' ? 'PATCH' : 'DELETE';
  route('/events/google-linked', { status: 503 }, { method: providerMethod });
  route('/events/outlook-linked', { status: 503 }, { method: providerMethod });
  const client = as(tokenFor({ uid }));
  const result = method === 'PUT'
    ? await client.put(`/api/lawfirms/${firm.id}/calendar-events/${row.id}`).send({ title: 'Changed linked meeting' })
    : await client.delete(`/api/lawfirms/${firm.id}/calendar-events/${row.id}`);
  expect(result.status).toBe(503);
  expect(callsMatching('/events/google-linked').some((call) => call.method === providerMethod)).toBe(true);
  const queued = (await testPool.query("select provider, payload from calendar_sync_failures where kind = 'outbound' and user_id = $1 order by provider", [uid])).rows;
  expect(queued.map((work) => work.provider)).toEqual(['google', 'outlook']);

  resetGoogleFetch();
  route('/events/google-linked', { status: method === 'PUT' ? 200 : 204, json: method === 'PUT' ? { id: 'google-linked', etag: 'retried' } : undefined }, { method: providerMethod });
  route('/events/outlook-linked', { status: method === 'PUT' ? 200 : 204, json: method === 'PUT' ? { id: 'outlook-linked', changeKey: 'retried' } : undefined }, { method: providerMethod });
  await testPool.query("update calendar_sync_failures set next_attempt_at = now() where user_id = $1", [uid]);
  const retried = await outbound.retryFailedOutbound();
  expect(retried.failed).toBe(0);
  expect(callsMatching('/events/').filter((call) => call.method === providerMethod).map((call) => new URL(call.url).pathname.split('/').pop()).sort()).toEqual(['google-linked', 'outlook-linked']);
  expect((await testPool.query("select 1 from calendar_sync_failures where kind = 'outbound' and user_id = $1", [uid])).rowCount).toBe(0);
  if (method === 'DELETE') expect((await testPool.query('select 1 from calendar_events where id = $1', [row.id])).rowCount).toBe(0);
});

test.each(['provider', 'queue'])('an imported meeting retries its sibling copy after a %s failure', async (failurePoint) => {
  const uid = await connectGoogle(firm);
  await testPool.query('update members set is_owner = true where law_firm_id = $1 and user_id = $2', [firm.id, uid]);
  await testPool.query(`insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, is_sync_to_provider, meta)
    values ($1, 'microsoft', 'microsoft-access', 'microsoft-refresh', true, '{"outlookTimezone":"America/New_York"}')`, [uid]);
  const modified = new Date().toISOString();
  route('syncToken=', { status: 200, json: { items: [{ id: 'external-source', summary: 'Imported sibling meeting', updated: modified,
    start: { dateTime: '2026-11-10T14:00:00Z' }, end: { dateTime: '2026-11-10T15:00:00Z' } }], nextSyncToken: 'external-committed' } });
  route('/me/events', { status: 503 }, { method: 'POST' });
  const google = require('../../src/modules/calendar/google/google.service');
  if (failurePoint === 'queue') {
    const persist = jest.spyOn(syncRepo, 'recordOutboundWork').mockRejectedValueOnce(new Error('external queue unavailable'));
    try {
      await expect(google.processWatchNotification({ userId: uid, lawFirmId: firm.id })).rejects.toThrow('external queue unavailable');
      expect(persist).toHaveBeenCalled();
      expect((await testPool.query("select sync_cursor from user_oauth_tokens where user_id = $1 and provider = 'google'", [uid])).rows[0].sync_cursor).toBe('token-seed');
    } finally { persist.mockRestore(); }
    await google.processWatchNotification({ userId: uid, lawFirmId: firm.id });
  } else {
    await google.processWatchNotification({ userId: uid, lawFirmId: firm.id });
  }
  expect((await testPool.query('select title from calendar_events where created_by = $1', [uid])).rows).toEqual([{ title: 'Imported sibling meeting' }]);
  expect(callsMatching('/me/events').filter((call) => call.method === 'POST')).toHaveLength(1);
  const queued = (await testPool.query("select provider, payload from calendar_sync_failures where kind = 'outbound' and user_id = $1", [uid])).rows;
  expect(queued.map((work) => work.provider)).toEqual(['outlook']);
  expect(queued[0].payload.entityData.title).toBe('Imported sibling meeting');
  expect((await testPool.query("select sync_cursor from user_oauth_tokens where user_id = $1 and provider = 'google'", [uid])).rows[0].sync_cursor).toBe('external-committed');
  resetGoogleFetch();
  route('/me/events', { status: 200, json: { id: 'sibling-copy', changeKey: 'retry-version' } }, { method: 'POST' });
  await testPool.query("update calendar_sync_failures set next_attempt_at = now() where user_id = $1", [uid]);
  expect((await outbound.retryFailedOutbound()).failed).toBe(0);
  expect(callsMatching('/me/events').find((call) => call.method === 'POST')?.body.subject).toBe('Imported sibling meeting');
  expect((await testPool.query('select outlook_id from calendar_events where created_by = $1', [uid])).rows).toEqual([{ outlook_id: 'sibling-copy' }]);
});

test.each([
  ['google', 'provider'], ['outlook', 'provider'], ['google', 'queue'], ['outlook', 'queue'],
])('a %s cancellation durably retries deleting its sibling copy after a %s failure', async (provider, failurePoint) => {
  const uid = await connectGoogle(firm);
  await testPool.query(`insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, is_sync_to_provider, is_sync_from_provider, meta)
    values ($1, 'microsoft', 'microsoft-access', 'microsoft-refresh', true, true, '{"outlookTimezone":"America/New_York"}')`, [uid]);
  const siblingProvider = provider === 'google' ? 'outlook' : 'google';
  await calendarEventsRepo.upsert(firm.id, 'cancelled-source', {
    title: 'Cancelled imported meeting', provider, createdBy: uid, start: '2026-11-10T14:00:00Z',
    googleEventId: provider === 'google' ? 'source-id' : 'sibling-id',
    outlookId: provider === 'outlook' ? 'source-id' : 'sibling-id',
  });
  const row = (await testPool.query('select id from calendar_events where created_by = $1', [uid])).rows[0];
  await syncRepo.saveMapping({ provider: siblingProvider, externalEventId: 'sibling-id', calendarId: 'primary', userId: uid,
    lawFirmId: firm.id, entityType: 'externalEvent', entityId: row.id, itemKey: 'external' });
  route('/events/sibling-id', { status: 503 }, { method: 'DELETE' });
  route('syncToken=', { status: 200, json: { items: [{ id: 'source-id', status: 'cancelled' }], nextSyncToken: 'cancelled-committed' } });
  const cancel = () => provider === 'google'
    ? require('../../src/modules/calendar/google/google.service').processWatchNotification({ userId: uid, lawFirmId: firm.id })
    : require('../../src/modules/calendar/outlook/outlook.service').processSubscriptionNotification({ userId: uid, lawFirmId: firm.id, changeType: 'deleted', resourceData: { id: 'source-id' } });
  if (failurePoint === 'queue') {
    const persist = jest.spyOn(syncRepo, 'recordOutboundWork').mockRejectedValueOnce(new Error('delete queue unavailable'));
    try {
      await expect(cancel()).rejects.toThrow('delete queue unavailable');
      expect(persist).toHaveBeenCalled();
      expect((await testPool.query('select 1 from calendar_events where id = $1', [row.id])).rowCount).toBe(1);
      expect(callsMatching('/events/sibling-id').filter((call) => call.method === 'DELETE')).toHaveLength(0);
    } finally { persist.mockRestore(); }
  }
  await cancel();
  expect(callsMatching('/events/sibling-id').some((call) => call.method === 'DELETE')).toBe(true);
  expect((await testPool.query('select 1 from calendar_events where id = $1', [row.id])).rowCount).toBe(0);
  const queued = (await testPool.query("select provider, payload from calendar_sync_failures where kind = 'outbound' and user_id = $1", [uid])).rows;
  expect(queued.map((work) => work.provider)).toEqual([siblingProvider]);
  expect(queued[0].payload.action).toBe('deleteEventsFromEntity');
  resetGoogleFetch();
  route('/events/sibling-id', { status: 204 }, { method: 'DELETE' });
  await testPool.query("update calendar_sync_failures set next_attempt_at = now() where user_id = $1", [uid]);
  expect((await outbound.retryFailedOutbound()).failed).toBe(0);
  expect(callsMatching('/events/sibling-id').filter((call) => call.method === 'DELETE')).toHaveLength(1);
  expect((await testPool.query("select 1 from calendar_sync_failures where kind = 'outbound' and user_id = $1", [uid])).rowCount).toBe(0);
  expect((await testPool.query('select 1 from calendar_mappings where external_event_id = $1', ['sibling-id'])).rowCount).toBe(0);
});


test.each(['google', 'outlook'])('clearing a source %s location clears the provider venue', async (provider) => {
  const uid = provider === 'google' ? await connectGoogle(firm) : await connectMicrosoft(firm);
  await testPool.query('update members set is_owner = true where law_firm_id = $1 and user_id = $2', [firm.id, uid]);
  await calendarEventsRepo.upsert(firm.id, 'clear-location', {
    title: 'Consultation', provider, createdBy: uid, start: '2026-11-10T14:00:00Z', location: 'Room 4',
    ...(provider === 'google' ? { googleEventId: 'source-location-id' } : { outlookId: 'source-location-id' }),
  });
  const { rows } = await testPool.query('select id, location from calendar_events where law_firm_id = $1', [firm.id]);
  expect(rows).toHaveLength(1);
  expect(rows[0].location).toBe('Room 4');
  route('/events/source-location-id', { status: 200, json: { id: 'source-location-id', etag: 'cleared', changeKey: 'cleared' } }, { method: 'PATCH' });
  const response = await as(tokenFor({ uid })).put(`/api/lawfirms/${firm.id}/calendar-events/${rows[0].id}`).send({ location: null });
  expect(response.status).toBe(200);
  expect(response.body.event.location).toBeNull();
  const writes = callsMatching('/events/source-location-id').filter((call) => call.method === 'PATCH');
  expect(writes).toHaveLength(1);
  expect(writes[0].body.location).toEqual(provider === 'google' ? '' : { displayName: '' });
});
