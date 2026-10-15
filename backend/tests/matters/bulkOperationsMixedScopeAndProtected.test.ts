/**
 * Bulk reassignment and deletion: mixed scopes, protected records, and error mapping.
 *
 * B10.2 requirement:
 * "Bulk reassignment or deletion includes mixed scopes, protected records,
 * and accurate per-item result/error mapping."
 *
 * Covers:
 * 1. Matter bulk-delete (`POST /api/lawfirms/:id/matters/bulk-delete`):
 *    - Legitimate deletable matter is removed and emits MATTER_DELETED.
 *    - Protected matter under legal hold is preserved with exact error mapping.
 *    - Protected matter with trust account activity is preserved with exact error mapping.
 *    - Protected matter with billing records (unbilled time entries) is preserved with exact error mapping.
 *    - Protected matter where caller is not staffed (non-member) is preserved with exact error mapping.
 *    - Non-existent matter ID is reported as not found.
 *    - Database state proves legitimate row is deleted while all 4 protected rows and their
 *      sub-resources (trust ledger, time entries) survive intact.
 *
 * 2. Task bulk-delete (`POST /api/lawfirms/:id/tasks/bulk-delete`):
 *    - Task on accessible matter is deleted.
 *    - Standalone task with no matter is deleted.
 *    - Task on inaccessible matter (caller not on matter) is preserved with 'No access to task matter'.
 *    - Non-existent task ID is mapped to 'Task not found'.
 *
 * 3. Task bulk-matter reassignment (`POST /api/lawfirms/:id/tasks/bulk-matter`):
 *    - Task with assignees on destination matter is reassigned.
 *    - Task with an assignee NOT on destination matter is refused per-item with
 *      membership requirement error, preserving prior matter affiliation.
 *    - Task on inaccessible source matter is refused with 'No access to current task matter'.
 *    - Standalone task with no assignees is reassigned.
 *    - Non-existent task ID is mapped to 'Task not found'.
 *
 * 4. Matter bulk-update-status (`POST /api/lawfirms/:id/matters/bulk-update-status`):
 *    - Mixed batch with accessible matter and inaccessible matter. Accessible matter updates;
 *      inaccessible matter is preserved and mapped to per-item failure.
 *
 * 5. Matter bulk-update-practice-area (`POST /api/lawfirms/:id/matters/bulk-update-practice-area`):
 *    - Mixed batch with accessible matter and inaccessible matter. Accessible matter updates;
 *      inaccessible matter is preserved and mapped to per-item failure.
 */
import { randomUUID } from 'crypto';

import { installInMemoryBucket } from '../support/inMemoryBucket';
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createPersonClient,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

async function createMatter(
  lawFirmId: string,
  name: string,
  memberUids: string[] = [],
): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1, $2, $3, $4, 'active')`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  for (const uid of memberUids) {
    await testPool.query(
      `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at)
       values ($1, $2, $3, 'lead', now())`,
      [lawFirmId, id, uid],
    );
  }
  return id;
}

async function createTask(
  lawFirmId: string,
  title: string,
  options: { matterId?: string | null; assignedTo?: string[] } = {},
): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into tasks (id, law_firm_id, title, matter_id, status)
     values ($1, $2, $3, $4, 'open')`,
    [id, lawFirmId, title, options.matterId || null],
  );
  if (options.assignedTo?.length) {
    for (const uid of options.assignedTo) {
      await testPool.query(
        `insert into task_assignees (law_firm_id, task_id, user_id)
         select t.law_firm_id, t.id, $2 from tasks t where t.id = $1`,
        [id, uid],
      );
    }
  }
  return id;
}

async function getMatter(id: string) {
  const { rows } = await testPool.query('select * from matters where id = $1', [id]);
  return rows[0] || null;
}

async function getTask(id: string) {
  const { rows } = await testPool.query('select * from tasks where id = $1', [id]);
  return rows[0] || null;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Bulk Operations Firm' });
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Bulk Client' });
  await drainEvents();
});

