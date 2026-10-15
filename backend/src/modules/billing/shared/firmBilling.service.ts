const { assertLawFirmMembership } = require('../../../shared/utils/membership');
const { payLinkUrl } = require('./payLinkUrl');
const { paymentsWithSurcharge } = require('./paymentOutput');
const { CONTEXT_TYPES } = require('../context');
const invoicesRepo = require('../invoices/invoices.repository');
const billingReads = require('./billingReads');
const { resolveRate } = require('./rateResolution');
const { toNumber, roundCurrency, toCents, fromCents, hourlyAmountCents } = require('./money');
const { classifyInvoiceForClient } = require('./clientInvoiceRelation');
const { deriveInvoiceStatus, deriveExpectedPayments, isPastDue, invoiceTotalCents } = require('./invoiceStatus');
const { zonedDayString } = require('../../../shared/utils/time');
const { addDays } = require('../../../shared/utils/localTime');
const { computeInvoiceDerived } = require('./invoiceDerive');
const { toDate, toIso, toDayKey } = require('../../../shared/utils/dateConversion');
const { getFirmBillingSettings, setFirmBillingSettings } = require('./billingSettings');
const firmBillingWindow = require('./firmBillingWindow');
const { isUuid } = require('../../../shared/utils/isUuid');
const {
  resolveEffectiveClientIds,
  resolveBillingEffectiveClientIds,
} = require('../../clients/clientCompanyLinks.util');

/**
 * The one invoice-total rule, in dollars. `invoiceStatus.invoiceTotalCents` is
 * the canonical form; this is the name the firm reads use for it.
 */
export function getInvoiceTotal(invoice: any) {
  return fromCents(invoiceTotalCents(invoice));
}


/**
 * The one past-due rule. `invoiceStatus.isPastDue` is the canonical predicate
 * (integer-cent remaining, calendar days in the viewer's zone, independent of
 * the partial-payment bucket); this is the name the firm reads use for it.
 */
export function isInvoicePastDue(invoice: any, now = new Date(), timeZone = 'UTC') {
  return isPastDue(invoice, now, timeZone);
}

// deriveInvoiceStatus now lives in shared/invoiceStatus.js (single source of
// truth shared with invoices.repository's persisted-status writeback). The
// integer-cent math and overdue rule are identical to the prior inline version.

async function getAccessibleMatters(lawFirmId: string, actingUserId: string) {
  return billingReads.listAccessibleMatters(lawFirmId, actingUserId);
}

async function getFirmClients(lawFirmId: string) {
  return billingReads.listFirmClients(lawFirmId);
}

async function getChargeCodeMap(lawFirmId: string) {
  return billingReads.chargeCodeMap(lawFirmId);
}

/**
 * The name of the client a matter invoice is billed TO, or null when it isn't
 * billed to anyone in particular.
 *
 * Returning null matters: a matter can have several clients, and an invoice that
 * names none of them is a matter-level bill, not that matter's first client's
 * bill. Naming one anyway (as this used to, by falling back to the first name on
 * the matter) puts a payer on the invoice that nobody chose, and the pick shifts
 * as the matter's client list changes. Callers render the ambiguity instead.
 */
function resolveMatterBillingClient(invoice: any, matterClients: any) {
  if (invoice.clientName) return invoice.clientName;

  // invoices.client_id and invoices.matter_client_id both hold a clients.id.
  const billingClientId = invoice.clientId || invoice.matterClientId;
  if (!billingClientId) return null;

  const billingClient = matterClients.find((client: any) => client.id === billingClientId);
  if (!billingClient) return null;

  return billingClient.name || billingClient.email || billingClient.id;
}

async function getTimeEntryCoverage(lawFirmId: string, actingUserId: string) {
  const plansService = (() => {
    try {
      return require('../plans/plans.service');
    } catch {
      return null;
    }
  })();

  if (!plansService?.getTimeEntryCoverage) {
    return { covered: new Set(), queued: new Set() };
  }

  // Coverage is billing-critical. Treating a failed plan read as "no coverage"
  // makes covered or queued work look unbilled and lets it be invoiced twice.
  // Propagate the read failure so the caller shows an error instead.
  return plansService.getTimeEntryCoverage({ lawFirmId, actingUserId });
}

function timeEntryCoverageFromPlans(plans: any) {
  const covered = new Set();
  const queued = new Set();

  for (const plan of plans || []) {
    for (const period of plan.periods || []) {
      for (const id of period.coveredTimeEntryIds || []) covered.add(id);
      if (period.status === 'ready_to_bill') {
        for (const id of period.overageTimeEntryIds || []) queued.add(id);
      }
    }
  }

  return { covered, queued };
}

