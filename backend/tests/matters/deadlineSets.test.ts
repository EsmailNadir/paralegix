/**
 * Deadline sets: a firm recipe that turns one anchor date into a cascade of
 * matter events.
 *
 * `deadlineSets.service.ts` was at 12%. Every date it computes is a court
 * deadline, and a wrong one does not look wrong: it looks like a date.
 *
 *   THE OFFSET MATH IS THE PRODUCT. Day arithmetic runs in UTC so it cannot
 *   drift across a DST boundary, `before` subtracts, and an item marked
 *   `relativeTo: 'previous'` chains from the date computed for the item before
 *   it rather than from the anchor. The cases below assert exact calendar days,
 *   because "roughly a month out" is what a missed filing looks like.
 *
 *   THE FIRST ITEM CANNOT CHAIN. It has no previous item, so the service forces
 *   its `relativeTo` back to 'trigger' on write. A stored 'previous' would be
 *   harmless today (the chain starts at the anchor) and wrong the moment
 *   anything reorders the list, so it is pinned at the stored-row level.
 *
 *   WEEKEND ADJUSTMENT IS PER TEMPLATE. A Saturday result rolls to Monday and a
 *   Sunday result rolls to Monday, but only when the template asks. The fixtures
 *   name a real Saturday (2026-06-13) and Sunday (2026-06-14) and assert the
 *   same Monday for both, so a roll of the wrong number of days fails.
 *
 * A second firm holds a colliding template throughout. Applying a template is
 * the sharpest edge: the template id and the matter id are resolved by two
 * different queries, so a template that lost its tenant scope would write
 * another firm's deadlines onto this firm's matter.
 *
 * Fixtures are plain SQL through the test pool; the events an apply produces are
 * read back from `events`, not from the response alone.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod, type Gate } from '../support/gate';

const matterEventsRepo = require('../../src/modules/matters/matterEvents.repository');

let firmA: Firm;
let firmB: Firm;
let alice: Actor;   // owner at firm A, and a member of matterA
let matterA: string;

const SETS = () => `/api/lawfirms/${firmA.id}/deadline-sets`;
const APPLY = (templateId: string, matterId = matterA) =>
  `/api/lawfirms/${firmA.id}/matters/${matterId}/deadline-sets/${templateId}/apply`;

interface ItemSeed {
  title: string;
  type?: string;
  offsetDays: number;
  offsetDirection?: 'before' | 'after';
  relativeTo?: 'trigger' | 'previous';
  clientVisible?: boolean;
  notes?: string | null;
}

const item = (seed: ItemSeed) => ({
  title: seed.title,
  type: seed.type ?? 'filing_deadline',
  offsetDays: seed.offsetDays,
  offsetDirection: seed.offsetDirection ?? 'after',
  relativeTo: seed.relativeTo ?? 'trigger',
  clientVisible: seed.clientVisible === true,
  notes: seed.notes ?? null,
});

async function seedTemplate(
  lawFirmId: string, name: string,
  opts: { adjustForWeekends?: boolean; items?: ReturnType<typeof item>[] } = {},
): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into deadline_set_templates (id, law_firm_id, name, adjust_for_weekends, items)
     values ($1,$2,$3,$4,$5::jsonb) returning id`,
    [
      id, lawFirmId, name, opts.adjustForWeekends === true,
      JSON.stringify(opts.items ?? [item({ title: 'Answer Due', offsetDays: 30 })]),
    ],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

async function templateRow(id: string) {
  const { rows } = await testPool.query(
    'select name, description, adjust_for_weekends, items, law_firm_id from deadline_set_templates where id = $1',
    [id],
  );
  return rows[0];
}

async function templateCount(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(
    'select count(*)::int n from deadline_set_templates where law_firm_id = $1', [lawFirmId],
  );
  return rows[0].n;
}

/** A matter plus the matter_members row the event-create path requires. */
async function seedMatterFor(lawFirmId: string, userId: string, name: string): Promise<string> {
  const id = randomUUID();
  const matter = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1,$2,$3,$4,'active') returning id`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  expect(matter.rowCount).toBe(1);
  const member = await testPool.query(
    `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at)
     values ($1,$2,$3,'lead', now())`,
    [lawFirmId, id, userId],
  );
  expect(member.rowCount).toBe(1);
  return id;
}

/** Every event on a matter as [title, local day], newest last. */
async function eventDays(matterId: string): Promise<Array<[string, string]>> {
  const { rows } = await testPool.query(
    `select title, to_char(date at time zone 'America/New_York', 'YYYY-MM-DD') as day
       from events where matter_id = $1 order by date asc`,
    [matterId],
  );
  return rows.map((r: any) => [r.title, r.day]);
}

async function eventCount(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(
    'select count(*)::int n from events where law_firm_id = $1', [lawFirmId],
  );
  return rows[0].n;
}

beforeEach(async () => {
  firmA = await createFirm({ name: 'Firm A' });
  firmB = await createFirm({ name: 'Firm B' });
  alice = await ownerOf(firmA.id);
  await ownerOf(firmB.id);
  matterA = await seedMatterFor(firmA.id, alice.uid, 'Host Matter');
});

describe('managing templates', () => {
  it('stores a template with its normalized items', async () => {
    const res = await alice.api.post(SETS()).send({
      name: '  Civil Answer  ',
      description: '  Standard cascade  ',
      adjustForWeekends: true,
      items: [item({ title: '  Answer Due  ', offsetDays: 30, notes: '  file it  ' })],
    });

    expect(res.status).toBe(201);
    const row = await templateRow(res.body.deadlineSetId);
    expect(row.name).toBe('Civil Answer');
    expect(row.description).toBe('Standard cascade');
    expect(row.adjust_for_weekends).toBe(true);
    expect(row.items).toEqual([{
      title: 'Answer Due',
      type: 'filing_deadline',
      offsetDays: 30,
      offsetDirection: 'after',
      relativeTo: 'trigger',
      clientVisible: false,
      notes: 'file it',
    }]);
  });

  it('forces the first item back to the trigger date', async () => {
    const res = await alice.api.post(SETS()).send({
      name: 'Civil Answer',
      items: [
        // Nonsense on the first item: there is no previous item to chain from.
        item({ title: 'Answer Due', offsetDays: 30, relativeTo: 'previous' }),
        item({ title: 'Reply Due', offsetDays: 14, relativeTo: 'previous' }),
      ],
    });

    expect(res.status).toBe(201);
    const stored = (await templateRow(res.body.deadlineSetId)).items;
    expect(stored[0].relativeTo).toBe('trigger');
    // The second item's own chaining must survive the normalization.
    expect(stored[1].relativeTo).toBe('previous');
  });

  it('refuses a template with no items', async () => {
    const res = await alice.api.post(SETS()).send({ name: 'Empty', items: [] });

    expect(res.status).toBe(400);
    expect(await templateCount(firmA.id)).toBe(0);
  });

  it('refuses an item whose type is not a matter event type', async () => {
    const res = await alice.api.post(SETS()).send({
      name: 'Civil Answer',
      items: [{ ...item({ title: 'Answer Due', offsetDays: 30 }), type: 'lunch' }],
    });

    expect(res.status).toBe(400);
    expect(await templateCount(firmA.id)).toBe(0);
  });

  it('lists this firm\'s templates by name and none of the other firm\'s', async () => {
    await seedTemplate(firmA.id, 'Zoning Appeal');
    await seedTemplate(firmA.id, 'Civil Answer');
    // Colliding name at the other firm, so the exact-set assertion is also a
    // tenancy assertion.
    await seedTemplate(firmB.id, 'Civil Answer');

    const res = await alice.api.get(SETS());

    expect(res.status).toBe(200);
    expect(res.body.deadlineSets.map((t: any) => t.name)).toEqual(['Civil Answer', 'Zoning Appeal']);
  });

  it('reads one template back with its items', async () => {
    const template = await seedTemplate(firmA.id, 'Civil Answer', {
      items: [item({ title: 'Answer Due', offsetDays: 30 })],
    });

    const res = await alice.api.get(`${SETS()}/${template}`);

    expect(res.status).toBe(200);
    expect(res.body.deadlineSet.items.map((i: any) => i.title)).toEqual(['Answer Due']);
  });

  it('cannot read another firm\'s template', async () => {
    const theirs = await seedTemplate(firmB.id, 'Their Civil Answer');

    const res = await alice.api.get(`${SETS()}/${theirs}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Their Civil Answer');
  });

  it('replaces the items on update', async () => {
    const template = await seedTemplate(firmA.id, 'Civil Answer', {
      items: [item({ title: 'Answer Due', offsetDays: 30 })],
    });

    const res = await alice.api.put(`${SETS()}/${template}`).send({
      items: [item({ title: 'Motion Due', offsetDays: 45, offsetDirection: 'before' })],
    });

    expect(res.status).toBe(200);
    const stored = (await templateRow(template)).items;
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('Motion Due');
    expect(stored[0].offsetDirection).toBe('before');
  });

  it('cannot update another firm\'s template', async () => {
    const theirs = await seedTemplate(firmB.id, 'Their Civil Answer');

    const res = await alice.api.put(`${SETS()}/${theirs}`).send({ name: 'Renamed By A' });

    expect(res.status).toBe(404);
    expect((await templateRow(theirs)).name).toBe('Their Civil Answer');
  });

  it('deletes its own template', async () => {
    const template = await seedTemplate(firmA.id, 'Civil Answer');

    const res = await alice.api.delete(`${SETS()}/${template}`);

    expect(res.status).toBe(200);
    expect(await templateRow(template)).toBeUndefined();
  });

  it('cannot delete another firm\'s template', async () => {
    const theirs = await seedTemplate(firmB.id, 'Their Civil Answer');

    const res = await alice.api.delete(`${SETS()}/${theirs}`);

    expect(res.status).toBe(404);
    expect((await templateRow(theirs)).name).toBe('Their Civil Answer');
  });
});

