"use client";

import { useId, useState, useEffect, useRef } from "react";
import { X, Plus, Trash2, ChevronDown, ChevronUp, Upload } from "lucide-react";
import Dropdown from "@/components/ui/Dropdown";
import DatePicker from "@/components/ui/DatePicker";
import Checkbox from "@/components/ui/Checkbox";
import trustService from "@/services/trust.service";
import { parseCsv } from "@/lib/utils/csv";
import { formatDateOnly, todayLocalDate } from "@/lib/utils/dateUtils";
import { formatCents as fmtCents, moneyInputToCents, parseSignedMoneyInput } from "@/lib/utils/currency";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import Modal from "@/components/ui/Modal";
import type { TrustAccount, TrustAdjustment, ReconciliationSnapshot, TrustTransaction } from "@/types/trust";
import { AutoPager } from "@/components/ui/ListPager";
import usePagedRows from "@/hooks/usePagedRows";
import ErrorNotification from "@/components/ErrorNotification";
import ListSkeleton from "@/components/ui/ListSkeleton";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import FieldLabel from "@/components/ui/FieldLabel";

// Cap on the uncleared-transactions list pulled into the reconciliation wizard.
// Matches the backend's max page size; a firm reconciling on a normal cadence
// never has this many uncleared items at once.
const UNCLEARED_FETCH_LIMIT = 200;

// Parse a money-ish cell ("$1,234.56", "(50.00)", "-12.3") into a signed number,
// or NaN if it holds no numeric value. Parentheses denote a negative.
function parseMoney(raw: string): number {
  if (!raw) return NaN;
  let s = raw.trim();
  if (!s) return NaN;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) { negative = true; s = s.slice(1); }
  if (s === "" || isNaN(Number(s))) return NaN;
  const n = Number(s);
  return negative ? -n : n;
}

interface CsvBankParse {
  amountsCents: number[]; // absolute cents for each parsed bank row
  rowCount: number;
}

// Turn parsed CSV rows into a list of absolute-cents bank amounts. Tolerant of
// headers: prefers an "amount" column, then separate debit/credit columns,
// otherwise falls back to the last column that parses as money per row.
function extractBankAmounts(rows: string[][]): CsvBankParse {
  const amountsCents: number[] = [];
  if (rows.length === 0) return { amountsCents, rowCount: 0 };

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const looksLikeHeader = header.some((h) => /[a-z]/.test(h)) &&
    !rows[0].some((c) => !isNaN(parseMoney(c)) && c.trim() !== "");
  const dataRows = looksLikeHeader ? rows.slice(1) : rows;

  const amountIdx = looksLikeHeader ? header.findIndex((h) => h.includes("amount")) : -1;
  const debitIdx = looksLikeHeader ? header.findIndex((h) => h.includes("debit")) : -1;
  const creditIdx = looksLikeHeader ? header.findIndex((h) => h.includes("credit")) : -1;

  let rowCount = 0;
  for (const cells of dataRows) {
    if (cells.length === 0 || cells.every((c) => c.trim() === "")) continue;
    let value = NaN;
    if (amountIdx >= 0) {
      value = parseMoney(cells[amountIdx] ?? "");
    } else if (debitIdx >= 0 || creditIdx >= 0) {
      // Debit reduces the balance (outflow, negative); credit is positive.
      const debit = debitIdx >= 0 ? parseMoney(cells[debitIdx] ?? "") : NaN;
      const credit = creditIdx >= 0 ? parseMoney(cells[creditIdx] ?? "") : NaN;
      if (!isNaN(debit) && debit !== 0) value = -Math.abs(debit);
      else if (!isNaN(credit) && credit !== 0) value = Math.abs(credit);
    } else {
      // No labeled column: use the last cell that parses as money.
      for (let c = cells.length - 1; c >= 0; c--) {
        const v = parseMoney(cells[c]);
        if (!isNaN(v)) { value = v; break; }
      }
    }
    if (isNaN(value)) continue;
    rowCount++;
    amountsCents.push(Math.abs(Math.round(value * 100)));
  }
  return { amountsCents, rowCount };
}

// An adjustment row as typed. The amount stays text until submit so a malformed
// figure is refused there instead of being coerced on every keystroke.
interface AdjustmentDraft {
  description: string;
  amount: string;
  category: string;
}

// Cents for a typed signed amount, or NaN while it is empty or malformed.
function signedCentsOrNaN(text: string): number {
  const parsed = parseSignedMoneyInput(text);
  return "error" in parsed ? NaN : moneyInputToCents(parsed.amount);
}

