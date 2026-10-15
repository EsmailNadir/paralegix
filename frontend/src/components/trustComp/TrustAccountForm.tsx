"use client";

import { useId, useState, useEffect } from "react";
import { X } from "lucide-react";
import Dropdown from "@/components/ui/Dropdown";
import Modal from "@/components/ui/Modal";
import trustService from "@/services/trust.service";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import FieldLabel from "@/components/ui/FieldLabel";
import {
  TRUST_ACCOUNT_TYPE_LABELS,
  TRUST_INTEREST_BENEFICIARY_LABELS,
  type TrustAccount,
  type TrustAccountType,
  type TrustInterestBeneficiary,
} from "@/types/trust";

// When the account type changes, suggest a sensible default beneficiary the user
// can still override: pooled IOLTA interest goes to the bar foundation, while a
// separate interest-bearing account's interest belongs to the client.
const DEFAULT_BENEFICIARY_BY_TYPE: Record<TrustAccountType, TrustInterestBeneficiary | ""> = {
  iolta: "bar_foundation",
  separate_interest: "client",
  trust: "",
};

interface TrustAccountFormProps {
  open: boolean;
  lawFirmId: string;
  account?: TrustAccount | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function TrustAccountForm({ open, lawFirmId, account, onClose, onSaved }: TrustAccountFormProps) {
  const fieldIds = useId();
  const isEditing = !!account;
  const [name, setName] = useState(account?.name || "");
  const [bankName, setBankName] = useState(account?.bankName || "");
  const [accountNumberLast4, setAccountNumberLast4] = useState(account?.accountNumberLast4 || "");
  const [routingNumberLast4, setRoutingNumberLast4] = useState(account?.routingNumberLast4 || "");
  const [accountType, setAccountType] = useState<TrustAccountType>(account?.accountType || "iolta");
  const [ioltaTin, setIoltaTin] = useState(account?.ioltaTin || "");
  const [interestBeneficiary, setInterestBeneficiary] = useState<TrustInterestBeneficiary | "">(
    account?.interestBeneficiary || "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The modal stays mounted across opens (for the exit animation), so fields
  // initialized at mount would otherwise show stale data when a different
  // account is opened for editing. Re-sync from props each time the form opens
  // or the target account changes.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-syncs form fields from the target account each time the form opens
    setName(account?.name || "");
    setBankName(account?.bankName || "");
    setAccountNumberLast4(account?.accountNumberLast4 || "");
    setRoutingNumberLast4(account?.routingNumberLast4 || "");
    setAccountType(account?.accountType || "iolta");
    setIoltaTin(account?.ioltaTin || "");
    setInterestBeneficiary(account?.interestBeneficiary || "");
    setError(null);
  }, [open, account]);

