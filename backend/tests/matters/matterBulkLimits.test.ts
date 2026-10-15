/**
 * The matter bulk routes: how many ids one request may carry, and how many
 * listener chains one request may start.
 *
 * Every API instance shares a 12-connection pool across up to 80 concurrent
 * requests (the Supabase session pooler allows 15 in total). The matters grid
 * sends its "select all" answer straight to these routes, so one request can
 * carry thousands of ids. Two things therefore have to be bounded: the number
 * of ids the schema accepts at all, and the number of event-listener chains the
 * request sets running, because `eventBus.emit` does not await its listeners and
 * every chain issues its own queries.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatter } from '../support/matters';

const eventBus = require('../../src/shared/events/eventBus');
const {
  MATTER_UPDATED,
  MATTER_DELETED,
  MATTER_MEMBERS_UPDATED,
} = require('../../src/shared/events/eventTypes');

let firm: Firm;
let owner: Actor;

const M = () => `/api/lawfirms/${firm.id}/matters`;

const createMatter = (name: string) => seedMatter(firm.id, { name, memberUids: [owner.uid] });

async function createPracticeArea(name: string): Promise<string> {
  const { rows } = await testPool.query(
    'insert into practice_areas (law_firm_id, name) values ($1, $2) returning id',
    [firm.id, name],
  );
  return rows[0].id as string;
}

async function matterRow(id: string) {
  const { rows } = await testPool.query('select * from matters where id = $1', [id]);
  return rows[0] || null;
}

/**
 * A listener that records how many copies of itself are running at once.
 *
 * It holds its slot for `holdMs`, far longer than the route's own per-matter
 * work, so an unbounded fan-out shows up as a peak equal to the batch size
 * rather than as a timing coincidence.
 */
function concurrencyProbe(eventName: string, holdMs: number) {
  const seen: any[] = [];
  let active = 0;
  let peak = 0;
  const listener = async (payload: any) => {
    active += 1;
    peak = Math.max(peak, active);
    seen.push(payload);
    try {
      await new Promise((resolve) => { setTimeout(resolve, holdMs); });
    } finally {
      active -= 1;
    }
  };
  eventBus.on(eventName, listener);
  return {
    seen,
    peak: () => peak,
    remove: () => eventBus.off(eventName, listener),
  };
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Bulk Limits Firm' });
  owner = await ownerOf(firm.id);
  await drainEvents();
});

