/**
 * Events on a matter: hearings, deadlines and the dates a firm cannot miss.
 *
 * `matterEvents.service.ts` was at 9%. A matter event is a court date. Getting
 * one wrong by a day, or losing it from a list, is the failure mode that ends in
 * a missed filing, and nothing on screen looks broken when it happens.
 *
 * Two things get particular attention:
 *
 *   ALL-DAY ANCHORING. An all-day event is stored at NOON UTC rather than
 *   midnight. Midnight UTC renders as the previous day everywhere west of
 *   Greenwich, so a hearing on the 10th shows as the 9th for a firm in New York.
 *   Noon is far enough from both boundaries that no ordinary offset crosses a
 *   date line.
 *
 *   SCOPE. The firm-wide calendar and the per-matter list are separate reads,
 *   and either one can leak or drop an event independently of the other.
 */

import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createPersonClient,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let matterId: string;

const E = () => `/api/lawfirms/${firm.id}/matters/${matterId}/events`;
const FIRM_EVENTS = () => `/api/lawfirms/${firm.id}/matters/events`;

const createEvent = (body: Record<string, unknown> = {}) =>
  owner.api.post(E()).send({
    type: 'hearing',
    title: 'Motion Hearing',
    date: '2026-05-10',
    allDay: true,
    ...body,
  });

const eventRow = async (id: string) => {
  const { rows } = await testPool.query(
    'select title, type, date, ends_at, all_day, status, matter_id from events where id = $1',
    [id],
  );
  return rows[0];
};

const eventCount = async () => {
  const { rows } = await testPool.query(
    'select count(*)::int n from events where law_firm_id = $1', [firm.id],
  );
  return rows[0].n;
};

const linkedFileCount = async (eventId: string) => {
  const { rows } = await testPool.query(
    `select jsonb_array_length(coalesce(linked_files, '[]'::jsonb)) as n
       from events where id = $1`,
    [eventId],
  );
  return Number(rows[0].n);
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: 'Pat Person' });
  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Host Matter', clients: [{ clientId: client.id, name: 'Pat Person' }],
  });
  // Assert the fixture SUCCEEDED before reading what it produced. Without this,
  // a create that fails for any reason surfaces as a TypeError on `undefined`
  // several lines later, and the failure names the destructure instead of the
  // request. That has cost real diagnosis time on this suite.
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;
  await drainEvents();
});

