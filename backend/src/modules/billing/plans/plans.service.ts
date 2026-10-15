const { ValidationError, NotFoundError } = require('../../../shared/errors/AppError');
const { assertLawFirmMembership } = require('../../../shared/utils/membership');
const { resolveClientsInFirm } = require('../../../shared/utils/clientScope');
const { authorizeContext, CONTEXT_TYPES } = require('../context');
const invoicesRepo = require('../invoices/invoices.repository');
const invoicesService = require('../invoices/invoices.service');
const chargeCodesRepo = require('../chargeCodes/chargeCodes.repository');
const billingReads = require('../shared/billingReads');
const plansRepo = require('./plans.repository');
const { resolveRateValue } = require('../shared/rateResolution');
const { toNumber, roundCurrency, fromCents, hourlyAmountCents } = require('../shared/money');
const { toDate } = require('../../../shared/utils/dateConversion');
const { personalToday, firmZone } = require('../../../shared/utils/personalDay');
const { localDateFor } = require('../../../shared/utils/localTime');

function parseDateOrThrow(value: any, fieldName: any) {
  const parsed = toDate(value);
  if (!parsed) {
    throw new ValidationError({ [fieldName]: [`${fieldName} is invalid`] });
  }
  // Normalize to UTC midnight. These are day-only dates; using UTC throughout
  // (construction + math + dayKey's toISOString) keeps period boundaries stable
  // regardless of the server timezone (see backend/AGENTS.md date rules).
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function dayKey(value: any) {
  const date = toDate(value);
  return date ? date.toISOString().split('T')[0] : null;
}

function iso(value: any) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

function addDays(value: any, days: any) {
  const date = parseDateOrThrow(value, 'date');
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addInterval(value: any, unit: any, count: any, anchorDay: any) {
  const date = parseDateOrThrow(value, 'date');
  const next = new Date(date);
  if (unit === 'month') {
    // Clamp to the target month's last valid day so a plan anchored on the 29th-31st
    // does not overflow into the following month. setUTCMonth alone turns Jan 31 into
    // "Feb 31", which JS rolls forward to Mar 2/3 - skipping February's period and
    // permanently drifting the plan. Matches taskRecurrence/matterEvents month math.
    //
    // Clamp against the ORIGINAL anchor day (when supplied), not the current
    // possibly-already-clamped day, so a 31st-anchored plan returns to the 31st
    // in months that have one instead of sticking on the 28th after February.
    const targetDay = anchorDay || next.getUTCDate();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + count);
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(targetDay, lastDay));
  } else {
    next.setUTCDate(next.getUTCDate() + (count * 7));
  }
  return next;
}

function getPeriodEnd(startDate: any, intervalUnit: any, intervalCount: any, anchorDay: any) {
  const next = addInterval(startDate, intervalUnit, intervalCount, anchorDay);
  next.setUTCDate(next.getUTCDate() - 1);
  return next;
}

function buildInvoiceNumber(planId: string, periodId: any) {
  const compactPlan = String(planId || '').replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase();
  const compactPeriod = String(periodId || '').replace(/[^0-9]/g, '');
  return `RET-${compactPlan || 'PLAN'}-${compactPeriod || Date.now()}`;
}

function planContext(plan: any, lawFirmId: string) {
  return {
    type: plan.contextType,
    lawFirmId,
    entityId: plan.entityId,
  };
}

/**
 * The plan's default client is who every drafted invoice bills. On a matter
 * plan it must be one of that matter's clients (the only clients the plan form
 * offers); on a client plan, at least a client of this firm.
 */
async function assertDefaultClient({ lawFirmId, contextType, entityId, defaultClientId }: any) {
  if (!defaultClientId) return;
  if (contextType === CONTEXT_TYPES.matter) {
    if (!(await billingReads.isClientOnMatter(lawFirmId, entityId, defaultClientId))) {
      throw new ValidationError({ defaultClientId: ['The default client must be a client on this matter.'] });
    }
    return;
  }
  if (!(await resolveClientsInFirm(lawFirmId, [defaultClientId])).has(defaultClientId)) {
    throw new ValidationError({ defaultClientId: ['Select a client from this firm.'] });
  }
}

/** Index of the first element in a time-ordered array whose time is >= `t`. */
function lowerBound(sorted: any, t: any) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index one past the last element whose time is <= `t`. */
function upperBound(sorted: any, t: any) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].time <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function formatPeriod(period: any) {
  return {
    id: period.id,
    periodStartDate: period.periodStartDate || null,
    periodEndDate: period.periodEndDate || null,
    dueDate: period.dueDate || null,
    status: period.status || 'ready_to_bill',
    amount: roundCurrency(period.amount),
    includedHours: roundCurrency(period.includedHours),
    consumedHours: roundCurrency(period.consumedHours),
    overageHours: roundCurrency(period.overageHours),
    generatedInvoiceId: period.generatedInvoiceId || null,
    generatedInvoiceContextType: period.generatedInvoiceContextType || null,
    generatedInvoiceEntityId: period.generatedInvoiceEntityId || null,
    generatedAt: iso(period.generatedAt),
    coveredTimeEntryIds: Array.isArray(period.coveredTimeEntryIds) ? period.coveredTimeEntryIds : [],
    overageTimeEntryIds: Array.isArray(period.overageTimeEntryIds) ? period.overageTimeEntryIds : [],
    createdAt: iso(period.createdAt),
    updatedAt: iso(period.updatedAt),
  };
}

