/**
 * A court or practice area id that does not name one of this firm's rows is a
 * 400 on every write path that takes one.
 *
 * Tasks always refused it. Creating a matter silently stored null for both, and
 * updating a matter refused a bad practice area but silently nulled a bad court,
 * so the same wrong id was an error on one screen and a quiet data loss on the
 * next. The caller got a 200 and a record with no court. Each case below drives
 * the real route with an id that does not belong to the firm (a made-up uuid,
 * another firm's real row, and a string that is not a uuid at all) and asserts
 * the status AND that nothing was written. Red if any of the four paths goes
 * back to nulling.
 */
import { randomUUID } from 'crypto';

import {
  createFirm,
  createPersonClient,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let ownCourtId: string;
let ownAreaId: string;
let foreignCourtId: string;
let foreignAreaId: string;
let clientId: string;

type Field = 'courtId' | 'practiceAreaId';

const column: Record<Field, string> = { courtId: 'court_id', practiceAreaId: 'practice_area_id' };

interface Target {
  name: string;
  table: 'matters' | 'tasks';
  /** Sends the write and returns the response. */
  write: (body: Record<string, unknown>) => Promise<any>;
  /** The row the write acts on, or null for a create (nothing may be inserted). */
  existingId: () => string | null;
  /** The firm's row count in the table. */
  count: () => Promise<number>;
}

let matterId: string;
let taskId: string;

const countOf = async (table: string) => (await testPool.query(
  `select count(*)::int n from ${table} where law_firm_id = $1`, [firm.id],
)).rows[0].n as number;

const targets: Target[] = [
  {
    name: 'create matter',
    table: 'matters',
    write: (body) => owner.api.post(`/api/lawfirms/${firm.id}/matters`)
      .send({ name: 'New Matter', clients: [{ clientId, name: 'Pat Person' }], ...body }),
    existingId: () => null,
    count: () => countOf('matters'),
  },
  {
    name: 'update matter',
    table: 'matters',
    write: (body) => owner.api.put(`/api/lawfirms/${firm.id}/matters/${matterId}`).send(body),
    existingId: () => matterId,
    count: () => countOf('matters'),
  },
  {
    name: 'create task',
    table: 'tasks',
    write: (body) => owner.api.post(`/api/lawfirms/${firm.id}/tasks`).send({ title: 'New Task', ...body }),
    existingId: () => null,
    count: () => countOf('tasks'),
  },
  {
    name: 'update task',
    table: 'tasks',
    write: (body) => owner.api.put(`/api/lawfirms/${firm.id}/tasks/${taskId}`).send(body),
    existingId: () => taskId,
    count: () => countOf('tasks'),
  },
];

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const other = await createFirm();
  const insert = async (table: string, lawFirmId: string, name: string) => (await testPool.query(
    `insert into ${table} (law_firm_id, name) values ($1, $2) returning id`, [lawFirmId, name],
  )).rows[0].id as string;
  ownCourtId = await insert('courts', firm.id, 'Own Court');
  ownAreaId = await insert('practice_areas', firm.id, 'Own Area');
  foreignCourtId = await insert('courts', other.id, 'Foreign Court');
  foreignAreaId = await insert('practice_areas', other.id, 'Foreign Area');
  clientId = (await createPersonClient(firm.id, { name: 'Pat Person' })).id;
  matterId = (await testPool.query(
    `insert into matters (law_firm_id, name, matter_reference_id, status) values ($1, 'Existing', $2, 'active') returning id`,
    [firm.id, `REF-${randomUUID().slice(0, 8)}`],
  )).rows[0].id;
  taskId = (await testPool.query(
    `insert into tasks (law_firm_id, title) values ($1, 'Existing') returning id`, [firm.id],
  )).rows[0].id;
});

const badValues = (field: Field) => [
  ['an id that does not exist', () => randomUUID()],
  ["another firm's id", () => (field === 'courtId' ? foreignCourtId : foreignAreaId)],
  ['a string that is not a uuid', () => 'not-a-uuid'],
] as Array<[string, () => string]>;

describe.each(targets)('$name', (target) => {
  describe.each(['courtId', 'practiceAreaId'] as Field[])('%s', (field) => {
    it.each(badValues(field))('refuses %s with a 400 and writes nothing', async (_label, valueOf) => {
      const before = await target.count();
      const id = target.existingId();
      const stored = id
        ? (await testPool.query(`select ${column[field]} v from ${target.table} where id = $1`, [id])).rows[0].v
        : null;

      const res = await target.write({ [field]: valueOf() });

      expect(res.status).toBe(400);
      expect(await target.count()).toBe(before);
      if (id) {
        const after = await testPool.query(`select ${column[field]} v from ${target.table} where id = $1`, [id]);
        expect(after.rows[0].v).toBe(stored);
      }
    });

    it("stores the firm's own row", async () => {
      const own = field === 'courtId' ? ownCourtId : ownAreaId;

      const res = await target.write({ [field]: own });

      expect([200, 201]).toContain(res.status);
      const id = target.existingId() ?? (res.body.matterId ?? res.body.taskId);
      const row = await testPool.query(`select ${column[field]} v from ${target.table} where id = $1`, [id]);
      expect(row.rows[0].v).toBe(own);
    });
  });
});