describe('applying a template to a matter', () => {
  it('dates each item from the anchor', async () => {
    const template = await seedTemplate(firmA.id, 'Civil Answer', {
      items: [
        item({ title: 'Answer Due', offsetDays: 30 }),
        item({ title: 'Prepare Filing', offsetDays: 14, offsetDirection: 'before' }),
      ],
    });

    const res = await alice.api.post(APPLY(template)).send({ anchorDate: '2026-06-10' });
    await drainEvents();

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(2);
    expect(await eventDays(matterA)).toEqual([
      ['Prepare Filing', '2026-05-27'],
      ['Answer Due', '2026-07-10'],
    ]);
  });

  it('chains an item marked relativeTo previous off the item before it', async () => {
    const template = await seedTemplate(firmA.id, 'Civil Answer', {
      items: [
        item({ title: 'Answer Due', offsetDays: 30 }),
        item({ title: 'Reply Due', offsetDays: 5, relativeTo: 'previous' }),
      ],
    });

    const res = await alice.api.post(APPLY(template)).send({ anchorDate: '2026-06-10' });
    await drainEvents();

    expect(res.status).toBe(201);
    // Anchor + 30 = 2026-07-10, then + 5 from THAT date. Chaining from the
    // anchor instead would land on 2026-06-15.
    expect(await eventDays(matterA)).toEqual([
      ['Answer Due', '2026-07-10'],
      ['Reply Due', '2026-07-15'],
    ]);
  });

  it('rolls a Saturday and a Sunday result to the same Monday when asked', async () => {
    const template = await seedTemplate(firmA.id, 'Civil Answer', {
      adjustForWeekends: true,
      items: [
        // 2026-06-10 is a Wednesday: +3 lands on Saturday the 13th, +4 on
        // Sunday the 14th. Both must roll to Monday the 15th.
        item({ title: 'Saturday Item', offsetDays: 3 }),
        item({ title: 'Sunday Item', offsetDays: 4 }),
      ],
    });

    const res = await alice.api.post(APPLY(template)).send({ anchorDate: '2026-06-10' });
    await drainEvents();

    expect(res.status).toBe(201);
    expect(await eventDays(matterA)).toEqual([
      ['Saturday Item', '2026-06-15'],
      ['Sunday Item', '2026-06-15'],
    ]);
  });

  it('moves weekend deadlines before the anchor back to Friday', async () => {
    const template = await seedTemplate(firmA.id, 'Before hearing', {
      adjustForWeekends: true,
      items: [item({ title: 'Saturday notice', offsetDays: 3, offsetDirection: 'before' }), item({ title: 'Sunday notice', offsetDays: 2, offsetDirection: 'before' })],
    });
    const res = await alice.api.post(APPLY(template)).send({ anchorDate: '2026-06-16' });
    await drainEvents();
    expect(res.status).toBe(201);
    expect(await eventDays(matterA)).toEqual([['Saturday notice', '2026-06-12'], ['Sunday notice', '2026-06-12']]);
  });

  it('leaves a weekend date alone when the template does not adjust', async () => {
    const template = await seedTemplate(firmA.id, 'Civil Answer', {
      adjustForWeekends: false,
      items: [item({ title: 'Saturday Item', offsetDays: 3 })],
    });

    const res = await alice.api.post(APPLY(template)).send({ anchorDate: '2026-06-10' });
    await drainEvents();

    expect(res.status).toBe(201);
    expect(await eventDays(matterA)).toEqual([['Saturday Item', '2026-06-13']]);
  });

  it('carries the item\'s client visibility onto the created event', async () => {
    const template = await seedTemplate(firmA.id, 'Civil Answer', {
      items: [
        item({ title: 'Shared Deadline', offsetDays: 1, clientVisible: true }),
        item({ title: 'Internal Deadline', offsetDays: 2 }),
      ],
    });

    const res = await alice.api.post(APPLY(template)).send({ anchorDate: '2026-06-10' });
    await drainEvents();

    expect(res.status).toBe(201);
    const { rows } = await testPool.query(
      'select title, client_visible from events where matter_id = $1 order by date asc',
      [matterA],
    );
    expect(rows).toEqual([
      { title: 'Shared Deadline', client_visible: true },
      { title: 'Internal Deadline', client_visible: false },
    ]);
  });

  it('refuses an anchor date that is not a date', async () => {
    const template = await seedTemplate(firmA.id, 'Civil Answer');

    const res = await alice.api.post(APPLY(template)).send({ anchorDate: 'next tuesday' });
    await drainEvents();

    expect(res.status).toBe(400);
    expect(await eventCount(firmA.id)).toBe(0);
  });

  it('cannot apply another firm\'s template to this firm\'s matter', async () => {
    const theirs = await seedTemplate(firmB.id, 'Their Civil Answer', {
      items: [item({ title: 'Their Deadline', offsetDays: 30 })],
    });

    const refused = await alice.api.post(APPLY(theirs)).send({ anchorDate: '2026-06-10' });
    await drainEvents();

    expect(refused.status).toBe(404);
    expect(await eventCount(firmA.id)).toBe(0);

    // The same matter and the same anchor with this firm's own template does
    // create events, so the refusal was the tenant scope on the template lookup
    // and not a broken apply path.
    const mine = await seedTemplate(firmA.id, 'Civil Answer', {
      items: [item({ title: 'Answer Due', offsetDays: 30 })],
    });
    const accepted = await alice.api.post(APPLY(mine)).send({ anchorDate: '2026-06-10' });
    await drainEvents();
    expect(accepted.status).toBe(201);
    expect(await eventDays(matterA)).toEqual([['Answer Due', '2026-07-10']]);
  });

  it('cannot apply its own template to another firm\'s matter', async () => {
    const bob = await ownerOf(firmB.id);
    const theirMatter = await seedMatterFor(firmB.id, bob.uid, 'Their Matter');
    const template = await seedTemplate(firmA.id, 'Civil Answer');

    const res = await alice.api
      .post(APPLY(template, theirMatter)).send({ anchorDate: '2026-06-10' });
    await drainEvents();

    expect(res.status).toBe(404);
    expect(await eventCount(firmB.id)).toBe(0);
  });
});

