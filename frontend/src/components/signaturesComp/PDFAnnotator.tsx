'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import SigningDocumentText from './SigningDocumentText';
import Checkbox from "@/components/ui/Checkbox";
import { FileText, FolderOpen, Send, CheckCircle, Check, Download, X } from 'lucide-react';
import PDFPageViewer from './PDFPageViewer';
import TextAnnotation from './TextAnnotation';
import SignatureAnnotation from './SignatureAnnotation';
import TextStyleToolbar from './TextStyleToolbar';
import SignatureModal from './SignatureModal';
import AnnotationToolbar, { type DownloadFormat } from './AnnotationToolbar';
import ErrorToast from '@/components/ui/ErrorToast';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import ScrollArea from '@/components/ui/ScrollArea';
import ZoomControls from '@/components/ui/ZoomControls';
import { useAnnotationEditor, ANNOTATOR_MAX_BYTES } from '@/hooks/signatureHooks/useAnnotationEditor';
import { useAuth } from '@/hooks/useAuth';
import { useDocumentZoom } from '@/hooks/useDocumentZoom';
import { useExecutedDocumentWait } from '@/hooks/signatureHooks/useExecutedDocumentWait';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import ConfirmModal from '@/components/ui/ConfirmModal';
import Modal from '@/components/ui/Modal';
import { stampAnnotationsOntoPdf, downloadPdf } from './pdfStamper';
import signaturesService from '@/services/signatures.service';
import type { TextAnnotationData, SignatureAnnotationData } from '@/types/signature';
import ESignConsentDisclosure from "./ESignConsent";
import Spinner from "@/components/ui/Spinner";
import DocumentTooLargePage from '@/components/ui/DocumentTooLargePage';
import { formatBytes } from '@/lib/utils/format';
import Button from '@/components/ui/Button';

export { ANNOTATOR_MAX_BYTES };

export interface PDFAnnotatorProps {
  /**
   * Pre-loaded file (skips the upload zone). `sizeBytes`, when the caller
   * knows it, lets a document over the annotator cap be refused before the
   * signer spends any time on it; without it the cap applies when the bytes
   * are read to stamp.
   */
  file?: { url: string; name: string; sizeBytes?: number; bytes?: Uint8Array };
  /** Called when user downloads, receives stamped PDF bytes + filename */
  onSave?: (pdfBytes: Uint8Array, fileName: string) => void;
  /** Additional class name for the root element */
  className?: string;
  /** Called when user wants to change the file, navigates back to file picker */
  onChangeFile?: () => void;
  /** Signing session token. When present, shows a Done button to submit back to the law firm */
  token?: string;
  /**
   * The document revision the signer was shown, echoed back on submit.
   *
   * A freehand annotation is drawn on the document as it looked when it loaded.
   * If the sender replaced it while the page was open, submitting without this
   * would attach those marks to a document the signer never saw.
   */
  sourceRevision?: string | null;
}

