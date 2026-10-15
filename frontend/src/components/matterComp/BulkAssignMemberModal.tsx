"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { STATUS_VARIANTS } from "@/constants/statusMeta";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import Spinner from "@/components/ui/Spinner";
import Modal from "@/components/ui/Modal";
import type { User } from "@/types";
import MattersService from "@/services/matters.service";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";

interface Props {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  selectedMatterIds: string[];
  users: User[];
  onAfter?: () => Promise<void>;
}

export default function BulkAssignMemberModal({ open, onClose, lawFirmId, selectedMatterIds, users, onAfter }: Props) {
  const [selectedUserId, setSelectedUserId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ added: string[]; alreadyAssigned: string[]; failed: { matterId: string; error: string }[] } | null>(null);
  // How many of the selected matters this member would actually join, fetched
  // per selection so matters they're already on don't inflate the count.
  // `toAdd: null` means the preview call failed; the copy then falls back to
  // the full selection count rather than spinning forever.
  const [preview, setPreview] = useState<{ userId: string; toAdd: number | null } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const handleClose = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  const userOptions = useMemo(
    () => [
      { value: "", label: "Select a team member" },
      ...users.map((u) => ({ value: u.uid, label: u.name || u.email || u.uid })),
    ],
    [users]
  );

  const selectedUser = users.find((u) => u.uid === selectedUserId);

  // Reset on open so the close animation can replay the current screen
  // without the result view flipping back to the form mid-exit.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset modal state when it opens
      setSelectedUserId("");
      setResult(null);
      setSubmitting(false);
      setPreview(null);
      setPreviewLoading(false);
    }
  }, [open]);

  // Fetch how many of the selected matters this member would actually join.
  // Scoped to the open dialog and the current selection so a fast switch
  // between members can't apply a stale count to the wrong one.
  useEffect(() => {
    if (!open || !selectedUserId || selectedMatterIds.length === 0) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: loading/result state is set as the request progresses
    setPreviewLoading(true);
    MattersService.previewBulkAddMember({ lawFirmId, userId: selectedUserId, matterIds: selectedMatterIds })
      .then((res) => {
        if (cancelled) return;
        setPreview({ userId: selectedUserId, toAdd: res.toAdd.length });
      })
      .catch(() => {
        // Preview is advisory; on failure fall back to the full selection
        // count instead of leaving the loading state stuck. Submit still
        // resolves the real scope and reports the real outcome.
        if (!cancelled) setPreview({ userId: selectedUserId, toAdd: null });
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, lawFirmId, selectedUserId, selectedMatterIds]);

  const handleSubmit = async () => {
    if (!selectedUserId || selectedMatterIds.length === 0) return;
    setSubmitting(true);
    try {
      const res = await MattersService.bulkAddMember({
        lawFirmId,
        userId: selectedUserId,
        matterIds: selectedMatterIds,
      });
      setResult(res);
      if (onAfter) await onAfter();
    } catch (err) {
      setResult({ added: [], alreadyAssigned: [], failed: [{ matterId: "all", error: getErrorMessage(err, "Failed to assign the member") }] });
    } finally {
      setSubmitting(false);
    }
  };

  const totalFailed = result?.failed.length ?? 0;
  // Why the refused matters were refused: a count alone gives the firm nothing
  // to act on.
  const failureReasons = Array.from(new Set((result?.failed ?? []).map((f) => f.error).filter(Boolean)));

  return (
    <Modal
      isOpen={open}
      onClose={handleClose}
      title={result ? "Assignment Complete" : "Assign Member to Matters"}
      closeIcon={<X size={18} />}
      dismissible={!submitting}
      size="lg"
      footer={
        result ? (
          <Button type="primary" onClick={handleClose}>
            Done
          </Button>
        ) : (
          <>
            <Button type="secondary" onClick={handleClose} disabled={submitting}>
              Cancel
            </Button>
            <Button
              type="primary"
              onClick={handleSubmit}
              loading={submitting}
              disabled={submitting || !selectedUserId}
            >
              {submitting ? "Assigning..." : "Assign"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <>
          {result.added.length > 0 && (
            <div className="flex items-start gap-2">
              <CheckCircle2 size={20} className={`${STATUS_VARIANTS.success.text} mt-0.5 flex-shrink-0`} aria-hidden="true" />
              <p className="text-sm text-on-surface-secondary">
                Added to <span className="font-semibold">{result.added.length}</span> matter{result.added.length !== 1 ? "s" : ""}
              </p>
            </div>
          )}
          {result.alreadyAssigned.length > 0 && (
            <div className="flex items-start gap-2">
              <Info size={20} className="text-accent-emphasis mt-0.5 flex-shrink-0" aria-hidden="true" />
              <p className="text-sm text-on-surface-secondary">
                <span className="font-semibold">{result.alreadyAssigned.length}</span> already assigned
              </p>
            </div>
          )}
          {totalFailed > 0 && (
            <div className="flex items-start gap-2">
              <AlertCircle size={20} className={`${STATUS_VARIANTS.danger.text} mt-0.5 flex-shrink-0`} aria-hidden="true" />
              <p className="text-sm text-on-surface-secondary">
                <span className="font-semibold">{totalFailed}</span> failed
              </p>
            </div>
          )}
          <ErrorNotification error={failureReasons.length ? failureReasons.join(" ") : null} compact />

        </>
      ) : (
        <>
          <p className="text-sm text-on-surface-secondary">
            Assign a team member to the <span className="font-semibold text-on-surface">{selectedMatterIds.length}</span> selected matter{selectedMatterIds.length !== 1 ? "s" : ""}.
          </p>

          <Dropdown
            label="Team Member"
            value={selectedUserId}
            onChange={(v) => setSelectedUserId(v)}
            options={userOptions}
            portal
          />

          {selectedUserId && selectedUser && (
            <p className="text-sm text-on-surface-muted">
              {previewLoading || preview?.userId !== selectedUserId ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner size={13} /> Checking current matters...
                </span>
              ) : (
                <>
                  <span className="font-medium text-on-surface">{selectedUser.name || selectedUser.email}</span> will be added to {preview.toAdd ?? selectedMatterIds.length} matter{(preview.toAdd ?? selectedMatterIds.length) !== 1 ? "s" : ""}. Matters where they are already assigned will be skipped.
                </>
              )}
            </p>
          )}

        </>
      )}
    </Modal>
  );
}
