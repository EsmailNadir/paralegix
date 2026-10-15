"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import TemplateEditor from "@/components/templatesComp/TemplateEditor";
import TemplateOverlayEditor from "@/components/templatesComp/TemplateOverlayEditor";
import TemplatesWorkspace, {
  type TemplatesTab,
} from "@/components/templatesComp/TemplatesWorkspace";
import TemplateVersionToggle from "@/components/templatesComp/TemplateVersionToggle";
import WordTemplatesLibrary from "@/components/wordTemplates/WordTemplatesLibrary";
import { usePreferences } from "@/contexts/PreferencesContext";
import LoadingSpinner from "@/components/LoadingSpinner";
import ConfirmModal from "@/components/ui/ConfirmModal";
import RequireFeature from "@/components/ui/RequireFeature";
import { templatesService } from "@/services/templates.service";
import type { TemplateFillDraft } from "@/types/template";

/** Which view of the library the workspace is showing. */
interface LibraryView {
  tab?: TemplatesTab;
  folderId?: string | null;
}

type View =
  | ({ mode: "list" } & LibraryView)
  | ({
      mode: "list-fill";
      templateId: string;
      fillDraft?: TemplateFillDraft;
    } & LibraryView)
  | {
      mode: "new";
      folderId?: string | null;
      /** True when this editor was reached by "Use the full editor instead"
       *  from an unsaved overlay draft one history entry down. False when the
       *  Full editor version sent a picked document straight here. */
      fromOverlay: boolean;
    }
  | { mode: "edit"; templateId: string; fillDraft?: TemplateFillDraft }
  | {
      mode: "overlay";
      templateId: string;
      folderId: string | null;
      /** True only for the template just created by this session's upload,
       *  before anything has been saved to it, the one case "Use the full
       *  editor instead" is offered from. */
      isNew: boolean;
    };

// Shape stored on a history entry while the template editor is open, so
// Back/Forward can close and reopen the editor. Kept JSON-serializable
// because history state is structured-cloned.
type EditorHistoryState =
  | { mode: "new"; folderId: string | null; fromOverlay: boolean }
  | { mode: "edit"; templateId: string; fillDraft?: TemplateFillDraft | null }
  | { mode: "overlay"; templateId: string; folderId: string | null; isNew: boolean };

/** The library view recorded on a history entry, as the workspace writes it. */
function libraryViewFromHistoryState(state: unknown): LibraryView {
  const entry = (state ?? {}) as {
    templatesTab?: string;
    templatesFolderId?: string | null;
  };

  return {
    tab: entry.templatesTab === "all" ? "all" : "folders",
    folderId: entry.templatesFolderId ?? null,
  };
}

export default function TemplatesPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const lawFirmId =
    (Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : params?.lawFirmId) || "";

  if (!lawFirmId) return null;

  return (
    <RequireFeature feature="templates">
      <TemplatesVersionHost
        lawFirmId={lawFirmId}
        initialTab={searchParams.get("tab") === "all" ? "all" : "folders"}
        initialFolderId={searchParams.get("folder")}
        wordFillTemplateId={searchParams.get("fill")}
        wordFillMatterId={searchParams.get("matterId")}
      />
    </RequireFeature>
  );
}

/**
 * Chooses between the three template experiences by the person's saved
 * choice. Overlay and Full editor share the Paralegix library and differ only
 * in where a picked document goes; Word-first is its own library. A Word-first
 * fill link (`?fill=`) opens the Word-first library whatever the choice, since
 * the template it names lives there.
 */
