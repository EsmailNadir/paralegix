import { useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import Button from "@/components/ui/Button";
import Dropdown, { DropdownOption } from "@/components/ui/Dropdown";
import FieldError from "@/components/ui/FieldError";
import FieldLabel from "@/components/ui/FieldLabel";

/**
 * A Dropdown paired with an inline quick-create panel, for lists a firm can
 * extend on the fly (note types, note templates) without leaving the form.
 * Mirrors MatterPracticeAreaField's quick-create pattern.
 */
export default function QuickAddDropdown({
  label,
  value,
  onChange,
  options,
  buttonClassName,
  loading,
  quickAddTooltip,
  quickAddPlaceholder,
  quickAddButtonLabel,
  onQuickAdd,
  trailingAction,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  options: DropdownOption[];
  buttonClassName?: string;
  loading?: boolean;
  quickAddTooltip: string;
  quickAddPlaceholder: string;
  quickAddButtonLabel: string;
  /** Creates the new entry and resolves the value/id to select. */
  onQuickAdd: (label: string) => Promise<string>;
  /** Extra control rendered after the quick-add button, e.g. a color picker. */
  trailingAction?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!newLabel.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const newValue = await onQuickAdd(newLabel.trim());
      onChange(newValue);
      setOpen(false);
      setNewLabel("");
    } catch (e: any) {
      setError(e?.message || "Failed to create");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      {label && <FieldLabel>{label}</FieldLabel>}
      <div className="flex items-stretch gap-2">
        <div className="flex-1 min-w-0">
          <Dropdown
            value={value}
            onChange={onChange}
            options={options}
            loading={loading}
            buttonClassName={buttonClassName}
          />
        </div>
        <Tooltip title={quickAddTooltip} enterDelay={300}>
          <button
            aria-label={quickAddTooltip}
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            className="shrink-0 w-8 flex items-center justify-center rounded-lg border border-outline text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
          >
            {open ? <X size={15} /> : <Plus size={15} />}
          </button>
        </Tooltip>
        {trailingAction}
      </div>
      {open && (
        <div className="mt-2 p-3 rounded-lg border border-outline bg-surface-alt space-y-2">
          <FieldError message={error} className="mt-0" />
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder={quickAddPlaceholder}
              className="flex-1 rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-2 py-1.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
            <Button
              type="primary"
              size="small"
              className="whitespace-nowrap"
              onClick={handleCreate}
              disabled={creating || !newLabel.trim()}
              loading={creating}
            >
              {quickAddButtonLabel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