describe('creating an event', () => {
  it('materializes every occurrence beyond the old 52 limit and counts the parent once', async () => {
    const response = await createEvent({ recurrence: { pattern: 'daily', endType: 'count', endCount: 60 } });
    expect(response.status).toBe(201);
    expect(await eventCount()).toBe(60);
  });

  /**
   * The cap is 1,000 occurrences inclusive, the parent counted, on both kinds
   * of end. Goes red if the end-day check refuses a series of exactly 1,000,
   * or stops refusing one of 1,001.
   */
  it('accepts a daily repeat of exactly 1,000 days to an end day and refuses 1,001', async () => {
    const atCap = await createEvent({ recurrence: { pattern: 'daily', endType: 'date', endDate: '2029-02-02' } });
    expect(atCap.status).toBe(201);
    expect(await eventCount()).toBe(1000);

    const overCap = await createEvent({ title: 'One day too many', recurrence: { pattern: 'daily', endType: 'date', endDate: '2029-02-03' } });
    expect(overCap.status).toBe(400);
    expect(await eventCount()).toBe(1000);
  }, 60_000);

  it('accepts a repeat of exactly 1,000 by count', async () => {
    const atCap = await createEvent({ recurrence: { pattern: 'daily', endType: 'count', endCount: 1000 } });
    expect(atCap.status).toBe(201);
    expect(await eventCount()).toBe(1000);
  }, 60_000);

  it('refuses a repeat with a blank end day without creating any rows', async () => {
    const response = await createEvent({ recurrence: { pattern: 'weekly', endType: 'date', endDate: '' } });
    expect(response.status).toBe(400);
    expect(await eventCount()).toBe(0);
  });

  it('keeps all-day repeats noon anchored across daylight saving', async () => {
    const response = await createEvent({ date: '2026-10-31', recurrence: { pattern: 'daily', endType: 'count', endCount: 3 } });
    expect(response.status).toBe(201);
    const rows = (await testPool.query('select date from events where matter_id = $1 order by date', [matterId])).rows;
    expect(rows.map((row) => row.date.toISOString())).toEqual(['2026-10-31T12:00:00.000Z', '2026-11-01T12:00:00.000Z', '2026-11-02T12:00:00.000Z']);
  });
  it('keeps client-facing notes separate and sharing off unless enabled', async () => {
    const created = await createEvent({ notes: 'Internal preparation', clientDescription: 'Bring identification' });
    expect(created.status).toBe(201);
    const read = await owner.api.get(E());
    const event = read.body.events.find((e: any) => e.id === created.body.eventId);
    expect(event.notes).toBe('Internal preparation');
    expect(event.clientDescription).toBe('Bring identification');
    expect(event.clientVisible).toBe(false);
    const changed = await owner.api.put(`${E()}/${created.body.eventId}`).send({ clientDescription: 'Bring the originals', clientVisible: true });
    expect(changed.status).toBe(200);
    const row = (await testPool.query('select notes, client_description, client_visible from events where id = $1', [created.body.eventId])).rows[0];
    expect(row).toEqual({ notes: 'Internal preparation', client_description: 'Bring the originals', client_visible: true });
  });
  it('creates one on the matter', async () => {
    const res = await createEvent();

    expect(res.status).toBe(201);
    expect((await eventRow(res.body.eventId)).matter_id).toBe(matterId);
  });

  /**
   * An event's end, and why its absence was a defect rather than a missing
   * feature.
   *
   * The sync engine has always accepted an end (`buildTimedEventRange`) and
   * falls back to `start + 1 hour` when it gets none. Matter events had no
   * column to supply one, so an all-afternoon hearing reached Google and
   * Outlook as a one-hour block, every time. Migration 0220 added `ends_at`.
   *
   * WHAT MAKES THESE GO RED: dropping the column, or dropping the `end` the
   * calendar adapters now pass, which would silently restore the one-hour
   * block for every event that has a real duration.
   */
  it('stores an end so the event keeps its real duration', async () => {
    const res = await createEvent({
      allDay: false,
      date: '2026-05-10T13:00:00-04:00',
      endsAt: '2026-05-10T17:30:00-04:00',
    });

    expect(res.status).toBe(201);
    const row = await eventRow(res.body.eventId);
    expect(new Date(row.ends_at).toISOString()).toBe('2026-05-10T21:30:00.000Z');
    // Four and a half hours, not the hour the engine would have assumed.
    expect(new Date(row.ends_at).getTime() - new Date(row.date).getTime())
      .toBe(4.5 * 60 * 60 * 1000);
  });

  it('leaves the end null for an event that is an instant', async () => {
    // A filing deadline is a moment, not a span. Null is what keeps the
    // engine's one-hour block for those, which is the right default.
    const res = await createEvent({ allDay: false, date: '2026-05-10T13:00:00-04:00' });

    expect((await eventRow(res.body.eventId)).ends_at).toBeNull();
  });

  it('refuses an end that falls before its start', async () => {
    // Not a short event, a data error: the engine only honours an end strictly
    // after the start and would silently discard this one.
    const res = await createEvent({
      allDay: false,
      date: '2026-05-10T17:00:00-04:00',
      endsAt: '2026-05-10T13:00:00-04:00',
    });

    // 400 with a message, not the 500 a bare constraint violation produces.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('after its start');
    expect(await eventCount()).toBe(0);
  });

  it('stores an all-day event at NOON UTC, not midnight', async () => {
    const res = await createEvent({ date: '2026-05-10', allDay: true });

    const stored = new Date((await eventRow(res.body.eventId)).date);
    // Midnight UTC renders as the 9th for every firm west of Greenwich, which
    // is most of them, and a hearing shown a day early is a hearing attended on
    // the wrong day. Noon has twelve hours of margin either side.
    expect(stored.toISOString()).toBe('2026-05-10T12:00:00.000Z');
    expect((await eventRow(res.body.eventId)).status).toBe('upcoming');
  });

  it('anchors an all-day event at noon UTC even when the client sends local midnight, not a bare date', async () => {
    // The all-day toggle in the real UI sends the picked day as local
    // midnight ('YYYY-MM-DDTHH:mm'), not the bare 'YYYY-MM-DD' string every
    // other case in this file uses. For a caller ahead of UTC that shape used
    // to fall through to the full zoned-datetime resolver instead of the
    // noon-UTC day-only anchor, landing the stored instant on the PREVIOUS
    // calendar day. Paris is UTC+2 in September (CEST).
    const parisOwner = { uid: owner.uid, api: as(tokenFor({ uid: owner.uid }), 'Europe/Paris') };

    const res = await parisOwner.api.post(E()).send({
      type: 'hearing', title: 'Rentrée Hearing', date: '2026-09-01T00:00', allDay: true,
    });

    expect(res.status).toBe(201);
    const stored = await eventRow(res.body.eventId);
    expect(stored.date.toISOString()).toBe('2026-09-01T12:00:00.000Z');
  });

  it('re-anchors an all-day event correctly on update, using the EXISTING allDay flag when the request omits it', async () => {
    // The update payload can change `date` without re-sending `allDay` at
    // all (the UI only sends the fields the user actually touched). The
    // effective-allDay fallback must still read the event's stored `allDay`
    // in that case, not silently treat the edit as a timed event.
    const parisOwner = { uid: owner.uid, api: as(tokenFor({ uid: owner.uid }), 'Europe/Paris') };
    const created = await parisOwner.api.post(E()).send({
      type: 'hearing', title: 'Rescheduled Hearing', date: '2026-09-01T00:00', allDay: true,
    });
    expect(created.status).toBe(201);

    const res = await parisOwner.api.put(`${E()}/${created.body.eventId}`).send({
      date: '2026-09-15T00:00',
    });

    expect(res.status).toBe(200);
    const stored = await eventRow(created.body.eventId);
    expect(stored.date.toISOString()).toBe('2026-09-15T12:00:00.000Z');
  });

  it('refuses an unrecognised event type', async () => {
    const res = await createEvent({ type: 'nonsense' });

    // The type drives the icon, the reminder rules and the filters. An
    // unrecognised value makes the event vanish from every filtered view at
    // once.
    expect(res.status).toBe(400);
    expect(await eventCount()).toBe(0);
  });

  it('refuses more than twenty linked files before creating an event', async () => {
    const linkedFiles = Array.from({ length: 21 }, (_, index) => ({
      fileId: randomUUID(),
      name: `Exhibit ${index + 1}.pdf`,
      size: 100,
      contentType: 'application/pdf',
      scope: 'matter',
      scopeId: matterId,
    }));

    const res = await createEvent({ linkedFiles });

    // An event saves its linked-file payload as JSON. Refusing before the
    // insert keeps a malformed oversized attachment set from becoming a real
    // court-date record that later readers cannot safely render.
    expect(res.status).toBe(400);
    expect(await eventCount()).toBe(0);
  });

  it('refuses more than twenty linked files before replacing an existing event attachment set', async () => {
    const created = await createEvent();
    expect(created.status).toBe(201);
    expect(await linkedFileCount(created.body.eventId)).toBe(0);
    const linkedFiles = Array.from({ length: 21 }, (_, index) => ({
      fileId: randomUUID(),
      name: `Replacement ${index + 1}.pdf`,
      size: 100,
      contentType: 'application/pdf',
      scope: 'matter',
      scopeId: matterId,
    }));

    const res = await owner.api.put(`${E()}/${created.body.eventId}`).send({ linkedFiles });

    expect(res.status).toBe(400);
    expect(await linkedFileCount(created.body.eventId)).toBe(0);
  });

  it('refuses an impossible calendar date instead of silently rolling it into the next month', async () => {
    // Before the fix, `date: z.string().min(1)` had no calendar-validity check
    // at all (not even a regex), and `toTimestampOrNull` -> `localInputToUtcDate`
    // built the day with `Date.UTC(2026, 1, 30, ...)`, which rolls forward to
    // March 2 rather than failing. A court date for a day that doesn't exist
    // was silently created for the wrong day.
    const res = await createEvent({ date: '2026-02-30', allDay: true });

    expect(res.status).toBe(400);
    expect(await eventCount()).toBe(0);
  });

  // A court date with no date is not a court date.
  it.each([
    ['no title', { type: 'hearing', date: '2026-05-10' }],
    ['no date', { type: 'hearing', title: 'Untimed' }],
  ])('refuses an event with %s', async (_label, body) => {
    const res = await owner.api.post(E()).send(body);

    expect(res.status).toBe(400);
    expect(await eventCount()).toBe(0);
  });

  it('refuses an event on ANOTHER firm matter', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/matters/${matterId}/events`)
      .send({ type: 'hearing', title: 'Cross firm hearing', date: '2026-05-10' });

    // An event carrying this firm's matter id under another firm's law_firm_id
    // appears on neither calendar.
    expect(res.status).toBe(404);
    expect(await eventCount()).toBe(0);
  });

  it('refuses a member without the permission', async () => {
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi.post(E())
      .send({ type: 'hearing', title: 'Sneaky hearing', date: '2026-05-10' });

    expect(res.status).toBe(403);
    expect(await eventCount()).toBe(0);
  });
});

describe('timezone-aware date handling reaches the real route', () => {
  // `time.test.ts` covers the conversion helpers exhaustively; these two
  // prove the wiring (validation -> service -> `toTimestampOrNull` ->
  // `localInputToUtcDate` -> `formatEvent`) actually carries a caller's
  // timezone through a real request, rather than repeating every permutation
  // through the route.

  it('resolves a DST spring-forward gap wall-clock time to the documented push-forward instant', async () => {
    // 2026-03-08 is the US spring-forward date: America/Los_Angeles jumps
    // from 2:00 AM PST straight to 3:00 AM PDT, so "2:30 AM" never happens.
    // The documented policy (`shared/utils/time.ts`) pushes it forward past
    // the gap: 3:30 AM PDT (UTC-7) = 10:30 UTC, worked out independently of
    // the function under test.
    const res = await owner.api.post(E())
      .set('x-timezone', 'America/Los_Angeles')
      .send({ type: 'hearing', title: 'Gap Hearing', date: '2026-03-08T02:30', allDay: false });

    expect(res.status).toBe(201);
    expect(res.body.event.date).toBe('2026-03-08T10:30:00.000Z');
  });

  it('keeps an all-day event on the same calendar date for a positive half-hour-offset timezone', async () => {
    // The event is stored noon-anchored in UTC regardless of caller zone. Read
    // it back for a caller in Asia/Kolkata (UTC+5:30): noon UTC + 5:30 = 5:30
    // PM local, still the 10th, nowhere near a date boundary either side.
    const created = await createEvent({ date: '2026-05-10', allDay: true });
    expect(created.status).toBe(201);

    const res = await owner.api.get(E()).set('x-timezone', 'Asia/Kolkata');

    expect(res.status).toBe(200);
    const event = res.body.events.find((e: any) => e.id === created.body.eventId);
    expect(event.dateLocalInput.slice(0, 10)).toBe('2026-05-10');
  });
});

describe('reading events', () => {
  it('returns a timed event that starts before the view and ends inside it with its full span and zone', async () => {
    const created = await createEvent({ date: '2026-05-09T23:00', endsAt: '2026-05-11T01:00', allDay: false }).set('x-timezone', 'America/Los_Angeles');
    expect(created.status).toBe(201);
    const read = await owner.api.get(`${FIRM_EVENTS()}?from=2026-05-10&to=2026-05-11`).set('x-timezone', 'America/Los_Angeles');
    expect(read.status).toBe(200);
    const event = read.body.events.find((e: any) => e.id === created.body.eventId);
    expect(event).toBeDefined();
    expect(event.endsAt).toBe('2026-05-11T08:00:00.000Z');
    expect(event.timeZone).toBe('America/Los_Angeles');
  });
  it('lets the firm owner edit a visible matter event after leaving its roster', async () => {
    const created = await createEvent({ title: 'Original hearing' });
    expect(created.status).toBe(201);
    await testPool.query('delete from matter_members where law_firm_id = $1 and matter_id = $2 and user_id = $3', [firm.id, matterId, owner.uid]);
    const response = await owner.api.put(`${E()}/${created.body.eventId}`).send({ title: 'Owner correction' });
    expect(response.status).toBe(200);
    expect((await eventRow(created.body.eventId)).title).toBe('Owner correction');
  });
  it('lists the events on the matter', async () => {
    await createEvent({ title: 'Findable Hearing' });

    const res = await owner.api.get(E());

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Findable Hearing');
  });

  it('shows the event on the firm-wide calendar too', async () => {
    await createEvent({ title: 'Findable Hearing' });

    const res = await owner.api.get(FIRM_EVENTS());

    // The firm calendar is a separate read from the per-matter list. An event
    // that appeared on one and not the other is a date somebody is relying on
    // the other view to show them.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Findable Hearing');
  });

  it('does NOT list another firm events on the matter view', async () => {
    await createEvent({ title: 'Confidential Hearing' });
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .get(`/api/lawfirms/${otherFirm.id}/matters/${matterId}/events`);

    expect(JSON.stringify(res.body ?? {})).not.toContain('Confidential Hearing');
  });

  it('does NOT list another firm events on the firm calendar', async () => {
    await createEvent({ title: 'Confidential Hearing' });
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .get(`/api/lawfirms/${otherFirm.id}/matters/events`);

    // Checked separately from the per-matter list above, because the firm
    // calendar queries by firm rather than by matter and can leak on its own.
    expect(JSON.stringify(res.body ?? {})).not.toContain('Confidential Hearing');
  });

  it('answers for a matter with no events', async () => {
    const res = await owner.api.get(E());

    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
  });

});

describe('several events', () => {
  it('keeps them distinct', async () => {
    await createEvent({ title: 'First Hearing', date: '2026-05-10' });
    await createEvent({ title: 'Second Hearing', date: '2026-06-15' });

    const res = await owner.api.get(E());

    const body = JSON.stringify(res.body);
    expect(body).toContain('First Hearing');
    expect(body).toContain('Second Hearing');
    expect(await eventCount()).toBe(2);
  });

  it('allows two events on the SAME day', async () => {
    await createEvent({ title: 'Morning Hearing', date: '2026-05-10' });
    const second = await createEvent({ title: 'Afternoon Hearing', date: '2026-05-10' });

    // Two hearings in one day is ordinary. A uniqueness constraint on
    // (matter, date) would refuse the second and lose it silently.
    expect(second.status).toBe(201);
    expect(await eventCount()).toBe(2);
  });
});

/**
 * A matter event's court is its MATTER's court, read through a join.
 *
 * `events.court_id` belongs to client events only and is null on a matter event,
 * so every read that answers with a matter event has to reach the court through
 * `matters.court_id`. Each read below is a separate query in the repository, and
 * any one of them can forget the join on its own, so each surface is asserted.
 *
 * WHAT MAKES THESE GO RED: a read that drops the matters/courts join (courtName
 * missing or null for the court matter), a copy of the name taken at write time
 * (the rename case keeps the old name), or a courts join that is not held to the
 * matter's firm (the cross-firm case shows another firm's court name).
 */
describe('the court a matter event carries', () => {
  const COURT = 'Superior Court of Testing';
  let courtId: string;
  let clientId: string;
  let courtMatterId: string;
  let courtlessMatterId: string;

  const eventsOn = (id: string) => `/api/lawfirms/${firm.id}/matters/${id}/events`;
  const createOn = (id: string, title: string) => owner.api.post(eventsOn(id)).send({
    type: 'hearing', title, date: '2026-05-10', allDay: true,
  });
  const byId = (events: any[], id: string) => {
    const found = events.find((e: any) => e.id === id);
    expect(found).toBeDefined();
    return found;
  };

  beforeEach(async () => {
    const { rows } = await testPool.query(
      'insert into courts (law_firm_id, name) values ($1, $2) returning id', [firm.id, COURT],
    );
    courtId = rows[0].id;
    const client = await createPersonClient(firm.id, { name: 'Court Client' });
    clientId = client.id;
    const withCourt = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
      name: 'Court Matter', courtId, clients: [{ clientId, name: 'Court Client' }],
    });
    expect(withCourt.status).toBe(201);
    courtMatterId = withCourt.body.matterId;
    const withoutCourt = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
      name: 'Courtless Matter', clients: [{ clientId, name: 'Court Client' }],
    });
    expect(withoutCourt.status).toBe(201);
    courtlessMatterId = withoutCourt.body.matterId;
    await drainEvents();
  });

  it('names the matter court on the create and update responses', async () => {
    const created = await createOn(courtMatterId, 'Court Hearing');
    expect(created.status).toBe(201);
    expect(created.body.event.courtName).toBe(COURT);

    const updated = await owner.api.put(`${eventsOn(courtMatterId)}/${created.body.eventId}`)
      .send({ title: 'Court Hearing, moved' });
    expect(updated.status).toBe(200);
    expect(updated.body.event.title).toBe('Court Hearing, moved');
    expect(updated.body.event.courtName).toBe(COURT);

    const courtless = await createOn(courtlessMatterId, 'Courtless Hearing');
    expect(courtless.status).toBe(201);
    expect(courtless.body.event.courtName).toBeNull();
  });

  it('names the matter court on the matter list, whole and paged, and null for a courtless matter', async () => {
    const withCourt = await createOn(courtMatterId, 'Court Hearing');
    const without = await createOn(courtlessMatterId, 'Courtless Hearing');
    expect(withCourt.status).toBe(201);
    expect(without.status).toBe(201);

    const whole = await owner.api.get(eventsOn(courtMatterId));
    expect(whole.status).toBe(200);
    expect(byId(whole.body.events, withCourt.body.eventId).courtName).toBe(COURT);

    const paged = await owner.api.get(`${eventsOn(courtMatterId)}?limit=10`);
    expect(paged.status).toBe(200);
    expect(byId(paged.body.events, withCourt.body.eventId).courtName).toBe(COURT);

    const courtless = await owner.api.get(eventsOn(courtlessMatterId));
    expect(courtless.status).toBe(200);
    expect(byId(courtless.body.events, without.body.eventId)).toHaveProperty('courtName', null);
  });

  it('names the matter court on the firm-wide range read and in the calendar feed, identically', async () => {
    const withCourt = await createOn(courtMatterId, 'Court Hearing');
    const without = await createOn(courtlessMatterId, 'Courtless Hearing');
    const window = 'from=2026-05-01&to=2026-05-31&tz=America/New_York';

    const range = await owner.api.get(`${FIRM_EVENTS()}?${window}`);
    expect(range.status).toBe(200);
    expect(byId(range.body.events, withCourt.body.eventId).courtName).toBe(COURT);
    expect(byId(range.body.events, without.body.eventId)).toHaveProperty('courtName', null);

    const feed = await owner.api.get(`/api/lawfirms/${firm.id}/calendar-feed?${window}`);
    expect(feed.status).toBe(200);
    expect(byId(feed.body.matterEvents.events, withCourt.body.eventId).courtName).toBe(COURT);
    expect(feed.body.matterEvents).toEqual(range.body);
  });

  it('names the matter court on the matter-sourced rows of the client events tab', async () => {
    const withCourt = await createOn(courtMatterId, 'Court Hearing');
    const without = await createOn(courtlessMatterId, 'Courtless Hearing');

    const tab = await owner.api.get(`/api/lawfirms/${firm.id}/clients/${clientId}/events`);
    expect(tab.status).toBe(200);
    const courtRow = byId(tab.body.events, withCourt.body.eventId);
    expect(courtRow.source).toBe('matter');
    expect(courtRow.courtName).toBe(COURT);
    expect(byId(tab.body.events, without.body.eventId)).toHaveProperty('courtName', null);
  });

  it('follows a court rename, because the name is joined at read rather than copied', async () => {
    const created = await createOn(courtMatterId, 'Court Hearing');
    expect(created.body.event.courtName).toBe(COURT);

    await testPool.query('update courts set name = $2 where id = $1', [courtId, 'Renamed Court']);

    const list = await owner.api.get(eventsOn(courtMatterId));
    expect(byId(list.body.events, created.body.eventId).courtName).toBe('Renamed Court');
    const range = await owner.api.get(`${FIRM_EVENTS()}?from=2026-05-01&to=2026-05-31&tz=America/New_York`);
    expect(byId(range.body.events, created.body.eventId).courtName).toBe('Renamed Court');
    const tab = await owner.api.get(`/api/lawfirms/${firm.id}/clients/${clientId}/events`);
    expect(byId(tab.body.events, created.body.eventId).courtName).toBe('Renamed Court');
  });

  it('does not name a court that belongs to another firm', async () => {
    const created = await createOn(courtMatterId, 'Court Hearing');
    expect(created.body.event.courtName).toBe(COURT);
    const rival = await createFirm();
    const { rows } = await testPool.query(
      'insert into courts (law_firm_id, name) values ($1, $2) returning id', [rival.id, 'Rival Firm Court'],
    );
    // The service refuses a foreign court, so only a direct write can plant one.
    // The single-column foreign key does not stop it, which is why the join must.
    await testPool.query('update matters set court_id = $2 where id = $1', [courtMatterId, rows[0].id]);

    const list = await owner.api.get(eventsOn(courtMatterId));
    expect(list.status).toBe(200);
    expect(byId(list.body.events, created.body.eventId)).toHaveProperty('courtName', null);
    expect(JSON.stringify(list.body)).not.toContain('Rival Firm Court');
  });
});
