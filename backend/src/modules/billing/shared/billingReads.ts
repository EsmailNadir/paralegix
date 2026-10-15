/**
 * Postgres read helpers for the billing module (invoices + firm billing).
 * Replaces the inline Firestore reads the billing services used to do against
 * matters / matterClients / clients / chargeCodes / members / timeEntries / flatFees
 * / expenses. Returns plain objects in the shapes the billing services expect.
 */

const { financialRootSql, financialSql, withDrizzleTransaction } = require('../../../shared/database/financialQuery');
const { isUuid } = require('../../../shared/utils/isUuid');
// Canonical money helpers (single firm-wide definition). `num` keeps its local
// name as an alias of toNum; `centsToDollars` is the null-preserving cents→dollars
// conversion (identical behavior: null stays null, otherwise integer cents / 100).
const { toNum: num, fromCentsOrNull: centsToDollars, toCentsOrNull: dollarsToCents } = require('./money');
const { resolveRate } = require('./rateResolution');
const { configuredRate } = require('./rateResolution');

const dateIso = (v: any) => (v instanceof Date ? v.toISOString() : (v ? String(v) : null));

export async function getClient(lawFirmId: string, clientId: string) {
  if (!isUuid(clientId)) return null;
  const { rows } = await financialRootSql(
    `select id, user_id, name, email, phone, organization, address, client_type, billing_rates
       from clients where law_firm_id = $1 and id = $2 limit 1`,
    [lawFirmId, clientId]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    organization: r.organization,
    // address / clientType let a caller that already has this record resolve
    // billing recipients without a second read (see
    // billingRecipientSnapshot.resolveCurrentBillingRecipients's `client` arg).
    address: r.address,
    clientType: r.client_type || 'person',
    billingRates: r.billing_rates || {},
  };
}

export async function findClientByEmail(lawFirmId: string, email: any) {
  const e = (email || '').trim().toLowerCase();
  if (!e) return null;
  const { rows } = await financialRootSql(
    `select id, user_id, name, email from clients where law_firm_id = $1 and lower(email::text) = $2 limit 1`,
    [lawFirmId, e]
  );
  return rows[0] ? { id: rows[0].id, userId: rows[0].user_id, name: rows[0].name, email: rows[0].email } : null;
}

/** Matter clients (JOIN matter_clients -> clients), shaped like the old matterClients docs. */
export async function listMatterClients(lawFirmId: string, matterId: string) {
  if (!isUuid(matterId)) return [];
  // Scoped by law_firm_id as well as matter_id: tenant isolation is the app's
  // job here (the backend connects as `postgres` and bypasses RLS), so a matter
  // id belonging to another firm must return nothing rather than that firm's
  // clients.
  const { rows } = await financialRootSql(
    `select cli.id, cli.user_id, cli.name, cli.email, cli.phone, cli.organization, cli.billing_rates,
            ccj.billing_portion_bp
       from matter_clients ccj join clients cli on cli.id = ccj.client_id
      where ccj.law_firm_id = $1 and ccj.matter_id = $2 order by cli.name`,
    [lawFirmId, matterId]
  );
  return rows.map((r: any) => ({
    id: r.id, userId: r.user_id, name: r.name, email: r.email,
    phone: r.phone, organization: r.organization, billingRates: r.billing_rates || {},
    // Null unless the matter is configured for split billing. See
    // `isSplitConfigured` for what makes a set of these usable.
    billingPortionBp: r.billing_portion_bp != null ? Number(r.billing_portion_bp) : null,
  }));
}

/**
 * Whether `clientId` is one of the matter's clients. One keyed existence read,
 * firm-scoped like `listMatterClients`, so a client or matter of another firm
 * answers false.
 */
export async function isClientOnMatter(lawFirmId: string, matterId: string, clientId: string) {
  if (!isUuid(matterId) || !isUuid(clientId)) return false;
  const { rows } = await financialRootSql(
    `select 1 from matter_clients
      where law_firm_id = $1 and matter_id = $2 and client_id = $3 limit 1`,
    [lawFirmId, matterId, clientId]
  );
  return rows.length > 0;
}

/** Enriched matter (members with dollar hourlyRate, clientNames) for rate resolution. */
export async function getMatter(lawFirmId: string, matterId: string) {
  const mattersRepo = require('../../matters/matters.repository');
  return mattersRepo.findByIdRaw(lawFirmId, matterId);
}