/**
 * `applyDeadlineSet` used to create one matter event per item by calling
 * `matterEventsService.createMatterEvent` in a loop, each call its own
 * independently committed insert. A failure partway through (a bad row, a
 * dropped connection, anything) left the earlier items already committed: a
 * deadline set half-applied to a matter, with no error naming what's missing
 * and no way to tell "fully applied" from "half landed" from the data alone.
 * That is the exact failure mode this repo treats as catastrophic - a
 * silently missed filing deadline.
 */
describe('applied deadlines are all-day', () => {
  /**
   * A deadline is a day. Goes red if it is created as a timed event: at its
   * noon-UTC anchor it read as a 5:00 AM event in the Pacific zone, synced to
   * Google and Outlook at that time, and showed overdue from 5am on its day.
   */
  it('creates each one as an all-day event on its day', async () => {
    const template = await seedTemplate(firmA.id, 'Complaint served');

    const res = await alice.api.post(APPLY(template)).send({ anchorDate: '2026-06-10' });
    await drainEvents();

    expect(res.status).toBe(201);
    const { rows } = await testPool.query(
      `select all_day, date from events where matter_id = $1`, [matterA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].all_day).toBe(true);
    expect(rows[0].date.toISOString()).toBe('2026-07-10T12:00:00.000Z');
  });
});