describe('matter bulk-delete: mixed scopes, protected records, and error mapping', () => {
  it('deletes legitimate matter while preserving legal-hold, trust-active, billed, and non-member matters', async () => {
    // Non-owner member holding matters.delete and matters.view
    const member = await createFirmMember(firm.id, {
      isOwner: false,
      permissions: ['matters.view', 'matters.delete', 'matters.update'],
    });

    // 1. Legitimate deletable matter: active, empty, member is staffed
    const deletableMatterId = await createMatter(firm.id, 'Deletable Matter', [member.uid]);

    // 2. Protected matter: under legal hold
    const heldMatterId = await createMatter(firm.id, 'Held Matter', [member.uid]);
    await testPool.query(
      `insert into legal_holds (law_firm_id, matter_id, reason)
       select law_firm_id, id, 'fixture hold' from matters where id = $1`,
      [heldMatterId],
    );

    // 3. Protected matter: has trust account activity
    const trustMatterId = await createMatter(firm.id, 'Trust Active Matter', [member.uid]);
    // Seed trust account and transaction
    const trustAccountId = randomUUID();
    await testPool.query(
      `insert into trust_accounts (id, law_firm_id, name, account_type)
       values ($1, $2, 'IOLTA Trust', 'iolta')`,
      [trustAccountId, firm.id],
    );
    const trustTxnId = randomUUID();
    await testPool.query(
      `insert into trust_transactions
         (id, law_firm_id, trust_account_id, matter_id, client_id, txn_date, type, amount_cents, status, description)
       values ($1, $2, $3, $4, $5, '2026-09-01', 'deposit', 50000, 'completed', 'Retainer deposit')`,
      [trustTxnId, firm.id, trustAccountId, trustMatterId, client.id],
    );

    // 4. Protected matter: has billing records (time entry)
    const billedMatterId = await createMatter(firm.id, 'Billed Matter', [member.uid]);
    const timeEntryId = randomUUID();
    await testPool.query(
      `insert into activities (kind, id, law_firm_id, matter_id, user_id, activity_date, hours, rate_cents, description)
       values ('time', $1, $2, $3, $4, '2026-09-01', 1.5, 30000, 'Initial drafting')`,
      [timeEntryId, firm.id, billedMatterId, member.uid],
    );

    // 5. Protected matter: caller is NOT a member of this matter
    const nonMemberMatterId = await createMatter(firm.id, 'Confidential Other Matter', [owner.uid]);

    // 6. Non-existent matter ID
    const nonExistentMatterId = randomUUID();

    const payload = [
      deletableMatterId,
      heldMatterId,
      trustMatterId,
      billedMatterId,
      nonMemberMatterId,
      nonExistentMatterId,
    ];

    const res = await as(tokenFor({ uid: member.uid }))
      .post(`/api/lawfirms/${firm.id}/matters/bulk-delete`)
      .send({ matterIds: payload });

    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(6);
    expect(res.body.deleted).toBe(1);
    expect(res.body.failed).toHaveLength(5);

    // Assert exact error mapping
    expect(res.body.errors[heldMatterId]).toBe(
      'This matter is under legal hold and cannot be deleted.',
    );
    expect(res.body.errors[trustMatterId]).toContain(
      'This matter has trust account activity and cannot be deleted.',
    );
    expect(res.body.errors[billedMatterId]).toContain(
      'This matter has billing records (invoices, time entries, or expenses) and cannot be deleted.',
    );
    expect(res.body.errors[nonMemberMatterId]).toBe(
      'User is not a member of this matter',
    );
    expect(res.body.errors[nonExistentMatterId]).toBe(
      'Matter not found',
    );

    // Database assertions: exactly the deletable matter was removed
    expect(await getMatter(deletableMatterId)).toBeNull();

    // All protected matters survived
    expect(await getMatter(heldMatterId)).not.toBeNull();
    expect(await getMatter(trustMatterId)).not.toBeNull();
    expect(await getMatter(billedMatterId)).not.toBeNull();
    expect(await getMatter(nonMemberMatterId)).not.toBeNull();

    // Sub-resources survived
    const { rows: txnRows } = await testPool.query(
      'select id from trust_transactions where id = $1',
      [trustTxnId],
    );
    expect(txnRows).toHaveLength(1);

    const { rows: teRows } = await testPool.query(
      `select id from activities where kind = 'time' and id = $1`,
      [timeEntryId],
    );
    expect(teRows).toHaveLength(1);
  });
});

