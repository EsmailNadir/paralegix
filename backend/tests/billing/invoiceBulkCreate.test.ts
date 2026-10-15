/**
 * Billing a whole screen of matters in one action: `bulkCreateInvoices`.
 *
 * This is the widest single write in the invoice service. One request turns N
 * contexts into N invoices, and every number on every one of them is derived
 * server-side: the invoice number comes from a per-firm counter, the lines come
 * from whatever the context still has unbilled, and the totals are re-summed in
 * integer cents. Nothing in the response tells a firm whether any of that went
 * right, because each invoice it produces looks perfectly ordinary on its own.
 *
 * The failures this file is built to catch are the ones with no visible symptom:
 *
 *   - Two invoices in one run carrying the SAME number. Each looks fine; the
 *     firm's books now have a collision, and the unique index is the only thing
 *     between that and two clients paying against one reference.
 *   - The counter advancing by less than the invoices created, so the NEXT run
 *     re-issues a number already in use.
 *   - A partial selection billing the right money but the wrong HOURS. The
 *     total is correct, so no reconciliation catches it; the client is simply
 *     shown an effective rate the firm never charged.
 *   - A per-line half cent rounded once at the end instead of per line, which
 *     moves the invoice total by a cent that the line items then fail to
 *     reconcile to.
 *   - A split matter billed once to the matter instead of once per payer, or
 *     billed per payer with numbers the counter never issued.
 *
 * `invoiceSplitAndPayments.test.ts` covers the explicit split endpoint;
 * `invoiceLifecycle.test.ts` covers a single create. This file covers only what
 * the bulk path adds on top of them: context fan-out, number allocation, line
 * selection, and the split it infers from the matter rather than being told.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

const invoicesRepo = require('../../src/modules/billing/invoices/invoices.repository');

let firm: Firm;
let owner: Actor;
let clientA: ClientRecord;
let clientB: ClientRecord;
/** A matter carrying $1,000 of unbilled time. */
let matterA: string;
/** A second matter, so a run always has more than one context to fan out over. */
let matterB: string;

const BULK = () => `/api/lawfirms/${firm.id}/billing/invoices/bulk`;

/**
 * A matter, with `owner` on it as a member.
 *
 * Matter membership is required by `authorizeContext` on the write path and has
 * no owner escape, so a matter seeded without this row is silently skipped by
 * the bulk run rather than refused, which reads as a fixture that has no work.
 */
async function seedMatter(name: string, clientId: string, member: string) {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1, $2, $3, $4, 'active')`,
    [id, firm.id, name, `REF-${id.slice(0, 8)}`],
  );
  await testPool.query(
    `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
     values ($1, $2, $3, 'lead', now())`,
    [id, member, firm.id],
  );
  await testPool.query(
    `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
    [id, clientId, firm.id],
  );
  return id;
}

/**
 * An unbilled time entry on a matter.
 *
 * `rate_cents` is always set: a null rate sends the read down the resolution
 * chain (charge code, matter member, client, firm default), and the amount then
 * depends on fixtures this file does not control.
 */
async function seedTimeEntry(matterId: string, hours: number, rateCents: number, description = 'Work') {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into activities (kind, id, law_firm_id, matter_id, user_id, activity_date, hours, rate_cents, description)
     values ('time', $1, $2, $3, $4, date '2026-03-10', $5, $6, $7) returning id`,
    [id, firm.id, matterId, owner.uid, hours, rateCents, description],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function seedFlatFee(matterId: string, amountCents: number, description = 'Filing fee') {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into activities (kind, id, law_firm_id, matter_id, description, charge_cents, activity_date)
     values ('flat_fee', $1, $2, $3, $4, $5, date '2026-03-10') returning id`,
    [id, firm.id, matterId, description, amountCents],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

/** Every invoice the firm holds, in the order the counter issued the numbers. */
async function invoiceRows(lawFirmId = firm.id) {
  const { rows } = await testPool.query(
    `select id, invoice_name, invoice_number, matter_id, client_context_id, client_id,
            total_cents, total_hours, split_group_id, split_share_cents
       from invoices where law_firm_id = $1 order by invoice_number`,
    [lawFirmId],
  );
  return rows;
}

/** The firm's invoice-number counter, or null when it has never allocated one. */
async function counterValue(lawFirmId = firm.id) {
  const { rows } = await testPool.query(
    `select next_val from firm_counters
      where law_firm_id = $1 and counter_type = 'invoice_number'`,
    [lawFirmId],
  );
  return rows.length ? Number(rows[0].next_val) : null;
}

/** The source ids placed on an invoice as line items. */
async function lineSourceIds(invoiceId: string) {
  const { rows } = await testPool.query(
    `select source_id, kind, amount_cents, quantity from invoice_line_items
      where invoice_id = $1 order by amount_cents`,
    [invoiceId],
  );
  return rows;
}

const bulk = (body: Record<string, unknown>) =>
  owner.api.post(BULK()).send({ invoiceDate: '2026-03-15', ...body });

const matterCtx = (entityId: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'matter', entityId, ...extra });

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  clientA = await createPersonClient(firm.id, { name: 'Alice Payer' });
  clientB = await createPersonClient(firm.id, { name: 'Bob Payer' });
  matterA = await seedMatter('Matter A', clientA.id, owner.uid);
  matterB = await seedMatter('Matter B', clientB.id, owner.uid);
  // $1,000 on A (10h at $100), $250 on B (2.5h at $100). Different figures so a
  // context that billed the wrong matter's work is visible in the total.
  await seedTimeEntry(matterA, 10, 10_000, 'A work');
  await seedTimeEntry(matterB, 2.5, 10_000, 'B work');
  await drainEvents();
});

