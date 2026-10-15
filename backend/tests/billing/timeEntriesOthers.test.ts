/**
 * Whose time entries a member may touch.
 *
 * `billing.manageTimeEntries` is the right to keep time. It has never said whose
 * time: any holder who is on the matter could edit or delete a teammate's entry,
 * move it, or log hours in a teammate's name. `billing.manageOthersTimeEntries`
 * is the second half of that right. A holder of only the first acts on entries
 * whose timekeeper is themselves; acting on anyone else's needs the second too.
 *
 * WHAT BREAKS EACH TEST:
 *  - drop the ownership check in update/delete and the "refuses a teammate's
 *    entry" cases answer 200 and the row changes;
 *  - drop it from create and a member can log hours under a teammate's name;
 *  - drop it from bulk delete and one teammate row in a selection is deleted;
 *  - make bulk delete skip instead of refuse and the selection's own rows go
 *    while the request answers 200;
 *  - check the permission BEFORE the billed freeze and the billed cases answer
 *    for the wrong reason; check it INSTEAD of the freeze and a holder of both
 *    codes edits a billed entry.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  createInvoice,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { seedMatter } from '../support/matters';

const MANAGE = 'billing.manageTimeEntries';
const MANAGE_OTHERS = 'billing.manageOthersTimeEntries';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let matterId: string;
let ownOnly: Actor;
let teammate: Actor;

const base = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const matterUrl = (id: string) => `${base()}/matter/${matterId}/${id}`;

/** Log an entry as the owner (who holds every code) for the given timekeeper. */
async function logFor(userId: string | null, body: Record<string, unknown> = {}) {
  const res = await owner.api.post(base()).send({
    matterId,
    userId: userId ?? 'FIRM',
    hours: 1,
    date: '2026-03-10',
    description: 'Drafted the motion',
    hourlyRate: 200,
    ...body,
  });
  expect(res.status).toBe(201);
  return res.body.timeEntry.id as string;
}

const exists = async (id: string) => {
  const { rows } = await testPool.query(`select 1 from activities where id = $1`, [id]);
  return rows.length === 1;
};

const hoursOf = async (id: string) => {
  const { rows } = await testPool.query(`select hours from activities where id = $1`, [id]);
  return Number(rows[0].hours);
};

async function billOntoInvoice(entryId: string) {
  const invoice = await createInvoice(firm.id, client.id, { totalCents: 20_000 });
  await testPool.query(
    `insert into invoice_line_items
       (invoice_id, law_firm_id, kind, source_id, quantity, rate_cents, amount_cents)
     values ($1, $2, 'time_entry', $3, 1, 20000, 20000)`,
    [invoice.id, firm.id, entryId],
  );
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Others Client' });
  ownOnly = await memberWith(firm.id, [MANAGE]);
  teammate = await memberWith(firm.id, [MANAGE]);
  matterId = await seedMatter(firm.id, {
    memberUids: [owner.uid, ownOnly.uid, teammate.uid],
    clientIds: [client.id],
  });
  await drainEvents();
});

describe('a member holding only manageTimeEntries, on their own entries', () => {
  it('creates, edits and deletes an entry they are the timekeeper of', async () => {
    const created = await ownOnly.api.post(base()).send({
      matterId, userId: ownOnly.uid, hours: 2, date: '2026-03-10', hourlyRate: 100,
    });
    expect(created.status).toBe(201);
    const id = created.body.timeEntry.id as string;

    const edited = await ownOnly.api.put(matterUrl(id)).send({ description: 'Mine, revised' });
    expect(edited.status).toBe(200);

    const deleted = await ownOnly.api.delete(matterUrl(id));
    expect(deleted.status).toBe(200);
    expect(await exists(id)).toBe(false);
  });
});