export async function chargeCodeMap(lawFirmId: string) {
  const { rows } = await financialRootSql(
    `select id, code, name, default_rate, member_rates from billing_codes where law_firm_id = $1 and kind = 'charge'`,
    [lawFirmId]
  );
  return new Map(rows.map((r: any) => [r.id, {
    // default_rate is a `numeric` column, which node-pg hands back as a STRING.
    // Rate resolution and the UI both distinguish "rate configured" from "no rate"
    // by type, so it has to be a number here or the charge-code tier is skipped.
    id: r.id, code: r.code, name: r.name, defaultRate: configuredRate(r.default_rate), memberRates: r.member_rates || {},
  }]));
}

export async function memberDefaultRates(lawFirmId: string) {
  const { rows } = await financialRootSql(
    `select user_id, default_hourly_rate_cents from members where law_firm_id = $1 and default_hourly_rate_cents is not null`,
    [lawFirmId]
  );
  const out: Record<string, any> = {};
  rows.forEach((r: any) => { out[r.user_id] = centsToDollars(r.default_hourly_rate_cents); });
  return out;
}

export async function firmDefaultRate(lawFirmId: string) {
  const { rows } = await financialRootSql(`select settings from law_firms where id = $1 limit 1`, [lawFirmId]);
  return rows[0]?.settings?.billing?.defaultRate ?? undefined;
}

/**
 * Whose negotiated rates price this entry, on a matter that has several clients.
 *
 * Rate tiers 3 and 4 read "the matter's billing client", and a matter does not
 * name a payer until an invoice is composed. Where the entry itself names one,
 * that is the answer: work done for a client is billed at the rate that client
 * agreed to, not at whichever client happens to sort first on the matter.
 *
 * The alphabetical pick stays for an entry that names nobody, and for one whose
 * named client has since left the matter. There is nothing better to resolve
 * against in either case, and returning null instead would bill the work at
 * whatever the tiers below happen to hold.
 *
 * This decides a stamped rate (migration 0233), so it settles the price once,
 * at write time. It cannot reprice work that is already rated.
 */
export function billingRatesForEntry(matterClients: any[] = [], matterClientIds: any = null) {
  const named = Array.isArray(matterClientIds) ? matterClientIds[0] : null;
  if (named) {
    const payer = matterClients.find((c: any) => c.id === named);
    if (payer) return payer.billingRates || null;
  }
  return matterClients[0]?.billingRates || null;
}

/**
 * The rate a time entry should carry, resolved from the same eight sources every
 * reader used to walk on every read, in the same order (`rateResolution.ts`).
 *
 * Since migration 0233 the answer is STORED on the entry (`resolved_rate_cents`,
 * `rate_source`) when it is written, and written again only when the entry's
 * own inputs change or the firm asks to re-rate. That is what stops a change to
 * a member's default rate from silently revaluing every unbilled entry they ever
 * logged. The billing client for a matter entry is the payer the entry names,
 * falling back to the matter's first client by name; see
 * `billingRatesForEntry`.
 */
export async function resolveEntryRate(lawFirmId: string, entry: {
  contextType: 'matter' | 'client'; entityId: string; userId: string | null;
  chargeCodeId: string | null; hourlyRate: number | null; matterClientIds?: any;
}) {
  const [chargeCodes, memberDefaults, firmDefault] = await Promise.all([
    chargeCodeMap(lawFirmId), memberDefaultRates(lawFirmId), firmDefaultRate(lawFirmId),
  ]);
  let matterMembers: any[] = [];
  let clientBillingRates: any = null;
  if (entry.contextType === 'matter') {
    const matterData = await getMatter(lawFirmId, entry.entityId);
    matterMembers = (matterData?.members || []).map((m: any) => ({ userId: m.userId, hourlyRate: m.hourlyRate }));
    const matterClients = await listMatterClients(lawFirmId, entry.entityId);
    clientBillingRates = billingRatesForEntry(matterClients, entry.matterClientIds);
  } else {
    const client = await getClient(lawFirmId, entry.entityId);
    clientBillingRates = client?.billingRates || null;
  }
  const chargeCode = entry.chargeCodeId ? chargeCodes.get(entry.chargeCodeId) : null;
  const { rate, source } = resolveRate({
    entry: { userId: entry.userId, hourlyRate: entry.hourlyRate },
    matterMembers, clientBillingRates, chargeCode,
    memberDefaultRates: memberDefaults, firmDefaultRate: firmDefault,
  });
  return {
    resolvedRateCents: source === 'none' ? null : dollarsToCents(rate),
    rateSource: source,
  };
}

