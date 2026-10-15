import type { TimeEntry } from './timeEntry';

export type BillingContextType = 'matter' | 'client';
export type SplitBillingMode = 'manual' | 'equal' | 'percentage' | 'fixed_amount';
export type ClientBillingEntryStatus = 'unbilled' | 'owned' | 'other_client' | 'shared_unassigned';
export type ClientBillingInvoiceRelation = 'owned' | 'other_client' | 'shared_unassigned';

export interface ClientBillingRowMetadata {
  billingStatus: ClientBillingEntryStatus;
  billingRecipientName?: string | null;
  billingRecipientClientId?: string | null;
  billingInvoiceId?: string | null;
  billingInvoiceNumber?: string | null;
  billingInvoiceName?: string | null;
}

export interface ClientBillingInvoiceMetadata {
  billingRelation: ClientBillingInvoiceRelation;
  billingRecipientName?: string | null;
  billingRecipientClientId?: string | null;
}

export interface BillingContext {
  type: BillingContextType;
  lawFirmId: string;
  entityId: string;
  // Optional billed client for matter-context invoices.
  clientId?: string | null;
}

export interface InvoiceLineItem {
  id: string;
  name?: string;
  description?: string;
  matterClientId?: string | null;
  matterClientIds?: string[] | null;
  rate?: number;
  hours?: number;
  amount: number;
  allocationPercent?: number;
  allocationAmount?: number;
}

export interface InvoiceFlatFee {
  id: string;
  description: string;
  amount: number;
  allocationPercent?: number;
  allocationAmount?: number;
}

/**
 * One editable invoice line as sent back to the API. `id` is the source row id
 * (time entry / flat fee / expense) - the server identifies the line by it, so it
 * always round-trips unchanged. For time entries the server recomputes `amount`
 * from hours x rate, so the value sent there is advisory.
 */
export interface InvoiceLineItemInput {
  /**
   * Source row id (time entry / flat fee / expense). Optional because
   * invoice_line_items.source_id is nullable - a plan-generated fee, or a line
   * whose source row is gone, has none, and the server accepts it either way.
   */
  id?: string | null;
  name?: string | null;
  description?: string | null;
  date?: string | number | null;
  hours?: number;
  rate?: number;
  amount?: number;
  userId?: string | null;
  userName?: string | null;
  chargeCodeId?: string | null;
  allocationPercent?: number | null;
  allocationAmount?: number | null;
  utbmsTaskCode?: string | null;
  utbmsActivityCode?: string | null;
}

export interface InvoicePayment {
  /** Stable id of the payment; edits and deletes name the payment by it. */
  id?: string;
  amount: number;
  date: string;
  invoiceNumber?: string | null;
  recordedBy?: string;
  description?: string | null;
  paymentMethod?: string | null;
  note?: string | null;
  paymentSource?: 'trust' | 'external' | 'stripe';
  trustTransactionId?: string;
  trustAccountId?: string;
  stripePaymentIntentId?: string;
  stripeSessionId?: string;
  /** The processing fee the client paid on top of `amount`, in cents; 0 when none. */
  surchargeCents?: number;
}

export interface CreditNote {
  id: string;
  amount: number;
  description: string;
  type: 'write_off' | 'discount' | 'adjustment';
  label?: string;
  createdBy: string;
  createdAt: string;
}

export interface ExpectedPayment {
  id?: string;
  dueDate: string;
  amount: number;
  status: 'pending' | 'paid' | 'overdue';
  matchedPaymentIndex?: number | null;
  preDueReminderSentAt?: string | null;
  isDownPayment?: boolean;
}

export interface PaymentPlan {
  enabled: boolean;
  installmentAmount: number;
  frequencyDays: number;
  planStartDate: string;
  expectedPayments: ExpectedPayment[];
  preReminderDays?: number | null;
}

export interface ReminderSettings {
  enabled: boolean;
  frequencyDays: number;
  lastSentAt: string | null;
  sentCount: number;
  maxReminders: number;
}

