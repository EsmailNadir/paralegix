import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import type { CardFeeEligibility, CardFeeRow } from '@/types/cardFees';
import { REQUEST_TIMEOUT_MS } from '@/lib/constants/requestTimeouts';
import { toApiError, ApiError } from '@/lib/utils/apiErrors';
import {
  applyListSortSearch,
  applyListWindow,
  type ListSortItem,
} from '@/lib/utils/listQuery';
import requestDeduplicator from './requestDeduplicator';
import { authenticatedHeaders } from './base.service';
import { uploadResumable } from '@/lib/files/resumableUpload';
import type {
  BillingContext,
  BillingPlan,
  BillingPlanPeriod,
  BillingWorkbenchResponse,
  Expense,
  FlatFee,
  FirmBillingInvoice,
  FirmBillingTimeEntry,
  Invoice,
  InvoiceLineItemInput,
  PaymentDate,
  TimeEntry,
  UnbilledWorkResponse,
  UnbilledSummary,
  SplitBillingMode,
} from '@/types';
import type { ChargeCode } from '@/types/chargeCode';
import { track } from "@/lib/analytics/analytics";
import { hourlyAmount } from "@/lib/utils/currency";

/** Whether the client pays each method's processing fee on one request. */
export interface PaymentFeeChoice {
  card: boolean;
  bank: boolean;
}

export interface PaymentFeeQuote {
  invoiceCents: number;
  /** The firm's billing setting, which the dialog's choice starts from. */
  firmDefault: PaymentFeeChoice;
  /** Who an emailed payment link would go to: the invoice's billing emails. */
  emailTo: string[];
  /**
   * One entry per method. A card whose fee the client pays has no single fee,
   * since debit cards never carry one, so it carries `cardRows` instead.
   */
  methods: Array<
    | {
        method: 'card' | 'bank';
        paidBy: 'firm' | 'client';
        feeCents: number;
        clientPaysCents: number;
        firmReceivesCents: number;
        cardRows?: undefined;
      }
    | { method: 'card'; paidBy: 'client'; cardRows: CardFeeRow[] }
  >;
  /** Whether the firm may pass the card fee on; the card box is locked with the reason when not. */
  cardFeeEligibility?: CardFeeEligibility;
}

export interface StripePaymentRequestResult {
  message: string;
  /** The secure payment link the client opens to pay. */
  paymentUrl: string;
}

export interface BillingSettings {
  clientPaymentEmails: boolean;
}

/** Largest page the firm billing list endpoints will serve. */
export const FIRM_BILLING_MAX_LIMIT = 200;

/**
 * How many pages `listFirmTimeEntriesAll` will walk before it stops and reports
 * the selection as incomplete.
 *
 * The route serves at most `FIRM_BILLING_MAX_LIMIT` rows per request, so "select
 * every matching entry" is a sequence of reads. They run ONE AT A TIME: the API
 * instance holds twelve Postgres connections for every user on it, and a
 * select-all that fanned its pages out in parallel would take a share of them
 * per click. The cap bounds that sequence at five round trips, which is also
 * what keeps a bulk action's id list a size the browser can act on.
 */
export const FIRM_TIME_ENTRY_SELECT_ALL_MAX_PAGES = 5;

/** Most entries one "select all matching" read will gather. */
export const FIRM_TIME_ENTRY_SELECT_ALL_CEILING =
  FIRM_BILLING_MAX_LIMIT * FIRM_TIME_ENTRY_SELECT_ALL_MAX_PAGES;

/**
 * Most matter ids `GET /billing/flat-fees/firm` accepts in one request.
 *
 * Mirrors `MAX_FIRM_MATTER_IDS` on the route, which refuses a longer list with a
 * 400 rather than quietly dropping its tail. A caller holding more matters than
 * this splits them and merges the answers.
 */
export const FIRM_FLAT_FEE_MAX_MATTER_IDS = FIRM_BILLING_MAX_LIMIT;

/**
 * The billing statuses that mean "work that has not been invoiced yet".
 *
 * A time entry the firm has not billed is `unbilled`, `queued` (sitting on a
 * draft invoice) or `covered_by_retainer`. Only `billed` is off the table, so
 * asking for this set is the server-side spelling of the `!isBilled` filter the
 * per-context reads apply in the browser.
 */
export const UNINVOICED_BILLING_STATUSES = 'unbilled,queued,covered_by_retainer';

/** Due buckets the upcoming-payments list groups outstanding invoices into. */
export type InvoiceDueGroup = 'overdue' | 'this_week' | 'this_month' | 'later' | 'no_date';

/** Per-bucket count and outstanding total across the whole awaiting set. */
export type InvoiceDueGroupTotals = Partial<
  Record<InvoiceDueGroup | 'all', { count: number; amount: number }>
>;

export interface FirmInvoiceListParams {
  /** 1-based. */
  page?: number;
  limit?: number;
  /**
   * Absolute row offset. Wins over `page` in `applyListWindow`, matching the
   * server, so a caller sends one or the other and never both.
   */
  offset?: number;
  sort?: ListSortItem[];
  search?: string;
  matterId?: string;
  clientId?: string;
  /**
   * Every invoice under one client relationship: their direct invoices plus
   * every invoice on a matter they are on, co-client invoices included. Wider
   * than `clientId`, which asks who an invoice was billed TO.
   */
  clientScope?: string;
  billingRelation?: 'owned' | 'other_client' | 'shared_unassigned';
  relatedClientId?: string;
  includeDetails?: boolean;
  /** A derived status key, or the `unpaid` / `due_soon` pseudo-statuses. */
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Custom range over the same next-payment day the `dueGroup` buckets use. */
  dueDateFrom?: string;
  dueDateTo?: string;
  dueGroup?: string;
  /** Restrict to invoices the firm is still owed money on. */
  awaitingOnly?: boolean;
}

export interface FirmInvoicePage {
  invoices: FirmBillingInvoice[];
  totalItems: number;
  /**
   * How many invoices sit in each status, for the filter chips above a list.
   * Counted over the matter/client scope and NOT the status filter, so picking a
   * chip doesn't zero every other chip. `overdue` overlaps the other keys: a
   * partially-paid invoice past its next payment date is in both.
   */
  statusCounts: Record<string, number>;
  /**
   * Billed / paid / outstanding across the invoices the scoped client actually
   * owes on (`billingRelation === "owned"`), over the whole scope rather than
   * the page or the active filters. Zeroes when no `clientScope` was requested.
   */
  summary: {
    ownedCount: number;
    totalBilled: number;
    totalPaid: number;
    totalOutstanding: number;
  };
  /** Present only when `awaitingOnly` was requested. */
  dueGroupTotals?: InvoiceDueGroupTotals;
}

/**
 * One matter's roll-up in the "Billing by matter" report, aggregated by the
 * server. The money figures cover the matter's whole lifetime, so the report
 * shows firm-wide truth without the browser ever holding the underlying entries.
 */
export interface BillingByMatterRow {
  id: string;
  name: string;
  status: string;
  practiceAreaName: string;
  clientNames: string[];
  timeEntryCount: number;
  totalHours: number;
  invoiceCount: number;
  totalBilled: number;
  totalOutstanding: number;
  nextPaymentDate: string | null;
  nextPaymentAmount: number | null;
  nextPaymentFromPlan: boolean;
  nextPaymentInvoiceName: string | null;
}

export interface BillingByMatterReportParams {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
  practiceArea?: string;
}

export interface BillingByMatterReport {
  rows: BillingByMatterRow[];
  /** Size of the whole filtered set, not the page. */
  totalItems: number;
  /**
   * Invoices billed straight to a client, which sit under no matter and so appear
   * in no row. Firm-wide and NOT narrowed by the caller's filters: it states what
   * this grouping cannot show at all.
   */
  unlinkedInvoices: { count: number; totalAmount: number };
  /**
   * Options for the practice-area filter, taken from the matters that appear in
   * the report - and, like the unlinked totals, not narrowed by the active
   * filters, or choosing one would leave it as the only option on offer.
   */
  practiceAreas: string[];
}

/**
 * One client's roll-up in the "Billing by client" report.
 *
 * Attribution follows the same two rules the browser applied: work that names a
 * client belongs to that client, and work that names nobody belongs to the
 * matter's sole client and to no one at all on a multi-client matter.
 */
export interface BillingByClientRow {
  id: string;
  clientId: string;
  name: string;
  matterNames: string[];
  matterCount: number;
  timeEntryCount: number;
  totalHours: number;
  invoiceCount: number;
  totalBilled: number;
  totalOutstanding: number;
  nextPaymentDate: string | null;
  nextPaymentAmount: number | null;
  nextPaymentFromPlan: boolean;
  nextPaymentInvoiceName: string | null;
}

export interface BillingByClientReport {
  rows: BillingByClientRow[];
  /** Size of the whole filtered set, not the page. */
  totalItems: number;
  /**
   * Money on invoices that belong to no client row - a matter invoice naming
   * nobody on a matter with several clients. Firm-wide and not narrowed by the
   * search, because it states what this grouping cannot show at all.
   */
  unattributedInvoices: { count: number; totalAmount: number };
}

/** One matter's share of a client's roll-up, for the report's detail modal. */
export interface BillingClientMatterRow {
  id: string;
  name: string;
  status: string;
  hours: number;
  billed: number;
  outstanding: number;
  invoiceCount: number;
}