describe('applying a template: a real write failure partway through', () => {
  let gate: Gate | null = null;

  afterEach(() => {
    gate?.restore();
    gate = null;
  });

  it('rolls back every event, not just the ones that already landed', async () => {
    const template = await seedTemplate(firmA.id, 'Civil Answer', {
      items: [
        item({ title: 'Answer Due', offsetDays: 30 }),
        item({ title: 'Reply Due', offsetDays: 45 }),
      ],
    });

    gate = gateMethod(matterEventsRepo, 'create');

    async function fire() {
      return alice.api.post(APPLY(template)).send({ anchorDate: '2026-06-10' });
    }

    const reqPromise = fire();
    // The first item's insert reaches the gate and pauses there.
    await gate.arrived(1);
    // Let it through for real - it runs inside the (now single) transaction
    // and inserts the first event's row.
    gate.openOne();
    // Arm the failure for the very next call: the second item's insert. It
    // cannot have reached the gate yet - releasing the first waiter only
    // started its real database work, which takes an actual round trip.
    gate.failNext(new Error('connection terminated unexpectedly'));

    const res = await reqPromise;
    await drainEvents();

    expect(res.status).toBeGreaterThanOrEqual(500);
    // THE BUG THIS PINS: before the fix, this finds ONE event (the first
    // item, already committed on its own) instead of zero.
    expect(await eventCount(firmA.id)).toBe(0);
  });

  it('a retry after the rollback produces exactly the template\'s events, never a duplicate of the first item', async () => {
    const template = await seedTemplate(firmA.id, 'Civil Answer', {
      items: [
        item({ title: 'Answer Due', offsetDays: 30 }),
        item({ title: 'Reply Due', offsetDays: 45 }),
      ],
    });

    gate = gateMethod(matterEventsRepo, 'create');
    async function fire() {
      return alice.api.post(APPLY(template)).send({ anchorDate: '2026-06-10' });
    }

    const reqPromise = fire();
    await gate.arrived(1);
    gate.openOne();
    gate.failNext(new Error('connection terminated unexpectedly'));
    const failed = await reqPromise;
    await drainEvents();
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await eventCount(firmA.id)).toBe(0);

    gate.restore();
    gate = null;

    const retried = await alice.api.post(APPLY(template)).send({ anchorDate: '2026-06-10' });
    await drainEvents();

    expect(retried.status).toBe(201);
    expect(await eventDays(matterA)).toEqual([
      ['Answer Due', '2026-07-10'],
      ['Reply Due', '2026-07-25'],
    ]);
  });
});