function formatPlan(plan: any, meta: any = {}) {
  const matterRecord = meta.matterRecord || null;
  const clientRecord = meta.clientRecord || null;
  const defaultClient = meta.defaultClient || null;

  return {
    id: plan.id,
    contextType: plan.contextType,
    entityId: plan.entityId,
    planType: plan.planType || 'retainer',
    name: plan.name || 'Retainer',
    status: plan.status || 'active',
    intervalUnit: plan.intervalUnit || 'month',
    intervalCount: plan.intervalCount || 1,
    startDate: dayKey(plan.startDate),
    nextRunDate: dayKey(plan.nextRunDate),
    amount: roundCurrency(plan.amount),
    includedHours: roundCurrency(plan.includedHours),
    billingEmail: plan.billingEmail || null,
    defaultDueDays: typeof plan.defaultDueDays === 'number' ? plan.defaultDueDays : 0,
    defaultClientId: plan.defaultClientId || null,
    notes: plan.notes || null,
    endCondition: plan.endCondition || 'manual',
    endDate: plan.endDate || null,
    matterName: plan.contextType === CONTEXT_TYPES.matter ? (matterRecord?.name || null) : null,
    clientName:
      plan.contextType === CONTEXT_TYPES.client
        ? (clientRecord?.name || clientRecord?.email || null)
        : (defaultClient?.name || defaultClient?.email || matterRecord?.clientNames?.[0] || null),
    periods: Array.isArray(meta.periods) ? meta.periods.map(formatPeriod) : undefined,
    // True when the period read hit its ceiling and the OLDEST periods were
    // dropped. Only meaningful alongside `periods`.
    periodsTruncated: Array.isArray(meta.periods) ? !!meta.periodsTruncated : undefined,
    createdAt: iso(plan.createdAt),
    updatedAt: iso(plan.updatedAt),
  };
}

/**
 * Rate inputs that are the same for every plan and every period in the firm:
 * the charge-code table, each member's firm-wide default rate, and the firm's
 * own fallback rate. Read once per request and threaded down, rather than
 * re-read for every billing period every plan has ever run.
 */
async function loadFirmRateContext(lawFirmId: string) {
  const [chargeCodes, memberDefaultRates, firmDefaultRate] = await Promise.all([
    chargeCodesRepo.findAll(lawFirmId).catch(() => []),
    billingReads.memberDefaultRates(lawFirmId),
    billingReads.firmDefaultRate(lawFirmId),
  ]);
  return {
    chargeCodeMap: new Map((chargeCodes || []).map((code: any) => [code.id, code])),
    memberDefaultRates,
    firmDefaultRate,
  };
}

/**
 * A once-per-request memo for `loadFirmRateContext`. Lazy on purpose: a firm
 * whose plans are all up to date computes no usage at all, and should therefore
 * issue no rate reads either.
 */
function firmRateLoader(lawFirmId: string) {
  let pending: any = null;
  return () => (pending || (pending = loadFirmRateContext(lawFirmId)));
}

/**
 * Everything usage computation needs for ONE plan, independent of which period
 * is being computed: the plan context's unbilled time log (date-ordered once),
 * the rate-resolution inputs, and the firm-wide rate context.
 *
 * Every period of a plan draws from this same set and differs only in which
 * slice of the date-ordered log falls inside its own dates, so loading it per
 * period re-read the matter's entire time log and full invoice graph once per
 * billing interval the plan had ever run.
 */
