import { apiFetch } from "@/lib/utils/fetchWithTokenRefresh";
import { toApiError } from "@/lib/utils/apiErrors";
import { authenticatedHeaders } from "./base.service";
import type {
  TrustAccount,
  TrustTransaction,
  ClientTrustBalance,
  TrustReconciliation,
  CreateTrustAccountPayload,
  UpdateTrustAccountPayload,
  CreateTransactionPayload,
  VoidTransactionPayload,
  TransactionFilters,
  CreateReconciliationPayload,
  AccountSummary,
  TrustMinimumBalance,
  UpsertMinimumBalancePayload,
  MatterTrustBalance,
  TrustInterestRemittance,
  UpsertRemittancePayload,
  TrustSettings,
  TrustAuditReport,
} from "@/types/trust";

/**
 * A ledger page request. `order` is the row order the server applies before
 * windowing, so "desc" makes the first page the most recent activity rather than
 * the oldest - it cannot be reproduced by reversing a page on the client.
 */
export interface LedgerPaging {
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

class TrustService {
  private baseApi: string;

  constructor() {
    const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5001/api";
    this.baseApi = API_URL.replace(/\/$/, "");
  }

  private getTrustBase(lawFirmId: string): string {
    return `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/trust`;
  }

  private async getAuthHeaders(options?: { json?: boolean }): Promise<HeadersInit> {
    return authenticatedHeaders(options?.json ? { "Content-Type": "application/json" } : {});
  }

  // ── Trust Accounts ─────────────────────────────────────

