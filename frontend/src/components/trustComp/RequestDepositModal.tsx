"use client";

import { useId, useState, useEffect } from "react";
import { X, Copy, Check, ExternalLink, Landmark, Mail } from "lucide-react";
import Dropdown from "@/components/ui/Dropdown";
import EntityPicker from "@/components/ui/EntityPicker";
import ErrorNotification from "@/components/ErrorNotification";
import Modal from "@/components/ui/Modal";
import SegmentedToggle from "@/components/ui/SegmentedToggle";
import billingService from "@/services/billing.service";
import { useNavigation } from "@/contexts/NavigationContext";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { moneyInputToCents, parseMoneyInput } from "@/lib/utils/currency";
import type { TrustAccount } from "@/types/trust";

interface RequestDepositModalProps {
  open: boolean;
  lawFirmId: string;
  accounts: TrustAccount[];
  onClose: () => void;
}

export default function RequestDepositModal({ open, lawFirmId, accounts, onClose }: RequestDepositModalProps) {
  const fieldIds = useId();
  const { navigate } = useNavigation();
  // Only trust accounts with a fully onboarded connected account (charges
  // enabled) can accept electronic deposits.
  const depositableAccounts = accounts.filter(
    (a) => a.status === "active" && a.stripeChargesEnabled === true,
  );

  const [trustAccountId, setTrustAccountId] = useState(depositableAccounts[0]?.id || "");
  const [clientId, setClientId] = useState("");
  const [matterId, setMatterId] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Same choice an invoice payment request offers: email the link, or copy it.
  const [delivery, setDelivery] = useState<"email" | "copy">("email");
  const [emailedTo, setEmailedTo] = useState<string | null>(null);

  // Reset everything when the modal closes so a reopen starts clean.
  useEffect(() => {
    if (open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets all form fields when the modal closes so a reopen starts clean
    setTrustAccountId(depositableAccounts[0]?.id || "");
    setClientId("");
    setMatterId("");
    setAmount("");
    setError(null);
    setCheckoutUrl(null);
    setCopied(false);
    setDelivery("email");
    setEmailedTo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only reset on close transition
  }, [open]);

  // The matter must go with the client. A matter left over from the previous
  // client would attribute the deposit to the wrong client's matter.
  const handleClientChange = (nextClientId: string) => {
    setClientId(nextClientId);
    setMatterId("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Also enforces the ceiling the API enforces, so the firm gets a sentence
    // instead of a generic failure from a request the server would reject.
    const parsedAmount = parseMoneyInput(amount);
    if ("error" in parsedAmount) {
      setError(parsedAmount.error);
      return;
    }
    const amountCents = moneyInputToCents(parsedAmount.amount);
    if (!trustAccountId) {
      setError("Please select a trust account");
      return;
    }
    if (!clientId) {
      setError("Please select a client");
      return;
    }

    setSubmitting(true);
    try {
      const result = await billingService.requestTrustDeposit(lawFirmId, {
        trustAccountId,
        clientId,
        amountCents,
        matterId: matterId || undefined,
        sendEmail: delivery === "email",
      });
      setCheckoutUrl(result.checkoutUrl);
      setEmailedTo(result.emailedTo);
      if (delivery === "copy") {
        try {
          await navigator.clipboard.writeText(result.checkoutUrl);
          setCopied(true);
        } catch {
          // The link stays on screen to copy by hand when the browser refuses.
        }
      }
    } catch (err) {
      setError(getErrorMessage(err, "Failed to request deposit"));
    } finally {
      setSubmitting(false);
    }
  };

  // Closing while the link is being created would let it land in a dialog that
  // has already reset, and the next open would show this client's link.
  const handleClose = () => {
    if (!submitting) onClose();
  };

  const handleCopy = async () => {
    if (!checkoutUrl) return;
    try {
      await navigator.clipboard.writeText(checkoutUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Failed to copy link");
    }
  };

  const inputClass =
    "w-full px-3 py-2 text-sm bg-input-bg border border-input-border rounded-lg text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";
  const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

  return (
    <Modal
      isOpen={open}
      onClose={handleClose}
      dismissible={!submitting}
      size="lg"
      className="rounded-xl border border-outline"
      showClose={false}
      labelledBy={`${fieldIds}-title`}
      bodyClassName={null}
    >
        <div className="flex items-center justify-between px-5 py-4 border-b border-outline-subtle shrink-0">
          <h3 id={`${fieldIds}-title`} className="text-sm font-semibold text-on-surface">Request Electronic Deposit</h3>
          <button onClick={handleClose} disabled={submitting} aria-label="Close" className="p-1 rounded-lg text-on-surface-muted hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {!checkoutUrl && depositableAccounts.length === 0 ? (
          <div className="px-5 py-6 space-y-4 text-center overflow-y-auto overflow-x-hidden styled-scrollbar">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface-alt">
              <Landmark size={22} className="text-on-surface-muted" />
            </div>
            <p className="text-sm text-on-surface">No trust account is set up for electronic deposits yet.</p>
            <p className="text-xs text-on-surface-muted">
              Connect a trust bank account in Trust settings.
            </p>
            <div className="flex justify-center gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-xs font-medium text-on-surface-secondary hover:bg-surface-hover rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => { onClose(); navigate(`/lawfirm/${lawFirmId}/trust?tab=settings`); }}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
              >
                Go to Trust settings
              </button>
            </div>
          </div>
        ) : checkoutUrl ? (
          <div className="px-5 py-5 space-y-4 overflow-y-auto overflow-x-hidden styled-scrollbar">
            <ErrorNotification error={error} onClose={() => setError(null)} compact />

            <p className="text-sm text-on-surface">
              {emailedTo ? `Deposit link emailed to ${emailedTo}.` : `Deposit link created${copied ? " and copied" : ""}.`}
            </p>
            <p className="text-xs text-on-surface-muted">
              {emailedTo
                ? "You can also copy it to send by text or message."
                : "Paste it into a text or message to the client."} They pay by bank transfer (ACH) and the funds deposit directly into trust. The link works for 24 hours.
            </p>
            <p className="text-xs text-on-surface-muted">
              Bank transfers take a few business days to clear before the funds appear in the trust ledger.
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={checkoutUrl}
                className="flex-1 px-3 py-2 text-xs bg-input-bg border border-input-border rounded-lg text-on-surface focus:outline-none"
              />
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-on-surface bg-surface-alt border border-outline-subtle hover:bg-surface-hover rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer shrink-0"
              >
                {copied ? <Check size={14} className="text-emerald-600 dark:text-emerald-400" /> : <Copy size={14} />}
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-xs font-medium text-on-surface-secondary hover:bg-surface-hover rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
              >
                Close
              </button>
              <a
                href={checkoutUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover rounded-lg transition-colors cursor-pointer"
              >
                <ExternalLink size={14} />
                Open
              </a>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3 overflow-y-auto overflow-x-hidden styled-scrollbar">
            <ErrorNotification error={error} onClose={() => setError(null)} compact />

            {/* Archived clients are no longer transacted with, so they must not
                be offered as the payer on a new trust deposit request. */}
            <div>
              <EntityPicker
                entity="clients"
                lawFirmId={lawFirmId}
                value={clientId}
                onChange={handleClientChange}
                excludeArchived
                label="Client *"
                placeholder="Select client"
                labelClassName={labelClass}
                buttonClassName="px-3 py-2 text-sm bg-input-bg border-input-border"
                portal
              />
            </div>

            {clientId && (
              <div>
                <label className={labelClass}>Matter</label>
                <EntityPicker
                  entity="matters"
                  lawFirmId={lawFirmId}
                  clientId={clientId}
                  value={matterId}
                  onChange={setMatterId}
                  placeholder="No matter selected"
                  buttonClassName="px-3 py-2 text-sm bg-input-bg border-input-border"
                  portal
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Dropdown
                  label="Trust account *"
                  value={trustAccountId}
                  onChange={setTrustAccountId}
                  options={depositableAccounts.map((a) => ({ value: a.id, label: a.name }))}
                  placeholder="Select account"
                  labelClassName={labelClass}
                  buttonClassName="px-3 py-2 text-sm bg-input-bg border-input-border"
                  portal
                />
              </div>
              <div>
                <label htmlFor={`${fieldIds}-amount`} className={labelClass}>Amount ($) *</label>
                <input
                  id={`${fieldIds}-amount`}
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  required
                  className={inputClass}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <span className={labelClass}>How do you want to send it?</span>
              <SegmentedToggle
                ariaLabel="How to send the deposit link"
                options={[
                  { value: "email", label: "Email it", icon: Mail },
                  { value: "copy", label: "Copy link", icon: Copy },
                ]}
                value={delivery}
                onChange={setDelivery}
              />
            </div>
            <p className="text-xs text-on-surface-muted">
              {delivery === "email"
                ? "We'll email the client a secure link to pay by bank transfer (ACH)."
                : "We'll create the link and copy it, so you can text or message it yourself. Nothing is emailed."}{" "}
              Funds deposit directly into trust. Bank transfers take a few business days to clear, and the link works for 24 hours.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={handleClose}
                disabled={submitting}
                className="px-3 py-1.5 text-xs font-medium text-on-surface-secondary hover:bg-surface-hover rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !trustAccountId || !clientId || !amount}
                className="px-4 py-1.5 text-xs font-medium text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
              >
                {submitting ? "Creating link..." : delivery === "email" ? "Email Deposit Link" : "Create & Copy Link"}
              </button>
            </div>
          </form>
        )}
    </Modal>
  );
}