describe('a member holding only manageTimeEntries, on a teammate\'s entries', () => {
  it('refuses to edit a teammate entry and leaves it as it was', async () => {
    const id = await logFor(teammate.uid, { hours: 1 });

    const res = await ownOnly.api.put(matterUrl(id)).send({ hours: 9 });

    expect(res.status).toBe(403);
    expect(res.body.details?.requiredPermission).toEqual([MANAGE_OTHERS]);
    expect(await hoursOf(id)).toBe(1);
  });

  it('refuses to delete a teammate entry and leaves it in place', async () => {
    const id = await logFor(teammate.uid);

    const res = await ownOnly.api.delete(matterUrl(id));

    expect(res.status).toBe(403);
    expect(await exists(id)).toBe(true);
  });

  it('refuses to edit or delete firm-level time, which has no timekeeper of their own', async () => {
    const id = await logFor(null);

    const edit = await ownOnly.api.put(matterUrl(id)).send({ description: 'Not mine' });
    const del = await ownOnly.api.delete(matterUrl(id));

    expect(edit.status).toBe(403);
    expect(del.status).toBe(403);
    expect(await exists(id)).toBe(true);
  });

  it('refuses to move a teammate entry onto a matter, and it stays on the client', async () => {
    const clientEntry = (await owner.api.post(base()).send({
      clientId: client.id, userId: teammate.uid, hours: 1, date: '2026-03-10', hourlyRate: 200,
    })).body.timeEntry.id as string;

    const res = await ownOnly.api
      .put(`${base()}/client/${client.id}/${clientEntry}`)
      .send({ matterId });

    expect(res.status).toBe(403);
    const { rows } = await testPool.query(`select matter_id, client_id from activities where id = $1`, [clientEntry]);
    expect(rows[0]).toMatchObject({ matter_id: null, client_id: client.id });
  });

  it('refuses to log an entry in a teammate\'s name and writes nothing', async () => {
    const res = await ownOnly.api.post(base()).send({
      matterId, userId: teammate.uid, hours: 1, date: '2026-03-10', hourlyRate: 100,
    });

    expect(res.status).toBe(403);
    const { rows } = await testPool.query(
      `select 1 from activities where law_firm_id = $1 and kind = 'time'`, [firm.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses to log firm-level time, which is not their own', async () => {
    const res = await ownOnly.api.post(base()).send({
      matterId, userId: 'FIRM', hours: 1, date: '2026-03-10', hourlyRate: 100,
    });

    expect(res.status).toBe(403);
    const { rows } = await testPool.query(
      `select 1 from activities where law_firm_id = $1 and kind = 'time'`, [firm.id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('bulk delete', () => {
  const bulk = () => `${base()}/bulk-delete`;

  it('deletes a selection made only of the caller\'s own entries', async () => {
    const a = await logFor(ownOnly.uid);
    const b = await logFor(ownOnly.uid);

    const res = await ownOnly.api.post(bulk()).send({ timeEntryIds: [a, b] });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
    expect(await exists(a)).toBe(false);
    expect(await exists(b)).toBe(false);
  });

  it('refuses the whole request when one entry belongs to a teammate, deleting none', async () => {
    const mine = await logFor(ownOnly.uid);
    const theirs = await logFor(teammate.uid);

    const res = await ownOnly.api.post(bulk()).send({ timeEntryIds: [mine, theirs] });

    expect(res.status).toBe(403);
    expect(await exists(mine)).toBe(true);
    expect(await exists(theirs)).toBe(true);
  });

  it('does not reveal a teammate entry on a matter the caller is not staffed on', async () => {
    const hidden = await seedMatter(firm.id, { memberUids: [owner.uid, teammate.uid], clientIds: [client.id] });
    const theirs = (await owner.api.post(base()).send({
      matterId: hidden, userId: teammate.uid, hours: 1, date: '2026-03-10', hourlyRate: 100,
    })).body.timeEntry.id as string;

    const res = await ownOnly.api.post(bulk()).send({ timeEntryIds: [theirs] });

    // The same per-entry answer the matter wall already gives, not the 403 that
    // would confirm the id is a real entry of someone else's.
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(0);
    expect(res.body.errors[theirs]).toBe('User is not a member of this matter');
    expect(await exists(theirs)).toBe(true);
  });

  it('lets a holder of manageOthersTimeEntries delete a mixed selection', async () => {
    const lead = await memberWith(firm.id, [MANAGE, MANAGE_OTHERS]);
    await testPool.query(
      `insert into matter_members (law_firm_id, matter_id, user_id, role) values ($1,$2,$3,'lead')`,
      [firm.id, matterId, lead.uid],
    );
    const mine = await logFor(lead.uid);
    const theirs = await logFor(teammate.uid);

    const res = await lead.api.post(bulk()).send({ timeEntryIds: [mine, theirs] });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
  });
});

describe('a member holding manageTimeEntries and manageOthersTimeEntries', () => {
  let lead: Actor;

  beforeEach(async () => {
    lead = await memberWith(firm.id, [MANAGE, MANAGE_OTHERS]);
    await testPool.query(
      `insert into matter_members (law_firm_id, matter_id, user_id, role) values ($1,$2,$3,'lead')`,
      [firm.id, matterId, lead.uid],
    );
  });

  it('edits and deletes a teammate entry', async () => {
    const id = await logFor(teammate.uid);

    const edit = await lead.api.put(matterUrl(id)).send({ hours: 3 });
    expect(edit.status).toBe(200);
    expect(await hoursOf(id)).toBe(3);

    const del = await lead.api.delete(matterUrl(id));
    expect(del.status).toBe(200);
    expect(await exists(id)).toBe(false);
  });

  it('logs an entry in a teammate\'s name', async () => {
    const res = await lead.api.post(base()).send({
      matterId, userId: teammate.uid, hours: 1, date: '2026-03-10', hourlyRate: 100,
    });

    expect(res.status).toBe(201);
  });

  it('still cannot edit or delete a billed teammate entry', async () => {
    // Client context: an invoice here is a client-level one, which is what the
    // freeze looks up for a client-context entry.
    const id = (await owner.api.post(base()).send({
      clientId: client.id, userId: teammate.uid, hours: 1, date: '2026-03-10', hourlyRate: 200,
    })).body.timeEntry.id as string;
    await billOntoInvoice(id);
    const url = `${base()}/client/${client.id}/${id}`;

    const edit = await lead.api.put(url).send({ hours: 5 });
    const del = await lead.api.delete(url);

    expect(edit.status).toBe(403);
    expect(JSON.stringify(edit.body)).toMatch(/billed on an invoice/);
    expect(del.status).toBe(403);
    expect(JSON.stringify(del.body)).toMatch(/billed on an invoice/);
    expect(await hoursOf(id)).toBe(1);
  });
});

describe('the firm owner', () => {
  it('edits, deletes and logs for a teammate without holding the code in a role', async () => {
    const id = await logFor(teammate.uid);

    expect((await owner.api.put(matterUrl(id)).send({ hours: 4 })).status).toBe(200);
    expect((await owner.api.delete(matterUrl(id))).status).toBe(200);
  });
});

describe('another firm', () => {
  it('cannot reach this firm\'s entries even holding both codes in its own', async () => {
    const id = await logFor(teammate.uid);
    const otherFirm = await createFirm();
    const stranger = await memberWith(otherFirm.id, [MANAGE, MANAGE_OTHERS]);

    const edit = await stranger.api.put(matterUrl(id)).send({ hours: 9 });
    const del = await stranger.api.delete(matterUrl(id));

    expect(edit.status).toBe(403);
    expect(del.status).toBe(403);
    expect(await hoursOf(id)).toBe(1);
  });
});
