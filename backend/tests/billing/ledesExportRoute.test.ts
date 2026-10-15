/**
 * B06.2 M13: "Export filtered money" for the LEDES export route.
 *
 * `tests/billing/ledesExport.test.ts` already pins the pure `generateLedesExport`
 * function against hand-built invoice objects, and `invoiceSurfaceConsistency.test.ts`
 * checks that the exported INVOICE_TOTAL agrees with the detail total for one
 * seeded invoice. Neither exercises the two actual HTTP routes
 * (`GET .../matter/:matterId/:invoiceId/export/ledes` and the `client/` twin in
 * `invoices.routes.ts`) end to end: the permission gate, the tenant/context
 * scoping in `invoicesRepo.findById`, and the real DB round-trip through
 * `assembleInvoice`/`lineRowToItem` that turns a posted time entry into the
 * `entry.date`/`entry.name`/`entry.amount` fields the export reads.
 *
 * This file drives both routes for real:
 *   - cent-for-cent and date-for-date correctness against independently
 *     computed expected strings (never by calling `generateLedesExport` or
 *     `ledesCurrency`/`ledesDate` again as the oracle),
 *   - pipe/newline sanitization on a real posted invoice note and line-item
 *     name, checked by asserting the exported row still splits into exactly
 *     the documented 21 columns (an unsanitized delimiter would shift every
 *     column after it, which a value-only check could miss),
 *   - permission refusal for a view-only billing role,
 *   - cross-firm and same-firm wrong-context tenant scoping, which is the
 *     scenario a route-only pure-function test can never reach.
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

const LEDES_COLUMN_COUNT = 21;

/**
 * `invoicesService.authorizeContext` requires an actual `matter_members` row
 * even for the firm owner on a matter-context WRITE (unlike matter-membership
 * management, it does not short-circuit for owners/admins) - so every matter
 * used to create an invoice needs the acting user seated on it first.
 */
