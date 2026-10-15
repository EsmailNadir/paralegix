/**
 * Time entries, the raw material of every invoice.
 *
 * The module was at 22%. A time entry is the smallest unit of billable work in
 * the system: it becomes an invoice line, the invoice total, the client's bill,
 * and the firm's revenue. Nothing downstream can be right if the entry is wrong,
 * and none of the rules below had a test.
 *
 * The one that matters most is FROZEN ONCE BILLED. An invoice that has issued is
 * a document the client already has. Editing the hours behind it changes what
 * the firm's records say it charged, without changing the invoice, and the two
 * disagree from then on with nothing flagging it.
 *
 * The pure rounding arithmetic lives in `timeRounding.test.ts`; this file covers
 * what the ROUTES do.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createPersonClient,
  createOrgClient,
  createInvoice,
  ownerOf,
  memberWith,
  as,
  tokenFor,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { seedMatter } from '../support/matters';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const base = () => `/api/lawfirms/${firm.id}/billing/time-entries`;

/** Create a client-context entry and return its id. */
async function createEntry(body: Record<string, unknown> = {}) {
  const res = await owner.api.post(base()).send({
    clientId: client.id,
    userId: owner.uid,
    hours: 1.5,
    date: '2026-03-10',
    description: 'Drafted the motion',
    hourlyRate: 250,
    ...body,
  });
  return res;
}

const entryId = (res: any) => res.body.timeEntry.id as string;

/**
 * Put the entry onto an invoice as a LINE ITEM, which is what actually freezes it.
 *
 * `time_entries.billed` used to look like the flag for this and was not. The
 * service asks `billingReads.isSourceBilled`, which joins `invoice_line_items`
 * to `invoices`; the column was a denormalized flag nothing ever set, and
 * migration 0228 dropped it. A fixture that only set `billed = true` produced an
 * entry the service considered unbilled, so every freeze assertion below passed
 * against an entry that was never frozen. That is the exact failure mode this
 * suite exists to catch, and it caught itself.
 */
async function billOntoInvoice(entryId: string, hours = 1.5, rateCents = 25_000) {
  const invoice = await createInvoice(firm.id, client.id, { totalCents: 37_500 });
  await testPool.query(
    `insert into invoice_line_items
       (invoice_id, law_firm_id, kind, source_id, quantity, rate_cents, amount_cents)
     values ($1, $2, 'time_entry', $3, $4, $5, $6)`,
    [invoice.id, firm.id, entryId, hours, rateCents, Math.round(hours * rateCents)],
  );
  return invoice;
}

const rowFor = async (id: string) => {
  const { rows } = await testPool.query(
    `select hours, rate_cents, billable, activity_date as entry_date from activities where kind = 'time' and id = $1`,
    [id],
  );
  return rows[0];
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Time Client' });
  await drainEvents();
});

describe('an entry belongs to exactly one billing context', () => {
  it('accepts an entry against a client', async () => {
    const res = await createEntry();

    expect(res.status).toBe(201);
  });

  it('refuses an entry against BOTH a matter and a client', async () => {
    const res = await owner.api.post(base()).send({
      clientId: client.id,
      matterId: client.id,
      userId: owner.uid,
      hours: 1,
      date: '2026-03-10',
    });

    // Two contexts means two possible payers. The entry would land on whichever
    // invoice happened to be built first, and the other client would never be
    // billed for the work.
    expect(res.status).toBe(400);
  });

  it('refuses an entry against NEITHER', async () => {
    const res = await owner.api.post(base()).send({
      userId: owner.uid,
      hours: 1,
      date: '2026-03-10',
    });

    // Unattributed billable time is money the firm can never invoice, and it
    // does not appear as missing on any screen.
    expect(res.status).toBe(400);
  });
});

describe('what the entry stores', () => {
  it('stores the rate in integer CENTS', async () => {
    const res = await createEntry({ hourlyRate: 250 });

    const row = await rowFor(entryId(res));
    // $250.00 is 25000 cents. Storing 250 would bill the client two dollars
    // fifty an hour, and storing 250.00 as a float is the drift this schema
    // exists to prevent.
    expect(Number(row.rate_cents)).toBe(25_000);
  });

  it('stores hours as given when the firm has no rounding configured', async () => {
    const res = await createEntry({ hours: 1.75 });

    const row = await rowFor(entryId(res));
    expect(Number(row.hours)).toBe(1.75);
  });

  it('defaults an entry to BILLABLE', async () => {
    const res = await createEntry();

    const row = await rowFor(entryId(res));
    // The default has to be billable. A firm that forgets the flag under-bills;
    // the reverse is caught the moment a client queries the invoice.
    expect(row.billable).toBe(true);
  });

  it('honours an explicitly non-billable entry', async () => {
    const res = await createEntry({ billable: false });

    const row = await rowFor(entryId(res));
    // Written-off or courtesy work. Recorded, but never charged.
    expect(row.billable).toBe(false);
  });

  it('refuses negative hours', async () => {
    const res = await createEntry({ hours: -1 });

    // Negative time would subtract from an invoice total, which is a credit the
    // firm never approved.
    expect(res.status).toBe(400);
  });

  it('refuses a negative rate', async () => {
    const res = await createEntry({ hourlyRate: -50 });

    expect(res.status).toBe(400);
  });

  it('refuses a malformed date', async () => {
    const res = await createEntry({ date: 'the tenth of March' });

    // The entry date decides which billing period the work falls in.
    expect(res.status).toBe(400);
  });
});