function mapInvoiceRecord({
  contextType,
  entityId,
  matterRecord,
  clientRecord,
  invoice,
  matterClients = [],
  includeDetails = false,
  now = new Date(),
  timeZone = 'UTC',
}: any) {
  // Shared derivations (recurringPlanFlatFee, totalAmount, remainingBalance,
  // status, billingPlanName, isRecurringRetainer) come from the canonical
  // computeInvoiceDerived helper so this serializer and invoices.service's
  // formatInvoice can't drift. This caller's specifics (toNumber-coerced
  // money fields, the display-rounded remaining balance and split shares)
  // stay inline below.
  const { recurringPlanFlatFee, totalAmount, remainingBalance, status, refundDue, billingPlanName, isRecurringRetainer } =
    computeInvoiceDerived(invoice, now, timeZone);
  const flatFeesAmount = toNumber(invoice.flatFeesAmount);
  const amountPaid = toNumber(invoice.amountPaid);
  const totalWrittenOff = toNumber(invoice.totalWrittenOff);

  return {
    id: invoice.id,
    contextType,
    entityId,
    matterId: matterRecord?.id || null,
    matterName: matterRecord?.name || null,
    matterClientNames: matterRecord?.clientNames || [],
    relatedClientIds: matterClients.map((client: any) => client.id),
    // client_id and matter_client_id both hold a clients.id; either one means the
    // invoice is billed to that specific client. Null means it is a matter-level
    // bill with no single payer.
    clientId: clientRecord?.id || invoice.clientId || invoice.matterClientId || null,
    clientName:
      contextType === CONTEXT_TYPES.matter
        ? resolveMatterBillingClient(invoice, matterClients)
        : (invoice.clientName || clientRecord?.name || clientRecord?.email || null),
    clientEmail: invoice.clientEmail || clientRecord?.email || null,
    invoiceName: invoice.invoiceName || null,
    invoiceNumber: invoice.invoiceNumber || null,
    // invoice_date, due_date and next_payment_date are day-only `date` columns.
    // Serialize them as 'YYYY-MM-DD' (not a UTC-midnight timestamp) so the day the
    // firm chose renders as that same day; toIso would emit ...T00:00:00.000Z, which
    // dayjs renders as the previous day for any viewer behind UTC.
    invoiceDate: toDayKey(invoice.invoiceDate),
    dueDate: toDayKey(invoice.dueDate),
    nextPaymentDate: toDayKey(invoice.nextPaymentDate),
    billingEmail: invoice.billingEmail || null,
    notes: invoice.notes || null,
    totalHours: toNumber(invoice.totalHours),
    totalAmount,
    flatFeesAmount,
    amountPaid,
    totalWrittenOff,
    remainingBalance: roundCurrency(remainingBalance),
    refundDue,
    isPaid: Boolean(invoice.isPaid),
    status,
    createdAt: toIso(invoice.createdAt),
    updatedAt: toIso(invoice.updatedAt),
    splitGroupId: invoice.splitGroupId || null,
    splitMode: invoice.splitMode || null,
    splitRecipientCount: invoice.splitRecipientCount || null,
    splitShareAmount: roundCurrency(invoice.splitShareAmount),
    splitSharePercent: roundCurrency(invoice.splitSharePercent),
    billingPlanId: invoice.billingPlanId || null,
    billingPlanPeriodId: invoice.billingPlanPeriodId || null,
    billingPlanName,
    billingPlanType: invoice.billingPlanType || null,
    isRecurringRetainer,
    stripePaymentRequested: Boolean(invoice.stripePaymentRequested),
    // The installment the open payment link asks for, by its stable id; null
    // for the full balance or when no link is open.
    payLinkInstallmentId: invoice.payLinkInstallmentId || null,
    paymentPlan: deriveExpectedPayments(invoice.paymentPlan, now, timeZone) || null,
    ...(includeDetails ? {
      matterClientId: invoice.matterClientId || null,
      // Bill-to snapshot frozen at first external issue. Detail-only: the list
      // shape stays lean, and only the detail view renders a bill-to block.
      billingEmails: invoice.billingEmails || [],
      billingContactName: invoice.billingContactName || null,
      billingContactTitle: invoice.billingContactTitle || null,
      billingContactEmail: invoice.billingContactEmail || null,
      billingClientAddress: invoice.billingClientAddress || null,
      billingClientName: invoice.billingClientName || null,
      billingSnapshotAt: toIso(invoice.billingSnapshotAt),
      timeEntries: invoice.timeEntries || [],
      flatFees: invoice.flatFees || [],
      expenses: invoice.expenses || [],
      // Derived exactly as `formatInvoice` derives them. The repository row carries
      // `taxCents` and the line items, not these figures; reading them off the row
      // serialised every one of them as 0 and a tax-bearing invoice showed no tax
      // on the matter and client invoice lists.
      expensesAmount: roundCurrency(fromCents((invoice.expenses || []).reduce((sum: number, e: any) => sum + toCents(e.amount), 0))),
      taxRate: invoice.taxRate ?? null,
      taxAmount: roundCurrency(fromCents(Number(invoice.taxCents) || 0)),
      subtotalAmount: roundCurrency(fromCents(toCents(totalAmount) - (Number(invoice.taxCents) || 0))),
      amountAdjustmentNotes: invoice.amountAdjustmentNotes || [],
      paidDate: toIso(invoice.paidDate),
      // Each payment with the processing fee the client paid on top (0 when none).
      payments: paymentsWithSurcharge(invoice.payments),
      creditNotes: invoice.creditNotes || [],
      reminder: invoice.reminder || null,
      auditLog: invoice.auditLog || [],
      stripePaymentStatus: invoice.stripePaymentStatus || null,
      stripePaymentRequestedBy: invoice.stripePaymentRequestedBy || null,
      // The open payment request's link, for the firm to copy and send itself.
      paymentLinkUrl: invoice.stripePaymentRequested && invoice.payLinkToken ? payLinkUrl(invoice.payLinkToken) : null,
      stripeCheckoutSessionId: invoice.stripeCheckoutSessionId || null,
      lastReminderSentAt: toIso(invoice.lastReminderSentAt),
      reminderCount: invoice.reminderCount || 0,
      reminderOptOut: Boolean(invoice.reminderOptOut),
      preDueReminderDays: invoice.preDueReminderDays ?? null,
      preDueReminderSentAt: toIso(invoice.preDueReminderSentAt),
    } : {}),
  };
}

/**
 * BL6: load the firm-wide reads that listFirmInvoices / listFirmTimeEntries /
 * listFirmUnbilledFlatFees all share (accessible matters, firm clients, all
 * invoices grouped by context, matter-clients per matter) ONCE so getBillingWorkbench
 * doesn't trigger them 3× each. Pass the result as the `shared` arg to those
 * functions to reuse it.
 */
export async function loadFirmBillingShared(lawFirmId: string, actingUserId: string, invoicePrefilter: any = {}) {
  const [matters, clients] = await Promise.all([
    getAccessibleMatters(lawFirmId, actingUserId),
    getFirmClients(lawFirmId),
  ]);
  const [invoicesByContext, matterClientsByMatter] = await Promise.all([
    invoicesRepo.findForFirmByContext(lawFirmId, invoicePrefilter),
    billingReads.listMatterClientsForMatters(lawFirmId, matters.map((c: any) => c.id)),
  ]);
  return { matters, clients, invoicesByContext, matterClientsByMatter };
}

