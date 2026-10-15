"use client";

import ContactIdentityField from "@/components/contactsComp/ContactIdentityField";
import ContactDuplicateWarning from "@/components/contactsComp/ContactDuplicateWarning";

import { FIELD_LABEL_BLOCK_CLS, FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { useEffect, useId, useState } from "react";
import { ExternalLink, Info, X } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import clientsService, { type CreateCompanyRosterContactPayload, type CreatePersonRelatedContactPayload, type UpdateCompanyRosterLinkPayload, type UpdatePersonRelatedContactPayload } from "@/services/clients.service";
import { isPersonRelatedContact, type ClientContact, type ClientType } from "@/types";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import ConfirmModal from "@/components/ui/ConfirmModal";
import EntityPicker from "@/components/ui/EntityPicker";
import ErrorNotification from "@/components/ErrorNotification";

import Modal from "@/components/ui/Modal";
import { useContactDuplicateCheck } from "@/hooks/contactHooks/useContactDuplicateCheck";
import { useNavigation } from "@/contexts/NavigationContext";
import { getErrorMessage } from "@/lib/utils/apiErrors";

const INPUT_CLASS = FULL_INPUT_CLS;
const LABEL_CLASS = FIELD_LABEL_BLOCK_CLS;

interface ClientContactModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  lawFirmId: string;
  clientId: string;
  /** The link being edited, or null/undefined to add a new one. */
  editing?: ClientContact | null;
  /** Which form this renders: a PERSON client's related contacts, or a COMPANY client's roster. */
  clientType?: ClientType;
  /**
   * How many OTHER roster links (excluding the one being edited) currently
   * carry email delivery, used to warn before a save would leave the company
   * with no recipient for invoices or client notifications.
   */
  otherEmailRecipientCount?: number;
}

/**
 * Adds a person to a client's Contacts tab.
 *
 * For a PERSON client this picks or creates a firm-directory contact
 * (guardian, assistant, etc.) and links it - unchanged by the
 * organization-clients migration. Editing changes the shared contact record
 * itself (name/email/phone/title/notes), so those changes also apply on
 * every matter the person appears on.
 *
 * For a COMPANY client this picks or creates a standalone Person client and
 * links them to the roster. Their name/email/phone belong to that person's
 * own client record and are edited from their own client page instead - this
 * form only ever touches the relationship (relationship label, primary, and
 * billing flags), and only offers identity fields when creating someone new.
 */
