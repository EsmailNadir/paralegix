/**
 * Replacing a matter's lead set changes `matter_members.role`, the same
 * membership authority that the dedicated member routes reserve for
 * `matters.manageMembers`. Editing ordinary matter metadata must not be a
 * side door to promote or demote colleagues.
 */
import { randomUUID } from 'crypto';
import {
  createFirm,
  memberWith,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let editor: Actor;
let colleague: Actor;
let matterId: string;

const M = () => `/api/lawfirms/${firm.id}/matters/${matterId}`;

async function memberRoles() {
  const { rows } = await testPool.query(
    `select user_id, role from matter_members
      where law_firm_id = $1 and matter_id = $2
      order by user_id`,
    [firm.id, matterId],
  );
  return rows as Array<{ user_id: string; role: string }>;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  editor = await memberWith(firm.id, ['matters.view', 'matters.update']);
  colleague = await memberWith(firm.id, ['matters.view']);
  matterId = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status, lead_user_id)
     values ($1, $2, 'Lead permission matter', $3, 'active', $4)`,
    [matterId, firm.id, `REF-${matterId.slice(0, 8)}`, owner.uid],
  );
  await testPool.query(
    `insert into matter_members (law_firm_id, matter_id, user_id, role)
     values ($1, $2, $3, 'lead'), ($1, $2, $4, 'member'), ($1, $2, $5, 'member')`,
    [firm.id, matterId, owner.uid, editor.uid, colleague.uid],
  );
});

describe('matter lead changes use the member-management permission', () => {
  it('does not let matters.update alone promote a colleague to lead', async () => {
    const res = await editor.api.put(M()).send({ leadUserIds: [colleague.uid] });

    // POST /:matterId/members with role=lead requires matters.manageMembers.
    // Changing the lead list must not demote the current lead or promote another.
    expect(res.status).toBe(403);
    expect(await memberRoles()).toEqual([
      { user_id: colleague.uid, role: 'member' },
      { user_id: editor.uid, role: 'member' },
      { user_id: owner.uid, role: 'lead' },
    ].sort((a, b) => a.user_id.localeCompare(b.user_id)));
  });

  it('allows a matter member with matters.manageMembers to replace the lead set', async () => {
    const manager = await memberWith(firm.id, [
      'matters.view',
      'matters.update',
      'matters.manageMembers',
    ]);
    await testPool.query(
      `insert into matter_members (law_firm_id, matter_id, user_id, role)
       values ($1, $2, $3, 'member')`,
      [firm.id, matterId, manager.uid],
    );

    const res = await manager.api.put(M()).send({ leadUserIds: [colleague.uid] });

    expect(res.status).toBe(200);
    expect(await memberRoles()).toEqual([
      { user_id: colleague.uid, role: 'lead' },
      { user_id: editor.uid, role: 'member' },
      { user_id: manager.uid, role: 'member' },
      { user_id: owner.uid, role: 'member' },
    ].sort((a, b) => a.user_id.localeCompare(b.user_id)));
  });
});

export {};
