/**
 * The firm billing list SQL pre-filter must never hide a row.
 *
 * `listFirmInvoices` / `listFirmTimeEntries` decide which rows survive by running
 * predicates over DERIVED records (effective total, remaining balance, derived
 * status, which clients an entry is billed to). Those predicates live in
 * `firmBillingWindow` and are unit-tested in firmBillingWindow.test.ts.
 *
 * To stop a narrowed list loading every invoice and every time entry in the firm,
 * the column-only part of each filter is ALSO pushed into the SQL read as a
 * pre-filter. That is only safe while the pre-filter is a superset of the derived
 * pass: it may return extra rows (the derived pass drops them), but if it ever
 * drops a row the derived pass would have kept, that row vanishes from the list
 * and from `totalItems` with nothing on screen to say so. The failure looks like a
 * money figure that is quietly too small, which is why it is pinned here.
 *
 * These tests exercise the two read functions against the real database and assert
 * the superset property directly:
 *
 *     { rows the pre-filtered read returns }  is a SUPERSET of
 *     { rows whose derived field satisfies the same filter }
 *
 * The derived fields the pre-filter mirrors are re-derived here from the SAME
 * repository output the service consumes (the grouping key plus the two fallback
 * columns), so the test pins the mapping the pre-filter relies on rather than
 * re-implementing the money model.
 *
 * A superset assertion over an empty set is true and proves nothing, so the seed
 * below is deliberately varied: per firm, several invoices and time entries
 * spread across two matters, two clients, two charge codes and two users, over a
 * range of dates, and including for every filter dimension at least one row that
 * the filter must EXCLUDE. `expectSuperset` refuses to run against an empty
 * expected set unless the case says the set is meant to be empty.
 *
 * The rows that matter most are the ones whose derived client link comes from a
 * FALLBACK column: a matter invoice carrying only `matter_client_id`, and a
 * client-context invoice carrying only `client_context_id`. Those are the rows a
 * pre-filter that checked a single client column would silently drop, and
 * `seedFirm` asserts they exist rather than hoping.
 *
 * A second firm is seeded with overlapping dates and its own rows. Nearly every
 * table is keyed by `(law_firm_id, id)` and the scoping is the application's job,
 * so a lost tenant predicate returns another firm's money looking entirely
 * normal on screen.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createFirmMember,
  createPersonClient,
  createOrgClient,
  type Firm,
} from '../support/setupInProcess';

const invoicesRepo = require('../../src/modules/billing/invoices/invoices.repository');
const billingReads = require('../../src/modules/billing/shared/billingReads');

/** The six days every firm's rows are spread over, oldest first. */
const DAYS = [
  '2026-01-10',
  '2026-02-15',
  '2026-03-20',
  '2026-04-05',
  '2026-05-12',
  '2026-06-30',
];

interface SeededFirm {
  firm: Firm;
  matterIds: [string, string];
  clientIds: [string, string];
  chargeCodeIds: [string, string];
  userIds: [string, string];
  /** Every invoice id seeded for this firm, in insertion order. */
  invoiceIds: string[];
  /** Every time entry id seeded for this firm, in insertion order. */
  entryIds: string[];
  /** The matter invoice whose only client link is `matter_client_id`. */
  matterClientOnlyInvoiceId: string;
  /** The client-context invoice with no `client_id` of its own. */
  contextOnlyInvoiceId: string;
  /** The matter invoice with no `invoice_date`, which no date bound may keep. */
  undatedInvoiceId: string;
}

async function insertMatter(lawFirmId: string, name: string): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1, $2, $3, $4, 'active')`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  return id;
}

async function insertChargeCode(lawFirmId: string, code: string): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into billing_codes (id, law_firm_id, kind, code, name)
     values ($1, $2, 'charge', $3, $4)`,
    [id, lawFirmId, code, `Charge code ${code}`],
  );
  return id;
}

/**
 * One invoice. The schema's XOR check accepts exactly one of `matter_id` and
 * `client_context_id`, which is what makes an invoice a matter invoice or a
 * client-context one. `client_id` and `matter_client_id` are separately the
 * billed client, and either may be null, which is the whole reason the client
 * pre-filter has to consider all three columns.
 */