/**
 * The rate a reader should use for an entry: the stored one when the entry has
 * been rated, otherwise whatever `live()` resolves. A null `rateSource` means
 * nothing has rated the row yet (a fixture written by hand, or a row from before
 * migration 0233 the backfill did not reach); a stored `'none'` means it was
 * rated and no source applied.
 */
export function storedOrLiveRate(entry: any, live: () => number | null): number | null {
  if (entry && entry.rateSource) {
    return entry.rateSource === 'none' ? null : (entry.resolvedRate ?? null);
  }
  return live();
}

/** Time entries for a billing context (matter or client). */
export async function listTimeEntries(context: any) {
  const col = context.type === 'matter' ? 'matter_id' : 'client_id';
  const { rows } = await financialRootSql(
    `select te.id, te.user_id, u.name as user_name, te.hours, te.rate_cents,
            te.resolved_rate_cents, te.rate_source, te.matter_client_ids,
            te.billing_code_id as charge_code_id, te.description, te.activity_date as entry_date, te.name, te.billable,
            te.utbms_task_code, te.utbms_activity_code,
            te.source_task_id, st.title as source_task_title,
            te.source_event_id, se.title as source_event_title,
            te.coverage as retainer_coverage
       from activities te
       left join users u on u.id = te.user_id
       left join tasks st on st.id = te.source_task_id
       left join events se on se.id = te.source_event_id
      where te.kind = 'time' and te.law_firm_id = $1 and te.${col} = $2
      order by te.activity_date, te.created_at, te.id`,
    [context.lawFirmId, context.entityId]
  );
  return rows.map((r: any) => ({
    id: r.id,
    userId: r.user_id || '',
    userName: r.user_name || '',
    hours: num(r.hours),
    hourlyRate: centsToDollars(r.rate_cents),
    // Rate tiers 3-4 resolve against the client the entry names; see
    // `billingRatesForEntry`.
    matterClientIds: r.matter_client_ids || [],
    chargeCodeId: r.charge_code_id || null,
    description: r.description || '',
    date: dateIso(r.entry_date),
    name: r.name || '',
    utbmsTaskCode: r.utbms_task_code || null,
    utbmsActivityCode: r.utbms_activity_code || null,
    sourceTaskId: r.source_task_id || null,
    sourceTaskTitle: r.source_task_title || null,
    sourceEventId: r.source_event_id || null,
    sourceEventTitle: r.source_event_title || null,
    billable: r.billable !== false,
    resolvedRate: centsToDollars(r.resolved_rate_cents),
    rateSource: r.rate_source || null,
    // 'covered' when a retainer period's included hours pay for this entry.
    retainerCoverage: r.retainer_coverage || null,
  }));
}

export async function listFlatFees(context: any) {
  const col = context.type === 'matter' ? 'matter_id' : 'client_id';
  const { rows } = await financialRootSql(
    // `fee_date` is the day the firm put on the fee and what its own list shows;
    // this read used to date the fee by `created_at` instead, so the invoice
    // composer disagreed with the fee list about when a fee was for. Falls back
    // to the creation day only for a row that never had a date.
    `select id, description, amount_cents, coalesce(activity_date, created_at::date) as fee_date
       from activities where kind = 'flat_fee' and law_firm_id = $1 and ${col} = $2`,
    [context.lawFirmId, context.entityId]
  );
  return rows.map((r: any) => ({
    id: r.id, description: r.description || '',
    amount: centsToDollars(r.amount_cents), date: r.fee_date,
  }));
}

export async function listExpenses(context: any) {
  const col = context.type === 'matter' ? 'matter_id' : 'client_id';
  const { rows } = await financialRootSql(
    `select a.id, a.description, a.amount_cents, a.activity_date as expense_date,
            coalesce(bc.code, a.category) as category,
            a.billing_code_id as expense_category_id, a.vendor, a.billable
       from activities a
       left join billing_codes bc on bc.id = a.billing_code_id
      where a.kind = 'expense' and a.law_firm_id = $1 and a.${col} = $2`,
    [context.lawFirmId, context.entityId]
  );
  return rows.map((r: any) => ({
    id: r.id, description: r.description || '',
    amount: centsToDollars(r.amount_cents), date: dateIso(r.expense_date),
    category: r.category || null, expenseCategoryId: r.expense_category_id || null,
    vendor: r.vendor || '', billable: r.billable,
  }));
}