async function loadPlanUsageContext({ lawFirmId, plan, loadFirmRates }: any) {
  const context = planContext(plan, lawFirmId);

  // The firm rate context runs three reads of its own, so it follows the plan's
  // reads instead of joining them: at most three pool connections at once.
  const [timeEntries, invoices, matterRecord] = await Promise.all([
    billingReads.listTimeEntries(context),
    invoicesRepo.findByContext(context),
    context.type === CONTEXT_TYPES.matter ? billingReads.getMatter(lawFirmId, context.entityId) : Promise.resolve(null),
  ]);
  const firmRates = await loadFirmRates();

  // Full rate-resolution inputs (mirror invoices.service) so overage is priced
  // with the SAME 9-tier hierarchy as the invoice it feeds: matter members plus
  // the applicable client billing rates, for both matter- and client-context plans.
  let matterMembers = [];
  let clientBillingRates = null;
  let rateClients: any[] = [];
  if (context.type === CONTEXT_TYPES.matter) {
    matterMembers = (matterRecord?.members || []).map((m: any) => ({ userId: m.userId, hourlyRate: m.hourlyRate }));
    // Rate tiers 3-4 read the matter's billing client, resolved per entry from
    // the payer the entry names; see `billingRatesForEntry`.
    rateClients = await billingReads.listMatterClients(lawFirmId, context.entityId).catch(() => []);
  } else {
    const client = await billingReads.getClient(lawFirmId, context.entityId).catch(() => null);
    clientBillingRates = client?.billingRates || null;
  }

  const { timeEntryIds: billedTimeEntryIds } = billingReads.collectBilledIds(invoices);

  // Unbilled entries, dated and sorted once. Entries with an unreadable date can
  // never fall inside a period, so they are dropped here instead of being
  // re-tested per period. The sort is by date alone, and Array#sort is stable, so
  // entries sharing a date keep their source order exactly as they did when each
  // period sorted its own slice.
  const datedEntries = [];
  for (const entry of timeEntries) {
    if (billingReads.isBilled(billedTimeEntryIds, entry)) continue;
    // Written-off time never reaches an invoice (`createInvoice` refuses it), so
    // it neither uses the retainer's included hours nor counts as overage.
    if (entry.billable === false) continue;
    const time = toDate(entry.date)?.getTime();
    if (typeof time !== 'number' || Number.isNaN(time)) continue;
    datedEntries.push({ entry, time });
  }
  datedEntries.sort((a, b) => a.time - b.time);

  return {
    datedEntries,
    matterMembers,
    clientBillingRates,
    rateClients,
    isMatterContext: context.type === CONTEXT_TYPES.matter,
    chargeCodeMap: firmRates.chargeCodeMap,
    memberDefaultRates: firmRates.memberDefaultRates,
    firmDefaultRate: firmRates.firmDefaultRate,
  };
}

/**
 * Most periods one read of a plan will generate. Route validation bounds the
 * start date, so this only binds on a row written some other way; it keeps one
 * request from writing thousands of periods. Nothing is lost when it binds:
 * `nextRunDate` is saved where the pass stopped and the next read continues.
 */
export const MAX_PERIODS_PER_PASS = 500;

/** Hours as integer hundredths. Stored hours are numeric(6,2), so this is exact. */
const toHundredths = (hours: any) => Math.round(toNumber(hours) * 100);

/**
 * Retainer usage for one period. Pure: everything it reads was loaded once by
 * `loadPlanUsageContext`, so a plan with fifty periods costs one set of reads,
 * not fifty.
 */
function computeUsageForRange({ plan, usageContext, periodStartDate, periodEndDate }: any) {
  const rangeStart = parseDateOrThrow(periodStartDate, 'periodStartDate');
  const rangeEnd = parseDateOrThrow(periodEndDate, 'periodEndDate');
  rangeEnd.setUTCHours(23, 59, 59, 999);

  // The entry list is time-ordered, so the period's entries are a contiguous
  // slice of it and can be bounded rather than scanned.
  const { datedEntries } = usageContext;
  const from = lowerBound(datedEntries, rangeStart.getTime());
  const to = upperBound(datedEntries, rangeEnd.getTime());
  const entries = datedEntries.slice(from, to).map((item: any) => item.entry);

  // Integer hundredths of an hour throughout: float subtraction drifts
  // (0.3 - 0.1 - 0.1 < 0.1) and would split an entry that exactly uses up the
  // allowance into a covered part and a phantom overage of ~1e-17 hours.
  let remainingIncluded = Math.max(0, toHundredths(plan.includedHours));
  let consumedHours = 0;
  let overageHours = 0;
  const coveredTimeEntryIds = [];
  const overageTimeEntryIds = [];
  const overageEntries = [];

  // Entries are date-ordered, so the retainer's included hours are applied to the
  // earliest work first and only the remainder is billed as overage.
  for (const entry of entries) {
    const hours = toHundredths(entry.hours);

    // Wholly within the remaining allowance: covered by the retainer flat fee.
    if (remainingIncluded >= hours) {
      consumedHours += hours;
      remainingIncluded -= hours;
      coveredTimeEntryIds.push(entry.id);
      continue;
    }

    // Otherwise this entry crosses the allowance boundary. If any allowance is
    // left, split the entry: the included hours cover part of it and only the
    // remainder is overage. (The old logic billed the whole entry as overage the
    // moment one didn't fit, forfeiting the leftover allowance AND treating every
    // later entry as overage even when allowance remained, over-charging the
    // client.)
    const overagePortion = hours - remainingIncluded;
    const overagePortionHours = overagePortion / 100;
    if (remainingIncluded > 0) {
      consumedHours += remainingIncluded;
      remainingIncluded = 0;
      coveredTimeEntryIds.push(entry.id);
    }
    overageHours += overagePortion;
    overageTimeEntryIds.push(entry.id);

    const chargeCode = entry.chargeCodeId ? usageContext.chargeCodeMap.get(entry.chargeCodeId) : null;
    // The stored rate when the entry has one (migration 0233), so overage is
    // priced at the rate the work carries rather than today's tiers.
    const rate = billingReads.storedOrLiveRate(entry, () => resolveRateValue({
      entry,
      matterMembers: usageContext.matterMembers,
      clientBillingRates: usageContext.isMatterContext
        ? billingReads.billingRatesForEntry(usageContext.rateClients, entry.matterClientIds)
        : usageContext.clientBillingRates,
      chargeCode,
      memberDefaultRates: usageContext.memberDefaultRates,
      firmDefaultRate: usageContext.firmDefaultRate,
    })) ?? 0;

    overageEntries.push({
      id: entry.id,
      name: entry.name || 'Time entry',
      description: entry.description || undefined,
      rate,
      hours: overagePortionHours,
      // Whole cents, priced like a stored time entry (half up on hundredths of
      // an hour). This figure IS the overage the client is billed.
      amount: fromCents(hourlyAmountCents(overagePortionHours, rate || 0)),
    });
  }

  return {
    includedHours: roundCurrency(plan.includedHours),
    consumedHours: consumedHours / 100,
    overageHours: overageHours / 100,
    coveredTimeEntryIds,
    overageTimeEntryIds,
    overageEntries,
  };
}

