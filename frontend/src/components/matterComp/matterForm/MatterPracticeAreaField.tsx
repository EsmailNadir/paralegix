import { useState } from "react";
import { Plus, X } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import Button from "@/components/ui/Button";
import Dropdown, { DropdownOption } from "@/components/ui/Dropdown";
import FieldError from "@/components/ui/FieldError";
import { useNavigation } from "@/contexts/NavigationContext";
import FieldLabel from "@/components/ui/FieldLabel";

type PracticeArea = { id: string; name: string };

/**
 * Practice-area selector with an inline quick-create panel and an empty state
 * that links to settings. Shared by the create and edit matter modals so the
 * field behaves identically in both. Manages its own quick-create state.
 */
export default function MatterPracticeAreaField({
  value,
  onChange,
  practiceAreas,
  loading,
  createPracticeArea,
  firmId,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  practiceAreas: PracticeArea[];
  loading: boolean;
  createPracticeArea: (name: string) => Promise<{ practiceArea: { id: string } }>;
  firmId: string;
  disabled?: boolean;
}) {
  const { navigate } = useNavigation();
  const [showQuickCreate, setShowQuickCreate] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options: DropdownOption[] = [
    { label: "None", value: "" },
    ...practiceAreas.map((p) => ({ label: p.name, value: p.id })),
  ];
  const hasPracticeAreas = practiceAreas.length > 0;

  const handleQuickCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const result = await createPracticeArea(name.trim());
      onChange(result.practiceArea.id);
      setShowQuickCreate(false);
      setName("");
    } catch (e: any) {
      setError(e?.message || "Failed to create practice area");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <FieldLabel>Practice Area</FieldLabel>
      {/* The control stays mounted while the list loads (the menu carries the
          wait) so the field doesn't pop in and shift the rest of the form. The
          empty state is only the answer once we know the list is really empty. */}
      {!loading && !hasPracticeAreas && !showQuickCreate ? (
        <div className="rounded-lg border border-dashed border-outline p-4 text-center">
          <p className="text-sm text-on-surface-muted">No practice areas configured yet</p>
          <p className="text-xs text-on-surface-muted mt-1">
            <button
              type="button"
              onClick={() => navigate(`/lawfirm/${firmId}/settings/matter-config`)}
              className="text-accent-emphasis hover:underline"
            >
              Set up in Settings
            </button>{" "}
            or{" "}
            <button type="button" onClick={() => setShowQuickCreate(true)} className="text-accent-emphasis hover:underline">
              create one now
            </button>
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <Dropdown
              value={value}
              onChange={onChange}
              options={options}
              disabled={disabled}
              loading={loading}
              portal
            />
          </div>
          <Tooltip title="Quick-create a practice area" enterDelay={300}>
            <button aria-label="Quick-create a practice area"
              type="button"
              onClick={() => setShowQuickCreate((prev) => !prev)}
              className="flex size-[38px] shrink-0 items-center justify-center rounded-lg border border-outline text-on-surface-secondary transition-[background-color,border-color,color,transform] hover:bg-surface-hover hover:text-on-surface active:scale-[0.96] motion-reduce:active:scale-100"
            >
              {showQuickCreate ? <X size={16} /> : <Plus size={16} />}
            </button>
          </Tooltip>
        </div>
      )}
      {showQuickCreate && (
        <div className="mt-2 p-3 rounded-lg border border-outline bg-surface-alt space-y-2">
          <p className="text-xs font-medium text-on-surface">Quick Create Practice Area</p>
          <FieldError message={error} className="mt-0" />
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Family Law"
              className="flex-1 rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-2 py-1.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
            <Button
              type="primary"
              size="small"
              onClick={handleQuickCreate}
              disabled={creating || !name.trim()}
              loading={creating}
            >
              Create & Select
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
