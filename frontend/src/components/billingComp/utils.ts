import { isBeforeToday } from '@/lib/utils/dateUtils';
import type { Invoice } from "@/types";

/** Use the persisted resolved rate; legacy entries fall back to their manual or member rate. */
export function getTimeEntryRate(
  entry: { hourlyRate?: number | null; resolvedRate?: number | null; rateSource?: string | null },
  fallbackRate = 0,
): number {
  if (entry.rateSource) return entry.rateSource === "none" ? 0 : (entry.resolvedRate ?? 0);
  return typeof entry.hourlyRate === "number" ? entry.hourlyRate : fallbackRate;
}

export function isRecurringRetainerInvoice(
  invoice: Pick<Invoice, "isRecurringRetainer" | "billingPlanType" | "billingPlanId" | "flatFees">
) {
  return Boolean(
    invoice.isRecurringRetainer ||
      invoice.billingPlanType === "retainer" ||
      invoice.billingPlanId ||
      invoice.flatFees?.some((fee) => String(fee.id || "").startsWith("plan-"))
  );
}

export function getRecurringRetainerPlanName(
  invoice: Pick<Invoice, "billingPlanName" | "flatFees">
) {
  if (invoice.billingPlanName) return invoice.billingPlanName;
  const planFee = invoice.flatFees?.find((fee) => String(fee.id || "").startsWith("plan-"));
  return planFee?.description || null;
}

export { formatCurrency } from "@/lib/utils/currency";

/**
 * The unit a payment plan's instalment amount is quoted per, from its cadence in
 * days: "week", "2 wks" and "month" for the cadences the plan form offers, and
 * "N days" for any other. Only 30 days is monthly; the server steps a 30-day
 * plan by calendar months and every other cadence by whole days.
 */
export function paymentPlanCadenceLabel(frequencyDays: number | null | undefined): string {
  const days = Number(frequencyDays) || 30;
  if (days === 7) return "week";
  if (days === 14) return "2 wks";
  if (days === 30) return "month";
  return days === 1 ? "1 day" : `${days} days`;
}

/** Split `regularRemaining` into `paymentCount` installments; ceil per slice in cents so the plan covers the full balance. */
export function installmentAmountFromPaymentCount(regularRemaining: number, paymentCount: number): number {
  if (!(regularRemaining > 0) || paymentCount < 1 || !Number.isFinite(regularRemaining)) return NaN;
  const cents = Math.round(regularRemaining * 100);
  if (cents < 1) return NaN;
  return Math.ceil(cents / paymentCount) / 100;
}

export function getInvoiceTotal(invoice: Invoice) {
  const totalAmount = Number(invoice.totalAmount);
  return Number.isFinite(totalAmount) ? totalAmount : 0;
}

/**
 * What to call an invoice in a list. Most invoices carry a number but no name,
 * so falling straight to "Untitled Invoice" throws away the identifier printed
 * on the document itself and renders whole pages of identical rows.
 */
export function getInvoiceDisplayName(
  // Both are nullable in the database (`invoices.invoice_name` is a plain `text`
  // column), which is why this falls through them rather than taking an
  // `Invoice` whose `invoiceName` is declared non-null.
  invoice: { invoiceName?: string | null; invoiceNumber?: string | null }
) {
  return invoice.invoiceName?.trim() || invoice.invoiceNumber?.trim() || "Untitled Invoice";
}

/** Statuses that mean money is still expected on an invoice. */
export const UNPAID_STATUS_KEYS = new Set(["outstanding", "overdue", "partially_paid"]);

/**
 * Statuses that close an invoice: nothing is owed and nothing more is chased.
 * Paid and written off reach it through the amounts; voided is the firm
 * cancelling the bill, whatever the amounts still say.
 */
export const CLOSED_STATUS_KEYS = new Set(["paid", "credited", "voided"]);

/** Whether a status key closes the invoice (see CLOSED_STATUS_KEYS). */
export function isClosedStatusKey(statusKey: string | null | undefined) {
  return !!statusKey && CLOSED_STATUS_KEYS.has(statusKey);
}

/**
 * Whether the firm is still owed money on this invoice. A zero-total invoice is
 * never "paid" by the status rules (there was nothing to pay), so the balance
 * check is what keeps empty invoices out of the payment lists and counts.
 */
export function isAwaitingPayment(invoice: Invoice) {
  return (
    UNPAID_STATUS_KEYS.has(getInvoiceStatusKey(invoice)) &&
    getInvoiceRemainingBalance(invoice) > 0
  );
}

