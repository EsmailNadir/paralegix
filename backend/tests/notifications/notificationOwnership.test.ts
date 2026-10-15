/**
 * The firm-side notification routes: who a notification belongs to, and
 * whether paging can lose one.
 *
 * Notifications are per-USER inside a firm, not per-firm. Two properties
 * matter most here, and no screen would ever show either as wrong:
 *
 *   OWNERSHIP. Every write here is scoped by BOTH `law_firm_id` and `user_id`.
 *   Drop either half of that predicate and one member silently marks, unmarks or
 *   deletes another's notification, or clears the bell of a firm they are only
 *   incidentally a member of. The routes answer 200 for a no-op, so a status
 *   assertion cannot see any of it: every case below reads the OWNER's row back.
 *
 *   AGREEMENT AND PAGING. `/`, `/count` and `/feed` compute their numbers from
 *   three separate queries over the same rows. If they drift, the bell shows a
 *   badge for a notification the list will not show. Paging is a composite
 *   `(created_at, id)` cursor; a batched fan-out inserts every recipient's row in
 *   one statement, so identical timestamps across a page boundary are the normal
 *   case rather than the exotic one.
 *
 * Every case that asserts something did NOT happen also performs the same action
 * where it IS allowed, in the same test, so a broken route cannot pass by
 * failing at everything.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let alice: Actor;
let bob: Actor;

/**
 * Insert a notification directly, so every read and write path stays under test.
 *
 * `createdAt` is settable because paging is ordered by it: letting `now()` decide
 * would make the page boundaries depend on how fast the inserts ran.
 */
async function notify(
  userId: string,
  overrides: {
    lawFirmId?: string;
    type?: string;
    title?: string;
    read?: boolean;
    createdAt?: string;
  } = {},
): Promise<string> {
  const { rows } = await testPool.query(
    `insert into notifications (law_firm_id, user_id, type, title, body, read, created_at)
     values ($1, $2, $3, $4, 'Body text', $5, coalesce($6::timestamptz, now()))
     returning id`,
    [
      overrides.lawFirmId ?? firm.id,
      userId,
      overrides.type ?? 'task_assigned',
      overrides.title ?? 'A notification',
      overrides.read ?? false,
      overrides.createdAt ?? null,
    ],
  );
  return rows[0].id as string;
}

/**
 * Add an EXISTING user to a second firm.
 *
 * `createFirmMember` also inserts the `users` row, so it cannot be reused for
 * someone who already exists; the same person belonging to two firms is exactly
 * the shape the tenant-scoping cases need.
 */
async function joinFirm(lawFirmId: string, uid: string, isOwner = false): Promise<void> {
  await testPool.query(
    `insert into members (law_firm_id, user_id, role_id, is_owner, joined_at)
     values ($1, $2, null, $3, now())`,
    [lawFirmId, uid, isOwner],
  );
}

const path = (suffix = '', lawFirmId = firm?.id) =>
  `/api/lawfirms/${lawFirmId}/notifications${suffix}`;

/** One notification's read flag, read with plain SQL. */
async function readFlag(id: string): Promise<boolean> {
  const { rows } = await testPool.query('select read from notifications where id = $1', [id]);
  return rows[0].read;
}

/** Whether a notification row still exists at all. */
async function exists(id: string): Promise<boolean> {
  const { rows } = await testPool.query('select 1 from notifications where id = $1', [id]);
  return rows.length === 1;
}

/** How many unread rows a user holds in a firm, ignoring every route. */
async function unreadCount(userId: string, lawFirmId = firm.id): Promise<number> {
  const { rows } = await testPool.query(
    'select count(*)::int as n from notifications where user_id = $1 and law_firm_id = $2 and not read',
    [userId, lawFirmId],
  );
  return rows[0].n;
}

beforeEach(async () => {
  firm = await createFirm();
  alice = await ownerOf(firm.id);
  // A plain member, not an owner. Notifications are gated on firm MEMBERSHIP
  // rather than a permission code, so Bob reaches every route Alice does; the
  // only thing between him and her notifications is the user scoping.
  const bobMember = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
  bob = { uid: bobMember.uid, api: as(tokenFor({ uid: bobMember.uid })) };
  await drainEvents();
});

describe('the empty and single-row cases', () => {
  it('answers an empty list rather than an error when there are none', async () => {
    const res = await alice.api.get(path());

    expect(res.status).toBe(200);
    expect(res.body.notifications).toEqual([]);
  });

  it('counts zero for a member whose colleague has an unread one', async () => {
    await notify(alice.uid);

    const res = await bob.api.get(path('/count'));

    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(0);
  });

  it('marks one notification read without touching the caller other rows', async () => {
    const first = await notify(alice.uid, { title: 'First' });
    const second = await notify(alice.uid, { title: 'Second' });

    const res = await alice.api.post(path(`/${first}/read`));

    expect(res.status).toBe(200);
    expect(await readFlag(first)).toBe(true);
    expect(await readFlag(second)).toBe(false);
  });
});

