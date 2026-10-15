/**
 * Filtering, ordering and windowing for the firm-wide billing list reads
 * (`listFirmInvoices` / `listFirmTimeEntries` in firmBilling.service.js).
 *
 * These predicates run over the DERIVED records those functions build, not over
 * SQL rows. That is deliberate: invoice status, remaining balance, client
 * attribution, rate resolution and `billingStatus` are all derived in JavaScript
 * from several joined reads, so a filter expressed in SQL would have to
 * re-implement that derivation and could drift from it. Filtering the derived set
 * keeps one definition of every money field and one definition of "overdue".
 *
 * The predicates mirror what the billing UI used to compute client-side, field
 * for field, so moving the work to the server does not change which rows a filter
 * selects. Notably:
 *
 *   - The status rules mirror the UI's `getInvoiceStatusKey`, which resolves the
 *     effective due date through the payment plan's next pending installment
 *     before falling back to `nextPaymentDate` / `dueDate`.
 *   - Every date comparison is a calendar-day comparison between 'YYYY-MM-DD'
 *     strings in the VIEWER's timezone. Day-only columns are never parsed as
 *     timestamps, which is what used to shift them a day for viewers behind UTC.
 */

const { toNumber, toCents, fromCents } = require('./money');
const { resolvePage, whitelisted } = require('../../../shared/database/pagination');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Statuses that mean money is still expected on an invoice. */
export const UNPAID_STATUS_KEYS = new Set(['outstanding', 'overdue', 'partially_paid']);

/** Statuses that mean nothing more is expected on an invoice: settled, forgiven or cancelled. */
export const SETTLED_STATUS_KEYS = new Set(['paid', 'credited', 'voided']);

/** Where a time entry stands on its way to an invoice. */
export const BILLING_STATUSES = ['unbilled', 'queued', 'billed', 'covered_by_retainer'];

/** Due buckets, in the order the upcoming-payments list presents them. */
export const DUE_GROUPS = ['overdue', 'this_week', 'this_month', 'later', 'no_date'];

/** Largest page a caller may request, mirrored by the route schemas. */
export const MAX_PAGE_SIZE = 200;

/** A day-only 'YYYY-MM-DD' string, or null for anything else. */
export function asDay(value: any) {
  if (typeof value !== 'string') return null;
  const day = value.slice(0, 10);
  return DAY_RE.test(day) ? day : null;
}

