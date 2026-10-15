'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Checkbox from "@/components/ui/Checkbox";
import { Check, CheckCircle, Download, Send, Shield, X } from 'lucide-react';
import PDFPageViewer from './PDFPageViewer';
import SignatureModal from './SignatureModal';
import SignatureVisual from './SignatureVisual';
import { downloadPdf, stampSignatureFieldsOntoPdf } from './pdfStamper';
import signaturesService from '@/services/signatures.service';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import ScrollArea from '@/components/ui/ScrollArea';
import ZoomControls from '@/components/ui/ZoomControls';
import { useDocumentZoom } from '@/hooks/useDocumentZoom';
import { useExecutedDocumentWait } from '@/hooks/signatureHooks/useExecutedDocumentWait';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import ConfirmModal from '@/components/ui/ConfirmModal';
import Modal from '@/components/ui/Modal';
import LoadingSpinner from '@/components/LoadingSpinner';
import { resolveSignatureStyle } from '@/types/signature';
import type { SignatureField, SigningFieldValue, ToolMode } from '@/types/signature';
import ESignConsentDisclosure from "./ESignConsent";
import Spinner from "@/components/ui/Spinner";
import DatePicker from "@/components/ui/DatePicker";
import { fitTextToBox } from '@/lib/utils/textFit';
import FieldLabel from '@/components/ui/FieldLabel';
import Textarea from '@/components/ui/Textarea';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import SigningDocumentText from './SigningDocumentText';

interface RestrictedSigningViewProps {
  file: { url: string; name: string; bytes?: Uint8Array };
  fields: SignatureField[];
  token: string;
  sourceRevision?: string | null;
  instructionText?: string;
  showCompletionScreen?: boolean;
  /** Total number of signers on the session; > 1 means the completed document is only distributed once everyone signs. */
  totalParticipants?: number;
  /** Whether signers (not just the sender) get the finished document by email once all signers complete. */
  emailSignersOnComplete?: boolean;
  onSubmitted?: (result: { completed?: boolean; waitingForNextSigner?: boolean; nextSignerName?: string | null }) => void;
}

function getFieldType(field: SignatureField) {
  return field.fieldType || 'signature';
}

function getFieldLabel(field: SignatureField) {
  if (field.label?.trim()) return field.label.trim();

  switch (getFieldType(field)) {
    case 'initials':
      return 'Initials';
    case 'date':
      return 'Date';
    case 'text':
      return 'Text';
    case 'checkbox':
      return 'Checkbox';
    default:
      return 'Signature';
  }
}

function isValueComplete(field: SignatureField, value: string | boolean | undefined) {
  if (field.required === false) return true;

  if (getFieldType(field) === 'checkbox') {
    return value === true;
  }

  return typeof value === 'string' && value.trim().length > 0;
}

function formatDateValue(value: string) {
  if (!value) return '';
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-US');
}

// Reused offscreen canvas for measuring text width in the preview.
let previewTextCanvas: HTMLCanvasElement | null = null;
function measurePreviewTextWidth(text: string, fontSizePx: number) {
  if (typeof document === 'undefined') return 0;
  if (!previewTextCanvas) previewTextCanvas = document.createElement('canvas');
  const ctx = previewTextCanvas.getContext('2d');
  if (!ctx) return 0;
  ctx.font = `${fontSizePx}px Helvetica, Arial, sans-serif`;
  return ctx.measureText(text).width;
}

// Size a text/date value to its field the way the PDF stamp does. The fit is
// computed in PDF POINTS with the stamper's exact size formula, then scaled to
// screen pixels for display: computed in on-screen pixels the absolute font
// caps bit differently at each zoom level, so the preview's line wrapping
// could disagree with the stamped output.
function fitPreviewText(text: string, boxWidthPt: number, boxHeightPt: number, isText: boolean) {
  const maxFontSize = Math.max(10, Math.min(boxHeightPt * 0.55, isText ? 18 : 16));
  return fitTextToBox(text, boxWidthPt, boxHeightPt, maxFontSize, measurePreviewTextWidth);
}