/** Usage for a single period, loading the plan's context on the spot. */
async function computePeriodUsage({ lawFirmId, plan, periodStartDate, periodEndDate }: any) {
  const usageContext = await loadPlanUsageContext({
    lawFirmId, plan, loadFirmRates: firmRateLoader(lawFirmId),
  });
  return computeUsageForRange({ plan, usageContext, periodStartDate, periodEndDate });
}

/** Two id lists hold the same ids, order disregarded (the store does not order them). */
function sameIdSet(a: any, b: any) {
  const left = a || [];
  const right = b || [];
  if (left.length !== right.length) return false;
  const seen = new Set(left);
  if (seen.size !== new Set(right).size) return false;
  return right.every((id: any) => seen.has(id));
}

/**
 * Whether a stored period already says exactly what a recomputation would write.
 *
 * Errs toward "different": any value it cannot compare cleanly results in a
 * write, so the worst outcome is the redundant write this exists to avoid, never
 * a stale row.
 */
function periodMatches(existing: any, desired: any) {
  if (!existing) return false;
  const same = (a: any, b: any) => (a ?? null) === (b ?? null);

  // The coverage junction is keyed by (period, time entry), so an entry can hold
  // exactly one coverage there. An entry that straddles the allowance boundary is
  // reported as both covered and overage, and the store keeps only the covered
  // row. Comparing against the raw overage list would therefore never match, and
  // every period holding a straddling entry would be rewritten on every read.
  // What is compared is what a write would actually leave behind.
  const coveredSet = new Set(desired.coveredTimeEntryIds || []);
  const storableOverage = (desired.overageTimeEntryIds || []).filter((id: any) => !coveredSet.has(id));

  return (
    same(existing.periodEndDate, desired.periodEndDate)
    && same(existing.dueDate, desired.dueDate)
    && same(existing.status, desired.status)
    && toNumber(existing.amount) === toNumber(desired.amount)
    && toNumber(existing.includedHours) === toNumber(desired.includedHours)
    && toNumber(existing.consumedHours) === toNumber(desired.consumedHours)
    && toNumber(existing.overageHours) === toNumber(desired.overageHours)
    && same(existing.generatedInvoiceId, desired.generatedInvoiceId)
    && same(existing.generatedInvoiceContextType, desired.generatedInvoiceContextType)
    && same(existing.generatedInvoiceEntityId, desired.generatedInvoiceEntityId)
    && same(iso(existing.generatedAt), iso(desired.generatedAt))
    && sameIdSet(existing.coveredTimeEntryIds, desired.coveredTimeEntryIds)
    && sameIdSet(existing.overageTimeEntryIds, storableOverage)
  );
}

/**
 * Period list order as the store returns it: newest start date first, with rows
 * that carry no start date (only possible for imported rows) leading, which is
 * Postgres's default `order by ... desc` null placement.
 */
function byPeriodStartDesc(a: any, b: any) {
  if (a.id === b.id) return 0;
  if (a.id == null) return -1;
  if (b.id == null) return 1;
  return a.id < b.id ? 1 : -1;
}

