/**
 * Splitting one matter's bill across several clients, and correcting a payment.
 *
 * `invoices.service.ts` is 3,590 lines at 26%. These are the two largest
 * untested pieces of it, and both move money:
 *
 * SPLITTING divides one matter's unbilled work between the clients on that
 * matter. It is the path an organization and its people most often meet, since a
 * matter run for a company is frequently paid partly by the company and partly
 * by someone on its roster. The service cross-checks every figure the caller
 * sends against the work it is billing, in integer cents, because a split that
 * does not reconcile either invents money or loses it, and every invoice
 * involved still looks correct on its own.
 *
 * PAYMENT CORRECTION is how a firm undoes a mis-keyed receipt. Deleting or
 * editing a payment has to move the balance back, or the client is chased for
 * money they paid, or credited money they never sent.
 *
 * `invoiceLifecycle.test.ts` covers creating an invoice and recording a payment;
 * `invoiceAdjustments.test.ts` covers credit notes, write-offs and late fees.
 * This file starts where those stop.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createPersonClient,
  createOrgClient,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { gateMethod, type Gate } from '../support/gate';

const invoicesRepo = require('../../src/modules/billing/invoices/invoices.repository');

let gate: Gate | null = null;

afterEach(() => {
  // Unconditional: a failed assertion between installing the gate and opening
  // it must not leave a later spec's gate confused by a stale paused call.
  gate?.restore();
  gate = null;
});

let firm: Firm;
let owner: Actor;
/** The person who pays half. */
let person: ClientRecord;
/** The organization that pays the other half. */
let org: ClientRecord;
let matterId: string;
/** A four-hour entry at $100, so the matter carries exactly $400 to divide. */
let timeEntryId: string;

const B = () => `/api/lawfirms/${firm.id}/billing`;

/**
 * One split invoice for one client.
 *
 * Every figure has to agree with every other: the invoice total against the sum
 * of its lines, and the invoice hours against the sum of its line hours. Passing
 * a total without matching lines is refused, which is what the cases below
 * exercise.
 */
function share(clientId: string, invoiceName: string, amount: number, hours: number) {
  return {
    matterClientId: clientId,
    invoiceName,
    totalAmount: amount,
    totalHours: hours,
    allocationPercent: (amount / 400) * 100,
    timeEntries: [{
      id: timeEntryId,
      amount,
      hours,
      allocationPercent: (amount / 400) * 100,
    }],
  };
}

function splitRequest(invoices: unknown[]) {
  return owner.api.post(`${B()}/invoices/matter/${matterId}/split`).send({
    invoiceDate: '2026-03-15',
    splitMode: 'equal',
    sourceSelection: { timeEntries: [timeEntryId], flatFees: [] },
    invoices,
  });
}

/** An even fifty-fifty split, the ordinary case. */
const evenSplit = () => splitRequest([
  share(person.id, 'Split A', 200, 2),
  share(org.id, 'Split B', 200, 2),
]);

const invoiceRows = async () => {
  const { rows } = await testPool.query(
    `select invoice_name, total_cents, split_group_id, matter_client_id, split_share_cents
       from invoices where law_firm_id = $1 order by invoice_name`, [firm.id],
  );
  return rows;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  person = await createPersonClient(firm.id, { name: 'Pat Person' });
  org = await createOrgClient(firm.id, { name: 'Acme Corporation' });

  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Shared Matter',
    clients: [
      { clientId: person.id, name: 'Pat Person' },
      { clientId: org.id, name: 'Acme Corporation' },
    ],
  });
  // Asserted before reading, and read from ONE field rather than through a
  // `??` chain. A fallback chain keeps passing when the field it wanted is
  // renamed, so it hides exactly the change it looks like it is guarding.
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;
  expect(matterId).toBeTruthy();

  const entry = await owner.api.post(`${B()}/time-entries`).send({
    matterId,
    userId: owner.uid,
    hours: 4,
    date: '2026-03-10',
    hourlyRate: 100,
    description: 'Shared work',
  });
  expect(entry.status).toBe(201);
  timeEntryId = entry.body.timeEntry.id;
  await drainEvents();
});