describe('acting on another member notification id', () => {
  it('marks the caller own row read and leaves the other member row unread', async () => {
    const hers = await notify(alice.uid, { title: 'Alice unread' });
    const his = await notify(bob.uid, { title: 'Bob unread' });

    const trespass = await bob.api.post(path(`/${hers}/read`));
    const own = await bob.api.post(path(`/${his}/read`));

    // The second call is the control: it proves this route marks a row read at
    // all, so the untouched row below is scoping and not a dead handler.
    expect(own.status).toBe(200);
    expect(await readFlag(his)).toBe(true);
    expect(trespass.status).toBe(200);
    expect(await readFlag(hers)).toBe(false);
  });

  it('cannot flip another member already-read row back to unread', async () => {
    const hers = await notify(alice.uid, { title: 'Alice read', read: true });
    const his = await notify(bob.uid, { title: 'Bob read', read: true });

    const trespass = await bob.api.post(path(`/${hers}/unread`));
    const own = await bob.api.post(path(`/${his}/unread`));

    expect(own.status).toBe(200);
    expect(await readFlag(his)).toBe(false);
    expect(trespass.status).toBe(200);
    // Unread is the quieter direction of the same bug: it would resurface a
    // notification the owner had already dealt with, in their bell, for a
    // colleague's action they never see.
    expect(await readFlag(hers)).toBe(true);
  });

  it('deletes the caller own row and leaves the other member row in place', async () => {
    const hers = await notify(alice.uid, { title: 'Alice keeps this' });
    const his = await notify(bob.uid, { title: 'Bob deletes this' });

    const trespass = await bob.api.delete(path(`/${hers}`));
    const own = await bob.api.delete(path(`/${his}`));

    expect(own.status).toBe(200);
    expect(await exists(his)).toBe(false);
    expect(trespass.status).toBe(200);
    // The irreversible half. A delete scoped to the firm alone would destroy a
    // colleague's notification with no trace and no error.
    expect(await exists(hers)).toBe(true);
  });

  it('does not reach a notification the caller owns in a DIFFERENT firm', async () => {
    // Bob belongs to both firms, and the notification is genuinely his. Only the
    // firm in the URL is wrong, so user scoping alone would let this through and
    // the tenant scope is the sole thing refusing it.
    const otherFirm = await createFirm();
    await joinFirm(otherFirm.id, bob.uid);
    const elsewhere = await notify(bob.uid, { lawFirmId: otherFirm.id, title: 'Other firm' });
    const here = await notify(bob.uid, { title: 'This firm' });

    const trespass = await bob.api.post(path(`/${elsewhere}/read`));
    const own = await bob.api.post(path(`/${here}/read`));

    expect(own.status).toBe(200);
    expect(await readFlag(here)).toBe(true);
    expect(trespass.status).toBe(200);
    expect(await readFlag(elsewhere)).toBe(false);
  });
});

describe('mark-all-read', () => {
  it('clears the caller unread rows and reports how many it cleared', async () => {
    await notify(alice.uid);
    await notify(alice.uid);
    await notify(alice.uid, { read: true });

    const res = await alice.api.post(path('/mark-all-read'));

    expect(res.status).toBe(200);
    // The count is the proof the write ran. Without it, "zero unread left" is
    // equally true of a firm that never had any.
    expect(res.body.updated).toBe(2);
    expect(await unreadCount(alice.uid)).toBe(0);
  });

  it('leaves every other member of the same firm untouched', async () => {
    await notify(alice.uid);
    await notify(bob.uid);
    await notify(bob.uid);

    const res = await alice.api.post(path('/mark-all-read'));

    expect(res.body.updated).toBe(1);
    expect(await unreadCount(alice.uid)).toBe(0);
    // The obvious shape of the bug: a mark-all scoped to the firm rather than
    // the member, quietly clearing the whole office's bell.
    expect(await unreadCount(bob.uid)).toBe(2);
  });

  it('leaves the caller own rows in another firm unread', async () => {
    const otherFirm = await createFirm();
    await joinFirm(otherFirm.id, alice.uid, true);
    await notify(alice.uid, { title: 'This firm' });
    await notify(alice.uid, { lawFirmId: otherFirm.id, title: 'Other firm' });

    const res = await alice.api.post(path('/mark-all-read'));

    expect(res.body.updated).toBe(1);
    expect(await unreadCount(alice.uid, firm.id)).toBe(0);
    // Same user, same bell component, different workspace. Dropping the tenant
    // predicate here reads as "the badge cleared itself when I switched firms".
    expect(await unreadCount(alice.uid, otherFirm.id)).toBe(1);
  });
});

