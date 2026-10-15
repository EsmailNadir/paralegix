"use client";

// The Word-first template library: the library list plus its "New template"
// entry. New opens a small chooser: upload a Word document or fillable PDF
// (scan, review, commit), or start from scratch in the visual editor.

import { useId, useRef, useState, type ReactNode } from "react";
import { FilePlus, Sparkles, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import Modal from "@/components/ui/Modal";
import Spinner from "@/components/ui/Spinner";
import ErrorToast from "@/components/ui/ErrorToast";
import { useNavigation } from "@/contexts/NavigationContext";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import {
  ClientTextCheckError,
  wordTemplatesService,
} from "@/services/wordTemplates.service";
import type {
  BracketEdit,
  LeftoverClientText,
  TemplateFieldProposal,
} from "@/lib/wordTemplates/auto-bracket-types";
import type { WordTemplateFillDraft } from "@/types/wordTemplate";
import TemplateList from "./TemplateList";
import AutoBracketReview from "./AutoBracketReview";

/** A scanned upload waiting on the review: the stored object the commit rewrites. */
type PendingUpload = { fileName: string; objectPath: string };

export default function WordTemplatesLibrary({
  lawFirmId,
  versionToggle,
  initialFillTemplateId,
  initialFillDraft,
}: {
  lawFirmId: string;
  /** The switch between the three template versions, shown above the library. */
  versionToggle?: ReactNode;
  initialFillTemplateId?: string;
  initialFillDraft?: WordTemplateFillDraft;
}) {
  const { navigate } = useNavigation();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chooserTitleId = useId();
  const duplicateTitleId = useId();
  const [isPending, setIsPending] = useState(false);

  const [chooserOpen, setChooserOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<PendingUpload | null>(null);
  const [pendingEdits, setPendingEdits] = useState<BracketEdit[] | null>(null);
  const [proposals, setProposals] = useState<TemplateFieldProposal[] | null>(null);
  const [duplicate, setDuplicate] = useState<{ id: string; name: string } | null>(null);
  // Client details the server found still in plain text on the last save, and
  // the ones the reviewer chose to keep, carried into a duplicate re-run so
  // "Save as a copy" does not ask twice.
  const [leftovers, setLeftovers] = useState<LeftoverClientText[] | null>(null);
  const [pendingAcknowledged, setPendingAcknowledged] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const templatesBase = `/lawfirm/${lawFirmId}/templates`;

  const openChooser = () => {
    setError(null);
    setChooserOpen(true);
  };

  const chooseAdvanced = () => {
    setChooserOpen(false);
    navigate(`${templatesBase}/word/new`);
  };

  const resetPending = () => {
    setProposals(null);
    setPendingFile(null);
    setPendingEdits(null);
    setPendingAcknowledged([]);
    setLeftovers(null);
    setDuplicate(null);
  };

  // Commit the (possibly empty) accepted edits. On a same-name collision the
  // server answers with a `duplicate`: open the replace/copy/cancel chooser,
  // whose choice re-runs this with a strategy. When client details would stay
  // in plain text it refuses with the `leftovers`: the review shows them and
  // saving again means keeping exactly those.
  const commitWith = async (
    upload: PendingUpload,
    edits: BracketEdit[],
    { strategy, acknowledged = [] }: { strategy?: "copy" | "replace"; acknowledged?: string[] } = {},
  ) => {
    setError(null);
    setIsPending(true);
    try {
      const committed = await wordTemplatesService.commit(lawFirmId, {
        objectPath: upload.objectPath,
        fileName: upload.fileName,
        name: upload.fileName.replace(/\.[^.]+$/, "").slice(0, 200) || "Untitled",
        edits,
        ...(strategy ? { duplicateStrategy: strategy } : {}),
        ...(acknowledged.length > 0 ? { acknowledgedLeftovers: acknowledged } : {}),
      });
      if ("duplicate" in committed) {
        setPendingFile(upload);
        setPendingEdits(edits);
        setPendingAcknowledged(acknowledged);
        setDuplicate(committed.duplicate);
        return;
      }
      resetPending();
      setChooserOpen(false);
      queryClient.invalidateQueries({ queryKey: ["templates", lawFirmId] });
      navigate(`${templatesBase}/word/${committed.templateId}`);
    } catch (err) {
      if (err instanceof ClientTextCheckError && err.leftovers) {
        setDuplicate(null);
        setLeftovers(err.leftovers);
        return;
      }
      setError(getErrorMessage(err, "Failed to save template."));
    } finally {
      setIsPending(false);
    }
  };

  // One door for both formats: the server scans a .docx for form fields and
  // value-shaped spans, and a fillable PDF for its form fields, so staff do not
  // have to know which engine their document needs.
  const handleDocxPicked = async (file: File) => {
    setError(null);
    setIsPending(true);
    try {
      const detected = await wordTemplatesService.detect(lawFirmId, file);
      // Even with nothing found, the review opens: a template's text is printed
      // into every document made from it, so nobody gets to store one unseen.
      setPendingFile({ fileName: file.name, objectPath: detected.objectPath });
      setProposals(detected.proposals);
      setLeftovers(null);
      setChooserOpen(false);
    } catch (err) {
      setChooserOpen(false);
      setError(getErrorMessage(err, "Failed to scan the document."));
    } finally {
      setIsPending(false);
    }
  };

  const handleConfirmBrackets = (edits: BracketEdit[]) => {
    if (pendingFile) void commitWith(pendingFile, edits);
  };

  const handleSaveAnyway = (edits: BracketEdit[]) => {
    if (pendingFile && leftovers) {
      void commitWith(pendingFile, edits, { acknowledged: leftovers.map((l) => l.literal) });
    }
  };

  const resolveDuplicate = (strategy: "copy" | "replace") => {
    if (pendingFile && pendingEdits !== null) {
      void commitWith(pendingFile, pendingEdits, { strategy, acknowledged: pendingAcknowledged });
    }
  };

  const handleCancelReview = () => {
    resetPending();
    setError(null);
  };

  return (
    <>
      <div className="min-h-screen bg-page p-4 pl-5 md:p-6">
        <TemplateList
          lawFirmId={lawFirmId}
          versionToggle={versionToggle}
          converterEnabled
          onNewTemplate={openChooser}
          onEditTemplate={(templateId) => navigate(`${templatesBase}/word/${templateId}/edit`)}
          initialFillTemplateId={initialFillTemplateId}
          initialFillDraft={initialFillDraft}
        />
      </div>

      {/* Hidden input the chooser drives; picking a file starts the scan. */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".docx,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleDocxPicked(f);
          e.target.value = "";
        }}
        data-testid="new-template-docx-input"
      />

      <Modal
        isOpen={chooserOpen}
        onClose={() => setChooserOpen(false)}
        dismissible={!isPending}
        showClose={false}
        labelledBy={chooserTitleId}
        size="md"
        className="border-2 border-outline"
        bodyClassName={null}
      >
        <div data-testid="new-template-chooser">
          <div className="flex items-center justify-between border-b border-outline px-6 py-4">
            <h2 id={chooserTitleId} className="text-base font-semibold text-on-surface">New template</h2>
            <button
              type="button"
              onClick={() => setChooserOpen(false)}
              disabled={isPending}
              className="inline-flex size-8 items-center justify-center rounded-lg text-on-surface-muted transition-colors hover:text-on-surface disabled:opacity-50"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
          <div className="space-y-2 px-6 py-5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isPending}
              className="flex w-full items-start gap-3 rounded-lg border border-outline-subtle bg-surface-alt p-3 text-left transition-colors hover:bg-surface-hover disabled:opacity-60"
              data-testid="chooser-upload-docx"
            >
              {isPending ? (
                <Spinner size={18} className="mt-0.5 text-accent-emphasis" />
              ) : (
                <Sparkles size={18} className="mt-0.5 shrink-0 text-accent-emphasis" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium text-on-surface">
                  Upload a Word document or fillable PDF
                </p>
                <p className="text-xs text-on-surface-muted">
                  {isPending
                    ? "Scanning for fields…"
                    : "Keeps the original formatting exactly. Finds the fill-in blanks for you to name."}
                </p>
              </div>
            </button>
            <button
              type="button"
              onClick={chooseAdvanced}
              disabled={isPending}
              className="flex w-full items-start gap-3 rounded-lg border border-outline-subtle bg-surface-alt p-3 text-left transition-colors hover:bg-surface-hover disabled:opacity-60"
              data-testid="chooser-advanced"
            >
              <FilePlus size={18} className="mt-0.5 shrink-0 text-accent-emphasis" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-on-surface">Start in the editor</p>
                <p className="text-xs text-on-surface-muted">
                  Author visually from scratch. Importing here rebuilds the layout, so
                  formatting can shift: best for simple documents.
                </p>
              </div>
            </button>
          </div>
        </div>
      </Modal>

      {/* Unmount the review while the duplicate chooser is stacked on top, so
          its controls aren't keyboard-reachable behind the overlay (cancel from
          the chooser resets everything, so there's nothing to return to). */}
      {proposals && pendingFile && !duplicate && (
        <AutoBracketReview
          key={pendingFile.objectPath}
          open
          fileName={pendingFile.fileName}
          proposals={proposals}
          submitting={isPending}
          error={error}
          leftovers={leftovers}
          onCancel={handleCancelReview}
          onConfirm={handleConfirmBrackets}
          onSaveAnyway={handleSaveAnyway}
        />
      )}

      <Modal
        isOpen={Boolean(duplicate)}
        onClose={handleCancelReview}
        dismissible={!isPending}
        showClose={false}
        labelledBy={duplicateTitleId}
        size="md"
        className="border-2 border-outline"
        bodyClassName={null}
      >
        <div data-testid="duplicate-chooser">
          <div className="border-b border-outline px-6 py-4">
            <h2 id={duplicateTitleId} className="text-base font-semibold text-on-surface">Template already exists</h2>
            <p className="mt-0.5 text-xs text-on-surface-muted">
              A template named “{duplicate?.name}” already exists.
            </p>
          </div>
          <div className="space-y-2 px-6 py-5">
            <button
              type="button"
              onClick={() => resolveDuplicate("copy")}
              disabled={isPending}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-outline-subtle bg-surface-alt px-3 py-2 text-left text-sm font-medium text-on-surface transition-colors hover:bg-surface-hover disabled:opacity-60"
              data-testid="duplicate-copy"
            >
              {isPending && <Spinner size={15} className="text-accent-emphasis" />}
              Save as a copy
              <span className="ml-auto text-xs font-normal text-on-surface-muted">“{duplicate?.name} (copy)”</span>
            </button>
            <button
              type="button"
              onClick={() => resolveDuplicate("replace")}
              disabled={isPending}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-outline-subtle bg-surface-alt px-3 py-2 text-left text-sm font-medium text-on-surface transition-colors hover:bg-surface-hover disabled:opacity-60"
              data-testid="duplicate-replace"
            >
              Replace the existing template
              <span className="ml-auto text-xs font-normal text-on-surface-muted">overwrites its source</span>
            </button>
          </div>
          <div className="flex items-center justify-between gap-2 rounded-b-xl border-t border-outline bg-surface-alt px-6 py-4">
            {error && <span className="max-w-[60%] truncate text-xs text-red-600 dark:text-red-400">{error}</span>}
            <button
              type="button"
              onClick={handleCancelReview}
              disabled={isPending}
              className="ml-auto inline-flex h-8 items-center justify-center rounded-lg px-3 text-sm font-medium text-on-surface-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
              data-testid="duplicate-cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>

      {error && !proposals && !duplicate && !chooserOpen && (
        <ErrorToast message={error} onDismiss={() => setError(null)} />
      )}
    </>
  );
}
