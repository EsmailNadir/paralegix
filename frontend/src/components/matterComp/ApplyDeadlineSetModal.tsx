"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, ArrowRight } from "lucide-react";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import DatePicker from "@/components/ui/DatePicker";
import ErrorNotification from "@/components/ErrorNotification";
import Modal from "@/components/ui/Modal";
import ListEmptyState from "@/components/ui/ListEmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { formatDateOnly } from "@/lib/utils/dateUtils";
import deadlineSetsService from "@/services/deadlineSets.service";
import type { DeadlineSet } from "@/types/deadlineSet";
import { matterEventTypeMeta } from "@/constants/statusMeta";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import FieldLabel from "@/components/ui/FieldLabel";

interface Props {
  open: boolean;
  lawFirmId: string;
  matterId: string;
  onClose: () => void;
  onApplied: (message: string) => void;
}

// Mirrors the backend date math: plain-calendar-day offset in UTC, optional
// weekend roll-forward to Monday. Returns 'YYYY-MM-DD'.
function computeDeadlineDate(anchorYmd: string, offsetDays: number, direction: "before" | "after", adjustWeekends: boolean): string {
  const [y, m, d] = anchorYmd.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const delta = direction === "before" ? -offsetDays : offsetDays;
  base.setUTCDate(base.getUTCDate() + delta);
  if (adjustWeekends) {
    const dow = base.getUTCDay();
    if (dow === 6) base.setUTCDate(base.getUTCDate() + 2);
    else if (dow === 0) base.setUTCDate(base.getUTCDate() + 1);
  }
  const yy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(base.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export default function ApplyDeadlineSetModal({ open, lawFirmId, matterId, onClose, onApplied }: Props) {
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const canManageSets = hasPermission("settings.manageFirm");

  const goToSettings = () => {
    onClose();
    navigate(`/lawfirm/${lawFirmId}/settings/matter-config?tab=deadlineSets`);
  };

  const [sets, setSets] = useState<DeadlineSet[]>([]);
  const [loadingSets, setLoadingSets] = useState(false);
  const [setsLoaded, setSetsLoaded] = useState(false);
  useResetAfterClose(open, () => setSetsLoaded(false));
  const [selectedId, setSelectedId] = useState("");
  const [anchorDate, setAnchorDate] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSets = useCallback(async () => {
    setLoadingSets(true);
    setError(null);
    try {
      const res = await deadlineSetsService.list(lawFirmId);
      setSets(res.deadlineSets || []);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoadingSets(false);
      setSetsLoaded(true);
    }
  }, [lawFirmId]);

  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- reset selection and fetch sets when the modal opens */
    setSelectedId("");
    setAnchorDate("");
    setError(null);
    loadSets();
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, loadSets]);

  const selected = useMemo(() => sets.find((s) => s.id === selectedId) || null, [sets, selectedId]);

  const preview = useMemo(() => {
    if (!selected || !anchorDate) return [];
    const ymd = anchorDate.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return [];
    let previousYmd = ymd;
    return selected.items.map((it) => {
      const base = it.relativeTo === "previous" ? previousYmd : ymd;
      const date = computeDeadlineDate(base, Number(it.offsetDays) || 0, it.offsetDirection, selected.adjustForWeekends);
      previousYmd = date;
      return { ...it, date };
    });
  }, [selected, anchorDate]);

  const handleApply = async () => {
    if (!selected || !anchorDate) return;
    setApplying(true);
    setError(null);
    try {
      const res = await deadlineSetsService.apply(lawFirmId, matterId, selected.id, anchorDate);
      onApplied(res.message);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Apply a deadline set"
      icon={<CalendarClock size={18} className="text-accent-emphasis" />}
      dismissible={!applying}
      size="lg"
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={applying}>
            Cancel
          </Button>
          <Button
            type="primary"
            onClick={handleApply}
            loading={applying}
            disabled={applying || !selected || !anchorDate}
          >
            Create {preview.length > 0 ? preview.length : ""} {preview.length === 1 ? "event" : "events"}
          </Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} />

      {loadingSets || !setsLoaded ? (
        <ListSkeleton rows={3} label="Loading deadline sets" />
      ) : sets.length === 0 ? (
        <ListEmptyState
          compact
          title="No deadline sets yet"
          message={
            <>
              An admin can create them in{" "}
              <button
                type="button"
                onClick={goToSettings}
                className="font-medium text-accent-emphasis hover:text-accent-emphasis hover:underline cursor-pointer"
              >
                Settings → Matter Config → Deadline Sets
              </button>
              .
            </>
          }
        />
      ) : (
        <>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm font-medium text-on-surface">Deadline set</label>
              {canManageSets && (
                <button
                  type="button"
                  onClick={goToSettings}
                  className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis hover:underline cursor-pointer"
                >
                  Manage sets
                </button>
              )}
            </div>
            <Dropdown
              value={selectedId}
              onChange={setSelectedId}
              options={sets.map((s) => ({ label: s.name, value: s.id }))}
              placeholder="Choose a set"
              portal
            />
          </div>

          <div>
            <FieldLabel>Trigger date</FieldLabel>
            <DatePicker value={anchorDate} onChange={setAnchorDate} />
            <p className="mt-1 text-xs text-on-surface-muted">
              Each deadline is calculated from this date, or from the deadline before it.
            </p>
          </div>

          {selected && anchorDate && preview.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-medium text-on-surface">
                This will create {preview.length} {preview.length === 1 ? "event" : "events"}
              </p>
              <ul className="rounded-lg border border-outline divide-y divide-outline-subtle overflow-hidden">
                {preview.map((it, i) => (
                  <li key={i} className="flex items-center gap-2 px-3 py-2 text-sm bg-surface-alt/40">
                    <ArrowRight size={13} className="text-on-surface-muted shrink-0" />
                    <span className="text-on-surface truncate">{it.title}</span>
                    <span className="text-[11px] rounded-full bg-surface border border-outline-subtle px-2 py-0.5 text-on-surface-secondary shrink-0">
                      {matterEventTypeMeta(it.type).label}
                    </span>
                    <span className="ml-auto text-xs text-on-surface-secondary shrink-0">{formatDateOnly(it.date)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