export interface FirmTimeEntryListParams {
  page?: number;
  limit?: number;
  sort?: ListSortItem[];
  search?: string;
  context?: string;
  matterId?: string;
  clientId?: string;
  /**
   * Everything under one client relationship: their direct entries plus every
   * entry on a matter they are on. Wider than `clientId`, which asks who the work
   * is billed TO and therefore drops matter work nobody has been charged for yet.
   */
  clientScope?: string;
  userId?: string;
  chargeCodeId?: string;
  billingStatus?: string;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * What `POST /billing/time-entries/bulk-delete` answers.
 *
 * The repo's bulk envelope. `deleted` and `failed` are both needed to report the
 * run honestly: a 200 here does NOT mean every id went, it means the server
 * reached a decision about each one.
 */
export interface BulkDeleteTimeEntriesResult {
  /** Ids the caller sent. */
  requested: number;
  /** Rows actually removed. */
  deleted: number;
  /** Ids the server refused, which the caller should leave selected for retry. */
  failed: string[];
  /** Why each refused id was refused, keyed by id. */
  errors: Record<string, string>;
}

export interface FirmTimeEntrySelection extends FirmTimeEntryPage {
  /**
   * The gathered entries are NOT the whole match set: the walk hit
   * `FIRM_TIME_ENTRY_SELECT_ALL_CEILING` before `totalItems` did. A caller that
   * acts on the ids (bulk invoice, bulk delete) must say so rather than present
   * the subset as everything that matched.
   */
  truncated: boolean;
}

export interface FirmTimeEntryPage {
  timeEntries: FirmBillingTimeEntry[];
  totalItems: number;
  /**
   * Hours and value of everything the filters matched, NOT of the page on
   * screen, so a windowed list can still state the real total.
   */
  summary: { totalHours: number; totalAmount: number };
}

export interface BillingSummary {
  totalBilled: number;
  totalCollected: number;
  totalOutstanding: number;
  totalHoursThisMonth: number;
  totalRevenueThisMonth: number;
  overdueCount: number;
  overdueAmount: number;
  /** Invoices the firm is still owed money on, and how much, firm-wide. */
  awaitingCount: number;
  awaitingAmount: number;
  totalInvoices: number;
  /** Time entries not yet on an invoice, firm-wide. */
  unbilledTimeEntryCount: number;
  totalMatters: number;
}

export interface CreateTimeEntryPayload {
  userId: string;
  hours: number;
  date: string;
  matterClientId?: string | null;
  matterClientIds?: string[] | null;
  name?: string;
  description?: string;
  hourlyRate?: number | null;
  chargeCodeId?: string | null;
  sourceTaskId?: string | null;
  sourceEventId?: string | null;
  utbmsTaskCode?: string | null;
  utbmsActivityCode?: string | null;
  billable?: boolean;
}

/** A matter or client that has work waiting to be invoiced. */
export interface FirmUnbilledSummary {
  type: 'matter' | 'client';
  entityId: string;
  name: string;
  unbilledHours: number;
  unbilledFlatFees: number;
  unbilledTimeAmount: number;
  unbilledAmount: number;
}

export interface UpdateTimeEntryPayload {
  hours?: number;
  date?: string;
  matterClientId?: string | null;
  matterClientIds?: string[] | null;
  /**
   * Moves a client-logged entry onto one of that client's matters. Only valid
   * on a client-context entry that has not been billed.
   */
  matterId?: string;
  name?: string;
  description?: string;
  hourlyRate?: number | null;
  chargeCodeId?: string | null;
  sourceTaskId?: string | null;
  sourceEventId?: string | null;
  utbmsTaskCode?: string | null;
  utbmsActivityCode?: string | null;
  billable?: boolean;
}

export interface FirmFlatFeeListParams {
  page?: number;
  limit?: number;
  offset?: number;
  /** Matter ids to include, at most `FIRM_FLAT_FEE_MAX_MATTER_IDS` of them. */
  matterIds?: string[];
  clientId?: string;
  context?: 'matter' | 'client';
  /** `billed`, `unbilled`, or both comma-separated. */
  billingStatus?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Ask for `totalItems` and `summary` without a single row. */
  countOnly?: boolean;
}

export interface FirmFlatFeePage {
  flatFees: FlatFee[];
  /** Size of the whole match set, not of the page. */
  totalItems: number;
  /**
   * Rows the window withheld. The route caps every page, including one that
   * asked for no `limit`, so a caller must say so rather than present the page
   * as everything that matched.
   */
  truncated: boolean;
  summary: { totalAmount: number };
}

export interface CreateFlatFeePayload {
  description: string;
  amount: number;
  date?: string | null;
}

export interface UpdateFlatFeePayload {
  description?: string;
  amount?: number;
  date?: string | null;
}

export interface CreateExpensePayload {
  description: string;
  amount: number;
  date?: string | null;
  category?: string;
  vendor?: string;
  billable?: boolean;
}

export interface UpdateExpensePayload {
  description?: string;
  amount?: number;
  date?: string | null;
  category?: string;
  vendor?: string;
  billable?: boolean;
}

export interface CreateInvoicePayload {
  matterId?: string;
  contextClientId?: string;
  invoiceName: string;
  invoiceNumber?: string | null;
  invoiceDate: string;
  dueDate?: string | null;
  billingEmail?: string | null;
  notes?: string | null;
  clientId?: string | null;
  remitTo?:
    | {
        name?: string;
        address?: string;
        city?: string;
        state?: string;
        zip?: string;
      }
    | string
    | null;
  // `id` is the saved activity a line bills. A line with no `id` is a manual
  // line: billed as typed, and linked to no activity.
  timeEntries?: Array<{
    id?: string;
    name?: string;
    description?: string;
    rate?: number;
    hours?: number;
    amount: number;
  }>;
  flatFees?: Array<{
    id?: string;
    description: string;
    amount: number;
  }>;
  expenses?: Array<{
    id?: string;
    description: string;
    amount: number;
    category?: string;
    vendor?: string;
  }>;
  totalHours?: number;
  totalAmount?: number;
  flatFeesAmount?: number;
  expensesAmount?: number;
}

export interface CreateSplitInvoicesPayload {
  invoiceDate: string;
  dueDate?: string | null;
  notes?: string | null;
  remitTo?:
    | {
        name?: string;
        address?: string;
        city?: string;
        state?: string;
        zip?: string;
      }
    | string
    | null;
  splitMode: SplitBillingMode;
  sourceSelection: {
    timeEntries: string[];
    flatFees: string[];
  };
  invoices: Array<{
    matterClientId: string;
    invoiceName: string;
    invoiceNumber?: string | null;
    billingEmail?: string | null;
    timeEntries?: Array<{
      /** Absent on a hand-typed line, which the server bills as typed. */
      id?: string;
      name?: string;
      description?: string;
      rate?: number;
      hours?: number;
      amount: number;
      allocationPercent?: number;
      allocationAmount?: number;
    }>;
    flatFees?: Array<{
      id?: string;
      description: string;
      amount: number;
      allocationPercent?: number;
      allocationAmount?: number;
    }>;
    totalHours: number;
    totalAmount: number;
    flatFeesAmount: number;
    allocationPercent?: number;
    allocationAmount?: number;
  }>;
}

export interface PaymentPayload {
  isPaid?: boolean;
  paidDate?: string | null;
  paymentAmount?: number;
  nextPaymentDate?: string | null;
  allowOverpayment?: boolean;
  installmentIndex?: number;
  invoiceNumber?: string;
  paymentNote?: string;
  shortfallAction?: 'write_off' | 'add_to_next' | 'add_to_current';
  // Trust payment fields
  paymentSource?: 'trust' | 'external' | 'stripe';
  trustAccountId?: string;
  trustClientId?: string;
  trustClientName?: string;
}

export interface EditPaymentPayload {
  /** The payment's id from the invoice payload. When present it wins over the position. */
  paymentId?: string;
  paymentIndex?: number;
  amount?: number;
  date?: string;
  note?: string;
  invoiceNumber?: string | null;
}

export interface CreditNotePayload {
  amount: number;
  description?: string;
  type: 'write_off' | 'discount' | 'adjustment';
}

export interface SetPaymentPlanPayload {
  installmentAmount: number;
  frequencyDays: number;
  planStartDate: string;
  downPaymentAmount?: number;
  downPaymentAlreadyPaid?: boolean;
  downPaymentDueDate?: string;
}

export interface GenerateInvoiceFromUnbilledPayload {
  invoiceName: string;
  invoiceDate: string;
  dueDate?: string;
  billingEmail?: string;
  notes?: string;
  clientId?: string;
  remitTo?:
    | {
        name?: string;
        address?: string;
        city?: string;
        state?: string;
        zip?: string;
      }
    | null;
  selectedTimeEntryIds: string[];
  selectedFlatFeeIds: string[];
  timeEntryRates: Record<string, number>;
}

export interface CreateBillingPlanPayload {
  contextType: 'matter' | 'client';
  entityId: string;
  planType?: 'retainer';
  name: string;
  status?: 'active' | 'paused' | 'ended';
  intervalUnit: 'week' | 'month';
  intervalCount?: number;
  startDate: string;
  nextRunDate?: string;
  amount: number;
  includedHours?: number;
  billingEmail?: string | null;
  defaultDueDays?: number;
  defaultClientId?: string | null;
  notes?: string | null;
  endCondition?: 'manual' | 'matter_closed' | 'date';
  endDate?: string | null;
}

export interface UpdateBillingPlanPayload {
  name?: string;
  status?: 'active' | 'paused' | 'ended';
  intervalUnit?: 'week' | 'month';
  intervalCount?: number;
  startDate?: string;
  nextRunDate?: string;
  amount?: number;
  includedHours?: number;
  billingEmail?: string | null;
  defaultDueDays?: number;
  defaultClientId?: string | null;
  notes?: string | null;
  endCondition?: 'manual' | 'matter_closed' | 'date';
  endDate?: string | null;
}

async function safeJson(res: Response): Promise<any | null> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}


/** One preserved copy of an invoice, as it was emailed to the client. */
export interface InvoiceSentCopy {
  /** Storage name, which is also what the download route takes. */
  name: string;
  sizeBytes: number;
  /** When this copy went out, or null if the store did not report a time. */
  sentAt: string | null;
}