async function insertInvoice(
  lawFirmId: string,
  row: {
    matterId?: string | null;
    clientContextId?: string | null;
    clientId?: string | null;
    matterClientId?: string | null;
    invoiceDate?: string | null;
    totalCents?: number;
  },
): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into invoices (id, law_firm_id, matter_id, client_context_id, client_id,
                           matter_client_id, context_type, invoice_number, status,
                           total_cents, invoice_date)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'outstanding', $9, $10)`,
    [
      id,
      lawFirmId,
      row.matterId ?? null,
      row.clientContextId ?? null,
      row.clientId ?? null,
      row.matterClientId ?? null,
      row.matterId ? 'matter' : 'client',
      `INV-${id.slice(0, 8)}`,
      row.totalCents ?? 125_000,
      row.invoiceDate ?? null,
    ],
  );
  return id;
}

/**
 * One time entry. `time_entries` carries the same XOR: an entry belongs either
 * to a matter or to a client, and that is exactly what the `context` selector
 * reads.
 */
async function insertTimeEntry(
  lawFirmId: string,
  row: {
    matterId?: string | null;
    clientId?: string | null;
    userId: string;
    chargeCodeId?: string | null;
    entryDate: string;
    hours?: number;
  },
): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into activities (kind, id, law_firm_id, matter_id, client_id, user_id,
                               billing_code_id, activity_date, hours, rate_cents,
                               description, billable)
     values ('time', $1, $2, $3, $4, $5, $6, $7, $8, 35000, 'Fixture work', true)`,
    [
      id,
      lawFirmId,
      row.matterId ?? null,
      row.clientId ?? null,
      row.userId,
      row.chargeCodeId ?? null,
      row.entryDate,
      row.hours ?? 1.5,
    ],
  );
  return id;
}

/**
 * A firm with enough variety that no assertion below can pass by accident.
 *
 * For each filter dimension the firm holds rows on both sides of it: two
 * matters, two clients, two charge codes plus entries carrying none, two users,
 * six distinct dates plus an undated invoice, and both billing contexts. A
 * filter that wrongly drops a row therefore has a row available to drop.
 */
async function seedFirm(label: string): Promise<SeededFirm> {
  const firm = await createFirm({ name: `${label} Firm` });

  const memberOne = await createFirmMember(firm.id, { name: `${label} One` });
  const memberTwo = await createFirmMember(firm.id, { name: `${label} Two` });
  const userIds: [string, string] = [memberOne.uid, memberTwo.uid];

  const matterIds: [string, string] = [
    await insertMatter(firm.id, `${label} Matter One`),
    await insertMatter(firm.id, `${label} Matter Two`),
  ];

  const person = await createPersonClient(firm.id, { name: `${label} Person` });
  const org = await createOrgClient(firm.id, { name: `${label} Organization` });
  const clientIds: [string, string] = [person.id, org.id];

  const chargeCodeIds: [string, string] = [
    await insertChargeCode(firm.id, `${label}-A`),
    await insertChargeCode(firm.id, `${label}-B`),
  ];

  // A matter invoice whose ONLY client link is matter_client_id. A client
  // pre-filter that read `client_id` alone would drop this one.
  const matterClientOnlyInvoiceId = await insertInvoice(firm.id, {
    matterId: matterIds[0],
    clientId: null,
    matterClientId: clientIds[1],
    invoiceDate: DAYS[1],
  });

  // A client-context invoice with no client_id of its own. A pre-filter that
  // read `client_id` or `matter_client_id` but not `client_context_id` would
  // drop this one.
  const contextOnlyInvoiceId = await insertInvoice(firm.id, {
    clientContextId: clientIds[1],
    clientId: null,
    invoiceDate: DAYS[4],
  });

  // No invoice_date at all. Every bounded range must exclude it, on both sides
  // of the assertion, which is what pins the "a null date never satisfies a
  // bound" rule the derived pass applies.
  const undatedInvoiceId = await insertInvoice(firm.id, {
    matterId: matterIds[1],
    clientId: clientIds[0],
    invoiceDate: null,
  });

  const invoiceIds = [
    await insertInvoice(firm.id, {
      matterId: matterIds[0], clientId: clientIds[0], invoiceDate: DAYS[0],
    }),
    matterClientOnlyInvoiceId,
    await insertInvoice(firm.id, {
      matterId: matterIds[1],
      clientId: clientIds[1],
      // Both columns populated and disagreeing, so the derived precedence
      // (client_id wins) is exercised rather than assumed.
      matterClientId: clientIds[0],
      invoiceDate: DAYS[2],
    }),
    await insertInvoice(firm.id, {
      clientContextId: clientIds[0], clientId: clientIds[0], invoiceDate: DAYS[3],
    }),
    contextOnlyInvoiceId,
    undatedInvoiceId,
    await insertInvoice(firm.id, {
      matterId: matterIds[0], clientId: clientIds[0], invoiceDate: DAYS[5],
    }),
  ];

  const entryIds = [
    await insertTimeEntry(firm.id, {
      matterId: matterIds[0], userId: userIds[0], chargeCodeId: chargeCodeIds[0], entryDate: DAYS[0],
    }),
    await insertTimeEntry(firm.id, {
      matterId: matterIds[0], userId: userIds[1], chargeCodeId: chargeCodeIds[1], entryDate: DAYS[1],
    }),
    // No charge code: the chargeCodeId case must still be a superset of the
    // coded rows while these exist to be dropped by it.
    await insertTimeEntry(firm.id, {
      matterId: matterIds[1], userId: userIds[0], chargeCodeId: null, entryDate: DAYS[2],
    }),
    await insertTimeEntry(firm.id, {
      matterId: matterIds[1], userId: userIds[1], chargeCodeId: chargeCodeIds[0], entryDate: DAYS[3],
    }),
    // Client-context entries under the SAME users and charge codes as the
    // matter ones, so a user or code filter that also required a matter would
    // have something to lose.
    await insertTimeEntry(firm.id, {
      clientId: clientIds[0], userId: userIds[0], chargeCodeId: chargeCodeIds[1], entryDate: DAYS[4],
    }),
    await insertTimeEntry(firm.id, {
      clientId: clientIds[1], userId: userIds[1], chargeCodeId: null, entryDate: DAYS[5],
    }),
    await insertTimeEntry(firm.id, {
      matterId: matterIds[0], userId: userIds[0], chargeCodeId: chargeCodeIds[0], entryDate: DAYS[5],
    }),
    await insertTimeEntry(firm.id, {
      clientId: clientIds[0], userId: userIds[0], chargeCodeId: chargeCodeIds[0], entryDate: DAYS[0],
    }),
  ];

  return {
    firm,
    matterIds,
    clientIds,
    chargeCodeIds,
    userIds,
    invoiceIds,
    entryIds,
    matterClientOnlyInvoiceId,
    contextOnlyInvoiceId,
    undatedInvoiceId,
  };
}

