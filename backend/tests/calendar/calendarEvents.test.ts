/**
 * The external calendar event feed, driven through the real routes.
 *
 * `calendarEvents.service.ts` had no spec of its own: the calendar directory
 * covered the sync engines and the description builder, and left the three
 * routes a firm member actually calls untested.
 *
 * Two things are worth pinning here and neither shows up as a broken screen.
 *
 * TIMEZONE. Every value on this feed is derived from the caller's zone: the
 * ISO instants, the `*LocalDisplay` / `*LocalInput` strings the editor pre-fills
 * from, and the window `from`/`to` select over. An event at 01:30 UTC on 2 March
 * belongs to 1 March in New York and to 2 March in Sydney, so a route that drew
 * the window in UTC would quietly drop it out of the day a New York user is
 * looking at. That is a missed filing date, rendered as an ordinary empty
 * calendar.
 *
 * TENANCY. `calendar_events` is keyed by `(law_firm_id, id)` and every
 * repository entry point takes the firm id, so a dropped predicate leaks or
 * destroys another firm's calendar while answering 200. Each cross-firm case
 * below checks the neighbour's ROW afterwards, not just the status.
 *
 * Fixtures are plain SQL through the test pool. Seeding through the update
 * route would mean a broken scope produced both the data and the expectation.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ownerOf,
  memberWith,
  request,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

const path = (suffix = '') => `/api/lawfirms/${firm.id}/calendar-events${suffix}`;

/**
 * One synced external event.
 *
 * No `google_event_id` / `outlook_id`: those columns are what make the update
 * and delete routes call out to the provider services, which is a different
 * subsystem with its own specs. Leaving them null keeps these tests on the
 * route's own behaviour.
 */
async function seedEvent(
  lawFirmId: string,
  overrides: {
    title?: string;
    startsAt?: string | null;
    endsAt?: string | null;
    allDay?: boolean;
    location?: string | null;
    notes?: string | null;
    /**
     * Who synced this row. Defaults to `owner`, the caller these cases drive.
     *
     * Required in practice, not decorative: `listAll` and `findById` scope to
     * the acting user, because these rows are pages of that member's PERSONAL
     * Google or Outlook calendar and the read route is gated on the baseline
     * `calendar.view`. A fixture with no owner is invisible to everyone, which
     * is deliberate (see tests/calendar/calendarEventOwnership.test.ts) and
     * would silently empty every assertion in this file.
     */
    createdBy?: string | null;
  } = {},
): Promise<{ id: string; title: string }> {
  const id = randomUUID();
  const title = overrides.title ?? `Event ${id.slice(0, 8)}`;
  // `in`, not `??`: an explicit null start is a case under test, and a nullish
  // default would silently replace it with a timed event.
  const startsAt = 'startsAt' in overrides ? overrides.startsAt : '2026-03-02T01:30:00Z';
  const endsAt = 'endsAt' in overrides ? overrides.endsAt : '2026-03-02T02:30:00Z';
  const res = await testPool.query(
    `insert into calendar_events
       (id, law_firm_id, title, starts_at, ends_at, all_day, location, notes, provider, source,
        created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'google', 'external', $9)`,
    [
      id,
      lawFirmId,
      title,
      startsAt,
      endsAt,
      overrides.allDay ?? false,
      overrides.location ?? null,
      overrides.notes ?? null,
      'createdBy' in overrides ? overrides.createdBy : owner.uid,
    ],
  );
  // A silently missing fixture would turn every "must not appear" assertion in
  // this file into a vacuous pass.
  expect(res.rowCount).toBe(1);
  return { id, title };
}

/**
 * The feed as one caller in one zone sees it.
 *
 * The zone is a per-call argument rather than the agent default because half
 * this file turns on two callers reading the SAME row in different zones.
 */
async function feedAt(actor: Actor, lawFirmId: string, timeZone: string, query = '') {
  return request()
    .get(`/api/lawfirms/${lawFirmId}/calendar-events${query}`)
    .set('Authorization', `Bearer ${tokenFor({ uid: actor.uid })}`)
    .set('x-timezone', timeZone);
}