describe('how many ids one bulk matter action takes', () => {
  async function selectAllCeiling() {
    const res = await owner.api.get(`${M()}/ids`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBeGreaterThan(0);
    return res.body.limit as number;
  }

  /** `size` ids: one real matter first, then random ids that match nothing. */
  const idsOfLength = (matterId: string, size: number) =>
    [matterId, ...Array.from({ length: size - 1 }, () => randomUUID())];

  interface BulkRoute {
    path: string;
    /** The body besides the id list, built once the fixture exists. */
    body: (matterId: string) => Promise<Record<string, unknown>>;
    /** The count the response reports when the one real matter changed. */
    countKey?: string;
    /** Asserts the real matter was left exactly as seeded. */
    unchanged: (matterId: string, body: Record<string, unknown>) => Promise<void>;
  }

  const ROUTES: [string, BulkRoute][] = [
    ['bulk delete', {
      path: 'bulk-delete',
      body: async () => ({}),
      countKey: 'deleted',
      unchanged: async (matterId) => { expect(await matterRow(matterId)).not.toBeNull(); },
    }],
    ['bulk status', {
      path: 'bulk-update-status',
      body: async () => ({ status: 'on_hold' }),
      countKey: 'updated',
      unchanged: async (matterId) => { expect((await matterRow(matterId)).status).toBe('active'); },
    }],
    ['bulk practice area', {
      path: 'bulk-update-practice-area',
      body: async () => ({ practiceAreaId: await createPracticeArea('Estate Planning') }),
      countKey: 'updated',
      unchanged: async (matterId) => { expect((await matterRow(matterId)).practice_area_id).toBeNull(); },
    }],
    ['bulk add member', {
      path: 'bulk-add-member',
      body: async () => ({ userId: (await createFirmMember(firm.id, { isOwner: false })).uid }),
      unchanged: async (matterId, body) => {
        const { rows } = await testPool.query(
          'select 1 from matter_members where matter_id = $1 and user_id = $2',
          [matterId, body.userId],
        );
        expect(rows).toHaveLength(0);
      },
    }],
  ];

  it.each(ROUTES.filter(([, route]) => route.countKey))(
    'accepts a %s at exactly the select-all ceiling',
    async (_label, route) => {
      const matterId = await createMatter('Selected');
      const body = await route.body(matterId);
      const limit = await selectAllCeiling();

      const res = await owner.api.post(`${M()}/${route.path}`)
        .send({ ...body, matterIds: idsOfLength(matterId, limit) });

      expect(res.status).toBe(200);
      expect(res.body[route.countKey as string]).toBe(1);
    },
    180_000,
  );

  it.each(ROUTES)(
    'refuses one id more than the ceiling on %s, changing nothing',
    async (_label, route) => {
      const matterId = await createMatter('Selected');
      const body = await route.body(matterId);
      const limit = await selectAllCeiling();

      const res = await owner.api.post(`${M()}/${route.path}`)
        .send({ ...body, matterIds: idsOfLength(matterId, limit + 1) });

      expect(res.status).toBe(400);
      await route.unchanged(matterId, body);
    },
    180_000,
  );
});

describe('how many listener chains one bulk matter action starts', () => {
  const BATCH = 9;
  const HOLD_MS = 400;
  let probe: ReturnType<typeof concurrencyProbe> | null = null;

  afterEach(() => {
    probe?.remove();
    probe = null;
  });

  it('runs at most three MATTER_UPDATED listener chains at once on bulk status', async () => {
    const matterIds: string[] = [];
    for (let i = 0; i < BATCH; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      matterIds.push(await createMatter(`Status ${i}`));
    }
    await drainEvents();
    probe = concurrencyProbe(MATTER_UPDATED, HOLD_MS);

    const res = await owner.api.post(`${M()}/bulk-update-status`)
      .send({ matterIds, status: 'on_hold' });
    await drainEvents();

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(BATCH);
    // Exactly the chosen width: nine detached chains, each with its own queries,
    // against a 12-connection pool is what this bounds, and pinning the number
    // rather than a ceiling also proves the probe observed overlap at all.
    expect(probe.peak()).toBe(3);
    // Bounding the width must not drop or duplicate an event.
    expect(probe.seen.map((p: any) => p.matterId).sort()).toEqual([...matterIds].sort());
    for (const payload of probe.seen) {
      expect(payload.lawFirmId).toBe(firm.id);
      expect(payload.userId).toBe(owner.uid);
      expect(payload.matterData.status).toBe('on_hold');
    }
  }, 120_000);

  it('runs at most three MATTER_DELETED listener chains at once on bulk delete', async () => {
    const matterIds: string[] = [];
    for (let i = 0; i < BATCH; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      matterIds.push(await createMatter(`Doomed ${i}`));
    }
    await drainEvents();
    probe = concurrencyProbe(MATTER_DELETED, HOLD_MS);

    const res = await owner.api.post(`${M()}/bulk-delete`).send({ matterIds });
    await drainEvents();

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(BATCH);
    expect(probe.peak()).toBe(3);
    expect(probe.seen.map((p: any) => p.matterId).sort()).toEqual([...matterIds].sort());
    for (const payload of probe.seen) {
      expect(payload.lawFirmId).toBe(firm.id);
      expect(payload.userId).toBe(owner.uid);
      expect(Array.isArray(payload.tasks)).toBe(true);
      // The pre-delete document snapshot the MATTER_DELETED handlers sweep from.
      expect(Array.isArray(payload.files.objects)).toBe(true);
    }
  }, 120_000);

  it('runs at most three MATTER_MEMBERS_UPDATED listener chains at once on bulk add member', async () => {
    const matterIds: string[] = [];
    for (let i = 0; i < BATCH; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      matterIds.push(await createMatter(`Staffed ${i}`));
    }
    const target = await createFirmMember(firm.id, { isOwner: false });
    await drainEvents();
    probe = concurrencyProbe(MATTER_MEMBERS_UPDATED, HOLD_MS);

    const res = await owner.api.post(`${M()}/bulk-add-member`)
      .send({ userId: target.uid, matterIds });
    await drainEvents();

    expect(res.status).toBe(200);
    expect(res.body.added.sort()).toEqual([...matterIds].sort());
    expect(probe.peak()).toBe(3);
    expect(probe.seen.map((p: any) => p.matterId).sort()).toEqual([...matterIds].sort());
    for (const payload of probe.seen) {
      expect(payload.lawFirmId).toBe(firm.id);
      expect(payload.actorUserId).toBe(owner.uid);
      expect(payload.addedUserIds).toEqual([target.uid]);
      expect(payload.memberUserIds).toContain(target.uid);
    }
  }, 120_000);

  it('still reports every matter updated when a listener throws', async () => {
    const matterIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      matterIds.push(await createMatter(`Thrower ${i}`));
    }
    await drainEvents();
    const thrower = async () => { throw new Error('listener exploded'); };
    eventBus.on(MATTER_UPDATED, thrower);
    try {
      const res = await owner.api.post(`${M()}/bulk-update-status`)
        .send({ matterIds, status: 'closed' });
      await drainEvents();

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(3);
      expect(res.body.failed).toEqual([]);
    } finally {
      eventBus.off(MATTER_UPDATED, thrower);
    }
  }, 120_000);
});
