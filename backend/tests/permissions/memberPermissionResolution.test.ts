/**
 * The OTHER permission resolver, and its "never a silent deny" contract.
 *
 * There are two of them. `resolveFromRolePermissions` is pure and is used by the
 * single-JOIN path every request takes. `resolvePermissions` is the async twin
 * that fetches the role itself, and it has exactly one caller:
 * `membersService.getMember`, behind `GET /api/lawfirms/:id/members/:memberId`.
 * The two carry the same four leading branches, so a mutation in this copy is
 * invisible to a test that only exercises the other one. Recorded as F08 in the
 * progress ledger, and this file closes it.
 *
 * The branch worth the most here is the DB error. `resolvePermissions` used to
 * carry `.catch(() => null)`, which turned a transient database failure into an
 * empty permission set: a user who genuinely had access saw a 403, the log said
 * nothing, and the only symptom was somebody insisting they used to be able to
 * do this. The catch was replaced by a rethrow so it surfaces as a 500. Nothing
 * pinned that, and the difference between the two is invisible in every normal
 * run, because the error never happens.
 */
import {
  ownerOf,
  memberWith,
  createFirm,
  testPool,
} from '../support/setupInProcess';
import { gateMethod, type Gate } from '../support/gate';
import { ALL_PERMISSIONS, DEFAULT_PERMISSIONS } from '../../src/modules/lawfirms/roles/permissions';

const rolesRepo = require('../../src/modules/lawfirms/roles/roles.repository');

let gate: Gate | null = null;

afterEach(() => {
  gate?.restore();
  gate = null;
});

describe('reading one member resolves their permissions through the async twin', () => {
  it('returns the role permissions unioned with the baseline', async () => {
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const member = await memberWith(firmId, ['matters.manage']);

    const res = await owner.api.get(`/api/lawfirms/${firmId}/members/${member.uid}`);

    expect(res.status).toBe(200);
    expect(res.body.resolvedPermissions).toContain('matters.manage');
    // The union, not a replacement. A resolver that returned only the role's own
    // array would report a member as unable to read anything, and the members
    // screen is where an admin checks exactly that.
    for (const code of DEFAULT_PERMISSIONS) {
      expect(res.body.resolvedPermissions).toContain(code);
    }
  });

  it('reports an owner as holding everything', async () => {
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);

    const res = await owner.api.get(`/api/lawfirms/${firmId}/members/${owner.uid}`);

    expect(res.status).toBe(200);
    // Every code, not a sample: `isOwner` short-circuits resolution with
    // `role_id` null, so a resolver that read only the role would give the owner
    // nothing, and one that read the baseline would give them read-only pages.
    expect([...res.body.resolvedPermissions].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('reports a member whose role was deleted as holding the baseline, not nothing', async () => {
    // The case two stale comments claimed was "[] (fail closed)". It is not, and
    // it should not be: a member whose role was deleted degrades to read-only
    // pages, which is this product's rule. Reporting [] here would show an
    // admin a member who appears to have been silently ejected.
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const member = await memberWith(firmId, ['matters.manage']);

    const { rows } = await testPool.query(
      'select role_id from members where law_firm_id = $1 and user_id = $2',
      [firmId, member.uid],
    );
    await owner.api.delete(`/api/lawfirms/${firmId}/roles/${rows[0].role_id}`);

    const res = await owner.api.get(`/api/lawfirms/${firmId}/members/${member.uid}`);

    expect(res.status).toBe(200);
    expect(res.body.resolvedPermissions).toEqual([...DEFAULT_PERMISSIONS]);
    expect(res.body.resolvedPermissions).not.toContain('matters.manage');
  });
});

describe('a database failure is a 500, never a silent deny', () => {
  it('propagates a role lookup error instead of reporting no permissions', async () => {
    // The whole point of the rethrow. An empty permission set here is
    // indistinguishable from a member who legitimately has nothing, so a
    // transient failure would be recorded on the members screen as fact.
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const member = await memberWith(firmId, ['matters.manage']);

    gate = gateMethod(rolesRepo, 'findById');
    gate.open();
    gate.failNext(new Error('connection terminated unexpectedly'));

    const res = await owner.api.get(`/api/lawfirms/${firmId}/members/${member.uid}`);

    expect(res.status).toBe(500);
    // Whatever else is true, the response must not carry a permission list.
    expect(res.body.resolvedPermissions).toBeUndefined();
    expect(gate.entered()).toBe(1);
  });

  it('does not leak the database error text to the caller', async () => {
    // A 500 that quotes the driver hands an unauthenticated-adjacent surface a
    // description of the schema and the connection.
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const member = await memberWith(firmId, ['matters.manage']);

    gate = gateMethod(rolesRepo, 'findById');
    gate.open();
    gate.failNext(new Error('relation "roles" does not exist at character 42'));

    const res = await owner.api.get(`/api/lawfirms/${firmId}/members/${member.uid}`);

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/relation "roles"/);
    expect(JSON.stringify(res.body)).not.toMatch(/character 42/);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });

  it('recovers on the next request, so the failure is not cached as an answer', async () => {
    // A resolver that cached its own failure would turn one transient error
    // into a permanent wrong answer for the length of the cache TTL.
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const member = await memberWith(firmId, ['matters.manage']);

    gate = gateMethod(rolesRepo, 'findById');
    gate.open();
    gate.failNext(new Error('connection terminated unexpectedly'));

    const failed = await owner.api.get(`/api/lawfirms/${firmId}/members/${member.uid}`);
    expect(failed.status).toBe(500);

    const recovered = await owner.api.get(`/api/lawfirms/${firmId}/members/${member.uid}`);

    expect(recovered.status).toBe(200);
    expect(recovered.body.resolvedPermissions).toContain('matters.manage');
    expect(gate.entered()).toBe(2);
  });
});