export interface AuditLogEntry {
  action: string;
  amount?: number;
  description?: string;
  value?: string;
  paymentIndex?: number;
  oldAmount?: number;
  newAmount?: number;
  oldDate?: string;
  newDate?: string;
  deletedAmount?: number;
  deletedDate?: string;
  creditNoteId?: string;
  type?: string;
  overpaymentAmount?: number;
  sentTo?: string;
  performedBy: string;
  timestamp: string;
}

export interface InvoiceRefundDue {
  amount: number;
  /** 'voided': paid after the invoice was voided. 'overpaid': paid more than the total. */
  reason: 'voided' | 'overpaid';
}

export interface Invoice {
  id: string;
  contextType?: BillingContextType | null;
  entityId?: string | null;
  matterId?: string | null;
  clientContextId?: string | null;
  invoiceName: string;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  dueDate?: string | null;
  billingEmail?: string | null;
  /**
   * The frozen bill-to snapshot (migrations 0171 and 0173), written once on
   * this invoice's first external issue. All six are null/empty on a
   * still-draft invoice that has never left the firm; once populated they are
   * historical and roster changes never rewrite them. See `getInvoiceBillTo`
   * in `billingComp/utils`, the one place that resolves snapshot-vs-draft
   * display for a bill-to party.
   */
  billingEmails?: string[] | null;
  /** Attention contact's name on a company snapshot. Always null for a person client. */
  billingContactName?: string | null;
  billingContactTitle?: string | null;
  /** The snapshot's primary billing email, i.e. `billingEmails[0]` at snapshot time. */
  billingContactEmail?: string | null;
  /** Snapshotted billing address (plain text, mirrors `clients.address`). */
  billingClientAddress?: string | null;
  /** Snapshotted client display/legal name. Distinct from billingContactName (the attention contact). */
  billingClientName?: string | null;
  /** When the snapshot was taken. Null means this invoice is still a draft. */
  billingSnapshotAt?: string | null;
  notes?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  clientEmail?: string | null;
  taskId?: string | null;
  matterClientId?: string | null;
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
  timeEntries?: InvoiceLineItem[];
  flatFees?: InvoiceFlatFee[];
  expenses?: Array<{ id: string; description: string; amount: number; category?: string; vendor?: string }>;
  totalHours?: number;
  totalAmount?: number;
  flatFeesAmount?: number;
  expensesAmount?: number;
  taxRate?: number | null;
  taxAmount?: number;
  subtotalAmount?: number;
  amountAdjustmentNotes?: Array<{
    amount: number;
    note?: string | null;
    kind?: string | null;
    addedBy?: string | null;
    addedAt?: string | null;
  }>;
  status?: string;
  remainingBalance?: number;
  isPaid?: boolean;
  paidDate?: string | null;
  amountPaid?: number;
  payments?: InvoicePayment[];
  nextPaymentDate?: string | null;
  creditNotes?: CreditNote[];
  totalWrittenOff?: number;
  /** Money owed back to the payer; null or absent when nothing is. */
  refundDue?: InvoiceRefundDue | null;
  paymentPlan?: PaymentPlan | null;
  reminder?: ReminderSettings | null;
  auditLog?: AuditLogEntry[];
  // Stripe payment fields
  stripePaymentRequested?: boolean;
  stripePaymentStatus?: 'pending' | 'failed' | 'completed' | 'voided' | null;
  stripePaymentRequestedBy?: string | null;
  /** Whether the client pays each processing fee on the open payment request. */
  isCardFeePassedOn?: boolean;
  isBankFeePassedOn?: boolean;
  /** The open payment request's secure link, for the firm to copy. */
  paymentLinkUrl?: string | null;
  /** The payment-plan row (`ExpectedPayment.id`) the open link charges; null for the full balance. */
  payLinkInstallmentId?: string | null;
  stripeInvoiceId?: string | null;
  stripeCheckoutSessionId?: string | null;
  // Reminder tracking
  lastReminderSentAt?: string | null;
  reminderCount?: number;
  reminderOptOut?: boolean;
  preDueReminderDays?: number | null;
  preDueReminderSentAt?: string | null;
  createdAt?: string | null;
  createdBy?: string | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
  splitGroupId?: string | null;
  splitMode?: SplitBillingMode | null;
  splitRecipientCount?: number | null;
  splitShareAmount?: number | null;
  splitSharePercent?: number | null;
  billingPlanId?: string | null;
  billingPlanPeriodId?: string | null;
  billingPlanName?: string | null;
  billingPlanType?: 'retainer' | null;
  isRecurringRetainer?: boolean;
}