/**
 * Flatten `findForFirmByContext` into records carrying the three derived fields
 * the invoice pre-filter mirrors, exactly as `mapInvoiceRecord` computes them:
 * the matter is the byMatter grouping key, the billed-to client is the byClient
 * grouping key falling back to the invoice's own client columns, and the date is
 * the day-only `invoiceDate`.
 */
function deriveInvoiceKeys({ byMatter, byClient }: any) {
  const out = [];
  for (const [matterId, list] of byMatter) {
    for (const invoice of list) {
      out.push({
        id: invoice.id,
        matterId,
        clientId: invoice.clientId || invoice.matterClientId || null,
        invoiceDate: invoice.invoiceDate ? String(invoice.invoiceDate).slice(0, 10) : null,
      });
    }
  }
  for (const [clientId, list] of byClient) {
    for (const invoice of list) {
      out.push({
        id: invoice.id,
        matterId: null,
        clientId,
        invoiceDate: invoice.invoiceDate ? String(invoice.invoiceDate).slice(0, 10) : null,
      });
    }
  }
  return out;
}

function deriveEntryKeys({ byMatter, byClient }: any) {
  const out = [];
  for (const [matterId, list] of byMatter) {
    for (const entry of list) {
      out.push({ ...entry, context: 'matter', matterId, day: entry.date ? String(entry.date).slice(0, 10) : null });
    }
  }
  for (const list of byClient.values()) {
    for (const entry of list) {
      out.push({ ...entry, context: 'client', matterId: null, day: entry.date ? String(entry.date).slice(0, 10) : null });
    }
  }
  return out;
}

/**
 * The heart of every case: everything the caller's filter would keep out of the
 * FULL read must be present in the PRE-FILTERED read.
 *
 * `expectedKept` is required, not optional. A superset assertion over an empty
 * expected set is true no matter what the pre-filter does, so a case that seeded
 * nothing on the keeping side of its filter would report a green that proves
 * nothing. Stating the count up front makes the seed part of the assertion:
 * thinning the fixture turns the case red here rather than turning it silent.
 */