describe('fanning one request out over several contexts', () => {
  it('creates one invoice per context that has unbilled work', async () => {
    const res = await bulk({ contexts: [matterCtx(matterA), matterCtx(matterB)] });

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(2);
    // Read from the database rather than the response: the response is what the
    // service says it did, the rows are what it actually did.
    const rows = await invoiceRows();
    expect(rows.map((r: any) => r.matter_id).sort()).toEqual([matterA, matterB].sort());
  });

  it('bills each context only its OWN work', async () => {
    await bulk({ contexts: [matterCtx(matterA), matterCtx(matterB)] });

    const rows = await invoiceRows();
    const byMatter = new Map(rows.map((r: any) => [r.matter_id, Number(r.total_cents)]));
    // $1,000 and $250, never $1,250 on either. A summary batch keyed loosely
    // enough to let one context read another's entries shows up here and
    // nowhere else: both invoices would still look internally consistent.
    expect(byMatter.get(matterA)).toBe(100_000);
    expect(byMatter.get(matterB)).toBe(25_000);
  });

  it('reports how many contexts it was asked for, alongside what it produced', async () => {
    const res = await bulk({ contexts: [matterCtx(matterA), matterCtx(matterB)] });

    expect(res.body.requested).toBe(2);
    expect(res.body.failed).toEqual([]);
    expect(res.body.errors).toEqual({});
  });

  it('marks the billed work as billed, so a second run finds nothing to bill', async () => {
    await bulk({ contexts: [matterCtx(matterA)] });
    const second = await bulk({ contexts: [matterCtx(matterA)] });

    expect(second.body.created).toEqual([]);
    expect(second.body.skipped).toEqual([matterA]);
    // The absence above only means something because the first run really did
    // create an invoice against this matter.
    expect(await invoiceRows()).toHaveLength(1);
  });
});