export default function RestrictedSigningView({
  file,
  fields,
  token,
  sourceRevision,
  instructionText,
  showCompletionScreen = true,
  totalParticipants = 0,
  emailSignersOnComplete = false,
  onSubmitted,
}: RestrictedSigningViewProps) {
  const fieldIds = useId();
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const { zoom, zoomIn, zoomOut, resetZoom, zoomAreaProps } = useDocumentZoom();
  const [fieldValues, setFieldValues] = useState<Record<string, string | boolean>>({});
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);
  const [editorValue, setEditorValue] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);

  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showIncompleteWarning, setShowIncompleteWarning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  // `finalizeTimedOut` is set once the wait for the executed document passes
  // its deadline: the job carries on without this page, so the signer is told
  // they can leave.
  const { isFinalizing, setIsFinalizing, finalizeTimedOut } = useExecutedDocumentWait(token);
  const [waitingForNextSigner, setWaitingForNextSigner] = useState(false);
  const [nextSignerName, setNextSignerName] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submitErrorRef = useRef<HTMLDivElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);

  const [consentAgreed, setConsentAgreed] = useState(false);
  const [consentName, setConsentName] = useState('');
  const idempotencyKeyRef = useRef<string | null>(null);

  // Decline state
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [isDeclining, setIsDeclining] = useState(false);
  const [hasDeclined, setHasDeclined] = useState(false);

  useEffect(() => {
    if (submitError && !isSubmitting && !isDeclining) submitErrorRef.current?.focus();
  }, [submitError, isSubmitting, isDeclining]);
  useEffect(() => {
    if (hasDeclined || submitSuccess) resultHeadingRef.current?.focus();
  }, [hasDeclined, submitSuccess]);

  // Anything the signer has actually filled in. Not `completedCount`, which
  // treats an untouched optional field as done and so would be non-zero before
  // the signer has entered a thing.
  const hasEnteredValues = useMemo(
    () => Object.values(fieldValues).some(
      (value) => value === true || (typeof value === 'string' && value.trim().length > 0)
    ),
    [fieldValues]
  );

  const [showLeaveWarning, setShowLeaveWarning] = useState(false);

  // Field values live only in this component until the document is submitted,
  // so leaving the page throws them away. Nothing is lost once the signature is
  // recorded, or once the signer has declined.
  const { leave } = useUnsavedChangesGuard(
    hasEnteredValues && !submitSuccess && !hasDeclined,
    useCallback(() => setShowLeaveWarning(true), [])
  );

  const requiredFields = useMemo(
    () => fields.filter((field) => field.required !== false),
    [fields]
  );

  const completedCount = useMemo(
    () => fields.filter((field) => isValueComplete(field, fieldValues[field.id])).length,
    [fieldValues, fields]
  );

  const totalFields = fields.length;

  const allRequiredComplete = requiredFields.length > 0
    ? requiredFields.every((field) => isValueComplete(field, fieldValues[field.id]))
    : fields.length === 0 || fields.every((field) => isValueComplete(field, fieldValues[field.id]));

  const currentFieldValues = useMemo<SigningFieldValue[]>(
    () => Object.entries(fieldValues).map(([fieldId, value]) => ({ fieldId, value })),
    [fieldValues]
  );

  const activeField = fields.find((field) => field.id === activeFieldId) || null;
  const liveEditingField = fields.find((field) => field.id === editingFieldId) || null;
  // Retain the last edited field while the editor modal plays its exit animation
  // so its contents don't blank out once editingFieldId is cleared.
  const stickyEditingFieldRef = useRef<SignatureField | null>(null);
  if (liveEditingField) stickyEditingFieldRef.current = liveEditingField;
  const editingField = liveEditingField ?? stickyEditingFieldRef.current;

  const handleSignatureDone = useCallback((dataUrl: string) => {
    if (!activeFieldId) return;
    setFieldValues((prev) => ({ ...prev, [activeFieldId]: dataUrl }));
    setActiveFieldId(null);
  }, [activeFieldId]);

  const openEditorForField = useCallback((field: SignatureField) => {
    const fieldType = getFieldType(field);
    const existingValue = fieldValues[field.id];

    if (fieldType === 'checkbox') {
      setFieldValues((prev) => ({ ...prev, [field.id]: prev[field.id] === true ? false : true }));
      return;
    }

    if (fieldType === 'signature' || fieldType === 'initials') {
      setActiveFieldId(field.id);
      return;
    }

    setEditingFieldId(field.id);
    if (fieldType === 'date') {
      setEditorValue(typeof existingValue === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(existingValue) ? existingValue : '');
      return;
    }

    setEditorValue(typeof existingValue === 'string' ? existingValue : '');
  }, [fieldValues]);

  const saveEditorValue = useCallback(() => {
    if (!editingField) return;

    const fieldType = getFieldType(editingField);
    const normalizedValue = fieldType === 'date'
      ? editorValue
      : editorValue.trim();

    setFieldValues((prev) => ({
      ...prev,
      [editingField.id]: normalizedValue,
    }));
    setEditingFieldId(null);
    setEditorValue('');
  }, [editingField, editorValue]);

  const buildStampedPdf = useCallback(async () => {
    if (!file.bytes) return new Uint8Array();
    return stampSignatureFieldsOntoPdf(file.bytes, fields, currentFieldValues);
  }, [currentFieldValues, fields, file.bytes]);

  const handleDownload = useCallback(async () => {
    setIsDownloading(true);
    try {
      if (file.bytes) {
        const stamped = await buildStampedPdf();
        downloadPdf(stamped, file.name);
      } else if (file.url) {
        const a = document.createElement('a');
        a.href = file.url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (err) {
      console.error('Download failed:', err);
    } finally {
      setIsDownloading(false);
    }
  }, [buildStampedPdf, file.bytes, file.name, file.url]);

  const handleDownloadFromStamped = useCallback(async () => {
    // The executed document, from the session's own signed URL. It used to come
    // from bytes this component had stamped itself, but the server produces the
    // executed copy now, so what the browser held was never the filed document.
    if (token) {
      try {
        const read = await signaturesService.getSigningReadMetadata(token, 'attachment');
        const a = document.createElement('a');
        a.href = read.url;
        a.download = read.fileName || file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch (err) {
        console.error('Failed to download executed document:', err);
      }
    }
  }, [file.name, token]);

  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // This view is the FIELD-driven one: the signer fills placed fields and
      // the server rebuilds the executed document from the values, so nothing
      // here needs the document's bytes.
      //
      // There used to be a second branch that stamped the PDF in the browser
      // and posted it, for a session that carried no revision. Every session
      // carries one, and that branch was the last caller of the browser
      // stamper on this path.
      if (!sourceRevision || !token) {
        throw new Error('Cannot complete signing without document revision.');
      }
      const idempotencyKey = idempotencyKeyRef.current || (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `sign-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      idempotencyKeyRef.current = idempotencyKey;
      const result = await signaturesService.completeSigning(token, {
        consentAgreed: true,
        consentName: consentName.trim(),
        consentTimestamp: new Date().toISOString(),
        sourceRevision,
        idempotencyKey,
        fieldValues: currentFieldValues,
      });

      setWaitingForNextSigner(!!result.waitingForNextSigner);
      setNextSignerName(result.nextSignerName || null);
      setIsFinalizing(result.state === 'processing' || result.state === 'recoverable_failure');
      if (result.state === 'permanent_refusal') {
        throw new Error('Your signature was recorded, but this document cannot be finalized. Please contact the sender.');
      }
      onSubmitted?.(result);

      if (showCompletionScreen) {
        setSubmitSuccess(true);
      }

      setShowConfirmModal(false);
    } catch (err) {
      setSubmitError(getErrorMessage(err, 'Failed to submit document'));
    } finally {
      setIsSubmitting(false);
    }
  }, [consentName, currentFieldValues, onSubmitted, setIsFinalizing, showCompletionScreen, sourceRevision, token]);

  // Handle decline
  const handleDecline = useCallback(async () => {
    setSubmitError(null);
    setIsDeclining(true);
    try {
      await signaturesService.declineToSign(token, declineReason.trim() || undefined);
      setShowDeclineModal(false);
      setHasDeclined(true);
    } catch (err) {
      setSubmitError(getErrorMessage(err, 'Failed to decline'));
    } finally {
      setIsDeclining(false);
    }
  }, [declineReason, token]);

  // Declined screen
  if (hasDeclined) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center max-w-md space-y-4">
          <div className="mx-auto w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
            <X className="w-8 h-8 text-red-600 dark:text-red-400" />
          </div>
          <h2 ref={resultHeadingRef} tabIndex={-1} className="text-xl font-semibold text-on-surface">You Have Declined to Sign</h2>
          <p className="text-sm text-on-surface-muted">
            The sender has been notified of your decision. You can close this page.
          </p>
        </div>
      </div>
    );
  }

  // Completion screen
  if (submitSuccess) {
    const signedAt = new Date();
    const formattedTimestamp = signedAt.toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });

    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
          <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mb-4">
            <CheckCircle size={32} className="text-green-600 dark:text-green-400" />
          </div>
          <h2 ref={resultHeadingRef} tabIndex={-1} className="text-xl font-semibold text-on-surface mb-2">Signing Complete</h2>
          <p className="text-on-surface-secondary text-sm mb-6 max-w-md">
            Your signature has been recorded for &ldquo;{file.name}&rdquo;.
            {isFinalizing ? (
              finalizeTimedOut ? (
                <>
                  {' '}The executed document is still being prepared. You can close this page
                  {emailSignersOnComplete ? '; it will be emailed to you.' : '.'}
                </>
              ) : (
                <> Your signature was recorded. The executed document is still being produced.</>
              )
            ) : waitingForNextSigner ? (
              <>
                {nextSignerName ? ` ${nextSignerName} is up next.` : ' The other signers still need to complete it.'}
                {emailSignersOnComplete
                  ? " Once everyone has signed, you'll get an email letting you know it's done, with the completed document attached. You can download your copy below in the meantime."
                  : ' You can download your copy below; the finished document will be ready once everyone has signed.'}
              </>
            ) : (
              <>
                {totalParticipants > 1 ? ' All parties have signed.' : ''}
                {emailSignersOnComplete
                  ? ' The completed document will be emailed to you.'
                  : ' The completed document is ready.'}
              </>
            )}
          </p>
          <div className="bg-surface-alt rounded-lg p-4 text-left text-sm space-y-2 w-full max-w-sm">
            <div className="flex justify-between">
              <span className="text-on-surface-muted">Document</span>
              <span className="text-on-surface font-medium truncate ml-4 max-w-[200px]">{file.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-on-surface-muted">Signed at</span>
              <span className="text-on-surface font-medium">{formattedTimestamp}</span>
            </div>
            {consentName.trim() && (
              <div className="flex justify-between">
                <span className="text-on-surface-muted">Your name</span>
                <span className="text-on-surface font-medium">{consentName.trim()}</span>
              </div>
            )}
          </div>
          {isFinalizing && !finalizeTimedOut && (
            <div className="mt-4 inline-flex items-center gap-2.5 px-4 py-2 text-sm font-medium rounded-lg bg-surface-alt border border-outline-subtle text-on-surface-secondary">
              <Spinner size={16} />
              <span>Sealing document and preparing your copy...</span>
            </div>
          )}
          {!isFinalizing && <button
            onClick={handleDownloadFromStamped}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-outline-subtle text-on-surface hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
          >
            <Download size={16} />
            Download a Copy
          </button>}
          <p className="mt-6 text-sm text-on-surface-secondary">
            You can safely close this tab now, or{' '}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full page load is wanted here: it tears down the finished signing session rather than client-side routing away with its state still mounted */}
            <a href="/" className="text-accent-emphasis font-medium hover:underline">
              go to Paralegix
            </a>
            .
          </p>
          {/* Trust badge */}
          <div className="mt-4 flex items-center gap-2 text-xs text-on-surface-muted">
            <Shield size={14} />
            <span>Secured with digital certificate &middot; Tamper-evident</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col">
      {/* Header bar */}
      <div className="sticky top-0 z-30 bg-surface border-b border-outline-subtle">
        <div className="px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-sm font-medium text-on-surface truncate">{file.name}</span>
            <button
              onClick={() => { setSubmitError(null); setShowDeclineModal(true); }}
              className="text-xs text-on-surface-muted hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer whitespace-nowrap"
            >
              Decline to Sign
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* A readout, not a control: the document scrolls, so this says where
                the signer is rather than offering to move them. */}
            {totalPages > 1 && (
              <>
                <span className="shrink-0 text-xs tabular-nums text-on-surface-muted">
                  Page {currentPage} of {totalPages}
                </span>
                <div className="h-4 w-px shrink-0 bg-outline-subtle" />
              </>
            )}
            <ZoomControls className="shrink-0" zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} />
            <div className="h-4 w-px shrink-0 bg-outline-subtle" />
            <button
              onClick={handleDownload}
              disabled={!allRequiredComplete || isDownloading}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-outline-subtle text-on-surface hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              {isDownloading ? <Spinner size={16} /> : <Download size={16} />}
              Download
            </button>

            <button
              onClick={() => { setSubmitError(null); allRequiredComplete ? setShowConfirmModal(true) : setShowIncompleteWarning(true); }}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              <Send size={16} />
              Done
            </button>
          </div>
        </div>

        {/* Progress bar */}
        <div className="px-4 pb-2">
          <div className="flex items-center justify-between text-xs text-on-surface-muted mb-1">
            <span>{completedCount} of {totalFields} field{totalFields !== 1 ? 's' : ''} completed</span>
            <span>{totalFields > 0 ? Math.round((completedCount / totalFields) * 100) : 0}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-surface-alt overflow-hidden">
            <div
              className="h-full rounded-full bg-green-500 transition-all duration-300"
              style={{ width: `${totalFields > 0 ? (completedCount / totalFields) * 100 : 0}%` }}
            />
          </div>
        </div>
      </div>

      {!allRequiredComplete && (
        <div className="bg-accent-soft border-b border-accent-border-soft px-4 py-2.5 text-center">
          <p className="text-sm text-accent-emphasis">
            {instructionText || 'Click each highlighted field to complete your part of the document.'}
          </p>
        </div>
      )}

      <ScrollArea
        className="flex-1 bg-gray-100 dark:bg-gray-900"
        viewportClassName="p-6"
        viewportProps={zoomAreaProps}
      >
        <PDFPageViewer
          file={file}
          mode={'select' as ToolMode}
          zoom={zoom}
          onDocumentLoad={(numPages) => setTotalPages(numPages)}
          onDocumentProxy={setDocumentProxy}
          onVisiblePageChange={setCurrentPage}
          onPageClick={() => {}}
        >
          {(page, pageWidth, pageHeight, pagePointSize) => (
            <>
              {fields.filter((field) => field.page === page).map((field) => {
                const fieldType = getFieldType(field);
                const left = (field.xPercent / 100) * pageWidth;
                const top = (field.yPercent / 100) * pageHeight;
                const width = (field.widthPercent / 100) * pageWidth;
                const height = (field.heightPercent / 100) * pageHeight;
                const value = fieldValues[field.id];
                const complete = isValueComplete(field, value);
                const isTextField = fieldType === 'text' || fieldType === 'date';
                const textDisplayValue = isTextField && typeof value === 'string'
                  ? (fieldType === 'date' ? formatDateValue(value) : value)
                  : '';
                // Pixels per PDF point. The text fit runs in point space so
                // its result matches the stamp at every zoom level, then this
                // converts the chosen sizes back for on-screen rendering.
                const pxPerPt = pagePointSize ? pageWidth / pagePointSize.width : 1;
                const fittedText = textDisplayValue
                  ? fitPreviewText(textDisplayValue, width / pxPerPt, height / pxPerPt, fieldType === 'text')
                  : null;
                const signatureStyle = resolveSignatureStyle(field.style);
                const isRequired = field.required !== false;
                const requiredMark = isRequired ? " *" : "";

                return (
                  <button
                    key={field.id}
                    type="button"
                    id={`field-${field.id}`}
                    aria-label={`${getFieldLabel(field)}, page ${field.page}, ${isRequired ? 'required' : 'optional'}, ${complete ? 'complete' : 'incomplete'}`}
                    onClick={() => openEditorForField(field)}
                    className={`absolute z-10 overflow-hidden rounded border-2 p-0 appearance-none transition-all cursor-pointer ${
                      complete
                        ? 'border-green-400/70 bg-green-50/20 hover:border-green-500'
                        : 'border-dashed border-accent-solid bg-accent-soft hover:bg-accent-soft'
                    }`}
                    style={{ left, top, width, height }}
                    title={getFieldLabel(field)}
                    >
                      {complete ? (
                        <>
                          {(fieldType === 'signature' || fieldType === 'initials') && typeof value === 'string' ? (
                          <div className="absolute inset-0">
                            <SignatureVisual style={signatureStyle} dataUrl={value} />
                          </div>
                        ) : fieldType === 'checkbox' ? (
                          <div className="absolute inset-0 flex items-center justify-center text-2xl font-bold text-green-600">
                            ✓
                          </div>
                        ) : (
                          <div
                            className="absolute inset-0 flex flex-col items-center justify-center px-1 text-center font-medium text-on-surface"
                            style={{ fontFamily: 'Helvetica, Arial, sans-serif' }}
                          >
                            {fittedText?.lines.map((line, index) => (
                              <div
                                key={index}
                                className="w-full whitespace-nowrap"
                                style={{
                                  fontSize: `${fittedText.fontSize * pxPerPt}px`,
                                  lineHeight: `${fittedText.lineHeight * pxPerPt}px`,
                                }}
                              >
                                {line}
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="absolute -top-2 -right-2 w-5 h-5 bg-green-500 text-white rounded-full flex items-center justify-center">
                          <Check className="w-3 h-3" />
                        </div>
                      </>
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center px-2 text-center text-xs font-medium text-accent-emphasis">
                        {fieldType === 'signature' || fieldType === 'initials' ? (
                          <div className="absolute inset-0 text-accent-emphasis">
                            <SignatureVisual
                              style={signatureStyle}
                              placeholderText={`${fieldType === 'initials'
                                ? 'Click to initial'
                                : signatureStyle === 'x-line'
                                  ? 'Click to sign on line'
                                  : 'Click to sign'}${requiredMark}`}
                            />
                          </div>
                        ) : fieldType === 'checkbox' ? (
                          <span>{`${field.label || 'Click to check'}${requiredMark}`}</span>
                        ) : (
                          <span>{`${field.label || `Click to add ${getFieldLabel(field).toLowerCase()}`}${requiredMark}`}</span>
                        )}
                      </div>
                    )}
                  </button>
                );
              })}
            </>
          )}
        </PDFPageViewer>
      </ScrollArea>

      <SigningDocumentText pdf={documentProxy} />
      <SignatureModal
        isOpen={!!activeFieldId}
        onClose={() => setActiveFieldId(null)}
        lockedStyle={activeField ? resolveSignatureStyle(activeField.style) : undefined}
        fieldType={activeField && getFieldType(activeField) === 'initials' ? 'initials' : 'signature'}
        onDone={(dataUrl) => handleSignatureDone(dataUrl)}
      />

      <Modal
        isOpen={!!editingFieldId}
        onClose={() => setEditingFieldId(null)}
        title={editingField ? getFieldLabel(editingField) : undefined}
        size="md"
        className="rounded-xl"
        closeIcon={<X size={18} strokeWidth={2} />}
        bodyClassName="px-6 py-5 space-y-4"
        footer={editingField && (
          <>
            <button
              onClick={() => {
                setEditingFieldId(null);
                setEditorValue('');
              }}
              className="px-3 py-2 text-sm font-medium rounded-lg border border-outline-subtle text-on-surface hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={saveEditorValue}
              disabled={!editorValue.trim()}
              className="px-3 py-2 text-sm font-medium rounded-lg bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              Save
            </button>
          </>
        )}
      >
        {editingField && (
          <>
            <label id={`${fieldIds}-editor-label`} htmlFor={getFieldType(editingField) === 'date' ? undefined : `${fieldIds}-editor`} className="block text-sm font-medium text-on-surface">
              {editingField.label || getFieldLabel(editingField)}
            </label>
            {getFieldType(editingField) === 'date' ? (
              <DatePicker
                ariaLabelledBy={`${fieldIds}-editor-label`}
                value={editorValue}
                onChange={setEditorValue}
                className="w-full"
              />
            ) : (
              <input
                id={`${fieldIds}-editor`}
                type="text"
                value={editorValue}
                onChange={(event) => setEditorValue(event.target.value)}
                placeholder={`Enter ${getFieldLabel(editingField).toLowerCase()}`}
                className="w-full rounded-md border border-input-border bg-input-bg text-on-surface px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
            )}
          </>
        )}
      </Modal>

      <Modal
        isOpen={showIncompleteWarning}
        onClose={() => setShowIncompleteWarning(false)}
        title="Fields still missing"
        size="sm"
        className="rounded-xl"
        closeIcon={<X size={18} strokeWidth={2} />}
        bodyClassName="px-6 py-5 space-y-4"
      >
        <p className="text-sm text-on-surface-secondary">
          Please complete all required fields before submitting.
        </p>
        <div className="space-y-1.5">
          {requiredFields
            .filter((field) => !isValueComplete(field, fieldValues[field.id]))
            .map((field, index) => (
              <button
                key={field.id}
                onClick={() => {
                  setShowIncompleteWarning(false);
                  // The document is one continuous scroll, so "go there"
                  // means scrolling the field's element into view.
                  setTimeout(() => {
                    document.getElementById(`field-${field.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    // A checkbox is not auto-toggled from here: openEditorForField
                    // would mark it checked sight unseen, and these are usually
                    // acknowledgements the signer should read in context first.
                    if (getFieldType(field) !== 'checkbox') openEditorForField(field);
                  }, 150);
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors cursor-pointer text-left"
              >
                <div className="w-6 h-6 rounded-full bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center flex-shrink-0">
                  <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">{index + 1}</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-300">{getFieldLabel(field)}</p>
                  <p className="text-xs text-amber-600 dark:text-amber-500">Page {field.page} · tap to go there</p>
                </div>
              </button>
            ))}
        </div>
      </Modal>

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
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              {isSubmitting ? <Spinner size={16} /> : <Send size={16} />}
              Sign & Submit
            </button>
          </>
        }
      >
        <ESignConsentDisclosure
          name={consentName}
          onNameChange={setConsentName}
          disabled={isSubmitting}
        />

        <label className="flex items-start gap-3 rounded-lg border border-outline-subtle bg-page/60 px-4 py-3 cursor-pointer">
          <Checkbox
            checked={consentAgreed}
            onChange={setConsentAgreed}
            disabled={isSubmitting}
          />
          <span className="text-sm text-on-surface-secondary">
            I agree to sign this document electronically and acknowledge that my electronic signature is legally binding.
          </span>
        </label>

        {submitError && (
          <div ref={submitErrorRef} tabIndex={-1} role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
            {submitError}
          </div>
        )}
      </Modal>

      {/* Decline modal */}
      <Modal
        isOpen={showDeclineModal}
        onClose={() => setShowDeclineModal(false)}
        title="Decline to Sign"
        size="md"
        className="rounded-xl"
        closeIcon={<X size={18} strokeWidth={2} />}
        // The original hid the close "x" outright while declining; Modal has
        // no per-render showClose toggle for that, so backdrop-dismissal is
        // disabled instead (accepted minor behavior delta from the pilot batch).
        dismissible={!isDeclining}
        bodyClassName="px-6 py-5 space-y-4"
        footer={
          <>
            <button
              onClick={() => setShowDeclineModal(false)}
              disabled={isDeclining}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-outline-subtle text-on-surface hover:bg-surface-hover disabled:opacity-50 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleDecline}
              disabled={isDeclining}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              {isDeclining ? <Spinner size={16} /> : null}
              Decline
            </button>
          </>
        }
      >
        <p className="text-sm text-on-surface-secondary">
          Are you sure you want to decline? The sender will be notified.
        </p>
        <div>
          <FieldLabel htmlFor={`${fieldIds}-declinereason`}>Reason</FieldLabel>
          <Textarea
            id={`${fieldIds}-declinereason`}
            value={declineReason}
            onChange={(event) => setDeclineReason(event.target.value)}
            placeholder="Why are you declining to sign?"
            rows={3} className="resize-none"
            disabled={isDeclining}
          />
        </div>
        {submitError && <div ref={submitErrorRef} tabIndex={-1} role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">{submitError}</div>}
      </Modal>

      <ConfirmModal
        isOpen={showLeaveWarning}
        title="Leave without signing?"
        message={`You have filled in fields on ${file.name} but haven't submitted them yet. Leaving this page discards your work, and you'll have to start over from the signing link.`}
        confirmText="Leave and discard"
        confirmType="danger"
        cancelText="Keep signing"
        onConfirm={() => { setShowLeaveWarning(false); leave(); }}
        onClose={() => setShowLeaveWarning(false)}
      />

      {/* Full-screen submission overlay */}
      {isSubmitting && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-surface/80 backdrop-blur-sm">
          <LoadingSpinner size="lg" />
          <p className="mt-4 text-sm text-on-surface-secondary">Applying your signature...</p>
          <p className="mt-1 text-xs text-on-surface-muted">This may take a moment for large documents.</p>
        </div>
      )}
    </div>
  );
}
