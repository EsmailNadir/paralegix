import { useEffect, useId, useRef, useState } from "react";
import { formatCourtAddress } from "@/types/court";
import FieldLabel from "@/components/ui/FieldLabel";
import TextInput from "@/components/ui/TextInput";

type SimpleCourt = { id: string; name: string; address?: string | null; city?: string | null; state?: string | null };

/**
 * Free-text task location. Autofills from the selected court's address when
 * the field is still empty, and offers to save a manually typed location back
 * onto the court record once it diverges from that court's stored address.
 */
export default function TaskLocationField({
  location,
  setLocation,
  courtId,
  courts,
  canLinkToCourt = false,
  updateCourtAddress,
}: {
  location: string;
  setLocation: (v: string) => void;
  courtId: string;
  courts: SimpleCourt[];
  canLinkToCourt?: boolean;
  updateCourtAddress?: (courtId: string, address: string) => Promise<unknown>;
}) {
  const fieldIds = useId();
  const selectedCourt = courtId ? courts.find((c) => c.id === courtId) ?? null : null;
  const courtAddress = formatCourtAddress(selectedCourt);
  const prevCourtIdRef = useRef(courtId);
  const [editedByUser, setEditedByUser] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (courtId === prevCourtIdRef.current) return;
    prevCourtIdRef.current = courtId;
    setSaved(false);
    if (courtId && courtAddress && !location.trim()) {
      setLocation(courtAddress);
    }
    // Only react to an actual court change, not to every location keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courtId]);

  const showLinkPrompt =
    editedByUser &&
    !saved &&
    !!selectedCourt &&
    canLinkToCourt &&
    !!updateCourtAddress &&
    location.trim() !== "" &&
    location.trim() !== courtAddress.trim();

  const handleLink = async () => {
    if (!selectedCourt || !updateCourtAddress) return;
    setSaving(true);
    try {
      await updateCourtAddress(selectedCourt.id, location.trim());
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <FieldLabel htmlFor={`${fieldIds}-location`}>Location</FieldLabel>
      <TextInput
        id={`${fieldIds}-location`}
        value={location}
        onChange={(e) => {
          setEditedByUser(true);
          setSaved(false);
          setLocation(e.target.value);
        }}
        placeholder="e.g. Conference Room A, 123 Main St"
        maxLength={500}
      />
      {showLinkPrompt && (
        <p className="mt-1.5 text-xs text-on-surface-secondary">
          Save this as {selectedCourt!.name}&apos;s address?{" "}
          <button
            type="button"
            onClick={handleLink}
            disabled={saving}
            className="text-accent-emphasis hover:underline disabled:opacity-60"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </p>
      )}
    </div>
  );
}