/** The feed of the firm under test. */
async function feed(actor: Actor, timeZone: string, query = '') {
  return feedAt(actor, firm.id, timeZone, query);
}

const titles = (body: any): string[] => (body.events || []).map((e: any) => e.title);

async function rowById(id: string) {
  const { rows } = await testPool.query(
    'select title, starts_at, all_day from calendar_events where id = $1',
    [id],
  );
  return rows[0] || null;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

describe('reading the feed', () => {
  it('keeps an all-day calendar label on the same day in New Zealand', async () => {
    await seedEvent(firm.id, { startsAt: '2026-11-10T12:00:00Z', endsAt: '2026-11-11T12:00:00Z', allDay: true });
    const response = await owner.api.get(`${path()}?tz=Pacific/Auckland`);
    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(1);
    expect(response.body.events[0].startLocalInput).toBe('2026-11-10');
    expect(response.body.events[0].endLocalInput).toBe('2026-11-11');
  });
  it('returns the stored instants as ISO strings', async () => {
    const event = await seedEvent(firm.id, {
      title: 'Deposition',
      startsAt: '2026-03-02T01:30:00Z',
      endsAt: '2026-03-02T02:30:00Z',
    });

    const res = await feed(owner, 'America/New_York');

    expect(res.status).toBe(200);
    const found = res.body.events.find((e: any) => e.id === event.id);
    // Drizzle and node-pg both hand a `timestamptz` back as a JS Date. Anything
    // that forwarded the Date object straight to `res.json` would serialize to
    // the same string here, so the shape is asserted on the whole envelope
    // below rather than trusted from this alone.
    expect(found.start).toBe('2026-03-02T01:30:00.000Z');
    expect(found.end).toBe('2026-03-02T02:30:00.000Z');
    expect(res.body.totalEvents).toBe(res.body.events.length);
  });

  it('renders the local editing values in the CALLER timezone, not UTC', async () => {
    await seedEvent(firm.id, {
      title: 'Filing deadline',
      startsAt: '2026-03-02T01:30:00Z',
      endsAt: '2026-03-02T02:30:00Z',
    });

    const newYork = await feed(owner, 'America/New_York');
    const sydney = await feed(owner, 'Australia/Sydney');

    // 01:30 UTC on 2 March is 20:30 on 1 March in New York and 12:30 on
    // 2 March in Sydney. These are the values the edit form pre-fills, so a
    // route that formatted in UTC would show every user the wrong DAY.
    expect(newYork.body.events[0].startLocalInput).toBe('2026-03-01T20:30');
    expect(sydney.body.events[0].startLocalInput).toBe('2026-03-02T12:30');
    expect(newYork.body.events[0].endLocalInput).toBe('2026-03-01T21:30');
    expect(sydney.body.events[0].endLocalInput).toBe('2026-03-02T13:30');
  });

  it('refuses a request that carries no timezone', async () => {
    await seedEvent(firm.id, { title: 'Unreachable without a zone' });

    const res = await request()
      .get(path())
      .set('Authorization', `Bearer ${tokenFor({ uid: owner.uid })}`);

    // Every value on this feed is zone-derived, so answering without one would
    // silently pick the server's zone.
    expect(res.status).toBe(400);
  });

  /**
   * `provider_details` defaults to an empty object, so a check on the column
   * being present reports meeting details for every imported event. Goes red
   * if an event with no details stops reading `meeting: null`, or if one with
   * details stops reporting them.
   */
  it('reports meeting details only for an event that has them', async () => {
    const plain = await seedEvent(firm.id, { title: 'Dentist' });
    const meeting = await seedEvent(firm.id, { title: 'Client call' });
    const stored = await testPool.query(
      `update calendar_events set provider_details = $2::jsonb where id = $1`,
      [meeting.id, JSON.stringify({ organizer: { email: 'org@example.com' }, isPrivate: true })],
    );
    expect(stored.rowCount).toBe(1);

    const res = await feed(owner, 'America/New_York');

    expect(res.status).toBe(200);
    const byId = (id: string) => res.body.events.find((e: any) => e.id === id);
    expect(byId(meeting.id).meeting).toMatchObject({ organizer: { email: 'org@example.com' }, isPrivate: true });
    expect(byId(plain.id)).toHaveProperty('meeting', null);
  });

  it('nulls the instants for an event with no start or end', async () => {
    await seedEvent(firm.id, { title: 'Undated', startsAt: null, endsAt: null });

    const res = await feed(owner, 'America/New_York');

    const found = res.body.events.find((e: any) => e.title === 'Undated');
    expect(found.start).toBeNull();
    expect(found.startLocalDisplay).toBeNull();
  });
});

describe('the calendar window', () => {
  const START = '2026-03-02T01:30:00Z';

  it('includes an event that falls inside the requested day in the caller zone', async () => {
    await seedEvent(firm.id, { title: 'Late evening hearing', startsAt: START, endsAt: START });

    const res = await feed(owner, 'America/New_York', '?from=2026-03-01&to=2026-03-01');

    // 1 March in New York runs to 05:00 UTC on 2 March, so the 01:30 UTC event
    // is inside it.
    expect(res.status).toBe(200);
    expect(titles(res.body)).toContain('Late evening hearing');
  });

  it('excludes that same event for a caller whose day ended before it', async () => {
    await seedEvent(firm.id, { title: 'Late evening hearing', startsAt: START, endsAt: START });

    const res = await feed(owner, 'UTC', '?from=2026-03-01&to=2026-03-01');

    // Paired with the case above: identical row, identical query string, and
    // the only difference is the zone. A window resolved in a fixed zone would
    // answer both the same way.
    expect(res.status).toBe(200);
    expect(titles(res.body)).not.toContain('Late evening hearing');
  });

  it('includes an event that began before the window and runs into it', async () => {
    await seedEvent(firm.id, {
      title: 'Multi-day trial',
      startsAt: '2026-02-25T09:00:00Z',
      endsAt: '2026-03-01T17:00:00Z',
    });
    await seedEvent(firm.id, {
      title: 'Finished in February',
      startsAt: '2026-02-01T09:00:00Z',
      endsAt: '2026-02-02T17:00:00Z',
    });

    const res = await feed(owner, 'UTC', '?from=2026-03-01&to=2026-03-01');

    // The predicate is an overlap, not containment. The February event is the
    // control: without it, a window that ignored `from` entirely would pass.
    expect(titles(res.body)).toContain('Multi-day trial');
    expect(titles(res.body)).not.toContain('Finished in February');
  });

  it('returns everything when no window is given', async () => {
    await seedEvent(firm.id, { title: 'Way out in 2031', startsAt: '2031-01-01T09:00:00Z' });

    const res = await feed(owner, 'UTC');

    expect(titles(res.body)).toContain('Way out in 2031');
  });
});

describe('updating an event', () => {
  it('clears notes, description and location when the editor sends null', async () => {
    const event = await seedEvent(firm.id, { notes: 'Bring documents', location: 'Room 4' });
    await testPool.query('update calendar_events set description = $2 where id = $1', [event.id, 'Bring documents']);
    const response = await owner.api.put(path(`/${event.id}`)).send({ notes: null, location: null });
    expect(response.status).toBe(200);
    expect(response.body.event).toMatchObject({ notes: null, description: null, location: null });
    const { rows } = await testPool.query('select notes, description, location from calendar_events where id = $1', [event.id]);
    expect(rows).toEqual([{ notes: null, description: null, location: null }]);
  });

  it('preserves notes, description and location when the editor omits them', async () => {
    const event = await seedEvent(firm.id, { notes: 'Bring documents', location: 'Room 4' });
    await testPool.query('update calendar_events set description = $2 where id = $1', [event.id, 'Provider description']);
    const response = await owner.api.put(path(`/${event.id}`)).send({ title: 'Renamed' });
    expect(response.status).toBe(200);
    expect(response.body.event).toMatchObject({ title: 'Renamed', notes: 'Bring documents', description: 'Provider description', location: 'Room 4' });
  });

  it('refuses guest deletion and keeps the imported meeting', async () => {
    const event = await seedEvent(firm.id, { title: 'Organizer meeting' });
    await testPool.query('update calendar_events set provider_details = $2::jsonb where id = $1', [event.id, JSON.stringify({ isOrganizer: false, attendees: [{ email: 'guest@example.test' }] })]);
    const response = await owner.api.delete(path(`/${event.id}`));
    expect(response.status).toBe(403);
    expect((await rowById(event.id)).title).toBe('Organizer meeting');
  });
  it('refuses a guest edit without changing the imported meeting', async () => {
    const event = await seedEvent(firm.id, { title: 'Organizer title' });
    await testPool.query('update calendar_events set provider_details = $2::jsonb where id = $1', [event.id, JSON.stringify({ isOrganizer: false, attendees: [{ email: 'guest@example.test' }] })]);
    const response = await owner.api.put(path(`/${event.id}`)).send({ title: 'Guest overwrite' });
    expect(response.status).toBe(403);
    expect((await rowById(event.id)).title).toBe('Organizer title');
  });

  it('requires an organizer to confirm attendee notification before saving', async () => {
    const event = await seedEvent(firm.id, { title: 'Original' });
    await testPool.query('update calendar_events set provider_details = $2::jsonb where id = $1', [event.id, JSON.stringify({ isOrganizer: true, attendees: [{ email: 'guest@example.test' }] })]);
    const refused = await owner.api.put(path(`/${event.id}`)).send({ title: 'Rescheduled' });
    expect(refused.status).toBe(409);
    expect((await rowById(event.id)).title).toBe('Original');
    const confirmed = await owner.api.put(path(`/${event.id}`)).send({ title: 'Rescheduled', confirmNotifyAttendees: true });
    expect(confirmed.status).toBe(200);
    expect((await rowById(event.id)).title).toBe('Rescheduled');
  });
  it('renames one without flipping its all-day flag', async () => {
    const event = await seedEvent(firm.id, { title: 'Old title', allDay: true });

    const res = await owner.api.put(path(`/${event.id}`)).send({ title: 'New title' });

    expect(res.status).toBe(200);
    expect(res.body.event.title).toBe('New title');
    // An update that defaulted `allDay` to false would push a timed event to
    // the provider on the next outbound sync.
    expect(res.body.event.allDay).toBe(true);
    expect((await rowById(event.id)).all_day).toBe(true);
  });

  it('stores a new start as the instant it was given', async () => {
    const event = await seedEvent(firm.id, { startsAt: '2026-03-02T01:30:00Z' });

    const res = await owner.api.put(path(`/${event.id}`)).send({ start: '2026-04-01T14:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(res.body.event.start).toBe('2026-04-01T14:00:00.000Z');
    expect((await rowById(event.id)).starts_at.toISOString()).toBe('2026-04-01T14:00:00.000Z');
  });

  /**
   * An all-day edit arrives as bare days. Goes red if they are read as UTC
   * midnight rather than the noon-UTC anchor every other all-day value takes:
   * the response then shows the day before, with a clock time, to anyone
   * behind UTC.
   */
  it('stores an all-day edit at the day anchor and reads it back as the day alone', async () => {
    const event = await seedEvent(firm.id, { allDay: true, startsAt: '2026-03-02T12:00:00Z', endsAt: '2026-03-03T12:00:00Z' });

    const res = await owner.api.put(path(`/${event.id}`))
      .set('x-timezone', 'America/Los_Angeles')
      .send({ start: '2026-04-10', end: '2026-04-11', allDay: true });

    expect(res.status).toBe(200);
    expect((await rowById(event.id)).starts_at.toISOString()).toBe('2026-04-10T12:00:00.000Z');
    expect(res.body.event.startLocalDisplay).toBe('Apr 10, 2026');
  });

  /** Goes red if the route reads only the raw header: a zone sent as ?tz was ignored. */
  it('formats the reply in a zone sent as ?tz', async () => {
    const event = await seedEvent(firm.id, { startsAt: '2026-03-02T01:30:00Z' });

    const res = await owner.api.put(`${path(`/${event.id}`)}?tz=Asia/Tokyo`)
      .unset('x-timezone')
      .send({ start: '2026-04-01T14:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(res.body.event.startLocalInput).toBe('2026-04-01T23:00');
  });

  it('answers 404 for an event that does not exist', async () => {
    const res = await owner.api
      .put(path('/00000000-0000-0000-0000-000000000000'))
      .send({ title: 'Nothing to rename' });

    expect(res.status).toBe(404);
  });

  it('rejects an unparseable start with a 400, not a raw 500', async () => {
    const event = await seedEvent(firm.id, { startsAt: '2026-03-02T01:30:00Z' });

    const res = await owner.api.put(path(`/${event.id}`)).send({ start: 'not-a-date' });

    // `new Date('not-a-date')` is an Invalid Date; forwarding it straight to the
    // repository sent NaN-filled fields to Postgres and surfaced as an opaque
    // INTERNAL_ERROR with no indication the request body was the problem. The
    // row must also survive untouched, the same as any other rejected write.
    expect(res.status).toBe(400);
    expect((await rowById(event.id)).starts_at.toISOString()).toBe('2026-03-02T01:30:00.000Z');
  });

  it('rejects an unparseable end the same way', async () => {
    const event = await seedEvent(firm.id, { endsAt: '2026-03-02T02:30:00Z' });

    const res = await owner.api.put(path(`/${event.id}`)).send({ end: 'also-not-a-date' });

    expect(res.status).toBe(400);
  });

  /**
   * A start-only edit moves the event a month later. Goes red if the stored
   * end stays behind on the old day, which leaves the row ending before it
   * starts and pushes that range to the provider.
   */
  it('moves the end with a new start, keeping the length', async () => {
    const event = await seedEvent(firm.id, { startsAt: '2026-03-02T01:30:00Z', endsAt: '2026-03-02T02:30:00Z' });

    const res = await owner.api.put(path(`/${event.id}`)).send({ start: '2026-04-01T14:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(res.body.event.end).toBe('2026-04-01T15:00:00.000Z');
    const { rows } = await testPool.query('select ends_at from calendar_events where id = $1', [event.id]);
    expect(rows[0].ends_at.toISOString()).toBe('2026-04-01T15:00:00.000Z');
  });

  /** Goes red if an end before the start is stored instead of refused. */
  it('refuses an end before the start with a 400 and keeps the row', async () => {
    const event = await seedEvent(firm.id, { startsAt: '2026-03-02T01:30:00Z', endsAt: '2026-03-02T02:30:00Z' });

    const res = await owner.api.put(path(`/${event.id}`)).send({ end: '2026-03-01T23:00:00.000Z' });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query('select ends_at from calendar_events where id = $1', [event.id]);
    expect(rows[0].ends_at.toISOString()).toBe('2026-03-02T02:30:00.000Z');
  });
});

describe('deleting an event', () => {
  it('removes the row', async () => {
    const event = await seedEvent(firm.id);

    const res = await owner.api.delete(path(`/${event.id}`));

    expect(res.status).toBe(200);
    expect(await rowById(event.id)).toBeNull();
  });

  it('answers 404 for an event that does not exist', async () => {
    const res = await owner.api.delete(path('/00000000-0000-0000-0000-000000000000'));

    expect(res.status).toBe(404);
  });
});

describe('tenancy', () => {
  let otherFirm: Firm;
  let otherOwner: Actor;
  let theirEvent: { id: string; title: string };

  beforeEach(async () => {
    otherFirm = await createFirm({ name: 'Neighbouring Firm' });
    otherOwner = await ownerOf(otherFirm.id);
    // Owned by the NEIGHBOUR, which is what makes their own read below work now
    // that the feed is scoped to the syncing member as well as the firm.
    theirEvent = await seedEvent(otherFirm.id, {
      title: 'Neighbour Confidential Hearing', createdBy: otherOwner.uid,
    });
  });

  it('does not put another firm events on this firm feed', async () => {
    const mine = await feed(owner, 'UTC');
    const theirs = await feedAt(otherOwner, otherFirm.id, 'UTC');

    // The neighbour's own read proves the row is real and reachable, so the
    // absence below is a refusal rather than a missing fixture.
    expect(titles(theirs.body)).toContain('Neighbour Confidential Hearing');
    expect(titles(mine.body)).not.toContain('Neighbour Confidential Hearing');
  });

  it('refuses to update another firm event and leaves the row untouched', async () => {
    const res = await owner.api
      .put(`/api/lawfirms/${firm.id}/calendar-events/${theirEvent.id}`)
      .send({ title: 'Hijacked' });

    expect(res.status).toBe(404);
    expect((await rowById(theirEvent.id)).title).toBe('Neighbour Confidential Hearing');
  });

  it('refuses to delete another firm event and leaves the row in place', async () => {
    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/calendar-events/${theirEvent.id}`);

    expect(res.status).toBe(404);
    expect(await rowById(theirEvent.id)).not.toBeNull();
  });

  it('refuses a member of another firm asking under this firm', async () => {
    const res = await feed(otherOwner, 'UTC');

    // A non-member has no standing in this firm at all, so the permission gate
    // answers before the service is reached.
    expect(res.status).toBe(403);
  });
});

describe('permissions', () => {
  it('lets a baseline member read THEIR OWN feed', async () => {
    // `calendar.view` is in DEFAULT_PERMISSIONS, so an empty role still reads.
    // Asserted so the write refusals below cannot pass on a member who is
    // simply locked out of the module entirely.
    //
    // The event is seeded against the READER, not the owner. The feed is scoped
    // to the syncing member now: these rows are pages of one person's personal
    // Google calendar, and this case used to pass because any member could read
    // anyone's. See tests/calendar/calendarEventOwnership.test.ts.
    const reader = await memberWith(firm.id, []);
    await seedEvent(firm.id, { title: 'Team standup', createdBy: reader.uid });

    const res = await feed(reader, 'UTC');

    expect(res.status).toBe(200);
    expect(titles(res.body)).toContain('Team standup');
  });

  it('refuses a member without calendar.sync an update, and the title survives', async () => {
    const event = await seedEvent(firm.id, { title: 'Protected title' });
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.put(path(`/${event.id}`)).send({ title: 'Edited by a reader' });

    expect(res.status).toBe(403);
    expect((await rowById(event.id)).title).toBe('Protected title');
  });

  it('refuses a member without calendar.sync a delete, and the row survives', async () => {
    const event = await seedEvent(firm.id);
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.delete(path(`/${event.id}`));

    expect(res.status).toBe(403);
    expect(await rowById(event.id)).not.toBeNull();
  });

  it('lets a member holding calendar.sync update one', async () => {
    const syncer = await memberWith(firm.id, ['calendar.sync']);
    // Their own row. `calendar.sync` authorizes the ACTION; it does not grant a
    // member the right to rewrite a colleague's synced calendar entry.
    const event = await seedEvent(firm.id, { title: 'Before', createdBy: syncer.uid });

    const res = await syncer.api.put(path(`/${event.id}`)).send({ title: 'After' });

    // Paired with the refusals above so neither passes against a route that
    // refuses everybody.
    expect(res.status).toBe(200);
    expect((await rowById(event.id)).title).toBe('After');
  });
});