/** A dollar amount as whole cents, so settlement arithmetic never subtracts floats. */
function toCents(dollars: unknown) {
  return Math.round((Number(dollars) || 0) * 100);
}

/** Total, paid and written-off cents of an invoice, each rounded to a cent before any subtraction. */
function settlementCents(invoice: Invoice) {
  return {
    total: toCents(getInvoiceTotal(invoice)),
    paid: toCents(invoice.amountPaid),
    writtenOff: toCents(invoice.totalWrittenOff),
  };
}

export function getInvoiceRemainingBalance(invoice: Invoice) {
  // A voided invoice was cancelled, so nothing on it is owed.
  if (invoice.status === "voided") return 0;
  const { total, paid, writtenOff } = settlementCents(invoice);
  return Math.max(0, total - writtenOff - paid) / 100;
}

/**
 * How far an invoice is settled BEYOND its total - money the firm owes back.
 *
 * `getInvoiceRemainingBalance` clamps at zero, which is right for "what is still
 * owed" but hides an over-settled invoice completely. Editing line items can lower
 * a total below what was already collected, so detail surfaces read this to show
 * the credit instead of a flat $0.00. Returns 0 in the normal case, which is why
 * list and aggregate surfaces can keep using the clamped balance untouched.
 */
export function getInvoiceCreditBalance(invoice: Invoice) {
  const { total, paid, writtenOff } = settlementCents(invoice);
  return Math.max(0, paid + writtenOff - total) / 100;
}

/**
 * Billed, paid and outstanding across a set of invoices, in dollars, summed in
 * integer cents. A voided invoice is left out of all three: the firm cancelled
 * it, so it was neither billed nor owed, and money that landed on it anyway is
 * a refund to make, not revenue.
 */
export function summarizeInvoiceMoney(invoices: Invoice[]) {
  let billedCents = 0;
  let paidCents = 0;
  let outstandingCents = 0;
  for (const inv of invoices) {
    if (inv.status === "voided") continue;
    billedCents += Math.round(getInvoiceTotal(inv) * 100);
    paidCents += Math.round((Number(inv.amountPaid) || 0) * 100);
    outstandingCents += Math.round(getInvoiceRemainingBalance(inv) * 100);
  }
  return {
    totalBilled: billedCents / 100,
    totalPaid: paidCents / 100,
    outstanding: outstandingCents / 100,
  };
}

export function getInvoiceStatusKey(invoice: Invoice) {
  // The firm cancelled this bill. Its amounts can still read as owed, so the
  // amount rules below would call it outstanding or overdue; the stored status
  // is the one fact that says otherwise.
  if (invoice.status === "voided") return "voided";
  const { total: totalCents, paid: paidCents, writtenOff: writtenOffCents } = settlementCents(invoice);
  const totalAmount = totalCents / 100;
  const amountPaid = paidCents / 100;
  const totalWrittenOff = writtenOffCents / 100;
  const remaining = totalCents - paidCents - writtenOffCents;
  const effectiveDueDate = getInvoiceNextPaymentInfo(invoice).date;

  // How the balance reached zero decides the label. `isPaid` marks an invoice the
  // firm actually collected; otherwise a write-off is what closed it, and calling
  // that "Paid" claims money that never came in. Derived from the live amounts
  // rather than the stored status, which nothing writes 'credited' to.
  if (remaining <= 0 && (totalAmount > 0 || amountPaid > 0 || totalWrittenOff > 0)) {
    if (invoice.isPaid === true) return "paid";
    if (totalWrittenOff > 0 || (invoice.creditNotes || []).length > 0) return "credited";
    return "paid";
  }

  if (amountPaid > 0) {
    return "partially_paid";
  }

  if (effectiveDueDate && isBeforeToday(effectiveDueDate)) {
    return "overdue";
  }

  return "outstanding";
}

export function getInvoiceNextPaymentInfo(invoice: Invoice): {
  date: string | null;
  amount: number | null;
  fromPlan: boolean;
} {
  const plan = invoice.paymentPlan;
  if (plan?.enabled && plan.expectedPayments?.length) {
    const next = plan.expectedPayments.find(
      (payment) => payment.status === "pending" || payment.status === "overdue"
    );
    if (next) {
      return {
        date: next.dueDate,
        amount: next.amount,
        fromPlan: true,
      };
    }
  }

  if (invoice.nextPaymentDate) {
    return { date: invoice.nextPaymentDate, amount: null, fromPlan: false };
  }

  return { date: invoice.dueDate || null, amount: null, fromPlan: false };
}