describe('FROZEN ONCE BILLED', () => {
  let id: string;

  beforeEach(async () => {
    const res = await createEntry({ hours: 1.5, hourlyRate: 250 });
    id = entryId(res);
    await billOntoInvoice(id);
  });

  // Each refusal is asserted on the DATA as well as the status: a route that
  // refused with a 403 after already writing would pass a status check alone.
  it.each([
    // The invoice already states 1.5 hours. Changing the entry to 9 leaves the
    // firm's own records claiming a different figure from the document the
    // client is holding, and nothing reconciles the two.
    ['the hours', { hours: 9 }, (row: any) => expect(Number(row.hours)).toBe(1.5)],
    ['the rate', { hourlyRate: 900 }, (row: any) => expect(Number(row.rate_cents)).toBe(25_000)],
    // Moving a billed entry into another period would take revenue off one
    // month's books and add it to another, after both were reported.
    ['the date', { date: '2026-01-01' }, (row: any) => expect(row.entry_date).toBe('2026-03-10')],
    // The work was already charged. Marking it non-billable now writes off
    // money the client has already been asked to pay.
    ['it to non-billable', { billable: false }, (row: any) => expect(row.billable).toBe(true)],
  ])('refuses to change %s, and leaves the row untouched', async (_label, change, unchanged) => {
    const res = await owner.api.put(`${base()}/client/${client.id}/${id}`).send(change);

    expect(res.status).toBe(403);
    unchanged(await rowFor(id));
  });

  it('refuses to DELETE it', async () => {
    const res = await owner.api.delete(`${base()}/client/${client.id}/${id}`);

    // Deleting the entry behind an issued invoice line leaves the line with
    // nothing supporting it, which is the record a firm needs if the bill is
    // ever questioned.
    expect(res.status).toBe(403);

    const { rows } = await testPool.query(`select id from activities where kind = 'time' and id = $1`, [id]);
    expect(rows).toHaveLength(1);
  });

  it('still allows editing the DESCRIPTION', async () => {
    const res = await owner.api.put(`${base()}/client/${client.id}/${id}`)
      .send({ description: 'Corrected the typo in the narrative' });

    // The freeze covers what was CHARGED, not how it was worded. A blanket
    // refusal would leave a firm unable to fix a client-visible typo, and this
    // is what proves the guard is a field list rather than a whole-row lock.
    expect(res.status).toBe(200);
  });
});

describe('an UNBILLED entry is still editable', () => {
  it('accepts an hours change', async () => {
    const res = await createEntry({ hours: 1.5 });
    const id = entryId(res);

    const updated = await owner.api.put(`${base()}/client/${client.id}/${id}`).send({ hours: 2 });

    // The positive half of the freeze. Without it, a route that refused EVERY
    // edit would satisfy all the cases above while making ordinary corrections
    // impossible.
    expect(updated.status).toBe(200);
    expect(Number((await rowFor(id)).hours)).toBe(2);
  });

  it('accepts a delete', async () => {
    const res = await createEntry();
    const id = entryId(res);

    const deleted = await owner.api.delete(`${base()}/client/${client.id}/${id}`);

    expect(deleted.status).toBe(200);
    const { rows } = await testPool.query(`select id from activities where kind = 'time' and id = $1`, [id]);
    expect(rows).toHaveLength(0);
  });
});