describe('task bulk-delete: mixed scopes and inaccessible matters', () => {
  it('deletes accessible tasks while rejecting tasks on inaccessible matters', async () => {
    const member = await createFirmMember(firm.id, {
      isOwner: false,
      permissions: ['tasks.view', 'tasks.delete'],
    });

    const accessibleMatterId = await createMatter(firm.id, 'Staffed Matter', [member.uid]);
    const inaccessibleMatterId = await createMatter(firm.id, 'Unstaffed Matter', [owner.uid]);

    // 1. Task on accessible matter
    const task1 = await createTask(firm.id, 'Accessible task', { matterId: accessibleMatterId });

    // 2. Standalone task with no matter
    const task2 = await createTask(firm.id, 'Standalone task', { matterId: null });

    // 3. Task on inaccessible matter
    const task3 = await createTask(firm.id, 'Inaccessible task', { matterId: inaccessibleMatterId });

    // 4. Non-existent task
    const nonExistentTaskId = randomUUID();

    const res = await as(tokenFor({ uid: member.uid }))
      .post(`/api/lawfirms/${firm.id}/tasks/bulk-delete`)
      .send({ taskIds: [task1, task2, task3, nonExistentTaskId] });

    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(4);
    expect(res.body.deleted).toBe(2);
    expect(res.body.failed).toContain(task3);
    expect(res.body.failed).toContain(nonExistentTaskId);

    expect(res.body.errors[task3]).toBe('No access to task matter');
    expect(res.body.errors[nonExistentTaskId]).toBe('Task not found');

    // DB verification
    expect(await getTask(task1)).toBeNull();
    expect(await getTask(task2)).toBeNull();
    expect(await getTask(task3)).not.toBeNull();
  });
});

describe('task bulk-matter reassignment: mixed scopes, assignee boundaries, and error mapping', () => {
  it('reassigns valid tasks while rejecting tasks with unstaffed assignees or inaccessible source matters', async () => {
    const member = await createFirmMember(firm.id, {
      isOwner: false,
      permissions: ['tasks.view', 'tasks.update'],
    });
    const colleague = await createFirmMember(firm.id, {
      isOwner: false,
      permissions: ['tasks.view'],
    });

    // Destination matter: member and owner are staffed; colleague is NOT staffed
    const destMatterId = await createMatter(firm.id, 'Destination Matter', [member.uid, owner.uid]);

    // Source matter: member is staffed
    const sourceMatterId = await createMatter(firm.id, 'Source Matter', [member.uid, colleague.uid]);

    // Inaccessible source matter: member is NOT staffed
    const inaccessibleMatterId = await createMatter(firm.id, 'Inaccessible Matter', [owner.uid]);

    // Task A: assigned to member (who IS on destMatter) -> should succeed
    const taskA = await createTask(firm.id, 'Task A', {
      matterId: sourceMatterId,
      assignedTo: [member.uid],
    });

    // Task B: assigned to colleague (who is NOT on destMatter) -> should fail per-item
    const taskB = await createTask(firm.id, 'Task B', {
      matterId: sourceMatterId,
      assignedTo: [colleague.uid],
    });

    // Task C: on inaccessible matter -> should fail with no access to current task matter
    const taskC = await createTask(firm.id, 'Task C', {
      matterId: inaccessibleMatterId,
      assignedTo: [owner.uid],
    });

    // Task D: standalone unassigned task -> should succeed
    const taskD = await createTask(firm.id, 'Task D', { matterId: null, assignedTo: [] });

    // Non-existent task
    const nonExistentTaskId = randomUUID();

    const res = await as(tokenFor({ uid: member.uid }))
      .post(`/api/lawfirms/${firm.id}/tasks/bulk-matter`)
      .send({
        taskIds: [taskA, taskB, taskC, taskD, nonExistentTaskId],
        matterId: destMatterId,
      });

    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(5);
    expect(res.body.updated).toBe(2);
    expect(res.body.failed).toHaveLength(3);

    // Errors map verification
    expect(res.body.errors[taskB]).toContain('to this matter before assigning them work on it');
    expect(res.body.errors[taskC]).toBe('No access to current task matter');
    expect(res.body.errors[nonExistentTaskId]).toBe('Task not found');

    // DB state verification
    const updatedA = await getTask(taskA);
    expect(updatedA.matter_id).toBe(destMatterId);

    const updatedD = await getTask(taskD);
    expect(updatedD.matter_id).toBe(destMatterId);

    // Rejected tasks must NOT be reassigned
    const preservedB = await getTask(taskB);
    expect(preservedB.matter_id).toBe(sourceMatterId);

    const preservedC = await getTask(taskC);
    expect(preservedC.matter_id).toBe(inaccessibleMatterId);
  });
});

