"use client";

import { useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import Spinner from "@/components/ui/Spinner";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { ClientTextCheckError, wordTemplatesService } from "@/services/wordTemplates.service";
import type { LeftoverClientText } from "@/lib/wordTemplates/auto-bracket-types";
import { LeftoverClientTextDialog } from "./LeftoverClientText";

/** Replaces a Word template's stored .docx in place, asking first if it still names a client. */
export default function ReplaceDocxButton({
  lawFirmId,
  templateId,
  onReplaced,
}: {
  lawFirmId: string;
  templateId: string;
  onReplaced: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  // A replacement the server held back because it still names a client: kept
  // so Save anyway can resend the same file with those values acknowledged.
  const [held, setHeld] = useState<{ file: File; leftovers: LeftoverClientText[] } | null>(null);
  const [isPending, setIsPending] = useState(false);

  const handleFile = async (file: File, acknowledged?: string[]) => {
    setError(null);
    setIsPending(true);
    try {
      await wordTemplatesService.replaceDocx(lawFirmId, templateId, file, acknowledged);
      setHeld(null);
      onReplaced();
    } catch (err) {
      if (err instanceof ClientTextCheckError && err.leftovers) setHeld({ file, leftovers: err.leftovers });
      else setError(getErrorMessage(err, "Failed to replace the document."));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={isPending}
        className="inline-flex h-8 items-center gap-2 w-full rounded-lg px-3 text-sm font-medium bg-accent-soft hover:bg-accent-soft text-accent-emphasis transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
        data-testid="replace-docx-button"
      >
        {isPending ? <Spinner size={14} /> : <RotateCw size={14} strokeWidth={2} />}
        {isPending ? "Uploading…" : "Re-upload .docx"}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = "";
        }}
        data-testid="replace-docx-input"
      />
      {error && !held && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400 mt-1" data-testid="replace-docx-error">
          {error}
        </p>
      )}
      <LeftoverClientTextDialog
        leftovers={held?.leftovers ?? null}
        pending={isPending}
        error={held ? error : null}
        onConfirm={() => {
          if (held) void handleFile(held.file, held.leftovers.map((l) => l.literal));
        }}
        onCancel={() => {
          setHeld(null);
          setError(null);
        }}
      />
    </>
  );
}