/**
 * The firm's invoice list, optionally filtered, ordered and windowed.
 *
 * Which rows survive is decided on the DERIVED records this function builds, not
 * in SQL. The money-bearing fields a filter looks at (effective total, remaining
 * balance, derived status, the client an invoice is billed to) are all computed
 * here from several joined reads, so filtering the derived set keeps one
 * definition of each and lets the server select exactly the rows the UI would
 * have selected itself.
 *
 * What SQL does own is a PRE-filter on the plain columns (`matter_id`,
 * `invoice_date`, and the columns a billed-to client can come from), so a
 * narrowed list stops loading every invoice in the firm just to discard most of
 * them. It is a superset of the real filter and the derived-record pass still
 * runs over whatever it returns, so it can only change how much is read, never
 * which rows come back. It is skipped when a `shared` bundle is supplied (that
 * bundle is reused by other lists with different filters) and when `awaitingOnly`
 * is set, because the due-bucket tiles below summarize the whole awaiting set
 * rather than the narrowed one.
 *
 * Paging is opt-in: with no `limit` the complete list comes back, which is what
 * the billing workbench and the billing summary read. `totalItems` is always the
 * pre-window match count.
 */
export async function listFirmInvoices({
  lawFirmId,
  actingUserId,
  shared,
  timezone,
  page,
  limit,
  offset,
  sort,
  search,
  matterId,
  clientId,
  clientScope,
  billingRelation,
  relatedClientId,
  includeDetails,
  status,
  dateFrom,
  dateTo,
  dueDateFrom,
  dueDateTo,
  dueGroup,
  awaitingOnly,
}: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  // Widen `clientScope` (the client-detail Billing tab's own relationship id)
  // to also include every company the viewed person is linked to via
  // `client_company_links`, gated on that specific link's `can_view_billing`
  // flag. Only the FILTER widens; `scopeClient`/`classifyInvoiceForClient`
  // below keep using the raw `clientScope` id, since "owned by this client"
  // is still relative to the person actually being viewed.
  const clientScopeIds = isUuid(clientScope)
    ? new Set((await resolveBillingEffectiveClientIds(lawFirmId, clientScope)).clientIds)
    : undefined;

  // The due-bucket tiles need every awaiting invoice, so that view reads the
  // whole set and lets the derived-record filter do all the narrowing.
  const invoicePrefilter = awaitingOnly ? {} : { matterId, clientId, dateFrom, dateTo };

  const { matters, clients, invoicesByContext, matterClientsByMatter } =
    shared || await loadFirmBillingShared(lawFirmId, actingUserId, invoicePrefilter);
  const { byMatter, byClient } = invoicesByContext;

  // Each row's status is judged on the viewer's calendar day, like the chips and
  // filters below.
  const viewNow = new Date();
  const viewZone = timezone || 'UTC';

  const matterInvoices = matters.map((matterRecord: any) =>
    (byMatter.get(matterRecord.id) || []).map((invoice: any) =>
      mapInvoiceRecord({
        contextType: CONTEXT_TYPES.matter,
        entityId: matterRecord.id,
        matterRecord,
        invoice,
        matterClients: matterClientsByMatter.get(matterRecord.id) || [],
        includeDetails,
        now: viewNow,
        timeZone: viewZone,
      })
    )
  );

  const clientInvoices = clients.map((clientRecord: any) =>
    (byClient.get(clientRecord.id) || []).map((invoice: any) =>
      mapInvoiceRecord({
        contextType: CONTEXT_TYPES.client,
        entityId: clientRecord.id,
        clientRecord,
        invoice,
        includeDetails,
        now: viewNow,
        timeZone: viewZone,
      })
    )
  );

  const records = [...matterInvoices.flat(), ...clientInvoices.flat()];

  // Attach this client's view of each invoice. Only meaningful when the caller
  // asked for one client's scope; without `clientScope` there is no "this client"
  // to be owned BY, so the fields stay off rather than being filled with a
  // misleading default.
  if (clientScope) {
    const scopeClient = clients.find((c: any) => c.id === clientScope) || { id: clientScope };
    for (const record of records) {
      const matterClients = record.matterId
        ? (matterClientsByMatter.get(record.matterId) || [])
        : [];
      record._scopeMatterClientIds = matterClients.map((mc: any) => mc.id);
      Object.assign(record, classifyInvoiceForClient({
        invoice: record,
        source: record.contextType === CONTEXT_TYPES.client ? 'direct' : 'matter',
        matterClients,
        currentClient: scopeClient,
      }));
    }
  }

  // Calendar-day comparisons ("overdue", "due within 30 days", the due buckets)
  // roll over at the VIEWER's midnight, so they are computed against the viewer's
  // current day rather than the server's UTC day.
  const todayDay = zonedDayString(new Date(), timezone || 'UTC');

  const filtered = firmBillingWindow.filterInvoices(records, {
    search, matterId, clientId, clientScope: clientScopeIds, billingRelation, relatedClientId,
    status, dateFrom, dateTo, dueDateFrom, dueDateTo, dueGroup, awaitingOnly, todayDay,
  });

  const comparator =
    firmBillingWindow.resolveComparator(sort, firmBillingWindow.INVOICE_COMPARATORS, todayDay)
    || firmBillingWindow.resolveComparator(
      'createdAt:desc',
      firmBillingWindow.INVOICE_COMPARATORS,
      todayDay,
    );
  filtered.sort(comparator);

  const { items, totalItems } = firmBillingWindow.windowList(filtered, { limit, offset, page });

  // Chip counts for the list's status filter. Computed over the SCOPE only —
  // matter / client — deliberately excluding `status` itself, so selecting a chip
  // doesn't zero out every other chip and strand the reader with no way back.
  const scopeFiltered = firmBillingWindow.filterInvoices(records, {
    matterId, clientId, clientScope: clientScopeIds, relatedClientId, todayDay,
  });

  const result: any = {
    invoices: items,
    totalItems,
    statusCounts: firmBillingWindow.countInvoiceStatuses(scopeFiltered, todayDay),
    summary: firmBillingWindow.summarizeOwnedInvoices(scopeFiltered),
  };
  if (awaitingOnly) {
    // Bucket counts and outstanding totals for the upcoming-payments tiles. They
    // summarize every invoice still awaiting payment, independent of the search /
    // matter / client / bucket filters narrowing the rows below them, so they
    // cannot be derived from the returned page.
    result.dueGroupTotals = firmBillingWindow.dueGroupTotals(
      firmBillingWindow.filterInvoices(records, { awaitingOnly: true, todayDay }),
      todayDay,
    );
  }
  return result;
}