function TemplatesVersionHost({
  lawFirmId,
  initialTab,
  initialFolderId,
  wordFillTemplateId,
  wordFillMatterId,
}: {
  lawFirmId: string;
  initialTab: TemplatesTab;
  initialFolderId: string | null;
  wordFillTemplateId: string | null;
  wordFillMatterId: string | null;
}) {
  const { templateVersion, updateTemplateVersion } = usePreferences();
  const versionToggle = (
    <TemplateVersionToggle
      value={templateVersion}
      onChange={(next) => {
        // A refused save already put the previous version back on screen.
        updateTemplateVersion(next).catch(() => {});
      }}
    />
  );

  if (templateVersion === "word-first" || wordFillTemplateId) {
    return (
      <WordTemplatesLibrary
        lawFirmId={lawFirmId}
        versionToggle={versionToggle}
        initialFillTemplateId={wordFillTemplateId ?? undefined}
        initialFillDraft={wordFillMatterId ? { selectedCaseId: wordFillMatterId } : undefined}
      />
    );
  }

  return (
    <TemplatesPageContent
      lawFirmId={lawFirmId}
      initialTab={initialTab}
      initialFolderId={initialFolderId}
      createMode={templateVersion}
      versionToggle={versionToggle}
    />
  );
}

function TemplatesPageContent({
  lawFirmId,
  initialTab,
  initialFolderId,
  createMode,
  versionToggle,
}: {
  lawFirmId: string;
  initialTab: TemplatesTab;
  initialFolderId: string | null;
  /** Where a picked document goes: an overlay draft, or straight to the full editor. */
  createMode: "overlay" | "full-editor";
  versionToggle: React.ReactNode;
}) {
  const [view, setView] = useState<View>({ mode: "list" });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [transitioning, setTransitioning] = useState(false);
  const queryClient = useQueryClient();
  // Set just before a programmatic history.back() so the popstate handler
  // skips that one event instead of overriding the view the caller already set.
  const suppressNextPopRef = useRef(false);
  // The document picked on the library's create panel, handed to the editor so it
  // opens already converting it. A File cannot live on a history entry, so a Back
  // then Forward through the editor lands on its own upload step instead.
  const pendingFileRef = useRef<File | null>(null);
  // The same file, kept around after a Document Overlay upload so "Use the full
  // editor instead" can hand it to TemplateEditor without asking the user to pick
  // it again. Cleared whenever the overlay editor is left (saved or backed out of)
  // or reopened on an already-existing template, so it can never leak onto the
  // wrong template the way a stale `pendingFileRef` couldn't either.
  const overlaySourceFileRef = useRef<File | null>(null);
  // Whether the overlay template currently open has been saved at least once
  // in this session. Direct-upload finalization creates the `templates` row immediately
  // (the editor needs a real PDF to render), unlike html/docx which stage
  // everything in memory until Save, so a fresh overlay upload the user
  // abandons without saving leaves an empty row behind unless it's cleaned
  // up. This flag is what stops that cleanup from firing on the *successful*
  // path too: `handleSaved` sets it before navigating away, and the moment it
  // is true, `leaveOverlayDraft` never deletes the template it guards.
  const overlaySavedRef = useRef(false);
  // Track draft deletions to prevent duplicate API delete requests when React
  // lifecycle or navigation events fire concurrently.
  const deletedDraftIdsRef = useRef<Set<string>>(new Set());
  // Set only while a "new"-mode full editor is open because the user chose
  // "Use the full editor instead" from a still-unsaved overlay draft one
  // history entry down (the entry is kept, not replaced, so the browser's
  // own Back returns to it). If the full editor gets saved instead, that
  // overlay draft is now an abandoned duplicate of the same source file:
  // `handleSaved` deletes it and skips the return trip past its entry,
  // straight to the library. Left alone (Back out of the full editor
  // instead), the overlay entry's own existing cleanup handles it.
  const bailedOverlayDraftIdRef = useRef<string | null>(null);

  // Unsaved work in the editor, as the editor reports it. Mirrored into a ref
  // for the popstate listener, which is registered once and would otherwise
  // close over the initial value.
  const [editorDirty, setEditorDirty] = useState(false);
  const editorDirtyRef = useRef(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // The editor entry as it was pushed, so an intercepted Back can put it back.
  const editorHistoryStateRef = useRef<EditorHistoryState | null>(null);
  // Which navigation a pending discard-confirmation should complete: fully
  // leaving (generic Back) or returning to the overlay draft this full-editor
  // session was reached from ("Back to Document Overlay"). Only meaningful
  // while confirmDiscard is open.
  const backTargetRef = useRef<"leave" | "overlay">("leave");

  // Stable identity: this is handed to the editors as `onDirtyChange`, and a
  // fresh function every render would re-run any effect of theirs that lists
  // it as a dependency.
  const setDirty = useCallback((dirty: boolean) => {
    editorDirtyRef.current = dirty;
    setEditorDirty(dirty);
  }, []);

  // Opening the editor pushes its own entry on top of wherever it was opened
  // from (a folder, the flat library, or the fill modal), so the browser Back
  // button closes the editor and returns there.
  const viewFromEditorState = (editor: EditorHistoryState): View =>
    editor.mode === "new"
      ? { mode: "new", folderId: editor.folderId, fromOverlay: editor.fromOverlay }
      : editor.mode === "overlay"
        ? { mode: "overlay", templateId: editor.templateId, folderId: editor.folderId, isNew: editor.isNew }
        : {
            mode: "edit",
            templateId: editor.templateId,
            fillDraft: editor.fillDraft ?? undefined,
          };

  const openEditor = (editor: EditorHistoryState) => {
    setTransitioning(true);
    editorHistoryStateRef.current = editor;
    window.history.pushState(
      { ...window.history.state, templatesEditor: editor },
      ""
    );
    setView(viewFromEditorState(editor));
  };

  // Cleans up after leaving a Document Overlay editor, by whichever path:
  // "Use the full editor instead", the in-app Back button, or the browser's
  // own Back button/gesture. The source file staged for the full-editor bail
  // is single-use either way, and a template row created by this session's
  // upload but never actually saved would otherwise sit in the library
  // forever as an empty "Overlay" entry, since direct-upload finalization creates it
  // immediately instead of staging it in memory the way html/docx do.
  // `overlaySavedRef` is what keeps this from deleting a template the user
  // just successfully saved: `handleSaved` sets it before navigating away,
  // and by the time this fires (on that same trip back to the library) it is
  // already true.
  const leaveOverlayDraft = useCallback(
    (overlayView: { templateId: string; isNew: boolean }) => {
      overlaySourceFileRef.current = null;
      if (!overlayView.isNew || overlaySavedRef.current) return;
      if (deletedDraftIdsRef.current.has(overlayView.templateId)) return;
      deletedDraftIdsRef.current.add(overlayView.templateId);

      // Best-effort: a failed delete here isn't worth blocking navigation
      // over, since the user is already leaving this template behind.
      templatesService.delete(lawFirmId, overlayView.templateId).catch((err: unknown) => {
        const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { status?: number; statusCode?: number })?.statusCode;
        if (status === 404) return;
        console.warn("Failed to delete unsaved Document Overlay template draft:", err);
      });
      queryClient.invalidateQueries({ queryKey: ["templates", lawFirmId] });
    },
    [lawFirmId, queryClient]
  );

  // Bails out of a just-uploaded overlay template into the existing full-editor
  // creation path, with the same file. This is a pure navigation choice per the
  // design: nothing overlay-specific has been saved yet, so the draft is kept
  // alive (not deleted) and its history entry kept (not replaced), so Back from
  // the full editor reopens the overlay editor on the same draft. That editor
  // remounts and reloads the draft from the server, so boxes placed but never
  // saved before switching are gone; its switch confirmation warns about that.
  const handleUseFullEditorFromOverlay = () => {
    if (view.mode !== "overlay") return;
    const { templateId, folderId } = view;
    const file = overlaySourceFileRef.current;

    bailedOverlayDraftIdRef.current = templateId;
    pendingFileRef.current = file;
    openEditor({ mode: "new", folderId, fromOverlay: true });
  };

  // The Full editor version: a picked document opens the full editor directly,
  // importing it as HTML (or as a DOCX merge-field template) with no overlay
  // draft behind it.
  const handleDocumentPicked = ({ file, folderId }: { file: File; folderId: string | null }) => {
    bailedOverlayDraftIdRef.current = null;
    pendingFileRef.current = file;
    openEditor({ mode: "new", folderId, fromOverlay: false });
  };

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (suppressNextPopRef.current) {
        suppressNextPopRef.current = false;
        return;
      }

      // Forward navigation onto an editor entry reopens the editor.
      const editor = event.state?.templatesEditor as EditorHistoryState | undefined;
      if (editor?.mode === "new" || editor?.mode === "edit" || editor?.mode === "overlay") {
        editorHistoryStateRef.current = editor;
        setTransitioning(true);
        setView(viewFromEditorState(editor));
        return;
      }

      // Landed on a library entry while the editor holds unsaved work. Back
      // cannot be cancelled, only undone: push the editor's entry back on so
      // the user stays where they were, and ask. Confirming clears the flag and
      // goes back for real.
      if (editorDirtyRef.current && editorHistoryStateRef.current) {
        backTargetRef.current = "leave";
        window.history.pushState(
          { ...window.history.state, templatesEditor: editorHistoryStateRef.current },
          ""
        );
        setConfirmDiscard(true);
        return;
      }

      // Covers the browser's own Back button/gesture pressed directly,
      // which never runs through `leaveEditor`: every other exit from an
      // overlay editor (the in-app Back button, a confirmed discard, "Use
      // the full editor instead") does, and cleans up there instead.
      const current = viewRef.current;
      if (current.mode === "overlay") leaveOverlayDraft(current);

      // Landed on a library entry: close the editor if it is open, restoring the
      // view recorded on the entry being returned to.
      const library = libraryViewFromHistoryState(event.state);
      setView((currentView) => {
        if (currentView.mode === "edit" && currentView.fillDraft) {
          // Backing out of an editor that was opened from the fill modal
          // reopens the modal with the draft intact.
          return {
            mode: "list-fill",
            templateId: currentView.templateId,
            fillDraft: currentView.fillDraft,
            ...library,
          };
        }
        if (currentView.mode === "list" || currentView.mode === "list-fill") {
          // Already on the library; its own popstate listener restores the view.
          return currentView;
        }
        return { mode: "list", ...library };
      });
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [leaveOverlayDraft]);

  // "new" mode always sits one history entry above the unsaved overlay draft
  // it was reached from (see handleUseFullEditorFromOverlay). Leaving it any
  // way other than "Back to Document Overlay" abandons that draft: delete it
  // and skip the return trip past its entry, straight to the library.
  const abandonBailedOverlayDraftAndGoToLibrary = () => {
    const draftId = bailedOverlayDraftIdRef.current;
    bailedOverlayDraftIdRef.current = null;
    if (draftId && !deletedDraftIdsRef.current.has(draftId)) {
      deletedDraftIdsRef.current.add(draftId);
      templatesService.delete(lawFirmId, draftId).catch((err: unknown) => {
        const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { status?: number; statusCode?: number })?.statusCode;
        if (status === 404) return;
        console.warn("Failed to delete abandoned Document Overlay draft:", err);
      });
      queryClient.invalidateQueries({ queryKey: ["templates", lawFirmId] });
    }

    if (window.history.state?.templatesEditor) {
      suppressNextPopRef.current = true;
      window.history.go(-2);
      setView({ mode: "list", ...libraryViewFromHistoryState(window.history.state) });
    } else {
      setView({ mode: "list" });
    }
  };

  const handleSaved = () => {
    pendingFileRef.current = null;
    // Set before the navigation below, which triggers the same popstate
    // cleanup path an unsaved abandon would: this is what stops that cleanup
    // from deleting the template this save just wrote.
    if (view.mode === "overlay") overlaySavedRef.current = true;
    queryClient.invalidateQueries({ queryKey: ["templates", lawFirmId] });
    // The fill modal caches full template HTML under its own key; drop it so a
    // fill right after an edit doesn't generate the pre-edit document.
    queryClient.invalidateQueries({ queryKey: ["template-fill-detail", lawFirmId] });

    // Saving the full editor after a bail leaves the overlay draft it was
    // reached from as an orphaned duplicate of the same source file.
    if (view.mode === "new" && bailedOverlayDraftIdRef.current) {
      abandonBailedOverlayDraftAndGoToLibrary();
      return;
    }

    if (window.history.state?.templatesEditor) {
      if (view.mode === "edit" && view.fillDraft) {
        // Saving should not reopen the fill modal, so pop the editor entry
        // silently and land on the library at the view recorded on the entry.
        suppressNextPopRef.current = true;
        window.history.back();
        setView({ mode: "list", ...libraryViewFromHistoryState(window.history.state) });
      } else {
        // Popping the editor entry lets the popstate handler restore the view
        // the editor was opened from.
        window.history.back();
      }
      return;
    }

    setView({ mode: "list" });
  };

  // Reload and tab close bypass both Back paths, and only the browser's own
  // generic prompt can stop them.
  useEffect(() => {
    if (!editorDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers only show the prompt when returnValue is set.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [editorDirty]);

  const handleBack = () => {
    // The Back button asks the same question the browser's Back gesture does.
    backTargetRef.current = "leave";
    if (editorDirtyRef.current) {
      setConfirmDiscard(true);
      return;
    }
    leaveEditor();
  };

  // The dedicated way back to the overlay draft a full-editor session was
  // reached from ("Back to Document Overlay"), distinct from the generic
  // Back above: this one specifically returns to it instead of abandoning it.
  const handleBackToOverlay = () => {
    backTargetRef.current = "overlay";
    if (editorDirtyRef.current) {
      setConfirmDiscard(true);
      return;
    }
    returnToOverlay();
  };

  // Clearing the flag first is what lets the popstate handler fall through to
  // its normal close instead of intercepting the Back it is about to trigger.
  const discardAndLeave = () => {
    setConfirmDiscard(false);
    setDirty(false);
    if (backTargetRef.current === "overlay") returnToOverlay();
    else leaveEditor();
  };

  // Single step back to the overlay entry one history entry down. Only ever
  // called for "new" mode reached via a bail, which always has one.
  const returnToOverlay = () => {
    pendingFileRef.current = null;
    if (window.history.state?.templatesEditor) {
      window.history.back();
      return;
    }
    leaveEditor();
  };

  const leaveEditor = () => {
    pendingFileRef.current = null;

    // "new" mode: leaving any way other than "Back to Document Overlay"
    // abandons the overlay draft it was reached from, rather than
    // resurfacing it a step behind wherever Back actually meant to go.
    if (view.mode === "new" && bailedOverlayDraftIdRef.current) {
      abandonBailedOverlayDraftAndGoToLibrary();
      return;
    }

    if (window.history.state?.templatesEditor) {
      // The editor pushed a history entry; going back through it restores
      // the prior view (a folder, the flat library, or the fill modal).
      window.history.back();
      return;
    }

    // No editor entry on the stack (e.g. after a page refresh): fall back to
    // a direct view change. The popstate handler above covers this same
    // cleanup for the `window.history.back()` path just above.
    if (view.mode === "overlay") leaveOverlayDraft(view);

    if (view.mode === "edit" && view.fillDraft) {
      setView({
        mode: "list-fill",
        templateId: view.templateId,
        fillDraft: view.fillDraft,
      });
    } else {
      setView({ mode: "list" });
    }
  };

  if (view.mode === "new" || view.mode === "edit") {
    return (
      <>
        {transitioning && (
          <div className="fixed inset-0 bg-page/80 flex items-center justify-center z-30">
            <LoadingSpinner />
          </div>
        )}
        <TemplateEditor
          lawFirmId={lawFirmId}
          {...(view.mode === "new"
            ? { folderId: view.folderId ?? null, initialFile: pendingFileRef.current }
            : {
                templateId: view.templateId,
                initialFillValues: view.fillDraft?.values,
                initialRepeaterFillValues: view.fillDraft?.repeaterValues,
              })}
          onSaved={handleSaved}
          onBack={handleBack}
          onReady={() => setTransitioning(false)}
          onDirtyChange={setDirty}
          // Only a "new" editor reached by bailing out of a Document Overlay
          // draft (see handleUseFullEditorFromOverlay) has that draft one
          // history entry down to return to.
          onUseOverlayEditor={view.mode === "new" && view.fromOverlay ? handleBackToOverlay : undefined}
        />
        <ConfirmModal
          isOpen={confirmDiscard}
          title="Discard unsaved changes?"
          message={
            view.mode === "edit" && view.fillDraft
              ? "You have edited this document since opening it. Going back to the fill form discards those edits; the values you filled in are kept."
              : view.mode === "new" && backTargetRef.current === "overlay"
                ? "You have changes to this template that have not been saved. Going back to Document Overlay discards them; the document itself is kept."
                : view.mode === "new" && view.fromOverlay
                  ? "You have changes to this template that have not been saved. Going back abandons them, along with the Document Overlay draft this was opened from."
                  : "You have changes to this template that have not been saved. Going back to the library discards them."
          }
          confirmText="Discard"
          confirmType="danger"
          cancelText="Keep editing"
          onConfirm={discardAndLeave}
          onClose={() => setConfirmDiscard(false)}
        />
      </>
    );
  }

  if (view.mode === "overlay") {
    return (
      <>
        {transitioning && (
          <div className="fixed inset-0 bg-page/80 flex items-center justify-center z-30">
            <LoadingSpinner />
          </div>
        )}
        <TemplateOverlayEditor
          lawFirmId={lawFirmId}
          templateId={view.templateId}
          onSaved={handleSaved}
          onBack={handleBack}
          onReady={() => setTransitioning(false)}
          onDirtyChange={setDirty}
          // Only offered for the template this session's own upload just
          // created, and never for one reopened after it was already saved
          // once: per the design, once an overlay template is saved its
          // type is locked, matching how html/docx already can't convert
          // into each other.
          onUseFullEditor={view.isNew ? handleUseFullEditorFromOverlay : undefined}
        />
        <ConfirmModal
          isOpen={confirmDiscard}
          title="Discard unsaved changes?"
          message={
            view.isNew
              ? "This document hasn't been saved as a template yet. Going back to the library discards the upload and any fields you've placed on it."
              : "You have placed fields on this document that have not been saved. Going back to the library discards that layout."
          }
          confirmText="Discard"
          confirmType="danger"
          cancelText="Keep editing"
          onConfirm={discardAndLeave}
          onClose={() => setConfirmDiscard(false)}
        />
      </>
    );
  }

  return (
    <TemplatesWorkspace
      lawFirmId={lawFirmId}
      headerActions={versionToggle}
      createMode={createMode}
      onDocumentPicked={handleDocumentPicked}
      initialTab={view.tab ?? initialTab}
      // A view restored from history carries an explicit null for "top level",
      // which the URL's folder parameter must not override.
      initialFolderId={view.folderId !== undefined ? view.folderId : initialFolderId}
      onOverlayCreated={({ templateId, folderId, sourceFile }) => {
        overlaySavedRef.current = false;
        overlaySourceFileRef.current = sourceFile;
        openEditor({ mode: "overlay", templateId, folderId, isNew: true });
      }}
      onEditTemplate={(templateId, fillDraft, templateType) =>
        // Overlay templates have no HTML content to prefill from a fill
        // draft the way html/docx do, so reopening one for editing always
        // goes straight to the placement editor; `folderId` isn't used by
        // TemplateOverlayEditor for an already-saved template (only "Use
        // the full editor instead" needs it, and that's offered only for a
        // template this session just uploaded, never a reopened one).
        templateType === "overlay"
          ? openEditor({ mode: "overlay", templateId, folderId: null, isNew: false })
          : openEditor({ mode: "edit", templateId, fillDraft: fillDraft ?? null })
      }
      initialFillTemplateId={view.mode === "list-fill" ? view.templateId : undefined}
      initialFillDraft={view.mode === "list-fill" ? view.fillDraft : undefined}
    />
  );
}