async function ensurePlanPeriods({ lawFirmId, plan, loadFirmRates }: any) {
  let workingPlan = plan;
  // Periods open on the firm's day, not the UTC one.
  const today = parseDateOrThrow(localDateFor(await firmZone(lawFirmId)), 'today');
  const loadRates = loadFirmRates || firmRateLoader(lawFirmId);

  // The plan's periods, read once. The loop below used to look each period up
  // individually, which cost a round trip (two, with its coverage rows) for every
  // billing interval the plan had ever run — so the read grew by one lookup per
  // period, forever, for a page that renders them all at once.
  const {
    periods: existingPeriods,
    truncated: periodsTruncated,
  } = await plansRepo.listPeriods(lawFirmId, workingPlan.id);
  const returnedIds = new Set(existingPeriods.map((period: any) => period.id).filter((id: any) => id != null));

  // What the generator checks before writing. Read separately, and only when the
  // generator actually runs, because `listPeriods` is capped and drops a plan's
  // OLDEST periods — exactly the ones a rewound run date walks first. Treating a
  // dropped period as missing would re-create it, recomputing a settled period
  // against a time log its invoice has already emptied.
  let existingPending: any = null;
  const existingByStart = async (fromStartDate: any) => {
    if (!existingPending) {
      existingPending = plansRepo.listPeriodsFrom(lawFirmId, workingPlan.id, fromStartDate)
        .then((rows: any) => {
          const map = new Map();
          for (const period of rows) if (period.id != null) map.set(period.id, period);
          return map;
        });
    }
    return existingPending;
  };

  // Loaded on first use: a plan with nothing to recompute reads nothing.
  let usagePending: any = null;
  const usageContext = () => (
    usagePending || (usagePending = loadPlanUsageContext({ lawFirmId, plan: workingPlan, loadFirmRates: loadRates }))
  );

  // Periods this call resolved: those left untouched, plus those it wrote. Both
  // are store entities, so the list handed back is the same shape either way.
  const written = new Map();
  const unchanged = new Map();
  const pendingWrites = [];

  if ((workingPlan.status || 'active') === 'active') {
    let cursor = parseDateOrThrow(workingPlan.nextRunDate || workingPlan.startDate, 'nextRunDate');
    let advanced = false;
    let generatedThisPass = 0;
    // The generator never looks behind its own run date, so that is where the
    // existence window starts.
    const windowStart = dayKey(cursor);

    // Stop generating once the plan's end date has passed (endCondition 'date');
    // otherwise an 'active' dated plan keeps minting billable periods forever.
    const endBound = (workingPlan.endCondition === 'date' && workingPlan.endDate)
      ? parseDateOrThrow(workingPlan.endDate, 'endDate')
      : null;

    // The plan's original anchor day (e.g. the 31st), so monthly periods return
    // to it in months that have it instead of sticking on the 28th after Feb.
    const anchorDay = parseDateOrThrow(workingPlan.startDate, 'startDate').getUTCDate();
    const unit = workingPlan.intervalUnit;
    const count = workingPlan.intervalCount || 1;

    while (cursor <= today && (!endBound || cursor <= endBound) && generatedThisPass < MAX_PERIODS_PER_PASS) {
      const periodStartDate = dayKey(cursor);
      const periodEndDate = dayKey(getPeriodEnd(cursor, unit, count, anchorDay));
      const dueDate = dayKey(addDays(periodEndDate, workingPlan.defaultDueDays || 0));
      const existing = (await existingByStart(windowStart)).get(periodStartDate) || null;

      // A period that already produced an invoice is a historical record: its
      // included/consumed/overage split is exactly what that invoice was built
      // from. Recomputing it would run against the CURRENT unbilled set, which no
      // longer contains the overage entries — that invoice billed them — so the
      // period would quietly rewrite itself to zero overage and stop matching the
      // invoice it generated. Only open periods are recomputed. (This also skips
      // the per-period fan-out of reads for every settled period.)
      const usage = existing?.generatedInvoiceId
        ? {
            includedHours: existing.includedHours,
            consumedHours: existing.consumedHours,
            overageHours: existing.overageHours,
            coveredTimeEntryIds: Array.isArray(existing.coveredTimeEntryIds) ? existing.coveredTimeEntryIds : [],
            overageTimeEntryIds: Array.isArray(existing.overageTimeEntryIds) ? existing.overageTimeEntryIds : [],
          }
        : computeUsageForRange({
            plan: workingPlan,
            usageContext: await usageContext(),
            periodStartDate,
            periodEndDate,
          });

      const desired = {
        periodStartDate,
        periodEndDate,
        dueDate,
        amount: roundCurrency(workingPlan.amount),
        includedHours: usage.includedHours,
        consumedHours: usage.consumedHours,
        overageHours: usage.overageHours,
        coveredTimeEntryIds: usage.coveredTimeEntryIds,
        overageTimeEntryIds: usage.overageTimeEntryIds,
        status: existing?.generatedInvoiceId
          ? (existing.status || 'draft_created')
          : (existing?.status === 'skipped' ? 'skipped' : 'ready_to_bill'),
        generatedInvoiceId: existing?.generatedInvoiceId || null,
        generatedInvoiceContextType: existing?.generatedInvoiceContextType || null,
        generatedInvoiceEntityId: existing?.generatedInvoiceEntityId || null,
        generatedAt: existing?.generatedAt || null,
      };

      // Materialise only what would actually change. This read has to keep
      // creating periods — nothing else does, and callers (the invoice draft
      // path, the workbench's coverage lookup) require them to exist — but a plan
      // that is already up to date should leave the database untouched rather
      // than rewrite every period, and its coverage rows, on every GET.
      if (periodMatches(existing, desired)) unchanged.set(periodStartDate, existing);
      else pendingWrites.push(desired);

      cursor = addInterval(cursor, unit, count, anchorDay);
      advanced = true;
      generatedThisPass += 1;
    }

    // Periods behind the run date were generated by an earlier read, and work
    // logged or changed since still lands in them. Every such period without an
    // invoice has its usage recomputed, so its consumed hours and coverage follow
    // the time log. A period with an invoice is that invoice's record and stays
    // as written (the upsert skips it too). The set is the capped period read, so
    // it is bounded the same way the period list is.
    for (const period of existingPeriods) {
      const start = period.id;
      if (start == null || start >= windowStart || period.generatedInvoiceId) continue;
      const usage = computeUsageForRange({
        plan: workingPlan,
        usageContext: await usageContext(),
        periodStartDate: start,
        periodEndDate: period.periodEndDate,
      });
      const desired = {
        periodStartDate: start,
        periodEndDate: period.periodEndDate,
        dueDate: period.dueDate,
        amount: period.amount,
        includedHours: usage.includedHours,
        consumedHours: usage.consumedHours,
        overageHours: usage.overageHours,
        coveredTimeEntryIds: usage.coveredTimeEntryIds,
        overageTimeEntryIds: usage.overageTimeEntryIds,
        status: period.status === 'skipped' ? 'skipped' : 'ready_to_bill',
        generatedInvoiceId: null,
        generatedInvoiceContextType: null,
        generatedInvoiceEntityId: null,
        generatedAt: null,
      };
      if (!periodMatches(period, desired)) pendingWrites.push(desired);
    }

    if (pendingWrites.length) {
      const stored = await plansRepo.upsertPeriods(lawFirmId, workingPlan.id, pendingWrites);
      for (const [start, period] of stored) written.set(start, period);
    }
    for (const [start, period] of unchanged) written.set(start, period);

    if (advanced) {
      workingPlan = await plansRepo.update(lawFirmId, workingPlan.id, {
        nextRunDate: cursor,
      });
    }
  }

  // The period list as it now stands, assembled from the single read above plus
  // whatever the loop produced, rather than re-reading the whole set. Every
  // entry is a store entity: an untouched period is the row that was read, and a
  // changed one is what the upsert returned.
  const periods = existingPeriods.map((period: any) => (
    (period.id != null && written.has(period.id)) ? written.get(period.id) : period
  ));
  const created = [];
  for (const [start, period] of written) {
    if (!returnedIds.has(start)) created.push(period);
  }
  if (created.length) {
    periods.push(...created);
    periods.sort(byPeriodStartDesc);
  }

  // `periodsTruncated` rides along so the caller can say the list is partial.
  // Note it describes the READ, not the plan: periods this call materialised are
  // always present regardless, because they were merged in above.
  return { plan: workingPlan, periods, periodsTruncated };
}

