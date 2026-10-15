"use client";

import { useId, useState } from "react";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import ErrorNotification from "@/components/ErrorNotification";
import FieldLabel from "@/components/ui/FieldLabel";
import Modal from "@/components/ui/Modal";
import TagChip from "@/components/ui/TagChip";
import useSeedOnOpen from "@/hooks/useSeedOnOpen";
import billingService from "@/services/billing.service";
import clientsService from "@/services/clients.service";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import type { BillingContext } from "@/types/billing";
import type { Invoice } from "@/types";
import { hasOpenPaymentLink } from "./invoiceDetailHelpers";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Addresses typed or pasted at once, separated by commas, semicolons or spaces. */
function parseEmails(text: string): string[] {
  return text.split(/[\s,;]+/).map((part) => part.trim()).filter(Boolean);
}

/** Appends the new addresses, skipping any already listed (case-insensitive). */
function mergeEmails(list: string[], added: string[]): string[] {
  const next = [...list];
  for (const email of added) {
    if (!next.some((existing) => existing.toLowerCase() === email.toLowerCase())) next.push(email);
  }
  return next;
}

/**
 * Correct who an invoice is billed to, for a firm that learns the address was
 * wrong. The new list replaces the invoice's billing emails; for a person
 * client it can also fix the client's record so later invoices use it. If a
 * payment link already went to the old address, the firm is asked whether to
 * resend it, with the invoice's existing processing-fee choice and for the same
 * installment the open link charges.
 */
export default function EditBillingEmailModal({
  open,
  onClose,
  onSaved,
  invoice,
  billingContext,
  clientId,
  clientName,
  canUpdateClient,
  currentEmails,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  invoice: Invoice;
  billingContext: BillingContext;
  clientId: string | null;
  clientName: string;
  /** A person client, and the firm member may edit clients. */
  canUpdateClient: boolean;
  currentEmails: string[];
}) {
  const fieldId = useId();
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [updateClient, setUpdateClient] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState<"edit" | "resend">("edit");
  const [savedEmails, setSavedEmails] = useState<string[]>([]);

  useSeedOnOpen(open, () => {
    setEmails(currentEmails);
    setDraft("");
    setUpdateClient(true);
    setError(null);
    setStep("edit");
  });

  const linkPending = hasOpenPaymentLink(invoice);

  /**
   * Turns the typed text into chips. An invalid address stays in the field
   * with an error so it can be fixed rather than silently dropped.
   */
  const commitDraft = (): string[] | null => {
    const added = parseEmails(draft);
    const invalid = added.find((email) => !EMAIL_RE.test(email));
    if (invalid) {
      setError(`"${invalid}" is not a valid email address.`);
      return null;
    }
    const next = mergeEmails(emails, added);
    setEmails(next);
    setDraft("");
    return next;
  };

  const removeEmail = (email: string) => {
    setEmails((prev) => prev.filter((existing) => existing !== email));
  };

  const handleSave = async () => {
    const finalEmails = commitDraft();
    if (!finalEmails) return;
    if (finalEmails.length === 0) {
      setError("Enter at least one billing email.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (canUpdateClient && updateClient && clientId) {
        await clientsService.updateClient(billingContext.lawFirmId, clientId, { email: finalEmails[0] });
      }
      await billingService.updateBillingEmails(billingContext, invoice.id, finalEmails);
      onSaved();
      if (linkPending) {
        setSavedEmails(finalEmails);
        setStep("resend");
      } else {
        onClose();
      }
    } catch (err) {
      setError(getErrorMessage(err, "Failed to update the billing email"));
    } finally {
      setSaving(false);
    }
  };

  const handleResend = async () => {
    setSaving(true);
    setError(null);
    try {
      await billingService.requestStripePayment(billingContext, invoice.id, {
        card: invoice.isCardFeePassedOn === true,
        bank: invoice.isBankFeePassedOn === true,
      }, { installmentId: invoice.payLinkInstallmentId ?? undefined });
      onSaved();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to resend the payment link"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      dismissible={!saving}
      title={step === "edit" ? "Edit billing email" : "Resend payment link?"}
      size="md"
      footer={step === "edit" ? (
        <>
          <Button type="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="primary" onClick={handleSave} loading={saving} disabled={saving}>Save</Button>
        </>
      ) : (
        <>
          <Button type="secondary" onClick={onClose} disabled={saving}>Not now</Button>
          <Button type="primary" onClick={handleResend} loading={saving} disabled={saving}>Resend payment link</Button>
        </>
      )}
    >
      <ErrorNotification error={error} onClose={() => setError(null)} compact />
      {step === "edit" ? (
        <div className="space-y-4">
          <div>
            <FieldLabel htmlFor={`${fieldId}-emails`}>Billing email</FieldLabel>
            <div className="fused-field-group flex flex-wrap items-center gap-2 rounded-md border border-input-border bg-input-bg px-3 py-2 focus-within:ring-2 focus-within:ring-focus-ring">
              {emails.map((email) => (
                <TagChip
                  key={email}
                  label={email}
                  onRemove={saving ? undefined : () => removeEmail(email)}
                  removeLabel={`Remove ${email}`}
                />
              ))}
              <input
                id={`${fieldId}-emails`}
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    commitDraft();
                  } else if (e.key === "Backspace" && !draft && emails.length > 0) {
                    removeEmail(emails[emails.length - 1]);
                  }
                }}
                onBlur={() => { if (draft.trim()) commitDraft(); }}
                placeholder={emails.length ? "Add another email" : "billing@client.com"}
                disabled={saving}
                className="min-w-40 flex-1 bg-transparent py-0.5 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none"
              />
            </div>
            <p className="mt-1 text-xs text-on-surface-muted">
              Reminders, payment links and receipts for this invoice go here. Press Enter to add each address.
            </p>
          </div>
          {canUpdateClient && (
            <Checkbox
              checked={updateClient}
              onChange={setUpdateClient}
              disabled={saving}
              label={`Also update ${clientName}'s email`}
              description="Later invoices for this client will use it too."
            />
          )}
        </div>
      ) : (
        <p className="text-sm text-on-surface-secondary">
          The payment link for this invoice was already sent to the old address. Send a new one to {savedEmails.join(", ")}? The old link stops working.
        </p>
      )}
    </Modal>
  );
}