export function getInvoiceStatus(invoice: Invoice) {
  const status = getInvoiceStatusKey(invoice);
  const nextPaymentDate = getInvoiceNextPaymentInfo(invoice).date;

  if (status === "credited") {
    return { label: "Written Off", variant: "neutral" as const };
  }

  if (status === "voided") {
    return { label: "Voided", variant: "neutral" as const };
  }

  switch (status) {
    case "paid":
      return { label: "Paid", variant: "success" as const };
    case "partially_paid": {
      const isOverdue = nextPaymentDate
        ? isBeforeToday(nextPaymentDate)
        : false;
      if (isOverdue) {
        return { label: "Partially Paid (Overdue)", variant: "danger" as const };
      }
      return { label: "Partially Paid", variant: "info" as const };
    }
    case "overdue":
      return { label: "Overdue", variant: "danger" as const };
    default:
      return { label: "Unpaid", variant: "warning" as const };
  }
}

/**
 * Whether an invoice should count as "overdue" for bucketing (pill counts, status
 * filters), regardless of whether a partial payment has come in. `getInvoiceStatusKey`
 * returns "partially_paid" the moment any money has been paid, even past the due
 * date, so an overdue-but-partially-paid invoice was silently falling out of the
 * Overdue bucket while its own badge still said "(Overdue)".
 */
export function isInvoiceEffectivelyOverdue(invoice: Invoice): boolean {
  const statusKey = getInvoiceStatusKey(invoice);
  if (statusKey === "overdue") return true;
  if (statusKey !== "partially_paid") return false;
  const nextPaymentDate = getInvoiceNextPaymentInfo(invoice).date;
  return nextPaymentDate ? isBeforeToday(nextPaymentDate) : false;
}

/**
 * Orders an invoice list for display: settled invoices (paid, written off or voided) sink
 * to the bottom, and the rest are ordered by whichever date the surface cares
 * about. `nextPayment` puts the soonest-due work first (what a firm chases);
 * `invoiceDate` is a newest-first history view.
 */
export function sortInvoicesForList<T extends Invoice>(
  invoices: T[],
  by: "nextPayment" | "invoiceDate" = "nextPayment"
): T[] {
  return [...invoices].sort((a, b) => {
    const aIsDone = isClosedStatusKey(getInvoiceStatusKey(a));
    const bIsDone = isClosedStatusKey(getInvoiceStatusKey(b));
    if (aIsDone !== bIsDone) return aIsDone ? 1 : -1;

    if (by === "invoiceDate") {
      return (b.invoiceDate || "").localeCompare(a.invoiceDate || "");
    }

    const aDate = getInvoiceNextPaymentInfo(a).date;
    const bDate = getInvoiceNextPaymentInfo(b).date;
    if (!aDate && !bDate) return 0;
    if (!aDate) return 1;
    if (!bDate) return -1;
    return aDate.localeCompare(bDate);
  });
}

/** A live client record, loaned in to fill a draft invoice's bill-to block before anything has been snapshotted. */
export interface DraftBillToClient {
  name?: string | null;
  email?: string | null;
  address?: string | null;
  organization?: string | null;
  clientType?: string | null;
}

export interface InvoiceBillTo {
  /** The billed party's own name: the company, or the person, whichever this invoice is billed to. */
  name: string | null;
  /** A person client's free-text employer, when the caller has a live client record. Never set for a company. */
  organization: string | null;
  /** "Attn: {name}, {title}" for a company snapshot with an attention contact; otherwise null. */
  attentionLine: string | null;
  address: string | null;
  /** Every address this bill reaches once issued. At most one entry before that. */
  emails: string[];
  /** The one email to show where only one fits. */
  primaryEmail: string | null;
  /**
   * Whether the billed party is an organization, or null when this record
   * cannot tell. A snapshot only knows it is a company when it froze an
   * attention contact, which the backend writes for companies alone; a company
   * whose roster had no usable contact reads as null here, not false.
   */
  isCompany: boolean | null;
  /** Whether these are the frozen historical values or today's live/draft data. */
  source: "snapshot" | "draft";
}

/**
 * Who to print or display as an invoice's bill-to party.
 *
 * Once an invoice has issued, `invoices.billing_*` (migrations 0171 and 0173)
 * holds the frozen snapshot and is authoritative: a roster change, or a client
 * rename, months later must not reshape a March invoice. `billingClientName`
 * is the frozen name.
 *
 * Before first issue there is nothing frozen yet, so this reads today's live
 * client record when the caller has one loaded (`draftClient`) and otherwise
 * falls back to the invoice's draft-time `clientName`/`clientEmail`/`billingEmail`
 * columns. This is the one place every bill-to surface (the PDF, the portal
 * invoice page, the firm invoice detail sidebar) resolves this, so they can't
 * drift into showing different answers to "who is this invoice billed to".
 */
