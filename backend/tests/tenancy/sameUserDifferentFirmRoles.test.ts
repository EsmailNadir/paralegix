/**
 * B02 A04: the same real person, a member of two different firms, holding a
 * DIFFERENT role in each.
 *
 * This is a routine situation in a legal practice product (an attorney of
 * record at one firm, an of-counsel or a conflicts-cleared consultant at
 * another), and it is the one case none of the existing tenancy or permission
 * batteries can express: `ownerOf`/`memberWith` each mint a brand-new uid, so
 * every prior "two firms" spec is really "two DIFFERENT people, one per
 * firm" wearing firm A's and firm B's badges. That proves the membership gate
 * refuses an outsider; it says nothing about whether the PERMISSION decision
 * for one firm can be contaminated by the same identity's standing in
 * another. Nothing covered that, because no fixture in the suite could build
 * the shape: one identity holding a different role in two firms at once.
 *
 * `createFirmMember` (tests/support/factories.ts) now tolerates being called
 * twice with the same `uid` across two different firms (`on conflict (id) do
 * nothing` on the `users` insert; `members` has no such conflict because its
 * key is `(law_firm_id, user_id)`), and `ownerOf`/`memberWith`
 * (tests/support/actors.ts) both take an optional `uid` override so a spec
 * can hand the SAME identity two different standings without hand-rolling the
 * insert. This file is the first consumer of that.
 *
 * WHY THIS COULD PLAUSIBLY BREAK: `requirePermission` resolves the acting
 * member through `loadResolvedMember(lawFirmId, userId)`
 * (`src/modules/lawfirms/roles/requirePermission.ts`), backed by a short-TTL
 * cache keyed on BOTH `lawFirmId` and `userId`
 * (`src/modules/lawfirms/roles/permissionCache.ts`). Either half of that
 * composite key collapsing to just `userId` -- a copy-paste in a future
 * refactor, a cache key built from the wrong variable -- would let this
 * exact identity's OWNER status in one firm leak into a completely
 * unrelated firm the moment both are resolved within the same 30s window.
 * Nothing before this file would have noticed, because nothing before this
 * file ever asked the same identity to hold power in one firm and
 * nothing in another.
 */
