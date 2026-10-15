"use client";

import { useId, useState, useEffect, useRef, useMemo } from "react";
import { Search, UserRound, BriefcaseBusiness, Building2, CalendarDays } from "lucide-react";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";

interface PlaceholderModalProps {
  open: boolean;
  onClose: () => void;
  onInsert: (name: string) => void;
  repeaterPrefix?: string | null;
}

type SuggestionGroup = {
  label: string;
  icon: React.ReactNode;
  fields: { id: string; description: string }[];
};

const SUGGESTION_GROUPS: SuggestionGroup[] = [
  {
    label: "Client",
    icon: <UserRound size={13} />,
    fields: [
      { id: "client_name", description: "Full name" },
      { id: "client_first_name", description: "First name" },
      { id: "client_last_name", description: "Last name" },
      { id: "client_email", description: "Email address" },
      { id: "client_phone", description: "Phone number" },
      { id: "client_address", description: "Mailing address" },
      { id: "client_organization", description: "Company / organization" },
      { id: "client_preferred_contact_method", description: "Preferred contact method" },
      { id: "client_status", description: "Client status" },
    ],
  },
  {
    label: "Matter",
    icon: <BriefcaseBusiness size={13} />,
    fields: [
      { id: "case_name", description: "Case / matter name" },
      { id: "case_number", description: "Case number" },
      { id: "case_reference_id", description: "Reference ID" },
      { id: "case_description", description: "Description" },
      { id: "case_status", description: "Status" },
      { id: "practice_area", description: "Practice area" },
      { id: "charge_code", description: "Charge code" },
      { id: "case_category", description: "Category" },
      { id: "lead_attorney", description: "Lead attorney name" },
    ],
  },
  {
    label: "Law Firm",
    icon: <Building2 size={13} />,
    fields: [
      { id: "firm_name", description: "Firm name" },
      { id: "firm_address", description: "Street address" },
      { id: "firm_city", description: "City" },
      { id: "firm_state", description: "State" },
      { id: "firm_zip", description: "Postal code" },
      { id: "firm_full_address", description: "Full address (street, city, state, zip)" },
      { id: "firm_phone", description: "Phone number" },
      { id: "firm_email", description: "Email address" },
    ],
  },
  {
    label: "Date",
    icon: <CalendarDays size={13} />,
    fields: [
      { id: "date", description: `Today's date (${new Date().toLocaleDateString()})` },
      {
        id: "full_date",
        description: `Full date (${new Date().toLocaleDateString(undefined, {
          year: "numeric",
          month: "long",
          day: "numeric",
        })})`,
      },
      { id: "year", description: `Current year (${new Date().getFullYear()})` },
      {
        id: "month",
        description: `Current month (${new Date().toLocaleDateString(undefined, { month: "long" })})`,
      },
      { id: "day", description: `Day of month (${new Date().getDate()})` },
    ],
  },
];

export default function PlaceholderModal({
  open,
  onClose,
  onInsert,
  repeaterPrefix,
}: PlaceholderModalProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const fieldId = useId();
  const searchId = useId();
  const errorId = useId();

  // Reset the form fields when it opens. Done during render so these
  // synchronous resets don't run inside an effect.
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setName("");
      setError(null);
      setSearch("");
    }
  }

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return SUGGESTION_GROUPS;
    return SUGGESTION_GROUPS.map((group) => ({
      ...group,
      fields: group.fields.filter(
        (f) =>
          f.id.includes(q) ||
          f.description.toLowerCase().includes(q) ||
          group.label.toLowerCase().includes(q),
      ),
    })).filter((group) => group.fields.length > 0);
  }, [search]);

  const resolvedName = repeaterPrefix ? `${repeaterPrefix}.${name.trim()}` : name.trim();

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Field ID is required.");
      return;
    }
    onInsert(repeaterPrefix ? `${repeaterPrefix}.${trimmed}` : trimmed);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSubmit();
  };

  const handleSelectSuggestion = (fieldId: string) => {
    setName(fieldId);
    setError(null);
    inputRef.current?.focus();
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Insert Placeholder"
      subtitle="Creates a fillable placeholder in the document"
      size="md"
      footer={
        <>
          <Button type="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit}>Insert Field</Button>
        </>
      }
    >
          <>
            <div>
              <label htmlFor={fieldId} className="mb-1 block text-sm font-medium text-on-surface">Field ID</label>
              <input
                id={fieldId}
                ref={inputRef}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                onKeyDown={handleKeyDown}
                placeholder="e.g. client_name, date_signed"
                className="h-8 w-full rounded-lg border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-control-ring"
              />
              <p className="mt-1.5 text-xs text-on-surface-muted">
                Fields with the same ID will be filled with the same value everywhere they appear.
              </p>
              {error && <p id={errorId} className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
            </div>

            {repeaterPrefix && (
              <div className="flex items-center gap-2 rounded-md bg-accent-soft border border-accent-border-soft px-3 py-2">
                <span className="text-sm font-medium text-accent-emphasis">
                  ↻ Repeater: {repeaterPrefix}
                </span>
                <span className="text-xs text-accent-emphasis">
                  This field will repeat with each row
                </span>
              </div>
            )}

            <div className="flex items-center gap-2 rounded-md bg-surface-alt border border-outline px-3 py-2">
              <span className="text-xs text-on-surface-muted">Preview:</span>
              <span className="inline-flex h-5 items-center whitespace-nowrap rounded-md px-1.5 font-mono text-sm font-medium bg-accent-soft text-accent-emphasis border border-accent-border-soft">
                {`{${resolvedName || "field_id"}}`}
              </span>
            </div>

            {/* Auto-fill suggestions */}
            <div>
              <label htmlFor={searchId} className="mb-1.5 block text-sm font-medium text-on-surface-secondary uppercase tracking-[0.06em]">
                Auto-fill Fields
              </label>
              <p className="text-xs text-on-surface-muted mb-2">
                These fields auto-fill in Fill &amp; Download. Firm and date fields fill automatically.
              </p>
              <div className="relative mb-2">
                <Search
                  size={13}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-muted"
                />
                <input
                  id={searchId}
                  ref={searchRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search fields..."
                  className="h-8 w-full rounded-lg border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-control-ring"
                />
              </div>

              <div className="space-y-2 max-h-[200px] overflow-y-auto styled-scrollbar">
                {filteredGroups.length === 0 ? (
                  <p className="text-xs text-on-surface-muted text-center py-3">
                    No matching fields
                  </p>
                ) : (
                  filteredGroups.map((group) => (
                    <div key={group.label}>
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-on-surface-muted">{group.icon}</span>
                        <span className="text-sm font-medium text-on-surface-secondary">
                          {group.label}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {group.fields.map((field) => (
                          <button
                            key={field.id}
                            type="button"
                            onClick={() => handleSelectSuggestion(field.id)}
                            className={`inline-flex min-h-6 items-center gap-1.5 rounded-md px-2 text-left text-xs transition-colors cursor-pointer ${
                              name === field.id
                                ? "bg-accent-soft text-accent-emphasis border border-accent-border-soft"
                                : "bg-surface-alt text-on-surface-secondary hover:bg-surface-hover border border-outline-subtle"
                            }`}
                          >
                            {field.id}
                            <span
                              className={`${name === field.id ? "text-accent-emphasis" : "text-on-surface-muted"}`}
                            >
                              {field.description}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
    </Modal>
  );
}
