/**
 * Time logged from a task's own notes counts toward the task.
 *
 * A task's "Time Logged" sums the time entries whose `source_task_id` is the
 * task (`tasks.repository.ts`, `oneById`). Time added on a task note is billed
 * against the task's matter, so unless the entry also names the task as its
 * source it lands on the matter and the task itself reads as zero hours.
 *
 * Both ways of putting time on a task note are covered: a note posted with time
 * attached, and the note's own "Add time" action.
 *
 * Red if the task notes adapter stops passing the task as the entry's source.
 */
import {
  createFirm,
  createPersonClient,
  drainEvents,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedNote } from '../support/notesWorld';

const TIME = { timeSpent: 1.5, timeEntryDate: '2026-09-01', activityName: 'Drafting', isBillable: true };

let firm: Firm;
let owner: Actor;
let taskId: string;

const notesPath = (suffix = '') => `/api/lawfirms/${firm.id}/tasks/${taskId}/notes${suffix}`;
const sourceTaskIds = async () => (await testPool.query(
  `select source_task_id from activities where law_firm_id = $1 and kind = 'time'`, [firm.id],
)).rows.map((r: any) => r.source_task_id);
const loggedHours = async () => {
  const res = await owner.api.get(`/api/lawfirms/${firm.id}/tasks/${taskId}`);
  expect(res.status).toBe(200);
  return res.body.loggedHours;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: 'Time Client' });
  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Time Matter', clients: [{ clientId: client.id, name: 'Time Client' }],
  });
  expect(matter.status).toBe(201);
  const task = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`).send({ title: 'Timed task', matterId: matter.body.matterId });
  expect(task.status).toBe(201);
  taskId = task.body.taskId;
  await drainEvents();
});

it('counts time posted with a task note toward the task', async () => {
  expect(await loggedHours()).toBe(0);

  const res = await owner.api.post(notesPath()).send({ content: 'Drafted the motion', timeEntries: [TIME] });

  expect(res.status).toBe(201);
  expect(await sourceTaskIds()).toEqual([taskId]);
  expect(await loggedHours()).toBe(1.5);
});

it("counts time added through a task note's Add time toward the task", async () => {
  const note = await seedNote(firm.id, { taskId }, { content: 'Seeded', createdBy: owner.uid });

  const res = await owner.api.post(notesPath(`/${note.id}/time`)).send(TIME);

  expect(res.status).toBe(201);
  expect(await sourceTaskIds()).toEqual([taskId]);
  expect(await loggedHours()).toBe(1.5);
});
