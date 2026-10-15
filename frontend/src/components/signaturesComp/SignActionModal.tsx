'use client';

import { useId, useState, useRef, useEffect, useCallback } from 'react';
import { X, PenLine, Copy, Send, Mail, Check, FolderOpen, ArrowLeft, Lock } from 'lucide-react';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useNavigation } from '@/contexts/NavigationContext';
import signaturesService from '@/services/signatures.service';
import clientsService from '@/services/clients.service';
import EntityPicker from '@/components/ui/EntityPicker';
import FieldError from '@/components/ui/FieldError';
import type { FullLookupItem } from '@/hooks/useEntityLookup';
import Modal from '@/components/ui/Modal';
import DestinationPickerModal from './DestinationPickerModal';
import type { SigningTemplate } from '@/types/signature';
import Spinner from '@/components/ui/Spinner';
import ListSkeleton from '@/components/ui/ListSkeleton';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import { useResetAfterClose } from '@/hooks/useMountTransition';
import FieldLabel from '@/components/ui/FieldLabel';
import FilesService from '@/services/files.service';
import FlattenPdfModal from './FlattenPdfModal';

class FlattenModalRequested extends Error {
  constructor() {
    super('Flattening was handed off to the flatten document modal.');
    this.name = 'FlattenModalRequested';
  }
}

function needsBrowserFlattening(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = getErrorMessage(error, '');
  return code === 'PDF_REQUIRES_FLATTENING'
    || code === 'PDF_UNSUPPORTED_FORM'
    || /form fields we cannot prepare for signing|flatten the form/i.test(message);
}

interface SignActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  fileName: string;
  objectPath: string;
  lawFirmId: string;
  /** Present for a document selected from the file manager. */
  fileId?: string;
}