export function getInvoiceBillTo(
  invoice: Pick<
    Invoice,
    | "billingSnapshotAt"
    | "billingContactName"
    | "billingContactTitle"
    | "billingContactEmail"
    | "billingClientAddress"
    | "billingClientName"
    | "billingEmails"
    | "clientName"
    | "clientEmail"
    | "billingEmail"
  >,
  draftClient?: DraftBillToClient | null
): InvoiceBillTo {
  if (invoice.billingSnapshotAt) {
    const name = invoice.billingClientName || null;
    const emails = invoice.billingEmails || [];
    return {
      name,
      organization: null,
      attentionLine: invoice.billingContactName
        ? `Attn: ${invoice.billingContactName}${invoice.billingContactTitle ? `, ${invoice.billingContactTitle}` : ""}`
        : null,
      address: invoice.billingClientAddress || null,
      emails,
      primaryEmail: invoice.billingContactEmail || emails[0] || null,
      isCompany: invoice.billingContactName ? true : null,
      source: "snapshot",
    };
  }

  const primaryEmail = invoice.billingEmail || draftClient?.email || invoice.clientEmail || null;
  return {
    name: invoice.clientName || draftClient?.name || null,
    organization: draftClient?.organization || null,
    attentionLine: null,
    address: draftClient?.address || null,
    emails: primaryEmail ? [primaryEmail] : [],
    primaryEmail,
    isCompany: draftClient?.clientType ? draftClient.clientType === "company" : null,
    source: "draft",
  };
}

export interface RemitTo {
  name?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
}

/**
 * The remit-to block on an invoice, whatever shape it came back in.
 *
 * `invoices.remit_to` is a jsonb column, but some rows carry it as a JSON
 * *string* rather than a parsed object. Callers that only accepted objects fell
 * through to their "plain string" branch and printed the raw
 * `{"name":"…","address":""}` onto the invoice PDF. Returns null when there is
 * nothing usable to render.
 */
export function parseRemitTo(raw: unknown): RemitTo | null {
  if (!raw) return null;

  if (typeof raw === "object") {
    const value = raw as RemitTo;
    return value.name || value.address || value.city || value.state || value.zip ? value : null;
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("{")) {
      try {
        return parseRemitTo(JSON.parse(trimmed));
      } catch {
        // Malformed JSON: fall through and treat it as a plain firm name.
      }
    }
    return { name: trimmed };
  }

  return null;
}

export interface InvoiceClientAttribution {
  /** The client this invoice is billed to, or null when no single client is. */
  name: string | null;
  /** `clients.id` of that client, when known. Links and id matching use this. */
  clientId: string | null;
  /** True when a specific client is on the hook for this invoice. */
  isAttributed: boolean;
  /** Every client on the invoice's matter. Context, never a payer. */
  matterClientNames: string[];
  /**
   * True when the invoice is matter-level work on a matter with several clients,
   * so no one client can be shown as the payer.
   */
  isAmbiguous: boolean;
}

/**
 * Who an invoice is billed to.
 *
 * A matter can have several clients, and an invoice raised against the matter
 * rather than against one of them has no payer. Showing one of the matter's
 * clients anyway invents an attribution, and filtering an invoice list by every
 * co-client on the matter returns invoices billed to somebody else. Both lists
 * read attribution through here so they agree with each other and with the row
 * label.
 */
export function getInvoiceClientAttribution(
  invoice: Pick<
    Invoice,
    "contextType" | "clientId" | "clientContextId" | "clientName" | "entityId"
  > & { matterClientNames?: string[] }
): InvoiceClientAttribution {
  const matterClientNames = invoice.matterClientNames || [];
  const isClientContext = invoice.contextType === "client";
  const clientId = isClientContext
    ? invoice.clientContextId || invoice.clientId || invoice.entityId || null
    : invoice.clientId || null;

  // A client-context invoice is by definition billed to that client. A matter
  // invoice needs a client id of its own; the API leaves the name null when
  // nothing was chosen.
  const isAttributed = isClientContext || Boolean(clientId) || Boolean(invoice.clientName);

  return {
    name: isAttributed ? invoice.clientName || null : null,
    clientId,
    isAttributed,
    matterClientNames,
    isAmbiguous: !isAttributed && matterClientNames.length > 1,
  };
}