  // Auto-suggest a beneficiary when the type changes (only while creating, so we
  // never silently overwrite a value an editor already set). The user can still
  // pick a different beneficiary afterward.
  const handleAccountTypeChange = (value: TrustAccountType) => {
    setAccountType(value);
    if (value !== "iolta") setIoltaTin("");
    if (!isEditing) setInterestBeneficiary(DEFAULT_BENEFICIARY_BY_TYPE[value]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      if (isEditing) {
        await trustService.updateAccount(lawFirmId, account!.id, {
          name,
          bankName,
          accountNumberLast4,
          routingNumberLast4: routingNumberLast4 || undefined,
          accountType,
          ioltaTin: accountType === "iolta" ? ioltaTin || undefined : undefined,
          interestBeneficiary: (interestBeneficiary || undefined) as TrustInterestBeneficiary | undefined,
        });
      } else {
        await trustService.createAccount(lawFirmId, {
          name,
          bankName,
          accountNumberLast4,
          routingNumberLast4: routingNumberLast4 || undefined,
          accountType,
          ioltaTin: accountType === "iolta" ? ioltaTin || undefined : undefined,
          interestBeneficiary: (interestBeneficiary || undefined) as TrustInterestBeneficiary | undefined,
        });
      }
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to save account"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      dismissible={!saving}
      size="md"
      className="rounded-xl border border-outline"
      showClose={false}
      labelledBy={`${fieldIds}-title`}
      bodyClassName={null}
    >
        <div className="flex items-center justify-between px-5 py-4 border-b border-outline-subtle shrink-0">
          <h3 id={`${fieldIds}-title`} className="text-sm font-semibold text-on-surface">
            {isEditing ? "Edit Trust Account" : "New Trust Account"}
          </h3>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded-lg text-on-surface-muted hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4 overflow-y-auto overflow-x-hidden styled-scrollbar">
          <ErrorNotification error={error} compact />

          <div>
            <FieldLabel htmlFor={`${fieldIds}-name`} size="xs" tone="secondary">Account Name *</FieldLabel>
            <input
              id={`${fieldIds}-name`}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Main IOLTA Account"
              required
              className="w-full px-3 py-2 text-sm bg-input-bg border border-input-border rounded-lg text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          </div>

          <div>
            <FieldLabel htmlFor={`${fieldIds}-bankname`} size="xs" tone="secondary">Bank Name *</FieldLabel>
            <input
              id={`${fieldIds}-bankname`}
              type="text"
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              placeholder="e.g. Chase Bank"
              required
              className="w-full px-3 py-2 text-sm bg-input-bg border border-input-border rounded-lg text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel htmlFor={`${fieldIds}-accountnumberlast4`} size="xs" tone="secondary">Last 4 of Account # *</FieldLabel>
              <input
                id={`${fieldIds}-accountnumberlast4`}
                type="text"
                value={accountNumberLast4}
                onChange={(e) => setAccountNumberLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="1234"
                required
                maxLength={4}
                className="w-full px-3 py-2 text-sm bg-input-bg border border-input-border rounded-lg text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </div>
            <div>
              <FieldLabel htmlFor={`${fieldIds}-routingnumberlast4`} size="xs" tone="secondary">Last 4 of Routing #</FieldLabel>
              <input
                id={`${fieldIds}-routingnumberlast4`}
                type="text"
                value={routingNumberLast4}
                onChange={(e) => setRoutingNumberLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="5678"
                maxLength={4}
                className="w-full px-3 py-2 text-sm bg-input-bg border border-input-border rounded-lg text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </div>
          </div>

          <div>
            <Dropdown
              label="Account Type"
              value={accountType}
              onChange={(value) => handleAccountTypeChange(value as TrustAccountType)}
              options={(Object.keys(TRUST_ACCOUNT_TYPE_LABELS) as TrustAccountType[]).map((key) => ({
                value: key,
                label: TRUST_ACCOUNT_TYPE_LABELS[key],
              }))}
              labelClassName="block text-xs font-medium text-on-surface-secondary mb-1"
              buttonClassName="px-3 py-2 text-sm bg-input-bg border-input-border"
              portal
            />
          </div>

          {accountType === "iolta" && (
            <div>
              <FieldLabel htmlFor={`${fieldIds}-ioltatin`} size="xs" tone="secondary">IOLTA Program TIN</FieldLabel>
              <input
                id={`${fieldIds}-ioltatin`}
                type="text"
                value={ioltaTin}
                onChange={(e) => setIoltaTin(e.target.value)}
                placeholder="e.g. 12-3456789"
                className="w-full px-3 py-2 text-sm bg-input-bg border border-input-border rounded-lg text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            </div>
          )}

          <div>
            <Dropdown
              label="Interest Beneficiary"
              value={interestBeneficiary}
              onChange={(value) => setInterestBeneficiary(value as TrustInterestBeneficiary | "")}
              placeholder="None"
              options={[
                { value: "", label: "None" },
                ...(Object.keys(TRUST_INTEREST_BENEFICIARY_LABELS) as TrustInterestBeneficiary[]).map((key) => ({
                  value: key,
                  label: TRUST_INTEREST_BENEFICIARY_LABELS[key],
                })),
              ]}
              labelClassName="block text-xs font-medium text-on-surface-secondary mb-1"
              buttonClassName="px-3 py-2 text-sm bg-input-bg border-input-border"
              portal
            />
          </div>

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
              disabled={saving || !name || !bankName || accountNumberLast4.length !== 4}
              className="px-4 py-1.5 text-xs font-medium text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              {saving ? "Saving..." : isEditing ? "Save Changes" : "Create Account"}
            </button>
          </div>
        </form>
    </Modal>
  );
}
