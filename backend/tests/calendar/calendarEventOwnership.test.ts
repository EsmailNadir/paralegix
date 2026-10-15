/**
 * A synced calendar event belongs to the member who synced it.
 *
 * `syncFromGoogle` pages the connected user's calendar and upserts every event
 * into `calendar_events`, and `resolveCalendarId` returns 'primary' when the
 * user's target is 'default'. So the rows are, by default, that member's
 * PERSONAL calendar: doctor's appointments, interviews, and any meeting for a
 * matter the reader is walled off from.
 *
 * Every row is stamped `created_by` with the syncing user. Nothing read it.
 * `listAll` was `where law_firm_id = $1`, and the route is gated on
 * `calendar.view`, which is in DEFAULT_PERMISSIONS and therefore held by every
 * member of the firm whatever their role. So any member read every other
 * member's personal calendar.
 *
 * That this is a defect rather than a shared-calendar feature is settled by the
 * design either side of it: `allowGoogleToParalegixSync` is a per-USER setting
 * on `user_settings`, and the frontend shows these only while that member's
 * own import is on. Nobody builds a shared firm calendar with a personal
 * on/off switch.
 *
 * The write paths matter as much as the read. They are gated on `calendar.sync`,
 * which is not baseline but is held by the built-in Attorney and Paralegal
 * roles, so a colleague could rewrite or delete another member's synced rows.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  memberWith,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let colleague: Actor;

const base = () => `/api/lawfirms/${firm.id}/calendar-events`;

/** A synced external event owned by `createdBy`. */
async function seedEvent(title: string, createdBy: string | null): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into calendar_events
       (id, law_firm_id, title, starts_at, ends_at, all_day, provider, source, created_by)
     values ($1, $2, $3, '2026-03-02T01:30:00Z', '2026-03-02T02:30:00Z', false,
             'google', 'external', $4)`,
    [id, firm.id, title, createdBy],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

const titlesIn = (body: any) => (body.events ?? []).map((e: any) => e.title);

const eventRow = async (id: string) => (await testPool.query(
  'select title, law_firm_id from calendar_events where id = $1', [id],
)).rows[0];

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  // calendar.sync is what the write routes need, and it is NOT baseline. This
  // is the built-in Attorney/Paralegal shape.
  colleague = await memberWith(firm.id, ['calendar.view', 'calendar.sync']);
  await drainEvents();
});

describe('listing returns only the caller\'s own synced events', () => {
  it('shows mine and hides a colleague\'s', async () => {
    await seedEvent('Owner therapy appointment', owner.uid);
    await seedEvent('Colleague job interview', colleague.uid);

    const res = await owner.api.get(base());

    expect(res.status).toBe(200);
    // Both halves. Asserting only the absence would pass against a list that
    // returned nothing at all.
    expect(titlesIn(res.body)).toEqual(['Owner therapy appointment']);
  });

  it('shows the colleague THEIR own, so the filter is per caller', async () => {
    await seedEvent('Owner therapy appointment', owner.uid);
    await seedEvent('Colleague job interview', colleague.uid);

    const res = await colleague.api.get(base());

    // The mirror. A filter hardwired to one user would satisfy the case above.
    expect(titlesIn(res.body)).toEqual(['Colleague job interview']);
  });

  it('hides a row with NO owner from everyone', async () => {
    await seedEvent('Mine', owner.uid);
    await seedEvent('Orphaned pre-backfill row', null);

    const res = await owner.api.get(base());

    // Rows written before `created_by` was populated have no owner to match.
    // Excluded deliberately: failing closed on a confidentiality question is
    // the safer default, and the alternative shows everyone's calendar to
    // everyone again. These need a backfill, not an exemption.
    expect(titlesIn(res.body)).toEqual(['Mine']);
  });

  it('never returns another FIRM\'s events', async () => {
    const other = await createFirm({ name: 'Other Firm' });
    const otherOwner = await ownerOf(other.id);
    await testPool.query(
      `insert into calendar_events
         (law_firm_id, title, starts_at, provider, source, created_by)
       values ($1, 'Their event', '2026-03-02T01:30:00Z', 'google', 'external', $2)`,
      [other.id, otherOwner.uid],
    );
    await seedEvent('Mine', owner.uid);

    const res = await owner.api.get(base());

    // The firm scope has to survive the new user predicate rather than be
    // replaced by it.
    expect(titlesIn(res.body)).toEqual(['Mine']);
  });
});

// There is deliberately no read-by-id block here. `getExternalCalendarEvent`
// exists in calendarEvents.service but NO route reaches it: the router declares
// only GET /, PUT /:eventId and DELETE /:eventId. A test against it would have
// asserted 404 and passed for the wrong reason, proving the route's absence
// rather than the ownership rule. It is scoped in the service anyway, so it
// cannot become a hole if someone mounts it later.

describe('writing another member\'s synced event', () => {
  it('refuses an update, and leaves the row alone', async () => {
    const id = await seedEvent('Colleague job interview', colleague.uid);

    const res = await owner.api.put(`${base()}/${id}`).send({ title: 'Rewritten' });

    expect(res.status).toBe(404);
    // The row, not the status. This route is gated on calendar.sync, which the
    // built-in Attorney and Paralegal roles hold.
    expect((await eventRow(id)).title).toBe('Colleague job interview');
  });

  it('refuses a delete, and leaves the row alone', async () => {
    const id = await seedEvent('Colleague job interview', colleague.uid);

    const res = await owner.api.delete(`${base()}/${id}`);

    expect(res.status).toBe(404);
    expect(await eventRow(id)).toBeDefined();
  });

  it('still lets the OWNER of the row update it', async () => {
    const id = await seedEvent('Mine', owner.uid);

    const res = await owner.api.put(`${base()}/${id}`).send({ title: 'Renamed' });

    // The half that keeps the refusals honest. A gate that refused every write
    // would satisfy both cases above and break the feature.
    expect(res.status).toBe(200);
    expect((await eventRow(id)).title).toBe('Renamed');
  });
});