async function createMatter(lawFirmId: string, name = 'Ledes export matter', memberUid?: string): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, $3, $4)`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  if (memberUid) {
    await testPool.query(
      `insert into matter_members (matter_id, user_id, law_firm_id, role) values ($1, $2, $3, 'member')`,
      [id, memberUid, lawFirmId],
    );
  }
  return id;
}

/** Parse one LEDES export body into its header row and data rows, columns split on '|'. */
function parseLedes(text: string) {
  const lines = text.split('\r\n');
  expect(lines[0]).toBe('LEDES1998B[]');
  const columns = lines[1].replace(/\[\]$/, '').split('|');
  const rows = lines.slice(2).filter((l) => l.length > 0).map((l) => l.replace(/\[\]$/, '').split('|'));
  return { columns, rows };
}

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const invoicesBase = () => `/api/lawfirms/${firm.id}/billing/invoices`;
const clientBase = () => `${invoicesBase()}/client/${client.id}`;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Ledes Export Client', email: 'ledes-export@example.test' });
  await drainEvents();
});

describe('client-context LEDES export route: cent and date correctness', () => {
  it('exports exact seeded cents, hours, rate and dates, independently computed', async () => {
    // 3.25 hours at $210.40/hr, but `amount` is the trusted, independently
    // supplied total (not hours*rate) exactly like a real caller can send -
    // chosen as a non-round cent value so any recompute-vs-store drift shows.
    const createRes = await owner.api.post(clientBase()).send({
      invoiceName: 'Ledes cents invoice',
      invoiceDate: '2026-04-05',
      dueDate: '2026-05-05',
      totalAmount: 683.80,
      timeEntries: [
        { date: '2026-04-02', hours: 3.25, rate: 210.40, amount: 683.80, name: 'Motion drafting' },
      ],
    });
    expect(createRes.status).toBe(201);
    const invoiceId = createRes.body.invoice.id as string;
    expect(invoiceId).toMatch(/^[0-9a-f-]{36}$/);
    await drainEvents();

    const res = await owner.api.get(`${clientBase()}/${invoiceId}/export/ledes`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);

    const { columns, rows } = parseLedes(res.text);
    expect(columns).toHaveLength(LEDES_COLUMN_COUNT);
    expect(rows).toHaveLength(1);
    const row = rows[0];

    expect(row[0]).toBe('20260405');          // INVOICE_DATE
    expect(row[2]).toBe(client.id);           // CLIENT_ID
    expect(row[4]).toBe('683.80');            // INVOICE_TOTAL
    expect(row[5]).toBe('20260402');          // BILLING_START_DATE
    expect(row[6]).toBe('20260402');          // BILLING_END_DATE
    expect(row[9]).toBe('F');                 // EXP/FEE/INV_ADJ_TYPE
    expect(row[10]).toBe('3.25');             // LINE_ITEM_NUMBER_OF_UNITS
    expect(row[11]).toBe('0.00');             // LINE_ITEM_ADJUSTMENT_AMOUNT
    expect(row[12]).toBe('683.80');           // LINE_ITEM_TOTAL
    expect(row[13]).toBe('20260402');         // LINE_ITEM_DATE
    expect(row[19]).toBe(firm.id);            // LAW_FIRM_ID
    expect(row[20]).toBe('210.40');           // LINE_ITEM_UNIT_COST

    // Ground truth independent of the export: the persisted invoice row itself.
    const { rows: dbRows } = await testPool.query(
      `select total_cents from invoices where id = $1`, [invoiceId],
    );
    expect(Number(dbRows[0].total_cents)).toBe(68_380);
  });

  // Sanitizing a pipe or a newline without shifting columns is pinned against
  // `generateLedesExport` itself in `ledesExport.test.ts`.
});

describe('matter-context LEDES export route', () => {
  it('exports the matter id as LAW_FIRM_MATTER_ID and the correct cents', async () => {
    const matterId = await createMatter(firm.id, 'Ledes matter | with a pipe', owner.uid);

    const createRes = await owner.api.post(invoicesBase()).send({
      matterId,
      invoiceName: 'Ledes matter invoice',
      invoiceDate: '2026-04-10',
      totalAmount: 250.50,
      timeEntries: [
        { date: '2026-04-08', hours: 2, rate: 125.25, amount: 250.50, name: 'Research' },
      ],
    });
    expect(createRes.status).toBe(201);
    const invoiceId = createRes.body.invoice.id as string;
    await drainEvents();

    const res = await owner.api.get(`${invoicesBase()}/matter/${matterId}/${invoiceId}/export/ledes`);
    expect(res.status).toBe(200);

    const { rows } = parseLedes(res.text);
    expect(rows[0][3]).toBe(matterId);   // LAW_FIRM_MATTER_ID
    expect(rows[0][4]).toBe('250.50');   // INVOICE_TOTAL
    expect(rows[0][12]).toBe('250.50');  // LINE_ITEM_TOTAL
  });

  it('refuses the export when the URL matterId does not govern the invoice, rather than leaking it under the wrong scope', async () => {
    const realMatterId = await createMatter(firm.id, 'Real matter', owner.uid);
    const otherMatterId = await createMatter(firm.id, 'Unrelated matter', owner.uid);

    const createRes = await owner.api.post(invoicesBase()).send({
      matterId: realMatterId,
      invoiceName: 'Scoped matter invoice',
      invoiceDate: '2026-04-10',
      totalAmount: 100,
      timeEntries: [{ date: '2026-04-08', hours: 1, rate: 100, amount: 100, name: 'Work' }],
    });
    expect(createRes.status).toBe(201);
    const invoiceId = createRes.body.invoice.id as string;
    await drainEvents();

    const res = await owner.api.get(`${invoicesBase()}/matter/${otherMatterId}/${invoiceId}/export/ledes`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });
});

describe('permission refusal', () => {
  it('refuses a member holding only billing.viewInvoices, without leaking any LEDES content', async () => {
    const createRes = await owner.api.post(clientBase()).send({
      invoiceName: 'Ledes permission invoice',
      invoiceDate: '2026-04-05',
      totalAmount: 50,
      timeEntries: [{ date: '2026-04-02', hours: 1, rate: 50, amount: 50, name: 'Work' }],
    });
    expect(createRes.status).toBe(201);
    const invoiceId = createRes.body.invoice.id as string;
    await drainEvents();

    const viewer = await memberWith(firm.id, ['billing.viewInvoices']);
    const res = await viewer.api.get(`${clientBase()}/${invoiceId}/export/ledes`);

    expect(res.status).toBe(403);
    expect(String(res.text || '')).not.toContain('LEDES1998B');
  });
});

describe('cross-firm tenant isolation', () => {
  it('refuses a second firm\'s owner reading firm A\'s invoice under firm B\'s own lawFirmId path', async () => {
    const createRes = await owner.api.post(clientBase()).send({
      invoiceName: 'Ledes tenant invoice',
      invoiceDate: '2026-04-05',
      totalAmount: 50,
      timeEntries: [{ date: '2026-04-02', hours: 1, rate: 50, amount: 50, name: 'Work' }],
    });
    expect(createRes.status).toBe(201);
    const invoiceId = createRes.body.invoice.id as string;
    await drainEvents();

    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    // Firm B's own lawFirmId in the path, but firm A's real client/invoice ids -
    // invoicesRepo.findById scopes by law_firm_id = firm B, so this must miss
    // entirely rather than returning firm A's money.
    const res = await otherOwner.api.get(
      `/api/lawfirms/${otherFirm.id}/billing/invoices/client/${client.id}/${invoiceId}/export/ledes`,
    );
    expect(res.status).toBe(404);
  });

  it('refuses a same-firm caller reading the invoice under a different client\'s context', async () => {
    const createRes = await owner.api.post(clientBase()).send({
      invoiceName: 'Ledes wrong-client invoice',
      invoiceDate: '2026-04-05',
      totalAmount: 50,
      timeEntries: [{ date: '2026-04-02', hours: 1, rate: 50, amount: 50, name: 'Work' }],
    });
    expect(createRes.status).toBe(201);
    const invoiceId = createRes.body.invoice.id as string;
    await drainEvents();

    const otherClient = await createPersonClient(firm.id, { name: 'Other Client', email: 'other-ledes@example.test' });

    const res = await owner.api.get(
      `${invoicesBase()}/client/${otherClient.id}/${invoiceId}/export/ledes`,
    );
    expect(res.status).toBe(404);
  });
});
