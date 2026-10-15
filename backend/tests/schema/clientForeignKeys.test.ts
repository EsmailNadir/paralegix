/**
 * Every foreign key to `clients(id)` is real, and each one names its own delete
 * action.
 *
 * Until migration 0225 there was exactly ONE. `schema.sql` declared twenty and a
 * sweep at the foot of the file dropped nineteen, keeping only
 * `conversations.client_record_id`, which migration 0172 had excluded by name.
 * So `client_id` was an unconstrained uuid on time entries, invoices, expenses
 * and the trust ledger: nothing stopped a row naming a client that had been
 * deleted, or one belonging to another firm.
 *
 * WHAT MAKES THIS GO RED: reinstating a sweep, adding a column that points at
 * `clients` without a key, dropping one, or changing an action. The action is
 * the part worth pinning. Seven of these were `cascade` before 0225, which meant
 * deleting a client would have destroyed its invoices, time entries, expenses,
 * billing plans, retainer threshold and trust ledger entries. Flipping any of
 * them back would be silent: the delete would simply start succeeding.
 */
import { randomUUID } from 'crypto';

import { testPool, createFirm, createPersonClient } from '../support/setupInProcess';

/** `table.column action`, as migration 0225 declared them. */
const EXPECTED = new Set<string>([
  'billing_plans.client_id restrict',
  'billing_plans.default_client_id set null',
  'client_company_links.company_client_id cascade',
  'client_company_links.person_client_id cascade',
  'client_identity_verifications.client_id cascade',
  'contact_clients.client_id cascade',
  'conversation_participants.client_id cascade',
  'conversations.client_record_id restrict',
  'document_requests.client_id cascade',
  'events.client_id cascade',
  'file_client_visibility.client_id cascade',
  'files.client_id cascade',
  'activities.client_id restrict',
  'invitations.client_id set null',
  'invoices.client_context_id restrict',
  'invoices.client_id set null',
  'matter_clients.client_id cascade',
  'notes.client_id cascade',
  'task_clients.client_id cascade',
  'trust_minimum_balances.client_id restrict',
  'trust_transactions.client_id restrict',
]);

const ACTION = { a: 'no action', r: 'restrict', c: 'cascade', n: 'set null', d: 'set default' } as const;

describe('foreign keys to clients(id)', () => {
  it('declares every one of them, with the delete action it was given', async () => {
    const { rows } = await testPool.query(
      `select cl.relname as tbl, att.attname as col, con.confdeltype as act
         from pg_constraint con
         join pg_class cl on cl.oid = con.conrelid
         join unnest(con.conkey) as k(attnum) on true
         join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
        where con.contype = 'f' and con.confrelid = 'clients'::regclass
          and att.attname <> 'law_firm_id'`,
    );
    const actual = new Set(
      rows.map((r: any) => `${r.tbl}.${r.col} ${ACTION[r.act as keyof typeof ACTION]}`),
    );
    const missing = [...EXPECTED].filter((e) => !actual.has(e)).sort();
    const extra = [...actual].filter((a) => !EXPECTED.has(a)).sort();
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('refuses a time entry naming a client that does not exist', async () => {
    const firm = await createFirm();
    await expect(testPool.query(
      `insert into activities (kind, id, law_firm_id, client_id, description, hours, activity_date)
       values ('time', $1, $2, $3, 'Ghost work', 1, '2026-03-01')`,
      [randomUUID(), firm.id, randomUUID()],
    )).rejects.toThrow(/violates foreign key constraint/);
  });

  it('refuses to delete a client with money against it, rather than destroying it', async () => {
    const firm = await createFirm();
    const client = await createPersonClient(firm.id, { name: 'Paying Client' });
    const entryId = randomUUID();
    await testPool.query(
      `insert into activities (kind, id, law_firm_id, client_id, description, hours, activity_date)
       values ('time', $1, $2, $3, 'Billable work', 2, '2026-03-01')`,
      [entryId, firm.id, client.id],
    );

    await expect(testPool.query('delete from clients where id = $1', [client.id]))
      .rejects.toThrow(/violates foreign key constraint/);

    const { rows } = await testPool.query(`select client_id from activities where kind = 'time' and id = $1`, [entryId]);
    expect(rows[0].client_id).toBe(client.id);
  });

  it('still cascades the junction rows a client owns outright', async () => {
    const firm = await createFirm();
    const client = await createPersonClient(firm.id, { name: 'Junction Client' });
    const taskId = randomUUID();
    await testPool.query(
      `insert into tasks (id, law_firm_id, title) values ($1, $2, 'Fixture task')`,
      [taskId, firm.id],
    );
    await testPool.query(
      `insert into task_clients (law_firm_id, task_id, client_id) values ($1, $2, $3)`,
      [firm.id, taskId, client.id],
    );

    await testPool.query('delete from clients where id = $1', [client.id]);

    const { rows } = await testPool.query('select 1 from task_clients where client_id = $1', [client.id]);
    expect(rows).toHaveLength(0);
  });
});