describe('the numbers it hands out', () => {
  it('gives every invoice in one run a DISTINCT number', async () => {
    await bulk({ contexts: [matterCtx(matterA), matterCtx(matterB)] });

    const numbers = (await invoiceRows()).map((r: any) => r.invoice_number);
    expect(numbers).toHaveLength(2);
    expect(new Set(numbers).size).toBe(2);
  });

  it('takes them in sequence from the firm counter', async () => {
    await bulk({ contexts: [matterCtx(matterA), matterCtx(matterB)] });

    expect((await invoiceRows()).map((r: any) => r.invoice_number)).toEqual(['INV-001', 'INV-002']);
    // The counter holds the NEXT value, so two allocations from a fresh firm
    // leave it at 3. A counter that lags the invoices it issued hands the next
    // run a number already in use.
    expect(await counterValue()).toBe(3);
  });

  it('continues the sequence on a later run rather than restarting at one', async () => {
    await bulk({ contexts: [matterCtx(matterA)] });
    await seedTimeEntry(matterB, 1, 10_000, 'more B work');
    await bulk({ contexts: [matterCtx(matterB)] });

    expect((await invoiceRows()).map((r: any) => r.invoice_number)).toEqual(['INV-001', 'INV-002']);
  });

  it('strips the digits off the requested prefix, so the counter supplies the number', async () => {
    // A caller sending "BILL-042" is naming a prefix and a starting point. Only
    // the prefix is honoured: the number is the counter's to issue, or two
    // concurrent runs both start at 042.
    const res = await bulk({ contexts: [matterCtx(matterA)], invoiceNamePrefix: 'BILL-042' });

    expect(res.status).toBe(201);
    expect((await invoiceRows()).map((r: any) => r.invoice_number)).toEqual(['BILL-001']);
  });

  it('keeps ONE counter per firm, so a new prefix does not restart the sequence', async () => {
    await bulk({ contexts: [matterCtx(matterA)], invoiceNamePrefix: 'INV-001' });
    await bulk({ contexts: [matterCtx(matterB)], invoiceNamePrefix: 'BILL-001' });

    // The second prefix picks up at 002, not 001. That reads oddly on screen and
    // is deliberate: the counter is what makes a number unique within the firm,
    // and the unique index on (law_firm_id, invoice_number) is firm-wide too.
    const rows = await invoiceRows();
    expect(rows.map((r: any) => r.invoice_number).sort()).toEqual(['BILL-002', 'INV-001']);
  });

  it('pads the number to three digits', async () => {
    await bulk({ contexts: [matterCtx(matterA)] });

    expect((await invoiceRows())[0].invoice_number).toBe('INV-001');
  });

  it('names the invoice with the same value it numbered it', async () => {
    await bulk({ contexts: [matterCtx(matterA)] });

    const row = (await invoiceRows())[0];
    expect(row.invoice_name).toBe('INV-001');
    expect(row.invoice_number).toBe('INV-001');
  });

  it('does not draw on another firm counter', async () => {
    const otherFirm = await createFirm({ name: 'Other Firm' });
    const otherOwner = await ownerOf(otherFirm.id);
    await bulk({ contexts: [matterCtx(matterA), matterCtx(matterB)] });

    // The first firm has consumed 001 and 002. A shared counter would start the
    // second firm at 003 and its books would have an unexplained gap.
    const otherClient = await createPersonClient(otherFirm.id, { name: 'Other Client' });
    const otherMatterId = randomUUID();
    await testPool.query(
      `insert into matters (id, law_firm_id, name, matter_reference_id, status)
       values ($1, $2, 'Other Matter', $3, 'active')`,
      [otherMatterId, otherFirm.id, `REF-${otherMatterId.slice(0, 8)}`],
    );
    await testPool.query(
      `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
       values ($1, $2, $3, 'lead', now())`,
      [otherMatterId, otherOwner.uid, otherFirm.id],
    );
    await testPool.query(
      `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
      [otherMatterId, otherClient.id, otherFirm.id],
    );
    await testPool.query(
      `insert into activities (kind, id, law_firm_id, matter_id, user_id, activity_date, hours, rate_cents, description)
       values ('time', gen_random_uuid(), $1, $2, $3, date '2026-03-10', 1, 10000, 'other work')`,
      [otherFirm.id, otherMatterId, otherOwner.uid],
    );

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/billing/invoices/bulk`)
      .send({ invoiceDate: '2026-03-15', contexts: [{ type: 'matter', entityId: otherMatterId }] });
    expect(res.status).toBe(201);

    expect((await invoiceRows(otherFirm.id)).map((r: any) => r.invoice_number)).toEqual(['INV-001']);
  });
});

