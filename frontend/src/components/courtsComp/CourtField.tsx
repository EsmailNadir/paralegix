import { useState } from "react";
import { Plus, X } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import Button from "@/components/ui/Button";
import Dropdown, { DropdownOption } from "@/components/ui/Dropdown";
import FieldError from "@/components/ui/FieldError";
import CourtDirectoryLink from "@/components/courtsComp/CourtDirectoryLink";
import CourtNameAutocomplete, { formatCourtCatalogValue } from "@/components/courtsComp/CourtNameAutocomplete";
import { formatCourtOptionLabel } from "@/types/court";
import type { CourtUpsertData, CreateCourtResponse } from "@/services/courts.service";

type SimpleCourt = { id: string; name: string; abbreviation?: string | null; city?: string | null };

/**
 * Court selector with an optional inline quick-create
 * panel and an empty state that links to settings. Manages its own quick-create
 * state and auto-selects a freshly created court.
 */
export default function CourtField({
  value,
  onChange,
  courts,
  loading,
  createCourt,
  firmId,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  courts: SimpleCourt[];
  loading: boolean;
  createCourt?: (data: CourtUpsertData & { name: string }) => Promise<CreateCourtResponse>;
  firmId?: string;
  disabled?: boolean;
}) {
  const [showQuickCreate, setShowQuickCreate] = useState(false);
  const [name, setName] = useState("");
  const [abbreviation, setAbbreviation] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [courtType, setCourtType] = useState("");
  const [address, setAddress] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options: DropdownOption[] = [
    { label: "None", value: "" },
    ...courts.map((c) => ({ label: formatCourtOptionLabel(c), value: c.id })),
  ];
  const handleQuickCreate = async () => {
    if (!name.trim() || !createCourt) return;
    setCreating(true);
    setError(null);
    try {
      const result = await createCourt({
        name: name.trim(),
        ...(abbreviation.trim() ? { abbreviation: abbreviation.trim() } : {}),
        ...(city.trim() ? { city: city.trim() } : {}),
        ...(state.trim() ? { state: state.trim() } : {}),
        ...(courtType.trim() ? { courtType: courtType.trim() } : {}),
        ...(address.trim() ? { address: address.trim() } : {}),
      });
      onChange(result.courtId);
      setShowQuickCreate(false);
      setName("");
      setAbbreviation("");
      setCity("");
      setState("");
      setCourtType("");
      setAddress("");
    } catch (e: any) {
      setError(e?.message || "Failed to create court");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="block text-sm font-medium text-on-surface">Court</label>
        {createCourt && <CourtDirectoryLink lawFirmId={firmId} />}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <Dropdown
            value={value}
            onChange={onChange}
            options={options}
            disabled={disabled}
            loading={loading}
            portal
            searchable
            searchPlaceholder="Search courts"
          />
        </div>
        {createCourt && <Tooltip title="Quick-create a court" enterDelay={300}>
          <button aria-label="Quick-create a court"
            type="button"
            onClick={() => setShowQuickCreate((prev) => !prev)}
            className="flex size-[38px] shrink-0 items-center justify-center rounded-lg border border-outline text-on-surface-secondary transition-[background-color,border-color,color,transform] hover:bg-surface-hover hover:text-on-surface active:scale-[0.96] motion-reduce:active:scale-100"
          >
            {showQuickCreate ? <X size={16} /> : <Plus size={16} />}
          </button>
        </Tooltip>}
      </div>
      {showQuickCreate && (
        <div className="mt-2 p-3 rounded-lg border border-outline bg-surface-alt space-y-2">
          <p className="text-xs font-medium text-on-surface">Quick Create Court</p>
          <FieldError message={error} className="mt-0" />
          <div className="flex items-center gap-2">
            <CourtNameAutocomplete
              value={name}
              onChange={setName}
              onSelect={(court) => {
                setName(court.fullName);
                setAbbreviation(court.citationAbbrev || court.shortName || "");
                setState(court.state || "");
                setCourtType(formatCourtCatalogValue(court.courtType));
              }}
              lawFirmId={firmId}
              className="flex-1 rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-2 py-1.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
            <input
              type="text"
              value={abbreviation}
              onChange={(e) => setAbbreviation(e.target.value)}
              placeholder="Abbreviation"
              maxLength={50}
              className="w-40 rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-2 py-1.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="City"
              className="w-32 flex-1 rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-2 py-1.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
            <input
              type="text"
              value={state}
              onChange={(e) => setState(e.target.value)}
              placeholder="State / Province"
              className="w-36 flex-1 rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-2 py-1.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
            <input
              type="text"
              value={courtType}
              onChange={(e) => setCourtType(e.target.value)}
              placeholder="Type (e.g. Federal, State)"
              className="w-44 flex-1 rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-2 py-1.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Address (optional)"
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