class BillingService {
  private baseApi: string;

  constructor() {
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    this.baseApi = API_URL.replace(/\/$/, '');
  }

  private getBillingBase(lawFirmId: string): string {
    return `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/billing`;
  }

  private getContextSegment(context: BillingContext): string {
    return `${context.type}/${encodeURIComponent(context.entityId)}`;
  }

  private async getAuthHeaders(options?: { json?: boolean; timezone?: boolean }): Promise<Record<string, string>> {
    const extra: Record<string, string> = {};
    if (options?.json) extra['Content-Type'] = 'application/json';
    return authenticatedHeaders(extra, { timezone: options?.timezone ?? true });
  }

  private buildContextBody(context: BillingContext): { matterId?: string; clientId?: string } {
    if (context.type === 'matter') {
      return { matterId: context.entityId };
    }
    return { clientId: context.entityId };
  }

  // Time entries
  /**
   * Time entries for one matter/client context.
   *
   * `unbilledOnly` asks the server to drop entries already carried by an invoice.
   * Opt-in: without it the complete list comes back, billed entries included.
   * Prefer it over fetching everything and filtering `isBilled` in the browser - 
   * on a long-running matter the billed entries are the overwhelming majority and
   * are downloaded only to be discarded.
   */
  async listTimeEntries(
    context: BillingContext,
    userId?: string,
    options?: { unbilledOnly?: boolean },
  ): Promise<TimeEntry[]> {
    const url = new URL(
      `${this.getBillingBase(context.lawFirmId)}/time-entries/${this.getContextSegment(context)}`,
    );

    if (userId) {
      url.searchParams.append('userId', userId);
    }

    if (options?.unbilledOnly) {
      url.searchParams.append('unbilledOnly', 'true');
    }

    const response = await apiFetch(url.toString(), {
      method: 'GET',
      headers: await this.getAuthHeaders({ timezone: true }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch time entries');
    }

    const body = (await response.json()) as { timeEntries?: TimeEntry[] };
    return body.timeEntries || [];
  }


  /** One server-filtered, server-ordered page of the firm's time entries. */
  async listFirmTimeEntriesPage(
    lawFirmId: string,
    params: FirmTimeEntryListParams = {},
  ): Promise<FirmTimeEntryPage> {
    const url = new URL(`${this.getBillingBase(lawFirmId)}/time-entries/firm`);
    applyListWindow(url, params, { defaultLimit: 10, maxLimit: FIRM_BILLING_MAX_LIMIT });
    applyListSortSearch(url, { search: params.search, sort: params.sort });
    for (const key of [
      'context', 'matterId', 'clientId', 'clientScope', 'userId', 'chargeCodeId', 'billingStatus',
      'dateFrom', 'dateTo',
    ] as const) {
      const value = params[key];
      if (value) url.searchParams.set(key, value);
    }

    const response = await apiFetch(url.toString(), {
      method: 'GET',
      headers: await this.getAuthHeaders({ timezone: true }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch firm time entries');
    }

    const body = (await response.json()) as Partial<FirmTimeEntryPage>;
    return {
      timeEntries: body.timeEntries || [],
      totalItems: body.totalItems ?? 0,
      summary: {
        totalHours: body.summary?.totalHours ?? 0,
        totalAmount: body.summary?.totalAmount ?? 0,
      },
    };
  }

  /**
   * Every server-filtered, server-ordered time entry matching the query, for
   * selecting across pages and then acting on the selection in bulk.
   *
   * Walks the paged route SEQUENTIALLY, at `FIRM_BILLING_MAX_LIMIT` rows per
   * request and at most `FIRM_TIME_ENTRY_SELECT_ALL_MAX_PAGES` requests. The
   * window is always sent: a request with no `limit` is answered with the
   * endpoint's own 200-row clamp, and a caller reading only `timeEntries` cannot
   * tell that from a complete answer, which is how "select all 1,250" came to
   * select 200 and bulk-delete them.
   *
   * `truncated` is the honest half of the contract. `totalItems` and `summary`
   * describe the whole match set, `timeEntries` only what the walk reached, and a
   * caller must present the shortfall rather than the total. Entries are keyed by
   * id while collecting, so a row that shifts between two pages (a concurrent
   * edit reorders the underlying list) is held once rather than double-counted
   * into a selection that looks complete and is not.
   */
  async listFirmTimeEntriesAll(
    lawFirmId: string,
    params: Omit<FirmTimeEntryListParams, "page" | "limit"> = {},
  ): Promise<FirmTimeEntrySelection> {
    const collected = new Map<string, FirmBillingTimeEntry>();
    let totalItems = 0;
    let summary = { totalHours: 0, totalAmount: 0 };

    for (let page = 1; page <= FIRM_TIME_ENTRY_SELECT_ALL_MAX_PAGES; page += 1) {
      const result = await this.listFirmTimeEntriesPage(lawFirmId, {
        ...params,
        page,
        limit: FIRM_BILLING_MAX_LIMIT,
      });

      totalItems = result.totalItems;
      summary = result.summary;
      for (const entry of result.timeEntries) collected.set(entry.id, entry);

      // A short page is the last one, whatever the reported total says.
      if (result.timeEntries.length < FIRM_BILLING_MAX_LIMIT) break;
      if (collected.size >= totalItems) break;
    }

    return {
      timeEntries: Array.from(collected.values()),
      totalItems,
      summary,
      truncated: collected.size < totalItems,
    };
  }

  async createTimeEntry(context: BillingContext, payload: CreateTimeEntryPayload): Promise<TimeEntry> {
    const response = await apiFetch(`${this.getBillingBase(context.lawFirmId)}/time-entries`, {
      method: 'POST',
      headers: await this.getAuthHeaders({ json: true, timezone: true }),
      body: JSON.stringify({
        ...this.buildContextBody(context),
        ...payload,
      }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to create time entry');
    }

    const body = (await response.json()) as { timeEntry: TimeEntry };
    return body.timeEntry;
  }

  async updateTimeEntry(
    context: BillingContext,
    timeEntryId: string,
    payload: UpdateTimeEntryPayload,
  ): Promise<TimeEntry> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/time-entries/${this.getContextSegment(context)}/${encodeURIComponent(timeEntryId)}`,
      {
        method: 'PUT',
        headers: await this.getAuthHeaders({ json: true, timezone: true }),
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to update time entry');
    }

    const body = (await response.json()) as { timeEntry: TimeEntry };
    return body.timeEntry;
  }

  async deleteTimeEntry(context: BillingContext, timeEntryId: string): Promise<void> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/time-entries/${this.getContextSegment(context)}/${encodeURIComponent(timeEntryId)}`,
      {
        method: 'DELETE',
        headers: await this.getAuthHeaders(),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to delete time entry');
    }
  }

  /**
   * Delete a selection of time entries in ONE request.
   *
   * Replaces one DELETE per selected row. A select-all delete on the firm list
   * reaches `FIRM_TIME_ENTRY_SELECT_ALL_CEILING` rows, and the API instance
   * holds twelve Postgres connections for every user on it, so a thousand round
   * trips took the pool away from the whole firm for as long as the run lasted.
   *
   * Takes a firm id rather than a `BillingContext` because a selection is
   * assembled from the firm-wide list and spans matters and clients; the server
   * reads each entry's own context.
   *
   * NOT all-or-nothing. The route answers per entry, so an entry the caller may
   * not delete (billed on an invoice, or on a matter they are not staffed on)
   * comes back in `failed`/`errors` while the rest are deleted. Callers must
   * report both halves rather than treating a 200 as "all of them went".
   *
   * The route caps the list at the same 1,000 the select-all walk can gather and
   * refuses a longer one with a 400 rather than truncating it.
   */
  async bulkDeleteTimeEntries(
    lawFirmId: string,
    timeEntryIds: string[],
  ): Promise<BulkDeleteTimeEntriesResult> {
    const response = await apiFetch(
      `${this.getBillingBase(lawFirmId)}/time-entries/bulk-delete`,
      {
        method: 'POST',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify({ timeEntryIds }),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to delete time entries');
    }

    return (await response.json()) as BulkDeleteTimeEntriesResult;
  }

  // Flat fees
  /** As `listTimeEntries`: `unbilledOnly` is opt-in server-side filtering. */
  async listFlatFees(context: BillingContext, options?: { unbilledOnly?: boolean }): Promise<FlatFee[]> {
    const url = new URL(
      `${this.getBillingBase(context.lawFirmId)}/flat-fees/${this.getContextSegment(context)}`,
    );

    if (options?.unbilledOnly) {
      url.searchParams.append('unbilledOnly', 'true');
    }

    const response = await apiFetch(
      url.toString(),
      {
        method: 'GET',
        headers: await this.getAuthHeaders(),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch flat fees');
    }

    const body = (await response.json()) as { flatFees?: FlatFee[] };
    return body.flatFees || [];
  }

  /**
   * One bounded page of the firm's flat fees, across matters and clients at
   * once.
   *
   * `clientId` and `matterIds` are OR'd server-side, not AND'd: sending both
   * asks "this client's own fees plus the fees on these matters", which is the
   * client billing screens' whole question. Use it instead of looping
   * `listFlatFees` per matter.
   */
  async listFirmFlatFeesPage(
    lawFirmId: string,
    params: FirmFlatFeeListParams = {},
  ): Promise<FirmFlatFeePage> {
    const url = new URL(`${this.getBillingBase(lawFirmId)}/flat-fees/firm`);
    applyListWindow(url, params, {
      defaultLimit: FIRM_BILLING_MAX_LIMIT,
      maxLimit: FIRM_BILLING_MAX_LIMIT,
    });
    for (const key of ['clientId', 'context', 'billingStatus', 'dateFrom', 'dateTo'] as const) {
      const value = params[key];
      if (value) url.searchParams.set(key, value);
    }
    // An EMPTY list is not "no filter": the server reads a named-but-empty set
    // as "these matters", and answers it with nothing. Omit the key instead.
    if (params.matterIds && params.matterIds.length > 0) {
      url.searchParams.set('matterIds', params.matterIds.join(','));
    }
    if (params.countOnly) url.searchParams.set('countOnly', 'true');

    const response = await apiFetch(url.toString(), {
      method: 'GET',
      headers: await this.getAuthHeaders(),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch flat fees');
    }

    const body = (await response.json()) as Partial<FirmFlatFeePage>;
    return {
      flatFees: body.flatFees || [],
      totalItems: body.totalItems ?? 0,
      truncated: body.truncated === true,
      summary: { totalAmount: body.summary?.totalAmount ?? 0 },
    };
  }

  /**
   * Every flat fee under one client relationship: the client's own fees plus the
   * fees on the matters named.
   *
   * ONE request for a client whose matters fit the route's id ceiling, which is
   * every client short of two hundred matters. Beyond that the ids are split and
   * the reads run ONE AT A TIME, for the reason `listFirmTimeEntriesAll` walks
   * its pages sequentially: the API instance shares twelve Postgres connections
   * across every user on it, and a fan-out takes a share of them per click.
   * `clientId` rides on the first read only, so the client's own fees are
   * counted once rather than once per chunk.
   *
   * Asking for neither a client nor a matter sends NO request: the route with no
   * filters answers for the whole firm, which is never what a client screen
   * means by "this client has nothing linked".
   */
  async listClientScopeFlatFees(
    lawFirmId: string,
    {
      clientId,
      matterIds = [],
      billingStatus,
      countOnly,
    }: {
      clientId?: string;
      matterIds?: string[];
      billingStatus?: string;
      countOnly?: boolean;
    },
  ): Promise<FirmFlatFeePage> {
    const empty: FirmFlatFeePage = {
      flatFees: [], totalItems: 0, truncated: false, summary: { totalAmount: 0 },
    };
    if (!clientId && matterIds.length === 0) return empty;

    const chunks: string[][] = [];
    for (let i = 0; i < matterIds.length; i += FIRM_FLAT_FEE_MAX_MATTER_IDS) {
      chunks.push(matterIds.slice(i, i + FIRM_FLAT_FEE_MAX_MATTER_IDS));
    }
    if (chunks.length === 0) chunks.push([]);

    const merged: FirmFlatFeePage = { ...empty, summary: { totalAmount: 0 } };
    for (const [index, chunk] of chunks.entries()) {
      const page = await this.listFirmFlatFeesPage(lawFirmId, {
        clientId: index === 0 ? clientId : undefined,
        matterIds: chunk,
        billingStatus,
        countOnly,
        limit: FIRM_BILLING_MAX_LIMIT,
      });
      merged.flatFees.push(...page.flatFees);
      merged.totalItems += page.totalItems;
      merged.truncated = merged.truncated || page.truncated;
      merged.summary.totalAmount += page.summary.totalAmount;
    }
    return merged;
  }

  async addFlatFee(context: BillingContext, payload: CreateFlatFeePayload): Promise<FlatFee> {
    const response = await apiFetch(`${this.getBillingBase(context.lawFirmId)}/flat-fees`, {
      method: 'POST',
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify({
        ...this.buildContextBody(context),
        ...payload,
      }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to add flat fee');
    }

    const body = (await response.json()) as { flatFee: FlatFee };
    return body.flatFee;
  }

  async updateFlatFee(context: BillingContext, flatFeeId: string, payload: UpdateFlatFeePayload): Promise<FlatFee> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/flat-fees/${this.getContextSegment(context)}/${encodeURIComponent(flatFeeId)}`,
      {
        method: 'PUT',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to update flat fee');
    }

    const body = (await response.json()) as { flatFee: FlatFee };
    return body.flatFee;
  }

  async removeFlatFee(context: BillingContext, flatFeeId: string): Promise<void> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/flat-fees/${this.getContextSegment(context)}/${encodeURIComponent(flatFeeId)}`,
      {
        method: 'DELETE',
        headers: await this.getAuthHeaders(),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to remove flat fee');
    }
  }

  // Expenses
  async listExpenses(context: BillingContext): Promise<Expense[]> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/expenses/${this.getContextSegment(context)}`,
      {
        method: 'GET',
        headers: await this.getAuthHeaders(),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch expenses');
    }

    const body = (await response.json()) as { expenses?: Expense[] };
    return body.expenses || [];
  }

  async addExpense(context: BillingContext, payload: CreateExpensePayload): Promise<Expense> {
    const response = await apiFetch(`${this.getBillingBase(context.lawFirmId)}/expenses`, {
      method: 'POST',
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify({
        ...this.buildContextBody(context),
        ...payload,
      }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to add expense');
    }

    const body = (await response.json()) as { expense: Expense };
    return body.expense;
  }

  async updateExpense(context: BillingContext, expenseId: string, payload: UpdateExpensePayload): Promise<Expense> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/expenses/${this.getContextSegment(context)}/${encodeURIComponent(expenseId)}`,
      {
        method: 'PUT',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to update expense');
    }

    const body = (await response.json()) as { expense: Expense };
    return body.expense;
  }

  async removeExpense(context: BillingContext, expenseId: string): Promise<void> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/expenses/${this.getContextSegment(context)}/${encodeURIComponent(expenseId)}`,
      {
        method: 'DELETE',
        headers: await this.getAuthHeaders(),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to remove expense');
    }
  }

  // Invoices
  async listInvoices(context: BillingContext): Promise<Invoice[]> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}`,
      {
        method: 'GET',
        headers: await this.getAuthHeaders(),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch invoices');
    }

    const body = (await response.json()) as { invoices?: Invoice[] };
    return body.invoices || [];
  }

  /**
   * Email an invoice, with the rendered PDF as its attachment.
   *
   * The PDF goes to STORAGE first and the send carries only its path. It used
   * to be base64 in the request body, which cost the API container the raw
   * bytes, the string they arrived as and the buffer they decoded to, all at
   * once, under a 50 MiB body ceiling on an instance serving 80 concurrent
   * requests. The tab paid for it too: building that string walked the whole
   * document one byte at a time.
   *
   * The upload carries no API credential. The session url IS the authorization,
   * and sending a bearer token to a storage host that never needed it widens
   * where that credential has been.
   */
  async sendInvoiceEmail(
    context: BillingContext,
    invoiceId: string,
    options: { recipientEmail: string; recipientName?: string; pdf: File },
  ): Promise<{ sent: boolean; to?: string[]; reason?: string }> {
    const base = `${this.getBillingBase(context.lawFirmId)}/invoices/`
      + `${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}`;

    const initResponse = await apiFetch(`${base}/send-email-init`, {
      method: 'POST',
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify({
        contentType: 'application/pdf',
        fileName: options.pdf.name,
        size: options.pdf.size,
      }),
    });
    const opened = await initResponse.json().catch(() => ({} as any));
    if (!initResponse.ok) {
      throw ApiError.fromResponse(initResponse, opened, 'Failed to send invoice email');
    }

    await uploadResumable({
      file: options.pdf,
      sessionUrl: opened.uploadUrl,
      contentType: 'application/pdf',
    });

    // Only after the PUT resolves. Sent before it, this would mail an invoice
    // with no attachment and archive nothing as the copy the client received.
    const response = await apiFetch(`${base}/send-email`, {
      method: 'POST',
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify({
        recipientEmail: options.recipientEmail,
        recipientName: options.recipientName,
        objectPath: opened.objectPath,
        pdfFileName: options.pdf.name,
      }),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) {
      throw ApiError.fromResponse(response, body, 'Failed to send invoice email');
    }
    return body as { sent: boolean; to?: string[]; reason?: string };
  }

  /**
   * The preserved copies of an invoice: one per time it was emailed, exactly as
   * the client received it. Distinct from downloading the invoice, which renders
   * from what it says today.
   */
  async listInvoiceSentCopies(
    lawFirmId: string,
    invoiceId: string,
  ): Promise<InvoiceSentCopy[]> {
    const response = await apiFetch(
      `${this.getBillingBase(lawFirmId)}/invoices/${encodeURIComponent(invoiceId)}/sent-copies`,
      { method: 'GET', headers: await this.getAuthHeaders() },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to load the sent copies of this invoice');
    }

    const body = (await response.json()) as { sentCopies?: InvoiceSentCopy[] };
    return body.sentCopies || [];
  }

  /**
   * Download one preserved copy of a sent invoice.
   *
   * The API answers with a short-lived signed url rather than the PDF itself,
   * so the bytes go storage to browser and never through the API container.
   * This used to pull the whole document into a Blob here, which held it in the
   * page as well as in the server that sent it.
   *
   * The filename the user sees rides on the url's own content disposition, set
   * when the url was signed, so the saved file is still labelled by invoice and
   * send date rather than by the storage object's opaque name.
   */
  async downloadInvoiceSentCopy(
    lawFirmId: string,
    invoiceId: string,
    name: string,
  ): Promise<void> {
    const response = await apiFetch(
      `${this.getBillingBase(lawFirmId)}/invoices/${encodeURIComponent(invoiceId)}/sent-copies/${encodeURIComponent(name)}`,
      { method: 'GET', headers: await this.getAuthHeaders() },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to download the sent copy');
    }

    const { signedUrl } = (await response.json()) as { signedUrl?: string };
    if (!signedUrl) {
      throw new Error('Failed to download the sent copy');
    }

    // Handed to the browser's own download manager. No Blob, so a large invoice
    // is never resident in the page.
    const link = document.createElement('a');
    link.href = signedUrl;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }


  /**
   * One page of the "Billing by matter" report.
   *
   * The rows are a GROUP BY over the firm's invoices and time entries, produced
   * in Postgres. This report used to be reduced in the browser from the firm's
   * complete lifetime time-entry and invoice lists, which is a download that
   * grows for as long as the firm does.
   */
  async getByMatterReport(
    lawFirmId: string,
    params: BillingByMatterReportParams = {},
  ): Promise<BillingByMatterReport> {
    const url = new URL(`${this.getBillingBase(lawFirmId)}/reports/by-matter`);
    if (params.page) url.searchParams.set('page', String(params.page));
    if (params.limit) url.searchParams.set('limit', String(params.limit));
    for (const key of ['search', 'status', 'practiceArea'] as const) {
      const value = params[key];
      if (value) url.searchParams.set(key, value);
    }

    const response = await apiFetch(url.toString(), {
      method: 'GET',
      // The viewer's timezone decides which payments read as overdue.
      headers: await this.getAuthHeaders({ timezone: true }),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to load the billing report');
    }

    const body = (await response.json()) as Partial<BillingByMatterReport>;
    return {
      rows: body.rows || [],
      totalItems: body.totalItems ?? 0,
      unlinkedInvoices: body.unlinkedInvoices || { count: 0, totalAmount: 0 },
      practiceAreas: body.practiceAreas || [],
    };
  }

  /**
   * One page of the "Billing by client" report - the same server-side GROUP BY
   * as the by-matter report, grouped by who the work is billed to.
   */
  async getByClientReport(
    lawFirmId: string,
    params: { page?: number; limit?: number; search?: string } = {},
  ): Promise<BillingByClientReport> {
    const url = new URL(`${this.getBillingBase(lawFirmId)}/reports/by-client`);
    if (params.page) url.searchParams.set('page', String(params.page));
    if (params.limit) url.searchParams.set('limit', String(params.limit));
    if (params.search) url.searchParams.set('search', params.search);

    const response = await apiFetch(url.toString(), {
      method: 'GET',
      headers: await this.getAuthHeaders({ timezone: true }),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to load the billing report');
    }

    const body = (await response.json()) as Partial<BillingByClientReport>;
    return {
      rows: body.rows || [],
      totalItems: body.totalItems ?? 0,
      unattributedInvoices: body.unattributedInvoices || { count: 0, totalAmount: 0 },
    };
  }

  /** The per-matter breakdown behind one client's card in the report. */
  async getClientMatterBreakdown(
    lawFirmId: string,
    clientId: string,
  ): Promise<BillingClientMatterRow[]> {
    const url = `${this.getBillingBase(lawFirmId)}/reports/by-client/${encodeURIComponent(clientId)}/matters`;
    const response = await apiFetch(url, {
      method: 'GET',
      headers: await this.getAuthHeaders({ timezone: true }),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to load the client breakdown');
    }
    const body = (await response.json()) as { matters?: BillingClientMatterRow[] };
    return body.matters || [];
  }

  /**
   * One server-filtered, server-ordered page of the firm's invoices.
   *
   * With `awaitingOnly` the response also carries `dueGroupTotals`: per-bucket
   * counts and outstanding totals across every awaiting invoice, not just the
   * returned page, so the upcoming-payments tiles show firm figures.
   */
  async listFirmInvoicesPage(
    lawFirmId: string,
    params: FirmInvoiceListParams = {},
  ): Promise<FirmInvoicePage> {
    const url = new URL(`${this.getBillingBase(lawFirmId)}/invoices/firm`);
    applyListWindow(url, params, { defaultLimit: 10, maxLimit: FIRM_BILLING_MAX_LIMIT });
    applyListSortSearch(url, { search: params.search, sort: params.sort });
    for (const key of ['matterId', 'clientId', 'clientScope', 'billingRelation', 'relatedClientId', 'status', 'dateFrom', 'dateTo', 'dueDateFrom', 'dueDateTo', 'dueGroup'] as const) {
      const value = params[key];
      if (value) url.searchParams.set(key, value);
    }
    if (params.awaitingOnly) url.searchParams.set('awaitingOnly', 'true');
    if (params.includeDetails) url.searchParams.set('includeDetails', 'true');

    const response = await apiFetch(url.toString(), {
      method: 'GET',
      headers: await this.getAuthHeaders({ timezone: true }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch firm invoices');
    }

    const body = (await response.json()) as Partial<FirmInvoicePage>;
    return {
      invoices: body.invoices || [],
      totalItems: body.totalItems ?? 0,
      statusCounts: body.statusCounts || {},
      summary: body.summary || { ownedCount: 0, totalBilled: 0, totalPaid: 0, totalOutstanding: 0 },
      dueGroupTotals: body.dueGroupTotals,
    };
  }

  async getInvoice(context: BillingContext, invoiceId: string): Promise<Invoice> {
    const invoices = await this.listInvoices(context);
    const invoice = invoices.find((inv) => inv.id === invoiceId);
    if (!invoice) {
      throw new Error('Invoice not found');
    }
    return invoice;
  }

  async createInvoice(context: BillingContext, payload: CreateInvoicePayload): Promise<Invoice> {
    const base = this.getBillingBase(context.lawFirmId);
    const endpoint = context.type === 'matter'
      ? `${base}/invoices`
      : `${base}/invoices/client/${encodeURIComponent(context.entityId)}`;

    const body: Record<string, unknown> = {
      ...payload,
      ...(context.type === 'matter'
        ? { matterId: context.entityId }
        : { contextClientId: context.entityId }),
    };

    const response = await apiFetch(endpoint, {
      method: 'POST',
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await safeJson(response);
      const detailMsg = err?.details?.splitInvoices?.[0] || err?.details?.formErrors?.[0] || (err?.details?.fieldErrors ? Object.values(err.details.fieldErrors).flat()[0] : null);
      throw new ApiError(detailMsg || err?.error || 'Failed to create invoice', {
        status: response.status,
        code: err?.code,
        details: err?.details,
        requestId: err?.requestId,
      });
    }

    const result = (await response.json()) as { invoice: Invoice };
    track("invoice_created", {
      context_type: context.type,
      time_entry_count: payload.timeEntries?.length ?? 0,
      flat_fee_count: payload.flatFees?.length ?? 0,
    });
    return result.invoice;
  }

  async createSplitInvoices(
    lawFirmId: string,
    matterId: string,
    payload: CreateSplitInvoicesPayload,
  ): Promise<{ splitGroupId: string; createdCount: number; invoices: Invoice[] }> {
    const response = await apiFetch(
      `${this.getBillingBase(lawFirmId)}/invoices/matter/${encodeURIComponent(matterId)}/split`,
      {
        method: 'POST',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const err = await safeJson(response);
      const detailMsg = err?.details?.splitInvoices?.[0] || err?.details?.formErrors?.[0] || (err?.details?.fieldErrors ? Object.values(err.details.fieldErrors).flat()[0] : null);
      throw new ApiError(detailMsg || err?.error || 'Failed to create split invoices', {
        status: response.status,
        code: err?.code,
        details: err?.details,
        requestId: err?.requestId,
      });
    }

    return (await response.json()) as { splitGroupId: string; createdCount: number; invoices: Invoice[] };
  }

  async deleteInvoice(context: BillingContext, invoiceId: string): Promise<void> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}`,
      {
        method: 'DELETE',
        headers: await this.getAuthHeaders(),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to delete invoice');
    }
  }

  async updateInvoiceDetails(
    context: BillingContext,
    invoiceId: string,
    payload: {
      invoiceName?: string;
      invoiceNumber?: string | null;
      invoiceDate?: string | null;
      dueDate?: string | null;
      remitTo?: string | { name?: string; address?: string; city?: string; state?: string; zip?: string } | null;
    },
  ): Promise<Invoice> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}/details`,
      {
        method: 'PATCH',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      throw await toApiError(response, 'Failed to update invoice');
    }
    const data = await response.json();
    return data.invoice;
  }

  /**
   * Deliberately replace an already-issued invoice's frozen bill-to snapshot
   * with the client's current billing recipients (roster or client email).
   *
   * This is the one sanctioned way to rewrite billing history, for an invoice
   * that went out against stale or wrong recipient data. It does not return the
   * updated invoice, only the resolved recipients the caller should merge onto
   * its already-loaded invoice (`billingEmails`, `billingContactName`,
   * `billingContactTitle`, `billingContactEmail` <- `primaryEmail`,
   * `billingClientAddress` <- `clientAddress`, `billingSnapshotAt` <- `snapshotAt`).
   */
  async refreshBillingRecipients(
    context: BillingContext,
    invoiceId: string,
  ): Promise<{
    message: string;
    billingRecipients: {
      clientRecordId: string | null;
      clientType: 'person' | 'company' | null;
      clientName: string | null;
      clientAddress: string | null;
      contactName: string | null;
      contactTitle: string | null;
      primaryEmail: string | null;
      emails: string[];
      source: 'snapshot' | 'current';
      snapshotAt: string | null;
    };
  }> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}/billing-recipients/refresh`,
      {
        method: 'POST',
        headers: await this.getAuthHeaders({ json: true }),
      },
    );
    if (!response.ok) {
      throw await toApiError(response, 'Failed to refresh billing recipients');
    }
    return response.json();
  }

  /**
   * Replace an invoice's line items. Replace-all: send the complete surviving set
   * for every kind, since an omitted array clears that section.
   *
   * Lowering the total below what has already been settled comes back as a 409
   * `INVOICE_TOTAL_BELOW_SETTLED` whose `details.creditAmount` is the credit the
   * change would leave; re-send with `acknowledgeOverpayment` to go ahead.
   */
  async updateInvoiceLineItems(
    context: BillingContext,
    invoiceId: string,
    payload: {
      timeEntries: InvoiceLineItemInput[];
      flatFees: InvoiceLineItemInput[];
      expenses: InvoiceLineItemInput[];
      acknowledgeOverpayment?: boolean;
    },
  ): Promise<Invoice> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}/line-items`,
      {
        method: 'PATCH',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      throw await toApiError(response, 'Failed to update line items');
    }
    const body = (await response.json()) as { invoice: Invoice };
    return body.invoice;
  }

  async updateInvoicePayment(context: BillingContext, invoiceId: string, payload: PaymentPayload): Promise<Invoice> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}/payment`,
      {
        method: 'PUT',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to update invoice payment');
    }

    const body = (await response.json()) as { invoice: Invoice };
    return body.invoice;
  }

  async editInvoicePayment(context: BillingContext, invoiceId: string, payload: EditPaymentPayload): Promise<Invoice> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}/payment`,
      {
        method: 'PATCH',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to edit payment');
    }

    const body = (await response.json()) as { invoice: Invoice };
    return body.invoice;
  }

  /**
   * Removes one payment. `paymentId` names it exactly; the position is sent too so a
   * backend that predates payment ids still removes the right row.
   */
  async deleteInvoicePayment(
    context: BillingContext,
    invoiceId: string,
    paymentIndex: number,
    paymentId?: string,
  ): Promise<Invoice> {
    const url = new URL(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}/payment`,
    );
    url.searchParams.append('paymentIndex', String(paymentIndex));
    if (paymentId) url.searchParams.append('paymentId', paymentId);

    const response = await apiFetch(url.toString(), {
      method: 'DELETE',
      headers: await this.getAuthHeaders(),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to delete payment');
    }

    const body = (await response.json()) as { invoice: Invoice };
    return body.invoice;
  }

  async addAmountToInvoice(context: BillingContext, invoiceId: string, payload: { amount: number; note?: string }): Promise<Invoice> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}/add-amount`,
      {
        method: 'PATCH',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to add amount to invoice');
    }

    const body = (await response.json()) as { invoice: Invoice };
    return body.invoice;
  }

  async applyLateFee(context: BillingContext, invoiceId: string): Promise<{ invoice: Invoice; lateFeeAmount: number }> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}/late-fee`,
      {
        method: 'POST',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify({}),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to apply late fee');
    }

    const body = (await response.json()) as { invoice: Invoice; lateFeeAmount: number };
    return body;
  }

  async voidInvoice(context: BillingContext, invoiceId: string): Promise<{ message: string; invoice: Invoice }> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}/void`,
      {
        method: 'POST',
        headers: await this.getAuthHeaders(),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to void invoice');
    }

    return (await response.json()) as { message: string; invoice: Invoice };
  }

  async addCreditNote(context: BillingContext, invoiceId: string, payload: CreditNotePayload): Promise<Invoice> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}/credit-note`,
      {
        method: 'POST',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to add credit note');
    }

    const body = (await response.json()) as { invoice: Invoice };
    return body.invoice;
  }

  async deleteCreditNote(context: BillingContext, invoiceId: string, creditNoteId: string): Promise<Invoice> {
    const url = new URL(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}/credit-note`,
    );
    url.searchParams.append('creditNoteId', creditNoteId);

    const response = await apiFetch(url.toString(), {
      method: 'DELETE',
      headers: await this.getAuthHeaders(),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to delete credit note');
    }

    const body = (await response.json()) as { invoice: Invoice };
    return body.invoice;
  }

  async setPaymentPlan(context: BillingContext, invoiceId: string, payload: SetPaymentPlanPayload): Promise<Invoice> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}/payment-plan`,
      {
        method: 'POST',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to set payment plan');
    }

    const body = (await response.json()) as { invoice: Invoice };
    return body.invoice;
  }

  async removePaymentPlan(context: BillingContext, invoiceId: string): Promise<Invoice> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}/payment-plan`,
      {
        method: 'DELETE',
        headers: await this.getAuthHeaders(),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to remove payment plan');
    }

    const body = (await response.json()) as { invoice: Invoice };
    return body.invoice;
  }

  async updateInstallment(context: BillingContext, invoiceId: string, installmentIndex: number, payload: { dueDate?: string; amount?: number }): Promise<Invoice> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}/payment-plan/installment/${installmentIndex}`,
      {
        method: 'PATCH',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to update installment');
    }

    const body = (await response.json()) as { invoice: Invoice };
    return body.invoice;
  }

  async replacePaymentPlanSchedule(
    context: BillingContext,
    invoiceId: string,
    payload: { installments: { dueDate: string; amount: number }[]; frequencyDays?: number },
  ): Promise<Invoice> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}/payment-plan/schedule`,
      {
        method: 'PATCH',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to update payment plan schedule');
    }

    const body = (await response.json()) as { invoice: Invoice };
    return body.invoice;
  }

  /** `paymentId` is the payment that settled the installment; the server refuses if it no longer does. */
  async unpayInstallment(
    context: BillingContext,
    invoiceId: string,
    installmentIndex: number,
    paymentId?: string,
  ): Promise<Invoice> {
    const query = paymentId ? `?paymentId=${encodeURIComponent(paymentId)}` : '';
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}/payment-plan/installment/${installmentIndex}/payment${query}`,
      {
        method: 'DELETE',
        headers: await this.getAuthHeaders(),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to mark installment as unpaid');
    }

    const body = (await response.json()) as { invoice: Invoice };
    return body.invoice;
  }

  async getUnbilledSummary(context: BillingContext): Promise<UnbilledSummary> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/unbilled-summary`,
      {
        method: 'GET',
        headers: await this.getAuthHeaders(),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch unbilled summary');
    }

    return (await response.json()) as UnbilledSummary;
  }

