export type TrustAccountStatus = "active" | "inactive";

export type TrustAccountType = "iolta" | "trust" | "separate_interest";

export type TrustInterestBeneficiary = "bar_foundation" | "client" | "firm";

export const TRUST_ACCOUNT_TYPE_LABELS: Record<TrustAccountType, string> = {
  iolta: "IOLTA (pooled)",
  trust: "Trust / Retainer",
  separate_interest: "Separate Interest-Bearing",
};

export const TRUST_INTEREST_BENEFICIARY_LABELS: Record<TrustInterestBeneficiary, string> = {
  bar_foundation: "Bar Foundation",
  client: "Client",
  firm: "Firm",
};

export type TrustTransactionType = "deposit" | "withdrawal" | "transfer" | "refund";

export type TrustTransactionStatus = "completed" | "void";

export type TrustTransactionSource = "check" | "wire" | "ach" | "cash" | "credit_card" | "interest" | "stripe" | "other";

export type TrustTransferTo = "operating" | "other";

export interface TrustAccount {
  id: string;
  name: string;
  bankName: string;
  accountNumberLast4: string;
  routingNumberLast4?: string;
  accountType: TrustAccountType;
  ioltaTin?: string | null;
  interestBeneficiary?: TrustInterestBeneficiary | null;
  bookCloseDate?: string | null; // YYYY-MM-DD; transactions on/before are locked
  status: TrustAccountStatus;
  // Stripe connected-account state for electronic (ACH) trust deposits. Each
  // trust account onboards its own connected account (its trust/IOLTA bank),
  // separate from the firm's operating Stripe account.
  stripeConnected?: boolean;
  stripeChargesEnabled?: boolean;
  stripeOnboardingComplete?: boolean;
  bookBalance: number; // cents
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TrustTransaction {
  id: string;
  trustAccountId: string;
  trustAccountName?: string | null;
  type: TrustTransactionType;
  amountCents: number;
  clientId: string;
  clientName: string;
  matterId?: string;
  matterName?: string;
  date: string;
  description: string;
  referenceNumber: string;
  payee?: string;
  transferTo?: TrustTransferTo;
  transferToAccountId?: string | null; // destination trust account (double-entry transfer)
  transferGroupId?: string | null; // links the two legs of a trust→trust transfer
  source?: TrustTransactionSource;
  status: TrustTransactionStatus;
  invoiceId?: string; // linked billing invoice (set when type === 'withdrawal' paid an invoice)
  clientBalanceAfter: number; // cents
  accountBalanceAfter: number; // cents
  clearedAt?: string | null; // set once a reconciliation marks this entry cleared
  clearedInReconciliationId?: string | null;
  voidedBy?: string;
  voidedAt?: string;
  voidReason?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClientTrustBalance {
  clientId: string;
  clientName: string;
  trustAccountId: string;
  balanceCents: number;
}

export interface TrustAdjustment {
  description: string;
  amountCents: number;
  category: string;
}

export interface TrustReconciliation {
  id: string;
  trustAccountId: string;
  reconciliationDate: string;
  bankStatementBalanceCents: number;
  bookBalanceCents: number;
  clientLedgerTotalCents: number;
  isReconciled: boolean;
  discrepancyCents: number;
  adjustments: TrustAdjustment[];
  outstandingTransactionIds: string[];
  notes: string;
  reconciledBy: string;
  reconciledByName?: string | null;
  reconciledAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReconciliationSnapshot {
  bookBalanceCents: number;
  clientLedgerTotalCents: number;
  clientBreakdown: Array<{ clientId: string; clientName: string; balanceCents: number }>;
  /** The last STATEMENT date certified, not when the paperwork was done. */
  lastReconciliationDate: string | null;
  lastReconciledAt: string | null;
  accountName: string | null;
  reconcileCadence: TrustReconcileCadence;
  /** lastReconciliationDate plus the cadence, or null when never reconciled. */
  nextReconciliationDueDate: string | null;
  /** True when never reconciled, as well as when the due date has passed. */
  reconciliationOverdue: boolean;
}

export interface CreateTrustAccountPayload {
  name: string;
  bankName: string;
  accountNumberLast4: string;
  routingNumberLast4?: string;
  accountType?: TrustAccountType;
  ioltaTin?: string;
  interestBeneficiary?: TrustInterestBeneficiary;
}

export interface UpdateTrustAccountPayload {
  name?: string;
  bankName?: string;
  accountNumberLast4?: string;
  routingNumberLast4?: string;
  accountType?: TrustAccountType;
  ioltaTin?: string;
  interestBeneficiary?: TrustInterestBeneficiary;
}

export interface TrustMinimumBalance {
  id: string;
  clientId: string;
  clientName?: string | null;
  trustAccountId: string;
  trustAccountName?: string | null;
  minimumCents: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpsertMinimumBalancePayload {
  clientId: string;
  trustAccountId: string;
  minimumCents: number;
}

export interface MatterTrustBalance {
  matterId: string;
  trustAccountId: string;
  trustAccountName?: string;
  balanceCents: number;
}

export type TrustRemittanceStatus = "pending" | "remitted";


export interface TrustInterestRemittance {
  id: string;
  trustAccountId: string;
  trustAccountName?: string | null;
  periodStart?: string | null; // YYYY-MM-DD
  periodEnd?: string | null; // YYYY-MM-DD
  interestEarnedCents: number;
  amountRemittedCents: number;
  remittedTo?: string | null;
  remittanceDate?: string | null; // YYYY-MM-DD
  referenceNumber?: string | null;
  notes?: string | null;
  status: TrustRemittanceStatus;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpsertRemittancePayload {
  trustAccountId: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  interestEarnedCents?: number;
  amountRemittedCents?: number;
  remittedTo?: string | null;
  remittanceDate?: string | null;
  referenceNumber?: string | null;
  notes?: string | null;
  status?: TrustRemittanceStatus;
}

export interface CreateTransactionPayload {
  trustAccountId: string;
  type: TrustTransactionType;
  amountCents: number;
  clientId: string;
  clientName: string;
  matterId?: string;
  matterName?: string;
  date: string;
  description?: string;
  referenceNumber?: string;
  payee?: string;
  transferTo?: TrustTransferTo;
  transferToAccountId?: string; // destination trust account for a double-entry transfer
  source?: TrustTransactionSource;
  invoiceId?: string; // optionally link to a billing invoice
}

export interface VoidTransactionPayload {
  voidReason: string;
}

export interface TransactionFilters {
  trustAccountId?: string;
  clientId?: string;
  type?: TrustTransactionType;
  status?: TrustTransactionStatus;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

export interface CreateReconciliationPayload {
  trustAccountId: string;
  reconciliationDate: string;
  bankStatementBalanceCents: number;
  adjustments?: TrustAdjustment[];
  outstandingTransactionIds?: string[];
  notes?: string;
}

export interface AccountSummary {
  account: TrustAccount;
  clientBalances: ClientTrustBalance[];
  transactionCount: number;
  clientCount: number;
}

export type TrustReconcileCadence = "monthly" | "quarterly";

export interface TrustSettings {
  reconcileCadence: TrustReconcileCadence;
  retentionYears: number;
  flatFeeToOperatingAllowed: boolean;
  // Firm-level opt-in gating electronic (ACH) trust deposits. Even when true,
  // a specific trust account still needs a fully onboarded connected account.
  electronicTrustDepositsAllowed: boolean;
  // Make the matter ledger authoritative for withdrawals rather than a reporting
  // view. Off by default, because a firm that deposits at the client level and
  // spends against matters would have every withdrawal refused.
  enforceMatterTrustBalance: boolean;
  // The balance at which a client's trust account raises a low-balance alert,
  // in integer cents, when that client has no minimum of its own. Null means the
  // built-in $100.
  defaultMinimumCents: number | null;
  // Derived from retentionYears by the backend, never sent back on save. A count
  // of years is not something a reader can act on; the date it resolves to is.
  retentionCutoffDate: string;
}

/**
 * One client's balance inside one account, as the audit report reports it.
 * Narrower than `ClientTrustBalance`: the account is already the row this sits
 * under, so repeating `trustAccountId` on every entry would be noise.
 */
export interface TrustAuditClientBalance {
  clientId: string;
  clientName: string;
  balanceCents: number;
}

/** One trust account's standing in the firm-wide audit report. */
export interface TrustAuditAccount {
  trustAccountId: string;
  name: string;
  accountType: TrustAccountType;
  bankName: string | null;
  accountNumberLast4: string | null;
  status: string;
  /** The stored running total on the account row. */
  bookBalanceCents: number;
  /** The same figure re-derived by summing the ledger. */
  ledgerBalanceCents: number;
  /** The sum of every client's balance inside this account. */
  clientLedgerTotalCents: number;
  /** book minus ledger. Non-zero means the running total has drifted. */
  driftCents: number;
  /** All three figures agree AND no client inside the account is negative. */
  balanced: boolean;
  clientBalances: TrustAuditClientBalance[];
  negativeClientBalances: TrustAuditClientBalance[];
  outstandingCount: number;
  outstandingNetCents: number;
  lastReconciliationDate: string | null;
  lastReconciliationIsReconciled: boolean | null;
  bookCloseDate: string | null;
  nextReconciliationDueDate: string | null;
  reconciliationOverdue: boolean;
}

export interface TrustAuditReport {
  generatedAt: string;
  reconcileCadence: TrustReconcileCadence;
  retentionYears: number;
  retentionCutoffDate: string;
  accounts: TrustAuditAccount[];
  totals: {
    bookBalanceCents: number;
    clientLedgerTotalCents: number;
    balanced: boolean;
  };
}

export interface TrustConnectStatus {
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingComplete: boolean;
}