/**
 * Firm-wide invoice money records for the billing SUMMARY / accounts-receivable
 * totals.
 *
 * listFirmInvoices builds full display records only for the acting user's
 * accessible matters (plus all client-context invoices). That per-user scoping
 * is right for a personal work list, but WRONG for a firm accounts-receivable
 * total: the firm is owed money on every matter, not just the ones the caller is
 * a member of. Deriving A/R from the accessible-matters subset silently drops
 * every other attorney's outstanding balances and undercounts the firm's books.
 *
 * This derives just the monetary fields (enough for the summary aggregates and
 * the past-due predicate) for EVERY invoice the firm has — matter- and
 * client-context alike — from invoicesByContext, which findForFirmByContext
 * already scopes by law_firm_id only. No matter/membership filter is applied.
 */
export function firmInvoiceMoneyRecords(invoicesByContext: any) {
  const { byMatter, byClient } = invoicesByContext;
  const records = [];
  for (const group of [byMatter, byClient]) {
    for (const invoiceList of group.values()) {
      for (const invoice of invoiceList) {
        const { totalAmount, remainingBalance, status } = computeInvoiceDerived(invoice);
        records.push({
          id: invoice.id,
          totalAmount,
          flatFeesAmount: toNumber(invoice.flatFeesAmount),
          amountPaid: toNumber(invoice.amountPaid),
          totalWrittenOff: toNumber(invoice.totalWrittenOff),
          remainingBalance: roundCurrency(remainingBalance),
          isPaid: Boolean(invoice.isPaid),
          status,
          dueDate: toDayKey(invoice.dueDate),
          nextPaymentDate: toDayKey(invoice.nextPaymentDate),
          invoiceDate: toDayKey(invoice.invoiceDate),
          createdAt: toIso(invoice.createdAt),
        });
      }
    }
  }
  return records;
}

function resolveTimeEntryRate({ entry, matterRecord, clientRecord, chargeCodes, memberDefaultRates, firmDefaultRate }: any) {
  const chargeCode = entry.chargeCodeId ? chargeCodes.get(entry.chargeCodeId) : null;
  const { rate, source } = resolveRate({
    entry,
    matterMembers: matterRecord?.members,
    clientBillingRates: clientRecord?.billingRates,
    chargeCode,
    memberDefaultRates,
    firmDefaultRate,
  });
  return source === 'none' ? null : rate;
}

/**
 * The firm's time-entry list, optionally filtered, ordered and windowed.
 *
 * Like listFirmInvoices, the filters run on the DERIVED records rather than in
 * SQL. `hourlyRate`, `amount` and especially `billingStatus` (which depends on the
 * invoice line items, retainer coverage and draft queue) are resolved here from
 * several joined reads, so filtering the derived set is what keeps a filtered page
 * consistent with an unfiltered one. Pushing the filters into SQL
 * (`billingReads.listTimeEntriesForFirm`) remains available as a later
 * optimization, at the cost of re-expressing that derivation in the query.
 *
 * Paging is opt-in: with no `limit` the complete list comes back, which is what
 * the billing workbench and the billing summary read. `totalItems` is always the
 * pre-window match count.
 */
