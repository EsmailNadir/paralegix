/**
 * Removing members decides and removes under one matter lock.
 *
 * The last-member check and the `reassignTo` check both read the member list,
 * and the removal that follows is a separate write. Two removals that overlap
 * each read the list before either has written, so each saw a survivor that the
 * other was about to remove: a matter could end with no members, and work could
 * be handed to a member who had just left.
 *
 * The first two cases make the overlap deterministic. The removal is held at
 * `removeMembers` (the write that follows the checks); the first request is
 * released before the second, and the second is released only once the first
 * has finished. When the checks run before the lock the second request still
 * holds its stale read and acts on it. When they run under the lock the second
 * request is still waiting for the lock while the first is held, so it reads
 * the list after the first has committed. The third case holds the matter row
 * lock directly to prove a removal waits for it.
 */
import {
  createFirm,
  createFirmMember,
  drainEvents,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter } from '../support/matters';
import { gateMethod, type Gate } from '../support/gate';

const mattersRepo = require('../../src/modules/matters/matters.repository');

let firm: Firm;
let owner: Actor;
let alice: string;
let bob: string;
let matter: string;
let gate: Gate | null = null;

// Async so the request is sent when this is called; a bare supertest request
// is lazy and would not start until it is awaited.
const remove = async (body: Record<string, unknown>) =>
  owner.api.post(`/api/lawfirms/${firm.id}/matters/${matter}/members/remove`).send(body);

const memberIds = async () => (await testPool.query(
  'select user_id from matter_members where matter_id = $1 order by user_id', [matter],
)).rows.map((r: any) => r.user_id as string);

/** Assignees of the matter's tasks who are not on the matter. */
const assigneesWhoLeft = async () => (await testPool.query(
  `select ta.user_id from task_assignees ta
     join tasks t on t.id = ta.task_id
    where t.matter_id = $1
      and not exists (select 1 from matter_members mm where mm.matter_id = t.matter_id and mm.user_id = ta.user_id)`,
  [matter],
)).rows.map((r: any) => r.user_id as string);

async function seedAssignedTask(userId: string) {
  const { rows } = await testPool.query(
    `insert into tasks (law_firm_id, matter_id, title) values ($1, $2, 'Work') returning id`,
    [firm.id, matter],
  );
  await testPool.query(
    'insert into task_assignees (law_firm_id, task_id, user_id) values ($1, $2, $3)',
    [firm.id, rows[0].id, userId],
  );
}

/**
 * Start `first`, hold it at the write, start `second`, then finish `first`
 * before `second`. Both requests reaching the gate is the overlap of the
 * unlocked code; under the lock only one ever does, so the wait is bounded
 * and its timeout is the expected outcome.
 */
async function runInForcedOrder(first: () => Promise<any>, second: () => Promise<any>) {
  gate = gateMethod(mattersRepo, 'removeMembers');
  const firstRes = first();
  await gate.arrived(1);
  const secondRes = second();
  await gate.arrived(2, 600).catch(() => undefined);
  gate.openOne();
  const a = await firstRes.catch((e: any) => e);
  gate.open();
  const b = await secondRes;
  await drainEvents();
  return { a, b };
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  alice = (await createFirmMember(firm.id, { isOwner: false, permissions: [] })).uid;
  bob = (await createFirmMember(firm.id, { isOwner: false, permissions: [] })).uid;
});

afterEach(() => {
  gate?.restore();
  gate = null;
});

/** RED IF the target check runs before the lock: the work lands on Bob after he left. */
it('never hands work to a member whose removal committed first', async () => {
  matter = await seedMatter(firm.id, { name: 'Race', memberUids: [owner.uid, alice, bob] });
  await seedAssignedTask(alice);

  const { a, b } = await runInForcedOrder(
    () => remove({ targetUserIds: [bob] }),
    () => remove({ targetUserIds: [alice], reassignTo: bob }),
  );

  expect(a.status).toBe(200);
  expect(b.status).toBe(400);
  expect(b.body.error).toMatch(/reassignTo must be a member who stays on this matter/);
  expect(await memberIds()).toEqual([owner.uid, alice].sort());
  expect(await assigneesWhoLeft()).toEqual([]);
});

/** RED IF the last-member check runs before the lock: two 200s and an empty matter. */
it('never lets two removals take the matter down to zero members', async () => {
  matter = await seedMatter(firm.id, { name: 'Two members', memberUids: [alice, bob] });

  const { a, b } = await runInForcedOrder(
    () => remove({ targetUserIds: [alice] }),
    () => remove({ targetUserIds: [bob] }),
  );

  expect(a.status).toBe(200);
  expect(b.status).toBe(400);
  expect(b.body.error).toMatch(/at least one member/);
  expect(await memberIds()).toEqual([bob]);
});

/** RED IF the removal never takes the matter row lock: nothing ever waits. */
it('waits for the matter row lock before deciding', async () => {
  matter = await seedMatter(firm.id, { name: 'Held', memberUids: [owner.uid, alice, bob] });
  const held = await testPool.connect();
  try {
    await held.query('begin');
    await held.query('select id from matters where id = $1 for update', [matter]);
    const removing = remove({ targetUserIds: [alice] });

    const deadline = Date.now() + 5_000;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      const { rows } = await testPool.query(
        `select 1 from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query ilike '%matters%for update%'`,
      );
      waiting = rows.length > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(waiting).toBe(true);
    expect(await memberIds()).toEqual([owner.uid, alice, bob].sort());

    await held.query('commit');
    const res = await removing;
    await drainEvents();

    expect(res.status).toBe(200);
    expect(await memberIds()).toEqual([owner.uid, bob].sort());
  } finally {
    await held.query('rollback').catch(() => undefined);
    held.release();
  }
});