export async function listPlans({
  lawFirmId, actingUserId, includePeriods = false, relatedClientId,
}: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  // One accessible-matter read, used both to decide which plans the caller may
  // see and to name them. It was previously read twice per request, once for
  // each of those two uses.
  const [plans, accessibleMatters, firmClients] = await Promise.all([
    plansRepo.findAll(lawFirmId).catch(() => []),
    billingReads.listAccessibleMatters(lawFirmId, actingUserId),
    billingReads.listFirmClients(lawFirmId),
  ]);
  const accessibleMatterIds = new Set(accessibleMatters.map((matter: any) => matter.id));
  const nameMaps = {
    matters: new Map(accessibleMatters.map((matter: any) => [matter.id, matter])),
    clients: new Map(firmClients.map((client: any) => [client.id, client])),
  };

  let visiblePlans = plans.filter((plan: any) => {
    if (plan.contextType === CONTEXT_TYPES.client) return true;
    return accessibleMatterIds.has(plan.entityId);
  });
  if (relatedClientId) {
    const matterPlanIds = visiblePlans
      .filter((plan: any) => plan.contextType === CONTEXT_TYPES.matter)
      .map((plan: any) => plan.entityId);
    const clientsByMatter = await billingReads.listMatterClientsForMatters(lawFirmId, matterPlanIds);
    visiblePlans = visiblePlans.filter((plan: any) =>
      plan.contextType === CONTEXT_TYPES.client
        ? plan.entityId === relatedClientId
        : (clientsByMatter.get(plan.entityId) || []).some((client: any) => client.id === relatedClientId),
    );
  }

  // The firm's rate inputs are the same for every plan and every period, so they
  // are read at most once for the whole request instead of once per period.
  const loadFirmRates = firmRateLoader(lawFirmId);

  const formatted = [];
  for (const rawPlan of visiblePlans) {
    const { plan, periods, periodsTruncated } = await ensurePlanPeriods({ lawFirmId, plan: rawPlan, loadFirmRates });
    const matterRecord = plan.contextType === CONTEXT_TYPES.matter ? nameMaps.matters.get(plan.entityId) : null;
    const clientRecord = plan.contextType === CONTEXT_TYPES.client ? nameMaps.clients.get(plan.entityId) : null;
    const defaultClient = plan.defaultClientId ? nameMaps.clients.get(plan.defaultClientId) : null;

    formatted.push(
      formatPlan(plan, {
        matterRecord,
        clientRecord,
        defaultClient,
        periods: includePeriods ? periods : undefined,
        periodsTruncated: includePeriods ? periodsTruncated : undefined,
      })
    );
  }

  return { plans: formatted };
}