describe('billing only part of a context', () => {
  let keptId: string;
  let droppedId: string;

  beforeEach(async () => {
    // Wipe the default entry so the two below are the whole of the matter's
    // unbilled work and the arithmetic below is exact.
    await testPool.query(`delete from activities where kind = 'time' and matter_id = $1`, [matterA]);
    // 3h at $100 = $300, and 7h at $100 = $700. Different hours as well as
    // different money, so an invoice that billed the right dollars against the
    // wrong hours is distinguishable.
    keptId = await seedTimeEntry(matterA, 3, 10_000, 'kept');
    droppedId = await seedTimeEntry(matterA, 7, 10_000, 'dropped');
  });

  it('bills only the entries named in the selection', async () => {
    const res = await bulk({ contexts: [matterCtx(matterA, { timeEntryIds: [keptId] })] });
    expect(res.status).toBe(201);

    const row = (await invoiceRows())[0];
    expect(Number(row.total_cents)).toBe(30_000);
    expect((await lineSourceIds(row.id)).map((l: any) => l.source_id)).toEqual([keptId]);
  });

  it('bills the HOURS of the selection, not the context whole unbilled total', async () => {
    await bulk({ contexts: [matterCtx(matterA, { timeEntryIds: [keptId] })] });

    // The stored hours are re-summed from the line items the selection produced,
    // so what has to break for this to go red is the selection filter itself:
    // any widening of it puts the dropped 7h back on the invoice. The trap it
    // guards is an invoice whose money is right and whose hours are the matter's
    // full 10. That reconciles against its own lines on every screen and still
    // tells the client 10 hours were billed at an effective $30/h the firm never
    // charged.
    expect(Number((await invoiceRows())[0].total_hours)).toBe(3);
  });

  it('leaves the unselected work unbilled and available for the next run', async () => {
    await bulk({ contexts: [matterCtx(matterA, { timeEntryIds: [keptId] })] });
    const second = await bulk({ contexts: [matterCtx(matterA)] });

    expect(second.body.created).toHaveLength(1);
    const rows = await invoiceRows();
    expect(rows).toHaveLength(2);
    const secondInvoice = rows.find((r: any) => r.invoice_number === 'INV-002');
    expect(Number(secondInvoice.total_cents)).toBe(70_000);
    expect((await lineSourceIds(secondInvoice.id)).map((l: any) => l.source_id)).toEqual([droppedId]);
  });

  it('ignores a selected id that belongs to a DIFFERENT context', async () => {
    const foreign = await seedTimeEntry(matterB, 4, 10_000, 'B work not in this context');

    await bulk({ contexts: [matterCtx(matterA, { timeEntryIds: [keptId, foreign] })] });

    // A selection is caller-supplied. Filtering it against the context's own
    // unbilled set is the only thing stopping one matter's bill from pulling in
    // another's work, which no screen on either matter would show as wrong.
    const row = (await invoiceRows())[0];
    expect(Number(row.total_cents)).toBe(30_000);
    expect((await lineSourceIds(row.id)).map((l: any) => l.source_id)).toEqual([keptId]);
  });

  it('skips a context whose selection matches nothing it can bill', async () => {
    const otherContextsEntry = await seedTimeEntry(matterB, 1, 10_000, 'B work, not in matter A');
    const res = await bulk({
      contexts: [matterCtx(matterA, { timeEntryIds: [otherContextsEntry] }), matterCtx(matterB)],
    });

    expect(res.body.skipped).toEqual([matterA]);
    // The skip means something only because the OTHER context in the same run
    // was billed: an empty run would produce the same skipped list.
    expect(res.body.created).toHaveLength(1);
    expect((await invoiceRows()).map((r: any) => r.matter_id)).toEqual([matterB]);
  });

  it('bills a flat fee selection independently of the time selection', async () => {
    const feeId = await seedFlatFee(matterA, 12_500);

    await bulk({
      contexts: [matterCtx(matterA, { timeEntryIds: [], flatFeeIds: [feeId] })],
    });

    const row = (await invoiceRows())[0];
    expect(Number(row.total_cents)).toBe(12_500);
    expect(Number(row.total_hours)).toBe(0);
  });
});

describe('the cent each line lands on', () => {
  it('rounds every line to a whole cent before summing, not the run total', async () => {
    await testPool.query(`delete from activities where kind = 'time' and matter_id = $1`, [matterA]);
    // 2.35h at $100.10 is $235.235: exactly half a cent. Two of them is the
    // input where the two arithmetics part company. Rounded per line the
    // invoice is 23524 + 23524 = 47048 cents; summed first and rounded once it
    // is 47047. A round-number fixture passes under either.
    //
    // The cents are rounded per line TWICE on the way here (once where the
    // unbilled summary builds the line, once where createInvoice re-sums the
    // lines it was handed), so either alone still lands on 47048. What has to
    // break for this to go red is BOTH of them turning into a float sum.
    await seedTimeEntry(matterA, 2.35, 10_010, 'half-cent one');
    await seedTimeEntry(matterA, 2.35, 10_010, 'half-cent two');

    const res = await bulk({ contexts: [matterCtx(matterA)] });
    expect(res.status).toBe(201);

    const row = (await invoiceRows())[0];
    expect(Number(row.total_cents)).toBe(47_048);
    // And the stored lines must add up to it, or the invoice disagrees with
    // itself the moment anyone totals the page.
    const lines = await lineSourceIds(row.id);
    expect(lines.reduce((sum: number, l: any) => sum + Number(l.amount_cents), 0)).toBe(47_048);
  });

  it('keeps the invoice total equal to the sum of its lines across mixed sources', async () => {
    await seedFlatFee(matterA, 3_333);
    await seedFlatFee(matterA, 6_667);

    await bulk({ contexts: [matterCtx(matterA)] });

    const row = (await invoiceRows())[0];
    const lines = await lineSourceIds(row.id);
    expect(lines).toHaveLength(3);
    expect(lines.reduce((sum: number, l: any) => sum + Number(l.amount_cents), 0))
      .toBe(Number(row.total_cents));
    expect(Number(row.total_cents)).toBe(110_000);
  });
});

