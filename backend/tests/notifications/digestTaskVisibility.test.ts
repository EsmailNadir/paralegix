/**
 * Digest task audience boundaries (B08.1).
 *
 * The digest's task query has a deliberately asymmetric visibility rule:
 * assignees see their assigned work even when they are not on the matter team,
 * while an unassigned matter task falls back only to that matter's team. This
 * is an email-recipient boundary, not merely a list-filter detail: widening the
 * unassigned branch would put a matter's deadline in every firm member's inbox.
 */
import { randomUUID } from 'crypto';
import {
  createFirm,
  memberWith,
  ownerOf,
  testPool,
} from '../support/setupInProcess';
import { findDigestTasks } from '../../src/modules/notifications/digest/digest.repository';

const TODAY = '2026-09-01';
const WINDOW_END = '2026-09-08';

async function seedMatter(lawFirmId: string, memberId: string): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, 'Confidential Digest Matter', $3)`,
    [id, lawFirmId, `DIGEST-${id}`],
  );
  await testPool.query(
    `insert into matter_members (matter_id, user_id, law_firm_id)
     values ($1, $2, $3)`,
    [id, memberId, lawFirmId],
  );
  return id;
}

async function seedTask(lawFirmId: string, matterId: string, title: string): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into tasks (id, law_firm_id, matter_id, title, status, due_date)
     values ($1, $2, $3, $4, 'open', $5::date)`,
    [id, lawFirmId, matterId, title, TODAY],
  );
  return id;
}

describe('digest task recipient boundaries', () => {
  it('keeps an unassigned matter task on its team while delivering an explicitly assigned task only to its assignee', async () => {
    const firm = await createFirm({ name: 'Digest Task Audience' });
    const matterMember = await ownerOf(firm.id);
    const outsideAssignee = await memberWith(firm.id, ['tasks.view']);
    const matterId = await seedMatter(firm.id, matterMember.uid);
    const teamTaskId = await seedTask(firm.id, matterId, 'Team-only unassigned deadline');
    const assignedTaskId = await seedTask(firm.id, matterId, 'Assignee-only deadline');
    await testPool.query(
      `insert into task_assignees (law_firm_id, task_id, user_id)
         select t.law_firm_id, t.id, $2 from tasks t where t.id = $1`,
      [assignedTaskId, outsideAssignee.uid],
    );

    const [teamTasks, assigneeTasks] = await Promise.all([
      findDigestTasks(firm.id, matterMember.uid, TODAY, WINDOW_END),
      findDigestTasks(firm.id, outsideAssignee.uid, TODAY, WINDOW_END),
    ]);

    // The team member sees the unassigned fallback, but an assignment means
    // the other deadline is no longer broadcast to the whole matter team.
    expect(teamTasks.map((task: any) => task.id)).toEqual([teamTaskId]);
    // Explicit assignment is sufficient even without matter membership, but it
    // must not also pull the matter's unrelated unassigned work into the email.
    expect(assigneeTasks.map((task: any) => task.id)).toEqual([assignedTaskId]);
  });
});