describe('the list, the count and the feed over one seeded set', () => {
  /** Five for Alice (two of them read), three for Bob, all in this firm. */
  async function seedMixedSet() {
    await notify(alice.uid, { type: 'task_assigned', title: 'A1' });
    await notify(alice.uid, { type: 'task_assigned', title: 'A2' });
    await notify(alice.uid, { type: 'invoice_paid', title: 'A3' });
    await notify(alice.uid, { type: 'invoice_paid', title: 'A4', read: true });
    await notify(alice.uid, { type: 'message', title: 'A5', read: true });
    await notify(bob.uid, { type: 'task_assigned', title: 'B1' });
    await notify(bob.uid, { type: 'invoice_paid', title: 'B2' });
    await notify(bob.uid, { type: 'message', title: 'B3', read: true });
  }

  it('agree on the totals for the same caller', async () => {
    await seedMixedSet();

    const list = await alice.api.get(path());
    const count = await alice.api.get(path('/count'));
    const feed = await alice.api.get(path('/feed'));

    expect(list.status).toBe(200);
    expect(list.body.total).toBe(5);
    expect(list.body.notifications).toHaveLength(5);
    // Three separate queries in three separate handlers. The failure this pins
    // is the bell showing a badge the list cannot account for.
    expect(count.body.unreadCount).toBe(3);
    expect(feed.body.total).toBe(5);
    expect(feed.body.unreadCount).toBe(3);
    expect(feed.body.notifications).toHaveLength(5);
  });

  it('agree once Bob is counted separately, so neither is reading the firm', async () => {
    await seedMixedSet();

    const count = await bob.api.get(path('/count'));
    const feed = await bob.api.get(path('/feed'));

    expect(count.body.unreadCount).toBe(2);
    expect(feed.body.total).toBe(3);
    // 5 + 3 = 8 rows exist in this firm. A handler that lost its user predicate
    // would answer 8 and 5 here, and the numbers above would still look plausible.
    expect(feed.body.notifications).toHaveLength(3);
  });

  it('agree under the unreadOnly filter', async () => {
    await seedMixedSet();

    const list = await alice.api.get(path('?unreadOnly=true'));
    const feed = await alice.api.get(path('/feed?unreadOnly=true'));
    const count = await alice.api.get(path('/count'));

    expect(list.body.total).toBe(3);
    expect(list.body.notifications).toHaveLength(3);
    expect(feed.body.total).toBe(3);
    // `/count` is unconditionally the unread count, so under this filter the
    // list total and the count must be the same number.
    expect(count.body.unreadCount).toBe(3);
  });

  it('agree under a types filter, and the filter really narrows', async () => {
    await seedMixedSet();

    const list = await alice.api.get(path('?types=invoice_paid,message'));
    const feed = await alice.api.get(path('/feed?types=invoice_paid,message'));

    expect(list.body.total).toBe(3);
    expect(list.body.notifications.map((n: any) => n.title).sort()).toEqual(['A3', 'A4', 'A5']);
    expect(feed.body.total).toBe(3);
    // The unread count deliberately ignores the type filter: it is the bell
    // badge, not the filtered view. Pinned so a "fix" that narrows it is a
    // deliberate product change rather than a silent one.
    expect(feed.body.unreadCount).toBe(3);
  });
});

