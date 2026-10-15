/**
 * The number, invoice date and remit-to freeze at issue, judged under the lock.
 *
 * The edit used to decide "not issued yet" from a read taken before it locked
 * the row. A first send that stamped `billing_snapshot_at` while the edit
 * waited was not seen, and the number changed on a bill the client already had.
 * This spec holds the row, lets the edit block, stamps the snapshot from the
 * holding transaction, and then lets the edit continue.
 */
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { waitForInvoiceLockWaiter as waitForLock } from '../support/invoiceLockWaiter';

let firm: Firm;
let owner: Actor;
let clientId: string;
let invoiceId: string;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}`;

const waitForInvoiceLockWaiter = () =>
  waitForLock('The edit never blocked on the held invoice row lock');

async function invoiceNumber() {
  const { rows } = await testPool.query('select invoice_number from invoices where id = $1', [invoiceId]);
  return rows[0].invoice_number;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  clientId = (await createPersonClient(firm.id, { name: 'Frozen Client' })).id;
  const created = await owner.api.post(B()).send({
    invoiceName: 'Freeze', invoiceNumber: 'ORIG-1', invoiceDate: '2026-03-01', dueDate: '2026-03-31',
    totalAmount: 1000, flatFeesAmount: 1000, flatFees: [{ description: 'Fixed fee', amount: 1000 }],
  });
  expect(created.status).toBe(201);
  invoiceId = created.body.invoice.id;
  await drainEvents();
});

/** RED IF the freeze is read before the lock: 200 and the number becomes INV-CHANGED. */
it('refuses a number change when the invoice is issued while the edit waits', async () => {
  const held = await testPool.connect();
  async function edit() {
    return owner.api.patch(`${B()}/${invoiceId}/details`).send({ invoiceNumber: 'INV-CHANGED' });
  }
  let res;
  try {
    await held.query('begin');
    await held.query('select id from invoices where id = $1 for update', [invoiceId]);
    const editing = edit();
    await waitForInvoiceLockWaiter();
    await held.query('update invoices set billing_snapshot_at = now() where id = $1', [invoiceId]);
    await held.query('commit');
    res = await editing;
  } finally {
    await held.query('rollback').catch(() => undefined);
    held.release();
  }

  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/frozen once an invoice has been issued/);
  expect(await invoiceNumber()).toBe('ORIG-1');
});

it('refuses a number change after issue with 409', async () => {
  await testPool.query('update invoices set billing_snapshot_at = now() where id = $1', [invoiceId]);

  const res = await owner.api.patch(`${B()}/${invoiceId}/details`).send({ invoiceNumber: 'INV-CHANGED' });

  expect(res.status).toBe(409);
  expect(await invoiceNumber()).toBe('ORIG-1');
});

it('still lets the number change before issue', async () => {
  const res = await owner.api.patch(`${B()}/${invoiceId}/details`).send({ invoiceNumber: 'INV-CHANGED' });

  expect(res.status).toBe(200);
  expect(await invoiceNumber()).toBe('INV-CHANGED');
});
