/**
 * B02.2 A08/A09 across three genuinely different modules (billing, matters,
 * tasks — three different router files, three different services).
 *
 * A08 — a member holding the READ side of a permission pair, but not the
 * WRITE side, must be refused the write with the correct error shape while
 * the paired read stays useful. Critically, a grant from a wholly unrelated
 * domain must not incidentally authorize the write either: `requirePermission`
 * checks membership in a fixed allow-list for the route, so a bug that
 * widened that list (or an `||` instead of the right permission constant)
 * would pass every existing test that only tries the empty-baseline case.
 *
 * A09 — a member holding the EXACT required grant must have the write
 * actually complete, and a fresh read (not just the mutation's own response,
 * where that would prove the point circularly) must show the changed state.
 * `permissionBoundary.test.ts` already checks "status < 400" for a few write
 * routes; this file checks the state those routes are supposed to produce.
 */
import {
  createFirm, ownerOf, memberWith, testPool,
} from '../support/setupInProcess';

describe('billing charge codes: creating one needs billing.manageRates, not billing.viewRates', () => {
  it('A08: a read-only member reads the list but is refused creating a code, and an unrelated write grant does not help', async () => {
    const { id: firmId } = await createFirm();
    // Reading rates is an explicit grant independent of managing them.
    const readOnly = await memberWith(firmId, ['billing.viewRates']);

    const listBefore = await readOnly.api.get(`/api/lawfirms/${firmId}/billing/charge-codes`);
    expect(listBefore.status).toBe(200);
    expect(listBefore.body.chargeCodes).toEqual([]);

    const refused = await readOnly.api
      .post(`/api/lawfirms/${firmId}/billing/charge-codes`)
      .send({ code: 'RES01', name: 'Research' });
    expect({ status: refused.status, code: refused.body?.code }).toEqual({ status: 403, code: 'FORBIDDEN' });

    // A grant from a completely different domain (matters, not billing) must
    // not incidentally unlock this write.
    const wrongGrant = await memberWith(firmId, ['matters.create']);
    const stillRefused = await wrongGrant.api
      .post(`/api/lawfirms/${firmId}/billing/charge-codes`)
      .send({ code: 'RES02', name: 'Research Two' });
    expect({ status: stillRefused.status, code: stillRefused.body?.code }).toEqual({ status: 403, code: 'FORBIDDEN' });

    // Neither refused attempt left a row behind.
    const listAfter = await readOnly.api.get(`/api/lawfirms/${firmId}/billing/charge-codes`);
    expect(listAfter.body.chargeCodes).toEqual([]);
  });

  it('A09: the exact grant creates the charge code, and a fresh list (not just the 201) shows it', async () => {
    const { id: firmId } = await createFirm();
    const granted = await memberWith(firmId, ['billing.manageRates', 'billing.viewRates']);

    const created = await granted.api
      .post(`/api/lawfirms/${firmId}/billing/charge-codes`)
      .send({ code: 'RES01', name: 'Research', defaultRate: 150 });

    expect(created.status).toBe(201);
    expect(created.body).toEqual({ message: 'Charge code created successfully', chargeCodeId: expect.any(String) });

    const list = await granted.api.get(`/api/lawfirms/${firmId}/billing/charge-codes`);
    expect(list.status).toBe(200);
    const codes = list.body.chargeCodes.map((c: any) => ({ code: c.code, name: c.name, defaultRate: c.defaultRate }));
    expect(codes).toContainEqual({ code: 'RES01', name: 'Research', defaultRate: 150 });
  });
});

