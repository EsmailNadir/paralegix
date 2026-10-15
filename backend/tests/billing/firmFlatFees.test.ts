/**
 * The firm-wide flat-fee read: `GET /billing/flat-fees/firm`.
 *
 * Flat fees could only be read one context at a time, so two screens looped a
 * request per matter. A client with eighty matters fired eighty requests, each
 * taking one of the twelve connections the whole instance shares. This route
 * answers the same question once.
 *
 * Four properties carry the weight here, and each has a case below that goes red
 * when it breaks.
 *
 *   THE ETHICAL WALL SURVIVES THE AGGREGATION. The per-matter route refuses a
 *   member who is not on the matter. A firm-wide read that forgets this hands
 *   that member every matter's fees in one response, and nothing on screen looks
 *   wrong. `listAccessibleMatters` is the same helper the other firm-wide
 *   billing reads use, so the rule is reused rather than restated.
 *
 *   THE ROWS ARE THE SAME ROWS. If the firm read and the per-matter read
 *   disagree about a fee's amount, date or `isBilled`, one of the two screens
 *   showing them is lying about money. The pinning case asserts deep equality
 *   against the per-matter and per-client routes rather than re-deriving what
 *   the fields ought to be.
 *
 *   THE WINDOW IS BOUNDED. `limit` above the ceiling is refused, and no `limit`
 *   at all is served at the ceiling with `truncated` set, so a firm that
 *   outgrows one page finds out instead of quietly losing rows.
 *
 *   THE COST DOES NOT GROW WITH THE FILTER. The point of the route is that one
 *   request replaces N. Answering it with one query per matter id would move the
 *   N from the network to the pool and change nothing. The connection case
 *   measures the app pool's own `acquire` events, so it counts real checkouts.
 */
import { randomUUID } from 'crypto';

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

// Loaded after the harness, which points DATABASE_URL at this worker's test
// database: `db.ts` reads the URL when it is first imported.
const { pool } = require('../../src/shared/database/db');

/** Mirrors MAX_PAGE_SIZE in `shared/firmBillingWindow.ts`. */
const MAX_PAGE_SIZE = 200;

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const base = () => `/api/lawfirms/${firm.id}/billing/flat-fees`;
const firmPath = () => `${base()}/firm`;

/** A matter, with the given uids on it as members. */
async function seedMatter(uids: string[] = [], name = 'Firm Flat Fee Matter') {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1, $2, $3, $4, 'active')`,
    [id, firm.id, name, `REF-${id.slice(0, 8)}`],
  );
  for (const uid of uids) {
    await testPool.query(
      `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at)
       values ($1, $2, $3, 'lead', now())`,
      [firm.id, id, uid],
    );
  }
  return id;
}

/**
 * A flat fee, written straight to `activities` so a case can seed one on a
 * matter the acting caller is deliberately NOT on.
 */
async function seedFee(
  context: { matterId?: string; clientId?: string },
  overrides: { cents?: number; date?: string | null; description?: string } = {},
) {
  const id = randomUUID();
  await testPool.query(
    `insert into activities (id, kind, law_firm_id, matter_id, client_id, description,
                             charge_cents, activity_date, created_by)
     values ($1, 'flat_fee', $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      firm.id,
      context.matterId ?? null,
      context.clientId ?? null,
      overrides.description ?? 'Fixed-fee engagement',
      overrides.cents ?? 150_050,
      overrides.date === undefined ? '2026-05-19' : overrides.date,
      owner.uid,
    ],
  );
  return id;
}

/**
 * Put a fee onto an invoice as a LINE ITEM, which is the only thing that makes
 * it billed. The source tables' own `billed` columns are never maintained, so a
 * fixture that set one would produce a fee every reader still calls unbilled.
 */