describe('tenancy', () => {
  it('does not list another firm time entries', async () => {
    await createEntry({ description: 'Confidential narrative' });
    await drainEvents();
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    // The positive control: the owning firm's list carries the narrative, so
    // its absence below is about the caller, not an entry that never landed.
    const own = await owner.api.get(`/api/lawfirms/${firm.id}/billing/time-entries/firm`);
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).toContain('Confidential narrative');

    const res = await otherOwner.api
      .get(`/api/lawfirms/${otherFirm.id}/billing/time-entries/firm`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('Confidential narrative');
  });

  it('does not let one firm create an entry against another firm client', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/billing/time-entries`)
      .send({ clientId: client.id, userId: otherOwner.uid, hours: 1, date: '2026-03-10' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const { rows } = await testPool.query(
      `select id from activities where kind = 'time' and client_id = $1 and law_firm_id = $2`,
      [client.id, otherFirm.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('does not let one firm edit another firm entry', async () => {
    const res = await createEntry();
    const id = entryId(res);
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const edit = await otherOwner.api
      .put(`/api/lawfirms/${otherFirm.id}/billing/time-entries/client/${client.id}/${id}`)
      .send({ hours: 99 });

    expect(edit.status).toBeGreaterThanOrEqual(400);
    expect(Number((await rowFor(id)).hours)).toBe(1.5);
  });
});

describe('permissions', () => {
  it('refuses a member without billing.manageTimeEntries', async () => {
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi.post(base()).send({
      clientId: client.id, userId: narrow.uid, hours: 1, date: '2026-03-10',
    });

    // Recording billable time is recording money owed. The always-on baseline
    // grants `.view` codes only, so a narrow role must not reach this.
    expect(res.status).toBe(403);
  });

  it('refuses a stranger to the firm entirely', async () => {
    const outsider = await createFirmMember((await createFirm()).id, { isOwner: true });
    const outsiderApi = as(tokenFor({ uid: outsider.uid }));

    const res = await outsiderApi.post(base()).send({
      clientId: client.id, userId: outsider.uid, hours: 1, date: '2026-03-10',
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('organizations', () => {
  it('records time against an organization client', async () => {
    const org = await createOrgClient(firm.id, { name: 'Acme Corporation' });
    await drainEvents();

    const res = await owner.api.post(base()).send({
      clientId: org.id,
      userId: owner.uid,
      hours: 2,
      date: '2026-03-10',
      hourlyRate: 300,
    });

    // An organization is a billable client like any other. A time-entry path
    // that resolved the client through `clients.user_id`, which an organization
    // can never carry, refuses here and the firm cannot bill its corporate work
    // at all.
    expect(res.status).toBe(201);
    const row = await rowFor(entryId(res));
    expect(Number(row.rate_cents)).toBe(30_000);
  });
});

describe('the context list and what is still to invoice', () => {
  it('flags the billed entry, and drops it when only unbilled work is asked for', async () => {
    const billed = entryId(await createEntry({ hours: 1.5, description: 'Billed work' }));
    const open = entryId(await createEntry({ hours: 0.7, description: 'Open work' }));
    await billOntoInvoice(billed);

    const all = await owner.api.get(`${base()}/client/${client.id}`);
    const unbilled = await owner.api.get(`${base()}/client/${client.id}?unbilledOnly=true`);

    expect(all.status).toBe(200);
    expect(all.body.timeEntries.map((e: any) => [e.id, e.isBilled]).sort())
      .toEqual([[billed, true], [open, false]].sort());
    // This list feeds "create invoice from unbilled time". A billed entry in it
    // is the same work charged twice.
    expect(unbilled.status).toBe(200);
    expect(unbilled.body.timeEntries.map((e: any) => [e.id, e.hours, e.isBilled])).toEqual([[open, 0.7, false]]);
  });

  it('narrows a matter list to one member, and refuses a user who is not on the matter', async () => {
    const colleague = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const outsider = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const matterId = await seedMatter(firm.id, { memberUids: [owner.uid, colleague.uid], clientIds: [client.id] });
    const log = (userId: string, hours: number) => owner.api.post(base()).send({
      matterId, userId, hours, date: '2026-03-10', hourlyRate: 200,
    });
    expect((await log(owner.uid, 1)).status).toBe(201);
    expect((await log(colleague.uid, 2.25)).status).toBe(201);

    const mine = await owner.api.get(`${base()}/matter/${matterId}?userId=${colleague.uid}`);
    const offMatter = await owner.api.get(`${base()}/matter/${matterId}?userId=${outsider.uid}`);

    expect(mine.status).toBe(200);
    expect(mine.body.timeEntries.map((e: any) => [e.userId, e.hours])).toEqual([[colleague.uid, 2.25]]);
    expect(offMatter.status).toBe(400);
    expect(JSON.stringify(offMatter.body)).toContain('User is not a member of this matter');
  });
});

describe('who the time is for, on a matter', () => {
  let matterId: string;
  let coClient: ClientRecord;
  beforeEach(async () => {
    coClient = await createPersonClient(firm.id, { name: 'Co Client' });
    matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id, coClient.id] });
  });

  it('refuses to log time for a firm member who is not on the matter, and writes nothing', async () => {
    // The timekeeper decides the rate. Time logged under someone off the matter
    // is billed at their rate for work the matter's own team did not record.
    const offMatter = await createFirmMember(firm.id, { isOwner: false, permissions: [] });

    const res = await owner.api.post(base()).send({
      matterId, userId: offMatter.uid, hours: 1, date: '2026-03-10', hourlyRate: 200,
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('User is not a member of this matter');
    const { rows } = await testPool.query(
      `select count(*)::int n from activities where kind = 'time' and matter_id = $1`, [matterId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('refuses a payer who is not a client on the matter, and writes nothing', async () => {
    // The payer named here is who the line is invoiced to. A client from
    // another matter would be billed for work done for someone else.
    const stranger = await createPersonClient(firm.id, { name: 'Unrelated Client' });

    const res = await owner.api.post(base()).send({
      matterId, userId: owner.uid, hours: 1, date: '2026-03-10', hourlyRate: 200,
      matterClientIds: [coClient.id, stranger.id],
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('not linked to this matter');
    const { rows } = await testPool.query(
      `select count(*)::int n from activities where kind = 'time' and matter_id = $1`, [matterId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('re-points the payer on an unbilled entry, de-duplicating the list', async () => {
    const created = await owner.api.post(base()).send({
      matterId, userId: owner.uid, hours: 1, date: '2026-03-10', hourlyRate: 200,
      matterClientIds: [client.id],
    });
    expect(created.status).toBe(201);

    const res = await owner.api.put(`${base()}/matter/${matterId}/${entryId(created)}`)
      .send({ matterClientIds: [coClient.id, coClient.id] });

    expect(res.status).toBe(200);
    const { rows } = await testPool.query(
      'select matter_client_ids from activities where id = $1', [entryId(created)],
    );
    expect(rows[0].matter_client_ids).toEqual([coClient.id]);
  });
});

/**
 * Work logged against a client before a matter exists is moved onto the matter
 * once one is opened. The two rules: only client-level time moves, and only
 * onto a matter that already lists that client. Filing one client's hours
 * under another client's matter bills the wrong client and discloses the work.
 */
describe('moving client time onto a matter', () => {
  const moveRow = async (id: string) => {
    const { rows } = await testPool.query(
      'select matter_id, client_id, matter_client_ids, hours, rate_cents from activities where id = $1', [id],
    );
    return rows[0];
  };

  it('moves it onto a matter that lists the client, keeping the client as the payer and the money as it was', async () => {
    const matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
    const id = entryId(await createEntry({ hours: 1.5, hourlyRate: 250 }));

    const res = await owner.api.put(`${base()}/client/${client.id}/${id}`).send({ matterId });

    expect(res.status).toBe(200);
    expect(await moveRow(id)).toEqual({
      matter_id: matterId, client_id: null, matter_client_ids: [client.id], hours: '1.50', rate_cents: '25000',
    });
  });

  it('refuses a matter that does not list this client, and leaves the entry where it was', async () => {
    const other = await createPersonClient(firm.id, { name: 'Someone Else' });
    const theirMatter = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [other.id] });
    const id = entryId(await createEntry());

    const res = await owner.api.put(`${base()}/client/${client.id}/${id}`).send({ matterId: theirMatter });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('does not belong to this client');
    expect(await moveRow(id)).toMatchObject({ matter_id: null, client_id: client.id });
  });

  it('answers not-found for another firm\'s matter, and leaves the entry where it was', async () => {
    const rival = await createFirm();
    const rivalMatter = await seedMatter(rival.id, { clientIds: [] });
    const id = entryId(await createEntry());

    const res = await owner.api.put(`${base()}/client/${client.id}/${id}`).send({ matterId: rivalMatter });

    expect(res.status).toBe(404);
    expect(await moveRow(id)).toMatchObject({ matter_id: null, client_id: client.id });
  });

  it('refuses to move time that is already on a matter', async () => {
    const matterA = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
    const matterB = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
    const created = await owner.api.post(base()).send({
      matterId: matterA, userId: owner.uid, hours: 1, date: '2026-03-10', hourlyRate: 200,
    });
    expect(created.status).toBe(201);

    const res = await owner.api.put(`${base()}/matter/${matterA}/${entryId(created)}`).send({ matterId: matterB });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Only time logged against a client can be moved');
    expect((await moveRow(entryId(created))).matter_id).toBe(matterA);
  });

  it('refuses to move billed time, which would restate an issued invoice', async () => {
    const matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
    const id = entryId(await createEntry());
    await billOntoInvoice(id);

    const res = await owner.api.put(`${base()}/client/${client.id}/${id}`).send({ matterId });

    expect(res.status).toBe(403);
    expect(await moveRow(id)).toMatchObject({ matter_id: null, client_id: client.id });
  });

  /**
   * Moving time onto a matter writes to that matter, so it needs the same
   * standing as logging time there directly. Red if only the client context
   * is authorized: the non-member's move answers 200 and the entry moves.
   */
  it('refuses a member who is not on the destination matter, and leaves the entry where it was', async () => {
    const matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
    const id = entryId(await createEntry());
    const outsider = await memberWith(firm.id, ['billing.manageTimeEntries', 'billing.manageOthersTimeEntries']);

    const res = await outsider.api.put(`${base()}/client/${client.id}/${id}`).send({ matterId });

    expect(res.status).toBe(403);
    expect(await moveRow(id)).toMatchObject({ matter_id: null, client_id: client.id });
  });

  /** The same member succeeds once on the matter. Red if the check refuses members. */
  it('lets a member of the destination matter move it', async () => {
    const insider = await memberWith(firm.id, ['billing.manageTimeEntries', 'billing.manageOthersTimeEntries']);
    const matterId = await seedMatter(firm.id, { memberUids: [owner.uid, insider.uid], clientIds: [client.id] });
    const id = entryId(await createEntry());

    const res = await insider.api.put(`${base()}/client/${client.id}/${id}`).send({ matterId });

    expect(res.status).toBe(200);
    expect(await moveRow(id)).toMatchObject({ matter_id: matterId, client_id: null });
  });

  /**
   * Logging time on a matter directly requires the timekeeper to be on it, so a
   * move must not park a teammate's hours on a matter they are not staffed on.
   * Red if only the acting user is checked: the move answers 200 and the entry
   * lands on a matter its own timekeeper cannot see.
   */
  describe('whose entry it is', () => {
    const entryFor = async (timekeeper: Actor) => entryId(await createEntry({ userId: timekeeper.uid }));

    it('refuses another member\'s entry when that member is not on the destination matter, and leaves it where it was', async () => {
      const teammate = await memberWith(firm.id, ['billing.manageTimeEntries']);
      const matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
      const id = await entryFor(teammate);

      const res = await owner.api.put(`${base()}/client/${client.id}/${id}`).send({ matterId });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('User is not a member of this matter');
      expect(await moveRow(id)).toMatchObject({ matter_id: null, client_id: client.id });
    });

    it('moves another member\'s entry once that member is on the destination matter', async () => {
      const teammate = await memberWith(firm.id, ['billing.manageTimeEntries']);
      const matterId = await seedMatter(firm.id, { memberUids: [owner.uid, teammate.uid], clientIds: [client.id] });
      const id = await entryFor(teammate);

      const res = await owner.api.put(`${base()}/client/${client.id}/${id}`).send({ matterId });

      expect(res.status).toBe(200);
      expect(await moveRow(id)).toMatchObject({ matter_id: matterId, client_id: null });
    });

    it('moves the acting member\'s own entry', async () => {
      const matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
      const id = await entryFor(owner);

      const res = await owner.api.put(`${base()}/client/${client.id}/${id}`).send({ matterId });

      expect(res.status).toBe(200);
      expect(await moveRow(id)).toMatchObject({ matter_id: matterId, client_id: null });
    });

    it('moves a firm-level entry, which direct creation on a matter also allows without a user', async () => {
      const matterId = await seedMatter(firm.id, { memberUids: [owner.uid], clientIds: [client.id] });
      const id = entryId(await createEntry({ userId: 'FIRM' }));

      const res = await owner.api.put(`${base()}/client/${client.id}/${id}`).send({ matterId });

      expect(res.status).toBe(200);
      expect(await moveRow(id)).toMatchObject({ matter_id: matterId, client_id: null });
    });
  });
});

describe('an entry that is not there', () => {
  it('answers not-found to an edit or delete of an id in no context, and writes nothing', async () => {
    const id = entryId(await createEntry({ hours: 1.5 }));
    const otherClient = await createPersonClient(firm.id, { name: 'Other Client' });

    // The right id under the wrong client: the context, not the id alone,
    // decides which entry may be touched.
    const edit = await owner.api.put(`${base()}/client/${otherClient.id}/${id}`).send({ hours: 9 });
    const del = await owner.api.delete(`${base()}/client/${otherClient.id}/${id}`);

    expect(edit.status).toBe(404);
    expect(del.status).toBe(404);
    expect(Number((await rowFor(id)).hours)).toBe(1.5);
  });
});