export default function PDFAnnotator({ file, onSave, className, onChangeFile, token, sourceRevision }: PDFAnnotatorProps) {
  // Word/ODT/RTF/TXT export converts through an authenticated endpoint, so an
  // anonymous signer (a public signing link) is offered PDF download only.
  const { user } = useAuth();
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(null);
  useEffect(() => { if (submitError && !isSubmitting) errorRef.current?.focus(); }, [submitError, isSubmitting]);
  useEffect(() => { if (submitSuccess) resultHeadingRef.current?.focus(); }, [submitSuccess]);
  const [stampedBytes, setStampedBytes] = useState<Uint8Array | null>(null);

  // "Sign your own" flow (no token): once the user has downloaded their signed
  // copy, surface a Done button so they can leave the editor.
  const [hasDownloaded, setHasDownloaded] = useState(false);

  // Consent
  const [consentAgreed, setConsentAgreed] = useState(false);
  const [consentName, setConsentName] = useState('');
  const idempotencyKeyRef = useRef<string | null>(null);
  // The document an earlier attempt stored, and the marks it was stamped from.
  // A retry names it again rather than opening a second upload, which a
  // consumed token refuses; once the marks change it no longer matches them.
  const uploadedRef = useRef<{ objectPath: string; annotations: unknown } | null>(null);
  const { isFinalizing, setIsFinalizing, finalizeTimedOut } = useExecutedDocumentWait(token);

  const { zoom, zoomIn, zoomOut, resetZoom, zoomAreaProps } = useDocumentZoom();

  const {
    state,
    dispatch,

    // Annotation actions
    handlePageClick,
    handleSignatureDone,
    handleDownload,

    // Text formatting
    handleBoldToggle,
    handleItalicToggle,
    handleFontFamilyChange,
    handleFontSizeChange,
    handleColorChange,
    saveSelection,

    // Computed values
    selectedTextAnnotation,
    currentFontFamily,
    currentFontSize,
    currentBold,
    currentItalic,
    currentColor,
    currentSignatureStyle,
    ensurePdfBytes,
  } = useAnnotationEditor({
    initialFile: file,
    onSave,
  });

  // Annotations live only in the editor's reducer until the document is
  // downloaded or submitted, so both exits - swapping the document out, and
  // leaving the page - throw them away and ask first.
  const [leaveIntent, setLeaveIntent] = useState<'back' | 'changeFile' | null>(null);
  const annotationCount = state.annotations.length;

  const { release, leave } = useUnsavedChangesGuard(
    annotationCount > 0 && !submitSuccess,
    useCallback(() => setLeaveIntent('back'), [])
  );

  // Releases first so the browser's own leave prompt doesn't fire on a
  // navigation the user already chose.
  const leaveToFilePicker = useCallback(() => {
    release();
    onChangeFile?.();
  }, [release, onChangeFile]);

  const handleChangeFile = useCallback(() => {
    if (annotationCount > 0 && !submitSuccess) {
      setLeaveIntent('changeFile');
      return;
    }
    leaveToFilePicker();
  }, [annotationCount, submitSuccess, leaveToFilePicker]);

  const handleDownloadAndOfferDone = useCallback(async (format: DownloadFormat) => {
    await handleDownload(format);
    setHasDownloaded(true);
  }, [handleDownload]);

  const handleSubmit = useCallback(async () => {
    if (!token) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const stamped = await stampAnnotationsOntoPdf(await ensurePdfBytes(), state.annotations);
      setStampedBytes(stamped);
      if (!sourceRevision) {
        throw new Error('Cannot submit without the document revision this was annotated on.');
      }
      const idempotencyKey = idempotencyKeyRef.current || (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `sign-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      idempotencyKeyRef.current = idempotencyKey;
      const annotations = state.annotations;
      const uploaded = uploadedRef.current?.annotations === annotations ? uploadedRef.current.objectPath : undefined;
      // The stamped document goes to STORAGE and the completion names it. It
      // used to be a multipart body, which put a whole document in the API.
      const result = await signaturesService.submitSignedDocument(token, stamped, state.fileName ?? 'document.pdf', {
        consentAgreed,
        consentName: consentName.trim(),
        consentTimestamp: new Date().toISOString(),
        sourceRevision,
        idempotencyKey,
      }, {
        signedObjectPath: uploaded,
        onUploaded: (objectPath) => { uploadedRef.current = { objectPath, annotations }; },
      });
      if (result.state === 'permanent_refusal') {
        throw new Error('Your signature was recorded, but this document cannot be finalized. Please contact the sender.');
      }
      setIsFinalizing(result.state === 'processing' || result.state === 'recoverable_failure');
      setSubmitSuccess(true);
      setShowConfirmModal(false);
    } catch (err) {
      setSubmitError(getErrorMessage(err, 'Failed to submit document'));
    } finally {
      setIsSubmitting(false);
    }
  }, [token, ensurePdfBytes, state.annotations, state.fileName, consentAgreed, consentName, sourceRevision, setIsFinalizing]);

  if (file?.sizeBytes != null && file.sizeBytes > ANNOTATOR_MAX_BYTES) {
    return (
      <DocumentTooLargePage
        title="This document is too large to sign in the browser"
        description={`Open signing draws on the document in your browser, which works up to ${formatBytes(ANNOTATOR_MAX_BYTES)}. Ask the sender to place signature fields instead.`}
      />
    );
  }

  if (!state.fileUrl) return null;

  // Success state
  if (submitSuccess) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center max-w-md space-y-4">
          <div className="mx-auto w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
            <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" />
          </div>
          <h2 ref={resultHeadingRef} tabIndex={-1} className="text-xl font-semibold text-on-surface">Document Submitted</h2>
          <p className="text-sm text-on-surface-muted">
            {isFinalizing ? (
              finalizeTimedOut
                ? 'Your signature was recorded. The executed document is still being prepared. You can close this page.'
                : 'Your signature was recorded. The executed document is still being produced.'
            ) : (
              'Your signed document has been sent back to the law firm. You can download a copy for your records.'
            )}
          </p>
          {stampedBytes && (
            <button
              onClick={() => downloadPdf(stampedBytes, state.fileName ?? 'document.pdf')}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-outline-subtle text-on-surface hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              <Download size={16} />
              Download a Copy
            </button>
          )}
        </div>
      </div>
    );
  }

  // Editor
  return (
    <div className={`flex-1 flex flex-col ${className || ''}`}>
      {/* Top toolbar */}
      <div className="sticky top-0 z-30 bg-surface border-b border-outline-subtle px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <FileText className="w-5 h-5 text-on-surface-muted flex-shrink-0" />
          <span className="text-sm font-medium text-on-surface truncate">{state.fileName}</span>
          {onChangeFile && (
            <button
              onClick={handleChangeFile}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-outline text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer flex-shrink-0"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Change File
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <ZoomControls className="shrink-0" zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} />
          <div className="h-4 w-px shrink-0 bg-outline-subtle" />
          <AnnotationToolbar
            mode={state.mode}
            onModeChange={(mode) => dispatch({ type: 'SET_MODE', mode })}
            canUndo={state.history.length > 0}
            canRedo={state.future.length > 0}
            onUndo={() => dispatch({ type: 'UNDO' })}
            onRedo={() => dispatch({ type: 'REDO' })}
            onDownload={handleDownloadAndOfferDone}
            isDownloading={state.isDownloading}
            allowConvertFormats={!!user}
          />
          {token && (
            <Button
              size="compact"
              onClick={() => setShowConfirmModal(true)}
              icon={<Send size={14} />}
            >
              Done
            </Button>
          )}
          {!token && hasDownloaded && onChangeFile && (
            <Button
              size="compact"
              onClick={leaveToFilePicker}
              icon={<Check size={14} />}
            >
              Done
            </Button>
          )}
        </div>
      </div>

      {/* Text style toolbar */}
      {(state.mode === 'text' || selectedTextAnnotation) && (
        <div className="bg-surface border-b border-outline-subtle px-4 py-2">
          <TextStyleToolbar
            fontFamily={currentFontFamily}
            fontSize={currentFontSize}
            isBold={currentBold}
            isItalic={currentItalic}
            color={currentColor}
            onFontFamilyChange={handleFontFamilyChange}
            onFontSizeChange={handleFontSizeChange}
            onBoldToggle={handleBoldToggle}
            onItalicToggle={handleItalicToggle}
            onColorChange={handleColorChange}
            onSaveSelection={saveSelection}
          />
        </div>
      )}

      {/* PDF viewer area */}
      <ScrollArea
        className="flex-1 bg-gray-100 dark:bg-gray-900"
        viewportClassName="p-6"
        viewportProps={zoomAreaProps}
      >
        <PDFPageViewer
          file={state.pdfBytes ? { url: state.fileUrl, bytes: state.pdfBytes } : { url: state.fileUrl }}
          mode={state.mode}
          zoom={zoom}
          onDocumentLoad={(numPages) => dispatch({ type: 'SET_TOTAL_PAGES', totalPages: numPages })}
          onVisiblePageChange={(page) => dispatch({ type: 'SET_PAGE', page })}
          onPageClick={handlePageClick}
          keyboardPlacement
          onDocumentProxy={setDocumentProxy}
        >
          {(page, pageWidth, pageHeight) => (
            <>
              {/* Text annotations */}
              {state.annotations
                .filter((a): a is TextAnnotationData => a.page === page && a.type === 'text')
                .map((a) => (
                  <TextAnnotation
                    key={a.id}
                    annotation={a}
                    isSelected={state.selectedAnnotationId === a.id}
                    pageWidth={pageWidth}
                    pageHeight={pageHeight}
                    onSelect={() => dispatch({ type: 'SELECT_ANNOTATION', id: a.id })}
                    onMove={(xPercent, yPercent) =>
                      dispatch({ type: 'MOVE_ANNOTATION', id: a.id, xPercent, yPercent })
                    }
                    onResize={(widthPercent, heightPercent) =>
                      dispatch({ type: 'RESIZE_ANNOTATION', id: a.id, widthPercent, heightPercent })
                    }
                    onTextChange={(text) =>
                      dispatch({ type: 'SET_ANNOTATION_TEXT', id: a.id, text })
                    }
                    onDelete={() => dispatch({ type: 'DELETE_ANNOTATION', id: a.id })}
                  />
                ))}

              {/* Signature annotations */}
              {state.annotations
                .filter((a): a is SignatureAnnotationData => a.page === page && a.type === 'signature')
                .map((a) => (
                  <SignatureAnnotation
                    key={a.id}
                    annotation={a}
                    isSelected={state.selectedAnnotationId === a.id}
                    pageWidth={pageWidth}
                    pageHeight={pageHeight}
                    onSelect={() => dispatch({ type: 'SELECT_ANNOTATION', id: a.id })}
                    onMove={(xPercent, yPercent) =>
                      dispatch({ type: 'MOVE_ANNOTATION', id: a.id, xPercent, yPercent })
                    }
                    onResize={(widthPercent, heightPercent) =>
                      dispatch({ type: 'RESIZE_ANNOTATION', id: a.id, widthPercent, heightPercent })
                    }
                    onDelete={() => dispatch({ type: 'DELETE_ANNOTATION', id: a.id })}
                  />
                ))}
            </>
          )}
        </PDFPageViewer>
      </ScrollArea>

      <SigningDocumentText pdf={documentProxy} />

      {/* Signature modal */}
      <SignatureModal
        isOpen={state.signatureModalOpen}
        onClose={() => dispatch({ type: 'CLOSE_SIGNATURE_MODAL' })}
        initialStyle={currentSignatureStyle}
        onDone={handleSignatureDone}
      />

      {/* Error toast */}
      {state.error && (
        <ErrorToast
          message={state.error}
          onDismiss={() => dispatch({ type: 'SET_ERROR', error: null })}
        />
      )}

      {/* Consent & submit confirmation modal */}
      <Modal
        isOpen={showConfirmModal}
        onClose={() => setShowConfirmModal(false)}
        title="Sign & Submit Document"
        size="lg"
        className="rounded-xl"
        closeIcon={<X size={18} strokeWidth={2} />}
        // The original hid the close "x" outright while submitting; Modal has
        // no per-render showClose toggle for that, so backdrop-dismissal is
        // disabled instead (accepted minor behavior delta from the pilot batch).
        dismissible={!isSubmitting}
        bodyClassName="px-6 py-5 space-y-4 overflow-y-auto overflow-x-hidden styled-scrollbar max-h-[70vh]"
        footer={
          <>
            <button
              onClick={() => setShowConfirmModal(false)}
              disabled={isSubmitting}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-outline-subtle text-on-surface hover:bg-surface-hover disabled:opacity-50 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || !consentAgreed || !consentName.trim()}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover disabled:opacity-50 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              {isSubmitting ? <Spinner size={16} /> : <Send size={16} />}
              {isSubmitting ? 'Submitting...' : 'Sign & Submit'}
            </button>
          </>
        }
      >
        <ESignConsentDisclosure
          name={consentName}
          onNameChange={setConsentName}
          disabled={isSubmitting}
        />

        <Checkbox
          checked={consentAgreed}
          onChange={setConsentAgreed}
          disabled={isSubmitting}
          label="I agree to sign this document electronically"
        />

        {submitError && (
          <div ref={errorRef} tabIndex={-1} role="alert" className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm">
            {submitError}
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={leaveIntent !== null}
        title={leaveIntent === 'changeFile' ? 'Choose a different document?' : 'Discard your changes?'}
        message={
          `You have added ${annotationCount} annotation${annotationCount === 1 ? '' : 's'} to ${state.fileName}`
          + (leaveIntent === 'changeFile'
            ? ', and they are not saved. Picking another document discards them.'
            : ", and they are not saved. Leaving this page discards them.")
        }
        confirmText="Discard"
        confirmType="danger"
        onConfirm={() => {
          const intent = leaveIntent;
          setLeaveIntent(null);
          if (intent === 'changeFile') leaveToFilePicker();
          else leave();
        }}
        onClose={() => setLeaveIntent(null)}
      />
    </div>
  );
}
