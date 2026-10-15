/**
 * Handing over the firm.
 *
 * `firm.transferOwnership` is the single most consequential permission in the
 * product: it is the one action that takes the firm away from the person who
 * owns it. The Admin built-in role is defined as every permission EXCEPT this
 * one, which is the whole reason that role exists.
 *
 * Nothing tested it. `permissionResolution.test.ts` asserts that the Admin role
 * excludes the code; the route, the service and the state change had no
 * coverage at all.
 *
 * Two guards stand in front of it and they are NOT redundant:
 *
 *   `requirePermission('firm.transferOwnership')` on the route, which a custom
 *   role can satisfy, and
 *
 *   `if (!actingMember?.isOwner)` in the service, which only the actual owner
 *   can satisfy.
 *
 * A firm can build a custom role holding every permission code, so the route
 * guard alone would let a member hand the firm to themselves. The service check
 * is what makes that impossible, and the case for it is below.
 *
 * The permission cache is deliberately not cleared between the transfer and the
 * assertions. Both members' effective permissions change, and the invalidation
 * that makes that immediate is part of what is under test.
 */
import {
  ownerOf,
  memberWith,
  createFirm,
  drainEvents,
  testPool,
} from '../support/setupInProcess';
import { ALL_PERMISSIONS } from '../../src/modules/lawfirms/roles/permissions';

const rolesService = require('../../src/modules/lawfirms/roles/roles.service');

/**
 * A firm WITH its built-in roles, which `createFirm` does not seed.
 *
 * `lawfirms.service` seeds them on real firm creation, and `transferOwnership`
 * only re-reads their ids. A fixture firm without them demotes the previous
 * owner to `role_id = null`, which resolves to the baseline rather than Admin,
 * so every assertion about what the demoted owner can still do would be
 * measuring the fixture instead of the product.
 */
async function createSeededFirm() {
  const firm = await createFirm();
  await rolesService.seedBuiltInRoles(firm.id);
  return firm;
}

const transfer = (api: any, firmId: string, newOwnerUserId: string) =>
  api.post(`/api/lawfirms/${firmId}/transfer-ownership`).send({ newOwnerUserId });

async function ownershipOf(firmId: string) {
  const { rows } = await testPool.query(
    `select m.user_id, m.is_owner, r.name as role_name
       from members m left join roles r on r.id = m.role_id
      where m.law_firm_id = $1 order by m.user_id`,
    [firmId],
  );
  return rows;
}

