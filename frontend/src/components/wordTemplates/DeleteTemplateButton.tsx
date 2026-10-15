"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Spinner from "@/components/ui/Spinner";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { wordTemplatesService } from "@/services/wordTemplates.service";

/** Deletes one Word-first template after a confirm, then hands control back. */
export default function DeleteTemplateButton({
  lawFirmId,
  templateId,
  name,
  onDeleted,
}: {
  lawFirmId: string;
  templateId: string;
  name: string;
  onDeleted: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const submit = async () => {
    setError(null);
    setIsPending(true);
    try {
      await wordTemplatesService.delete(lawFirmId, templateId);
      setConfirmOpen(false);
      onDeleted();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete template."));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={isPending}
        className="inline-flex h-8 items-center gap-2 w-full rounded-lg px-3 text-sm font-medium bg-red-50 dark:bg-red-950/20 hover:bg-red-600/20 text-red-600 dark:text-red-400 transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
        data-testid="delete-template-button"
      >
        {isPending ? <Spinner size={14} /> : <Trash2 size={14} strokeWidth={2} />}
        Delete template
      </button>
      <ConfirmModal
        isOpen={confirmOpen}
        title="Delete template"
        message={`Are you sure you want to delete "${name}"? This cannot be undone.`}
        confirmText="Delete"
        confirmType="danger"
        loading={isPending}
        error={error}
        onConfirm={() => void submit()}
        onClose={() => setConfirmOpen(false)}
      />
    </>
  );
}