export async function listFirmTimeEntries({
  lawFirmId,
  actingUserId,
  shared,
  page,
  limit,
  offset,
  sort,
  search,
  context,
  matterId,
  clientId,
  clientScope,
  userId,
  chargeCodeId,
  billingStatus,
  dateFrom,
  dateTo,
  coverage: suppliedCoverage,
}: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  // Widen `clientScope` (the client-detail Time Tracking tab's own relationship
  // id) to also include every company the viewed person is linked to via
  // `client_company_links`. Unlike Billing, Time Tracking is not billing-
  // sensitive, so it widens unconditionally rather than gating on
  // `can_view_billing`.
  const clientScopeIds = isUuid(clientScope)
    ? new Set((await resolveEffectiveClientIds(lawFirmId, clientScope)).clientIds)
    : undefined;

  // BL6: reuse the shared firm reads (matters/clients/invoices/matter-clients) when
  // provided by getBillingWorkbench; only fetch the time-entry-specific extras.
  const sharedReads = shared || await loadFirmBillingShared(lawFirmId, actingUserId);
  const { matters, clients, invoicesByContext, matterClientsByMatter } = sharedReads;
  const { byMatter: invByMatter, byClient: invByClient } = invoicesByContext;

  // Column-only narrowing, pushed into the entries read so a filtered list stops
  // loading the firm's entire time log. A superset of the real filter (the
  // derived-record pass below still runs), and skipped when a shared bundle is in
  // play so the workbench's unfiltered reads are unaffected.
  const entryPrefilter = shared ? {} : { matterId, userId, chargeCodeId, dateFrom, dateTo, context };

  // Staged so this list never holds more than three pool connections at once.
  // Computing coverage reads the firm's plans (up to three reads in parallel), so
  // when it is not supplied it runs on its own rather than beside the entries.
  const [chargeCodes, firmDefaultRate, memberDefaultRates] = await Promise.all([
    getChargeCodeMap(lawFirmId),
    billingReads.firmDefaultRate(lawFirmId),
    billingReads.memberDefaultRates(lawFirmId),
  ]);
  const coverage = suppliedCoverage || await getTimeEntryCoverage(lawFirmId, actingUserId);
  const { byMatter: teByMatter, byClient: teByClient } = await billingReads.listTimeEntriesForFirm(lawFirmId, entryPrefilter);

  const chargeCodeLabel = (id: any) => (id
    ? `${chargeCodes.get(id)?.code || ''} - ${chargeCodes.get(id)?.name || ''}`.trim()
    : null);

  const matterEntries = matters.map((matterRecord: any) => {
      const entries = teByMatter.get(matterRecord.id) || [];
      const invoices = invByMatter.get(matterRecord.id) || [];
      const matterClients = matterClientsByMatter.get(matterRecord.id) || [];

      const billedIds = billingReads.collectBilledIds(invoices).timeEntryIds;
      const billingClientRecord = matterClients[0] || null;
      const matterClientNames = matterClients.map((c: any) => c.name || c.email || c.id).filter(Boolean);

      return entries.map((entry: any) => {
        // The stored rate when the entry has one (migration 0233); live
        // resolution only for a row nothing has rated yet.
        const hourlyRate = billingReads.storedOrLiveRate(entry, () => (typeof entry.hourlyRate === 'number'
          ? entry.hourlyRate
          : resolveTimeEntryRate({ entry, matterRecord, clientRecord: billingClientRecord, chargeCodes, memberDefaultRates, firmDefaultRate })));

        let billingStatus = 'unbilled';
        if (billingReads.isBilled(billedIds, entry)) billingStatus = 'billed';
        else if (coverage.covered.has(entry.id)) billingStatus = 'covered_by_retainer';
        else if (coverage.queued.has(entry.id)) billingStatus = 'queued';

        return {
          id: entry.id,
          contextType: CONTEXT_TYPES.matter,
          entityId: matterRecord.id,
          matterId: matterRecord.id,
          // Which of the matter's clients this entry is billed to, when the
          // logger picked one (clients.id values). Empty means the entry is
          // matter-level work with no single payer, so callers must not charge
          // it to one client. `clientNames` below is every client ON the matter,
          // which is context, not attribution.
          matterClientId: entry.matterClientId || null,
          matterClientIds: Array.isArray(entry.matterClientIds) ? entry.matterClientIds : [],
          matterName: matterRecord.name || null,
          clientId: null,
          clientName: null,
          clientNames: matterClientNames.length > 0 ? matterClientNames : (matterRecord.clientNames || []),
          matterClients: matterClients.map((client: any) => ({
            id: client.id,
            name: client.name || client.email || client.id,
          })),
          userId: entry.userId || '',
          userName: entry.userName || '',
          hours: toNumber(entry.hours),
          date: entry.date,
          name: entry.name || '',
          description: entry.description || '',
          chargeCodeId: entry.chargeCodeId || null,
          sourceTaskId: entry.sourceTaskId || null,
          sourceTaskTitle: entry.sourceTaskTitle || null,
          sourceEventId: entry.sourceEventId || null,
          sourceEventTitle: entry.sourceEventTitle || null,
          billable: entry.billable !== false,
          chargeCodeName: entry.chargeCodeId ? chargeCodes.get(entry.chargeCodeId)?.name || null : null,
          chargeCodeLabel: chargeCodeLabel(entry.chargeCodeId),
          hourlyRate,
          // Priced like the stored time entry amount (half up on hundredths of an hour).
          amount: hourlyRate === null ? null : fromCents(hourlyAmountCents(entry.hours, hourlyRate)),
          billingStatus,
          createdAt: null,
          updatedAt: null,
        };
      });
  });

  const clientEntries = clients.map((clientRecord: any) => {
      const entries = teByClient.get(clientRecord.id) || [];
      const invoices = invByClient.get(clientRecord.id) || [];

      const billedIds = billingReads.collectBilledIds(invoices).timeEntryIds;

      return entries.map((entry: any) => {
        const chargeCode = entry.chargeCodeId ? chargeCodes.get(entry.chargeCodeId) : null;
        const hourlyRate = billingReads.storedOrLiveRate(entry, () => (typeof entry.hourlyRate === 'number'
          ? entry.hourlyRate
          : resolveTimeEntryRate({ entry, clientRecord, chargeCodes, memberDefaultRates, firmDefaultRate })));

        let billingStatus = 'unbilled';
        if (billingReads.isBilled(billedIds, entry)) billingStatus = 'billed';
        else if (coverage.covered.has(entry.id)) billingStatus = 'covered_by_retainer';
        else if (coverage.queued.has(entry.id)) billingStatus = 'queued';

        return {
          id: entry.id,
          contextType: CONTEXT_TYPES.client,
          entityId: clientRecord.id,
          matterId: null,
          matterClientId: null,
          matterName: null,
          clientId: clientRecord.id,
          clientName: clientRecord.name || clientRecord.email || clientRecord.id,
          clientNames: [clientRecord.name || clientRecord.email || clientRecord.id],
          matterClients: [],
          userId: entry.userId || '',
          userName: entry.userName || '',
          hours: toNumber(entry.hours),
          date: entry.date,
          name: entry.name || '',
          description: entry.description || '',
          chargeCodeId: entry.chargeCodeId || null,
          sourceTaskId: entry.sourceTaskId || null,
          sourceTaskTitle: entry.sourceTaskTitle || null,
          sourceEventId: entry.sourceEventId || null,
          sourceEventTitle: entry.sourceEventTitle || null,
          billable: entry.billable !== false,
          chargeCodeName: chargeCode?.name || null,
          chargeCodeLabel: chargeCodeLabel(entry.chargeCodeId),
          hourlyRate: typeof hourlyRate === 'number' ? hourlyRate : null,
          // Priced like the stored time entry amount (half up on hundredths of an hour).
          amount: typeof hourlyRate === 'number' ? fromCents(hourlyAmountCents(entry.hours, hourlyRate)) : null,
          billingStatus,
          createdAt: null,
          updatedAt: null,
        };
      });
  });

  const records = [...matterEntries.flat(), ...clientEntries.flat()];

  const filtered = firmBillingWindow.filterTimeEntries(records, {
    search, context, matterId, clientId, clientScope: clientScopeIds, userId, chargeCodeId, billingStatus, dateFrom, dateTo,
  });

  const comparator =
    firmBillingWindow.resolveComparator(sort, firmBillingWindow.TIME_ENTRY_COMPARATORS)
    || firmBillingWindow.resolveComparator('date:desc', firmBillingWindow.TIME_ENTRY_COMPARATORS);
  filtered.sort(comparator);

  // Totals over the whole match set, NOT the page. A caller that windows this
  // list still shows the hours and value of everything the filters matched, so a
  // matter's "42.5 hrs / $12,750" doesn't silently become the first ten rows'
  // worth the moment the list is paged. Summed in whole cents and converted once,
  // so a long list can't accumulate float drift into the figure a firm bills on.
  let totalHours = 0;
  let totalAmountCents = 0;
  for (const record of filtered) {
    totalHours += toNumber(record.hours);
    if (typeof record.amount === 'number') totalAmountCents += toCents(record.amount);
  }

  const { items, totalItems } = firmBillingWindow.windowList(filtered, { limit, offset, page });
  return {
    timeEntries: items,
    totalItems,
    summary: {
      totalHours: roundCurrency(totalHours),
      totalAmount: fromCents(totalAmountCents),
    },
  };
}