describe('a successful transfer moves ownership and nothing else', () => {
  it.each(['remove', 'role'])('rechecks owner protection when a queued %s overlaps an ownership promotion', async (action) => {
    const { id: firmId } = await createSeededFirm();
    const owner = await ownerOf(firmId);
    const successor = await memberWith(firmId, ['matters.view']);
    const { rows: roles } = await testPool.query("select id from roles where law_firm_id = $1 and name = 'Admin'", [firmId]);
    const membersRepo = require('../../src/modules/lawfirms/members/members.repository');
    const firmRepo = require('../../src/modules/lawfirms/lawfirms.repository');
    const originalRead = membersRepo.findByUserId;
    const originalLock = firmRepo.lockForUpdate;
    let reached!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const held = await testPool.connect();
    await held.query('begin');
    await held.query('select id from law_firms where id = $1 for update', [firmId]);
    const readGate = jest.spyOn(membersRepo, 'findByUserId').mockImplementation(async (...args: any[]) => {
      const result = await originalRead.apply(membersRepo, args);
      if (args[1] === successor.uid) { reached(); await resume; }
      return result;
    });
    const lockGate = jest.spyOn(firmRepo, 'lockForUpdate').mockImplementation(async (...args: any[]) => {
      reached();
      return originalLock.apply(firmRepo, args);
    });
    const path = `/api/lawfirms/${firmId}/members/${successor.uid}`;
    const request = action === 'remove' ? owner.api.delete(path) : owner.api.put(`${path}/role`).send({ roleId: roles[0].id });
    const pending = request.then((res: any) => res);
    try {
      await entered;
      await held.query('update members set is_owner = false where law_firm_id = $1 and user_id = $2', [firmId, owner.uid]);
      await held.query('update members set is_owner = true where law_firm_id = $1 and user_id = $2', [firmId, successor.uid]);
      await held.query('commit');
      release();
      expect((await pending).status).toBe(403);
      const members = await ownershipOf(firmId);
      expect(members.filter((member) => member.is_owner).map((member) => member.user_id)).toEqual([successor.uid]);
      expect(members.find((member) => member.user_id === successor.uid)?.role_name).not.toBe('Admin');
    } finally {
      await held.query('rollback');
      release();
      await pending;
      held.release();
      readGate.mockRestore();
      lockGate.mockRestore();
    }
  });

  it('restores ownership if removing the departing owner fails', async () => {
    const { id: firmId } = await createSeededFirm();
    const owner = await ownerOf(firmId);
    const successor = await memberWith(firmId, ['matters.view']);
    const repo = require('../../src/modules/lawfirms/members/members.repository');
    const original = repo.removeMember;
    let removed = false;
    const fault = jest.spyOn(repo, 'removeMember').mockImplementation(async (...args: any[]) => {
      await original.apply(repo, args);
      removed = true;
      throw new Error('Injected failure after member removal');
    });
    try {
      const res = await owner.api.post(`/api/lawfirms/${firmId}/leave`).send({ newAdminUserId: successor.uid });
      expect(res.status).toBe(500);
      expect(removed).toBe(true);
      const rows = await ownershipOf(firmId);
      expect(rows.find((row: any) => row.user_id === owner.uid)?.is_owner).toBe(true);
      expect(rows.find((row: any) => row.user_id === successor.uid)?.is_owner).toBe(false);
    } finally {
      fault.mockRestore();
    }
  });

  it('swaps the flags and demotes the old owner to Admin rather than ejecting them', async () => {
    const { id: firmId } = await createSeededFirm();
    const owner = await ownerOf(firmId);
    const successor = await memberWith(firmId, ['matters.view']);

    const res = await transfer(owner.api, firmId, successor.uid);
    await drainEvents();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      previousOwnerId: owner.uid,
      newOwnerId: successor.uid,
    });

    const rows = await ownershipOf(firmId);
    const previous = rows.find((r: any) => r.user_id === owner.uid);
    const current = rows.find((r: any) => r.user_id === successor.uid);

    expect(current.is_owner).toBe(true);
    expect(previous.is_owner).toBe(false);
    // Demoted, not removed. An owner who hands over the firm still works there,
    // and losing their account along with the title would be a surprise nobody
    // could undo without the new owner's help.
    expect(previous.role_name).toBe('Admin');
    expect(current.role_name).toBe('Owner');
  });

  it('leaves the firm with exactly one owner', async () => {
    // The invariant the whole feature rests on. Two owners, or none, is a state
    // no other code is written for.
    const { id: firmId } = await createSeededFirm();
    const owner = await ownerOf(firmId);
    const successor = await memberWith(firmId, ['matters.view']);

    await transfer(owner.api, firmId, successor.uid);
    await drainEvents();

    const owners = (await ownershipOf(firmId)).filter((r: any) => r.is_owner);
    expect(owners.map((r: any) => r.user_id)).toEqual([successor.uid]);
  });

  it('takes the owner-only action away from the old owner immediately', async () => {
    // No cache clearing between the transfer and this call. A missed
    // invalidation would let the previous owner transfer the firm again for up
    // to the 30 second TTL, which is long enough to take it back.
    const { id: firmId } = await createSeededFirm();
    const owner = await ownerOf(firmId);
    const successor = await memberWith(firmId, ['matters.view']);
    const bystander = await memberWith(firmId, ['matters.view']);

    await transfer(owner.api, firmId, successor.uid);
    await drainEvents();

    const takeItBack = await transfer(owner.api, firmId, bystander.uid);

    expect(takeItBack.status).toBe(403);
    expect((await ownershipOf(firmId)).filter((r: any) => r.is_owner).map((r: any) => r.user_id))
      .toEqual([successor.uid]);
  });

  it('gives the owner-only action to the new owner immediately', async () => {
    // The positive half. Without it, a route that refused EVERYONE would satisfy
    // the case above.
    const { id: firmId } = await createSeededFirm();
    const owner = await ownerOf(firmId);
    const successor = await memberWith(firmId, ['matters.view']);

    await transfer(owner.api, firmId, successor.uid);
    await drainEvents();

    const handedBack = await transfer(successor.api, firmId, owner.uid);
    await drainEvents();

    expect(handedBack.status).toBe(200);
    expect((await ownershipOf(firmId)).filter((r: any) => r.is_owner).map((r: any) => r.user_id))
      .toEqual([owner.uid]);
  });

  it('leaves the demoted owner able to work', async () => {
    // Admin is every permission except this one, so the previous owner keeps
    // running the firm. A transfer that quietly cost them their access would be
    // read as a bug in whatever they tried next.
    const { id: firmId } = await createSeededFirm();
    const owner = await ownerOf(firmId);
    const successor = await memberWith(firmId, ['matters.view']);

    await transfer(owner.api, firmId, successor.uid);
    await drainEvents();

    const created = await owner.api
      .post(`/api/lawfirms/${firmId}/matters`)
      .send({ name: 'Matter created by the previous owner' });

    expect(created.status).toBe(201);
  });
});