  /**
   * Every matter and client with unbilled work, in one request. Replaces asking
   * for a summary per context, which opened one request per matter AND per
   * client just to render the invoice-run picker.
   */
  async listFirmUnbilledSummaries(lawFirmId: string): Promise<FirmUnbilledSummary[]> {
    const response = await apiFetch(
      `${this.getBillingBase(lawFirmId)}/invoices/firm/unbilled-summaries`,
      {
        method: 'GET',
        headers: await this.getAuthHeaders(),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch unbilled work');
    }

    const body = (await response.json()) as { summaries?: FirmUnbilledSummary[] };
    return body.summaries || [];
  }

  async generateInvoiceFromUnbilled(
    context: BillingContext,
    payload: GenerateInvoiceFromUnbilledPayload,
  ): Promise<Invoice> {
    const summary = await this.getUnbilledSummary(context);

    const selectedTimeEntries = summary.unbilledTimeEntries
      .filter((entry) => payload.selectedTimeEntryIds.includes(entry.id))
      .map((entry) => {
        const rate = payload.timeEntryRates[entry.id] || 0;
        return {
          id: entry.id,
          name: entry.name || 'Service',
          description: entry.description || undefined,
          rate,
          hours: entry.hours,
          amount: hourlyAmount(entry.hours, rate),
        };
      });

    const selectedFlatFees = summary.unbilledFlatFees
      .filter((fee) => payload.selectedFlatFeeIds.includes(fee.id))
      .map((fee) => ({
        id: fee.id,
        description: fee.description,
        amount: fee.amount,
      }));

    const totalHours = selectedTimeEntries.reduce((sum, entry) => sum + (entry.hours || 0), 0);
    const timeEntriesAmount = selectedTimeEntries.reduce((sum, entry) => sum + entry.amount, 0);
    const flatFeesAmount = selectedFlatFees.reduce((sum, fee) => sum + fee.amount, 0);

    return this.createInvoice(context, {
      invoiceName: payload.invoiceName,
      invoiceDate: payload.invoiceDate,
      dueDate: payload.dueDate || null,
      billingEmail: payload.billingEmail || null,
      notes: payload.notes || null,
      clientId: payload.clientId || context.clientId || null,
      remitTo: payload.remitTo || null,
      timeEntries: selectedTimeEntries,
      flatFees: selectedFlatFees,
      totalHours,
      totalAmount: Math.round((timeEntriesAmount + flatFeesAmount) * 100) / 100,
      flatFeesAmount,
    });
  }

  // Cross-context helpers
  async listClientInvoices(lawFirmId: string, clientId: string): Promise<Invoice[]> {
    return this.listInvoices({
      type: 'client',
      lawFirmId,
      entityId: clientId,
    });
  }

  /**
   * Payment dates for the calendar. `window` bounds the read to the days being
   * drawn; omitting it expands every invoice in the firm.
   *
   * The bounds are day-only and compared as calendar days server-side, so the
   * window itself needs no timezone resolution. The header still goes out because
   * every request in the app carries it.
   */
  async getCalendarPaymentDates(lawFirmId: string, window?: { from: string; to: string }): Promise<PaymentDate[]> {
    const query = window ? `?from=${window.from}&to=${window.to}` : '';
    const response = await apiFetch(
      `${this.getBillingBase(lawFirmId)}/invoices/calendar-payment-dates${query}`,
      {
        method: 'GET',
        headers: await this.getAuthHeaders({ timezone: true }),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch payment dates');
    }

    const body = (await response.json()) as { paymentDates?: PaymentDate[] };
    return body.paymentDates || [];
  }

  // Firm-wide billing settings (client-facing email preferences, etc.)
  async getBillingSettings(lawFirmId: string): Promise<BillingSettings> {
    const response = await apiFetch(`${this.getBillingBase(lawFirmId)}/settings`, {
      method: 'GET',
      headers: await this.getAuthHeaders({ timezone: true }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch billing settings');
    }

    const body = (await response.json()) as { settings: BillingSettings };
    return body.settings;
  }

  async updateBillingSettings(
    lawFirmId: string,
    payload: { clientPaymentEmails: boolean },
  ): Promise<BillingSettings> {
    const response = await apiFetch(`${this.getBillingBase(lawFirmId)}/settings`, {
      method: 'PUT',
      headers: await this.getAuthHeaders({ json: true, timezone: true }),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to update billing settings');
    }

    const body = (await response.json()) as { settings: BillingSettings };
    return body.settings;
  }

  async getBillingSummary(lawFirmId: string): Promise<BillingSummary> {
    const response = await apiFetch(
      `${this.getBillingBase(lawFirmId)}/analytics/billing-summary`,
      {
        method: 'GET',
        // Send the viewer's timezone so "this month" totals use the viewer's
        // calendar month (the route now requires it).
        headers: await this.getAuthHeaders({ timezone: true }),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch billing summary');
    }

    return (await response.json()) as BillingSummary;
  }

  async getBillingWorkbench(
    lawFirmId: string,
    params: { attentionPage?: number; attentionLimit?: number } = {},
  ): Promise<BillingWorkbenchResponse> {
    const query = new URLSearchParams();
    if (params.attentionLimit != null) query.set('attentionLimit', String(params.attentionLimit));
    if (params.attentionPage != null) query.set('attentionPage', String(params.attentionPage));
    const suffix = query.toString() ? `?${query.toString()}` : '';

    const response = await apiFetch(`${this.getBillingBase(lawFirmId)}/workbench${suffix}`, {
      method: 'GET',
      // Send the viewer's timezone so the overdue / due-soon buckets roll over at
      // the viewer's local midnight (the route now requires it).
      headers: await this.getAuthHeaders({ timezone: true }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch billing workbench');
    }

    return (await response.json()) as BillingWorkbenchResponse;
  }

  async getUnbilledWork(
    lawFirmId: string,
    params: { page?: number; limit?: number } = {},
  ): Promise<UnbilledWorkResponse> {
    const query = new URLSearchParams();
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.page != null) query.set('page', String(params.page));
    const suffix = query.toString() ? `?${query.toString()}` : '';

    const response = await apiFetch(`${this.getBillingBase(lawFirmId)}/unbilled-work${suffix}`, {
      method: 'GET',
      headers: await this.getAuthHeaders(),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch unbilled work');
    }

    return (await response.json()) as UnbilledWorkResponse;
  }

  async listPlans(lawFirmId: string, opts: { relatedClientId?: string } = {}): Promise<BillingPlan[]> {
    const url = new URL(`${this.getBillingBase(lawFirmId)}/plans`);
    if (opts.relatedClientId) url.searchParams.set('relatedClientId', opts.relatedClientId);
    const response = await apiFetch(url.toString(), {
      method: 'GET',
      headers: await this.getAuthHeaders(),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch billing plans');
    }

    const body = (await response.json()) as { plans?: BillingPlan[] };
    return body.plans || [];
  }

  async getPlan(lawFirmId: string, planId: string): Promise<BillingPlan> {
    const plans = await this.listPlans(lawFirmId);
    const plan = plans.find((item) => item.id === planId);
    if (!plan) {
      throw new Error('Billing plan not found');
    }
    return plan;
  }

  async createPlan(lawFirmId: string, payload: CreateBillingPlanPayload): Promise<BillingPlan> {
    const response = await apiFetch(`${this.getBillingBase(lawFirmId)}/plans`, {
      method: 'POST',
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to create billing plan');
    }

    const body = (await response.json()) as { plan: BillingPlan };
    return body.plan;
  }

  async updatePlan(lawFirmId: string, planId: string, payload: UpdateBillingPlanPayload): Promise<BillingPlan> {
    const response = await apiFetch(`${this.getBillingBase(lawFirmId)}/plans/${encodeURIComponent(planId)}`, {
      method: 'PUT',
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to update billing plan');
    }

    const body = (await response.json()) as { plan: BillingPlan };
    return body.plan;
  }

  async createDraftFromPlanPeriod(
    lawFirmId: string,
    planId: string,
    periodId: string,
  ): Promise<{ invoice: Invoice; period: BillingPlanPeriod }> {
    const response = await apiFetch(
      `${this.getBillingBase(lawFirmId)}/plans/${encodeURIComponent(planId)}/periods/${encodeURIComponent(periodId)}/create-draft`,
      {
        method: 'POST',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify({}),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to create draft from billing plan period');
    }

    return (await response.json()) as { invoice: Invoice; period: BillingPlanPeriod };
  }

  // Charge codes
  async getChargeCodes(lawFirmId: string, includeInactive = false): Promise<{ chargeCodes: ChargeCode[] }> {
    const response = await apiFetch(
      `${this.getBillingBase(lawFirmId)}/charge-codes?includeInactive=${includeInactive}`,
      {
        method: 'GET',
        headers: await this.getAuthHeaders(),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch charge codes');
    }

    return (await response.json()) as { chargeCodes: ChargeCode[] };
  }

  async getChargeCode(lawFirmId: string, chargeCodeId: string): Promise<ChargeCode> {
    const response = await apiFetch(
      `${this.getBillingBase(lawFirmId)}/charge-codes/${encodeURIComponent(chargeCodeId)}`,
      {
        method: 'GET',
        headers: await this.getAuthHeaders(),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch charge code');
    }

    return (await response.json()) as ChargeCode;
  }

  async createChargeCode(
    lawFirmId: string,
    payload: { code: string; name: string; defaultRate?: number | null; memberRates?: Record<string, number> },
  ): Promise<{ message: string; chargeCodeId: string }> {
    const response = await apiFetch(`${this.getBillingBase(lawFirmId)}/charge-codes`, {
      method: 'POST',
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to create charge code');
    }

    return (await response.json()) as { message: string; chargeCodeId: string };
  }

  async updateChargeCode(
    lawFirmId: string,
    chargeCodeId: string,
    payload: { code?: string; name?: string; isActive?: boolean; defaultRate?: number | null; memberRates?: Record<string, number> },
  ): Promise<{ message: string }> {
    const response = await apiFetch(
      `${this.getBillingBase(lawFirmId)}/charge-codes/${encodeURIComponent(chargeCodeId)}`,
      {
        method: 'PUT',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to update charge code');
    }

    return (await response.json()) as { message: string };
  }

  async deleteChargeCode(lawFirmId: string, chargeCodeId: string): Promise<{ message: string }> {
    const response = await apiFetch(
      `${this.getBillingBase(lawFirmId)}/charge-codes/${encodeURIComponent(chargeCodeId)}`,
      {
        method: 'DELETE',
        headers: await this.getAuthHeaders(),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to delete charge code');
    }

    return (await response.json()) as { message: string };
  }

  // What requesting online payment for an invoice costs by each method: the
  // fee, who pays it, what the client pays and what the firm receives.
  // `choice` previews what the firm has ticked; left out, the firm's billing
  // setting decides. `installmentId` prices a link for one payment-plan row
  // instead of the full remaining balance.
  async getPaymentFeeQuote(
    context: BillingContext,
    invoiceId: string,
    choice?: PaymentFeeChoice,
    installmentId?: string,
  ): Promise<PaymentFeeQuote> {
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    const params = new URLSearchParams();
    if (choice) {
      params.set('card', String(choice.card));
      params.set('bank', String(choice.bank));
    }
    if (installmentId) params.set('installmentId', installmentId);
    const query = params.toString() ? `?${params.toString()}` : '';
    const response = await apiFetch(
      `${API_URL}/stripe/payment/${encodeURIComponent(context.lawFirmId)}/${encodeURIComponent(context.type)}/${encodeURIComponent(context.entityId)}/${encodeURIComponent(invoiceId)}/fee-quote${query}`,
      { method: 'GET', headers: await this.getAuthHeaders() },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to load processing fees');
    }

    return (await response.json()) as PaymentFeeQuote;
  }

  // Correct who an invoice is billed to: the list replaces its billing emails.
  async updateBillingEmails(context: BillingContext, invoiceId: string, emails: string[]): Promise<{ message: string }> {
    const response = await apiFetch(
      `${this.getBillingBase(context.lawFirmId)}/invoices/${this.getContextSegment(context)}/${encodeURIComponent(invoiceId)}/billing-email`,
      {
        method: 'PUT',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify({ emails }),
      },
    );
    if (!response.ok) {
      throw await toApiError(response, 'Failed to update the billing email');
    }
    return response.json();
  }

  // Request online payment: makes the invoice's secure payment link, and emails
  // it to the billing recipients unless `sendEmail` is false (the firm copies
  // it to send another way). `installmentId` makes the link charge one
  // payment-plan row; left out, it charges the full remaining balance. A new
  // request replaces the invoice's previous link.
  async requestStripePayment(
    context: BillingContext,
    invoiceId: string,
    feeChoice?: PaymentFeeChoice,
    { sendEmail = true, installmentId }: { sendEmail?: boolean; installmentId?: string } = {},
  ): Promise<StripePaymentRequestResult> {
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    const response = await apiFetch(
      `${API_URL}/stripe/payment/${encodeURIComponent(context.lawFirmId)}/${encodeURIComponent(context.type)}/${encodeURIComponent(context.entityId)}/${encodeURIComponent(invoiceId)}/request`,
      {
        method: 'POST',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify({
          ...(feeChoice ? { isCardFeePassedOn: feeChoice.card, isBankFeePassedOn: feeChoice.bank } : {}),
          sendEmail,
          ...(installmentId ? { installmentId } : {}),
        }),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to request payment');
    }

    return (await response.json()) as StripePaymentRequestResult;
  }

  // Stripe electronic trust deposit request. Returns a hosted checkout URL the
  // client uses to pay funds directly into the firm's trust account.
  async requestTrustDeposit(
    lawFirmId: string,
    payload: { trustAccountId: string; clientId: string; amountCents: number; matterId?: string; sendEmail?: boolean },
  ): Promise<{ checkoutUrl: string; sessionId: string; emailedTo: string | null }> {
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    const response = await apiFetch(
      `${API_URL}/stripe/trust/${encodeURIComponent(lawFirmId)}/request-deposit`,
      {
        method: 'POST',
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to request trust deposit');
    }

    return (await response.json()) as { checkoutUrl: string; sessionId: string; emailedTo: string | null };
  }

  // ── Firm operating account (Stripe Connect for invoice payments) ──────────
  // The firm's own connected account, where client invoice payments settle.
  // Separate from the per-trust-account onboarding below, which funds an IOLTA.

  // Start (or resume) onboarding. Redirect the browser to the returned `url`.
  async createFirmConnectAccount(lawFirmId: string): Promise<{ url: string; accountId: string }> {
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    const response = await apiFetch(
      `${API_URL}/stripe/connect/${encodeURIComponent(lawFirmId)}/create-account`,
      {
        method: 'POST',
        headers: await this.getAuthHeaders({ json: true, timezone: true }),
        body: JSON.stringify({}),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to connect Stripe');
    }

    return (await response.json()) as { url: string; accountId: string };
  }

  async getFirmConnectStatus(lawFirmId: string): Promise<{
    connected: boolean;
    stripeAccountId: string | null;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    onboardingComplete: boolean;
    /** On its own Standard account: invoice payments are direct charges (0.9% Paralegix fee). */
    directCharges?: boolean;
  }> {
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    const response = await apiFetch(
      `${API_URL}/stripe/connect/${encodeURIComponent(lawFirmId)}/status`,
      {
        method: 'GET',
        headers: await this.getAuthHeaders({ timezone: true }),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to load payment settings');
    }

    return (await response.json()) as {
      connected: boolean;
      stripeAccountId: string | null;
      chargesEnabled: boolean;
      payoutsEnabled: boolean;
      onboardingComplete: boolean;
    };
  }

  // Returns a one-time link into the connected account's Stripe Express dashboard.
  async getFirmConnectDashboardLink(lawFirmId: string): Promise<{ url: string }> {
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    const response = await apiFetch(
      `${API_URL}/stripe/connect/${encodeURIComponent(lawFirmId)}/dashboard-link`,
      {
        method: 'GET',
        headers: await this.getAuthHeaders({ timezone: true }),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to open Stripe dashboard');
    }

    return (await response.json()) as { url: string };
  }

  async disconnectFirmConnect(lawFirmId: string): Promise<{ disconnected: boolean }> {
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    const response = await apiFetch(
      `${API_URL}/stripe/connect/${encodeURIComponent(lawFirmId)}`,
      {
        method: 'DELETE',
        headers: await this.getAuthHeaders({ timezone: true }),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to disconnect Stripe');
    }

    return (await response.json()) as { disconnected: boolean };
  }

  // ── Trust connected accounts (per-account trust/IOLTA Stripe onboarding) ──
  // Each trust account onboards its own Stripe connected account so clients can
  // fund it electronically by ACH, kept separate from the firm's operating account.

  // Start (or resume) onboarding. Redirect the browser to the returned `url`.
  async createTrustConnectAccount(
    lawFirmId: string,
    trustAccountId: string,
  ): Promise<{ url: string; accountId: string }> {
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    const response = await apiFetch(
      `${API_URL}/stripe/trust-connect/${encodeURIComponent(lawFirmId)}/${encodeURIComponent(trustAccountId)}/create-account`,
      {
        method: 'POST',
        headers: await this.getAuthHeaders({ json: true, timezone: true }),
        body: JSON.stringify({}),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to start trust account onboarding');
    }

    return (await response.json()) as { url: string; accountId: string };
  }

  async getTrustConnectStatus(
    lawFirmId: string,
    trustAccountId: string,
  ): Promise<{ connected: boolean; chargesEnabled: boolean; payoutsEnabled: boolean; onboardingComplete: boolean }> {
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    const response = await apiFetch(
      `${API_URL}/stripe/trust-connect/${encodeURIComponent(lawFirmId)}/${encodeURIComponent(trustAccountId)}/status`,
      {
        method: 'GET',
        headers: await this.getAuthHeaders({ timezone: true }),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch trust account connection status');
    }

    return (await response.json()) as {
      connected: boolean;
      chargesEnabled: boolean;
      payoutsEnabled: boolean;
      onboardingComplete: boolean;
    };
  }

  // Returns a one-time link into the connected account's Stripe Express dashboard.
  async getTrustConnectDashboardLink(
    lawFirmId: string,
    trustAccountId: string,
  ): Promise<{ url: string }> {
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    const response = await apiFetch(
      `${API_URL}/stripe/trust-connect/${encodeURIComponent(lawFirmId)}/${encodeURIComponent(trustAccountId)}/dashboard-link`,
      {
        method: 'GET',
        headers: await this.getAuthHeaders({ timezone: true }),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to open Stripe dashboard');
    }

    return (await response.json()) as { url: string };
  }

  async disconnectTrustConnect(
    lawFirmId: string,
    trustAccountId: string,
  ): Promise<{ disconnected: boolean }> {
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    const response = await apiFetch(
      `${API_URL}/stripe/trust-connect/${encodeURIComponent(lawFirmId)}/${encodeURIComponent(trustAccountId)}`,
      {
        method: 'DELETE',
        headers: await this.getAuthHeaders({ timezone: true }),
      },
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to disconnect trust bank account');
    }

    return (await response.json()) as { disconnected: boolean };
  }

  async voidStripePaymentRequest(
    context: BillingContext,
    invoiceId: string,
  ): Promise<{ message: string }> {
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    const response = await apiFetch(
      `${API_URL}/stripe/payment/${encodeURIComponent(context.lawFirmId)}/${encodeURIComponent(context.type)}/${encodeURIComponent(context.entityId)}/${encodeURIComponent(invoiceId)}/void`,
      {
        method: 'POST',
        headers: await this.getAuthHeaders({ json: true }),
      },
    );
    if (!response.ok) {
      throw await toApiError(response, 'Failed to void payment request');
    }
    return (await response.json()) as { message: string };
  }

  async bulkCreateInvoices(lawFirmId: string, payload: {
    contexts: Array<{
      type: 'matter' | 'client';
      entityId: string;
      /** Bill only these lines. Omit to bill everything unbilled on the context. */
      timeEntryIds?: string[];
      flatFeeIds?: string[];
    }>;
    invoiceDate: string;
    dueDate?: string | null;
    invoiceNamePrefix?: string;
  }): Promise<{
    message: string;
    requested: number;
    created: Invoice[];
    skipped: string[];
    failed: string[];
    errors: Record<string, string>;
  }> {
    const response = await apiFetch(`${this.getBillingBase(lawFirmId)}/invoices/bulk`, {
      method: 'POST',
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify(payload),
      timeoutMs: REQUEST_TIMEOUT_MS.upload,
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to bulk create invoices');
    }
    return (await response.json()) as {
      message: string;
      requested: number;
      created: Invoice[];
      skipped: string[];
      failed: string[];
      errors: Record<string, string>;
    };
  }

  async reorderChargeCodes(lawFirmId: string, chargeCodeIds: string[]): Promise<{ message: string }> {
    const response = await apiFetch(`${this.getBillingBase(lawFirmId)}/charge-codes/reorder`, {
      method: 'PUT',
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify({ chargeCodeIds }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to reorder charge codes');
    }

    return (await response.json()) as { message: string };
  }

  // ── UTBMS Codes ────────────────────────────────────────────────────

  async getUtbmsCodes(lawFirmId: string): Promise<{
    taskCodes: Array<{ code: string; label: string }>;
    activityCodes: Array<{ code: string; label: string }>;
    expenseCodes: Array<{ code: string; label: string }>;
  }> {
    const url = `${this.getBillingBase(lawFirmId)}/utbms-codes`;
    const headers = await this.getAuthHeaders();
    // Resolves to the parsed body, and throws an ApiError itself on a refusal.
    return requestDeduplicator.execute(url, { headers });
  }

  // ── Expense Categories ─────────────────────────────────────────────

  async listExpenseCategories(lawFirmId: string, includeInactive = false): Promise<{ expenseCategories: import('@/types').ExpenseCategoryConfig[] }> {
    const qs = includeInactive ? '?includeInactive=true' : '';
    const url = `${this.getBillingBase(lawFirmId)}/expense-categories${qs}`;
    const headers = await this.getAuthHeaders();
    // Resolves to the parsed body, and throws an ApiError itself on a refusal.
    return requestDeduplicator.execute(url, { headers });
  }

  async createExpenseCategory(lawFirmId: string, data: { code: string; name: string }): Promise<{ message: string; expenseCategoryId: string }> {
    const response = await apiFetch(`${this.getBillingBase(lawFirmId)}/expense-categories`, {
      method: 'POST',
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to create expense category');
    }
    return response.json();
  }

  async updateExpenseCategory(lawFirmId: string, id: string, data: { code?: string; name?: string; isActive?: boolean }): Promise<{ message: string }> {
    const response = await apiFetch(`${this.getBillingBase(lawFirmId)}/expense-categories/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to update expense category');
    }
    return response.json();
  }

  async deleteExpenseCategory(lawFirmId: string, id: string): Promise<{ message: string }> {
    const response = await apiFetch(`${this.getBillingBase(lawFirmId)}/expense-categories/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: await this.getAuthHeaders(),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to delete expense category');
    }
    return response.json();
  }

  async reorderExpenseCategories(lawFirmId: string, expenseCategoryIds: string[]): Promise<{ message: string }> {
    const response = await apiFetch(`${this.getBillingBase(lawFirmId)}/expense-categories/reorder`, {
      method: 'PUT',
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify({ expenseCategoryIds }),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to reorder expense categories');
    }
    return response.json();
  }
}

const billingService = new BillingService();

export default billingService;
