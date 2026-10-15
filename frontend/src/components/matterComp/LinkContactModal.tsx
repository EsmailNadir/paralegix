"use client";

import { FIELD_LABEL_BLOCK_CLS, FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { useEffect, useId, useState } from "react";
import { X, Plus } from "lucide-react";
import mattersService from "@/services/matters.service";
import type { Contact, MatterContact, MatterContactRole } from "@/types";
import type { LookupItem } from "@/hooks/useEntityLookup";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import EntityPicker from "@/components/ui/EntityPicker";
import ErrorNotification from "@/components/ErrorNotification";
import ContactFormModal from "@/components/contactsComp/ContactFormModal";
import Modal from "@/components/ui/Modal";
import { MATTER_CONTACT_ROLE_OPTIONS } from "@/constants/statusMeta";
import { getErrorMessage } from "@/lib/utils/apiErrors";

const INPUT_CLASS = FULL_INPUT_CLS;
const LABEL_CLASS = FIELD_LABEL_BLOCK_CLS;

interface LinkContactModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  lawFirmId: string;
  matterId: string;
  /**
   * The link being edited. Editing changes only what the contact is ON THIS
   * MATTER - their details are shared with every other matter and are edited
   * from the contacts directory.
   */
  editing?: MatterContact | null;
  /** Whether the user may add records to the shared directory. */
  canCreateContact: boolean;
}

/**
 * Puts a contact on a matter: pick one from the firm directory, or create a new
 * directory record and link it in one step.
 */
export default function LinkContactModal({
  open, onClose, onSaved, lawFirmId, matterId, editing, canCreateContact,
}: LinkContactModalProps) {
  const fieldIds = useId();
  const [contactId, setContactId] = useState("");
  const [role, setRole] = useState<MatterContactRole>("opposing_counsel");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs form fields to the link being edited when the modal opens
    setContactId(editing?.contactId || "");
    setRole(editing?.role || "opposing_counsel");
    setNotes(editing?.notes || "");
    setError(null);
  }, [open, editing]);

  const handleSubmit = async () => {
    if (!editing && !contactId) {
      setError("Pick a contact, or create a new one.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (editing) {
        await mattersService.updateContact(lawFirmId, matterId, editing.id, {
          role,
          notes: notes.trim() || null,
        });
      } else {
        await mattersService.createContact(lawFirmId, matterId, {
          contactId,
          role,
          notes: notes.trim() || null,
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const isMatterContactRole = (value?: string | null): value is MatterContactRole =>
    MATTER_CONTACT_ROLE_OPTIONS.some((option) => option.value === value);

  // Prefill the matter role from the contact's usual category, e.g. picking a
  // judge from the directory defaults "Role on this matter" to Judge too.
  const handleContactSelect = (item: LookupItem | null) => {
    if (isMatterContactRole(item?.category)) setRole(item.category);
  };

  // A contact created from here is linked by the same submit as an existing
  // one, so the new record just becomes the picker's selection.
  const handleContactCreated = (contact: Contact) => {
    setContactId(contact.id);
    if (isMatterContactRole(contact.category)) setRole(contact.category);
    setCreateOpen(false);
  };

  return (
    <>
    <Modal
      isOpen={open}
      onClose={onClose}
      title={editing ? "Edit Contact on Matter" : "Add Contact"}
      closeIcon={<X size={18} />}
      size="lg"
      lockScroll
      dismissible={!submitting}
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            type="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={submitting || (!editing && !contactId)}
          >
            {editing ? "Save Changes" : "Add to Matter"}
          </Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} compact />

            {editing ? (
              <div>
                <p className={LABEL_CLASS}>Contact</p>
                <p className="text-sm text-on-surface">{editing.name}</p>
                <p className="text-xs text-on-surface-muted mt-0.5">
                  Their name and details are shared across matters. Edit those from Contacts.
                </p>
              </div>
            ) : (
              <div>
                <label className={LABEL_CLASS}>Contact *</label>
                <EntityPicker
                  entity="contacts"
                  lawFirmId={lawFirmId}
                  value={contactId}
                  onChange={setContactId}
                  onSelectItem={handleContactSelect}
                  excludeMatterId={matterId}
                  placeholder="Search your contacts…"
                  buttonClassName="border-input-border bg-input-bg"
                  portal
                />
                {contactId && (
                  <button
                    type="button"
                    onClick={() => setContactId("")}
                    className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-accent-emphasis hover:underline cursor-pointer"
                  >
                    <X size={13} /> Clear selection
                  </button>
                )}
                {canCreateContact && (
                  <button
                    type="button"
                    onClick={() => setCreateOpen(true)}
                    className="mt-2 flex items-center gap-1.5 text-xs font-medium text-accent-emphasis hover:underline cursor-pointer"
                  >
                    <Plus size={13} /> Create a new contact
                  </button>
                )}
              </div>
            )}

            <div>
              <label id={`${fieldIds}-role-on-this-matter-label`} className={LABEL_CLASS}>Role on this matter</label>
              <Dropdown
                ariaLabelledBy={`${fieldIds}-role-on-this-matter-label`}
                value={role}
                onChange={(value) => setRole(value as MatterContactRole)}
                options={MATTER_CONTACT_ROLE_OPTIONS}
                buttonClassName="border-input-border bg-input-bg"
                portal
              />
            </div>

            <div>
              <label htmlFor={`${fieldIds}-notes`} className={LABEL_CLASS}>Notes for this matter</label>
              <textarea
                id={`${fieldIds}-notes`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything specific to this contact's involvement here..."
                rows={3}
                className={INPUT_CLASS}
                maxLength={2000}
              />
            </div>
    </Modal>

      <ContactFormModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={handleContactCreated}
        onUseExisting={handleContactCreated}
        lawFirmId={lawFirmId}
        matterContext
      />
    </>
  );
}