export async function listFirmUnbilledFlatFees({ lawFirmId, actingUserId, shared }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  // BL6: reuse the shared firm reads (matters/clients/invoices) when provided.
  const { matters, clients, invoicesByContext } =
    shared || await loadFirmBillingShared(lawFirmId, actingUserId);
  const { byMatter: invByMatter, byClient: invByClient } = invoicesByContext;

  const { byMatter: ffByMatter, byClient: ffByClient } = await billingReads.listFlatFeesForFirm(lawFirmId);

  const matterFees = matters.map((matterRecord: any) => {
      const fees = ffByMatter.get(matterRecord.id) || [];
      const invoices = invByMatter.get(matterRecord.id) || [];

      const billedIds = billingReads.collectBilledIds(invoices).flatFeeIds;

      return fees
        .filter((fee: any) => !billingReads.isBilled(billedIds, fee))
        .map((fee: any) => ({
          id: fee.id,
          itemType: 'flat_fee',
          contextType: CONTEXT_TYPES.matter,
          entityId: matterRecord.id,
          matterId: matterRecord.id,
          matterName: matterRecord.name || null,
          clientId: null,
          // A matter fee carries no client of its own: `activities` holds exactly
          // one of matter_id and client_id. The first client by name is a
          // placeholder the invoice composer replaces when the firm picks a payer.
          clientName: matterRecord.clientNames?.[0] || null,
          description: fee.description || 'Flat fee',
          amount: roundCurrency(fee.amount),
          date: fee.date,
        }));
  });

  const clientFees = clients.map((clientRecord: any) => {
      const fees = ffByClient.get(clientRecord.id) || [];
      const invoices = invByClient.get(clientRecord.id) || [];

      const billedIds = billingReads.collectBilledIds(invoices).flatFeeIds;

      return fees
        .filter((fee: any) => !billingReads.isBilled(billedIds, fee))
        .map((fee: any) => ({
          id: fee.id,
          itemType: 'flat_fee',
          contextType: CONTEXT_TYPES.client,
          entityId: clientRecord.id,
          matterId: null,
          matterName: null,
          clientId: clientRecord.id,
          clientName: clientRecord.name || clientRecord.email || clientRecord.id,
          description: fee.description || 'Flat fee',
          amount: roundCurrency(fee.amount),
          date: toIso(fee.date || fee.createdAt),
        }));
  });

  return { flatFees: [...matterFees.flat(), ...clientFees.flat()] };
}

/**
 * Completed work the firm has not logged time against yet.
 *
 * Paging is opt-in, like every other billing list: with no `limit` the whole set
 * comes back. `summary` is always computed over the COMPLETE set, so the "N open"
 * badge counts the firm's real backlog rather than the page beneath it.
 */
export async function listFirmUnbilledWork({ lawFirmId, actingUserId, page, limit, offset }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const tasksRepo = require('../../tasks/tasks.repository');

  // Run one at a time, so this list holds exactly one pool connection for the
  // whole request. Every request on an instance shares one 12-connection pool
  // against a Supabase pooler that allows 15 in total, and this list is fetched
  // beside the workbench on the same screen, so a flat four-way read let two
  // users on the billing page hold more than half the pool between them.
  //
  // Three reads is few enough to serialize. The accessible-matter read used to
  // be the fourth and the second-slowest (two sequential round trips: the
  // owner/admin check, then the names), and nothing below consumed it: a task's
  // matter id and matter name come from the task read's own `matters` join. It
  // was also not the matter wall. `findVisibleToUser` is called without
  // `seeAll`, so it applies `matter_id is null or exists (matter_members …)` in
  // SQL itself; the accessible-matter list is WIDER than that for an owner or
  // admin, so filtering through it could only ever have added rows.
  const tasks = await tasksRepo.findVisibleToUser(lawFirmId, actingUserId, { status: 'completed' });
  const capturedSourceIds = await billingReads.listCapturedWorkSourceIds(lawFirmId);
  const clients = await getFirmClients(lawFirmId);

  const clientNameMap = new Map(
    clients.map((clientRecord: any) => [clientRecord.id, clientRecord.name || clientRecord.email || clientRecord.id])
  );

  // NOTE: matter-event-sourced work is omitted until the calendar (matterEvents)
  // module is ported to Postgres.
  //
  // A completed task drops off this list once any time entry points back at it,
  // otherwise every task the firm has already captured time for would sit here
  // forever and invite double-billing. The completed-status half of that pair runs
  // in SQL (see the `status` argument above) because it discards ~90% of the rows;
  // the captured-id half stays here, since it is a set membership test against a
  // separately loaded id set rather than a column predicate.
  const taskItems = tasks
    .filter((task: any) => !capturedSourceIds.taskIds.has(task.id))
    .map((task: any) => {
      const clientId = Array.isArray(task.clientIds) && task.clientIds.length > 0 ? task.clientIds[0] : null;
      return {
        id: `task:${task.id}`,
        workType: 'task',
        taskId: task.id,
        eventId: null,
        title: task.title || 'Untitled task',
        details: task.description || '',
        matterId: task.matterId || null,
        matterName: task.matterName || null,
        clientId,
        clientName: clientId ? task.clientNames?.[0] || clientNameMap.get(clientId) || null : null,
        date: toIso(task.updatedAt || task.dueDate || task.createdAt),
        sourceLabel: 'Completed task',
      };
    });

  const items = [...taskItems].sort((a, b) => {
    const dateA = toDate(a.date)?.getTime() || 0;
    const dateB = toDate(b.date)?.getTime() || 0;
    return dateB - dateA;
  });

  const { items: windowed, totalItems } = firmBillingWindow.windowList(items, { limit, offset, page });

  return {
    summary: { totalCount: items.length, taskCount: taskItems.length, eventCount: 0 },
    items: windowed,
    totalItems,
  };
}

