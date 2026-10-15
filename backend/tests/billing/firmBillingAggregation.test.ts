import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  ownerOf,
  freezeClockAt,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import {
  getInvoiceTotal,
  isInvoicePastDue,
  listFirmInvoices,
  getBillingWorkbench,
} from '../../src/modules/billing/shared/firmBilling.service';

let firm: Firm;
let owner: Actor;

async function seedClient(lawFirmId: string, name = 'Client Agg') {
  const id = randomUUID();
  await testPool.query(
    `insert into clients (id, law_firm_id, name, email, client_type) values ($1, $2, $3, $4, 'person')`,
    [id, lawFirmId, name, `${id.slice(0, 8)}@example.com`],
  );
  return { id, name };
}

/**
 * A matter with a client attached.
 *
 * `matters` carries no `client_id`. A matter can bill several clients with a
 * split between them, so the link is the `matter_clients` junction, and the
 * aggregation under test reads it through that junction rather than off the
 * matter row.
 */
async function seedMatter(lawFirmId: string, clientId: string, name = 'Matter Agg') {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, $3, $4)`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  await testPool.query(
    `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
    [id, clientId, lawFirmId],
  );
  return { id, name };
}

async function seedInvoice(
  lawFirmId: string,
  matterId: string,
  clientId: string,
  overrides: Record<string, any> = {},
) {
  const id = randomUUID();
  const invoiceNumber = `INV-${id.slice(0, 6).toUpperCase()}`;
  const toCents = (dollars: number) => Math.round(dollars * 100);

  // Relational columns, not a `doc` jsonb: `invoices` has no such column. Money
  // is integer cents, and a CHECK constraint requires exactly one of `matter_id`
  // or `client_context_id`, which is how a matter invoice is told from a
  // client-level one.
  await testPool.query(
    `insert into invoices (
       id, law_firm_id, matter_id, client_id, context_type, invoice_number, invoice_name,
       status, total_cents, amount_paid_cents, total_written_off_cents, is_paid,
       invoice_date, due_date, client_email, client_name
     ) values ($1, $2, $3, $4, 'matter', $5, $5, $6, $7, $8, $9, $10,
               current_date, $11, 'client@example.com', 'Client Agg')`,
    [
      id,
      lawFirmId,
      matterId,
      clientId,
      invoiceNumber,
      overrides.status ?? 'outstanding',
      toCents(overrides.totalAmount ?? 1000),
      toCents(overrides.amountPaid ?? 0),
      toCents(overrides.totalWrittenOff ?? 0),
      overrides.isPaid ?? false,
      overrides.dueDate ?? '2026-08-01',
    ],
  );

  return { id, invoiceNumber, totalAmount: overrides.totalAmount ?? 1000 };
}

async function seedUnbilledTimeEntry(lawFirmId: string, matterId: string, hours = 2.5, rateCents = 20000) {
  const id = randomUUID();
  const amountCents = Math.round(hours * rateCents);
  // `entry_date`, not `date`. `amount_cents` is `generated always as
  // round(hours * rate_cents)` and may not be written, so it is computed here
  // only to return the figure the caller asserts against.
  await testPool.query(
    `insert into activities (kind, id, law_firm_id, matter_id, hours, rate_cents, activity_date, description)
     values ('time', $1, $2, $3, $4, $5, '2026-08-20', 'Unbilled Legal Research')`,
    [id, lawFirmId, matterId, hours, rateCents],
  );
  return { id, hours, amountCents };
}