describe('permissions', () => {
  it('lets a matters member read templates but not create one', async () => {
    const viewer = await memberWith(firmA.id, ['matters.view', 'matters.update']);
    await seedTemplate(firmA.id, 'Civil Answer');

    const read = await viewer.api.get(SETS());
    expect(read.status).toBe(200);
    expect(read.body.deadlineSets.map((t: any) => t.name)).toEqual(['Civil Answer']);

    const body = { name: 'Zoning Appeal', items: [item({ title: 'Appeal Due', offsetDays: 30 })] };
    const refused = await viewer.api.post(SETS()).send(body);
    expect(refused.status).toBe(403);
    expect(await templateCount(firmA.id)).toBe(1);

    // The identical body from the owner succeeds, so the 403 was about the
    // caller and not about the payload.
    const accepted = await alice.api.post(SETS()).send(body);
    expect(accepted.status).toBe(201);
  });

  it('refuses a delete from a member without settings.manageFirm', async () => {
    const viewer = await memberWith(firmA.id, ['matters.view', 'matters.update']);
    const template = await seedTemplate(firmA.id, 'Civil Answer');

    const refused = await viewer.api.delete(`${SETS()}/${template}`);

    expect(refused.status).toBe(403);
    expect((await templateRow(template)).name).toBe('Civil Answer');

    // Real data, and a permitted caller can act on it.
    const accepted = await alice.api.delete(`${SETS()}/${template}`);
    expect(accepted.status).toBe(200);
  });
});