describe('matters: renaming one needs matters.update, not just matters.view', () => {
  /**
   * Both actors below are inserted into `matter_members` alongside their role,
   * so the write refusal is attributable to the missing `matters.update`
   * permission alone, not to the separate "must be staffed on the matter"
   * rule `assertMatterWriteAccess` also enforces for non-admins. That second
   * rule is real (see the A09 case below, which deliberately satisfies it)
   * but is not what this test is pinning.
   */
  async function stageMatterMember(firmId: string, matterId: string, uid: string) {
    await testPool.query(
      `insert into matter_members (law_firm_id, matter_id, user_id, role) values ($1, $2, $3, 'member')`,
      [firmId, matterId, uid],
    );
  }

  it('A08: a baseline member (staffed on the matter) reads it but is refused renaming it, and an unrelated write grant does not help', async () => {
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const created = await owner.api.post(`/api/lawfirms/${firmId}/matters`).send({ name: 'Original Matter Name' });
    expect(created.status).toBe(201);
    const matterId = created.body.matterId;

    const readOnly = await memberWith(firmId, []);
    await stageMatterMember(firmId, matterId, readOnly.uid);

    const readBefore = await readOnly.api.get(`/api/lawfirms/${firmId}/matters/${matterId}`);
    expect(readBefore.status).toBe(200);
    expect(readBefore.body.name).toBe('Original Matter Name');

    const refused = await readOnly.api
      .put(`/api/lawfirms/${firmId}/matters/${matterId}`)
      .send({ name: 'Renamed By Read Only' });
    expect({ status: refused.status, code: refused.body?.code }).toEqual({ status: 403, code: 'FORBIDDEN' });

    // billing.manageRates has nothing to do with editing a matter's own record.
    const wrongGrant = await memberWith(firmId, ['billing.manageRates']);
    await stageMatterMember(firmId, matterId, wrongGrant.uid);
    const stillRefused = await wrongGrant.api
      .put(`/api/lawfirms/${firmId}/matters/${matterId}`)
      .send({ name: 'Renamed By Wrong Grant' });
    expect({ status: stillRefused.status, code: stillRefused.body?.code }).toEqual({ status: 403, code: 'FORBIDDEN' });

    const readAfter = await owner.api.get(`/api/lawfirms/${firmId}/matters/${matterId}`);
    expect(readAfter.body.name).toBe('Original Matter Name');
  });

  it('A09: the exact grant (plus being staffed on the matter) renames it, and a fresh read shows it', async () => {
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const created = await owner.api.post(`/api/lawfirms/${firmId}/matters`).send({ name: 'Original Matter Name' });
    const matterId = created.body.matterId;

    const granted = await memberWith(firmId, ['matters.update']);
    await stageMatterMember(firmId, matterId, granted.uid);

    const updated = await granted.api
      .put(`/api/lawfirms/${firmId}/matters/${matterId}`)
      .send({ name: 'Renamed By Exact Grant' });
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({ message: 'Matter updated successfully' });

    const fresh = await owner.api.get(`/api/lawfirms/${firmId}/matters/${matterId}`);
    expect(fresh.body.name).toBe('Renamed By Exact Grant');
  });
});

describe('tasks: renaming one needs tasks.update, not just tasks.view', () => {
  it('A08: a baseline member reads the task but is refused renaming it, and an unrelated write grant does not help', async () => {
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    // Standalone task (no matterId), so the only gate in play is the route
    // permission itself, not the separate matter-membership check tasks
    // carry when they belong to a matter.
    const created = await owner.api.post(`/api/lawfirms/${firmId}/tasks`).send({ title: 'Original Task Title' });
    expect(created.status).toBe(201);
    const taskId = created.body.taskId;

    const readOnly = await memberWith(firmId, []);
    const readBefore = await readOnly.api.get(`/api/lawfirms/${firmId}/tasks/${taskId}`);
    expect(readBefore.status).toBe(200);
    expect(readBefore.body.title).toBe('Original Task Title');

    const refused = await readOnly.api
      .put(`/api/lawfirms/${firmId}/tasks/${taskId}`)
      .send({ title: 'Renamed By Read Only' });
    expect({ status: refused.status, code: refused.body?.code }).toEqual({ status: 403, code: 'FORBIDDEN' });

    // clients.manage has nothing to do with editing a task.
    const wrongGrant = await memberWith(firmId, ['clients.manage']);
    const stillRefused = await wrongGrant.api
      .put(`/api/lawfirms/${firmId}/tasks/${taskId}`)
      .send({ title: 'Renamed By Wrong Grant' });
    expect({ status: stillRefused.status, code: stillRefused.body?.code }).toEqual({ status: 403, code: 'FORBIDDEN' });

    const readAfter = await owner.api.get(`/api/lawfirms/${firmId}/tasks/${taskId}`);
    expect(readAfter.body.title).toBe('Original Task Title');
  });

  it('A09: the exact grant renames the task, and both the mutation response and a fresh read show it', async () => {
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const created = await owner.api.post(`/api/lawfirms/${firmId}/tasks`).send({ title: 'Original Task Title' });
    const taskId = created.body.taskId;

    const granted = await memberWith(firmId, ['tasks.update']);
    const updated = await granted.api
      .put(`/api/lawfirms/${firmId}/tasks/${taskId}`)
      .send({ title: 'Renamed By Exact Grant' });
    expect(updated.status).toBe(200);
    expect(updated.body.task.title).toBe('Renamed By Exact Grant');

    const fresh = await owner.api.get(`/api/lawfirms/${firmId}/tasks/${taskId}`);
    expect(fresh.body.title).toBe('Renamed By Exact Grant');
  });
});