async function billOntoInvoice(feeId: string, amountCents: number) {
  const invoice = await createInvoice(firm.id, client.id, { totalCents: amountCents });
  await testPool.query(
    `insert into invoice_line_items
       (invoice_id, law_firm_id, kind, source_id, quantity, rate_cents, amount_cents)
     values ($1, $2, 'flat_fee', $3, 1, $4, $4)`,
    [invoice.id, firm.id, feeId, amountCents],
  );
  return invoice;
}

/** Bill a MATTER fee: the invoice has to sit on that matter for it to count. */
async function billMatterFeeOntoInvoice(feeId: string, matterId: string, amountCents: number) {
  const invoiceId = randomUUID();
  await testPool.query(
    `insert into invoices (id, law_firm_id, matter_id, context_type, invoice_number,
                           status, total_cents, invoice_date, due_date)
     values ($1, $2, $3, 'matter', $4, 'outstanding', $5, current_date, current_date + 30)`,
    [invoiceId, firm.id, matterId, `INV-${invoiceId.slice(0, 8)}`, amountCents],
  );
  await testPool.query(
    `insert into invoice_line_items
       (invoice_id, law_firm_id, kind, source_id, quantity, rate_cents, amount_cents)
     values ($1, $2, 'flat_fee', $3, 1, $4, $4)`,
    [invoiceId, firm.id, feeId, amountCents],
  );
  return invoiceId;
}

const idsOf = (res: any) => (res.body.flatFees || []).map((fee: any) => fee.id).sort();

/**
 * Count every checkout the app pool makes while `work` runs. Each `pool.query`
 * acquires a client and releases it, so the acquire count is the query count.
 */
async function poolCheckoutsDuring(work: () => Promise<unknown>) {
  let acquires = 0;
  let active = 0;
  let peak = 0;
  const onAcquire = () => { acquires += 1; active += 1; peak = Math.max(peak, active); };
  const onRelease = () => { active -= 1; };
  pool.on('acquire', onAcquire);
  pool.on('release', onRelease);
  try {
    const result = await work();
    return { result, acquires, peak };
  } finally {
    pool.off('acquire', onAcquire);
    pool.off('release', onRelease);
  }
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id);
  await drainEvents();
});

describe('GET /billing/flat-fees/firm - tenant and matter scope', () => {
  it("refuses another firm's owner and returns none of this firm's fees", async () => {
    const matterId = await seedMatter([owner.uid]);
    const feeId = await seedFee({ matterId });

    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api.get(firmPath());

    expect(res.status).toBe(403);
    expect(res.body.flatFees).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(feeId);
  });

  it('hides the fees of a matter the member is walled off from, and shows the rest', async () => {
    const member = await memberWith(firm.id, ['billing.viewInvoices']);
    const onMatter = await seedMatter([owner.uid, member.uid], 'Staffed');
    const offMatter = await seedMatter([owner.uid], 'Walled off');

    const visibleFee = await seedFee({ matterId: onMatter });
    const hiddenFee = await seedFee({ matterId: offMatter });
    const clientFee = await seedFee({ clientId: client.id });

    const res = await member.api.get(firmPath());

    expect(res.status).toBe(200);
    // The client fee is deliberately included: the per-client route gates on firm
    // membership alone, so widening it here would be a privilege change.
    expect(idsOf(res)).toEqual([visibleFee, clientFee].sort());
    expect(res.body.totalItems).toBe(2);
    expect(JSON.stringify(res.body)).not.toContain(hiddenFee);
  });

  it('shows an owner every matter, including the ones they are not staffed on', async () => {
    const unstaffed = await seedMatter([], 'Nobody on it');
    const feeId = await seedFee({ matterId: unstaffed });

    const res = await owner.api.get(firmPath());

    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([feeId]);
  });

  it('returns nothing for a matter id belonging to another firm', async () => {
    const otherFirm = await createFirm();
    const otherMatterId = randomUUID();
    await testPool.query(
      `insert into matters (id, law_firm_id, name, matter_reference_id, status)
       values ($1, $2, 'Other firm matter', $3, 'active')`,
      [otherMatterId, otherFirm.id, `REF-${otherMatterId.slice(0, 8)}`],
    );

    const res = await owner.api.get(`${firmPath()}?matterIds=${otherMatterId}`);

    expect(res.status).toBe(200);
    expect(res.body.flatFees).toEqual([]);
    expect(res.body.totalItems).toBe(0);
  });
});