/**
 * The workbench's "needs attention" list: every overdue invoice, then every
 * recurring-plan period ready to bill, then every other ready-to-bill item.
 *
 * The order is deliberate and belongs on the server. The client used to receive
 * the three source arrays whole and concatenate them in this order itself, which
 * meant a firm's ENTIRE unbilled backlog crossed the wire to render a five-row
 * paged list. Building the list here lets the response carry one page of it.
 *
 * Within each group the sort matches what the client applied: biggest outstanding
 * balance first for overdue, soonest due first for plan periods, largest amount
 * first for the rest.
 */
function buildAttentionRows({ overdue, readyItems }: any) {
  const overdueRows = [...overdue]
    .sort((a, b) => (b.remainingBalance ?? 0) - (a.remainingBalance ?? 0))
    .map((item) => ({ kind: 'overdue', key: `overdue:${item.contextType}:${item.id}`, item }));

  const planRows = readyItems
    .filter((item: any) => item.itemType === 'plan_period')
    .sort((a: any, b: any) => (a.date ?? '').localeCompare(b.date ?? ''))
    .map((item: any) => ({ kind: 'plan', key: `plan:${item.id}`, item }));

  const billRows = readyItems
    .filter((item: any) => item.itemType !== 'plan_period')
    .sort((a: any, b: any) => (b.amount ?? -1) - (a.amount ?? -1))
    .map((item: any) => ({ kind: 'unbilled', key: `bill:${item.id}`, item }));

  return [...overdueRows, ...planRows, ...billRows];
}

/**
 * @param {object} args
 * @param {number} [args.attentionLimit] - rows of the attention list to return.
 *   Opt-in like every other paged read here: omit it and the whole list comes
 *   back, which is what an export or a direct API caller wants. The UI always
 *   passes one.
 */
