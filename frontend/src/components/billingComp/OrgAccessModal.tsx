"use client";

import { useId } from "react";
import React, { useState, useEffect, useCallback } from "react";
import { Building2, Mail, Eye, EyeOff, ShieldCheck, Clock, X, User, Pencil, Check, AlertTriangle } from "lucide-react";
import clientsService from "@/services/clients.service";
import { CompanyRosterContact } from "@/types/client";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import Modal from "@/components/ui/Modal";
import Spinner from "@/components/ui/Spinner";
import ListEmptyState from "@/components/ui/ListEmptyState";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Tooltip from "@/components/ui/Tooltip";
import { INPUT_CLS } from "@/components/ui/inputClasses";
import RequirePermission from "@/components/ui/RequirePermission";

export interface OrgAccessModalProps {
  isOpen: boolean;
  onClose: () => void;
  lawFirmId: string;
  clientId: string;
  clientName: string;
}

export default function OrgAccessModal({
  isOpen,
  onClose,
  lawFirmId,
  clientId,
  clientName,
}: OrgAccessModalProps) {
  const fieldIds = useId();
  const titleId = useId();

  const [contacts, setContacts] = useState<CompanyRosterContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Member editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editIsEmailRecipient, setEditIsEmailRecipient] = useState(false);
  const [editCanViewBilling, setEditCanViewBilling] = useState(false);
  const [editIsPrimary, setEditIsPrimary] = useState(false);
  const [editRelationship, setEditRelationship] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Set to the member whose save would leave the organization with no email
  // recipient. Holds the change until the firm confirms, rather than silently
  // leaving its invoices with nowhere to send.
  const [confirmingLastRecipient, setConfirmingLastRecipient] = useState<CompanyRosterContact | null>(null);

  useResetAfterClose(isOpen, () => {
    setContacts([]);
    setError(null);
    setEditingId(null);
    setSaveError(null);
    setConfirmingLastRecipient(null);
  });

  const loadRoster = useCallback(async () => {
    if (!lawFirmId || !clientId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await clientsService.listClientContacts(lawFirmId, clientId);
      const roster = (res || []).filter(
        (c): c is CompanyRosterContact => Boolean((c as CompanyRosterContact).personClientId) || Boolean(c.name)
      );
      setContacts(roster as CompanyRosterContact[]);
    } catch (err: any) {
      console.error("Failed to load organization roster access:", err);
      setError(err?.message || "Failed to load organization members");
    } finally {
      setLoading(false);
    }
  }, [lawFirmId, clientId]);

  // Opening loads through `loadRoster` rather than repeating its body here. The
  // copy this replaced never called setLoading(true), so the first open rendered
  // the "No roster members" empty state until the request landed, telling the
  // firm an organization had nobody on it while it was still being read.
  useEffect(() => {
    if (!isOpen) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetches the roster when the modal opens; the synchronous setState is the loading flag that has to be on before the request starts
    void loadRoster();
  }, [isOpen, loadRoster]);

  const handleStartEdit = (contact: CompanyRosterContact) => {
    setEditingId(contact.id);
    setEditIsEmailRecipient(Boolean(contact.isEmailRecipient));
    setEditCanViewBilling(Boolean(contact.canViewBilling));
    setEditIsPrimary(Boolean(contact.isPrimary));
    setEditRelationship(contact.relationship || "");
    setSaveError(null);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setSaveError(null);
  };

  // True when saving `contact` would turn off the organization's last remaining
  // email recipient. An organization's invoices go to the linked people flagged
  // "Receives emails"; with none left, issuing one fails outright. The same
  // check guards the equivalent save in ClientContactModal, so the warning does
  // not depend on which screen the firm happened to open.
  const removesLastEmailRecipient = (contact: CompanyRosterContact) =>
    Boolean(contact.isEmailRecipient)
    && !editIsEmailRecipient
    && contacts.filter((c) => c.id !== contact.id && c.isEmailRecipient).length === 0;

  const performSaveEdit = async (contact: CompanyRosterContact) => {
    if (!lawFirmId || !clientId || !contact.id) return;
    setSaving(true);
    setSaveError(null);
    try {
      await clientsService.updateClientContact(lawFirmId, clientId, contact.id, {
        isEmailRecipient: editIsEmailRecipient,
        canViewBilling: editCanViewBilling,
        isPrimary: editIsPrimary,
        relationship: editRelationship.trim() || null,
      });
      setEditingId(null);
      await loadRoster();
    } catch (err: any) {
      console.error("Failed to update organization member access:", err);
      setSaveError(err?.message || "Failed to save permissions");
    } finally {
      setSaving(false);
      setConfirmingLastRecipient(null);
    }
  };

  const handleSaveEdit = async (contact: CompanyRosterContact) => {
    if (removesLastEmailRecipient(contact)) {
      setConfirmingLastRecipient(contact);
      return;
    }
    await performSaveEdit(contact);
  };

  return (
    <>
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      labelledBy={titleId}
      size="2xl"
      dismissible={!saving}
      showClose={false}
      bodyClassName={null}
      className="rounded-2xl border border-outline overflow-hidden shadow-2xl"
    >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-outline px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent-emphasis dark:bg-accent-soft dark:text-accent-emphasis">
              <Building2 className="h-5 w-5" />
            </div>
            <div>
              <h3 id={titleId} className="text-base font-semibold tracking-tight text-on-surface">
                Organization Roster & Access
              </h3>
              <p className="text-xs text-on-surface-muted">
                {clientName} • Billing permissions & email delivery settings
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg p-1.5 text-on-surface-muted hover:bg-surface-hover hover:text-on-surface transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Close dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 text-on-surface-muted gap-3">
              <Spinner size={24} className="text-accent-emphasis" />
              <p className="text-xs font-medium">Loading organization roster...</p>
            </div>
          ) : error ? (
            <div className="rounded-xl border border-rose-200 dark:border-rose-800/40 bg-rose-50 dark:bg-rose-500/10 p-4 text-center">
              <p className="text-xs font-medium text-rose-700 dark:text-rose-400">{error}</p>
              <Button type="secondary" size="small" className="mt-3" onClick={loadRoster}>
                Retry
              </Button>
            </div>
          ) : contacts.length === 0 ? (
            <ListEmptyState
              compact
              icon={<User className="h-8 w-8" />}
              title="No roster members"
              message="No individual contacts are currently linked to this organization."
            />
          ) : (
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-on-surface-muted">
                Members ({contacts.length})
              </p>
              <div className="divide-y divide-outline/50 rounded-xl border border-outline bg-surface-alt/30">
                {contacts.map((contact) => {
                  const isEditing = editingId === contact.id;

                  if (isEditing) {
                    return (
                      <div key={contact.id || contact.personClientId} className="p-4 space-y-4 bg-surface rounded-xl border border-accent-emphasis/30 shadow-sm">
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="text-sm font-semibold text-on-surface">{contact.name}</span>
                            {contact.email && <p className="text-xs text-on-surface-muted">{contact.email}</p>}
                          </div>
                          <span className="text-xs font-medium text-accent-emphasis bg-accent-soft px-2 py-0.5 rounded-full">
                            Editing Permissions
                          </span>
                        </div>

                        {saveError && (
                          <div className="rounded-lg bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-800/40 p-2.5 text-xs text-rose-700 dark:text-rose-400">
                            {saveError}
                          </div>
                        )}

                        <div className="space-y-3 pt-1">
                          {/* Role / Relationship */}
                          <div>
                            <label htmlFor={`${fieldIds}-editrelationship`} className="block text-xs font-medium text-on-surface-muted mb-1">
                              Role / Relationship
                            </label>
                            <input
                              id={`${fieldIds}-editrelationship`}
                              type="text"
                              className={INPUT_CLS}
                              placeholder="e.g. CEO, Accounting"
                              value={editRelationship}
                              onChange={(e) => setEditRelationship(e.target.value)}
                            />
                          </div>

                          {/* Checkboxes */}
                          <div className="space-y-2.5 pt-1">
                            <label className="flex items-start gap-2.5 cursor-pointer">
                              <Checkbox checked={editIsEmailRecipient} onChange={setEditIsEmailRecipient} className="mt-0.5" />
                              <div>
                                <span className="text-xs font-medium text-on-surface">Receives Billing Emails</span>
                                <p className="text-[11px] text-on-surface-muted">
                                  Invoices, reminders, and payment receipts will be emailed to this person.
                                </p>
                              </div>
                            </label>

                            <label className="flex items-start gap-2.5 cursor-pointer">
                              <Checkbox checked={editCanViewBilling} onChange={setEditCanViewBilling} className="mt-0.5" />
                              <div>
                                <span className="text-xs font-medium text-on-surface">Can View Billing in Client Portal</span>
                                <p className="text-[11px] text-on-surface-muted">
                                  Allows viewing organization invoices and payment history in the portal.
                                </p>
                              </div>
                            </label>

                            <label className="flex items-start gap-2.5 cursor-pointer">
                              <Checkbox checked={editIsPrimary} onChange={setEditIsPrimary} className="mt-0.5" />
                              <div>
                                <span className="text-xs font-medium text-on-surface">Primary Contact</span>
                                <p className="text-[11px] text-on-surface-muted">
                                  Sets this member as the primary contact for this organization.
                                </p>
                              </div>
                            </label>
                          </div>
                        </div>

                        {/* Save / Cancel buttons */}
                        <div className="flex items-center justify-end gap-2 pt-2 border-t border-outline/50">
                          <Button type="secondary" size="small" disabled={saving} onClick={handleCancelEdit}>
                            Cancel
                          </Button>
                          <Button type="primary" size="small" loading={saving} onClick={() => handleSaveEdit(contact)}>
                            <Check className="w-3.5 h-3.5 mr-1 inline" /> Save Changes
                          </Button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={contact.id || contact.personClientId} className="p-4 space-y-2.5">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-on-surface">{contact.name}</span>
                            {contact.isPrimary && (
                              <span className="inline-flex items-center rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent-emphasis">
                                Primary Contact
                              </span>
                            )}
                            {contact.relationship && (
                              <span className="inline-flex items-center rounded-full bg-surface-alt px-2 py-0.5 text-[10px] font-medium text-on-surface-muted border border-outline">
                                {contact.relationship}
                              </span>
                            )}
                          </div>
                          {contact.email && (
                            <p className="text-xs text-on-surface-muted mt-0.5">{contact.email}</p>
                          )}
                        </div>

                        <RequirePermission permission="clients.manage">
                          <Button type="secondary" size="small" onClick={() => handleStartEdit(contact)}>
                            <Pencil className="w-3 h-3 mr-1 inline" /> Edit
                          </Button>
                        </RequirePermission>
                      </div>

                      {/* Permissions & Delivery status tags */}
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        {/* Email Delivery */}
                        {contact.isEmailRecipient ? (
                          contact.email ? (
                            <Tooltip title="Invoices, reminders, and payment receipts will be emailed to this person" enterDelay={300}>
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                                <Mail className="w-3.5 h-3.5" /> Receives Billing Emails
                              </span>
                            </Tooltip>
                          ) : (
                            <Tooltip title="No email address added: emails cannot be delivered until an email address is added" enterDelay={300}>
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400 border border-amber-200 dark:border-amber-800">
                                <AlertTriangle className="w-3.5 h-3.5 text-amber-500" /> Receives Billing Emails (No Email)
                              </span>
                            </Tooltip>
                          )
                        ) : (
                          <Tooltip title="This member is not set to receive billing emails" enterDelay={300}>
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-surface-alt text-on-surface-muted border border-outline">
                              <Mail className="w-3.5 h-3.5" /> No Email Delivery
                            </span>
                          </Tooltip>
                        )}

                        {/* Billing View Access */}
                        {contact.canViewBilling ? (
                          <Tooltip title="Allows viewing organization invoices and payment history in the client portal" enterDelay={300}>
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400 border border-blue-200 dark:border-blue-800">
                              <Eye className="w-3.5 h-3.5" /> Can View Billing
                            </span>
                          </Tooltip>
                        ) : (
                          <Tooltip title="This member cannot view billing in the client portal" enterDelay={300}>
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-surface-alt text-on-surface-muted border border-outline">
                              <EyeOff className="w-3.5 h-3.5" /> No Billing Access
                            </span>
                          </Tooltip>
                        )}

                        {/* Portal Account */}
                        {contact.userId ? (
                          <Tooltip title="This member has an active client portal account" enterDelay={300}>
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-accent-soft text-accent-emphasis border border-accent-emphasis/20">
                              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" /> Portal Active
                            </span>
                          </Tooltip>
                        ) : contact.portalInvitePending ? (
                          <Tooltip title="An invitation to join the client portal has been sent and is pending acceptance" enterDelay={300}>
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400 border border-amber-200 dark:border-amber-800">
                              <Clock className="w-3.5 h-3.5" /> Invite Pending
                            </span>
                          </Tooltip>
                        ) : (
                          <Tooltip title="This member does not have a client portal account yet" enterDelay={300}>
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-surface-alt text-on-surface-muted border border-outline">
                              No Portal Account
                            </span>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-outline px-6 py-4 bg-surface-alt/20">
          <Button type="secondary" size="small" onClick={onClose} disabled={saving}>
            Close
          </Button>
        </div>
    </Modal>

    {/* Outside Modal's backdrop above, which closes this modal on any click that
        reaches it. Nested inside, every click on the confirm dialog would
        bubble up and dismiss the roster behind it, cancel included. */}
    <ConfirmModal
      isOpen={!!confirmingLastRecipient}
      onClose={() => setConfirmingLastRecipient(null)}
      onConfirm={() => {
        if (confirmingLastRecipient) void performSaveEdit(confirmingLastRecipient);
      }}
      title="Remove last email recipient?"
      message={`${confirmingLastRecipient?.name || "This member"} is ${clientName}'s only email recipient. After this change, invoices and client notifications will have nowhere to send until you add a new recipient.`}
      confirmText={saving ? "Saving..." : "Save Anyway"}
      confirmType="danger"
      loading={saving}
      stacked
    />
    </>
  );
}