describe('a matter configured for split billing', () => {
  beforeEach(async () => {
    // 60/40 between the two clients. `isSplitConfigured` requires at least two
    // clients whose basis points sum to exactly 10000, so anything less leaves
    // the matter on the ordinary single-invoice path.
    await testPool.query(
      `insert into matter_clients (matter_id, client_id, law_firm_id, billing_portion_bp)
       values ($1, $2, $3, 4000)`,
      [matterA, clientB.id, firm.id],
    );
    const updated = await testPool.query(
      `update matter_clients set billing_portion_bp = 6000
        where matter_id = $1 and client_id = $2`,
      [matterA, clientA.id],
    );
    expect(updated.rowCount).toBe(1);
  });

  it('bills each payer their own invoice instead of the matter once', async () => {
    const res = await bulk({ contexts: [matterCtx(matterA)] });
    expect(res.status).toBe(201);

    const rows = (await invoiceRows()).filter((r: any) => r.matter_id === matterA);
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.client_id).sort()).toEqual([clientA.id, clientB.id].sort());
  });

  it('divides the matter $1,000 in the portions the matter carries', async () => {
    await bulk({ contexts: [matterCtx(matterA)] });

    const rows = (await invoiceRows()).filter((r: any) => r.matter_id === matterA);
    const byClient = new Map(rows.map((r: any) => [r.client_id, Number(r.total_cents)]));
    expect(byClient.get(clientA.id)).toBe(60_000);
    expect(byClient.get(clientB.id)).toBe(40_000);
    // Nothing invented and nothing lost: the shares must be the work, exactly.
    expect(Number(byClient.get(clientA.id)) + Number(byClient.get(clientB.id))).toBe(100_000);
  });

  it('gives each share its OWN number from the counter', async () => {
    await bulk({ contexts: [matterCtx(matterA)] });

    const rows = (await invoiceRows()).filter((r: any) => r.matter_id === matterA);
    const numbers = rows.map((r: any) => r.invoice_number).sort();
    // Both numbers must be issued values, not one allocation with a suffix
    // bolted on. A suffix the counter never handed out collides the moment the
    // counter reaches it.
    expect(numbers).toEqual(['INV-001', 'INV-002']);
    expect(await counterValue()).toBe(3);
  });

  it('links the shares under one split group', async () => {
    await bulk({ contexts: [matterCtx(matterA)] });

    const rows = (await invoiceRows()).filter((r: any) => r.matter_id === matterA);
    const groups = rows.map((r: any) => r.split_group_id);
    expect(groups[0]).toBeTruthy();
    expect(groups[1]).toBe(groups[0]);
  });

  it('places the one time entry on BOTH invoices as an allocated line', async () => {
    await bulk({ contexts: [matterCtx(matterA)] });

    const rows = (await invoiceRows()).filter((r: any) => r.matter_id === matterA);
    const [first, second] = await Promise.all(rows.map((r: any) => lineSourceIds(r.id)));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].source_id).toBe(second[0].source_id);
    expect(Number(first[0].amount_cents) + Number(second[0].amount_cents)).toBe(100_000);
  });

  it('still bills a NON-split context in the same run once', async () => {
    const res = await bulk({ contexts: [matterCtx(matterA), matterCtx(matterB)] });

    expect(res.status).toBe(201);
    expect((await invoiceRows()).filter((r: any) => r.matter_id === matterB)).toHaveLength(1);
    expect((await invoiceRows()).filter((r: any) => r.matter_id === matterA)).toHaveLength(2);
  });
});