interface ReconciliationFormProps {
  open: boolean;
  lawFirmId: string;
  accounts: TrustAccount[];
  onClose: () => void;
  onSaved: () => void;
}

export default function ReconciliationForm({ open, lawFirmId, accounts, onClose, onSaved }: ReconciliationFormProps) {
  const fieldIds = useId();
  const activeAccounts = accounts.filter((a) => a.status === "active");
  const [trustAccountId, setTrustAccountId] = useState(activeAccounts[0]?.id || "");
  const [reconciliationDate, setReconciliationDate] = useState(todayLocalDate());
  const [bankStatementBalance, setBankStatementBalance] = useState("");
  const [notes, setNotes] = useState("");
  const [adjustments, setAdjustments] = useState<AdjustmentDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The form stays mounted between opens, so the figures entered for one bank
  // statement are cleared on close rather than carried into the next one.
  useResetAfterClose(open, () => {
    setTrustAccountId(activeAccounts[0]?.id || "");
    setReconciliationDate(todayLocalDate());
    setBankStatementBalance("");
    setNotes("");
    setAdjustments([]);
    setOutstandingIds(new Set());
    setImportSummary(null);
    setError(null);
  });
  const [snapshot, setSnapshot] = useState<ReconciliationSnapshot | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [showClientBreakdown, setShowClientBreakdown] = useState(false);
  // Uncleared (not-yet-reconciled) completed transactions for the account, and
  // the subset the user flags as still outstanding on the bank statement.
  const [unclearedTxns, setUnclearedTxns] = useState<TrustTransaction[]>([]);
  const [loadingTxns, setLoadingTxns] = useState(false);
  const [hitFetchLimit, setHitFetchLimit] = useState(false);
  const [outstandingIds, setOutstandingIds] = useState<Set<string>>(new Set());
  // Summary of the most recent bank-statement CSV auto-match, shown inline.
  const [importSummary, setImportSummary] = useState<{ matched: number; total: number; outstanding: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    if (!trustAccountId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- toggles loading flag around an async snapshot fetch
    setLoadingSnapshot(true);
    trustService.getReconciliationSnapshot(lawFirmId, trustAccountId)
      .then(setSnapshot)
      .catch(() => setSnapshot(null))
      .finally(() => setLoadingSnapshot(false));
  }, [open, lawFirmId, trustAccountId]);

  // Pull the account's completed-but-uncleared transactions so the user can mark
  // which ones have actually cleared the bank. Switching accounts clears any
  // prior outstanding selection (the transactions no longer apply).
  useEffect(() => {
    if (!open || !trustAccountId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- toggles loading flag around an async fetch
    setLoadingTxns(true);
    setOutstandingIds(new Set());
    setImportSummary(null);
    trustService.listTransactions(lawFirmId, {
      trustAccountId,
      status: "completed",
      limit: UNCLEARED_FETCH_LIMIT,
    })
      .then((txns) => {
        setHitFetchLimit(txns.length >= UNCLEARED_FETCH_LIMIT);
        setUnclearedTxns(txns.filter((t) => !t.clearedAt));
      })
      .catch(() => { setUnclearedTxns([]); setHitFetchLimit(false); })
      .finally(() => setLoadingTxns(false));
  }, [open, lawFirmId, trustAccountId]);

  // Only transactions dated on/before the statement date are reconcilable now;
  // later ones carry forward (the backend clears on the same `txn_date <= date`
  // rule). Outstanding = eligible items the user left unchecked.
  const eligibleTxns = unclearedTxns.filter((t) => !t.date || t.date <= reconciliationDate);

  // The outstanding-item checklist grows with unreconciled volume, so the
  // rendered rows are windowed. `outstandingNet` below still sums every
  // eligible transaction, not just the page.
  const eligiblePager = usePagedRows(eligibleTxns, 25, reconciliationDate);
  const outstandingNet = eligibleTxns.reduce(
    (sum, t) => (outstandingIds.has(t.id) ? sum + (t.type === "deposit" ? t.amountCents : -t.amountCents) : sum),
    0,
  );

  const toggleOutstanding = (id: string) => {
    setOutstandingIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Auto-reconcile against an uploaded bank statement. Each eligible uncleared
  // transaction whose absolute amount is found in the statement is marked
  // cleared (consuming one matching bank row); everything else is outstanding.
  const handleImportFile = async (file: File) => {
    setError(null);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      const { amountsCents } = extractBankAmounts(rows);

      // Multiset of available bank amounts keyed by abs cents -> remaining count.
      const available = new Map<number, number>();
      for (const cents of amountsCents) {
        available.set(cents, (available.get(cents) || 0) + 1);
      }

      const nextOutstanding = new Set<string>();
      let matched = 0;
      for (const t of eligibleTxns) {
        const key = Math.abs(t.amountCents);
        const remaining = available.get(key) || 0;
        if (remaining > 0) {
          available.set(key, remaining - 1);
          matched++;
        } else {
          nextOutstanding.add(t.id);
        }
      }

      setOutstandingIds(nextOutstanding);
      setImportSummary({
        matched,
        total: eligibleTxns.length,
        outstanding: nextOutstanding.size,
      });
    } catch {
      setError("Could not read the CSV file. Check that it is a valid bank statement export.");
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so selecting the same file again re-triggers onChange.
    e.target.value = "";
    if (file) void handleImportFile(file);
  };

  // A malformed balance is NaN, which hides the comparison rather than judging
  // a figure nobody typed. A malformed adjustment counts as zero in the preview
  // and is refused on submit.
  const bankCents = signedCentsOrNaN(bankStatementBalance);
  const adjustmentTotal = adjustments.reduce((sum, a) => sum + (signedCentsOrNaN(a.amount) || 0), 0);
  const bookCents = snapshot?.bookBalanceCents ?? 0;
  const ledgerCents = snapshot?.clientLedgerTotalCents ?? 0;
  // Mirror the backend exactly: expected bank = book - outstanding + adjustments,
  // discrepancy = actual bank - expected, and "in balance" requires both the
  // bank side AND book == sum-of-client-ledgers.
  const expectedBankCents = bookCents - outstandingNet + adjustmentTotal;
  const discrepancyCents = bankCents - expectedBankCents;
  const isReconciled = !isNaN(bankCents) && bankStatementBalance
    ? discrepancyCents === 0 && (bookCents - ledgerCents) === 0
    : null;

  const addAdjustment = () => {
    setAdjustments([...adjustments, { description: "", amount: "", category: "other" }]);
  };

  const removeAdjustment = (index: number) => {
    setAdjustments(adjustments.filter((_, i) => i !== index));
  };

  const updateAdjustment = (index: number, field: keyof AdjustmentDraft, value: string) => {
    setAdjustments(adjustments.map((a, i) => (i === index ? { ...a, [field]: value } : a)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // The balance and adjustments may be negative or zero, but a third decimal,
    // an exponent or stray text is refused rather than rounded or read loosely.
    if (!bankStatementBalance.trim()) {
      setError("Bank statement balance is required");
      return;
    }
    const parsedBalance = parseSignedMoneyInput(bankStatementBalance);
    if ("error" in parsedBalance) {
      setError(`Bank statement balance: ${parsedBalance.error}`);
      return;
    }
    const bankBalanceCents = moneyInputToCents(parsedBalance.amount);

    // An empty amount is a zero adjustment, which is dropped below as before.
    const adjustmentsToSave: TrustAdjustment[] = [];
    for (const [index, adj] of adjustments.entries()) {
      let amountCents = 0;
      if (adj.amount.trim()) {
        const parsed = parseSignedMoneyInput(adj.amount);
        if ("error" in parsed) {
          setError(`Adjustment ${index + 1}: ${parsed.error}`);
          return;
        }
        amountCents = moneyInputToCents(parsed.amount);
      }
      if (adj.description && amountCents !== 0) {
        adjustmentsToSave.push({ description: adj.description, amountCents, category: adj.category });
      }
    }

    if (!reconciliationDate) {
      setError("Please select a reconciliation date");
      return;
    }

    setSaving(true);
    try {
      await trustService.createReconciliation(lawFirmId, {
        trustAccountId,
        reconciliationDate,
        bankStatementBalanceCents: bankBalanceCents,
        adjustments: adjustmentsToSave,
        outstandingTransactionIds: eligibleTxns.filter((t) => outstandingIds.has(t.id)).map((t) => t.id),
        notes: notes || undefined,
      });
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to create reconciliation"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      size="lg"
      dismissible={!saving}
      className="rounded-xl border border-outline"
      showClose={false}
      labelledBy={`${fieldIds}-title`}
      bodyClassName={null}
    >
        <div className="flex items-center justify-between px-5 py-4 border-b border-outline-subtle shrink-0">
          <h3 id={`${fieldIds}-title`} className="text-sm font-semibold text-on-surface">3-Way Reconciliation</h3>
          <button onClick={onClose} disabled={saving} aria-label="Close" className="p-1 rounded-lg text-on-surface-muted hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4 overflow-y-auto overflow-x-hidden">
          <ErrorNotification error={error} compact />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Dropdown
                label="Account *"
                value={trustAccountId}
                onChange={setTrustAccountId}
                options={activeAccounts.map((account) => ({
                  value: account.id,
                  label: account.name,
                }))}
                labelClassName="text-xs font-medium text-on-surface-secondary mb-1"
                buttonClassName="px-3 py-2 text-sm bg-input-bg border-input-border"
                portal
              />
            </div>
            <div>
              <FieldLabel id={`${fieldIds}-reconciliation-date-label`} size="xs" tone="secondary">Reconciliation Date *</FieldLabel>
              <DatePicker
                ariaLabelledBy={`${fieldIds}-reconciliation-date-label`}
                value={reconciliationDate} onChange={setReconciliationDate} className="w-full" />
            </div>
          </div>

          {/* Three-way comparison */}
          {snapshot && !loadingSnapshot && (
            <div className="bg-surface-alt rounded-lg p-3 space-y-2">
              <p className="text-xs font-semibold text-on-surface-secondary mb-2 uppercase tracking-wide">System Figures</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <p className="text-on-surface-muted">Book Balance</p>
                  <p className="font-bold text-on-surface tabular-nums">{fmtCents(bookCents)}</p>
                </div>
                <div>
                  <p className="text-on-surface-muted">Client Ledger Total</p>
                  <p className="font-bold text-on-surface tabular-nums">{fmtCents(ledgerCents)}</p>
                </div>
              </div>
              {bankStatementBalance && !isNaN(bankCents) && (
                <div className="mt-2 pt-2 border-t border-outline-subtle">
                  <div className="grid grid-cols-2 gap-2 text-xs text-center">
                    <div>
                      <p className="text-on-surface-muted">Expected Bank</p>
                      <p className="font-bold tabular-nums">{fmtCents(expectedBankCents)}</p>
                    </div>
                    <div>
                      <p className="text-on-surface-muted">Bank Statement</p>
                      <p className="font-bold tabular-nums">{fmtCents(bankCents)}</p>
                    </div>
                  </div>
                  {outstandingNet !== 0 && (
                    <p className="mt-1 text-[10px] text-center text-on-surface-muted">
                      Expected = Book {fmtCents(bookCents)} − outstanding {fmtCents(outstandingNet)}
                      {adjustmentTotal !== 0 ? ` + adjustments ${fmtCents(adjustmentTotal)}` : ""}
                    </p>
                  )}
                  <div className={`mt-2 text-center text-xs font-semibold px-2 py-1 rounded-full ${
                    isReconciled
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                  }`}>
                    {isReconciled ? "✓ In Balance" : `Discrepancy: ${fmtCents(discrepancyCents)}`}
                  </div>
                  {bookCents !== ledgerCents && (
                    <p className="mt-1 text-[10px] text-center text-amber-600 dark:text-amber-400">
                      Book and client ledger differ by {fmtCents(bookCents - ledgerCents)}
                    </p>
                  )}
                </div>
              )}
              {/* Client breakdown toggle */}
              {snapshot.clientBreakdown.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowClientBreakdown(v => !v)}
                    className="flex items-center gap-1 text-xs text-accent-emphasis hover:underline cursor-pointer mt-1"
                  >
                    {showClientBreakdown ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    {showClientBreakdown ? "Hide" : "Show"} client breakdown ({snapshot.clientBreakdown.length})
                  </button>
                  {showClientBreakdown && (
                    <div className="mt-2 space-y-1 max-h-40 overflow-y-auto overflow-x-hidden">
                      {snapshot.clientBreakdown.map((c) => (
                        <div key={c.clientId} className="flex justify-between text-xs">
                          <span className="text-on-surface-secondary">{c.clientName}</span>
                          <span className="font-medium text-on-surface tabular-nums">{fmtCents(c.balanceCents)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {loadingSnapshot && (
            <div className="bg-surface-alt rounded-lg p-3 text-xs text-on-surface-muted">Loading account figures...</div>
          )}

          <div>
            <FieldLabel htmlFor={`${fieldIds}-bankstatementbalance`} size="xs" tone="secondary">Bank Statement Balance ($) *</FieldLabel>
            <input
              id={`${fieldIds}-bankstatementbalance`}
              type="number"
              step="0.01"
              value={bankStatementBalance}
              onChange={(e) => setBankStatementBalance(e.target.value)}
              placeholder="0.00"
              required
              className="w-full px-3 py-2 text-sm bg-input-bg border border-input-border rounded-lg text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          </div>

          {/* Uncleared transactions: check what cleared the bank, leave outstanding unchecked */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-on-surface-secondary">
                Uncleared Transactions{eligibleTxns.length > 0 ? ` (${eligibleTxns.length})` : ""}
              </label>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={loadingTxns || eligibleTxns.length === 0}
                className="inline-flex items-center gap-1 text-xs text-accent-emphasis hover:underline disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                <Upload size={12} /> Import bank statement (CSV)
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={onFileChange}
                className="hidden"
              />
            </div>
            <p className="text-[11px] text-on-surface-muted mb-2">
              Check off each transaction that has cleared the bank. Leave any still outstanding unchecked, they carry forward.
            </p>
            {importSummary && (
              <div className="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 px-2.5 py-1.5 rounded-lg mb-2">
                Matched {importSummary.matched} of {importSummary.total} transactions, {importSummary.outstanding} marked outstanding.
              </div>
            )}
            {loadingTxns ? (
              <ListSkeleton rows={4} label="Loading transactions" />
            ) : eligibleTxns.length === 0 ? (
              <div className="text-xs text-on-surface-muted px-1 py-2">
                No uncleared transactions on or before this date.
              </div>
            ) : (
              <div className="max-h-48 overflow-y-auto overflow-x-hidden border border-outline-subtle rounded-lg divide-y divide-outline-subtle">
                {eligiblePager.pagedRows.map((t) => {
                  const cleared = !outstandingIds.has(t.id);
                  return (
                    <label
                      key={t.id}
                      className="flex items-center gap-2 px-2.5 py-1.5 text-xs cursor-pointer hover:bg-surface-hover"
                    >
                      <Checkbox checked={cleared} onChange={() => toggleOutstanding(t.id)} />
                      <span className="flex-1 min-w-0 truncate text-on-surface-secondary">
                        {formatDateOnly(t.date)}
                        {" · "}
                        <span className="capitalize">{t.type}</span>
                        {t.clientName ? ` · ${t.clientName}` : ""}
                        {t.referenceNumber ? ` · #${t.referenceNumber}` : ""}
                      </span>
                      <span className={`tabular-nums font-medium ${t.type === "deposit" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                        {t.type === "deposit" ? "+" : "-"}{fmtCents(t.amountCents)}
                      </span>
                      {!cleared && (
                        <span className="text-[9px] font-semibold text-amber-600 dark:text-amber-400 shrink-0">OUTSTANDING</span>
                      )}
                    </label>
                  );
                })}
                {eligiblePager.total > eligiblePager.rowsPerPage && (
                  <AutoPager pager={eligiblePager} />
                )}
              </div>
            )}
            {hitFetchLimit && (
              <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">
                Showing the {UNCLEARED_FETCH_LIMIT} most recent transactions. Older uncleared items may not appear.
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-on-surface-secondary">Adjustments</label>
              <button
                type="button"
                onClick={addAdjustment}
                className="inline-flex items-center gap-1 text-xs text-accent-emphasis hover:underline cursor-pointer"
              >
                <Plus size={12} /> Add
              </button>
            </div>
            {adjustments.map((adj, i) => (
              <div key={i} className="flex items-center gap-2 mb-2">
                <input
                  type="text"
                  value={adj.description}
                  onChange={(e) => updateAdjustment(i, "description", e.target.value)}
                  placeholder="Description"
                  className="flex-1 px-2 py-1.5 text-xs bg-input-bg border border-input-border rounded-lg text-on-surface"
                />
                <input
                  type="number"
                  step="0.01"
                  value={adj.amount}
                  onChange={(e) => updateAdjustment(i, "amount", e.target.value)}
                  placeholder="$0.00"
                  className="w-24 px-2 py-1.5 text-xs bg-input-bg border border-input-border rounded-lg text-on-surface"
                />
                <button
                  type="button"
                  onClick={() => removeAdjustment(i)}
                  className="p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>

          <div>
            <FieldLabel htmlFor={`${fieldIds}-notes`} size="xs" tone="secondary">Notes</FieldLabel>
            <textarea
              id={`${fieldIds}-notes`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Reconciliation notes..."
              rows={2}
              className="w-full px-3 py-2 text-sm bg-input-bg border border-input-border rounded-lg text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring resize-none"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 text-xs font-medium text-on-surface-secondary hover:bg-surface-hover rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !trustAccountId || !bankStatementBalance}
              className="px-4 py-1.5 text-xs font-medium text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              {saving ? "Reconciling..." : "Run Reconciliation"}
            </button>
          </div>
        </form>
    </Modal>
  );
}