function expectSuperset({ full, prefiltered, keeps, label, expectedKept }: {
  full: any[];
  prefiltered: any[];
  keeps: (row: any) => boolean;
  label: string;
  expectedKept: number;
}) {
  const kept = full.filter(keeps);
  expect({ label, kept: kept.length }).toEqual({ label, kept: expectedKept });

  const returned = new Set(prefiltered.map((r: any) => r.id));
  const missing = kept.filter((r: any) => !returned.has(r.id)).map((r: any) => r.id);
  expect({ label, missing }).toEqual({ label, missing: [] });
}

let fixture: SeededFirm;
let other: SeededFirm;
let fullInvoices: any[];
let fullEntries: any[];

beforeEach(async () => {
  fixture = await seedFirm('Fixture');
  other = await seedFirm('Other');

  fullInvoices = deriveInvoiceKeys(await invoicesRepo.findForFirmByContext(fixture.firm.id));
  fullEntries = deriveEntryKeys(await billingReads.listTimeEntriesForFirm(fixture.firm.id));
}, 120000);

describe('invoice list SQL pre-filter', () => {
  test('the fixture firm has invoices, so the assertions below are not vacuous', () => {
    expect(fullInvoices.length).toBe(fixture.invoiceIds.length);
    expect(fullInvoices.map((r) => r.id).sort()).toEqual([...fixture.invoiceIds].sort());

    // The variety each case below leans on. Without these the filters would run
    // against a world that cannot distinguish a correct pre-filter from one that
    // drops rows.
    expect(new Set(fullInvoices.map((r) => r.matterId).filter(Boolean)).size).toBe(2);
    expect(new Set(fullInvoices.map((r) => r.clientId).filter(Boolean)).size).toBe(2);
    expect(new Set(fullInvoices.map((r) => r.invoiceDate).filter(Boolean)).size).toBe(DAYS.length);
    expect(fullInvoices.filter((r) => !r.invoiceDate).length).toBe(1);

    // The two rows whose derived client comes from a fallback column. These are
    // the rows a single-column client pre-filter would lose.
    const fallbackOnly = fullInvoices.find((r) => r.id === fixture.matterClientOnlyInvoiceId);
    expect(fallbackOnly).toMatchObject({ matterId: fixture.matterIds[0], clientId: fixture.clientIds[1] });
    const contextOnly = fullInvoices.find((r) => r.id === fixture.contextOnlyInvoiceId);
    expect(contextOnly).toMatchObject({ matterId: null, clientId: fixture.clientIds[1] });
  });

  test('no pre-filter returns every invoice', async () => {
    const rows = deriveInvoiceKeys(await invoicesRepo.findForFirmByContext(fixture.firm.id, {}));
    expect(rows.map((r) => r.id).sort()).toEqual(fullInvoices.map((r: any) => r.id).sort());
  }, 60000);

  test('matterId keeps every invoice on that matter', async () => {
    // Every matter that actually has invoices, so the case covers real ids rather
    // than one arbitrarily chosen one.
    const matterIds = [...new Set(fullInvoices.map((r: any) => r.matterId).filter(Boolean))];
    expect(matterIds.length).toBe(2);

    for (const matterId of matterIds) {
      const keeps = (r: any) => (r.matterId || '') === matterId;
      // eslint-disable-next-line no-await-in-loop
      const rows = deriveInvoiceKeys(await invoicesRepo.findForFirmByContext(fixture.firm.id, { matterId }));
      expectSuperset({
        full: fullInvoices,
        prefiltered: rows,
        keeps,
        label: `matterId=${matterId}`,
        expectedKept: fullInvoices.filter(keeps).length,
      });
      // The narrowing is real, not a pass-through that would make the superset
      // property trivially true.
      expect(rows.length).toBeLessThan(fullInvoices.length);
    }
  }, 120000);

  test('clientId keeps every invoice billed to that client', async () => {
    const clientIds = [...new Set(fullInvoices.map((r: any) => r.clientId).filter(Boolean))];
    expect(clientIds.length).toBe(2);

    for (const clientId of clientIds) {
      const keeps = (r: any) => (r.clientId || '') === clientId;
      // eslint-disable-next-line no-await-in-loop
      const rows = deriveInvoiceKeys(await invoicesRepo.findForFirmByContext(fixture.firm.id, { clientId }));
      expectSuperset({
        full: fullInvoices,
        prefiltered: rows,
        keeps,
        label: `clientId=${clientId}`,
        expectedKept: fullInvoices.filter(keeps).length,
      });
      expect(rows.length).toBeLessThan(fullInvoices.length);
    }
  }, 120000);

  test('a client filter keeps the invoices linked only through a fallback column', async () => {
    // Stated separately from the loop above because these two rows are the whole
    // reason the pre-filter checks three columns rather than one. The loop would
    // still go red without them, but not say why.
    const rows = deriveInvoiceKeys(
      await invoicesRepo.findForFirmByContext(fixture.firm.id, { clientId: fixture.clientIds[1] }),
    );
    const returned = rows.map((r) => r.id);
    expect(returned).toContain(fixture.matterClientOnlyInvoiceId);
    expect(returned).toContain(fixture.contextOnlyInvoiceId);
  }, 60000);

  test('a date range keeps every invoice dated inside it', async () => {
    const days = fullInvoices.map((r: any) => r.invoiceDate).filter(Boolean).sort();
    expect(days.length).toBe(DAYS.length);

    // Both open-ended bounds and a closed range that splits the real data. The
    // bounds are real invoice dates on purpose: an inclusive comparison turned
    // exclusive drops exactly the row sitting on the boundary.
    const mid = days[Math.floor(days.length / 2)];
    const ranges: { dateFrom?: string; dateTo?: string }[] = [
      { dateFrom: days[0] },
      { dateTo: days[days.length - 1] },
      { dateFrom: days[0], dateTo: mid },
      { dateFrom: mid, dateTo: days[days.length - 1] },
      { dateFrom: '1990-01-01', dateTo: '1990-12-31' },
    ];

    for (const range of ranges) {
      // Mirrors firmBillingWindow: a null invoice date never satisfies a bound.
      const keeps = (r: any) => Boolean(r.invoiceDate)
        && (!range.dateFrom || r.invoiceDate >= range.dateFrom)
        && (!range.dateTo || r.invoiceDate <= range.dateTo);
      const expectedKept = fullInvoices.filter(keeps).length;
      // Only the 1990 window is allowed to keep nothing, and it is here to prove
      // the read narrows at all rather than ignoring the bounds.
      if (range.dateFrom === '1990-01-01') expect(expectedKept).toBe(0);
      else expect(expectedKept).toBeGreaterThan(0);

      // eslint-disable-next-line no-await-in-loop
      const rows = deriveInvoiceKeys(await invoicesRepo.findForFirmByContext(fixture.firm.id, range));
      expectSuperset({
        full: fullInvoices,
        prefiltered: rows,
        keeps,
        label: JSON.stringify(range),
        expectedKept,
      });
      // The undated invoice can never satisfy a bound, so a bounded read that
      // returned it would mean the SQL was ignoring the bound entirely.
      expect(rows.map((r) => r.id)).not.toContain(fixture.undatedInvoiceId);
    }
  }, 120000);

  test('combining matterId with a date range keeps everything satisfying both', async () => {
    const matterId = fixture.matterIds[0];
    const filter = { matterId, dateFrom: DAYS[0], dateTo: DAYS[DAYS.length - 1] };
    const keeps = (r: any) => (r.matterId || '') === matterId && Boolean(r.invoiceDate);

    const rows = deriveInvoiceKeys(await invoicesRepo.findForFirmByContext(fixture.firm.id, filter));
    expectSuperset({
      full: fullInvoices,
      prefiltered: rows,
      keeps,
      label: JSON.stringify(filter),
      expectedKept: 3,
    });
    expect(rows.length).toBeLessThan(fullInvoices.length);
  }, 60000);

  test('an unparseable matter id does not silently empty the list', async () => {
    // A non-uuid can reach the read from a hand-edited query string. It must not
    // become `matter_id = 'garbage'`, which would error, nor quietly match nothing
    // in a way the derived pass could not correct.
    const rows = deriveInvoiceKeys(
      await invoicesRepo.findForFirmByContext(fixture.firm.id, { matterId: 'not-a-uuid' }),
    );
    expect(rows.length).toBe(fullInvoices.length);
  }, 60000);

  test('no read returns another firm invoice', async () => {
    expect(other.invoiceIds.length).toBeGreaterThan(0);
    const foreign = new Set(other.invoiceIds);

    // The unfiltered read and a read whose only predicate is a date range that
    // spans both firms' rows. The date range carries nothing that could
    // distinguish the firms, so a lost `law_firm_id` predicate shows up here.
    const reads = await Promise.all([
      invoicesRepo.findForFirmByContext(fixture.firm.id),
      invoicesRepo.findForFirmByContext(fixture.firm.id, {
        dateFrom: DAYS[0], dateTo: DAYS[DAYS.length - 1],
      }),
      invoicesRepo.findForFirmByContext(fixture.firm.id, { clientId: other.clientIds[0] }),
    ]);

    for (const read of reads) {
      const leaked = deriveInvoiceKeys(read).map((r) => r.id).filter((id) => foreign.has(id));
      expect(leaked).toEqual([]);
    }
  }, 60000);
});