describe('Firm Billing Aggregation Service', () => {
  beforeEach(async () => {
    firm = await createFirm({ name: 'Firm Billing Agg' });
    owner = await ownerOf(firm.id);
  });

  describe('Pure Utility Logic', () => {
    it('calculates getInvoiceTotal from totalAmount alone, never falling back to flatFeesAmount', () => {
      expect(getInvoiceTotal({ totalAmount: 450.5 })).toBe(450.5);
      expect(getInvoiceTotal({ flatFeesAmount: 300.0 })).toBe(0);
      expect(getInvoiceTotal({})).toBe(0);
    });

    it('evaluates isInvoicePastDue correctly considering payments and timezones', () => {
      // Unpaid past due
      const overdueInvoice = {
        totalAmount: 500,
        amountPaid: 0,
        totalWrittenOff: 0,
        isPaid: false,
        dueDate: '2026-08-01',
      };
      expect(isInvoicePastDue(overdueInvoice, new Date('2026-08-31T00:00:00Z'))).toBe(true);

      // Paid in full
      const paidInvoice = {
        totalAmount: 500,
        amountPaid: 500,
        totalWrittenOff: 0,
        isPaid: true,
        dueDate: '2026-08-01',
      };
      expect(isInvoicePastDue(paidInvoice, new Date('2026-08-31T00:00:00Z'))).toBe(false);

      // Future due date
      const futureInvoice = {
        totalAmount: 500,
        amountPaid: 0,
        totalWrittenOff: 0,
        isPaid: false,
        dueDate: '2026-10-01',
      };
      expect(isInvoicePastDue(futureInvoice, new Date('2026-08-31T00:00:00Z'))).toBe(false);
    });
  });

  describe('listFirmInvoices and Workbench Aggregation', () => {
    it('lists all invoices across matters and clients in the firm', async () => {
      const client = await seedClient(firm.id, 'Alpha Client');
      const matter1 = await seedMatter(firm.id, client.id, 'Matter One');
      const matter2 = await seedMatter(firm.id, client.id, 'Matter Two');

      await seedInvoice(firm.id, matter1.id, client.id, { totalAmount: 600 });
      await seedInvoice(firm.id, matter2.id, client.id, { totalAmount: 400 });

      const result = await listFirmInvoices({
        lawFirmId: firm.id,
        actingUserId: owner.uid,
      });

      expect(result.invoices).toHaveLength(2);
      expect(result.invoices.map((inv: any) => inv.totalAmount)).toEqual(
        expect.arrayContaining([600, 400]),
      );
    });

    // Unbilled work (completed tasks, never time entries) is pinned through the
    // real route in `workbenchRoutes.test.ts` ("GET /billing/unbilled-work").

    it('summarises overdue money and unbilled hours on the workbench', async () => {
      const client = await seedClient(firm.id, 'Gamma Client');
      const matter = await seedMatter(firm.id, client.id, 'Workbench Matter');

      await seedInvoice(firm.id, matter.id, client.id, {
        totalAmount: 1000,
        amountPaid: 200,
        dueDate: '2026-07-01',
      });
      await seedUnbilledTimeEntry(firm.id, matter.id, 4.0, 25000);

      const workbench = await getBillingWorkbench({
        lawFirmId: firm.id,
        actingUserId: owner.uid,
        timezone: 'America/New_York',
      });

      // Exact figures, not "greater than zero". The overdue amount is the
      // REMAINING balance (1000 billed less 200 paid), so a summary that summed
      // invoice totals instead would read 1000 and still be "greater than zero".
      expect(workbench.summary).toMatchObject({
        overdueAmount: 800,
        overdueCount: 1,
        totalCollected: 200,
        totalInvoices: 1,
        unbilledHours: 4,
      });
    });

    it('never counts another firm money on this firm workbench', async () => {
      const client = await seedClient(firm.id, 'Gamma Client');
      const matter = await seedMatter(firm.id, client.id, 'Workbench Matter');
      await seedInvoice(firm.id, matter.id, client.id, {
        totalAmount: 1000, amountPaid: 200, dueDate: '2026-07-01',
      });

      const neighbour = await createFirm({ name: 'Neighbour LLP' });
      const neighbourOwner = await ownerOf(neighbour.id);
      const theirClient = await seedClient(neighbour.id, 'Their Client');
      const theirMatter = await seedMatter(neighbour.id, theirClient.id, 'Their Matter');
      await seedInvoice(neighbour.id, theirMatter.id, theirClient.id, {
        totalAmount: 9999, amountPaid: 0, dueDate: '2026-07-01',
      });

      const mine = await getBillingWorkbench({
        lawFirmId: firm.id, actingUserId: owner.uid, timezone: 'America/New_York',
      });
      const theirs = await getBillingWorkbench({
        lawFirmId: neighbour.id, actingUserId: neighbourOwner.uid, timezone: 'America/New_York',
      });

      // Both directions. An aggregate that lost its firm scope would show 10799
      // here, and a query returning nothing at all would pass a one-sided check.
      expect(mine.summary.overdueAmount).toBe(800);
      expect(theirs.summary.overdueAmount).toBe(9999);
    });

    // `collections.dueSoonCount` is computed from `firmBilling.service.ts`'s
    // private `startOfDay`/`getInvoiceDueDate`, which read the calendar day off
    // `Date`'s LOCAL getters - the SERVER PROCESS's OS time zone, not the `tz`
    // parameter this same function is passed (and correctly uses one line
    // above, for `overdueCount`). Pacific/Midway (UTC-11) is picked because it
    // reads a full calendar day BEHIND both plausible server zones this suite
    // runs under (UTC in CI, America/Los_Angeles here): "now" frozen at
    // 2026-03-02T05:00:00Z is already March 2nd server-side under either zone,
    // but only 6pm on March 1st for a Midway recipient - so an invoice due
    // exactly that recipient's "today" is invisible to a server-local
    // comparison regardless of which of those two zones actually runs this.
    it('counts an invoice due "today" in the RECIPIENT zone as due-soon, not the server zone', async () => {
      const client = await seedClient(firm.id, 'Midway Client');
      const matter = await seedMatter(firm.id, client.id, 'Midway Matter');
      await seedInvoice(firm.id, matter.id, client.id, {
        totalAmount: 500,
        dueDate: '2026-03-01',
      });

      freezeClockAt('2026-03-02T05:00:00Z');
      const workbench = await getBillingWorkbench({
        lawFirmId: firm.id,
        actingUserId: owner.uid,
        timezone: 'Pacific/Midway',
      });

      expect(workbench.collections).toMatchObject({ overdueCount: 0, dueSoonCount: 1 });
    });
  });

  // Billing settings, including ignoring keys the writer does not own, are pinned
  // in `workbenchRoutes.test.ts` ("GET/PUT /billing/settings").
});