/** `day` moved by `days` calendar days, as a 'YYYY-MM-DD' string. */
export function shiftDay(day: any, days: any) {
  const base = asDay(day);
  if (!base) return null;
  const [y, m, d] = base.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${mm}-${dd}`;
}

/** Whole calendar days from `fromDay` to `toDay` (negative when toDay is earlier). */
export function daysBetween(fromDay: any, toDay: any) {
  const a = asDay(fromDay);
  const b = asDay(toDay);
  if (!a || !b) return null;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/** Case-insensitive "contains" against any of the supplied values. */
function matchesText(needle: any, values: any) {
  for (const value of values) {
    if (typeof value === 'string' && value.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/**
 * The day a payment is next expected on an invoice.
 *
 * A payment plan's earliest pending (or already-overdue) installment wins, because
 * that is the amount actually coming due; only without one does the invoice's own
 * `nextPaymentDate` and then `dueDate` apply. An installment carrying no due date
 * deliberately does NOT fall through to those columns: the plan is what governs
 * the schedule, so an undated installment means no known next payment.
 */
export function invoiceNextPaymentDay(record: any) {
  const plan = record.paymentPlan;
  if (plan && plan.enabled && Array.isArray(plan.expectedPayments) && plan.expectedPayments.length) {
    // The earliest open instalment by date, whatever order the rows are stored in.
    const openRows = plan.expectedPayments.filter(
      (payment: any) => payment && (payment.status === 'pending' || payment.status === 'overdue'),
    );
    if (openRows.length) {
      return openRows.reduce((earliest: string | null, payment: any) => {
        const day = asDay(payment.dueDate);
        return day && (!earliest || day < earliest) ? day : earliest;
      }, null);
    }
  }
  if (record.nextPaymentDate) return asDay(record.nextPaymentDate);
  return asDay(record.dueDate);
}

/**
 * The status an invoice reports in the lists: 'paid' | 'credited' | 'voided' |
 * 'partially_paid' | 'overdue' | 'outstanding'.
 *
 * Derived from the record's live amounts rather than any stored column, and from
 * the plan-aware next-payment day above, so it is the same value the row's badge
 * shows. How a zero balance was reached decides the label: `isPaid` means the
 * firm collected it, otherwise a write-off closed it and calling that 'paid'
 * would credit the firm with money it never received.
 *
 * `todayDay` is the viewer's current calendar day, so "overdue" rolls over at the
 * viewer's midnight and not the server's.
 */
export function invoiceStatusKey(record: any, todayDay: any) {
  // Void is the one status the firm sets and the amounts cannot argue with: a
  // voided invoice keeps its balance on paper, so every rule below would call
  // it outstanding or overdue. `record.status` is deriveInvoiceStatus's output,
  // which returns 'voided' for a voided row and nothing else.
  if (record.status === 'voided') return 'voided';

  const totalCents = toCents(record.totalAmount);
  const paidCents = toCents(record.amountPaid);
  const writtenOffCents = toCents(record.totalWrittenOff);
  const remainingCents = totalCents - paidCents - writtenOffCents;

  if (remainingCents <= 0 && (totalCents > 0 || paidCents > 0 || writtenOffCents > 0 || record.isPaid === true)) {
    if (record.isPaid === true) return 'paid';
    // The firm list carries `totalWrittenOff` but not the credit notes behind it,
    // so the write-off amount is the signal that the balance was forgiven.
    if (writtenOffCents > 0) return 'credited';
    return 'paid';
  }

  if (paidCents > 0) return 'partially_paid';

  // An invoice that owes nothing has no payment to be late on.
  const nextDay = invoiceNextPaymentDay(record);
  if (remainingCents > 0 && nextDay && todayDay && nextDay < todayDay) return 'overdue';

  return 'outstanding';
}

/** Remaining balance in integer cents. */
function remainingCents(record: any) {
  return toCents(record.remainingBalance);
}

/**
 * Whether a record belongs under a concrete status chip or filter. The unpaid
 * statuses (outstanding, overdue, partially_paid) require money still owed; the
 * settled ones and 'voided' do not.
 */
function matchesStatus(record: any, status: any, todayDay: any) {
  if (!UNPAID_STATUS_KEYS.has(status)) return true;
  return invoiceStatusKey(record, todayDay) === status && remainingCents(record) > 0;
}

/**
 * Whether the firm is still owed money on this invoice. A zero-total invoice reads
 * "outstanding" until it is marked paid (there was nothing to pay), so the balance
 * check is what keeps empty invoices out of the payment lists and totals.
 *
 * Timezone-independent in effect: the only status the viewer's day can change is
 * 'outstanding' vs 'overdue', and both are unpaid.
 */
export function isAwaitingPayment(record: any, todayDay: any) {
  return UNPAID_STATUS_KEYS.has(invoiceStatusKey(record, todayDay)) && remainingCents(record) > 0;
}

/**
 * Whether an invoice with money still owing is past its effective due day.
 *
 * This is deliberately independent of invoiceStatusKey(): a partially-paid
 * invoice keeps the `partially_paid` badge while still belonging in overdue
 * counts and filters once its next payment day has passed.
 */
export function isPastDue(record: any, todayDay: any) {
  if (!isAwaitingPayment(record, todayDay)) return false;
  const nextDay = invoiceNextPaymentDay(record);
  return Boolean(nextDay && todayDay && nextDay < todayDay);
}

/** Which due bucket a next-payment day falls in, relative to the viewer's today. */
export function dueGroupForDay(nextDay: any, todayDay: any) {
  if (!nextDay) return 'no_date';
  if (todayDay && nextDay < todayDay) return 'overdue';
  const diff = daysBetween(todayDay, nextDay);
  if (diff === null) return 'no_date';
  if (diff <= 7) return 'this_week';
  if (diff <= 30) return 'this_month';
  return 'later';
}

/**
 * Per-bucket counts and outstanding totals across the WHOLE awaiting set, for the
 * upcoming-payments summary tiles. Computed here rather than on the client
 * because the client only ever holds one page. Sums in integer cents and converts
 * once, so no float dust accumulates across invoices.
 */
export function dueGroupTotals(records: any, todayDay: any) {
  const totals: any = { all: { count: 0, amountCents: 0 } };
  for (const group of DUE_GROUPS) totals[group] = { count: 0, amountCents: 0 };

  for (const record of records) {
    const group = dueGroupForDay(invoiceNextPaymentDay(record), todayDay);
    const cents = remainingCents(record);
    totals.all.count += 1;
    totals.all.amountCents += cents;
    totals[group].count += 1;
    totals[group].amountCents += cents;
  }

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(totals) as Array<[string, any]>) {
    out[key] = { count: value.count, amount: fromCents(value.amountCents) };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Invoice filtering                                                  */
/* ------------------------------------------------------------------ */

/**
 * Apply the firm invoice-list filters to the derived records.
 *
 * `status` accepts a concrete status key plus two pseudo-statuses the UI offers:
 * `unpaid` (any status with money still expected) and `due_soon` (not yet due,
 * next payment within 30 days). `awaitingOnly` is the upcoming-payments list's
 * gate, and `dueGroup` narrows to one of its buckets.
 */
/**
 * How many invoices sit in each status, for the filter chips above a list.
 *
 * Counted over whatever set the caller passes — which must NOT already be
 * narrowed by status, or every chip but the selected one would read zero and the
 * user would lose the way back. `overdue` overlaps the other keys deliberately:
 * a partially-paid invoice past its next payment date is counted both as
 * `partially_paid` and as `overdue`, matching what each chip filters to.
 */
export function countInvoiceStatuses(records: any, todayDay: any) {
  const counts: any = { all: records.length, overdue: 0 };
  for (const record of records) {
    const key = invoiceStatusKey(record, todayDay);
    // A status chip counts exactly the rows its filter returns, and the unpaid
    // statuses mean money is still owed, so an invoice that owes nothing sits
    // under none of them.
    if (matchesStatus(record, key, todayDay)) counts[key] = (counts[key] || 0) + 1;
    // An 'overdue' key already counted itself above; only a partially-paid
    // invoice past its next payment day still needs adding to the chip.
    if (key !== 'overdue' && isPastDue(record, todayDay)) counts.overdue += 1;
  }
  return counts;
}

/**
 * Whether an invoice falls under a client's relationship: their own direct
 * invoices, plus every invoice on a matter they are on — including ones billed to
 * a different client on a shared matter.
 *
 * Deliberately wider than `clientId`, which asks who an invoice was billed TO.
 * A client's billing page is reviewing the whole relationship, and the invoices
 * billed to a co-client on a shared matter are exactly the context that explains
 * why this client's share looks the way it does.
 *
 * `clientIds` is a `Set` rather than one id so the client-detail Billing tab can
 * widen the relationship to every company the viewed person is linked to via
 * `client_company_links` (resolved by the caller with
 * `resolveBillingEffectiveClientIds`, which already respects `can_view_billing`).
 * A single-client caller passes a one-element Set, so behavior there is unchanged.
 *
 * Requires `_scopeMatterClientIds` on the record, attached by listFirmInvoices.
 */
export function invoiceInClientScope(record: any, clientIds: Set<string>) {
  if (record.contextType === 'client') return clientIds.has(record.entityId);
  return (record._scopeMatterClientIds || []).some((id: string) => clientIds.has(id));
}

/**
 * Billed and paid across the invoices a client actually owes on.
 *
 * Restricted to `owned` because that is whose money it is: an invoice billed to a
 * co-client on a shared matter is shown for context, never counted against this
 * client's balance. A voided invoice was cancelled and counts nowhere.
 *
 * Outstanding is each invoice's own remaining balance (total less paid less
 * written off, floored at zero), summed. Credit on one over-settled invoice is
 * that invoice's credit, not a payment towards another. Whole cents throughout,
 * converted once, so a long relationship cannot accumulate float drift into a
 * figure a firm chases.
 */
export function summarizeOwnedInvoices(records: any) {
  let billedCents = 0;
  let paidCents = 0;
  let outstandingCents = 0;
  let ownedCount = 0;
  for (const record of records) {
    if (record.billingRelation !== 'owned') continue;
    if (record.status === 'voided') continue;
    ownedCount += 1;
    const totalCents = toCents(toNumber(record.totalAmount));
    const invoicePaidCents = toCents(toNumber(record.amountPaid));
    const writtenOffCents = toCents(toNumber(record.totalWrittenOff));
    billedCents += totalCents;
    paidCents += invoicePaidCents;
    outstandingCents += Math.max(0, totalCents - invoicePaidCents - writtenOffCents);
  }
  return {
    ownedCount,
    totalBilled: fromCents(billedCents),
    totalPaid: fromCents(paidCents),
    totalOutstanding: fromCents(outstandingCents),
  };
}

export function filterInvoices(records: any, {
  search,
  matterId,
  clientId,
  clientScope,
  billingRelation,
  relatedClientId,
  status,
  dateFrom,
  dateTo,
  dueDateFrom,
  dueDateTo,
  dueGroup,
  awaitingOnly,
  todayDay,
}: any = {}) {
  let result = records;

  if (awaitingOnly) {
    result = result.filter((record: any) => isAwaitingPayment(record, todayDay));
  }

  const needle = typeof search === 'string' ? search.trim().toLowerCase() : '';
  if (needle) {
    result = result.filter((record: any) => matchesText(needle, [
      record.invoiceName,
      // The number is what's printed on the document, and most invoices have no
      // name at all, so it's the identifier people actually search by.
      record.invoiceNumber,
      record.matterName,
      record.clientName,
      ...(record.matterClientNames || []),
    ]));
  }

  if (matterId) {
    result = result.filter((record: any) => (record.matterId || '') === matterId);
  }

  if (clientId) {
    // The client the invoice is billed TO. Matching co-clients on the same matter
    // would return invoices somebody else owes.
    result = result.filter((record: any) => (record.clientId || '') === clientId);
  }

  if (clientScope) result = result.filter((record: any) => invoiceInClientScope(record, clientScope));
  if (billingRelation) result = result.filter((record: any) => record.billingRelation === billingRelation);

  if (relatedClientId) {
    result = result.filter((record: any) =>
      record.contextType === 'client'
        ? record.entityId === relatedClientId
        : (record.relatedClientIds || []).includes(relatedClientId),
    );
  }

  if (status === 'due_soon') {
    const horizon = shiftDay(todayDay, 30);
    result = result.filter((record: any) => {
      if (!isAwaitingPayment(record, todayDay)) return false;
      const nextDay = invoiceNextPaymentDay(record);
      if (!nextDay || !todayDay || !horizon) return false;
      return nextDay >= todayDay && nextDay <= horizon;
    });
  } else if (status === 'unpaid') {
    result = result.filter((record: any) => isAwaitingPayment(record, todayDay));
  } else if (status === 'overdue') {
    result = result.filter((record: any) => isPastDue(record, todayDay));
  } else if (status) {
    result = result.filter((record: any) => invoiceStatusKey(record, todayDay) === status
      && matchesStatus(record, status, todayDay));
  }

  if (dateFrom) {
    result = result.filter((record: any) => {
      const day = asDay(record.invoiceDate);
      return day !== null && day >= dateFrom;
    });
  }

  if (dateTo) {
    result = result.filter((record: any) => {
      const day = asDay(record.invoiceDate);
      return day !== null && day <= dateTo;
    });
  }

  if (dueGroup) {
    result = result.filter(
      (record: any) => dueGroupForDay(invoiceNextPaymentDay(record), todayDay) === dueGroup,
    );
  }

  // Unlike `dateFrom`/`dateTo` above (the invoice's issue date), this ranges over
  // the derived next-payment day the due buckets themselves use, so it composes
  // with `dueGroup` as a custom range rather than a competing definition of "due".
  if (dueDateFrom) {
    result = result.filter((record: any) => {
      const day = invoiceNextPaymentDay(record);
      return day !== null && day >= dueDateFrom;
    });
  }

  if (dueDateTo) {
    result = result.filter((record: any) => {
      const day = invoiceNextPaymentDay(record);
      return day !== null && day <= dueDateTo;
    });
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Invoice ordering                                                   */
/* ------------------------------------------------------------------ */

const timeOf = (value: any) => {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/** Oldest first by creation instant, falling back to the invoice's own date. */
function compareByCreated(a: any, b: any) {
  return timeOf(a.createdAt || a.invoiceDate) - timeOf(b.createdAt || b.invoiceDate);
}

/**
 * Work-to-do order for the invoice list: anything still owed comes before
 * anything settled, then soonest next payment first.
 */
function compareByPaymentPriority(todayDay: any) {
  return (a: any, b: any) => {
    const keyA = invoiceStatusKey(a, todayDay);
    const keyB = invoiceStatusKey(b, todayDay);
    const doneA = SETTLED_STATUS_KEYS.has(keyA);
    const doneB = SETTLED_STATUS_KEYS.has(keyB);
    if (doneA !== doneB) return doneA ? 1 : -1;

    const dayA = invoiceNextPaymentDay(a) || asDay(a.invoiceDate) || '';
    const dayB = invoiceNextPaymentDay(b) || asDay(b.invoiceDate) || '';
    if (dayA && dayB) return dayA.localeCompare(dayB);
    if (dayA) return -1;
    if (dayB) return 1;
    return 0;
  };
}

/** Bucket order (overdue first, undated last), then soonest due first. */
function compareByDueGroup(todayDay: any) {
  return (a: any, b: any) => {
    const dayA = invoiceNextPaymentDay(a);
    const dayB = invoiceNextPaymentDay(b);
    const groupA = DUE_GROUPS.indexOf(dueGroupForDay(dayA, todayDay));
    const groupB = DUE_GROUPS.indexOf(dueGroupForDay(dayB, todayDay));
    if (groupA !== groupB) return groupA - groupB;
    if (!dayA && !dayB) return 0;
    if (!dayA) return 1;
    if (!dayB) return -1;
    return dayA.localeCompare(dayB);
  };
}

export const INVOICE_COMPARATORS = {
  createdAt: () => compareByCreated,
  paymentPriority: (todayDay: any) => compareByPaymentPriority(todayDay),
  dueGroup: (todayDay: any) => compareByDueGroup(todayDay),
};

/** Whitelisted invoice sort fields, exposed so the route schema can validate them. */
export const INVOICE_SORT_FIELDS = Object.keys(INVOICE_COMPARATORS);

export const TIME_ENTRY_COMPARATORS = {
  date: () => (a: any, b: any) => timeOf(a.date || a.createdAt) - timeOf(b.date || b.createdAt),
  // Ordered here rather than in the browser so they sort the whole match set. A
  // client-side comparator can only reach the rows already downloaded, which on a
  // paged list means "sort this page" while presenting itself as "sort by hours".
  member: () => (a: any, b: any) => (a.userName || '').localeCompare(b.userName || ''),
  hours: () => (a: any, b: any) => toNumber(a.hours) - toNumber(b.hours),
  // Entries with no resolvable rate carry a null amount; they sort as 0 so they
  // group together at one end rather than scattering through the order.
  amount: () => (a: any, b: any) => (toNumber(a.amount) - toNumber(b.amount)),
};

export const TIME_ENTRY_SORT_FIELDS = Object.keys(TIME_ENTRY_COMPARATORS);

/**
 * Parse a `field:dir,field:dir` sort model and return the comparator for its
 * first recognized field, or null when nothing matches (the caller then keeps its
 * own default ordering).
 *
 * Only the primary field is honoured: each comparator here already encodes its
 * own tiebreakers, so a second field would never be reached. `desc` reverses the
 * comparator's natural direction, which for the composite orderings
 * (paymentPriority, dueGroup) means "least urgent first".
 */
export function resolveComparator(sortParam: any, comparators: any, todayDay: any) {
  if (!sortParam) return null;
  for (const part of String(sortParam).split(',')) {
    const [field, dir] = part.split(':');
    // Own-key lookup only: a plain `comparators[field]` also resolves inherited
    // Object.prototype members, so `?sort=constructor:asc` would return a
    // non-comparator that throws when Array.sort calls it.
    const build = whitelisted(comparators, field);
    if (typeof build !== 'function') continue;
    const cmp = build(todayDay);
    return dir === 'desc' ? (a: any, b: any) => -cmp(a, b) : cmp;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Time-entry filtering                                              */
/* ------------------------------------------------------------------ */

/**
 * The clients a time entry's work is billed to (`clients.id` values). A
 * client-context entry is billed to its client; matter work is billed to the
 * clients the logger actually named on the entry, and to nobody otherwise.
 */
function entryBilledClientIds(record: any) {
  if (record.clientId) return [record.clientId];
  const ids = Array.isArray(record.matterClientIds) ? record.matterClientIds.filter(Boolean) : [];
  if (ids.length) return ids;
  return record.matterClientId ? [record.matterClientId] : [];
}

/**
 * Whether an entry falls within a client's book of work: the client's own
 * direct-context entries, plus every entry on a matter the client is on.
 *
 * Deliberately WIDER than `clientId`, which asks who the work is billed TO and so
 * excludes matter work the logger never attributed to anyone. A client's billing
 * tab is reviewing everything done under that relationship, unattributed work
 * included — that work is precisely what still needs a payer assigned, so hiding
 * it is how it never gets billed.
 *
 * `clientIds` is a `Set` rather than one id so the client-detail Time Tracking tab
 * can widen the relationship to every company the viewed person is linked to via
 * `client_company_links` (resolved by the caller with `resolveEffectiveClientIds`;
 * Time Tracking is not billing-sensitive, so it widens unconditionally, unlike
 * Billing's `can_view_billing`-gated resolution). A single-client caller passes a
 * one-element Set, so behavior there is unchanged.
 */
function entryInClientScope(record: any, clientIds: Set<string>) {
  if (record.clientId) return clientIds.has(record.clientId);
  return (record.matterClients || []).some((client: any) => client && clientIds.has(client.id));
}

export function filterTimeEntries(records: any, {
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
}: any = {}) {
  let result = records;

  const needle = typeof search === 'string' ? search.trim().toLowerCase() : '';
  if (needle) {
    result = result.filter((record: any) => matchesText(needle, [
      record.matterName,
      record.clientName,
      ...(record.clientNames || []),
      record.userName,
      record.sourceTaskTitle,
      record.sourceEventTitle,
      record.name,
      record.description,
    ]));
  }

  if (context) result = result.filter((record: any) => record.contextType === context);
  if (matterId) result = result.filter((record: any) => (record.matterId || '') === matterId);
  if (clientId) result = result.filter((record: any) => entryBilledClientIds(record).includes(clientId));
  if (clientScope) result = result.filter((record: any) => entryInClientScope(record, clientScope));
  if (userId) result = result.filter((record: any) => (record.userId || '') === userId);
  if (chargeCodeId) result = result.filter((record: any) => (record.chargeCodeId || '') === chargeCodeId);
  if (billingStatus) {
    // Accepts a comma-separated set, so a caller can ask for "everything not yet
    // invoiced" in one request instead of one request per status.
    const allowed = new Set(String(billingStatus).split(',').map((s) => s.trim()).filter(Boolean));
    result = result.filter((record: any) => allowed.has(record.billingStatus));
  }

  if (dateFrom) {
    result = result.filter((record: any) => {
      const day = asDay(record.date);
      return day !== null && day >= dateFrom;
    });
  }

  if (dateTo) {
    result = result.filter((record: any) => {
      const day = asDay(record.date);
      return day !== null && day <= dateTo;
    });
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Windowing                                                          */
/* ------------------------------------------------------------------ */

/**
 * Take one page out of an ordered list, reporting the PRE-slice length as the
 * total.
 *
 * Paging is opt-in: with no `limit` the whole list comes back, which is the
 * unpaginated contract the workbench and the billing summary still rely on
 * (mirrors `buildPageClause`'s `optional` behaviour for the SQL reads).
 */
export function windowList(list: any, { limit, offset, page }: any = {}) {
  const totalItems = list.length;
  if (limit == null) return { items: list, totalItems };

  // resolvePage is the same clamping and page->offset rule the SQL-backed list
  // reads use, so `?page=3&limit=25` selects the same row range whether a list is
  // windowed in Postgres or here.
  const { limit: lim, offset: off } = resolvePage({
    limit, offset, page, fallbackLimit: 50, max: MAX_PAGE_SIZE,
  });

  return { items: list.slice(off, off + lim), totalItems };
}