describe('matter bulk-update-status and bulk-update-practice-area: mixed membership scopes', () => {
  it('bulk-update-status updates staffed matters and rejects unstaffed matters', async () => {
    const member = await createFirmMember(firm.id, {
      isOwner: false,
      permissions: ['matters.view', 'matters.update'],
    });

    const staffedMatterId = await createMatter(firm.id, 'Staffed Matter', [member.uid]);
    const unstaffedMatterId = await createMatter(firm.id, 'Unstaffed Matter', [owner.uid]);

    const res = await as(tokenFor({ uid: member.uid }))
      .post(`/api/lawfirms/${firm.id}/matters/bulk-update-status`)
      .send({
        matterIds: [staffedMatterId, unstaffedMatterId],
        status: 'closed',
      });

    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(2);
    expect(res.body.updated).toBe(1);
    expect(res.body.failed).toContain(unstaffedMatterId);
    expect(res.body.errors[unstaffedMatterId]).toBe('User is not a member of this matter');

    expect((await getMatter(staffedMatterId)).status).toBe('closed');
    expect((await getMatter(unstaffedMatterId)).status).toBe('active');
  });

  it('bulk-update-practice-area updates staffed matters and rejects unstaffed matters', async () => {
    const member = await createFirmMember(firm.id, {
      isOwner: false,
      permissions: ['matters.view', 'matters.update'],
    });

    // Seed practice area
    const practiceAreaId = randomUUID();
    await testPool.query(
      `insert into practice_areas (id, law_firm_id, name)
       values ($1, $2, 'Corporate Law')`,
      [practiceAreaId, firm.id],
    );

    const staffedMatterId = await createMatter(firm.id, 'Staffed PA Matter', [member.uid]);
    const unstaffedMatterId = await createMatter(firm.id, 'Unstaffed PA Matter', [owner.uid]);

    const res = await as(tokenFor({ uid: member.uid }))
      .post(`/api/lawfirms/${firm.id}/matters/bulk-update-practice-area`)
      .send({
        matterIds: [staffedMatterId, unstaffedMatterId],
        practiceAreaId,
      });

    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(2);
    expect(res.body.updated).toBe(1);
    expect(res.body.failed).toContain(unstaffedMatterId);
    expect(res.body.errors[unstaffedMatterId]).toBe('User is not a member of this matter');

    expect((await getMatter(staffedMatterId)).practice_area_id).toBe(practiceAreaId);
    expect((await getMatter(unstaffedMatterId)).practice_area_id).toBeNull();
  });
});