export async function getBillingWorkbench({ lawFirmId, actingUserId, timezone, attentionPage, attentionLimit, attentionOffset }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const tz = timezone || 'UTC';

  const plansService = (() => {
    try {
      return require('../plans/plans.service');
    } catch {
      return null;
    }
  })();

  // Load the shared billing records and plan periods in parallel. The same plan
  // result supplies both the workbench cards and time-entry coverage, avoiding a
  // second listPlans traversal inside listFirmTimeEntries.
  //
  // Run one after the other rather than together: each already runs its own reads
  // in parallel (two, then up to three), and the instance pool is small and
  // shared by every concurrent request, so the workbench never holds more than
  // three connections at once.
  const shared = await loadFirmBillingShared(lawFirmId, actingUserId);
  const plansResult = plansService?.listPlans
    ? await plansService.listPlans({ lawFirmId, actingUserId, includePeriods: true })
    : { plans: [] };
  const plans = plansResult.plans || [];
  const coverage = timeEntryCoverageFromPlans(plans);

  // No `limit` on either list read, so both return the firm's COMPLETE set: the
  // workbench aggregates over all of it (overdue / due-soon buckets, unbilled
  // hours, ready-to-bill items) and must never see a page.
  //
  // The invoice and flat-fee lists hold one connection each, so they share a
  // stage; the time-entry list runs up to three reads of its own, so it follows.
  const [firmInvoicesResult, unbilledFlatFeesResult] = await Promise.all([
    listFirmInvoices({ lawFirmId, actingUserId, shared, timezone: tz }),
    listFirmUnbilledFlatFees({ lawFirmId, actingUserId, shared }),
  ]);
  const firmTimeEntriesResult = await listFirmTimeEntries({ lawFirmId, actingUserId, shared, coverage });

  const invoices = firmInvoicesResult.invoices || [];
  const timeEntries = firmTimeEntriesResult.timeEntries || [];
  const flatFees = unbilledFlatFeesResult.flatFees || [];
  const now = new Date();
  const inSevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const overdue = invoices.filter((invoice: any) => isInvoicePastDue(invoice, now, tz));
  // Compare calendar days in the VIEWER's timezone, same as `isInvoicePastDue`
  // right above - not the server's. `startOfDay`/`getInvoiceDueDate` used to
  // read the server process's local calendar day instead, so this bucket's
  // 0-7-day window silently rolled at the wrong instant (or the wrong DAY
  // entirely) for any recipient whose zone differs from the server's.
  const todayDay = zonedDayString(now, tz);
  const dueSoonCutoffDay = todayDay ? addDays(todayDay, 7) : null;
  const dueSoon = invoices.filter((invoice: any) => {
    // A voided invoice is not past due (isInvoicePastDue already says so), but its
    // due day still falls in the window, so it has to be excluded by name.
    if (invoice.status === 'voided' || isInvoicePastDue(invoice, now, tz) || invoice.isPaid) return false;
    // An invoice nothing is owed on (a write-off cleared it) is not coming due.
    if (!(toCents(invoice.remainingBalance) > 0)) return false;
    // An invoice that owes nothing has nothing coming due.
    if (!(toCents(invoice.remainingBalance) > 0)) return false;
    const dueDateValue = invoice.nextPaymentDate || invoice.dueDate;
    if (!dueDateValue) return false;
    const dueDay = zonedDayString(dueDateValue, tz);
    return Boolean(dueDay && todayDay && dueSoonCutoffDay && dueDay >= todayDay && dueDay <= dueSoonCutoffDay);
  });
  const partiallyPaid = invoices.filter(
    (invoice: any) => invoice.status === 'partially_paid' && !isInvoicePastDue(invoice, now, tz)
  );

  const readyTimeEntries = timeEntries
    .filter((entry: any) => entry.billingStatus === 'unbilled' && entry.billable !== false)
    .map((entry: any) => ({
      id: entry.id,
      itemType: 'time_entry',
      contextType: entry.contextType,
      entityId: entry.entityId,
      matterId: entry.matterId,
      matterName: entry.matterName,
      clientId: entry.clientId,
      clientName: entry.clientName || entry.clientNames?.[0] || null,
      description: entry.name || entry.description || 'Time entry',
      amount: entry.amount,
      hours: entry.hours,
      date: entry.date,
      timeEntryId: entry.id,
    }));

  const readyPlanItems = [];
  for (const plan of plans) {
    for (const period of plan.periods || []) {
      if (period.status !== 'ready_to_bill') continue;
      readyPlanItems.push({
        id: `${plan.id}:${period.id}`,
        itemType: 'plan_period',
        contextType: plan.contextType,
        entityId: plan.entityId,
        matterId: plan.contextType === CONTEXT_TYPES.matter ? plan.entityId : null,
        matterName: plan.matterName || null,
        clientId: plan.contextType === CONTEXT_TYPES.client ? plan.entityId : (plan.defaultClientId || null),
        clientName: plan.clientName || null,
        description: `${plan.name || 'Retainer'} (${period.periodStartDate} - ${period.periodEndDate})`,
        amount: roundCurrency(period.amount),
        hours: roundCurrency(period.overageHours || 0),
        date: period.dueDate || period.periodEndDate,
        planId: plan.id,
        periodId: period.id,
      });
    }
  }

  const readyItems = [...readyTimeEntries, ...flatFees, ...readyPlanItems].sort((a, b) => {
    const dateA = toDate(a.date)?.getTime() || 0;
    const dateB = toDate(b.date)?.getTime() || 0;
    return dateB - dateA;
  });

  // Summed here, over the COMPLETE ready set, because the response only carries a
  // page of it. The client used to add these up itself from the full array.
  const readyToBillAmount = fromCents(
    readyItems.reduce((sum, item) => sum + toCents(item.amount), 0),
  );

  const attentionRows = buildAttentionRows({ overdue, readyItems });
  const { items: attentionItems, totalItems: attentionTotal } = firmBillingWindow.windowList(
    attentionRows,
    { limit: attentionLimit, offset: attentionOffset, page: attentionPage },
  );

  const unbilledHours = readyTimeEntries.reduce((sum: any, entry: any) => sum + toNumber(entry.hours), 0);
  // Accounting headlines remain firm-wide even when the caller's row list is
  // restricted by matter access. Reuse the already-loaded firm invoice payload
  // instead of deriving these totals from the member-scoped display records.
  const firmMoneyInvoices = firmInvoiceMoneyRecords(shared.invoicesByContext);
  // A voided invoice is cancelled: it carries no money in either direction, but
  // it is still a row in the invoice list, so it stays in `totalInvoices`.
  const liveMoneyInvoices = firmMoneyInvoices.filter((invoice) => invoice.status !== 'voided');
  const awaiting = liveMoneyInvoices.filter(
    (invoice) => firmBillingWindow.isAwaitingPayment(invoice),
  );
  // Non-billable time is written off, so it is not work waiting for an invoice.
  const uninvoicedTimeEntries = timeEntries.filter(
    (entry: any) => entry.billable !== false
      && ['unbilled', 'queued', 'covered_by_retainer'].includes(entry.billingStatus),
  );
  const activePlans = plans.filter((plan: any) => plan.status === 'active');
  const plansReadyThisWeek = readyPlanItems.filter((item) => {
    const date = toDate(item.date);
    return date && date <= inSevenDays;
  }).length;

  return {
    summary: {
      // BL #3: sum each invoice's remaining balance in whole cents, convert once.
      overdueAmount: fromCents(overdue.reduce((sum: any, invoice: any) => sum + toCents(invoice.remainingBalance), 0)),
      overdueCount: overdue.length,
      readyToBillCount: readyItems.length,
      readyToBillAmount,
      activePlanCount: activePlans.length,
      plansReadyThisWeek,
      unbilledHours: roundCurrency(unbilledHours),
      awaitingCount: awaiting.length,
      awaitingAmount: fromCents(awaiting.reduce(
        (sum, invoice) => sum + toCents(invoice.remainingBalance),
        0,
      )),
      totalCollected: fromCents(liveMoneyInvoices.reduce(
        (sum, invoice) => sum + toCents(invoice.amountPaid),
        0,
      )),
      totalInvoices: firmMoneyInvoices.length,
      uninvoicedTimeEntryCount: uninvoicedTimeEntries.length,
    },
    // The prioritized to-do list the overview renders, already ordered and
    // windowed. `totalItems` is the pre-window count, so the "N need attention"
    // badge and the pager still describe the whole backlog.
    attention: {
      rows: attentionItems,
      totalItems: attentionTotal,
    },
    // Counts only. These three arrays were the bulk of a response that reached
    // ~100 MB on a firm with a large unbilled backlog: nothing reads their
    // contents, and `attention.rows` carries the overdue invoices that are
    // actually rendered.
    collections: {
      overdueCount: overdue.length,
      dueSoonCount: dueSoon.length,
      partiallyPaidCount: partiallyPaid.length,
    },
    plans,
  };
}

/**
 * Read the per-firm billing settings (defaults merged with stored overrides).
 * Currently just `clientPaymentEmails` (client receipt/refund emails toggle).
 */
export async function getBillingSettings({ lawFirmId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  return { settings: await getFirmBillingSettings(lawFirmId) };
}

/**
 * Update the per-firm billing settings. Only known keys are applied; unknown
 * keys in the body are ignored.
 */
export async function updateBillingSettings({ lawFirmId, actingUserId, body }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const patch: Record<string, any> = {};
  if (body.clientPaymentEmails !== undefined) patch.clientPaymentEmails = body.clientPaymentEmails;
  const saved = await setFirmBillingSettings(lawFirmId, patch);
  return { settings: saved };
}

// Re-exported so callers keep importing these from here.
export { deriveInvoiceStatus, roundCurrency, toNumber, toIso, toDayKey };
