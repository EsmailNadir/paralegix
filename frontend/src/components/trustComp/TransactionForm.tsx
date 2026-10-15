"use client";

import { useId, useState } from "react";
import { X } from "lucide-react";
import Dropdown from "@/components/ui/Dropdown";
import EntityPicker from "@/components/ui/EntityPicker";
import DatePicker from "@/components/ui/DatePicker";
import ErrorNotification from "@/components/ErrorNotification";
import Modal from "@/components/ui/Modal";
import trustService from "@/services/trust.service";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { todayLocalDate } from "@/lib/utils/dateUtils";
import { moneyInputToCents, parseMoneyInput } from "@/lib/utils/currency";
import type { TrustAccount, TrustTransactionType, TrustTransactionSource, TrustTransferTo } from "@/types/trust";
import FieldLabel from "@/components/ui/FieldLabel";
import { track } from "@/lib/analytics/analytics";

interface TransactionFormProps {
  open: boolean;
  lawFirmId: string;
  accounts: TrustAccount[];
  onClose: () => void;
  onSaved: () => void;
}

export default function TransactionForm({ open, lawFirmId, accounts, onClose, onSaved }: TransactionFormProps) {
  const fieldIds = useId();
  const activeAccounts = accounts.filter((a) => a.status === "active");
  const [trustAccountId, setTrustAccountId] = useState(activeAccounts[0]?.id || "");
  const [type, setType] = useState<TrustTransactionType>("deposit");
  const [amount, setAmount] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientName, setClientName] = useState("");
  const [matterId, setMatterId] = useState("");
  const [matterName, setMatterName] = useState("");
  const [date, setDate] = useState(todayLocalDate());
  const [description, setDescription] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [payee, setPayee] = useState("");
  const [transferTo, setTransferTo] = useState<TrustTransferTo | "">("");
  const [transferToAccountId, setTransferToAccountId] = useState("");
  const [source, setSource] = useState<TrustTransactionSource | "">("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The form stays mounted between opens, so everything is cleared on close. A
  // copy of the last transaction left ready to submit would record it twice.
  useResetAfterClose(open, () => {
    setTrustAccountId(activeAccounts[0]?.id || "");
    setType("deposit");
    setAmount("");
    setClientId("");
    setClientName("");
    setMatterId("");
    setMatterName("");
    setDate(todayLocalDate());
    setDescription("");
    setReferenceNumber("");
    setPayee("");
    setTransferTo("");
    setTransferToAccountId("");
    setSource("");
    setError(null);
  });

  // Switching type clears transfer-specific selections so a stale
  // transferToAccountId can't ride along on a non-transfer (the backend rejects it).
  const handleTypeChange = (value: TrustTransactionType) => {
    setType(value);
    if (value !== "transfer") {
      setTransferTo("");
      setTransferToAccountId("");
    }
  };

  // One destination dropdown covers both: a literal external target
  // ('operating'/'other' → single outflow leg) or another trust account (uuid →
  // double-entry transfer). The selected value is whichever is set.
  const transferDestValue = transferToAccountId || transferTo;
  const handleTransferDestChange = (value: string) => {
    if (value === "operating" || value === "other") {
      setTransferTo(value);
      setTransferToAccountId("");
    } else {
      setTransferToAccountId(value);
      setTransferTo("");
    }
  };

  // Changing or clearing the client must clear the matter too: a matter left
  // over from the previous client would attribute this trust movement to the
  // wrong client's matter.
  const handleClientChange = (nextClientId: string) => {
    setClientId(nextClientId);
    setMatterId("");
    setMatterName("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Refuses a third decimal, an exponent, a non-positive amount and anything
    // over the server maximum, rather than rounding or reading a number out of it.
    const parsedAmount = parseMoneyInput(amount);
    if ("error" in parsedAmount) {
      setError(parsedAmount.error);
      return;
    }
    const amountCents = moneyInputToCents(parsedAmount.amount);

    if (!clientId || !clientName) {
      setError("Please select a client");
      return;
    }

    if (!date) {
      setError("Please select a date");
      return;
    }

    setSaving(true);
    try {
      await trustService.createTransaction(lawFirmId, {
        trustAccountId,
        type,
        amountCents,
        clientId,
        clientName,
        matterId: matterId || undefined,
        matterName: matterName || undefined,
        date,
        description: description || undefined,
        referenceNumber: referenceNumber || undefined,
        payee: payee || undefined,
        transferTo: (transferTo || undefined) as TrustTransferTo | undefined,
        transferToAccountId: transferToAccountId || undefined,
        source: (source || undefined) as TrustTransactionSource | undefined,
      });
      track("trust_transaction_recorded", {
        transaction_type: type,
        source: source || null,
        has_matter: Boolean(matterId),
      });
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to create transaction"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      dismissible={!saving}
      size="lg"
      className="rounded-xl border border-outline"
      showClose={false}
      labelledBy={`${fieldIds}-title`}
      bodyClassName={null}
    >
        <div className="flex items-center justify-between px-5 py-4 border-b border-outline-subtle shrink-0">
          <h3 id={`${fieldIds}-title`} className="text-sm font-semibold text-on-surface">Record Transaction</h3>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded-lg text-on-surface-muted hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3 overflow-y-auto overflow-x-hidden styled-scrollbar">
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
              <Dropdown
                label="Type"
                value={type}
                onChange={(value) => handleTypeChange(value as TrustTransactionType)}
                options={[
                  { value: "deposit", label: "Deposit" },
                  { value: "withdrawal", label: "Withdrawal" },
                  { value: "transfer", label: "Transfer" },
                  { value: "refund", label: "Refund" },
                ]}
                labelClassName="text-xs font-medium text-on-surface-secondary mb-1"
                buttonClassName="px-3 py-2 text-sm bg-input-bg border-input-border"
                portal
              />
            </div>
          </div>

          {/* Client selector. Archived clients are no longer transacted with, so
              they must not be offered as the counterparty on new trust money. */}
          <div>
            <EntityPicker
              entity="clients"
              lawFirmId={lawFirmId}
              value={clientId}
              onChange={handleClientChange}
              onSelectItem={(item) => setClientName(item?.label || "")}
              excludeArchived
              label="Client *"
              placeholder="Select client"
              labelClassName="block text-xs font-medium text-on-surface-secondary mb-1"
              buttonClassName="px-3 py-2 text-sm bg-input-bg border-input-border"
              portal
            />
          </div>

          {/* Matter selector (only when client is selected) */}
          {clientId && (
            <div>
              <FieldLabel size="xs" tone="secondary">Matter (optional)</FieldLabel>
              <EntityPicker
                entity="matters"
                lawFirmId={lawFirmId}
                clientId={clientId}
                value={matterId}
                onChange={setMatterId}
                onSelectItem={(item) => setMatterName(item?.label || "")}
                placeholder="No matter selected"
                buttonClassName="px-3 py-2 text-sm bg-input-bg border-input-border"
                portal
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel htmlFor={`${fieldIds}-amount`} size="xs" tone="secondary">Amount ($) *</FieldLabel>
              <input
                id={`${fieldIds}-amount`}
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                required
                className="w-full px-3 py-2 text-sm bg-input-bg border border-input-border rounded-lg text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </div>
            <div>
              <FieldLabel id={`${fieldIds}-date-label`} size="xs" tone="secondary">Date *</FieldLabel>
              <DatePicker
                ariaLabelledBy={`${fieldIds}-date-label`}
                value={date} onChange={setDate} className="w-full" />
            </div>
          </div>

          <div>
            <FieldLabel htmlFor={`${fieldIds}-description`} size="xs" tone="secondary">Description</FieldLabel>
            <input
              id={`${fieldIds}-description`}
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Memo / description"
              className="w-full px-3 py-2 text-sm bg-input-bg border border-input-border rounded-lg text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel htmlFor={`${fieldIds}-referencenumber`} size="xs" tone="secondary">Reference #</FieldLabel>
              <input
                id={`${fieldIds}-referencenumber`}
                type="text"
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                placeholder="Check #, wire ref"
                className="w-full px-3 py-2 text-sm bg-input-bg border border-input-border rounded-lg text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </div>
            {type === "deposit" && (
              <div>
                <Dropdown
                  label="Source"
                  value={source}
                  onChange={(value) => setSource(value as TrustTransactionSource | "")}
                  placeholder="Select source"
                  options={[
                    { value: "check", label: "Check" },
                    { value: "wire", label: "Wire" },
                    { value: "ach", label: "ACH" },
                    { value: "cash", label: "Cash" },
                    { value: "credit_card", label: "Credit Card" },
                    { value: "interest", label: "Interest" },
                    { value: "other", label: "Other" },
                  ]}
                  labelClassName="text-xs font-medium text-on-surface-secondary mb-1"
                  buttonClassName="px-3 py-2 text-sm bg-input-bg border-input-border"
                  portal
                />
              </div>
            )}
            {(type === "withdrawal" || type === "refund") && (
              <div>
                <FieldLabel htmlFor={`${fieldIds}-payee`} size="xs" tone="secondary">Payee</FieldLabel>
                <input
                  id={`${fieldIds}-payee`}
                  type="text"
                  value={payee}
                  onChange={(e) => setPayee(e.target.value)}
                  placeholder="Payee name"
                  className="w-full px-3 py-2 text-sm bg-input-bg border border-input-border rounded-lg text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
              </div>
            )}
            {type === "transfer" && (
              <div>
                <Dropdown
                  label="Transfer To"
                  value={transferDestValue}
                  onChange={handleTransferDestChange}
                  placeholder="Select destination"
                  options={[
                    { value: "operating", label: "Operating Account" },
                    { value: "other", label: "Other" },
                    ...activeAccounts
                      .filter((a) => a.id !== trustAccountId)
                      .map((a) => ({ value: a.id, label: `Trust: ${a.name}` })),
                  ]}
                  labelClassName="text-xs font-medium text-on-surface-secondary mb-1"
                  buttonClassName="px-3 py-2 text-sm bg-input-bg border-input-border"
                  portal
                />
              </div>
            )}
          </div>

          <ErrorNotification error={error} onClose={() => setError(null)} compact className="mt-2" />

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 text-xs font-medium text-on-surface-secondary hover:bg-surface-hover rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !trustAccountId || !clientId || !clientName || !amount}
              className="px-4 py-1.5 text-xs font-medium text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              {saving ? "Recording..." : "Record Transaction"}
            </button>
          </div>
        </form>
    </Modal>
  );
}