describe('what the run will not do', () => {
  it('skips a matter the caller is not a member of, and writes nothing for it', async () => {
    const outsider = await memberWith(firm.id, ['billing.manageInvoices']);

    const res = await outsider.api.post(BULK()).send({
      invoiceDate: '2026-03-15',
      contexts: [matterCtx(matterA), matterCtx(matterB)],
    });

    expect(res.status).toBe(201);
    // Both matters are inaccessible to this caller, so both are skipped. The
    // write path has no owner or admin escape, which is why this is reported as
    // "nothing to bill" rather than an error.
    expect(res.body.created).toEqual([]);
    expect(res.body.skipped.sort()).toEqual([matterA, matterB].sort());
    expect(await invoiceRows()).toEqual([]);
    expect(await counterValue()).toBeNull();
  });

  it('refuses a member without billing.manageInvoices outright', async () => {
    const narrow = await memberWith(firm.id, ['billing.viewInvoices']);

    const res = await narrow.api.post(BULK()).send({
      invoiceDate: '2026-03-15',
      contexts: [matterCtx(matterA)],
    });

    expect(res.status).toBe(403);
    expect(await invoiceRows()).toEqual([]);
  });

  it('refuses an empty context list', async () => {
    const res = await bulk({ contexts: [] });

    expect(res.status).toBe(400);
    expect(await invoiceRows()).toEqual([]);
  });

  it('does not bill another firm matter', async () => {
    const otherFirm = await createFirm({ name: 'Other Firm' });
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/billing/invoices/bulk`)
      .send({ invoiceDate: '2026-03-15', contexts: [{ type: 'matter', entityId: matterA }] });

    expect(res.status).toBe(201);
    expect(res.body.created).toEqual([]);
    expect(await invoiceRows(otherFirm.id)).toEqual([]);
    // And the first firm's own work is untouched: nothing was billed under the
    // wrong tenant and then hidden by the list scoping.
    expect(await invoiceRows()).toEqual([]);
  });

  /**
   * M10: Failure during bulk/split invoice creation.
   *
   * When an error occurs on a specific context during bulk creation:
   * 1. Already created contexts remain committed.
   * 2. Failed contexts are captured in `errors` with exact accounting (`createdCount`, `errorCount`).
   * 3. Retrying the bulk operation skips already billed work and does not duplicate invoices.
   */
  it('partial failure accounting: commits successful matter, reports exact error for failed matter, and retry does not duplicate already committed invoice', async () => {
    const originalCreate = invoicesRepo.create.bind(invoicesRepo);
    const spy = jest.spyOn(invoicesRepo, 'create').mockImplementation(async (ctx: any, data: any) => {
      if (ctx.entityId === matterB) {
        throw new Error('database write failure on matter B');
      }
      return originalCreate(ctx, data);
    });

    try {
      const res = await bulk({ contexts: [matterCtx(matterA), matterCtx(matterB)] });

      expect(res.status).toBe(201);
      expect(res.body.requested).toBe(2);
      expect(res.body.created).toHaveLength(1);
      expect(res.body.failed).toEqual([matterB]);
      expect(res.body.skipped).toEqual([]);
      expect(res.body.errors[matterB]).toContain('database write failure on matter B');

      // Database verification: Matter A's invoice exists; Matter B was not committed
      const firstPassRows = await invoiceRows();
      expect(firstPassRows).toHaveLength(1);
      expect(firstPassRows[0].matter_id).toBe(matterA);

      // Matter A's line item is recorded; Matter B has no invoice lines yet
      const linesA = await lineSourceIds(firstPassRows[0].id);
      expect(linesA).toHaveLength(1);
      expect(Number(linesA[0].amount_cents)).toBe(100_000);

      // Restore the spy so Matter B can succeed on retry
      spy.mockRestore();

      // Retry the identical bulk request with both contexts
      const retryRes = await bulk({ contexts: [matterCtx(matterA), matterCtx(matterB)] });

      expect(retryRes.status).toBe(201);
      expect(retryRes.body.requested).toBe(2);
      expect(retryRes.body.created).toHaveLength(1);
      expect(retryRes.body.skipped).toEqual([matterA]);
      expect(retryRes.body.failed).toEqual([]);
      expect(retryRes.body.created[0].matterId).toBe(matterB);

      // Database verification: Matter A was NOT duplicated; Matter B now has its invoice
      const secondPassRows = await invoiceRows();
      expect(secondPassRows).toHaveLength(2);
      expect(secondPassRows.filter((r: any) => r.matter_id === matterA)).toHaveLength(1);
      const invoiceB = secondPassRows.find((r: any) => r.matter_id === matterB);
      expect(invoiceB).toBeDefined();

      const linesB = await lineSourceIds(invoiceB.id);
      expect(linesB).toHaveLength(1);
      expect(Number(linesB[0].amount_cents)).toBe(25_000);
    } finally {
      spy.mockRestore();
    }
  });
});