/**
 * Brings the open periods of every plan on one billing context up to date with
 * its time log. Runs after an entry in that context changes, so retainer
 * coverage and the composer's unbilled set agree without waiting for a plan read.
 */
export async function refreshContextPlans({ lawFirmId, contextType, entityId }: any) {
  const plans = (await plansRepo.findAll(lawFirmId))
    .filter((plan: any) => plan.contextType === contextType && plan.entityId === entityId);
  const loadFirmRates = firmRateLoader(lawFirmId);
  for (const plan of plans) {
    await ensurePlanPeriods({ lawFirmId, plan, loadFirmRates });
  }
}

export async function createPlan({ lawFirmId, actingUserId, body }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  await authorizeContext(
    {
      type: body.contextType,
      lawFirmId,
      entityId: body.entityId,
    },
    actingUserId,
  );
  await assertDefaultClient({
    lawFirmId,
    contextType: body.contextType,
    entityId: body.entityId,
    defaultClientId: body.defaultClientId,
  });

  const startDate = parseDateOrThrow(body.startDate, 'startDate');
  const nextRunDate = body.nextRunDate
    ? parseDateOrThrow(body.nextRunDate, 'nextRunDate')
    : startDate;

  const plan = await plansRepo.create(lawFirmId, {
    contextType: body.contextType,
    entityId: body.entityId,
    planType: body.planType || 'retainer',
    name: body.name.trim(),
    status: body.status || 'active',
    intervalUnit: body.intervalUnit,
    intervalCount: body.intervalCount || 1,
    startDate: startDate,
    nextRunDate: nextRunDate,
    amount: roundCurrency(body.amount),
    includedHours: roundCurrency(body.includedHours),
    billingEmail: body.billingEmail || null,
    defaultDueDays: typeof body.defaultDueDays === 'number' ? body.defaultDueDays : 0,
    defaultClientId: body.defaultClientId || null,
    notes: body.notes || null,
    endCondition: body.endCondition || 'manual',
    endDate: body.endDate || null,
    createdBy: actingUserId,
    updatedBy: actingUserId,
  });

  const result = await ensurePlanPeriods({ lawFirmId, plan });
  return {
    message: 'Billing plan created successfully',
    plan: formatPlan(result.plan, { periods: result.periods }),
  };
}

export async function updatePlan({ lawFirmId, planId, actingUserId, body }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const existing = await plansRepo.findById(lawFirmId, planId);
  if (!existing) {
    throw new NotFoundError('Billing plan');
  }

  await authorizeContext(planContext(existing, lawFirmId), actingUserId);
  if (body.defaultClientId !== undefined) {
    await assertDefaultClient({
      lawFirmId,
      contextType: existing.contextType,
      entityId: existing.entityId,
      defaultClientId: body.defaultClientId,
    });
  }

  const updateData: any = {
    updatedBy: actingUserId,
  };

  if (body.name !== undefined) updateData.name = body.name.trim();
  if (body.status !== undefined) updateData.status = body.status;
  if (body.intervalUnit !== undefined) updateData.intervalUnit = body.intervalUnit;
  if (body.intervalCount !== undefined) updateData.intervalCount = body.intervalCount;
  if (body.amount !== undefined) updateData.amount = roundCurrency(body.amount);
  if (body.includedHours !== undefined) updateData.includedHours = roundCurrency(body.includedHours);
  if (body.billingEmail !== undefined) updateData.billingEmail = body.billingEmail || null;
  if (body.defaultDueDays !== undefined) updateData.defaultDueDays = body.defaultDueDays;
  if (body.defaultClientId !== undefined) updateData.defaultClientId = body.defaultClientId || null;
  if (body.notes !== undefined) updateData.notes = body.notes || null;
  if (body.endCondition !== undefined) updateData.endCondition = body.endCondition;
  if (body.endDate !== undefined) updateData.endDate = body.endDate || null;

  if (body.startDate !== undefined) {
    const startDate = parseDateOrThrow(body.startDate, 'startDate');
    updateData.startDate = startDate;
    if (body.nextRunDate === undefined) {
      updateData.nextRunDate = startDate;
    }
  }

  if (body.nextRunDate !== undefined) {
    updateData.nextRunDate = parseDateOrThrow(body.nextRunDate, 'nextRunDate');
  }

  const updated = await plansRepo.update(lawFirmId, planId, updateData);
  const result = await ensurePlanPeriods({ lawFirmId, plan: updated });

  return {
    message: 'Billing plan updated successfully',
    plan: formatPlan(result.plan, { periods: result.periods }),
  };
}