/**
 * Matters whose billing the user may read. Firm owners/admins see every matter in
 * the firm — so firm-wide A/R, invoices, time entries, and the workbench are
 * complete for them — while regular members stay scoped to matters they belong to
 * (the ethical wall). Same owner/admin rule the matters list uses.
 *
 * Returns `{ id, name, clientNames }` per matter, which is the whole of what the
 * billing services read off these records. It deliberately does NOT return the
 * enriched matter entity: this read is unwindowed by design (the money aggregates
 * cover the firm, never a page), so enriching every row with its members, client
 * details, stage, court and outstanding balance made a firm's matter count the
 * dominant cost of every billing request.
 */
export async function listAccessibleMatters(lawFirmId: string, userId: string) {
  const mattersRepo = require('../../matters/matters.repository');
  const { isFirmOwnerOrAdmin } = require('../../../shared/utils/membership');
  const seeAll = await isFirmOwnerOrAdmin(lawFirmId, userId);
  return mattersRepo.listAccessibleMatterNames(lawFirmId, userId, { seeAll });
}

export async function listFirmClients(lawFirmId: string) {
  const { rows } = await financialRootSql(
    `select id, user_id, name, email, billing_rates from clients where law_firm_id = $1`,
    [lawFirmId]
  );
  return rows.map((r: any) => ({ id: r.id, userId: r.user_id, name: r.name, email: r.email, billingRates: r.billing_rates || {} }));
}

/** Next invoice number across the firm for a prefix (max numeric suffix + 1). */
/** Firm-wide time entries grouped by context (replaces per-matter/client listTimeEntries N+1). */
/**
 * Every time entry in the firm, grouped by the context it belongs to.
 *
 * `prefilter` narrows the read to the rows a caller's column-only filters could
 * possibly keep, and is deliberately a SUPERSET of the caller's real filter: the
 * derived-record filter in `firmBillingWindow` still runs afterwards, so
 * over-selecting only costs a little work while under-selecting would silently
 * drop entries. Filters that read a derived field (which clients an entry is
 * billed to, its billing status, the free-text search across matter/client/user
 * names) are NOT expressible here and stay where those fields are computed.
 */
