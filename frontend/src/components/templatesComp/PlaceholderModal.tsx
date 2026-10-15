"use client";

import { useId, useState, useEffect, useRef, useMemo } from "react";
import { Search } from "lucide-react";
import Button from "@/components/ui/Button";
import FieldError from "@/components/ui/FieldError";
import Modal from "@/components/ui/Modal";
import { useLastOpenValue } from "@/hooks/useMountTransition";
import { SUGGESTION_GROUPS } from "./mergeFieldCatalog";
import FieldLabel from "@/components/ui/FieldLabel";
import TextInput from "@/components/ui/TextInput";

interface PlaceholderModalProps {
  open: boolean;
  onClose: () => void;
  /** `repeaterName` is only passed when `newRepeater` is true, carrying the
   *  name the user just typed for the brand-new repeater this field starts. */
  onInsert: (name: string, repeaterName?: string) => void;
  /** An already-confirmed repeater this field is an additional column of;
   *  shown as a read-only badge. Mutually exclusive with `newRepeater`. */
  repeaterPrefix?: string | null;
  /** This field is the first column of a repeater that doesn't exist yet, so
   *  the repeater itself needs a name too: shows an editable "Repeater name"
   *  input above "Field ID" instead of the read-only badge. */
  newRepeater?: boolean;
}

/** The longest field or repeater name the server stores. */
const FIELD_NAME_MAX_LENGTH = 120;

export default function PlaceholderModal({ open, onClose, onInsert, repeaterPrefix, newRepeater }: PlaceholderModalProps) {
  const fieldIds = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [repeaterNameInput, setRepeaterNameInput] = useState("");
  const [repeaterNameError, setRepeaterNameError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const repeaterNameInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // The editor clears the repeater context in the same handler that closes
  // this, so the repeater chip would disappear a beat before the modal does.
  const shownRepeaterPrefix = useLastOpenValue(open, repeaterPrefix);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets form fields when the modal opens
    setName("");
    setError(null);
    setRepeaterNameInput("");
    setRepeaterNameError(null);
    setSearch("");
    const t = setTimeout(() => (newRepeater ? repeaterNameInputRef : inputRef).current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open, newRepeater]);

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return SUGGESTION_GROUPS;
    return SUGGESTION_GROUPS
      .map((group) => ({
        ...group,
        fields: group.fields.filter(
          (f) => f.id.includes(q) || f.description.toLowerCase().includes(q) || group.label.toLowerCase().includes(q)
        ),
      }))
      .filter((group) => group.fields.length > 0);
  }, [search]);

  const effectivePrefix = newRepeater ? repeaterNameInput.trim() : (repeaterPrefix ?? null);
  const resolvedName = effectivePrefix ? `${effectivePrefix}.${name.trim()}` : name.trim();

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (newRepeater && !repeaterNameInput.trim()) {
      setRepeaterNameError("Repeater name is required.");
      return;
    }
    if (!trimmed) {
      setError("Field ID is required.");
      return;
    }
    onInsert(effectivePrefix ? `${effectivePrefix}.${trimmed}` : trimmed, newRepeater ? repeaterNameInput.trim() : undefined);
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
      className="rounded-xl border-2 border-outline shadow-2xl"
      footer={
        <>
          <Button type="secondary" onClick={onClose}>Cancel</Button>
          <Button type="primary" onClick={handleSubmit} disabled={!name.trim() || (newRepeater && !repeaterNameInput.trim())}>Insert Field</Button>
        </>
      }
    >
      {newRepeater && (
              <div>
                <FieldLabel htmlFor={`${fieldIds}-repeaternameinput`}>
                  Repeater name *
                </FieldLabel>
                <TextInput
                  id={`${fieldIds}-repeaternameinput`}
                  ref={repeaterNameInputRef}
                  type="text"
                  value={repeaterNameInput}
                  maxLength={FIELD_NAME_MAX_LENGTH}
                  onChange={(e) => { setRepeaterNameInput(e.target.value); setRepeaterNameError(null); }}
                  onKeyDown={handleKeyDown}
                  placeholder="e.g. line_items"
                />
                <p className="mt-1.5 text-xs text-on-surface-muted">
                  Names the group of columns that repeats for each row, like each line item on an invoice.
                </p>
                <FieldError message={repeaterNameError} />
              </div>
            )}

            <div>
              <FieldLabel htmlFor={`${fieldIds}-name`}>
                Field ID *
              </FieldLabel>
              <TextInput
                id={`${fieldIds}-name`}
                ref={inputRef}
                type="text"
                value={name}
                maxLength={FIELD_NAME_MAX_LENGTH}
                onChange={(e) => { setName(e.target.value); setError(null); }}
                onKeyDown={handleKeyDown}
                placeholder="e.g. client_name, date_signed"
              />
              <p className="mt-1.5 text-xs text-on-surface-muted">
                Fields with the same ID will be filled with the same value everywhere they appear.
              </p>
              <FieldError message={error} />
            </div>

            {shownRepeaterPrefix && (
              <div className="flex items-center gap-2 rounded-md bg-accent-soft dark:bg-accent-soft border border-accent-border-soft dark:border-accent-border-soft px-3 py-2">
                <span className="text-xs font-medium text-accent-emphasis">↻ Repeater: {shownRepeaterPrefix}</span>
                <span className="text-xs text-accent-emphasis dark:text-accent-emphasis">, this field will repeat with each row</span>
              </div>
            )}

            <div className="flex items-center gap-2 rounded-md bg-surface-alt border border-outline px-3 py-2">
              <span className="text-xs text-on-surface-muted">Preview:</span>
              <span className="font-mono text-xs bg-accent-soft dark:bg-accent-soft text-accent-emphasis border border-accent-border-soft dark:border-accent-border-soft rounded px-1.5 py-0.5">
                {`{${resolvedName || "field_id"}}`}
              </span>
            </div>

            {/* Auto-fill suggestions */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-on-surface-secondary uppercase tracking-wide">
                Auto-fill Fields
              </label>
              <p className="text-xs text-on-surface-muted mb-2">
                These fields auto-fill when the template is filled. Firm and date fields fill automatically.
              </p>
              <div className="relative mb-2">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-muted" />
                <input
                  ref={searchRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search fields..."
                  className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted pl-8 pr-3 py-1.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
              </div>

              <div className="space-y-2 max-h-[200px] overflow-y-auto overflow-x-hidden styled-scrollbar">
                {filteredGroups.length === 0 ? (
                  <p className="text-xs text-on-surface-muted text-center py-3">No matching fields</p>
                ) : (
                  filteredGroups.map((group) => (
                    <div key={group.label}>
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-on-surface-muted"><group.icon size={13} /></span>
                        <span className="text-xs font-semibold text-on-surface-secondary">{group.label}</span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {group.fields.map((field) => (
                          <button
                            key={field.id}
                            type="button"
                            onClick={() => handleSelectSuggestion(field.id)}
                            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer ${
                              name === field.id
                                ? "bg-accent-soft dark:bg-accent-soft text-accent-emphasis dark:text-accent-emphasis border border-accent-border-soft dark:border-accent-border-soft"
                                : "bg-surface-alt text-on-surface-secondary hover:bg-surface-hover border border-outline-subtle"
                            }`}
                          >
                            {field.id}
                            <span className={`${name === field.id ? "text-accent-emphasis dark:text-accent-emphasis" : "text-on-surface-muted"}`}>
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
    </Modal>
  );
}