export async function createDraftFromPeriod({ lawFirmId, planId, periodId, actingUserId, timeZone }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const existingPlan = await plansRepo.findById(lawFirmId, planId);
  if (!existingPlan) {
    throw new NotFoundError('Billing plan');
  }

  await authorizeContext(planContext(existingPlan, lawFirmId), actingUserId);
  const ensured = await ensurePlanPeriods({ lawFirmId, plan: existingPlan });
  const plan = ensured.plan;

  // The in-memory hit is the fast path; the direct read is the correct one.
  // A period's `id` IS its start date (see `periodEntity`), which is why this
  // resolves through `findPeriodById` rather than a row-id lookup.
  // `listPeriods` is capped and drops a plan's OLDEST periods, and an old period
  // is exactly what someone catching up on billing draws an invoice from — so
  // resolving this only against the capped list would answer "no such period"
  // for one that plainly exists on screen a moment earlier. The ceiling governs
  // what is displayed, never what can be acted on.
  let period = ensured.periods.find((item: any) => item.id === periodId)
    || await plansRepo.findPeriodById(lawFirmId, planId, periodId);
  if (!period) {
    throw new NotFoundError('Billing plan period');
  }
  // A matter plan bills whichever client the firm named as its payer. With none
  // named the draft would have no client at all: it could not be paid from trust
  // and a payment request would fail on recipients. Refuse now, with the fix.
  if (plan.contextType === CONTEXT_TYPES.matter && !plan.defaultClientId) {
    throw new ValidationError({
      defaultClientId: ['Set a default client on this billing plan before drafting an invoice from it.'],
    });
  }

  if (period.generatedInvoiceId) {
    throw new ValidationError({ periodId: ['An invoice already exists for this period'] });
  }

  if ((period.status || 'ready_to_bill') !== 'ready_to_bill') {
    throw new ValidationError({ periodId: ['This billing period is not ready to invoice yet.'] });
  }

  const usage = await computePeriodUsage({
    lawFirmId,
    plan,
    periodStartDate: period.periodStartDate,
    periodEndDate: period.periodEndDate,
  });

  // A period drafted again after its earlier invoice was voided gets a numbered
  // name and invoice number, because the voided invoice keeps both.
  const baseName = `${plan.name || 'Evergreen Retainer'} ${period.periodStartDate || period.id}`;
  const takenNames = new Set((await invoicesRepo.findByContext(planContext(plan, lawFirmId)))
    .map((inv: any) => String(inv.invoiceName || '').toLowerCase()));
  let revision = 1;
  while (takenNames.has((revision === 1 ? baseName : `${baseName} (${revision})`).toLowerCase())) revision += 1;

  const body = {
    invoiceName: revision === 1 ? baseName : `${baseName} (${revision})`,
    invoiceNumber: revision === 1
      ? buildInvoiceNumber(plan.id, period.id)
      : `${buildInvoiceNumber(plan.id, period.id)}-${revision}`,
    // Today for the person drawing it; the UTC day was tomorrow every evening.
    invoiceDate: await personalToday({ timeZone, userId: actingUserId }),
    dueDate: period.dueDate || null,
    billingEmail: plan.billingEmail || null,
    notes: `${plan.name || 'Retainer'} for ${period.periodStartDate} to ${period.periodEndDate}`,
    clientId: plan.contextType === CONTEXT_TYPES.matter ? plan.defaultClientId : plan.entityId,
    flatFees: [
      {
        id: `plan-${plan.id}-${period.id}`,
        description: plan.name || 'Retainer',
        amount: roundCurrency(plan.amount),
      },
    ],
    timeEntries: usage.overageEntries,
    totalHours: roundCurrency(
      usage.overageEntries.reduce((sum, entry) => sum + toNumber(entry.hours), 0),
    ),
    totalAmount: roundCurrency(
      usage.overageEntries.reduce((sum, entry) => sum + toNumber(entry.amount), 0) + toNumber(plan.amount),
    ),
    flatFeesAmount: roundCurrency(plan.amount),
    billingPlanId: plan.id,
    billingPlanPeriodId: period.id,
    billingPlanName: plan.name || 'Evergreen Retainer',
    billingPlanType: plan.planType || 'retainer',
  };

  const result = plan.contextType === CONTEXT_TYPES.matter
    ? await invoicesService.createInvoice({
        lawFirmId,
        matterId: plan.entityId,
        actingUserId,
        body,
      })
    : await invoicesService.createInvoice({
        lawFirmId,
        clientId: plan.entityId,
        actingUserId,
        body: {
          ...body,
          contextClientId: plan.entityId,
        },
      });

  period = await plansRepo.updatePeriod(lawFirmId, plan.id, period.id, {
    status: 'draft_created',
    generatedInvoiceId: result.invoice.id,
    generatedInvoiceContextType: plan.contextType,
    generatedInvoiceEntityId: plan.entityId,
    generatedAt: new Date(),
  });

  return {
    message: 'Invoice created successfully',
    invoice: result.invoice,
    period: formatPeriod(period),
  };
}

export async function getTimeEntryCoverage({ lawFirmId, actingUserId }: any) {
  const { plans } = await listPlans({ lawFirmId, actingUserId, includePeriods: true });
  const covered = new Set();
  const queued = new Set();

  for (const plan of plans) {
    for (const period of plan.periods || []) {
      for (const id of period.coveredTimeEntryIds || []) {
        covered.add(id);
      }

      if (period.status === 'ready_to_bill') {
        for (const id of period.overageTimeEntryIds || []) {
          queued.add(id);
        }
      }
    }
  }

  return { covered, queued };
}