describe('the permission alone is not enough', () => {
  it('refuses a member whose custom role holds firm.transferOwnership', async () => {
    // The case the service-level `isOwner` check exists for. A firm can build a
    // role holding every code, and nothing stops it: `assertNoPermissionEscalation`
    // only prevents granting MORE than the grantor has, and an owner has
    // everything. The route guard passes. Only the service refuses.
    //
    // If this ever answers 200, any member an owner trusted with a broad role
    // can take the firm.
    const { id: firmId } = await createSeededFirm();
    const owner = await ownerOf(firmId);
    const overpowered = await memberWith(firmId, [...ALL_PERMISSIONS]);

    // Naming themselves is refused by the self-transfer guard, which fires
    // first and says "you are already the firm owner" even though they are not.
    const toSelf = await transfer(overpowered.api, firmId, overpowered.uid);
    expect(toSelf.status).toBe(400);

    // Naming anyone else reaches the guard that matters.
    const toAnother = await transfer(overpowered.api, firmId, owner.uid);
    expect(toAnother.status).toBe(403);
    expect(toAnother.body.error).toMatch(/only the current firm owner/i);

    expect((await ownershipOf(firmId)).filter((r: any) => r.is_owner).map((r: any) => r.user_id))
      .toEqual([owner.uid]);
  });

  it('refuses that member from handing the firm to a third party', async () => {
    const { id: firmId } = await createSeededFirm();
    const owner = await ownerOf(firmId);
    const overpowered = await memberWith(firmId, [...ALL_PERMISSIONS]);
    const bystander = await memberWith(firmId, ['matters.view']);

    const res = await transfer(overpowered.api, firmId, bystander.uid);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only the current firm owner/i);
    expect((await ownershipOf(firmId)).filter((r: any) => r.is_owner).map((r: any) => r.user_id))
      .toEqual([owner.uid]);
  });
});

describe('refusals that protect the invariant', () => {
  it('refuses a transfer to yourself', async () => {
    const { id: firmId } = await createSeededFirm();
    const owner = await ownerOf(firmId);

    const res = await transfer(owner.api, firmId, owner.uid);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already the firm owner/i);
  });

  it('refuses a transfer to somebody who is not a member', async () => {
    // Otherwise the firm would be handed to a user id with no membership row,
    // and the firm would have no reachable owner at all.
    const { id: firmId } = await createSeededFirm();
    const owner = await ownerOf(firmId);
    const { id: otherFirmId } = await createSeededFirm();
    const outsider = await ownerOf(otherFirmId);

    const res = await transfer(owner.api, firmId, outsider.uid);

    expect(res.status).toBe(404);
    expect((await ownershipOf(firmId)).filter((r: any) => r.is_owner).map((r: any) => r.user_id))
      .toEqual([owner.uid]);
  });

  it('refuses an owner of another firm entirely', async () => {
    const { id: firmA } = await createSeededFirm();
    const { id: firmB } = await createSeededFirm();
    const ownerA = await ownerOf(firmA);
    const ownerB = await ownerOf(firmB);

    const res = await transfer(ownerB.api, firmA, ownerB.uid);

    expect(res.status).toBe(403);
    expect((await ownershipOf(firmA)).filter((r: any) => r.is_owner).map((r: any) => r.user_id))
      .toEqual([ownerA.uid]);
  });
});

describe('the demotion must not depend on a role the firm can delete', () => {
  it('still leaves the outgoing owner with admin access when the Admin role is gone', async () => {
    // `deleteRole` protects only the Owner role, so a firm can delete Admin.
    // `transferOwnership` then finds no Admin role, writes `role_id = null`, and
    // the outgoing owner resolves to the read-only baseline instead of "full
    // access minus owner-only actions" that the service promises.
    //
    // Nothing on screen says so. The transfer succeeds, and the previous owner
    // discovers it at the next thing they try. They cannot fix it themselves
    // either: restoring a role needs a permission the baseline does not carry,
    // so the firm depends on the NEW owner to undo it.
    const { id: firmId } = await createSeededFirm();
    const owner = await ownerOf(firmId);
    const successor = await memberWith(firmId, ['matters.view']);

    const { rows } = await testPool.query(
      `select id from roles where law_firm_id = $1 and name = 'Admin'`,
      [firmId],
    );
    const deleted = await owner.api.delete(`/api/lawfirms/${firmId}/roles/${rows[0].id}`);
    expect(deleted.status).toBe(200);

    const res = await transfer(owner.api, firmId, successor.uid);
    await drainEvents();
    expect(res.status).toBe(200);

    // The promise the service documents, asserted through what the outgoing
    // owner can actually still do rather than through the role name.
    const created = await owner.api
      .post(`/api/lawfirms/${firmId}/matters`)
      .send({ name: 'Matter created by the previous owner' });

    expect(created.status).toBe(201);
  });
});