describe('splitting a matter bill', () => {
  it.each([
    ['split', 'split'], ['normal', 'split'], ['normal', 'edit'], ['split', 'edit'],
  ])('only one %s versus %s operation claims the source work', async (left, right) => {
    let editInvoiceId: string | undefined;
    if (right === 'edit') {
      const empty = await owner.api.post(`${B()}/invoices`).send({
        matterId, invoiceName: 'Editable', invoiceDate: '2026-03-15', totalAmount: 0,
      });
      expect(empty.status).toBe(201);
      editInvoiceId = empty.body.invoice.id;
    }
    const fire = async (kind: string, label: string) => {
      if (kind === 'split') return splitRequest([
        share(person.id, `${label} person`, 200, 2), share(org.id, `${label} org`, 200, 2),
      ]);
      const timeEntries = [{ id: timeEntryId, hours: 4, rate: 100, amount: 400 }];
      if (kind === 'edit') return owner.api.patch(`${B()}/invoices/matter/${matterId}/${editInvoiceId}/line-items`)
        .send({ timeEntries, flatFees: [], expenses: [] });
      return owner.api.post(`${B()}/invoices`).send({
        matterId, invoiceName: label, invoiceDate: '2026-03-15', timeEntries, totalAmount: 400,
      });
    };
    gate = gateMethod(invoicesRepo, 'lockBillingContext');
    const first = fire(left, 'First');
    const second = fire(right, 'Second');
    await gate.arrived(2);
    expect(gate.waiting()).toBe(2);
    gate.open();
    const responses = await Promise.all([first, second]);
    await drainEvents();
    expect(responses.filter((res) => res.status < 300)).toHaveLength(1);
    expect(responses.find((res) => res.status === 400)?.body.error).toMatch(/already billed/i);
    const { rows } = await testPool.query(
      'select sum(amount_cents)::text as cents from invoice_line_items where law_firm_id = $1 and source_id = $2',
      [firm.id, timeEntryId],
    );
    expect(rows[0].cents).toBe('40000');
  });

  it('creates one invoice per client', async () => {
    const res = await evenSplit();

    expect(res.status).toBe(201);
    expect(res.body.createdCount).toBe(2);
    expect(await invoiceRows()).toHaveLength(2);
  });

  it('links them under one split group', async () => {
    await evenSplit();

    const rows = await invoiceRows();
    // The group id is what lets any one invoice say "this is a share of a larger
    // bill". Without it each looks like a standalone invoice, and nobody can
    // tell that two clients were billed for the same work on purpose.
    expect(rows[0].split_group_id).not.toBeNull();
    expect(rows[0].split_group_id).toBe(rows[1].split_group_id);
  });

  it('bills each client their own share, in cents', async () => {
    await evenSplit();

    const rows = await invoiceRows();
    expect(Number(rows[0].total_cents)).toBe(20_000);
    expect(Number(rows[1].total_cents)).toBe(20_000);
  });

  it('divides the source work EXACTLY, creating and losing nothing', async () => {
    await evenSplit();

    const rows = await invoiceRows();
    const billed = rows.reduce((sum: number, r: any) => sum + Number(r.total_cents), 0);
    // The property that matters. Four hours at a hundred dollars is forty
    // thousand cents, and the shares must come to exactly that. A rounding slip
    // here either bills the clients for money the firm never earned or silently
    // drops revenue, and each invoice still looks right on its own.
    expect(billed).toBe(40_000);
  });

  it('records each client share against the client it belongs to', async () => {
    await evenSplit();

    const rows = await invoiceRows();
    const recipients = rows.map((r: any) => r.matter_client_id);
    // Both clients, each exactly once. Billing one client twice is the failure
    // this catches, and the totals still reconcile when it happens.
    expect(recipients).toHaveLength(2);
    expect(new Set(recipients).size).toBe(2);
  });

  it('splits UNEVENLY when asked', async () => {
    const res = await splitRequest([
      share(person.id, 'Quarter', 100, 1),
      share(org.id, 'Three quarters', 300, 3),
    ]);

    expect(res.status).toBe(201);
    const rows = await invoiceRows();
    const totals = rows.map((r: any) => Number(r.total_cents)).sort((a, b) => a - b);
    // An organization paying three quarters and a roster member the rest is the
    // ordinary shape of this feature, not an edge case.
    expect(totals).toEqual([10_000, 30_000]);
  });

  it('puts the ONE time entry on BOTH invoices as an allocated line', async () => {
    await evenSplit();

    const { rows } = await testPool.query(
      `select amount_cents, allocation_percent from invoice_line_items
        where law_firm_id = $1 and source_id = $2`, [firm.id, timeEntryId],
    );
    // One piece of work, two payers. Each invoice carries a line pointing at the
    // same entry, holding only that payer's portion.
    expect(rows).toHaveLength(2);
    const allocated = rows.reduce((sum: number, r: any) => sum + Number(r.amount_cents), 0);
    expect(allocated).toBe(40_000);
  });

  it('freezes the source entry once it is split', async () => {
    await evenSplit();

    const res = await owner.api
      .put(`${B()}/time-entries/matter/${matterId}/${timeEntryId}`)
      .send({ hours: 9 });

    // The entry now sits behind two issued invoices. Editing its hours would
    // leave both disagreeing with the firm's own record, and nothing reconciles
    // them. Frozen through the same `isSourceBilled` line-item check that
    // freezes an ordinary invoiced entry.
    expect(res.status).toBe(403);
  });
});