  async createAccount(lawFirmId: string, payload: CreateTrustAccountPayload): Promise<TrustAccount> {
    const response = await apiFetch(`${this.getTrustBase(lawFirmId)}/accounts`, {
      method: "POST",
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to create trust account");
    }
    const body = (await response.json()) as { account: TrustAccount };
    return body.account;
  }

  async listAccounts(lawFirmId: string): Promise<TrustAccount[]> {
    const response = await apiFetch(`${this.getTrustBase(lawFirmId)}/accounts`, {
      method: "GET",
      headers: await this.getAuthHeaders(),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch trust accounts");
    }
    const body = (await response.json()) as { accounts: TrustAccount[] };
    return body.accounts || [];
  }

  async getAccount(lawFirmId: string, accountId: string): Promise<TrustAccount> {
    const response = await apiFetch(
      `${this.getTrustBase(lawFirmId)}/accounts/${encodeURIComponent(accountId)}`,
      { method: "GET", headers: await this.getAuthHeaders() },
    );
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch trust account");
    }
    const body = (await response.json()) as { account: TrustAccount };
    return body.account;
  }

  async updateAccount(lawFirmId: string, accountId: string, payload: UpdateTrustAccountPayload): Promise<TrustAccount> {
    const response = await apiFetch(
      `${this.getTrustBase(lawFirmId)}/accounts/${encodeURIComponent(accountId)}`,
      {
        method: "PUT",
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      throw await toApiError(response, "Failed to update trust account");
    }
    const body = (await response.json()) as { account: TrustAccount };
    return body.account;
  }

  async updateAccountStatus(lawFirmId: string, accountId: string, status: "active" | "inactive"): Promise<TrustAccount> {
    const response = await apiFetch(
      `${this.getTrustBase(lawFirmId)}/accounts/${encodeURIComponent(accountId)}/status`,
      {
        method: "PATCH",
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify({ status }),
      },
    );
    if (!response.ok) {
      throw await toApiError(response, "Failed to update account status");
    }
    const body = (await response.json()) as { account: TrustAccount };
    return body.account;
  }

  // Set or clear (null) the account's book-close date (period lock).
  async updateBookCloseDate(lawFirmId: string, accountId: string, bookCloseDate: string | null): Promise<TrustAccount> {
    const response = await apiFetch(
      `${this.getTrustBase(lawFirmId)}/accounts/${encodeURIComponent(accountId)}/book-close`,
      {
        method: "PATCH",
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify({ bookCloseDate }),
      },
    );
    if (!response.ok) {
      throw await toApiError(response, "Failed to update book-close date");
    }
    const body = (await response.json()) as { account: TrustAccount };
    return body.account;
  }

  // ── Minimum Balances (evergreen retainer thresholds) ────

  async listMinimumBalances(lawFirmId: string): Promise<TrustMinimumBalance[]> {
    const response = await apiFetch(`${this.getTrustBase(lawFirmId)}/minimum-balances`, {
      method: "GET",
      headers: await this.getAuthHeaders(),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch minimum balances");
    }
    const body = (await response.json()) as { minimumBalances: TrustMinimumBalance[] };
    return body.minimumBalances || [];
  }

  async upsertMinimumBalance(lawFirmId: string, payload: UpsertMinimumBalancePayload): Promise<TrustMinimumBalance> {
    const response = await apiFetch(`${this.getTrustBase(lawFirmId)}/minimum-balances`, {
      method: "PUT",
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to save minimum balance");
    }
    const body = (await response.json()) as { minimumBalance: TrustMinimumBalance };
    return body.minimumBalance;
  }

  async deleteMinimumBalance(lawFirmId: string, id: string): Promise<void> {
    const response = await apiFetch(
      `${this.getTrustBase(lawFirmId)}/minimum-balances/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: await this.getAuthHeaders() },
    );
    if (!response.ok) {
      throw await toApiError(response, "Failed to remove minimum balance");
    }
  }

  // ── Interest Remittances (IOLTA interest tracking) ──────

  /**
   * Firm-wide IOLTA interest remittances.
   *
   * The server caps an unpaged read and reports `truncated` when it did, so the
   * flag is carried through rather than dropped: this is an interest history a
   * firm reconciles against its bar-foundation statements, and a capped list
   * rendered as a complete one is a reconciliation that silently does not add up.
   */
  async listRemittances(
    lawFirmId: string,
    trustAccountId?: string,
  ): Promise<{
    remittances: TrustInterestRemittance[];
    totalItems: number;
    truncated: boolean;
    ceiling: number | null;
  }> {
    const url = new URL(`${this.getTrustBase(lawFirmId)}/interest-remittances`);
    if (trustAccountId) {
      url.searchParams.append("trustAccountId", trustAccountId);
    }
    const response = await apiFetch(url.toString(), {
      method: "GET",
      headers: await this.getAuthHeaders(),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch interest remittances");
    }
    const body = (await response.json()) as {
      remittances?: TrustInterestRemittance[];
      totalItems?: number;
      truncated?: boolean;
      ceiling?: number;
    };
    const remittances = body.remittances || [];
    return {
      remittances,
      // Fall back to the rendered count rather than 0 so a server that predates
      // the envelope still reports a sane total.
      totalItems: body.totalItems ?? remittances.length,
      truncated: !!body.truncated,
      ceiling: body.ceiling ?? null,
    };
  }

  async createRemittance(lawFirmId: string, payload: UpsertRemittancePayload): Promise<TrustInterestRemittance> {
    const response = await apiFetch(`${this.getTrustBase(lawFirmId)}/interest-remittances`, {
      method: "POST",
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to create interest remittance");
    }
    const body = (await response.json()) as { remittance: TrustInterestRemittance };
    return body.remittance;
  }

  async updateRemittance(lawFirmId: string, id: string, payload: UpsertRemittancePayload): Promise<TrustInterestRemittance> {
    const response = await apiFetch(
      `${this.getTrustBase(lawFirmId)}/interest-remittances/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      throw await toApiError(response, "Failed to update interest remittance");
    }
    const body = (await response.json()) as { remittance: TrustInterestRemittance };
    return body.remittance;
  }

  // ── Per-firm Trust Settings (jurisdiction defaults) ─────

  async getTrustSettings(lawFirmId: string): Promise<TrustSettings> {
    const response = await apiFetch(`${this.getTrustBase(lawFirmId)}/settings`, {
      method: "GET",
      headers: await this.getAuthHeaders(),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch trust settings");
    }
    const body = (await response.json()) as { settings: TrustSettings };
    return body.settings;
  }

  async updateTrustSettings(lawFirmId: string, payload: Partial<TrustSettings>): Promise<TrustSettings> {
    const response = await apiFetch(`${this.getTrustBase(lawFirmId)}/settings`, {
      method: "PUT",
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to update trust settings");
    }
    const body = (await response.json()) as { settings: TrustSettings };
    return body.settings;
  }

  /**
   * The firm-wide audit report: every trust account's three figures, its
   * per-client balances, its negative balances and its reconciliation standing,
   * in one read. What a bar examination asks a firm to produce.
   */
  async getAuditReport(lawFirmId: string): Promise<TrustAuditReport> {
    const response = await apiFetch(`${this.getTrustBase(lawFirmId)}/audit-report`, {
      method: "GET",
      headers: await this.getAuthHeaders(),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch the trust audit report");
    }
    return (await response.json()) as TrustAuditReport;
  }

  async deleteRemittance(lawFirmId: string, id: string): Promise<void> {
    const response = await apiFetch(
      `${this.getTrustBase(lawFirmId)}/interest-remittances/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: await this.getAuthHeaders() },
    );
    if (!response.ok) {
      throw await toApiError(response, "Failed to remove interest remittance");
    }
  }

  // ── Matter Ledger ──────────────────────────────────────

  async getMatterLedger(
    lawFirmId: string,
    matterId: string,
    paging?: LedgerPaging,
  ): Promise<{ transactions: TrustTransaction[]; totalItems: number }> {
    const url = new URL(`${this.getTrustBase(lawFirmId)}/matters/${encodeURIComponent(matterId)}/ledger`);
    if (paging?.limit !== undefined) url.searchParams.set("limit", String(paging.limit));
    if (paging?.offset !== undefined) url.searchParams.set("offset", String(paging.offset));
    if (paging?.order !== undefined) url.searchParams.set("order", paging.order);
    const response = await apiFetch(url.toString(), {
      method: "GET",
      headers: await this.getAuthHeaders(),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch matter ledger");
    }
    const body = (await response.json()) as { transactions: TrustTransaction[]; totalItems?: number };
    return { transactions: body.transactions || [], totalItems: body.totalItems ?? 0 };
  }

  async getMatterBalance(lawFirmId: string, matterId: string): Promise<{
    matterId: string;
    totalBalanceCents: number;
    accountBalances: MatterTrustBalance[];
  }> {
    const response = await apiFetch(
      `${this.getTrustBase(lawFirmId)}/matters/${encodeURIComponent(matterId)}/balance`,
      { method: "GET", headers: await this.getAuthHeaders() },
    );
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch matter balance");
    }
    return await response.json();
  }

  // ── Transactions ───────────────────────────────────────

  async createTransaction(lawFirmId: string, payload: CreateTransactionPayload): Promise<TrustTransaction> {
    const response = await apiFetch(`${this.getTrustBase(lawFirmId)}/transactions`, {
      method: "POST",
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to create transaction");
    }
    const body = (await response.json()) as { transaction: TrustTransaction };
    return body.transaction;
  }

  async listTransactions(lawFirmId: string, filters?: TransactionFilters): Promise<TrustTransaction[]> {
    return (await this.listTransactionsPaged(lawFirmId, filters)).transactions;
  }

  /**
   * Paginated transaction list. The backend returns `{ transactions, totalItems }`
   * where `totalItems` is the count matching the same filters independent of the
   * `limit`/`offset` window, so callers can drive real pagination and totals.
   * `limit` is capped at 200 server-side and defaults to 100 when omitted.
   * `listTransactions` is kept as a thin array-returning wrapper for consumers
   * that supply their own explicit `limit`.
   */
  async listTransactionsPaged(
    lawFirmId: string,
    filters?: TransactionFilters,
  ): Promise<{ transactions: TrustTransaction[]; totalItems: number }> {
    const url = new URL(`${this.getTrustBase(lawFirmId)}/transactions`);
    if (filters) {
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      });
    }
    const response = await apiFetch(url.toString(), {
      method: "GET",
      headers: await this.getAuthHeaders(),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch transactions");
    }
    const body = (await response.json()) as { transactions: TrustTransaction[]; totalItems?: number };
    return { transactions: body.transactions || [], totalItems: body.totalItems ?? 0 };
  }

  async getTransaction(lawFirmId: string, transactionId: string): Promise<TrustTransaction> {
    const response = await apiFetch(
      `${this.getTrustBase(lawFirmId)}/transactions/${encodeURIComponent(transactionId)}`,
      { method: "GET", headers: await this.getAuthHeaders() },
    );
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch transaction");
    }
    const body = (await response.json()) as { transaction: TrustTransaction };
    return body.transaction;
  }

  async voidTransaction(lawFirmId: string, transactionId: string, payload: VoidTransactionPayload): Promise<TrustTransaction> {
    const response = await apiFetch(
      `${this.getTrustBase(lawFirmId)}/transactions/${encodeURIComponent(transactionId)}/void`,
      {
        method: "PATCH",
        headers: await this.getAuthHeaders({ json: true }),
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      throw await toApiError(response, "Failed to void transaction");
    }
    const body = (await response.json()) as { transaction: TrustTransaction };
    return body.transaction;
  }

  // ── Client Ledger ──────────────────────────────────────

  async getClientLedger(
    lawFirmId: string,
    clientId: string,
    paging?: LedgerPaging,
  ): Promise<TrustTransaction[]> {
    return (await this.getClientLedgerPaged(lawFirmId, clientId, paging)).transactions;
  }

  /**
   * Paginated client ledger. The backend returns `{ transactions, totalItems }`
   * where `totalItems` is the full count independent of the limit/offset window,
   * so callers can drive "load more"/totals. `getClientLedger` is kept as a
   * thin array-returning wrapper for existing consumers.
   */
  async getClientLedgerPaged(
    lawFirmId: string,
    clientId: string,
    paging?: LedgerPaging,
  ): Promise<{ transactions: TrustTransaction[]; totalItems: number }> {
    const url = new URL(
      `${this.getTrustBase(lawFirmId)}/clients/${encodeURIComponent(clientId)}/ledger`,
    );
    if (paging?.limit !== undefined) url.searchParams.set("limit", String(paging.limit));
    if (paging?.offset !== undefined) url.searchParams.set("offset", String(paging.offset));
    if (paging?.order !== undefined) url.searchParams.set("order", paging.order);
    const response = await apiFetch(url.toString(), {
      method: "GET",
      headers: await this.getAuthHeaders(),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch client ledger");
    }
    const body = (await response.json()) as { transactions: TrustTransaction[]; totalItems?: number };
    return { transactions: body.transactions || [], totalItems: body.totalItems ?? 0 };
  }

  async getClientBalance(lawFirmId: string, clientId: string): Promise<{
    clientId: string;
    totalBalanceCents: number;
    accountBalances: ClientTrustBalance[];
  }> {
    const response = await apiFetch(
      `${this.getTrustBase(lawFirmId)}/clients/${encodeURIComponent(clientId)}/balance`,
      { method: "GET", headers: await this.getAuthHeaders() },
    );
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch client balance");
    }
    return await response.json();
  }

  // ── Reports ────────────────────────────────────────────

  async getAllBalances(lawFirmId: string): Promise<ClientTrustBalance[]> {
    const response = await apiFetch(`${this.getTrustBase(lawFirmId)}/balances`, {
      method: "GET",
      headers: await this.getAuthHeaders(),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch balances");
    }
    const body = (await response.json()) as { balances: ClientTrustBalance[] };
    return body.balances || [];
  }

  async getAccountSummary(lawFirmId: string, accountId: string): Promise<AccountSummary> {
    const response = await apiFetch(
      `${this.getTrustBase(lawFirmId)}/accounts/${encodeURIComponent(accountId)}/summary`,
      { method: "GET", headers: await this.getAuthHeaders() },
    );
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch account summary");
    }
    return await response.json();
  }

  // ── Reconciliation ────────────────────────────────────

  async createReconciliation(lawFirmId: string, payload: CreateReconciliationPayload): Promise<TrustReconciliation> {
    const response = await apiFetch(`${this.getTrustBase(lawFirmId)}/reconciliations`, {
      method: "POST",
      headers: await this.getAuthHeaders({ json: true }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to create reconciliation");
    }
    const body = (await response.json()) as { reconciliation: TrustReconciliation };
    return body.reconciliation;
  }

  async listReconciliations(
    lawFirmId: string,
    trustAccountId?: string,
    paging?: { limit?: number; offset?: number },
  ): Promise<TrustReconciliation[]> {
    return (await this.listReconciliationsPaged(lawFirmId, trustAccountId, paging)).reconciliations;
  }

  /**
   * Paginated reconciliation history. The backend returns
   * `{ reconciliations, totalItems }` (filter-aware total independent of the
   * limit/offset window). `listReconciliations` stays an array-returning wrapper
   * for existing consumers.
   */
  async listReconciliationsPaged(
    lawFirmId: string,
    trustAccountId?: string,
    paging?: { limit?: number; offset?: number },
  ): Promise<{ reconciliations: TrustReconciliation[]; totalItems: number }> {
    const url = new URL(`${this.getTrustBase(lawFirmId)}/reconciliations`);
    if (trustAccountId) {
      url.searchParams.append("trustAccountId", trustAccountId);
    }
    if (paging?.limit !== undefined) url.searchParams.set("limit", String(paging.limit));
    if (paging?.offset !== undefined) url.searchParams.set("offset", String(paging.offset));
    const response = await apiFetch(url.toString(), {
      method: "GET",
      headers: await this.getAuthHeaders(),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch reconciliations");
    }
    const body = (await response.json()) as { reconciliations: TrustReconciliation[]; totalItems?: number };
    return { reconciliations: body.reconciliations || [], totalItems: body.totalItems ?? 0 };
  }

  async getLatestReconciliation(lawFirmId: string, trustAccountId: string): Promise<TrustReconciliation | null> {
    const url = new URL(`${this.getTrustBase(lawFirmId)}/reconciliations/latest`);
    url.searchParams.append("trustAccountId", trustAccountId);
    const response = await apiFetch(url.toString(), {
      method: "GET",
      headers: await this.getAuthHeaders(),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch latest reconciliation");
    }
    const body = (await response.json()) as { reconciliation: TrustReconciliation | null };
    return body.reconciliation;
  }

  async getReconciliation(lawFirmId: string, reconciliationId: string): Promise<TrustReconciliation> {
    const response = await apiFetch(
      `${this.getTrustBase(lawFirmId)}/reconciliations/${encodeURIComponent(reconciliationId)}`,
      { method: "GET", headers: await this.getAuthHeaders() },
    );
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch reconciliation");
    }
    const body = (await response.json()) as { reconciliation: TrustReconciliation };
    return body.reconciliation;
  }

  async getReconciliationSnapshot(
    lawFirmId: string,
    trustAccountId: string,
  ): Promise<import('@/types/trust').ReconciliationSnapshot> {
    const url = new URL(`${this.getTrustBase(lawFirmId)}/reconciliation-snapshot`);
    url.searchParams.set('trustAccountId', trustAccountId);
    const response = await apiFetch(url.toString(), {
      method: "GET",
      headers: await this.getAuthHeaders(),
    });
    if (!response.ok) {
      throw await toApiError(response, "Failed to fetch reconciliation snapshot");
    }
    return (await response.json()) as import('@/types/trust').ReconciliationSnapshot;
  }
}

const trustService = new TrustService();
export default trustService;
