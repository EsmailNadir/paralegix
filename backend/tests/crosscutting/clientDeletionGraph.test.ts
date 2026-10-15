/**
 * Deleting a client through the route: what goes with it, what must stay, and
 * what stops the delete.
 *
 * A client owns notes, events, matter links, task links, roster links and
 * contact links. It does NOT own the matters, tasks, directory contacts or
 * other clients those rows point at, and it must never reach into another
 * client or another firm. Money against it (time, invoices) stops the delete
 * rather than being destroyed with it.
 *
 * What has to break for each case to go red:
 *   - the child rows: drop a delete from `deleteClientCascade`, or flip an FK
 *     away from cascade (the row then survives, or the delete fails with a 500).
 *   - the survivors: widen a delete beyond `client_id = $client`, so a sibling,
 *     a matter, a task or a directory contact is lost.
 *   - the second firm: lose the `law_firm_id` scope on any of those deletes.
 *   - the refusals: flip `activities.client_id` or `invoices.client_context_id`
 *     to cascade (money lost) or drop the service's pre-checks (raw 500).
 */
import { randomUUID } from 'crypto';
import { installInMemoryBucket } from '../support/inMemoryBucket';
import { firmFingerprint } from '../support/idSweep';
import {
  testPool,
  createFirm,
  createInvoice,
  createOrgClient,
  createPersonClient,
  linkPersonToOrg,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

installInMemoryBucket();

const FIRM_TABLES = [
  'clients', 'matters', 'tasks', 'contacts', 'matter_clients', 'task_clients', 'notes', 'note_replies',
  'events', 'event_assignees', 'event_contacts', 'contact_clients', 'client_company_links',
] as const;

interface Graph {
  clientId: string;
  matterId: string;
  taskId: string;
  contactId: string;
  noteId: string;
  eventId: string;
  orgId: string;
}

/** One client with a row in every table that hangs off a client. */
async function seedGraph(firm: Firm, owner: Actor, name: string): Promise<Graph> {
  const lawFirmId = firm.id;
  const clientId = (await createPersonClient(lawFirmId, { name })).id;
  const orgId = (await createOrgClient(lawFirmId, { name: `${name} Org` })).id;
  await linkPersonToOrg(lawFirmId, clientId, orgId, { canViewBilling: false });

  const matterId = randomUUID();
  await testPool.query(
    'insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, $3, $4)',
    [matterId, lawFirmId, `${name} matter`, `REF-${matterId.slice(0, 8)}`],
  );
  await testPool.query(
    'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
    [lawFirmId, matterId, owner.uid],
  );
  await testPool.query(
    'insert into matter_clients (law_firm_id, matter_id, client_id) values ($1, $2, $3)',
    [lawFirmId, matterId, clientId],
  );

  const taskId = randomUUID();
  await testPool.query('insert into tasks (id, law_firm_id, title) values ($1, $2, $3)', [taskId, lawFirmId, `${name} task`]);
  await testPool.query(
    'insert into task_clients (law_firm_id, task_id, client_id) values ($1, $2, $3)',
    [lawFirmId, taskId, clientId],
  );

  const contactId = randomUUID();
  await testPool.query(
    `insert into contacts (id, law_firm_id, name) values ($1, $2, $3)`,
    [contactId, lawFirmId, `${name} contact`],
  );
  await testPool.query(
    'insert into contact_clients (law_firm_id, contact_id, client_id) values ($1, $2, $3)',
    [lawFirmId, contactId, clientId],
  );

  const noteId = randomUUID();
  await testPool.query(
    `insert into notes (id, law_firm_id, client_id, content, created_by) values ($1, $2, $3, $4, $5)`,
    [noteId, lawFirmId, clientId, `${name} note`, owner.uid],
  );
  await testPool.query(
    `insert into note_replies (law_firm_id, note_id, content, created_by) values ($1, $2, $3, $4)`,
    [lawFirmId, noteId, `${name} reply`, owner.uid],
  );

  const eventId = randomUUID();
  await testPool.query(
    `insert into events (id, law_firm_id, client_id, type, title, date, created_by)
     values ($1, $2, $3, 'meeting', $4, now(), $5)`,
    [eventId, lawFirmId, clientId, `${name} event`, owner.uid],
  );
  await testPool.query(
    'insert into event_assignees (law_firm_id, event_id, user_id) values ($1, $2, $3)',
    [lawFirmId, eventId, owner.uid],
  );
  await testPool.query(
    'insert into event_contacts (law_firm_id, event_id, contact_id) values ($1, $2, $3)',
    [lawFirmId, eventId, contactId],
  );

  return { clientId, matterId, taskId, contactId, noteId, eventId, orgId };
}

const count = async (sql: string, params: unknown[]) =>
  (await testPool.query(`select count(*)::int n from (${sql}) q`, params)).rows[0].n as number;

/** Rows hanging off the client, by the column that names it. */
async function ownedRows(g: Graph) {
  const byClient = (table: string) => count(`select 1 from ${table} where client_id = $1`, [g.clientId]);
  return {
    clients: await count('select 1 from clients where id = $1', [g.clientId]),
    notes: await byClient('notes'),
    noteReplies: await count('select 1 from note_replies where note_id = $1', [g.noteId]),
    events: await byClient('events'),
    eventAssignees: await count('select 1 from event_assignees where event_id = $1', [g.eventId]),
    eventContacts: await count('select 1 from event_contacts where event_id = $1', [g.eventId]),
    matterClients: await byClient('matter_clients'),
    taskClients: await byClient('task_clients'),
    contactClients: await byClient('contact_clients'),
    rosterLinks: await count(
      'select 1 from client_company_links where person_client_id = $1 or company_client_id = $1', [g.clientId],
    ),
  };
}

let firm: Firm;
let owner: Actor;
const del = (clientId: string, actor: Actor = owner, lawFirmId = firm.id) =>
  actor.api.delete(`/api/lawfirms/${lawFirmId}/clients/${clientId}`);

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

describe('deleting a client through the route', () => {
  it('removes the client and everything it owns, and nothing it merely points at', async () => {
    const target = await seedGraph(firm, owner, 'Target');
    const sibling = await seedGraph(firm, owner, 'Sibling');
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    await seedGraph(otherFirm, otherOwner, 'Elsewhere');
    const otherBefore = await firmFingerprint(FIRM_TABLES, otherFirm.id);
    const siblingBefore = await ownedRows(sibling);
    expect(await ownedRows(target)).toEqual({
      clients: 1, notes: 1, noteReplies: 1, events: 1, eventAssignees: 1, eventContacts: 1,
      matterClients: 1, taskClients: 1, contactClients: 1, rosterLinks: 1,
    });

    const res = await del(target.clientId);

    expect(res.status).toBe(200);
    expect(await ownedRows(target)).toEqual({
      clients: 0, notes: 0, noteReplies: 0, events: 0, eventAssignees: 0, eventContacts: 0,
      matterClients: 0, taskClients: 0, contactClients: 0, rosterLinks: 0,
    });
    // What the client only pointed at stays: the matter, the task, the
    // directory contact and the organization it was on the roster of.
    expect(await count('select 1 from matters where id = $1', [target.matterId])).toBe(1);
    expect(await count('select 1 from tasks where id = $1', [target.taskId])).toBe(1);
    expect(await count('select 1 from contacts where id = $1', [target.contactId])).toBe(1);
    expect(await count('select 1 from clients where id = $1', [target.orgId])).toBe(1);
    // The sibling client and the second firm are exactly as they were.
    expect(await ownedRows(sibling)).toEqual(siblingBefore);
    expect(await firmFingerprint(FIRM_TABLES, otherFirm.id)).toEqual(otherBefore);
  });

  it('answers 404 to a repeated delete and changes nothing the second time', async () => {
    const target = await seedGraph(firm, owner, 'Target');
    const sibling = await seedGraph(firm, owner, 'Sibling');
    expect((await del(target.clientId)).status).toBe(200);
    const before = await firmFingerprint(FIRM_TABLES, firm.id);

    const again = await del(target.clientId);

    expect(again.status).toBe(404);
    expect(await firmFingerprint(FIRM_TABLES, firm.id)).toEqual(before);
    expect((await ownedRows(sibling)).clients).toBe(1);
  });

  it('cannot be aimed at another firm: that firm\'s client is untouched', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const victim = await seedGraph(otherFirm, otherOwner, 'Victim');
    const before = await firmFingerprint(FIRM_TABLES, otherFirm.id);

    const res = await del(victim.clientId);

    expect(res.status).toBe(404);
    expect(await firmFingerprint(FIRM_TABLES, otherFirm.id)).toEqual(before);
  });

  describe('money against the client stops the delete', () => {
    it('refuses a client with a time entry, keeping the client, the entry and the rest of its graph', async () => {
      const target = await seedGraph(firm, owner, 'Target');
      const entryId = randomUUID();
      await testPool.query(
        `insert into activities (kind, id, law_firm_id, client_id, description, hours, activity_date)
         values ('time', $1, $2, $3, 'Billable work', 2, '2026-03-01')`,
        [entryId, firm.id, target.clientId],
      );
      const before = await firmFingerprint(FIRM_TABLES, firm.id);

      const res = await del(target.clientId);

      expect(res.status).toBe(409);
      expect(await count(`select 1 from activities where id = $1 and client_id = $2`, [entryId, target.clientId])).toBe(1);
      expect(await firmFingerprint(FIRM_TABLES, firm.id)).toEqual(before);
    });

    it('refuses a client with an invoice, keeping the invoice', async () => {
      const target = await seedGraph(firm, owner, 'Target');
      const invoice = await createInvoice(firm.id, target.clientId);
      const before = await firmFingerprint(FIRM_TABLES, firm.id);

      const res = await del(target.clientId);

      expect(res.status).toBe(409);
      expect(await count('select 1 from invoices where id = $1 and client_id = $2', [invoice.id, target.clientId])).toBe(1);
      expect(await firmFingerprint(FIRM_TABLES, firm.id)).toEqual(before);
    });
  });
});