describe('what the split refuses', () => {
  it('refuses an invoice total that does not match its lines', async () => {
    const res = await splitRequest([
      { ...share(person.id, 'Split A', 200, 2), totalAmount: 250 },
      share(org.id, 'Split B', 200, 2),
    ]);

    // The caller computes the split in the browser and sends both the parts and
    // the total. If they disagree, one of the two is wrong and the service
    // cannot tell which, so it refuses rather than picking.
    expect(res.status).toBe(400);
  });

  it('refuses hours that do not match the lines', async () => {
    const res = await splitRequest([
      { ...share(person.id, 'Split A', 200, 2), totalHours: 3 },
      share(org.id, 'Split B', 200, 2),
    ]);

    // Hours are cross-checked separately from money, because an invoice can
    // reconcile on amount while misstating the work behind it, and the hours are
    // what a client queries.
    expect(res.status).toBe(400);
  });

  it('refuses shares that do not add up to the work being billed', async () => {
    const res = await splitRequest([
      share(person.id, 'Split A', 200, 2),
      share(org.id, 'Split B', 100, 1),
    ]);

    // Three hundred of a four hundred dollar matter. The missing hundred is
    // revenue that would never be billed to anyone and would not show as
    // unbilled either, because the entry is now on an invoice.
    expect(res.status).toBe(400);
  });

  it('refuses to bill the same client twice in one split', async () => {
    const res = await splitRequest([
      share(person.id, 'Split A', 200, 2),
      share(person.id, 'Split B', 200, 2),
    ]);

    // Two invoices to one client for one matter, while the other client on the
    // matter is billed nothing. The totals still reconcile, which is exactly why
    // this needs its own check.
    expect(res.status).toBe(400);
  });

  it('refuses a client who is not on the matter', async () => {
    const stranger = await createPersonClient(firm.id, { name: 'Not On This Matter' });
    await drainEvents();

    const res = await splitRequest([
      share(person.id, 'Split A', 200, 2),
      share(stranger.id, 'Split B', 200, 2),
    ]);

    // Billing someone for a matter they are not a client on. They have no way to
    // recognise the work and no relationship that makes them liable for it.
    expect(res.status).toBe(400);
  });

  it('refuses an empty list of invoices', async () => {
    const res = await splitRequest([]);

    // A split into nobody consumes the unbilled work and produces no bill.
    expect(res.status).toBe(400);
  });

  it('refuses two invoices with the same name', async () => {
    const res = await splitRequest([
      share(person.id, 'Same Name', 200, 2),
      share(org.id, 'Same Name', 200, 2),
    ]);

    // Invoice names are how a firm and a client refer to a bill. Two identical
    // names in one split make every later conversation ambiguous.
    expect(res.status).toBe(400);
  });

  it('refuses a selected entry that no share carries, naming it', async () => {
    // Two shares of hand-added work reconcile to themselves, while the entry
    // the caller selected is on neither. Accepted, it would leave the 400.00
    // entry marked as split with nobody billed for it.
    const manual = (clientId: string, name: string) => ({
      matterClientId: clientId, invoiceName: name, totalAmount: 50, totalHours: 0.5,
      timeEntries: [{ amount: 50, hours: 0.5 }],
    });

    const res = await splitRequest([manual(person.id, 'Split A'), manual(org.id, 'Split B')]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Selected time entry "${timeEntryId}" was not allocated to a client.`);
    expect(await invoiceRows()).toHaveLength(0);
  });

  it('refuses shares whose hours do not add up to the entry, even when the money does', async () => {
    const res = await splitRequest([
      share(person.id, 'Split A', 200, 2),
      share(org.id, 'Split B', 200, 1.5),
    ]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Allocated hours do not match source time entry "${timeEntryId}".`);
    expect(await invoiceRows()).toHaveLength(0);
  });

  it('refuses allocation percentages that do not total 100, even when amounts and hours do', async () => {
    const res = await splitRequest([
      share(person.id, 'Split A', 200, 2),
      { ...share(org.id, 'Split B', 200, 2), timeEntries: [{ id: timeEntryId, amount: 200, hours: 2, allocationPercent: 40 }] },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Allocated percentages for time entry "${timeEntryId}" must total 100%.`);
    expect(await invoiceRows()).toHaveLength(0);
  });

  it('refuses a flat fee split for more or less than the fee, and one the caller did not select', async () => {
    const fee = await owner.api.post(`${B()}/flat-fees`).send({
      matterId, description: 'Filing package', amount: 150.01, date: '2026-03-11',
    });
    expect(fee.status).toBe(201);
    const feeId = fee.body.flatFee.id;
    await drainEvents();
    const withFee = (clientId: string, name: string, amount: number, feeAmount: number) => ({
      ...share(clientId, name, amount, 2),
      totalAmount: amount + feeAmount,
      flatFeesAmount: feeAmount,
      flatFees: [{ id: feeId, description: 'Filing package', amount: feeAmount }],
    });
    const send = (invoices: unknown[], flatFees: string[]) => owner.api
      .post(`${B()}/invoices/matter/${matterId}/split`).send({
        invoiceDate: '2026-03-15',
        splitMode: 'fixed_amount',
        sourceSelection: { timeEntries: [timeEntryId], flatFees },
        invoices,
      });

    // 75.00 + 70.00 against a 150.01 fee: 5.01 of the fee billed to nobody.
    const short = await send([withFee(person.id, 'Split A', 200, 75), withFee(org.id, 'Split B', 200, 70)], [feeId]);
    // The fee rides on a share without being in the selection, so nothing
    // marks it billed and it would be billed again next time.
    const unselected = await send([withFee(person.id, 'Split A', 200, 75), withFee(org.id, 'Split B', 200, 75.01)], []);

    expect(short.status).toBe(400);
    expect(short.body.error).toBe(`Allocated amount does not match source flat fee "${feeId}".`);
    expect(unselected.status).toBe(400);
    expect(unselected.body.error).toBe(`Flat fee "${feeId}" is not part of the selected split source.`);
    expect(await invoiceRows()).toHaveLength(0);
  });

  it('refuses a split that moves one cent from the flat fee onto the time entry, though the grand total balances', async () => {
    // The two per-source errors cancel in the grand total. Each allocation
    // must reconcile in integer cents, or the time entry can gain a cent that
    // the flat fee loses while every invoice total still balances.
    const fee = await owner.api.post(`${B()}/flat-fees`).send({
      matterId, description: 'Filing package', amount: 150.01, date: '2026-03-11',
    });
    expect(fee.status).toBe(201);
    const feeId = fee.body.flatFee.id;
    await drainEvents();
    const shareOf = (clientId: string, name: string, timeAmount: number, feeAmount: number) => ({
      matterClientId: clientId,
      invoiceName: name,
      totalAmount: Math.round((timeAmount + feeAmount) * 100) / 100,
      totalHours: 2,
      flatFeesAmount: feeAmount,
      timeEntries: [{ id: timeEntryId, amount: timeAmount, hours: 2 }],
      flatFees: [{ id: feeId, description: 'Filing package', amount: feeAmount }],
    });

    const res = await owner.api.post(`${B()}/invoices/matter/${matterId}/split`).send({
      invoiceDate: '2026-03-15',
      splitMode: 'fixed_amount',
      sourceSelection: { timeEntries: [timeEntryId], flatFees: [feeId] },
      invoices: [shareOf(person.id, 'Split A', 200.01, 75), shareOf(org.id, 'Split B', 200, 75)],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Allocated amount does not match source time entry "${timeEntryId}".`);
    expect(await invoiceRows()).toHaveLength(0);
  });

  it('refuses a flat fee allocation that is one cent short before checking the grand total', async () => {
    const fee = await owner.api.post(`${B()}/flat-fees`).send({
      matterId, description: 'Filing package', amount: 150.01, date: '2026-03-11',
    });
    expect(fee.status).toBe(201);
    const feeId = fee.body.flatFee.id;
    await drainEvents();
    const withFee = (clientId: string, name: string) => ({
      ...share(clientId, name, 200, 2),
      totalAmount: 275,
      flatFeesAmount: 75,
      flatFees: [{ id: feeId, description: 'Filing package', amount: 75 }],
    });

    const res = await owner.api.post(`${B()}/invoices/matter/${matterId}/split`).send({
      invoiceDate: '2026-03-15',
      splitMode: 'fixed_amount',
      sourceSelection: { timeEntries: [timeEntryId], flatFees: [feeId] },
      invoices: [withFee(person.id, 'Split A'), withFee(org.id, 'Split B')],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Allocated amount does not match source flat fee "${feeId}".`);
    expect(await invoiceRows()).toHaveLength(0);
  });

  it('writes NO invoice when it refuses', async () => {
    await splitRequest([
      share(person.id, 'Split A', 200, 2),
      share(org.id, 'Split B', 100, 1),
    ]);

    // Asserting the DATA. A service that validated per-invoice while writing as
    // it went would leave the first invoice standing and the second refused,
    // which is a half-billed matter nobody is told about.
    expect(await invoiceRows()).toHaveLength(0);
  });

  it('does not let one firm split another firm matter', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/billing/invoices/matter/${matterId}/split`)
      .send({
        invoiceDate: '2026-03-15',
        splitMode: 'equal',
        sourceSelection: { timeEntries: [timeEntryId], flatFees: [] },
        invoices: [share(person.id, 'Split A', 400, 4)],
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await invoiceRows()).toHaveLength(0);
  });

  it('refuses a member without the invoice permission', async () => {
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi
      .post(`${B()}/invoices/matter/${matterId}/split`)
      .send({
        invoiceDate: '2026-03-15',
        splitMode: 'equal',
        sourceSelection: { timeEntries: [timeEntryId], flatFees: [] },
        invoices: [share(person.id, 'Split A', 400, 4)],
      });

    expect(res.status).toBe(403);
  });
});

/**
 * M10: a real DB failure writing one share of a split, after another share in
 * the same request has already been through its own `invoicesRepo.create`.
 *
 * The refusal tests above ('writes NO invoice when it refuses') only exercise
 * the validation that runs BEFORE any invoice is written, so they say nothing
 * about a write-time failure partway through the loop that actually creates
 * the shares. That loop used to call `invoicesRepo.create` once per share,
 * each call its own committed transaction, so a failure on the SECOND share
 * left the FIRST permanently in the database: a `split_group_id` that will
 * never have its other half, with no error anywhere pointing at the gap.
 */
describe('a real write failure partway through creating the shares', () => {
  it('rolls back EVERY share, not just the one that failed', async () => {
    gate = gateMethod(invoicesRepo, '_createTx');

    // An async function that RETURNS the supertest chain, so calling it (even
    // before awaiting) actually dispatches the request - see the header note in
    // invoiceConcurrency.test.ts on why a bare `const req = api.post(...)` does
    // not.
    async function fire() {
      return evenSplit();
    }

    const reqPromise = fire();
    // The first share's write reaches the gate and pauses there.
    await gate.arrived(1);
    // Let it through for real - it runs inside the (now single) outer
    // transaction and inserts the first invoice's rows.
    gate.openOne();
    // Arm the failure for the very next call, which is the second share's
    // write. It cannot have reached the gate yet: releasing the first waiter
    // only started its real database work, which takes an actual round trip.
    gate.failNext(new Error('connection terminated unexpectedly'));

    const res = await reqPromise;

    expect(res.status).toBeGreaterThanOrEqual(500);
    // THE BUG THIS PINS: before the fix, this would find ONE invoice (the
    // first share, already committed) instead of zero - a split group
    // permanently short a share, billing 50% of the work with no error
    // pointing at the other half.
    expect(await invoiceRows()).toHaveLength(0);
  });

  it('a retry after the rollback produces exactly one clean pair, never a duplicate of the first share', async () => {
    gate = gateMethod(invoicesRepo, '_createTx');
    async function fire() {
      return evenSplit();
    }

    const reqPromise = fire();
    await gate.arrived(1);
    gate.openOne();
    gate.failNext(new Error('connection terminated unexpectedly'));
    const failed = await reqPromise;
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await invoiceRows()).toHaveLength(0);

    gate.restore();
    gate = null;

    // Same names, same source selection: only possible because the failed
    // attempt left nothing behind for "Split A" to collide with.
    const retried = await evenSplit();
    expect(retried.status).toBe(201);

    const rows = await invoiceRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.invoice_name).sort()).toEqual(['Split A', 'Split B']);
    expect(rows.map((r: any) => Number(r.total_cents)).sort((a: number, b: number) => a - b))
      .toEqual([20_000, 20_000]);
    // One split group, not two half-groups from two different attempts.
    expect(rows[0].split_group_id).toBe(rows[1].split_group_id);
  });
});

