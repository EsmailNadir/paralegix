"use client";

import { useState } from "react";
import { StickyNote } from "lucide-react";
import Button from "@/components/ui/Button";
import ErrorNotification from "@/components/ErrorNotification";
import Modal from "@/components/ui/Modal";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import useSeedOnOpen from "@/hooks/useSeedOnOpen";
import leadsService from "@/services/leads.service";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import type { Lead } from "@/types";

type Props = {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  lead: Lead;
  onAfter?: () => Promise<void> | void;
};

export default function QuickAddLeadNoteModal({ open, onClose, lawFirmId, lead, onAfter }: Props) {
  const [notes, setNotes] = useState(lead.notes || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill from the lead as it is when the dialog opens. The dialog is mounted
  // closed on the lead page, and saving replaces the whole notes field, so a
  // copy taken at mount would write older text over a later edit.
  useSeedOnOpen(open, () => {
    setNotes(lead.notes || "");
  }, lead.id);

  useResetAfterClose(open, () => {
    setError(null);
    setSaving(false);
  });

  const handleSubmit = async () => {
    try {
      setSaving(true);
      setError(null);
      await leadsService.updateLead(lawFirmId, lead.id, { notes: notes.trim() || null });
      await onAfter?.();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err) || "Failed to save note");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      dismissible={!saving}
      size="lg"
      className="relative"
      title="Add note"
      icon={<StickyNote size={18} />}
      subtitle={`Add an internal note to ${lead.name || "this lead"}.`}
      showClose={false}
      bodyClassName="px-6 py-4 space-y-3 overflow-y-auto overflow-x-hidden styled-scrollbar"
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="primary" onClick={handleSubmit} loading={saving} disabled={saving}>
            Save note
          </Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} />
      <label htmlFor="quick-lead-note" className="block text-sm font-medium text-on-surface">
        Note
      </label>
      <textarea
        id="quick-lead-note"
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        className="w-full min-h-[140px] resize-y rounded-lg border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        placeholder="Write an internal note"
        autoFocus
      />
    </Modal>
  );
}
