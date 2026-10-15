/**
 * GET /api/lawfirms/:lawFirmId/members/me: how much database work one answer costs.
 *
 * This route exists because the workspace used to learn the viewer's permissions
 * by reading the entire roster. That read grows with the firm: one row and one
 * identity lookup per member, and an avatar signed for each. At fifty users,
 * against a pool of twelve connections shared by every request on the instance,
 * the cost of finding out what ONE person may do was the size of the firm.
 *
 * So the property worth pinning is not a number of milliseconds, it is that the
 * cost is FLAT. The same request against a two-member firm and a fifteen-member
 * firm must check out the same number of connections. A regression here is
 * invisible on a developer's three-member test firm and only appears in the
 * largest customer's account.
 *
 * Checkouts are counted from the app pool's own `acquire` events, so every query
 * the request makes is counted, including the ones the auth and membership
 * middleware make.
 */
import {
  createFirm,
  createFirmMember,
  memberWith,
  resetCaches,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

// Loaded after the harness, which points DATABASE_URL at this worker's test
// database: `db.ts` reads the URL when it is first imported.
const { pool } = require('../../src/shared/database/db');

/**
 * The membership JOIN plus the caller's own identity row, with one connection of
 * headroom. Nothing here may scale with the roster.
 */
const MAX_CHECKOUTS = 3;

async function checkoutsDuring(work: () => Promise<unknown>) {
  let count = 0;
  const onAcquire = () => { count += 1; };
  pool.on('acquire', onAcquire);
  try {
    const result = await work();
    return { result, count };
  } finally {
    pool.off('acquire', onAcquire);
  }
}

async function firmWithMembers(memberCount: number): Promise<{ firm: Firm; caller: Actor }> {
  const firm = await createFirm();
  const caller = await memberWith(firm.id, ['matters.update', 'members.view']);
  // `caller` is the firm's second member (the factory makes the first an owner),
  // so the remainder fill the roster out to `memberCount`.
  for (let i = 0; i < memberCount - 2; i += 1) {
    await createFirmMember(firm.id, { isOwner: false, permissions: ['matters.view'] });
  }
  return { firm, caller };
}

describe('the cost of reading your own membership', () => {
  it('does not grow with the number of members in the firm', async () => {
    const small = await firmWithMembers(2);
    const large = await firmWithMembers(15);

    const smallRun = await checkoutsDuring(() => small.caller.api
      .get(`/api/lawfirms/${small.firm.id}/members/me`));
    const largeRun = await checkoutsDuring(() => large.caller.api
      .get(`/api/lawfirms/${large.firm.id}/members/me`));

    expect((smallRun.result as any).status).toBe(200);
    expect((largeRun.result as any).status).toBe(200);
    // Proves the listener is attached to the pool the request actually used, so
    // the equality below is a measurement rather than two zeroes.
    expect(smallRun.count).toBeGreaterThan(0);
    expect(largeRun.count).toBe(smallRun.count);
    expect(largeRun.count).toBeLessThanOrEqual(MAX_CHECKOUTS);
  });

  it('costs less than the roster read it replaced', async () => {
    const { firm, caller } = await firmWithMembers(15);

    const mine = await checkoutsDuring(() => caller.api
      .get(`/api/lawfirms/${firm.id}/members/me`));
    // Both measured cold. The first call warms the resolved-permission cache,
    // and leaving it warm would credit the roster with a membership lookup it
    // does not otherwise skip, narrowing the gap this case is about.
    resetCaches();
    const roster = await checkoutsDuring(() => caller.api
      .get(`/api/lawfirms/${firm.id}/members`));

    expect((mine.result as any).status).toBe(200);
    expect((roster.result as any).status).toBe(200);
    // The roster is still the right read for the members settings screen. It is
    // the wrong read for a page mount, and this is the gap that justifies the
    // route existing at all.
    expect(mine.count).toBeLessThan(roster.count);
  });
});