describe('correcting a payment', () => {
  let invoiceId: string;

  const invoicePath = () => `${B()}/invoices/client/${person.id}/${invoiceId}`;

  const balanceCents = async () => {
    const { rows } = await testPool.query(
      'select balance_due_cents, amount_paid_cents from invoices where id = $1', [invoiceId],
    );
    return {
      due: Number(rows[0].balance_due_cents),
      paid: Number(rows[0].amount_paid_cents),
    };
  };

  beforeEach(async () => {
    // A single flat fee carries the amount, because the service refuses an
    // invoice whose `totalAmount` does not equal the sum of its line items. A
    // fixture cannot state a total out of thin air.
    const created = await owner.api.post(`${B()}/invoices/client/${person.id}`).send({
      invoiceName: 'Correctable Invoice',
      invoiceDate: '2026-03-15',
      dueDate: '2026-04-15',
      totalAmount: 500,
      flatFeesAmount: 500,
      flatFees: [{ description: 'Fixed fee', amount: 500 }],
    });
    expect(created.status).toBe(201);
    invoiceId = created.body.invoice.id;

    const paid = await owner.api.put(`${invoicePath()}/payment`)
      .send({ paymentAmount: 200, paidDate: '2026-03-20' });
    expect(paid.status).toBe(200);
    await drainEvents();
  });

  it('starts with the payment applied', async () => {
    const { due, paid } = await balanceCents();

    expect(paid).toBe(20_000);
    expect(due).toBe(30_000);
  });

  it('restores the balance when a payment is deleted', async () => {
    const res = await owner.api.delete(`${invoicePath()}/payment?paymentIndex=0`);

    expect(res.status).toBe(200);
    const { due, paid } = await balanceCents();
    // A payment keyed against the wrong invoice has to be removable, and the
    // money has to go back. Leaving the balance reduced credits the client for
    // money the firm never received.
    expect(paid).toBe(0);
    expect(due).toBe(50_000);
  });

  it('adjusts the balance when a payment amount is edited', async () => {
    const res = await owner.api.patch(`${invoicePath()}/payment`)
      .send({ paymentIndex: 0, amount: 350 });

    expect(res.status).toBe(200);
    const { due, paid } = await balanceCents();
    // A mis-keyed amount, corrected. The balance has to follow, not just the
    // stored payment record.
    expect(paid).toBe(35_000);
    expect(due).toBe(15_000);
  });

  it('settles the invoice when an edit raises the payment to the full total', async () => {
    await owner.api.patch(`${invoicePath()}/payment`)
      .send({ paymentIndex: 0, amount: 500 });

    const { due } = await balanceCents();
    const { rows } = await testPool.query('select is_paid from invoices where id = $1', [invoiceId]);
    expect(due).toBe(0);
    expect(rows[0].is_paid).toBe(true);
  });

  it('reopens the invoice when a payment that settled it is deleted', async () => {
    await owner.api.patch(`${invoicePath()}/payment`)
      .send({ paymentIndex: 0, amount: 500 });

    await owner.api.delete(`${invoicePath()}/payment?paymentIndex=0`);

    const { rows } = await testPool.query('select is_paid from invoices where id = $1', [invoiceId]);
    // An invoice left marked paid with nothing paid on it disappears from every
    // outstanding list, and the firm stops chasing a live debt.
    expect(rows[0].is_paid).toBe(false);
    expect((await balanceCents()).due).toBe(50_000);
  });

  it('refuses a payment index that does not exist', async () => {
    const res = await owner.api.delete(`${invoicePath()}/payment?paymentIndex=7`);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await balanceCents()).paid).toBe(20_000);
  });

  it('refuses a negative payment index', async () => {
    const res = await owner.api.delete(`${invoicePath()}/payment?paymentIndex=-1`);

    expect(res.status).toBe(400);
  });

  it('refuses an edit to a zero or negative amount', async () => {
    const res = await owner.api.patch(`${invoicePath()}/payment`)
      .send({ paymentIndex: 0, amount: 0 });

    // A zero payment is a deletion wearing an edit's clothes, and it would leave
    // a payment record claiming nothing was paid.
    expect(res.status).toBe(400);
  });

  it('does not let one firm delete another firm payment', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api.delete(
      `/api/lawfirms/${otherFirm.id}/billing/invoices/client/${person.id}/${invoiceId}/payment?paymentIndex=0`,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await balanceCents()).paid).toBe(20_000);
  });

  it('refuses a member without the record-payments permission', async () => {
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi.delete(`${invoicePath()}/payment?paymentIndex=0`);

    expect(res.status).toBe(403);
    expect((await balanceCents()).paid).toBe(20_000);
  });

  it('M07: enforces payment boundaries just below, above, and exactly at outstanding amount', async () => {
    // Starting balance: $500 total, $200 already paid => $300 (30,000 cents) remaining.
    const initial = await balanceCents();
    expect(initial.due).toBe(30_000);
    expect(initial.paid).toBe(20_000);

    // 1. Payment just below remaining balance ($299.98).
    // Note: the guard is exact in cents, so 299.98 leaves 2 cents remaining.
    const belowRes = await owner.api.put(`${invoicePath()}/payment`).send({
      paymentAmount: 299.98,
      paidDate: '2026-03-21',
    });
    expect(belowRes.status).toBe(200);

    const afterBelow = await balanceCents();
    expect(afterBelow.paid).toBe(49_998);
    expect(afterBelow.due).toBe(2); // 2 cents remaining

    const { rows: rowsAfterBelow } = await testPool.query(
      'select is_paid from invoices where id = $1',
      [invoiceId],
    );
    expect(rowsAfterBelow[0].is_paid).toBe(false);
    const { rows: paymentsBelow } = await testPool.query(
      'select count(*)::int as count from invoice_payments where invoice_id = $1',
      [invoiceId],
    );
    expect(paymentsBelow[0].count).toBe(2);

    // 2. Payment above remaining balance ($0.05 when balance is $0.02).
    // The overpayment guard must refuse and write NOTHING.
    const aboveRes = await owner.api.put(`${invoicePath()}/payment`).send({
      paymentAmount: 0.05,
      paidDate: '2026-03-22',
    });
    expect(aboveRes.status).toBe(400);
    expect(aboveRes.body.error).toMatch(/exceeds the remaining balance/i);

    const afterAbove = await balanceCents();
    expect(afterAbove.paid).toBe(49_998);
    expect(afterAbove.due).toBe(2);

    const { rows: rowsAfterAbove } = await testPool.query(
      'select is_paid from invoices where id = $1',
      [invoiceId],
    );
    expect(rowsAfterAbove[0].is_paid).toBe(false);
    const { rows: paymentsAbove } = await testPool.query(
      'select count(*)::int as count from invoice_payments where invoice_id = $1',
      [invoiceId],
    );
    expect(paymentsAbove[0].count).toBe(2); // No payment row appended

    // 3. Payment exactly at remaining balance ($0.02).
    const exactRes = await owner.api.put(`${invoicePath()}/payment`).send({
      paymentAmount: 0.02,
      paidDate: '2026-03-23',
    });
    expect(exactRes.status).toBe(200);

    const afterExact = await balanceCents();
    expect(afterExact.paid).toBe(50_000);
    expect(afterExact.due).toBe(0);

    const { rows: rowsAfterExact } = await testPool.query(
      'select is_paid, paid_date from invoices where id = $1',
      [invoiceId],
    );
    expect(rowsAfterExact[0].is_paid).toBe(true);
    expect(rowsAfterExact[0].paid_date).toBeTruthy();
    const { rows: paymentsExact } = await testPool.query(
      'select count(*)::int as count from invoice_payments where invoice_id = $1',
      [invoiceId],
    );
    expect(paymentsExact[0].count).toBe(3);
  });
});
