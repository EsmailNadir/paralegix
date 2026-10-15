"use client";

import ContactIdentityField from "@/components/contactsComp/ContactIdentityField";
import ContactDuplicateWarning from "./ContactDuplicateWarning";

import { FIELD_LABEL_BLOCK_CLS, FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import contactsService from "@/services/contacts.service";
import type { Contact, ContactCategory, ContactType, ContactUpsertPayload } from "@/types";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import Dropdown from "@/components/ui/Dropdown";
import TagChip from "@/components/ui/TagChip";
import ErrorNotification from "@/components/ErrorNotification";

import { CONTACT_CATEGORY_OPTIONS } from "@/constants/statusMeta";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { useContactDuplicateCheck } from "@/hooks/contactHooks/useContactDuplicateCheck";
import Modal from "@/components/ui/Modal";
import ClientOrganizationAutocomplete from "@/components/clientComp/ClientOrganizationAutocomplete";

const INPUT_CLASS = FULL_INPUT_CLS;
const LABEL_CLASS = FIELD_LABEL_BLOCK_CLS;

const TYPE_OPTIONS: { value: ContactType; label: string }[] = [
  { value: "person", label: "Person" },
  { value: "company", label: "Organization" },
];

interface FormState {
  contactType: ContactType;
  name: string;
  category: ContactCategory;
  organization: string;
  title: string;
  barNumber: string;
  email: string;
  phone: string;
  phoneAlt: string;
  address: string;
  website: string;
  tags: string[];
  notes: string;
  oneTime: boolean;
}

const EMPTY_FORM: FormState = {
  contactType: "person",
  name: "",
  category: "opposing_counsel",
  organization: "",
  title: "",
  barNumber: "",
  email: "",
  phone: "",
  phoneAlt: "",
  address: "",
  website: "",
  tags: [],
  notes: "",
  oneTime: false,
};

function toForm(contact: Contact): FormState {
  return {
    contactType: contact.contactType || "person",
    name: contact.name || "",
    category: contact.category || "other",
    organization: contact.organization || "",
    title: contact.title || "",
    barNumber: contact.barNumber || "",
    email: contact.email || "",
    phone: contact.phone || "",
    phoneAlt: contact.phoneAlt || "",
    address: contact.address || "",
    website: contact.website || "",
    tags: contact.tags || [],
    notes: contact.notes || "",
    oneTime: contact.oneTime || false,
  };
}

interface ContactFormModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: (contact: Contact) => void;
  lawFirmId: string;
  editing?: Contact | null;
  /**
   * Offered when a likely duplicate is found: picking the existing contact
   * instead of creating a new one. Modals whose caller cannot use an existing
   * contact (the plain directory "New contact") leave this out, and the
   * warning is shown without that option.
   */
  onUseExisting?: (contact: Contact) => void;
  /** Seeds the name field, for a picker that had a typed search term. */
  initialName?: string;
  /** Shows the "one-time contact" checkbox. Only passed when opened from a matter's Add Contact flow. */
  matterContext?: boolean;
}

export default function ContactFormModal({
  open, onClose, onSaved, lawFirmId, editing, onUseExisting, initialName, matterContext,
}: ContactFormModalProps) {
  const fieldIds = useId();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Advisory only, and only while creating: editing a contact shouldn't warn
  // that it looks like itself.
  const { duplicates } = useContactDuplicateCheck(lawFirmId, form.name, form.email, {
    enabled: open && !editing,
  });

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs form fields to the contact being edited when the modal opens
    setForm(editing ? toForm(editing) : { ...EMPTY_FORM, name: initialName || "" });
    setTagInput("");
    setError(null);
  }, [open, editing, initialName]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    setForm((prev) => {
      if (prev.tags.length >= 25 || prev.tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
        return prev;
      }
      return { ...prev, tags: [...prev.tags, tag] };
    });
    setTagInput("");
  };

  const removeTag = (tag: string) => {
    setForm((prev) => ({ ...prev, tags: prev.tags.filter((existing) => existing !== tag) }));
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setError("Please enter a valid email address");
      return;
    }
    const pendingTag = tagInput.trim();
    const submittedTags = pendingTag
      && form.tags.length < 25
      && !form.tags.some((tag) => tag.toLowerCase() === pendingTag.toLowerCase())
      ? [...form.tags, pendingTag]
      : form.tags;
    setSubmitting(true);
    setError(null);

    // null (not undefined) on the optional fields, so clearing one persists as
    // cleared rather than being dropped from the payload.
    const payload: ContactUpsertPayload & { name: string } = {
      name: form.name.trim(),
      contactType: form.contactType,
      category: form.category,
      organization: form.organization.trim() || null,
      title: form.title.trim() || null,
      barNumber: form.barNumber.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      phoneAlt: form.phoneAlt.trim() || null,
      address: form.address.trim() || null,
      website: form.website.trim() || null,
      tags: submittedTags,
      notes: form.notes.trim() || null,
      ...(editing ? {} : { oneTime: form.oneTime }),
    };

    try {
      if (editing) {
        const { contact } = await contactsService.updateContact(lawFirmId, editing.id, payload);
        onSaved(contact);
      } else {
        const { contact } = await contactsService.createContact(lawFirmId, payload);
        onSaved(contact);
      }
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const isCompany = form.contactType === "company";

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      dismissible={!submitting}
      title={editing ? "Edit Contact" : "New Contact"}
      size="lg"
      closeIcon={<X size={18} />}
      lockScroll
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            type="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={submitting || !form.name.trim()}
          >
            {editing ? "Save Changes" : "Create Contact"}
          </Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} compact />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label id={`${fieldIds}-type-label`} className={LABEL_CLASS}>Type</label>
          <Dropdown
            ariaLabelledBy={`${fieldIds}-type-label`}
            value={form.contactType}
            onChange={(value) => set("contactType", value as ContactType)}
            options={TYPE_OPTIONS}
            buttonClassName="border-input-border bg-input-bg"
            portal
          />
        </div>
        <div>
          <label id={`${fieldIds}-category-label`} className={LABEL_CLASS}>Category</label>
          <Dropdown
            ariaLabelledBy={`${fieldIds}-category-label`}
            value={form.category}
            onChange={(value) => set("category", value as ContactCategory)}
            options={CONTACT_CATEGORY_OPTIONS}
            buttonClassName="border-input-border bg-input-bg"
            portal
          />
        </div>
      </div>

      <div>
        <ContactIdentityField label={<>{isCompany ? "Organization name *" : "Name *"}</>} id={`${fieldIds}-name`}