export async function listTimeEntriesForFirm(lawFirmId: string, prefilter: any = {}) {
  const { matterId, userId, chargeCodeId, dateFrom, dateTo, context } = prefilter;
  const params: unknown[] = [lawFirmId];
  let where = "te.kind = 'time' and te.law_firm_id = $1";

  if (matterId && isUuid(matterId)) {
    params.push(matterId);
    where += ` and te.matter_id = $${params.length}`;
  }
  if (userId) {
    params.push(userId);
    where += ` and te.user_id = $${params.length}`;
  }
  if (chargeCodeId && isUuid(chargeCodeId)) {
    params.push(chargeCodeId);
    where += ` and te.billing_code_id = $${params.length}`;
  }
  if (dateFrom) {
    params.push(dateFrom);
    where += ` and te.activity_date >= $${params.length}`;
  }
  if (dateTo) {
    params.push(dateTo);
    where += ` and te.activity_date <= $${params.length}`;
  }
  // An entry's context is decided by whether it carries a matter, which is the
  // same rule the grouping below applies.
  if (context === 'matter') where += ' and te.matter_id is not null';
  else if (context === 'client') where += ' and te.matter_id is null';

  const { rows } = await financialRootSql(
    `select te.id, te.user_id, u.name as user_name, te.hours, te.rate_cents,
            te.resolved_rate_cents, te.rate_source, te.matter_client_ids,
            te.billing_code_id as charge_code_id, te.description, te.activity_date as entry_date, te.name, te.billable,
            te.utbms_task_code, te.utbms_activity_code, te.matter_id, te.client_id,
            te.source_task_id, st.title as source_task_title,
            te.source_event_id, se.title as source_event_title,
            te.coverage as retainer_coverage
       from activities te
       left join users u on u.id = te.user_id
       left join tasks st on st.id = te.source_task_id
       left join events se on se.id = te.source_event_id
      where ${where}
      order by te.activity_date, te.created_at, te.id`,
    params
  );
  const byMatter = new Map();
  const byClient = new Map();
  for (const r of rows) {
    const item = {
      id: r.id, userId: r.user_id || '', userName: r.user_name || '',
      hours: num(r.hours), hourlyRate: centsToDollars(r.rate_cents), chargeCodeId: r.charge_code_id || null,
      // Rate tiers 3-4 resolve against the client the entry names; see
      // `billingRatesForEntry`.
      matterClientIds: r.matter_client_ids || [],
      resolvedRate: centsToDollars(r.resolved_rate_cents), rateSource: r.rate_source || null,
      description: r.description || '', date: dateIso(r.entry_date), name: r.name || '',
      utbmsTaskCode: r.utbms_task_code || null, utbmsActivityCode: r.utbms_activity_code || null,
      sourceTaskId: r.source_task_id || null, sourceTaskTitle: r.source_task_title || null,
      sourceEventId: r.source_event_id || null, sourceEventTitle: r.source_event_title || null,
      billable: r.billable !== false,
      retainerCoverage: r.retainer_coverage || null,
    };
    const map = r.matter_id ? byMatter : byClient;
    const key = r.matter_id || r.client_id;
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return { byMatter, byClient };
}

/**
 * Ids of the tasks and events the firm has already recorded time against, so the
 * unbilled-work list can drop work that is already captured. One scan of the
 * firm's linked entries rather than a per-task existence check.
 */
export async function listCapturedWorkSourceIds(lawFirmId: string) {
  const { rows } = await financialRootSql(
    `select distinct source_task_id, source_event_id
       from activities
      where kind = 'time' and law_firm_id = $1 and (source_task_id is not null or source_event_id is not null)`,
    [lawFirmId]
  );
  const taskIds = new Set();
  const eventIds = new Set();
  for (const r of rows) {
    if (r.source_task_id) taskIds.add(r.source_task_id);
    if (r.source_event_id) eventIds.add(r.source_event_id);
  }
  return { taskIds, eventIds };
}

/**
 * Of the supplied source ids (time entries, flat fees, expenses), those flagged
 * non-billable. The invoice builder already filters them out client-side, so this
 * is the server-side backstop for a direct API call or a stale tab submitting a
 * source that was written off after the composer loaded.
 */
export async function listNonBillableSourceIds(lawFirmId: string, sourceIds: any) {
  const ids = Array.from(new Set((sourceIds || []).filter(isUuid)));
  if (!ids.length) return new Set();
  const { rows } = await financialRootSql(
    `select id from activities
      where law_firm_id = $1 and id = any($2::uuid[]) and billable = false`,
    [lawFirmId, ids]
  );
  return new Set(rows.map((r: any) => r.id));
}

/** Firm-wide flat fees grouped by context (replaces per-matter/client listFlatFees N+1). */
export async function listFlatFeesForFirm(lawFirmId: string) {
  const { rows } = await financialRootSql(
    `select id, description, amount_cents, coalesce(activity_date, created_at::date) as fee_date, matter_id, client_id
       from activities where kind = 'flat_fee' and law_firm_id = $1`,
    [lawFirmId]
  );
  const byMatter = new Map();
  const byClient = new Map();
  for (const r of rows) {
    const item = {
      id: r.id, description: r.description || '',
      amount: centsToDollars(r.amount_cents), date: r.fee_date,
    };
    const map = r.matter_id ? byMatter : byClient;
    const key = r.matter_id || r.client_id;
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return { byMatter, byClient };
}

/** Matter clients for many matters in one query (replaces per-matter listMatterClients N+1). */
export async function listMatterClientsForMatters(lawFirmId: string, matterIds: string[]) {
  const ids = (matterIds || []).filter(isUuid);
  if (!ids.length) return new Map();
  const { rows } = await financialRootSql(
    `select ccj.matter_id, cli.id, cli.user_id, cli.name, cli.email, cli.phone, cli.organization, cli.billing_rates
       from matter_clients ccj join clients cli on cli.id = ccj.client_id
      where ccj.law_firm_id = $1 and ccj.matter_id = any($2::uuid[]) order by cli.name`,
    [lawFirmId, ids]
  );
  const byMatter = new Map();
  for (const r of rows) {
    if (!byMatter.has(r.matter_id)) byMatter.set(r.matter_id, []);
    byMatter.get(r.matter_id).push({
      id: r.id, userId: r.user_id, name: r.name, email: r.email,
      phone: r.phone, organization: r.organization, billingRates: r.billing_rates || {},
    });
  }
  return byMatter;
}

/**
 * Build the set of billed line-item ids from a context's invoice documents.
 * A voided invoice holds nothing: the firm cancelled it, and its work is free
 * to be billed again.
 */
export function collectBilledIds(invoices: any) {
  const timeEntryIds = new Set();
  const flatFeeIds = new Set();
  const expenseIds = new Set();
  for (const inv of invoices) {
    if (inv.status === 'voided') continue;
    (inv.timeEntries || []).forEach((te: any) => {
      if (te.id) timeEntryIds.add(te.id);
      if (te.timeEntryId) timeEntryIds.add(te.timeEntryId);
    });
    (inv.flatFees || []).forEach((ff: any) => { if (ff.id) flatFeeIds.add(ff.id); if (ff.flatFeeId) flatFeeIds.add(ff.flatFeeId); });
    (inv.expenses || []).forEach((ex: any) => { if (ex.id) expenseIds.add(ex.id); if (ex.expenseId) expenseIds.add(ex.expenseId); });
  }
  return { timeEntryIds, flatFeeIds, expenseIds };
}

/** True if a billing row is in a billed set. */
export function isBilled(set: any, row: any) {
  return set.has(row.id);
}

// Whether a source row (time entry / flat fee / expense) is already billed on an
// invoice in this context. The authoritative "billed" signal is an invoice line
// item whose source_id points back at the row (the source tables' own
// `billed`/`is_billed` columns are never maintained), so delete/edit guards must
// check this rather than that column. `kind` is the invoice_line_items kind
// ('time_entry' | 'flat_fee' | 'expense'); `sourceIds` is the row id.
//
// A line item on a voided invoice does not count: voiding releases the work
// (and activity_billed_immutable agrees).
//
// It still takes an array: a caller may hold more than one id for the same
// logical row (a draft id alongside the persisted one), and one query settles
// all of them.
export async function isSourceBilled(context: any, kind: any, sourceIds: any) {
  const ids = (Array.isArray(sourceIds) ? sourceIds : [sourceIds]).filter(Boolean).map(String);
  if (!ids.length) return false;
  const scopeCol = context.type === 'matter' ? 'i.matter_id' : 'i.client_context_id';
  const { rows } = await financialRootSql(
    `select 1
       from invoice_line_items li
       join invoices i on i.id = li.invoice_id
      where i.law_firm_id = $1 and ${scopeCol} = $2 and li.kind = $3 and li.source_id = any($4)
        and i.status <> 'voided'
      limit 1`,
    [context.lawFirmId, context.entityId, kind, ids],
  );
  return rows.length > 0;
}

/**
 * Which of these source ids an invoice already carries, anywhere in the firm.
 *
 * The same question `isSourceBilled` answers, asked once for a set that spans
 * billing contexts. A bulk action is assembled from the FIRM list, so its ids
 * come from many matters and many clients at once; calling `isSourceBilled` per
 * context (or per id) would put a round trip on the pool for every row, which is
 * the burst a bulk route exists to remove.
 *
 * Firm-wide rather than context-scoped ON PURPOSE, and it is the wider answer of
 * the two. `activities_billed_immutable` (db/schema/70_billing.sql) refuses to
 * delete a row that a line item on ANY non-voided invoice of the firm names, as
 * this does, and it aborts the whole
 * statement when it fires, so a batch built on the narrower context-scoped
 * answer would fail entirely rather than refusing one row. Composition only ever
 * puts an entry on an invoice for its own context, so the two answers agree on
 * every row the product can produce; where they could differ, this one matches
 * what the database will actually allow.
 */
export async function billedSourceIdsForFirm(lawFirmId: string, kind: any, sourceIds: any) {
  const ids = (Array.isArray(sourceIds) ? sourceIds : [sourceIds]).filter(Boolean).map(String);
  const out = new Set<string>();
  if (!ids.length) return out;
  const { rows } = await financialRootSql(
    `select distinct li.source_id
       from invoice_line_items li
       join invoices i on i.law_firm_id = li.law_firm_id and i.id = li.invoice_id
      where li.law_firm_id = $1 and li.kind = $2 and li.source_id = any($3)
        and i.status <> 'voided'`,
    [lawFirmId, kind, ids],
  );
  for (const r of rows) out.add(r.source_id);
  return out;
}

/**
 * The set of source ids already carried by an invoice in this context.
 *
 * Same question as `isSourceBilled`, asked for every row at once instead of one
 * at a time — and, more importantly, without loading the invoice graph to answer
 * it. The list endpoints used to call `invoicesRepo.findByContext`, which pulls
 * every invoice in the context plus five child-table reads, purely to walk the
 * line items and collect ids. This asks the line-items table directly.
 *
 * THE DEFINITION IS UNCHANGED, and that matters more than the speed here.
 * `isBilled` means "appears on an invoice for this context", and the invoice
 * graph derives its line items from exactly this table: `lineRowToItem` sets
 * `out.id = row.source_id` for rows of the matching `kind`. So the set this
 * returns is the same set the graph walk produced.
 *
 * Filtering on the source tables' own `billed` / `is_billed` columns would NOT
 * be equivalent — those are separate denormalized flags that are never
 * maintained — which is the quiet money discrepancy the callers' comments warn
 * about.
 *
 * @param {{lawFirmId: string, type: 'matter'|'client', entityId: string}} context
 * @param {'time_entry'|'flat_fee'|'expense'} kind
 * @returns {Promise<Set<string>>}
 */
export async function billedSourceIds(context: any, kind: any) {
  const scopeCol = context.type === 'matter' ? 'i.matter_id' : 'i.client_context_id';
  const { rows } = await financialRootSql(
    `select distinct li.source_id
       from invoice_line_items li
       join invoices i on i.id = li.invoice_id
      where i.law_firm_id = $1 and ${scopeCol} = $2
        and li.kind = $3 and li.source_id is not null
        and i.status <> 'voided'`,
    [context.lawFirmId, context.entityId, kind],
  );
  return new Set(rows.map((r: any) => r.source_id));
}

/**
 * Where each source id currently sits in the invoicing pipeline.
 *
 * Same authority as `billedSourceIds` (the line items table, never the source
 * table's unmaintained `billed` flag) but carries the invoice's identity and
 * status back with it. Callers need the status because "on an invoice" and "on
 * a *sent* invoice" are different facts to a timekeeper: an entry on a draft is
 * already locked against edits, and a UI that only says "billed" makes that
 * lock look like a bug.
 *
 * A source can in principle appear on more than one line; the first row wins,
 * which matches `isSourceBilled` answering yes on the first hit.
 *
 * @param {{lawFirmId: string, type: 'matter'|'client', entityId: string}} context
 * @param {'time_entry'|'flat_fee'|'expense'} kind
 * @param {string[]} sourceIds
 * @returns {Promise<Map<string, {invoiceId: string, invoiceNumber: string, status: string}>>}
 */
export async function invoicePlacementsForSources(context: any, kind: any, sourceIds: any) {
  const ids = (Array.isArray(sourceIds) ? sourceIds : [sourceIds]).filter(Boolean).map(String);
  const out = new Map<string, { invoiceId: string; invoiceNumber: string; status: string }>();
  if (!ids.length) return out;
  const scopeCol = context.type === 'matter' ? 'i.matter_id' : 'i.client_context_id';
  const { rows } = await financialRootSql(
    `select li.source_id, i.id as invoice_id, i.invoice_number, i.status
       from invoice_line_items li
       join invoices i on i.id = li.invoice_id
      where i.law_firm_id = $1 and ${scopeCol} = $2
        and li.kind = $3 and li.source_id = any($4)
        and i.status <> 'voided'`,
    [context.lawFirmId, context.entityId, kind, ids],
  );
  for (const r of rows) {
    if (!out.has(r.source_id)) {
      out.set(r.source_id, {
        invoiceId: r.invoice_id,
        invoiceNumber: r.invoice_number,
        status: r.status,
      });
    }
  }
  return out;
}

/**
 * Whether a matter's clients carry a usable billing split.
 *
 * A split is only usable when every client on the matter has a portion and the
 * portions total 100%. A partial set is treated as unconfigured rather than
 * being completed with a guess, because guessing here silently bills someone.
 */
export function isSplitConfigured(matterClients: any[]): boolean {
  if (!Array.isArray(matterClients) || matterClients.length < 2) return false;
  if (matterClients.some((c: any) => typeof c.billingPortionBp !== 'number')) return false;
  const total = matterClients.reduce((sum: number, c: any) => sum + c.billingPortionBp, 0);
  return total === 10000;
}