export interface FlatFee {
  id: string;
  description: string;
  amount: number;
  date?: string | null;
  createdBy?: string | null;
  contextType?: BillingContextType | null;
  matterId?: string | null;
  clientContextId?: string | null;
  clientId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  isBilled?: boolean;
}

export interface UnbilledTimeEntry {
  id: string;
  userId: string;
  userName: string;
  hours: number;
  amount?: number;
  rate?: number;
  date: string | null;
  name: string;
  description: string;
}

export interface UnbilledFlatFee {
  id: string;
  description: string;
  amount: number;
  date: string | null;
}

export interface ExpenseCategoryConfig {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  order: number;
  isDefault: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface Expense {
  id: string;
  description: string;
  amount: number;
  date?: string | null;
  category?: string;
  expenseCategoryId?: string | null;
  vendor: string;
  billable: boolean;
  receiptUrl?: string;
  createdBy?: string | null;
  contextType?: BillingContextType | null;
  matterId?: string | null;
  clientContextId?: string | null;
  clientId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  isBilled?: boolean;
}

export interface UnbilledExpense {
  id: string;
  description: string;
  amount: number;
  date: string | null;
  category?: string;
  vendor?: string;
}

export interface UnbilledSummary {
  unbilledTimeEntries: UnbilledTimeEntry[];
  unbilledFlatFees: UnbilledFlatFee[];
  unbilledExpenses?: UnbilledExpense[];
  totalUnbilledHours: number;
  totalUnbilledFlatFees: number;
  totalUnbilledExpenses?: number;
  totalUnbilledTimeAmount?: number;
}

export interface PaymentDate {
  id: string;
  invoiceId: string;
  billingItemType?: 'installment' | 'invoice_due_date' | 'payment_received';
  installmentId?: string | null;
  installmentIndex?: number;
  contextType?: BillingContextType;
  matterId?: string | null;
  matterName?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  invoiceName?: string | null;
  invoiceNumber?: string | null;
  totalAmount: number;
  amountPaid: number;
  totalWrittenOff?: number;
  scheduledAmount?: number;
  paidAmount?: number;
  paidDate?: string | null;
  dueDate: string | null;
  nextPaymentDate: string | null;
}

export interface FirmBillingInvoice extends Invoice {
  contextType: BillingContextType;
  entityId: string;
  matterName?: string | null;
  matterClientNames?: string[];
  remainingBalance: number;
  /**
   * How the invoice relates to the client the read was scoped to. Present only
   * when `clientScope` was requested - without a scoped client there is nobody for
   * an invoice to be owned BY, so the field is absent rather than defaulted.
   */
  billingRelation?: 'owned' | 'other_client' | 'shared_unassigned';
  billingRecipientName?: string | null;
  billingRecipientClientId?: string | null;
}

export interface FirmBillingTimeEntry extends TimeEntry {
  contextType: BillingContextType;
  entityId: string;
  matterName?: string | null;
  clientName?: string | null;
  clientNames: string[];
  matterClients?: Array<{ id: string; name: string }>;
  chargeCodeName?: string | null;
  chargeCodeLabel?: string | null;
  hourlyRate?: number | null;
  amount?: number | null;
}

export interface BillingPlanPeriod {
  id: string;
  periodStartDate: string | null;
  periodEndDate: string | null;
  dueDate: string | null;
  status: 'ready_to_bill' | 'draft_created' | 'closed' | 'skipped';
  amount: number;
  includedHours: number;
  consumedHours: number;
  overageHours: number;
  generatedInvoiceId: string | null;
  generatedInvoiceContextType: BillingContextType | null;
  generatedInvoiceEntityId: string | null;
  generatedAt: string | null;
  coveredTimeEntryIds: string[];
  overageTimeEntryIds: string[];
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface BillingPlan {
  id: string;
  contextType: BillingContextType;
  entityId: string;
  planType: 'retainer';
  name: string;
  status: 'active' | 'paused' | 'ended';
  intervalUnit: 'week' | 'month';
  intervalCount: number;
  startDate: string | null;
  nextRunDate: string | null;
  amount: number;
  includedHours: number;
  billingEmail?: string | null;
  defaultDueDays: number;
  defaultClientId?: string | null;
  notes?: string | null;
  endCondition?: 'manual' | 'matter_closed' | 'date';
  endDate?: string | null;
  matterName?: string | null;
  clientName?: string | null;
  periods?: BillingPlanPeriod[];
  /**
   * True when the period read hit its server-side ceiling and the OLDEST periods
   * were dropped. Only present alongside `periods`.
   */
  periodsTruncated?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export type BillingCollectionItem = FirmBillingInvoice;

export interface BillingReadyItem {
  id: string;
  itemType: 'time_entry' | 'flat_fee' | 'plan_period' | 'expense';
  contextType: BillingContextType;
  entityId: string;
  matterId?: string | null;
  matterClientId?: string | null;
  matterClientIds?: string[] | null;
  matterName?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  description: string;
  amount?: number | null;
  hours?: number | null;
  date?: string | null;
  timeEntryId?: string;
  planId?: string;
  periodId?: string;
}

/**
 * One row of the workbench's prioritized to-do list. The server builds and orders
 * the list (overdue invoices, then plan periods due, then everything else ready to
 * bill) and returns one page of it, so the page never has to hold a firm's whole
 * unbilled backlog to render five rows.
 */
export type BillingAttentionRow =
  | { kind: 'overdue'; key: string; item: BillingCollectionItem }
  | { kind: 'plan'; key: string; item: BillingReadyItem }
  | { kind: 'unbilled'; key: string; item: BillingReadyItem };

export interface BillingWorkbenchResponse {
  summary: {
    overdueAmount: number;
    overdueCount: number;
    readyToBillCount: number;
    /** Total value of every ready-to-bill item, summed over the whole set. */
    readyToBillAmount: number;
    activePlanCount: number;
    plansReadyThisWeek: number;
    unbilledHours: number;
    awaitingCount: number;
    awaitingAmount: number;
    totalCollected: number;
    totalInvoices: number;
    /** Matches the time tab's default unbilled, queued, and plan-covered view. */
    uninvoicedTimeEntryCount: number;
  };
  attention: {
    rows: BillingAttentionRow[];
    /** Rows before windowing, so the badge and pager describe the whole backlog. */
    totalItems: number;
  };
  collections: {
    overdueCount: number;
    dueSoonCount: number;
    partiallyPaidCount: number;
  };
  plans: BillingPlan[];
}

export interface UnbilledWorkItem {
  id: string;
  workType: 'task' | 'event';
  taskId?: string | null;
  eventId?: string | null;
  eventType?: string | null;
  title: string;
  details?: string | null;
  matterId?: string | null;
  matterName?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  date?: string | null;
  sourceLabel: string;
}

export interface UnbilledWorkResponse {
  /** Counted over the whole backlog, not the returned page. */
  summary: {
    totalCount: number;
    taskCount: number;
    eventCount: number;
  };
  items: UnbilledWorkItem[];
  /** Matches items.length when the caller asked for no page. */
  totalItems: number;
}
