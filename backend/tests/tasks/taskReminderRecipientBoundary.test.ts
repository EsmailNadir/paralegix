/**
 * Explicit task reminder recipients receive the task title, due date, and—on
 * matter work—the matter name. They are an audience boundary, not arbitrary
 * metadata, and must obey the same firm/matter membership rules as assignees.
 */
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
let outsider: Actor;
let matterId: string;

const T = () => `/api/lawfirms/${firm.id}/tasks`;

async function taskCount() {
  const { rows } = await testPool.query(
    'select count(*)::int as count from tasks where law_firm_id = $1',
    [firm.id],
  );
  return rows[0].count as number;
}

async function reminderRecipientsFor(taskId: string) {
  const { rows } = await testPool.query(
    'select reminder_recipient_ids from tasks where id = $1',
    [taskId],
  );
  return rows[0]?.reminder_recipient_ids ?? [];
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  outsider = await memberWith(firm.id, ['tasks.view']);
  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Reminder-confidential matter',
  });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;
});

describe('matter task reminder recipients respect the matter boundary', () => {
  it('does not let a matter member schedule reminders to a firm colleague outside the matter', async () => {
    const res = await owner.api.post(T()).send({
      title: 'Confidential deadline',
      matterId,
      dueDate: '2026-10-01',
      reminderRecipientIds: [outsider.uid],
    });

    expect(res.status).toBe(403);
    expect(await taskCount()).toBe(0);
  });

  it('allows a current matter member to be an explicit reminder recipient', async () => {
    const res = await owner.api.post(T()).send({
      title: 'Internal deadline',
      matterId,
      dueDate: '2026-10-01',
      reminderRecipientIds: [owner.uid],
    });

    expect(res.status).toBe(201);
    expect(await taskCount()).toBe(1);
  });

  it('does not let an update add an outsider to an existing matter task reminder audience', async () => {
    const created = await owner.api.post(T()).send({
      title: 'Existing confidential deadline',
      matterId,
      dueDate: '2026-10-01',
    });
    expect(created.status).toBe(201);

    const res = await owner.api.put(`${T()}/${created.body.taskId}`).send({
      reminderRecipientIds: [outsider.uid],
    });

    expect(res.status).toBe(403);
    expect(await reminderRecipientsFor(created.body.taskId)).toEqual([]);
  });
});

export {};