describe('paging', () => {
  /**
   * Walk every page with the composite cursor the previous page handed back,
   * returning the titles in the order they arrived. Bounded so a cursor that
   * fails to advance ends the test instead of the run.
   */
  async function pageThrough(limit: number): Promise<string[]> {
    const seen: string[] = [];
    let query = `?limit=${limit}`;
    for (let page = 0; page < 20; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await alice.api.get(path(query));
      expect(res.status).toBe(200);
      seen.push(...res.body.notifications.map((n: any) => n.title));
      if (!res.body.nextBefore) return seen;
      query = `?limit=${limit}&before=${encodeURIComponent(res.body.nextBefore)}`
        + `&beforeId=${res.body.nextBeforeId}`;
    }
    throw new Error('paging did not terminate within 20 pages');
  }

  it('returns every row exactly once across pages, newest first', async () => {
    // Distinct minutes, so the ordering is decided by created_at alone.
    for (let i = 0; i < 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await notify(alice.uid, {
        title: `N${i}`,
        createdAt: new Date(Date.UTC(2026, 5, 1, 10, i)).toISOString(),
      });
    }

    const seen = await pageThrough(3);

    expect(seen).toEqual(['N6', 'N5', 'N4', 'N3', 'N2', 'N1', 'N0']);
  });

  it('returns every row exactly once when they share a timestamp', async () => {
    // What a batched fan-out produces: `createMany` inserts every recipient's
    // row in ONE statement, so those rows carry the identical `now()`. A
    // created_at-only cursor either skips the rest of the tied group or serves
    // it again forever; the composite `(created_at, id)` cursor is what stops
    // both, and this is the only case that can tell.
    const sameInstant = '2026-06-01T10:00:00.000Z';
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await notify(alice.uid, { title: `T${i}`, createdAt: sameInstant });
    }

    const seen = await pageThrough(2);

    expect(seen).toHaveLength(6);
    expect([...seen].sort()).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5']);
  });

  it('returns every row exactly once when they share a MILLISECOND but not a microsecond', async () => {
    // The tie above is an exact one, which the composite cursor always handled.
    // This is the case it could not: `created_at` is `timestamptz` and stores
    // microseconds, but node-pg parses it into a JS `Date`, which holds only
    // milliseconds. Serving that parsed value back as the cursor rounded it DOWN,
    // and the comparison is strictly less-than, so every row sharing the
    // millisecond with more microseconds sorted ABOVE the cursor and was skipped
    // by that page and by every page after it. Permanently, not just once.
    //
    // Two separate inserts landing in the same millisecond is ordinary under
    // load, which is why this is not the batched-fan-out case. The microseconds
    // are written directly, since a Date cannot express them.
    const micros = ['000900', '000700', '000500', '000300', '000100'];
    for (let i = 0; i < micros.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await notify(alice.uid, { title: `U${i}`, createdAt: `2026-06-01 10:00:00.${micros[i]}+00` });
    }

    const seen = await pageThrough(2);

    // Descending by microsecond, so the order also proves the cursor is comparing
    // at full precision rather than merely returning everything.
    expect(seen).toEqual(['U0', 'U1', 'U2', 'U3', 'U4']);
  });

  it('hands back a cursor that keeps the microseconds', async () => {
    // The mechanism, isolated. The page-walk above would still pass if the
    // repository compensated somewhere else; this pins the value the client is
    // actually given, which is what a caller stores and echoes back.
    await notify(alice.uid, { title: 'C0', createdAt: '2026-06-01 10:00:00.000900+00' });
    await notify(alice.uid, { title: 'C1', createdAt: '2026-06-01 10:00:00.000300+00' });

    const res = await alice.api.get(path('?limit=1'));

    expect(res.body.notifications.map((n: any) => n.title)).toEqual(['C0']);
    expect(res.body.nextBefore).toBe('2026-06-01T10:00:00.000900Z');
  });

  it('stops rather than repeating the last page forever', async () => {
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await notify(alice.uid, {
        title: `S${i}`,
        createdAt: new Date(Date.UTC(2026, 5, 2, 9, i)).toISOString(),
      });
    }

    // Exactly divisible by the page size, which is where a `hasMore` computed
    // from the page length alone hands out a cursor for a page that is empty.
    const full = await alice.api.get(path('?limit=2'));
    expect(full.body.nextBefore).not.toBeNull();

    const second = await alice.api.get(
      path(`?limit=2&before=${encodeURIComponent(full.body.nextBefore)}`
        + `&beforeId=${full.body.nextBeforeId}`),
    );
    expect(second.body.notifications.map((n: any) => n.title)).toEqual(['S1', 'S0']);

    const third = await alice.api.get(
      path(`?limit=2&before=${encodeURIComponent(second.body.nextBefore)}`
        + `&beforeId=${second.body.nextBeforeId}`),
    );
    expect(third.body.notifications).toEqual([]);
    expect(third.body.nextBefore).toBeNull();
  });

  it('pages the caller own rows only, never filling a page from a colleague', async () => {
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await notify(alice.uid, {
        title: `Mine${i}`,
        createdAt: new Date(Date.UTC(2026, 5, 3, 8, i)).toISOString(),
      });
      // Interleaved in time, so a page taken by timestamp alone would be half
      // Bob's.
      // eslint-disable-next-line no-await-in-loop
      await notify(bob.uid, {
        title: `Theirs${i}`,
        createdAt: new Date(Date.UTC(2026, 5, 3, 8, i, 30)).toISOString(),
      });
    }

    const seen = await pageThrough(2);

    expect(seen).toEqual(['Mine2', 'Mine1', 'Mine0']);
  });
});

describe('tenancy', () => {
  it('does not show one firm another firm notifications', async () => {
    await notify(alice.uid, { title: 'Confidential Alpha' });
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    await notify(otherOwner.uid, { lawFirmId: otherFirm.id, title: 'Their own' });

    const res = await otherOwner.api.get(path('', otherFirm.id));

    // Their own row proves the list ran; ours must be absent from it.
    expect(res.status).toBe(200);
    expect(res.body.notifications.map((n: any) => n.title)).toEqual(['Their own']);
  });

  it('refuses a member of another firm asking under this firm', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api.get(path());

    expect(res.status).toBe(403);
  });
});