describe('time entry list SQL pre-filter', () => {
  test('the fixture firm has time entries, so the assertions below are not vacuous', () => {
    expect(fullEntries.length).toBe(fixture.entryIds.length);
    expect(fullEntries.map((r) => r.id).sort()).toEqual([...fixture.entryIds].sort());

    expect(new Set(fullEntries.map((r) => r.matterId).filter(Boolean)).size).toBe(2);
    expect(new Set(fullEntries.map((r) => r.userId).filter(Boolean)).size).toBe(2);
    expect(new Set(fullEntries.map((r) => r.chargeCodeId).filter(Boolean)).size).toBe(2);
    // Entries carrying no charge code, which every chargeCodeId case must drop.
    expect(fullEntries.filter((r) => !r.chargeCodeId).length).toBe(2);
    expect(fullEntries.filter((r) => r.context === 'matter').length).toBe(5);
    expect(fullEntries.filter((r) => r.context === 'client').length).toBe(3);
    expect(new Set(fullEntries.map((r) => r.day)).size).toBe(DAYS.length);
  });

  test('no pre-filter returns every entry', async () => {
    const rows = deriveEntryKeys(await billingReads.listTimeEntriesForFirm(fixture.firm.id, {}));
    expect(rows.map((r) => r.id).sort()).toEqual(fullEntries.map((r: any) => r.id).sort());
  }, 60000);

  test('matterId keeps every entry on that matter', async () => {
    const matterIds = [...new Set(fullEntries.map((r: any) => r.matterId).filter(Boolean))];
    expect(matterIds.length).toBe(2);

    for (const matterId of matterIds) {
      const keeps = (r: any) => (r.matterId || '') === matterId;
      // eslint-disable-next-line no-await-in-loop
      const rows = deriveEntryKeys(await billingReads.listTimeEntriesForFirm(fixture.firm.id, { matterId }));
      expectSuperset({
        full: fullEntries,
        prefiltered: rows,
        keeps,
        label: `matterId=${matterId}`,
        expectedKept: fullEntries.filter(keeps).length,
      });
      expect(rows.length).toBeLessThan(fullEntries.length);
    }
  }, 120000);

  test('userId keeps every entry logged by that user', async () => {
    const userIds = [...new Set(fullEntries.map((r: any) => r.userId).filter(Boolean))];
    expect(userIds.length).toBe(2);

    for (const userId of userIds) {
      const keeps = (r: any) => (r.userId || '') === userId;
      // eslint-disable-next-line no-await-in-loop
      const rows = deriveEntryKeys(await billingReads.listTimeEntriesForFirm(fixture.firm.id, { userId }));
      expectSuperset({
        full: fullEntries,
        prefiltered: rows,
        keeps,
        label: `userId=${userId}`,
        expectedKept: fullEntries.filter(keeps).length,
      });
      // Each user has work in BOTH contexts, so a userId pre-filter that also
      // required a matter would lose the client-context half.
      expect(new Set(rows.map((r) => r.context))).toEqual(new Set(['matter', 'client']));
      expect(rows.length).toBeLessThan(fullEntries.length);
    }
  }, 120000);

  test('chargeCodeId keeps every entry carrying that code', async () => {
    const codeIds = [...new Set(fullEntries.map((r: any) => r.chargeCodeId).filter(Boolean))];
    expect(codeIds.length).toBe(2);

    for (const chargeCodeId of codeIds) {
      const keeps = (r: any) => (r.chargeCodeId || '') === chargeCodeId;
      // eslint-disable-next-line no-await-in-loop
      const rows = deriveEntryKeys(await billingReads.listTimeEntriesForFirm(fixture.firm.id, { chargeCodeId }));
      expectSuperset({
        full: fullEntries,
        prefiltered: rows,
        keeps,
        label: `chargeCodeId=${chargeCodeId}`,
        expectedKept: fullEntries.filter(keeps).length,
      });
      expect(rows.length).toBeLessThan(fullEntries.length);
    }
  }, 120000);

  test('context selects entries by whether they carry a matter', async () => {
    for (const context of ['matter', 'client']) {
      const keeps = (r: any) => r.context === context;
      // eslint-disable-next-line no-await-in-loop
      const rows = deriveEntryKeys(await billingReads.listTimeEntriesForFirm(fixture.firm.id, { context }));
      expectSuperset({
        full: fullEntries,
        prefiltered: rows,
        keeps,
        label: `context=${context}`,
        expectedKept: context === 'matter' ? 5 : 3,
      });
      // Also assert the narrowing is real, not a pass-through.
      expect(rows.every((r) => r.context === context)).toBe(true);
    }
  }, 120000);

  test('a date range keeps every entry dated inside it', async () => {
    const days = fullEntries.map((r: any) => r.day).filter(Boolean).sort();
    expect(days.length).toBe(fixture.entryIds.length);
    const mid = days[Math.floor(days.length / 2)];
    const ranges: { dateFrom?: string; dateTo?: string }[] = [
      { dateFrom: days[0] },
      { dateTo: days[days.length - 1] },
      { dateFrom: days[0], dateTo: mid },
      { dateFrom: mid, dateTo: days[days.length - 1] },
      { dateFrom: '1990-01-01', dateTo: '1990-12-31' },
    ];

    for (const range of ranges) {
      const keeps = (r: any) => Boolean(r.day)
        && (!range.dateFrom || r.day >= range.dateFrom)
        && (!range.dateTo || r.day <= range.dateTo);
      const expectedKept = fullEntries.filter(keeps).length;
      if (range.dateFrom === '1990-01-01') expect(expectedKept).toBe(0);
      else expect(expectedKept).toBeGreaterThan(0);

      // eslint-disable-next-line no-await-in-loop
      const rows = deriveEntryKeys(await billingReads.listTimeEntriesForFirm(fixture.firm.id, range));
      expectSuperset({
        full: fullEntries,
        prefiltered: rows,
        keeps,
        label: JSON.stringify(range),
        expectedKept,
      });
    }
  }, 120000);

  test('combining a user, a matter and a date range keeps everything satisfying all three', async () => {
    const sample = fullEntries.find((r: any) => r.matterId && r.userId && r.day);
    expect(sample).toBeTruthy();
    const filter = {
      matterId: sample.matterId,
      userId: sample.userId,
      dateFrom: DAYS[0],
      dateTo: DAYS[DAYS.length - 1],
    };
    const keeps = (r: any) => r.matterId === sample.matterId && r.userId === sample.userId && Boolean(r.day);

    const rows = deriveEntryKeys(await billingReads.listTimeEntriesForFirm(fixture.firm.id, filter));
    expectSuperset({
      full: fullEntries,
      prefiltered: rows,
      keeps,
      label: JSON.stringify(filter),
      expectedKept: fullEntries.filter(keeps).length,
    });
    expect(rows.some((r) => r.id === sample.id)).toBe(true);
    expect(rows.length).toBeLessThan(fullEntries.length);
  }, 60000);

  test('an unparseable matter id does not silently empty the list', async () => {
    const rows = deriveEntryKeys(
      await billingReads.listTimeEntriesForFirm(fixture.firm.id, { matterId: 'not-a-uuid' }),
    );
    expect(rows.length).toBe(fullEntries.length);
  }, 60000);

  test('no read returns another firm time entry', async () => {
    expect(other.entryIds.length).toBeGreaterThan(0);
    const foreign = new Set(other.entryIds);

    const reads = await Promise.all([
      billingReads.listTimeEntriesForFirm(fixture.firm.id),
      billingReads.listTimeEntriesForFirm(fixture.firm.id, {
        dateFrom: DAYS[0], dateTo: DAYS[DAYS.length - 1],
      }),
      billingReads.listTimeEntriesForFirm(fixture.firm.id, { userId: other.userIds[0] }),
      billingReads.listTimeEntriesForFirm(fixture.firm.id, { context: 'matter' }),
    ]);

    for (const read of reads) {
      const leaked = deriveEntryKeys(read).map((r) => r.id).filter((id) => foreign.has(id));
      expect(leaked).toEqual([]);
    }
  }, 60000);
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