describe('GET /billing/flat-fees/firm - filtering pinned against the per-context routes', () => {
  it('returns exactly the rows the per-matter and per-client routes return', async () => {
    const matterA = await seedMatter([owner.uid], 'Matter A');
    const matterB = await seedMatter([owner.uid], 'Matter B');
    const matterC = await seedMatter([owner.uid], 'Matter C, not asked for');

    const billedFee = await seedFee({ matterId: matterA }, { cents: 250_075, description: 'Billed already' });
    await billMatterFeeOntoInvoice(billedFee, matterA, 250_075);
    await seedFee({ matterId: matterA }, { cents: 99_999, date: null });
    await seedFee({ matterId: matterB }, { cents: 1 });
    await seedFee({ clientId: client.id }, { cents: 333_333 });
    const excluded = await seedFee({ matterId: matterC });

    const [perA, perB, perClient, firmRes] = await Promise.all([
      owner.api.get(`${base()}/matter/${matterA}`),
      owner.api.get(`${base()}/matter/${matterB}`),
      owner.api.get(`${base()}/client/${client.id}`),
      owner.api.get(`${firmPath()}?matterIds=${matterA},${matterB}&clientId=${client.id}`),
    ]);

    expect(firmRes.status).toBe(200);

    const byId = (rows: any[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    const expected = byId([
      ...perA.body.flatFees,
      ...perB.body.flatFees,
      ...perClient.body.flatFees,
    ]);

    expect(expected).toHaveLength(4);
    expect(byId(firmRes.body.flatFees)).toEqual(expected);
    expect(firmRes.body.totalItems).toBe(4);
    expect(JSON.stringify(firmRes.body)).not.toContain(excluded);

    // The billed flag is derived here in SQL and in JS on the per-matter route.
    // Deep equality above already covers it; this names the row so a regression
    // reads as "the billed fee stopped being billed" rather than a diff dump.
    const billed = firmRes.body.flatFees.find((fee: any) => fee.id === billedFee);
    expect(billed.isBilled).toBe(true);
    expect(billed.amount).toBe(2500.75);
  });

  it('narrows to unbilled fees and counts only those', async () => {
    const matterId = await seedMatter([owner.uid]);
    const billed = await seedFee({ matterId }, { cents: 100_00 });
    await billMatterFeeOntoInvoice(billed, matterId, 100_00);
    const unbilled = await seedFee({ matterId }, { cents: 250_00 });

    const res = await owner.api.get(`${firmPath()}?billingStatus=unbilled`);

    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([unbilled]);
    expect(res.body.totalItems).toBe(1);
    expect(res.body.summary.totalAmount).toBe(250);
  });

  it('narrows to one context and to a day range', async () => {
    const matterId = await seedMatter([owner.uid]);
    const inRange = await seedFee({ matterId }, { date: '2026-03-15' });
    await seedFee({ matterId }, { date: '2026-01-05' });
    await seedFee({ clientId: client.id }, { date: '2026-03-16' });

    const res = await owner.api.get(`${firmPath()}?context=matter&dateFrom=2026-03-01&dateTo=2026-03-31`);

    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([inRange]);
    expect(res.body.totalItems).toBe(1);
  });
});

describe('GET /billing/flat-fees/firm - the bounded window', () => {
  it('refuses a limit above the ceiling instead of serving it', async () => {
    const res = await owner.api.get(`${firmPath()}?limit=${MAX_PAGE_SIZE + 1}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('pages within the ceiling and reports the whole match set', async () => {
    const matterId = await seedMatter([owner.uid]);
    const seeded = [];
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- five fixtures, ordered on purpose.
      seeded.push(await seedFee({ matterId }, { cents: 1_000 + i }));
    }

    const first = await owner.api.get(`${firmPath()}?limit=2`);
    const second = await owner.api.get(`${firmPath()}?limit=2&page=2`);

    expect(first.status).toBe(200);
    expect(first.body.flatFees).toHaveLength(2);
    expect(first.body.totalItems).toBe(5);
    expect(first.body.truncated).toBe(true);
    expect(second.body.flatFees).toHaveLength(2);
    expect(second.body.totalItems).toBe(5);

    const paged = [...idsOf(first), ...idsOf(second)];
    expect(new Set(paged).size).toBe(4);
    expect(seeded).toEqual(expect.arrayContaining(paged));
  });

  it('answers a count-only caller with the total and no rows at all', async () => {
    const matterId = await seedMatter([owner.uid]);
    await seedFee({ matterId }, { cents: 10_000 });
    await seedFee({ matterId }, { cents: 25_000 });

    const res = await owner.api.get(`${firmPath()}?countOnly=true`);

    expect(res.status).toBe(200);
    expect(res.body.flatFees).toEqual([]);
    expect(res.body.totalItems).toBe(2);
    expect(res.body.truncated).toBe(false);
    expect(res.body.summary.totalAmount).toBe(350);
  });
});

describe('GET /billing/flat-fees/firm - cost does not grow with the filter', () => {
  it('holds the same number of pool connections for 2 matter ids as for 14', async () => {
    const matterIds: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- fixtures, not the thing measured.
      const id = await seedMatter([owner.uid], `Matter ${i}`);
      // eslint-disable-next-line no-await-in-loop
      await seedFee({ matterId: id }, { cents: 1_000 + i });
      matterIds.push(id);
    }

    // Warm the permission cache, so the measurement below is the route's own
    // reads rather than a first-call cache miss.
    await owner.api.get(firmPath());

    const small = await poolCheckoutsDuring(() => owner.api
      .get(`${firmPath()}?matterIds=${matterIds.slice(0, 2).join(',')}`));
    const large = await poolCheckoutsDuring(() => owner.api
      .get(`${firmPath()}?matterIds=${matterIds.join(',')}`));

    expect((small.result as any).status).toBe(200);
    expect((large.result as any).status).toBe(200);
    expect((small.result as any).body.flatFees).toHaveLength(2);
    expect((large.result as any).body.flatFees).toHaveLength(14);

    // THE PROPERTY. Seven times the matter ids, the same number of checkouts.
    // Red the moment a per-matter read creeps back in, which is the whole reason
    // this route exists.
    expect(large.acquires).toBe(small.acquires);

    // The absolute figure, so an extra read is a deliberate change rather than a
    // silent one. Six: the caller's `users` row that `verifyToken` reads on
    // every authenticated request so a closed (erased) account is refused at
    // once (pinned in `tests/privacy/privacySubjectRights.test.ts`), ONE
    // `law_firms` lookup for the gates ahead of the handler, then the service's
    // firm-membership assertion, the owner-or-admin check and matter list
    // inside `listAccessibleMatters`, and the one page query.
    //
    // This route sits behind both the workspace billing gate and
    // `requireFeature('flatFees')`, which each want the same `law_firms` row. It
    // used to be two lookups; `loadFirmPlanForRequest` now memoizes the load for
    // the lifetime of one request, so both gates share it. That reuse is pinned
    // by `tests/plans/firmPlanPerRequest.test.ts`, including the half that
    // matters more here: it is scoped to a single request, so a plan change is
    // still visible on the next one.
    expect(large.acquires).toBe(6);
    // Staged, not fanned out, so this read can never be the request that drains
    // the pool for everyone else on the instance.
    expect(large.peak).toBeLessThanOrEqual(2);
  });

  it('refuses a matter-id list longer than the route will answer', async () => {
    const tooMany = Array.from({ length: MAX_PAGE_SIZE + 1 }, () => randomUUID()).join(',');

    const res = await owner.api.get(`${firmPath()}?matterIds=${tooMany}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