export interface TimeEntryClientAttribution {
  /** The client(s) this work is billed to, or null when none was chosen. */
  name: string | null;
  /** True when the work sits on a multi-client matter and names no client. */
  isAmbiguous: boolean;
}

/**
 * Who a time entry's work is billed to.
 *
 * Matter work is only chargeable to a client the entry actually names
 * (`matterClientIds`), or to the matter's sole client when there is just one.
 * Falling back to the first of several clients, as the lists used to, bills one
 * client for another's work on screen.
 */
export function getTimeEntryClientAttribution(
  entry: {
    context?: "matter" | "client";
    clientName?: string | null;
    clientNames?: string[] | null;
    matterClientId?: string | null;
    matterClientIds?: string[] | null;
  },
  matterClients: Array<{ id: string; name?: string | null }> = []
): TimeEntryClientAttribution {
  if (entry.context === "client") {
    return { name: entry.clientName || entry.clientNames?.[0] || null, isAmbiguous: false };
  }

  const namedIds = (
    entry.matterClientIds?.length
      ? entry.matterClientIds
      : entry.matterClientId
        ? [entry.matterClientId]
        : []
  ).filter(Boolean);

  if (namedIds.length) {
    const names = matterClients
      .filter((client) => namedIds.includes(client.id))
      .map((client) => client.name)
      .filter(Boolean);
    if (names.length) return { name: names.join(", "), isAmbiguous: false };
  }

  // Nothing named: only unambiguous when the matter has a single client.
  const candidates = matterClients.length
    ? matterClients.map((client) => client.name).filter(Boolean)
    : entry.clientNames || [];
  if (candidates.length === 1) return { name: candidates[0] as string, isAmbiguous: false };
  return { name: null, isAmbiguous: candidates.length > 1 };
}

export function getInvoiceDestination(
  lawFirmId: string,
  invoice: Pick<
    Invoice,
    "id" | "contextType" | "entityId" | "matterId" | "clientContextId" | "clientId"
  >
) {
  const matterId =
    invoice.matterId ||
    (invoice.contextType === "matter" ? invoice.entityId || null : null);

  if (matterId) {
    return `/lawfirm/${lawFirmId}/matters/${matterId}/invoices/${invoice.id}`;
  }

  const clientId =
    invoice.clientContextId ||
    invoice.clientId ||
    (invoice.contextType === "client" ? invoice.entityId || null : null);

  if (clientId) {
    return `/lawfirm/${lawFirmId}/clients/${clientId}/invoices/${invoice.id}`;
  }

  return null;
}

export function getBillingPlanDestination(lawFirmId: string, planId: string) {
  return `/lawfirm/${lawFirmId}/billing/plans/${planId}`;
}

/**
 * The billing context a time entry belongs to.
 *
 * The entry's own ids are the authority, not the screen it was opened from: an
 * entry filed against a matter is edited and deleted through that matter even
 * when the row was listed on a client page or in the firm-wide log. `time_entries`
 * carries a check constraint making matter and client mutually exclusive, so one
 * of the two branches always applies.
 */
export function getTimeEntryContext(
  lawFirmId: string,
  entry: {
    context?: string | null;
    contextType?: string | null;
    matterId?: string | null;
    clientId?: string | null;
    entityId?: string | null;
  },
): { lawFirmId: string; type: "matter" | "client"; entityId: string } {
  const declared = entry.context || entry.contextType;
  const isClient = declared === "client" || (!entry.matterId && !!entry.clientId);
  return {
    lawFirmId,
    type: isClient ? "client" : "matter",
    entityId: isClient
      ? entry.clientId || entry.entityId || ""
      : entry.matterId || entry.entityId || "",
  };
}

/**
 * Whether a time entry may still be changed.
 *
 * Time that has reached an invoice is part of a document already sent, so it is
 * read-only wherever it is listed. Editing it there would silently disagree with
 * the client's copy; the invoice is the place to adjust it.
 *
 * This is the server's rule exactly: the time-entry update and delete routes
 * refuse only an entry a line item on a non-voided invoice names
 * (`billingReads.isSourceBilled`), which the firm list reports as `billed`.
 * `queued` and `covered_by_retainer` time is on no invoice, so it stays
 * editable and deletable.
 */
export function isTimeEntryLocked(entry: { billingStatus?: string | null }): boolean {
  return entry.billingStatus === "billed";
}

/** Default time-entry filter shared by firm, matter and client lists. */
export const UNINVOICED_TIME_STATUSES = "unbilled,queued,covered_by_retainer";