type="text"
value={form.name}
onChange={(e) => set("name", e.target.value)}
placeholder={isCompany ? "e.g. Northwind Mutual Insurance" : "e.g. Jane Roe"}
maxLength={300} />
        <ContactDuplicateWarning duplicates={duplicates} onUseExisting={onUseExisting ? (dupe) => { onUseExisting(dupe); onClose(); } : undefined} />
      </div>

      {!isCompany && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor={`${fieldIds}-organization`} className={LABEL_CLASS}>Organization</label>
            <ClientOrganizationAutocomplete
              id={`${fieldIds}-organization`}
              lawFirmId={lawFirmId}
              value={form.organization}
              onChange={(organization) => set("organization", organization)}
              placeholder="e.g. Roe & Associates LLP"
              maxLength={300}
            />
          </div>
          <div>
            <ContactIdentityField label={<>Title</>} id={`${fieldIds}-title`}
type="text"
value={form.title}
onChange={(e) => set("title", e.target.value)}
placeholder="e.g. Partner"
maxLength={300} />
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <ContactIdentityField label={<>Email</>} id={`${fieldIds}-email`}
type="email"
value={form.email}
onChange={(e) => set("email", e.target.value)}
placeholder="name@example.com"
maxLength={300} />
        </div>
        <div>
          <ContactIdentityField label={<>Phone</>} id={`${fieldIds}-phone`}
type="tel"
value={form.phone}
onChange={(e) => set("phone", e.target.value)}
placeholder="(555) 123-4567"
maxLength={100} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor={`${fieldIds}-phonealt`} className={LABEL_CLASS}>Alternate phone</label>
          <input
            id={`${fieldIds}-phonealt`}
            type="tel"
            value={form.phoneAlt}
            onChange={(e) => set("phoneAlt", e.target.value)}
            placeholder="(555) 987-6543"
            className={INPUT_CLASS}
            maxLength={100}
          />
        </div>
        <div>
          <label htmlFor={`${fieldIds}-barnumber`} className={LABEL_CLASS}>Bar number</label>
          <input
            id={`${fieldIds}-barnumber`}
            type="text"
            value={form.barNumber}
            onChange={(e) => set("barNumber", e.target.value)}
            placeholder="e.g. 284195"
            className={INPUT_CLASS}
            maxLength={100}
          />
        </div>
      </div>

      <div>
        <label htmlFor={`${fieldIds}-address`} className={LABEL_CLASS}>Address</label>
        <input
          id={`${fieldIds}-address`}
          type="text"
          value={form.address}
          onChange={(e) => set("address", e.target.value)}
          placeholder="e.g. 123 Main St, Springfield"
          className={INPUT_CLASS}
          maxLength={1000}
        />
      </div>

      <div>
        <label htmlFor={`${fieldIds}-website`} className={LABEL_CLASS}>Website</label>
        <input
          id={`${fieldIds}-website`}
          type="text"
          value={form.website}
          onChange={(e) => set("website", e.target.value)}
          placeholder="https://example.com"
          className={INPUT_CLASS}
          maxLength={1000}
        />
      </div>

      <div>
        <label className={LABEL_CLASS}>Tags</label>
        <div className="fused-field-group flex flex-wrap items-center gap-2 rounded-md border border-input-border bg-input-bg px-3 py-2 focus-within:ring-2 focus-within:ring-focus-ring">
          {form.tags.map((tag) => (
            <TagChip
              key={tag}
              label={tag}
              onRemove={() => removeTag(tag)}
            />
          ))}
          <input
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag(tagInput);
              } else if (e.key === "Backspace" && !tagInput && form.tags.length > 0) {
                removeTag(form.tags[form.tags.length - 1]);
              }
            }}
            onBlur={() => addTag(tagInput)}
            placeholder={form.tags.length ? "Add another tag…" : "Type a tag and press Enter…"}
            className="min-w-40 flex-1 bg-transparent py-0.5 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none"
            maxLength={50}
            disabled={form.tags.length >= 25}
          />
        </div>
        <p className="mt-1 text-xs text-on-surface-muted">Use tags to group and filter contacts. Press Enter or comma to add one.</p>
      </div>

      <div>
        <label htmlFor={`${fieldIds}-notes`} className={LABEL_CLASS}>Notes</label>
        <textarea
          id={`${fieldIds}-notes`}
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="Background that applies to this contact everywhere..."
          rows={3}
          className={INPUT_CLASS}
          maxLength={5000}
        />
      </div>

      {matterContext && !editing && (
        <div className="rounded-md border border-outline-subtle bg-surface-alt px-3 py-2.5">
          <Checkbox
            checked={form.oneTime}
            onChange={(checked) => set("oneTime", checked)}
            label="One-time contact for this matter only"
            description="Won't be saved to your firm's shared Contacts directory."
          />
        </div>
      )}
    </Modal>
  );
}