export default function SignActionModal({
  isOpen,
  onClose,
  fileName,
  objectPath,
  lawFirmId,
  fileId,
}: SignActionModalProps) {
  const fieldIds = useId();
  const { navigate } = useNavigation();
  const [copied, setCopied] = useState(false);
  const [copyingLink, setCopyingLink] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useResetAfterClose(isOpen, () => setError(null));

  // Email form
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  const [emailName, setEmailName] = useState('');
  const [emailMessage, setEmailMessage] = useState('');
  const [replyToEmail, setReplyToEmail] = useState('');
  const [accessCode, setAccessCode] = useState('');

  // Portal form
  const [showPortalForm, setShowPortalForm] = useState(false);
  const [portalClientId, setPortalClientId] = useState('');
  /**
   * The portal recipient resolved from the picked client. A signing request is
   * addressed to the PERSON, so messaging needs the linked portal UID rather
   * than the `clients` row id the picker's value carries.
   */
  const [portalRecipient, setPortalRecipient] = useState<{ userId: string; name: string } | null>(null);
  /**
   * Whether the firm has any client with a portal account at all. The picker is
   * a typeahead, so an empty menu on its own cannot distinguish "nobody has
   * joined the portal" from "nothing matches what you typed".
   */
  const [hasPortalClients, setHasPortalClients] = useState<boolean | null>(null);
  const [loadingClients, setLoadingClients] = useState(false);
  // Client chosen purely to autofill the email fields below it.
  const [emailClientId, setEmailClientId] = useState('');
  const [emailClientNote, setEmailClientNote] = useState<string | null>(null);

  // Destination picker
  const [destinationPath, setDestinationPath] = useState('');
  const [destinationLabel, setDestinationLabel] = useState('');
  const [showDestinationPicker, setShowDestinationPicker] = useState(false);

  const [showOpenSigning, setShowOpenSigning] = useState(false);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [templates, setTemplates] = useState<SigningTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [actionCompleted, setActionCompleted] = useState(false);
  const [preparingFile, setPreparingFile] = useState(false);
  const [preparedSigningFile, setPreparedSigningFile] = useState<{ objectPath: string; fileName: string } | null>(null);
  const preparedSigningFilePromiseRef = useRef<Promise<{ objectPath: string; fileName: string }> | null>(null);
  const [flattenSourceFile, setFlattenSourceFile] = useState<File | null>(null);
  const [flattenModalOpen, setFlattenModalOpen] = useState(false);

  // The document the dialog is about now. A preparation started for an earlier
  // one may still be running when the dialog is reopened on another file; its
  // result must not become this file's signing PDF.
  const sourceKey = `${objectPath}\n${fileName}`;
  const sourceKeyRef = useRef(sourceKey);
  sourceKeyRef.current = sourceKey;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears cached prepared-file state and its ref when the source file changes
    setPreparedSigningFile(null);
    preparedSigningFilePromiseRef.current = null;
    setPreparingFile(false);
  }, [fileName, objectPath]);

  useEffect(() => {
    if (!isOpen) return;
    // Re-probe on each open so a client who joined the portal since last time is
    // not still reported as absent.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the portal-roster probe when the modal reopens
    setHasPortalClients(null);
  }, [isOpen]);

  const ensureSigningPdf = useCallback(async () => {
    if (preparedSigningFile) {
      return preparedSigningFile;
    }

    if (preparedSigningFilePromiseRef.current) {
      return preparedSigningFilePromiseRef.current;
    }

    const startedFor = sourceKey;
    const isCurrent = () => sourceKeyRef.current === startedFor;
    const promise = (async () => {
      setPreparingFile(true);
      try {
        // Preparation freezes every source before field placement. For PDFs it
        // also flattens supported interactive fields; non-PDFs are converted.
        // The document bytes never travel through the browser.
        const prepared = await signaturesService.prepareForSigning(
          lawFirmId,
          objectPath,
          fileName,
          Boolean(fileId),
        );
        if (isCurrent()) setPreparedSigningFile(prepared);
        return prepared;
      } catch (err) {
        if (!fileId || !needsBrowserFlattening(err) || !isCurrent()) throw err;

        const downloadUrl = await FilesService.getDownloadUrl(lawFirmId, fileId);
        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error('Failed to load this PDF for flattening.');
        const blob = await response.blob();
        if (!isCurrent()) throw err;
        setFlattenSourceFile(new File([blob], fileName, {
          type: 'application/pdf',
          lastModified: Date.now(),
        }));
        setFlattenModalOpen(true);
        throw new FlattenModalRequested();
      } finally {
        // A preparation for an earlier file leaves the spinner and the in-flight
        // slot alone: the file change already reset them, and a newer file's
        // preparation may hold them now.
        if (isCurrent()) {
          setPreparingFile(false);
          preparedSigningFilePromiseRef.current = null;
        }
      }
    })();

    preparedSigningFilePromiseRef.current = promise;
    return promise;
  }, [preparedSigningFile, fileName, objectPath, lawFirmId, fileId, sourceKey]);

  const handleSignYourself = async () => {
    setNavigating(true);
    setError(null);
    try {
      const signingFile = await ensureSigningPdf();
      onClose();
      const params = new URLSearchParams({
        objectPath: signingFile.objectPath,
        fileName: signingFile.fileName,
        lawFirmId,
      });
      navigate(`/signature?${params.toString()}`);
    } catch (err) {
      setNavigating(false);
      if (!(err instanceof FlattenModalRequested)) setError(getErrorMessage(err, 'Failed to prepare document'));
    }
  };

  const validateAccessCode = () => {
    const trimmed = accessCode.trim();
    if (trimmed && trimmed.length < 4) {
      setError('Access code must be at least 4 characters.');
      return false;
    }
    return true;
  };

  const handleCopyLink = async () => {
    setError(null);
    if (!validateAccessCode()) return;
    setCopyingLink(true);
    try {
      const signingFile = await ensureSigningPdf();
      const { token } = await signaturesService.generateLink(
        lawFirmId,
        signingFile.objectPath,
        signingFile.fileName,
        undefined,
        undefined,
        destinationPath || undefined,
        destinationLabel || undefined,
        undefined,
        accessCode.trim() || undefined
      );
      const link = `${window.location.origin}/signature?token=${token}`;
      try {
        await navigator.clipboard.writeText(link);
      } catch {
        // Fallback for unfocused document
        const textarea = document.createElement('textarea');
        textarea.value = link;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setActionCompleted(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      if (!(err instanceof FlattenModalRequested)) setError(getErrorMessage(err, 'Failed to copy link'));
    } finally {
      setCopyingLink(false);
    }
  };

  const handleSendToPortal = async () => {
    if (!portalRecipient) return;
    setError(null);
    if (!validateAccessCode()) return;
    setSending(true);
    try {
      const signingFile = await ensureSigningPdf();
      // One signer bound to the client's portal account. The backend posts the
      // request into the client's thread itself, linking to their portal
      // signing page rather than to a bearer link anyone in the thread could use.
      await signaturesService.sendSigningRequest(lawFirmId, {
        objectPath: signingFile.objectPath,
        fileName: signingFile.fileName,
        signers: [{
          participantId: 'portal-client',
          roleLabel: 'Signer',
          order: 1,
          deliveryMethod: 'portal',
          name: portalRecipient.name || undefined,
          clientUserId: portalRecipient.userId,
          accessCode: accessCode.trim() || undefined,
        }],
        destinationPath: destinationPath || undefined,
        destinationLabel: destinationLabel || undefined,
      });
      setSendSuccess('Signing request sent to client portal');
      setActionCompleted(true);
      setShowPortalForm(false);
      setPortalClientId('');
      setPortalRecipient(null);
      setTimeout(() => setSendSuccess(null), 3000);
    } catch (err) {
      if (!(err instanceof FlattenModalRequested)) setError(getErrorMessage(err, 'Failed to send to portal'));
      // The request exists even though the thread post failed. Sending again
      // would create a second one, so the form closes and the sender uses
      // Resend from the document instead.
      if ((err as { code?: string } | null)?.code === 'SIGNING_EMAIL_NOT_SENT') {
        setActionCompleted(true);
        setShowPortalForm(false);
      }
    } finally {
      setSending(false);
    }
  };

  const handleSendEmail = async () => {
    if (!emailTo.trim()) return;
    setError(null);
    if (!validateAccessCode()) return;
    setSending(true);
    try {
      const signingFile = await ensureSigningPdf();
      await signaturesService.sendSigningEmail(lawFirmId, {
        recipientEmail: emailTo.trim(),
        recipientName: emailName.trim() || undefined,
        objectPath: signingFile.objectPath,
        fileName: signingFile.fileName,
        message: emailMessage.trim() || undefined,
        replyToEmail: replyToEmail.trim() || undefined,
        destinationPath: destinationPath || undefined,
        destinationLabel: destinationLabel || undefined,
        accessCode: accessCode.trim() || undefined,
      });
      setSendSuccess('Signing email sent successfully');
      setActionCompleted(true);
      setShowEmailForm(false);
      setEmailTo('');
      setEmailName('');
      setEmailMessage('');
      setReplyToEmail('');
      setAccessCode('');
      setEmailClientId('');
      setEmailClientNote(null);
      setTimeout(() => setSendSuccess(null), 3000);
    } catch (err) {
      if (!(err instanceof FlattenModalRequested)) setError(getErrorMessage(err, 'Failed to send email'));
    } finally {
      setSending(false);
    }
  };

  /**
   * Asks only whether a portal client exists, so the form can say "nobody has
   * joined the portal yet" instead of showing a picker that can never match.
   * The options themselves come from the picker's own typeahead, so no roster is
   * loaded here.
   */
  const checkPortalClients = async () => {
    if (hasPortalClients !== null) return;
    setLoadingClients(true);
    try {
      const result = await clientsService.lookupClients(lawFirmId, { portalOnly: true, limit: 1 });
      setHasPortalClients(result.items.length > 0);
    } catch {
      setError('Failed to load clients');
    } finally {
      setLoadingClients(false);
    }
  };

  const handleShowPortal = () => {
    setShowPortalForm(true);
    setShowEmailForm(false);
    setShowTemplatePicker(false);
    void checkPortalClients();
  };

  const handleShowEmail = () => {
    setShowEmailForm(true);
    setShowPortalForm(false);
    setShowTemplatePicker(false);
  };

  const handleDesignatedFields = async () => {
    setNavigating(true);
    setError(null);
    try {
      const signingFile = await ensureSigningPdf();
      onClose();
      // Pass objectPath directly. The signature page asks /api/signing/preview-url
      // for a read link (no session needed) and never holds the document.
      const params = new URLSearchParams({
        objectPath: signingFile.objectPath,
        fileName: signingFile.fileName,
        mode: 'designate',
        lawFirmId,
      });
      if (destinationPath) params.set('destinationPath', destinationPath);
      if (destinationLabel) params.set('destinationLabel', destinationLabel);
      navigate(`/signature?${params.toString()}`);
    } catch (err) {
      setNavigating(false);
      if (!(err instanceof FlattenModalRequested)) setError(getErrorMessage(err, 'Failed to prepare document'));
    }
  };

  const handleShowTemplatePicker = async () => {
    setError(null);
    setShowTemplatePicker(true);
    setShowEmailForm(false);
    setShowPortalForm(false);
    setLoadingTemplates(true);

    try {
      const result = await signaturesService.listSigningTemplates(lawFirmId);
      setTemplates(result.templates || []);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load signing templates'));
    } finally {
      setLoadingTemplates(false);
    }
  };

  const handleUseTemplate = async (templateId: string) => {
    setNavigating(true);
    setError(null);

    try {
      const signingFile = await ensureSigningPdf();
      onClose();
      const params = new URLSearchParams({
        objectPath: signingFile.objectPath,
        fileName: signingFile.fileName,
        mode: 'designate',
        lawFirmId,
        templateId,
      });
      if (destinationPath) params.set('destinationPath', destinationPath);
      if (destinationLabel) params.set('destinationLabel', destinationLabel);
      navigate(`/signature?${params.toString()}`);
    } catch (err) {
      setNavigating(false);
      if (!(err instanceof FlattenModalRequested)) setError(getErrorMessage(err, 'Failed to prepare document'));
    }
  };

  if (navigating) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/50 backdrop-blur-sm">
        <LoadingSpinner />
        <p className="mt-4 text-sm font-medium text-white">Loading document...</p>
      </div>
    );
  }

  return (
    <>
    <Modal
      isOpen={isOpen && !flattenModalOpen}
      onClose={onClose}
      dismissible={!sending && !copyingLink}
      title="Document Signing"
      subtitle={fileName}
      size="md"
      closeIcon={<X size={18} strokeWidth={2} />}
    >
          {/* Error message */}
          {error && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm">
              {error}
            </div>
          )}

          {preparingFile && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 text-sm">
              <Spinner size={16} />
              Preparing PDF for signing...
            </div>
          )}

          {/* Signing actions: one flat level */}
          {!showOpenSigning && (
            <>
              <button
                onClick={handleSignYourself}
                disabled={preparingFile}
                className="w-full flex items-center gap-3 p-4 rounded-lg border border-accent-border-soft hover:border-accent-border-soft hover:bg-accent-soft transition-all cursor-pointer text-left"
              >
                <div className="w-9 h-9 rounded-lg bg-accent-soft flex items-center justify-center flex-shrink-0">
                  <PenLine size={17} className="text-accent-emphasis" />
                </div>
                <div>
                  <p className="text-sm font-medium text-on-surface">Sign it yourself</p>
                  <p className="text-xs text-on-surface-muted">Open the document and add your signature</p>
                </div>
              </button>

              <div className="flex items-center gap-3 py-0.5">
                <div className="flex-1 h-px bg-outline-subtle" />
                <span className="text-[11px] text-on-surface-muted uppercase tracking-wider">Send for signing</span>
                <div className="flex-1 h-px bg-outline-subtle" />
              </div>

              <button
                onClick={handleDesignatedFields}
                disabled={preparingFile}
                className="w-full flex items-center gap-3 p-4 rounded-lg border border-accent-border-soft hover:border-accent-border-soft hover:bg-accent-soft transition-all cursor-pointer text-left"
              >
                <div className="w-9 h-9 rounded-lg bg-accent-soft flex items-center justify-center flex-shrink-0">
                  <PenLine size={17} className="text-accent-emphasis" />
                </div>
                <div>
                  <p className="text-sm font-medium text-on-surface">Guided signing</p>
                  <p className="text-xs text-on-surface-muted">Choose signers, mark where they sign, then send</p>
                </div>
              </button>

              <button
                onClick={() => setShowOpenSigning(true)}
                disabled={preparingFile}
                className="w-full flex items-center gap-3 p-4 rounded-lg border border-blue-200 dark:border-accent-control-ring/20 hover:border-accent-border-soft dark:hover:border-accent-control-ring/40 hover:bg-blue-50/50 dark:hover:bg-blue-500/10 transition-all cursor-pointer text-left"
              >
                <div className="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center flex-shrink-0">
                  <Send size={17} className="text-accent-emphasis" />
                </div>
                <div>
                  <p className="text-sm font-medium text-on-surface">Open signing</p>
                  <p className="text-xs text-on-surface-muted">Client signs anywhere on the document</p>
                </div>
              </button>

              <button
                onClick={handleShowTemplatePicker}
                disabled={preparingFile}
                className={`w-full flex items-center gap-3 p-4 rounded-lg border transition-all cursor-pointer text-left ${
                  showTemplatePicker
                    ? 'border-amber-300 bg-amber-50/50 dark:border-amber-500/40 dark:bg-amber-500/10'
                    : 'border-amber-200 dark:border-amber-500/20 hover:border-amber-300 dark:hover:border-amber-500/40 hover:bg-amber-50/50 dark:hover:bg-amber-500/10'
                }`}
              >
                <div className="w-9 h-9 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center flex-shrink-0">
                  <FolderOpen size={17} className="text-amber-600 dark:text-amber-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-on-surface">Use template</p>
                  <p className="text-xs text-on-surface-muted">Apply a saved signer layout to this document</p>
                </div>
              </button>

              {showTemplatePicker && (
                <div className="rounded-xl border border-outline-subtle bg-surface-alt p-3 space-y-2">
                  {loadingTemplates ? (
                    <ListSkeleton rows={3} label="Loading signing templates" bordered={false} />
                  ) : templates.length === 0 ? (
                    <p className="text-sm text-on-surface-muted">No signing templates saved yet.</p>
                  ) : (
                    templates.map((template) => (
                      <button
                        key={template.templateId}
                        onClick={() => handleUseTemplate(template.templateId)}
                        className="w-full rounded-lg border border-outline-subtle bg-surface px-3 py-3 text-left hover:border-amber-300 hover:bg-amber-50/40 dark:hover:bg-amber-500/10 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-on-surface truncate">{template.name}</p>
                            <p className="text-xs text-on-surface-muted truncate">
                              {template.signerRoles.length} signer{template.signerRoles.length !== 1 ? 's' : ''} · {template.fields.length} field{template.fields.length !== 1 ? 's' : ''}
                            </p>
                          </div>
                          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-amber-600 dark:text-amber-300">
                            Use
                          </span>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </>
          )}

          {/* Open signing sub-view */}
          {showOpenSigning && (
            <>
              <button
                onClick={() => { setShowOpenSigning(false); setShowEmailForm(false); setShowPortalForm(false); setShowTemplatePicker(false); }}
                className="flex items-center gap-2 text-sm text-on-surface-secondary hover:text-on-surface transition-colors cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>

              {/* Success message */}
              {sendSuccess && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 text-sm">
                  <Check size={16} />
                  {sendSuccess}
                </div>
              )}

              {/* Access code: applies to all send methods */}
              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Lock size={13} className="text-on-surface-secondary" />
                  <span className="text-sm font-medium text-on-surface">Access code</span>
                </div>
                <input
                  type="text"
                  placeholder="e.g. meeting2024"
                  value={accessCode}
                  onChange={(e) => setAccessCode(e.target.value)}
                  minLength={4}
                  maxLength={20}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-input-border bg-input-bg text-on-surface focus-visible:ring-2 focus-visible:ring-focus-ring outline-none placeholder:text-on-surface-muted"
                />
                {accessCode.length > 0 && accessCode.length < 4 && (
                  <p className="mt-1 text-xs text-red-500">Access code must be at least 4 characters.</p>
                )}
                <p className="mt-1 text-xs text-on-surface-muted">Share this code with the signer separately (text, call, in person). 4-20 characters.</p>
              </div>

              {/* File destination picker */}
              <button
                onClick={() => setShowDestinationPicker(true)}
                className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer ${
                  destinationPath
                    ? 'border-accent-border-soft bg-accent-soft'
                    : 'border-outline-subtle hover:border-outline hover:bg-surface-hover'
                }`}
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                  destinationPath ? 'bg-accent-soft' : 'bg-surface-alt'
                }`}>
                  <FolderOpen size={16} className={destinationPath ? 'text-accent-emphasis' : 'text-on-surface-secondary'} />
                </div>
                <div className="text-left flex-1 min-w-0">
                  <p className="text-sm font-medium text-on-surface">
                    {destinationPath ? destinationLabel : 'Choose file destination'}
                  </p>
                  <p className="text-[11px] text-on-surface-muted">
                    {destinationPath ? 'Signed file will be saved here' : 'Where to save the signed document. The client can also download it.'}
                  </p>
                </div>
                {destinationPath && (
                  <Check size={16} className="text-accent-emphasis flex-shrink-0" />
                )}
              </button>

              <div className="h-px bg-outline-subtle" />

              {/* Copy link */}
              <button
                onClick={handleCopyLink}
                disabled={preparingFile || copyingLink}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-outline-subtle hover:border-outline hover:bg-surface-hover transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <div className="w-8 h-8 rounded-lg bg-surface-alt flex items-center justify-center flex-shrink-0">
                  {copyingLink
                    ? <Spinner size={16} className="text-on-surface-secondary" />
                    : copied ? <Check size={16} className="text-emerald-600 dark:text-emerald-400" /> : <Copy size={16} className="text-on-surface-secondary" />}
                </div>
                <div className="text-left">
                  <p className="text-sm font-medium text-on-surface">{copied ? 'Link copied!' : 'Copy link'}</p>
                  <p className="text-xs text-on-surface-muted">Generate a shareable signing URL</p>
                </div>
              </button>

              {/* Send to portal */}
              <button
                onClick={handleShowPortal}
                className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer ${
                  showPortalForm ? 'border-blue-300 bg-blue-50/30 dark:bg-blue-500/5' : 'border-outline-subtle hover:border-outline hover:bg-surface-hover'
                }`}
              >
                <div className="w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center flex-shrink-0">
                  <Send size={16} className="text-accent-emphasis" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-medium text-on-surface">Send to client portal</p>
                  <p className="text-xs text-on-surface-muted">Send via in-app messaging</p>
                </div>
              </button>

              {showPortalForm && (
                <div className="space-y-3">
                  {loadingClients ? (
                    <ListSkeleton rows={3} label="Loading portal clients" bordered={false} />
                  ) : hasPortalClients === false ? (
                    <p className="text-sm text-on-surface-muted py-1">No clients have joined the portal yet.</p>
                  ) : (
                    <>
                      <div>
                        <FieldLabel>Client *</FieldLabel>
                        <EntityPicker
                          entity="clients"
                          lawFirmId={lawFirmId}
                          portalOnly
                          value={portalClientId}
                          onChange={setPortalClientId}
                          onSelectItem={(item) =>
                            setPortalRecipient(
                              item?.userId ? { userId: item.userId, name: item.label } : null
                            )
                          }
                          placeholder="Select a client..."
                          portal
                        />
                      </div>
                      <button
                        onClick={handleSendToPortal}
                        disabled={!portalRecipient || sending || preparingFile}
                        className="w-full py-2 px-4 text-sm font-medium rounded-lg bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed transition-[background-color,transform] active:scale-[0.985] motion-reduce:active:scale-100 flex items-center justify-center gap-2 cursor-pointer"
                      >
                        {sending && <Spinner />}
                        Send to Portal
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* Email client */}
              <button
                onClick={handleShowEmail}
                className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer ${
                  showEmailForm ? 'border-purple-300 bg-purple-50/30 dark:bg-purple-500/5' : 'border-outline-subtle hover:border-outline hover:bg-surface-hover'
                }`}
              >
                <div className="w-8 h-8 rounded-lg bg-purple-50 dark:bg-purple-900/30 flex items-center justify-center flex-shrink-0">
                  <Mail size={16} className="text-purple-600 dark:text-purple-400" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-medium text-on-surface">Email client</p>
                  <p className="text-xs text-on-surface-muted">Send a signing link via email</p>
                </div>
              </button>

              {showEmailForm && (
                <div className="space-y-3">
                  <div>
                    <EntityPicker<FullLookupItem>
                      entity="clients"
                      lawFirmId={lawFirmId}
                      value={emailClientId}
                      onChange={setEmailClientId}
                      onSelectItem={(item) => {
                        if (!item) {
                          setEmailClientNote(null);
                          return;
                        }
                        const email = typeof item.email === 'string' ? item.email : '';
                        const name = typeof item.name === 'string' && item.name ? item.name : item.label;
                        if (email) setEmailTo(email);
                        setEmailName(name);
                        setEmailClientNote(
                          email ? null : 'This client has no email address on file. Enter one below.'
                        );
                      }}
                      placeholder="Search clients to autofill..."
                      full
                      excludeArchived
                      portal
                    />
                    <FieldError message={emailClientNote} />
                  </div>
                  <div>
                    <FieldLabel htmlFor={`${fieldIds}-emailto`}>Client email address *</FieldLabel>
                    <input
                      id={`${fieldIds}-emailto`}
                      type="email"
                      placeholder="Client email address"
                      value={emailTo}
                      onChange={(e) => setEmailTo(e.target.value)}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-input-border bg-input-bg text-on-surface focus-visible:ring-2 focus-visible:ring-focus-ring outline-none placeholder:text-on-surface-muted"
                    />
                  </div>
                  <input
                    type="text"
                    placeholder="Client name"
                    value={emailName}
                    onChange={(e) => setEmailName(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-input-border bg-input-bg text-on-surface focus-visible:ring-2 focus-visible:ring-focus-ring outline-none placeholder:text-on-surface-muted"
                  />
                  <textarea
                    placeholder="Message..."
                    value={emailMessage}
                    onChange={(e) => setEmailMessage(e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-input-border bg-input-bg text-on-surface focus-visible:ring-2 focus-visible:ring-focus-ring outline-none resize-none placeholder:text-on-surface-muted"
                  />
                  <div>
                    <input
                      type="email"
                      placeholder="Reply-to email"
                      value={replyToEmail}
                      onChange={(e) => setReplyToEmail(e.target.value)}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-input-border bg-input-bg text-on-surface focus-visible:ring-2 focus-visible:ring-focus-ring outline-none placeholder:text-on-surface-muted"
                    />
                    <p className="mt-1 text-xs text-on-surface-muted">Where client replies will go. Defaults to your email if left blank.</p>
                  </div>

                    <button
                      onClick={handleSendEmail}
                      disabled={!emailTo.trim() || sending || preparingFile}
                      className="w-full py-2 px-4 text-sm font-medium rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-[background-color,transform] active:scale-[0.985] motion-reduce:active:scale-100 flex items-center justify-center gap-2 cursor-pointer"
                    >
                    {sending && <Spinner />}
                    Send Email
                  </button>
                </div>
              )}

              {actionCompleted && (
                <button
                  onClick={onClose}
                  disabled={sending || copyingLink}
                  className="w-full py-2.5 px-4 text-sm font-medium rounded-lg bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed transition-[background-color,transform] active:scale-[0.985] motion-reduce:active:scale-100 cursor-pointer"
                >
                  Done
                </button>
              )}
            </>
          )}
    </Modal>

      {/* Destination picker modal */}
      <DestinationPickerModal
        isOpen={showDestinationPicker}
        onClose={() => setShowDestinationPicker(false)}
        onSelect={(path, label) => {
          setDestinationPath(path);
          setDestinationLabel(label);
        }}
        lawFirmId={lawFirmId}
        currentPath={destinationPath}
      />

      <FlattenPdfModal
        file={flattenSourceFile}
        isOpen={flattenModalOpen}
        onClose={() => setFlattenModalOpen(false)}
        onSuccess={async (flattenedFile) => {
          const prepared = await signaturesService.uploadForSigning(flattenedFile, lawFirmId);
          setPreparedSigningFile(prepared);
        }}
      />
    </>
  );
}