import {
  createFirm,
  ownerOf,
  memberWith,
  drainEvents,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const matterBody = (name: string) => ({ name, description: 'Seeded by the A04 spec' });

describe('B02 A04: ordinary permission code, granted in one firm and not the other', () => {
  let firmA: Firm;
  let firmB: Firm;
  let shared: Actor; // the SAME uid: matters.create in firmA, nothing in firmB

  beforeEach(async () => {
    firmA = await createFirm({ name: 'A04 Firm A' });
    firmB = await createFirm({ name: 'A04 Firm B' });
    // Build A's standing first, then hand firmB the SAME uid with nothing granted.
    shared = await memberWith(firmA.id, ['matters.create']);
    await memberWith(firmB.id, [], { uid: shared.uid });
    await drainEvents();
  });

  it('creates a matter under the firm that actually granted the permission', async () => {
    const res = await shared.api.post(`/api/lawfirms/${firmA.id}/matters`).send(matterBody('Allowed in A'));

    expect(res.status).toBe(201);
  });

  it('is refused under the OTHER firm the same identity also belongs to', async () => {
    const res = await shared.api.post(`/api/lawfirms/${firmB.id}/matters`).send(matterBody('Should not exist in B'));

    expect(res.status).toBe(403);
    const { rows } = await testPool.query(
      'select count(*)::int as n from matters where law_firm_id = $1', [firmB.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('the grant survives being asked about the OTHER firm first (cache warms on the wrong key first)', async () => {
    // Reverse the call order from the two cases above. `loadResolvedMember`
    // populates the cache on its first resolution for (lawFirmId, userId); if
    // that key ever collapsed to just userId, resolving firmB FIRST would
    // seed a "no permissions" entry that then incorrectly serves firmA's
    // later request too.
    const refusedFirst = await shared.api.post(`/api/lawfirms/${firmB.id}/matters`).send(matterBody('B first'));
    expect(refusedFirst.status).toBe(403);

    const allowedSecond = await shared.api.post(`/api/lawfirms/${firmA.id}/matters`).send(matterBody('A second, same identity'));
    expect(allowedSecond.status).toBe(201);
  });

  it('and the refusal survives being asked about the GRANTING firm first (cache warms on the correct key first)', async () => {
    const allowedFirst = await shared.api.post(`/api/lawfirms/${firmA.id}/matters`).send(matterBody('A first'));
    expect(allowedFirst.status).toBe(201);

    // A warm cache entry now exists for (firmA, uid) with matters.create. The
    // request below must resolve a SEPARATE cache entry for (firmB, uid),
    // not reuse the one that was just populated for a different firm.
    const refusedSecond = await shared.api.post(`/api/lawfirms/${firmB.id}/matters`).send(matterBody('B second, should stay blocked'));
    expect(refusedSecond.status).toBe(403);
  });
});

describe('B02 A04: an owner-only action, checked against the raw per-firm flag rather than a permission code', () => {
  // `POST /:lawFirmId/restore-deletion` (src/modules/lawfirms/lawfirms.routes.ts)
  // is deliberately NOT gated by `requirePermission`: it reads `member.isOwner`
  // straight off the `members` row, because a permission code CAN be granted to
  // a non-owner role and would therefore not isolate "owner-ness" specifically.
  // This is the cleanest owner-in-A-does-not-become-owner-in-B case the app has.
  let firmA: Firm;
  let firmB: Firm;
  let shared: Actor; // owner of A, an ordinary (non-owner) member of B
  let ownerB: Actor; // firmB's real owner, needed to schedule ITS deletion

  beforeEach(async () => {
    firmA = await createFirm({ name: 'A04 Owner Firm A' });
    firmB = await createFirm({ name: 'A04 Owner Firm B' });
    shared = await ownerOf(firmA.id);
    await memberWith(firmB.id, [], { uid: shared.uid });
    ownerB = await ownerOf(firmB.id);
    await drainEvents();

    // Schedule BOTH firms for deletion so restore-deletion has something to
    // undo. `firm.delete` is owner-exclusive here in practice (neither firm
    // handed the code to anyone else), so each firm's own owner does it.
    const deleteA = await shared.api.delete(`/api/lawfirms/${firmA.id}`);
    expect(deleteA.status).toBe(200);
    const deleteB = await ownerB.api.delete(`/api/lawfirms/${firmB.id}`);
    expect(deleteB.status).toBe(200);
    await drainEvents();
  });

  it('the shared identity restores the firm they actually own', async () => {
    const res = await shared.api.post(`/api/lawfirms/${firmA.id}/restore-deletion`);

    expect(res.status).toBe(200);
    const { rows } = await testPool.query(
      'select pending_deletion_at from law_firms where id = $1', [firmA.id],
    );
    expect(rows[0].pending_deletion_at).toBeNull();
  });

  it('is refused restoring the OTHER firm, despite being a real owner elsewhere', async () => {
    const res = await shared.api.post(`/api/lawfirms/${firmB.id}/restore-deletion`);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('Only the firm owner can restore a pending deletion');
    const { rows } = await testPool.query(
      'select pending_deletion_at from law_firms where id = $1', [firmB.id],
    );
    expect(rows[0].pending_deletion_at).not.toBeNull();
  });

  it("firmB's actual owner can still restore it (the positive control)", async () => {
    const res = await ownerB.api.post(`/api/lawfirms/${firmB.id}/restore-deletion`);

    expect(res.status).toBe(200);
    const { rows } = await testPool.query(
      'select pending_deletion_at from law_firms where id = $1', [firmB.id],
    );
    expect(rows[0].pending_deletion_at).toBeNull();
  });
});