export default function ClientContactModal({
  open, onClose, onSaved, lawFirmId, clientId, editing, clientType, otherEmailRecipientCount = 0,
}: ClientContactModalProps) {
  const fieldIds = useId();
  const { navigate } = useNavigation();
  const isCompany = clientType === "company";
  const [pickedContactId, setPickedContactId] = useState("");
  const [pickedPersonClientId, setPickedPersonClientId] = useState("");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [relationship, setRelationship] = useState("");
  const [notes, setNotes] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [isEmailRecipient, setIsEmailRecipient] = useState(false);
  const [canViewBilling, setCanViewBilling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when saving would remove the company's last billing recipient. Holds
  // the form until the firm explicitly confirms, rather than silently leaving
  // invoices with nowhere to send.
  const [confirmingLastRecipient, setConfirmingLastRecipient] = useState(false);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs form fields to the link being edited when the modal opens
    setPickedContactId("");
    setPickedPersonClientId("");
    setName(editing?.name || "");
    setEmail(editing?.email || "");
    setPhone(editing?.phone || "");
    // title/notes only exist on a PERSON client's related-contact shape.
    const editingPerson = editing && isPersonRelatedContact(editing) ? editing : null;
    setTitle(editingPerson?.title || "");
    setNotes(editingPerson?.notes || "");
    setRelationship(editing?.relationship || "");
    setIsPrimary(Boolean(editing?.isPrimary));
    // A company's invoices go to its related clients flagged "Receives emails",
    // and to nobody otherwise: an organization with none cannot be invoiced at
    // all. Adding the FIRST such person to a company therefore starts the box
    // ticked, so the ordinary path leaves the company billable. Once someone
    // else already receives its email, the default goes back to off - a later
    // arrival should not join the billing list unless the firm says so. Editing
    // always reflects the stored value.
    setIsEmailRecipient(
      editing ? Boolean(editing.isEmailRecipient) : (isCompany && otherEmailRecipientCount === 0)
    );
    setCanViewBilling(Boolean(editing?.canViewBilling));
    setError(null);
    setConfirmingLastRecipient(false);
  }, [open, editing, isCompany, otherEmailRecipientCount]);

  // Picking an existing directory contact/client means the identity fields
  // belong to that shared record, so they're hidden until edit mode - a
  // company link's identity fields are never editable here at all (see below).
  const showPersonIdentityFields = !isCompany && (editing || !pickedContactId);
  const showCompanyIdentityFields = isCompany && !editing && !pickedPersonClientId;

  // Advisory only, and only while creating a brand-new directory contact:
  // picking an existing one or editing the link shouldn't warn about itself.
  // Company path has no equivalent check - it picks/creates real clients.
  const { duplicates } = useContactDuplicateCheck(lawFirmId, name, email, {
    enabled: open && !isCompany && !editing && !pickedContactId,
  });

  const performSubmit = async () => {
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        if (isCompany) {
          const payload: UpdateCompanyRosterLinkPayload = {
            relationship: relationship.trim() || null,
            isPrimary,
            isEmailRecipient,
            canViewBilling,
          };
          await clientsService.updateClientContact(lawFirmId, clientId, editing.id, payload);
        } else {
          // Only the identity fields that changed are sent. They belong to the
          // shared directory contact, and the server asks for contacts.manage
          // whenever one is in the body, so resending them unchanged would block
          // a role that may only edit the link (relationship, primary).
          const original = isPersonRelatedContact(editing) ? editing : null;
          const changed = (value: string, before: string | null | undefined) =>
            value.trim() !== (before || "").trim();
          const payload: UpdatePersonRelatedContactPayload = {
            ...(changed(name, editing.name) && name.trim() ? { name: name.trim() } : {}),
            ...(changed(email, editing.email) ? { email: email.trim() || null } : {}),
            ...(changed(phone, editing.phone) ? { phone: phone.trim() || null } : {}),
            ...(changed(title, original?.title) ? { title: title.trim() || null } : {}),
            ...(changed(notes, original?.notes) ? { notes: notes.trim() || null } : {}),
            relationship: relationship.trim() || null,
            isPrimary,
          };
          await clientsService.updateClientContact(lawFirmId, clientId, editing.id, payload);
        }
      } else if (isCompany) {
        const payload: CreateCompanyRosterContactPayload = pickedPersonClientId
          ? {
              personClientId: pickedPersonClientId,
              relationship: relationship.trim() || undefined,
              isPrimary,
              isEmailRecipient,
              canViewBilling,
            }
          : {
              name: name.trim(),
              email: email.trim() || undefined,
              phone: phone.trim() || undefined,
              relationship: relationship.trim() || undefined,
              isPrimary,
              isEmailRecipient,
              canViewBilling,
            };
        await clientsService.createClientContact(lawFirmId, clientId, payload);
      } else {
        const payload: CreatePersonRelatedContactPayload = pickedContactId
          ? { contactId: pickedContactId, relationship: relationship.trim() || undefined, isPrimary }
          : {
              name: name.trim(),
              email: email.trim() || undefined,
              phone: phone.trim() || undefined,
              title: title.trim() || undefined,
              relationship: relationship.trim() || undefined,
              notes: notes.trim() || undefined,
              isPrimary,
            };
        await clientsService.createClientContact(lawFirmId, clientId, payload);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, editing ? "Failed to update contact" : "Failed to create contact"));
    } finally {
      setSaving(false);
      setConfirmingLastRecipient(false);
    }
  };

  // True when this save would turn OFF the company's last remaining email
  // recipient. Never true for a brand-new link, which can't have been "the"
  // recipient yet.
  const removingLastEmailRecipient =
    isCompany && !!editing?.isEmailRecipient && !isEmailRecipient && otherEmailRecipientCount === 0;

  // Mirrors the disabled-button condition below: for a company, there's no
  // picker/name field to satisfy once editing (identity isn't editable here
  // at all), so `pickedPersonClientId` stays empty and `name` stays seeded
  // from `editing.name` - never blank in practice - keeping this true only
  // while adding.
  const submitDisabled = isCompany
    ? !pickedPersonClientId && !name.trim()
    : !pickedContactId && !name.trim();

  const handleSubmit = async () => {
    if (!editing) {
      if (submitDisabled) {
        setError(isCompany ? "Pick an existing client, or enter a name for a new one." : "Pick an existing contact, or enter a name for a new one.");
        return;
      }
    } else if (!isCompany && !name.trim()) {
      setError("Contact name is required");
      return;
    }

    // The email is only sent while its field is shown; a picked record or a
    // company link keeps the address on its own record.
    const emailEditable = showPersonIdentityFields || showCompanyIdentityFields;
    if (emailEditable && email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Please enter a valid email address");
      return;
    }

    if (removingLastEmailRecipient) {
      setConfirmingLastRecipient(true);
      return;
    }

    await performSubmit();
  };

  return (
    <>
      <Modal
        isOpen={open}
        onClose={onClose}
        dismissible={!saving}
        title={editing ? (isCompany ? "Edit Relationship" : "Edit Contact") : (isCompany ? "Add Client" : "Add Contact")}
      subtitle={
        !editing
          ? (isCompany
            ? "Pick an existing client, or fill in the fields to add a new one."
            : "Pick someone from your firm's contacts, or fill in the fields to add a new one.")
          : undefined
      }
      size="lg"
      closeIcon={<X size={18} />}
      lockScroll
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button
            type="primary"
            onClick={handleSubmit}
            loading={saving}
            disabled={saving || submitDisabled}
          >
            {editing ? "Save Changes" : (isCompany ? "Add Client" : "Add Contact")}
          </Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} compact />

            {editing ? (
              isCompany ? (
                <div className="space-y-2">
                  <p className="text-xs text-on-surface-muted">
                    Name, email and phone belong to this person&apos;s own client record now, so
                    they&apos;re edited from their client page instead.
                  </p>
                  <div className="flex items-center justify-between gap-3 rounded-md border border-outline-subtle bg-surface-alt px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-on-surface truncate">{editing.name}</p>
                      <p className="text-xs text-on-surface-secondary truncate">
                        {[editing.email, editing.phone].filter(Boolean).join(" · ") || "No contact details on file"}
                      </p>
                    </div>
                    <Button
                      type="secondary"
                      size="small"
                      icon={<ExternalLink size={12} />}
                      onClick={() => {
                        onClose();
                        navigate(`/lawfirm/${lawFirmId}/clients/${editing.personClientId}`);
                      }}
                    >
                      View client
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-on-surface-muted">
                  Name, title, email and phone belong to this person&apos;s contact record, so
                  changes here also apply on every matter they appear on.
                </p>
              )
            ) : isCompany ? (
              <div>
                <EntityPicker
                  entity="clients"
                  lawFirmId={lawFirmId}
                  clientType="person"
                  excludeLinkedToClientId={clientId}
                  value={pickedPersonClientId}
                  onChange={setPickedPersonClientId}
                  placeholder="Search your clients…"
                  buttonClassName="border-input-border bg-input-bg"
                  portal
                />
                {pickedPersonClientId && (
                  <button
                    type="button"
                    onClick={() => setPickedPersonClientId("")}
                    className="text-xs font-medium text-accent-emphasis hover:underline cursor-pointer inline-flex items-center gap-1 mt-1.5"
                  >
                    <X size={13} /> Clear selection to add a new client instead
                  </button>
                )}
              </div>
            ) : (
              <div>
                <EntityPicker
                  entity="contacts"
                  lawFirmId={lawFirmId}
                  value={pickedContactId}
                  onChange={setPickedContactId}
                  placeholder="Search your contacts…"
                  buttonClassName="border-input-border bg-input-bg"
                  portal
                />
                {pickedContactId && (
                  <button
                    type="button"
                    onClick={() => setPickedContactId("")}
                    className="text-xs font-medium text-accent-emphasis hover:underline cursor-pointer inline-flex items-center gap-1 mt-1.5"
                  >
                    <X size={13} /> Clear selection to add a new contact instead
                  </button>
                )}
              </div>
            )}

            {showPersonIdentityFields && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <ContactIdentityField label={<>Name *</>} id={`${fieldIds}-name`}
value={name}
onChange={(e) => setName(e.target.value)}
placeholder="Name" />
                  <ContactDuplicateWarning duplicates={duplicates} onUseExisting={(dupe) => setPickedContactId(dupe.id)} />
                </div>
                <div>
                  <ContactIdentityField label={<>Title</>} id={`${fieldIds}-title`}
value={title}
onChange={(e) => setTitle(e.target.value)}
placeholder="Title" />
                </div>
                <div>
                  <ContactIdentityField label={<>Email</>} id={`${fieldIds}-email`}
value={email}
onChange={(e) => setEmail(e.target.value)}
placeholder="Email" />
                </div>
                <div>
                  <ContactIdentityField label={<>Phone</>} id={`${fieldIds}-phone`}
value={phone}
onChange={(e) => setPhone(e.target.value)}
placeholder="Phone" />
                </div>
                <div className="md:col-span-2">
                  <label htmlFor={`${fieldIds}-notes`} className={LABEL_CLASS}>Notes</label>
                  <textarea
                    id={`${fieldIds}-notes`}
                    value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" rows={3} className={INPUT_CLASS} />
                </div>
              </div>
            )}

            {showCompanyIdentityFields && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <ContactIdentityField label={<>Name *</>} id={`${fieldIds}-contact-name`}
value={name}
onChange={(e) => setName(e.target.value)}
placeholder="Name" />
                </div>
                <div>
                  <ContactIdentityField label={<>Email</>} id={`${fieldIds}-contact-email`}
value={email}
onChange={(e) => setEmail(e.target.value)}
placeholder="Email" />
                </div>
                <div>
                  <ContactIdentityField label={<>Phone</>} id={`${fieldIds}-contact-phone`}
value={phone}
onChange={(e) => setPhone(e.target.value)}
placeholder="Phone" />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor={`${fieldIds}-relationship`} className={LABEL_CLASS}>Relationship</label>
                <input
                  id={`${fieldIds}-relationship`}
                  value={relationship} onChange={(e) => setRelationship(e.target.value)} placeholder="Relationship" className={INPUT_CLASS} />
              </div>
              <label className="inline-flex items-center gap-2 rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface self-end">
                <Checkbox checked={isPrimary} onChange={setIsPrimary} />
                Primary contact
                <Tooltip title="Named on invoices and correspondence. Only one person can be primary, and it doesn't affect who gets emails.">
                  <Info size={13} className="text-on-surface-muted" />
                </Tooltip>
              </label>
            </div>

            {/* Billing delivery/access: only meaningful on a company's roster.
                The flags are independently editable (see the billing contract). */}
            {isCompany && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="inline-flex items-center gap-2 rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface">
                  <Checkbox checked={isEmailRecipient} onChange={setIsEmailRecipient} />
                  Receives emails
                  <Tooltip title="Included on client-facing emails, including invoices, payment updates, document requests, and shared-file notifications.">
                    <Info size={13} className="text-on-surface-muted" />
                  </Tooltip>
                </label>
                <label className="inline-flex items-center gap-2 rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface">
                  <Checkbox checked={canViewBilling} onChange={setCanViewBilling} />
                  Can view billing
                  <Tooltip title="Can see this company's invoices and billing info from their own portal login.">
                    <Info size={13} className="text-on-surface-muted" />
                  </Tooltip>
                </label>
              </div>
            )}
        </Modal>

        <ConfirmModal
          isOpen={confirmingLastRecipient}
          onClose={() => setConfirmingLastRecipient(false)}
          onConfirm={performSubmit}
          title="Remove last email recipient?"
          message={`${name.trim() || "This contact"} is the company's only email recipient. After this change, invoices and client notifications will have nowhere to send until you add a new recipient.`}
          confirmText={saving ? "Saving..." : "Save Anyway"}
          confirmType="danger"
          loading={saving}
          stacked
        />
      </>
  );
}
