'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FileSignature, LayoutTemplate } from 'lucide-react';
import ErrorNotification from '@/components/ErrorNotification';
import PageHeader from '@/components/ui/PageHeader';
import TabBar from '@/components/ui/TabBar';
import { useNavigation } from '@/contexts/NavigationContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useSigningNeedsMySignature } from '@/hooks/signatureHooks/useSigningNeedsMySignature';
import { useSigningSessionSummary } from '@/hooks/signatureHooks/useSigningSessionSummary';
import { useSigningSessions } from '@/hooks/signatureHooks/useSigningSessions';
import { useSigningTemplates } from '@/hooks/signatureHooks/useSigningTemplates';
import { useSigningWorkspace } from '@/hooks/signatureHooks/useSigningWorkspace';
import signaturesService from '@/services/signatures.service';
import { UploadCancelledError } from '@/lib/files/resumableUpload';
import FlattenPdfModal from './FlattenPdfModal';
import NeedsSignatureBanner from './NeedsSignatureBanner';
import SignActionModal from './SignActionModal';
import SignatureDropZone from './SignatureDropZone';
import SignatureSendPanel from './SignatureSendPanel';
import SigningSessionList from './SigningSessionList';
import SigningTemplateGrid from './SigningTemplateGrid';
import { getErrorMessage } from '@/lib/utils/apiErrors';

const SIGNABLE_EXTENSIONS = ['.pdf', '.docx', '.doc', '.odt', '.rtf', '.txt'];

function isSignableFile(name: string) {
  const lower = name.toLowerCase();
  return SIGNABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export type SignaturesTab = 'activity' | 'templates';

interface SignaturesWorkspaceProps {
  lawFirmId: string;
  /** Which view to open on, from the `tab` query parameter. */
  initialTab: SignaturesTab;
  /** Seeds the template search, from the `q` query parameter. */
  initialTemplateSearch?: string;
}

/**
 * The signing workspace: sending a document, the firm's signing activity, and the
 * saved templates, as two views of one page.
 *
 * The page used to stack all three - a full-width upload panel, then five recent
 * sessions, then the templates - so the templates sat at the very bottom, below
 * however much history happened to be above them, and the history itself was a
 * teaser that linked out to a near-duplicate page. Splitting activity and
 * templates into tabs gives each one the whole page and its own search, filters
 * and paging, which is what makes a firm with hundreds of sessions usable.
 *
 * Sending stays above the tabs rather than becoming a third one: it is why the
 * page gets opened, it applies to both views, and it is a single action rather
 * than a place to be.
 */
export default function SignaturesWorkspace({
  lawFirmId,
  initialTab,
  initialTemplateSearch = '',
}: SignaturesWorkspaceProps) {
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const canSend = hasPermission('signatures.send');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<SignaturesTab>(initialTab);
  const [error, setError] = useState<string | null>(null);
  const [unflattenedFile, setUnflattenedFile] = useState<File | null>(null);
  const [flattenModalOpen, setFlattenModalOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadAbortRef = useRef<AbortController | null>(null);
  // Leaving the page abandons the upload rather than letting it finish into a
  // page that is gone: finalizing would register a document nobody will see.
  useEffect(() => () => {
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
  }, []);
  const [signActionFile, setSignActionFile] = useState<
    { name: string; objectPath: string } | null
  >(null);
  const [signActionOpen, setSignActionOpen] = useState(false);

  // One request fills the four sections below on open; each then reads and
  // refreshes itself through its own query (see `useSigningWorkspace`).
  const { ready: workspaceReady } = useSigningWorkspace(lawFirmId);
  const sectionOptions = { enabled: workspaceReady };

  const {
    sessions,
    totalItems,
    loading,
    fetching,
    error: sessionsError,
    refetch: refetchSessions,
    page,
    setPage,
    rowsPerPage,
    setRowsPerPage,
    search,
    setSearch,
    statusFilter,
    setStatusFilter,
    downloadingCert,
    cancellingSession,
    downloadCertificate,
    cancelSession,
  } = useSigningSessions(lawFirmId, setError, sectionOptions);

  const { summary } = useSigningSessionSummary(lawFirmId, sectionOptions);
  const { documents: needsMySignature } = useSigningNeedsMySignature(lawFirmId, sectionOptions);
  const { templates } = useSigningTemplates(lawFirmId, sectionOptions);

  // The tab is part of the address so a view can be linked to and survives a
  // reload, but switching it is not a navigation: `navigate()` would push a route
  // change (and hold its loading indicator, which only clears on a pathname
  // change) for what is a swap of content already on the page.
  const selectTab = useCallback((next: SignaturesTab) => {
    setTab(next);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (next === 'activity') url.searchParams.delete('tab');
    else url.searchParams.set('tab', next);
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  }, []);

  const handleFile = useCallback(async (file: File) => {
    // Guards drag-and-drop too, which reaches this function directly without
    // going through the (permission-hidden) send panel button.
    if (!canSend) return;
    // One upload at a time, as the send panel's own button already enforces. A
    // file dropped mid-upload used to take over the controller, so Cancel
    // stopped only the newer upload and the first still landed afterwards.
    if (uploadAbortRef.current) return;

    if (!isSignableFile(file.name)) {
      setError('Unsupported file format. Please use PDF, DOCX, DOC, ODT, RTF, or TXT.');
      return;
    }

    setError(null);
    setUploading(true);
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    try {
      const { objectPath, fileName } = await signaturesService.uploadForSigning(file, lawFirmId, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setSignActionFile({ name: fileName, objectPath });
      setSignActionOpen(true);
    } catch (err) {
      const isCancelled =
        controller.signal.aborted ||
        err instanceof UploadCancelledError ||
        (err instanceof Error && (err.name === 'UploadCancelledError' || err.name === 'AbortError'));
      if (!isCancelled) {
        const errorMsg = getErrorMessage(err, 'Failed to upload file');
        const isUnsupportedForm =
          (err as any)?.code === 'PDF_UNSUPPORTED_FORM' ||
          /form fields we cannot prepare for signing|flatten the form/i.test(errorMsg);

        if (isUnsupportedForm) {
          setUnflattenedFile(file);
          setFlattenModalOpen(true);
          setError(null);
        } else {
          setUnflattenedFile(null);
          setError(errorMsg);
        }
      }
    } finally {
      if (uploadAbortRef.current === controller) {
        uploadAbortRef.current = null;
        setUploading(false);
      }
    }
  }, [canSend, lawFirmId]);

  const handleFlattenSuccess = useCallback(async (flattenedFile: File) => {
    setError(null);
    setUploading(true);
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    try {
      const { objectPath, fileName } = await signaturesService.uploadForSigning(flattenedFile, lawFirmId, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setError(null);
      setUnflattenedFile(null);
      setSignActionFile({ name: fileName, objectPath });
      setSignActionOpen(true);
    } catch (err) {
      // Cancelled by the user, which is not a failure to report.
      if (controller.signal.aborted || err instanceof UploadCancelledError) return;
      setError(getErrorMessage(err, 'Failed to upload flattened file'));
    } finally {
      if (uploadAbortRef.current === controller) {
        uploadAbortRef.current = null;
        setUploading(false);
      }
    }
  }, [lawFirmId]);

  const cancelUpload = useCallback(() => {
    if (uploadAbortRef.current) {
      uploadAbortRef.current.abort();
      uploadAbortRef.current = null;
    }
    setUploading(false);
  }, []);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const signNow = useCallback(
    (token: string) => navigate(`/signature?token=${encodeURIComponent(token)}`),
    [navigate]
  );

  return (
    <SignatureDropZone onFile={handleFile} extensions={SIGNABLE_EXTENSIONS}>
      <div className="min-h-screen bg-page">
        <div className="mx-auto min-w-0 max-w-[1600px] space-y-5 p-4 pl-5 md:p-6">
          <PageHeader
            eyebrow="eSignature"
            title="Document Signing"
            description="Everything your firm has sent for signature, and the templates you reuse."
          />

          <input
            ref={fileInputRef}
            type="file"
            accept={SIGNABLE_EXTENSIONS.join(',')}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) handleFile(file);
              event.target.value = '';
            }}
          />
          {/* Above sending: this is the one thing on the page that needs the
              signed-in member's own action, so it outranks the generic send CTA. */}
          {tab === 'activity' && (
            <NeedsSignatureBanner documents={needsMySignature} onSign={signNow} />
          )}

          {/* Above the tabs: sending is why the page gets opened, and it is the
              same action whichever view is showing. */}
          {canSend && (
            <SignatureSendPanel
              onClick={openFilePicker}
              uploading={uploading}
              onCancel={cancelUpload}
              extensions={SIGNABLE_EXTENSIONS}
            />
          )}

          <ErrorNotification error={error} onClose={() => setError(null)} />

          <TabBar
            value={tab}
            onChange={selectTab}
            tabs={[
              { value: 'activity', label: 'Signing activity', icon: FileSignature, count: summary.total },
              { value: 'templates', label: 'Templates', icon: LayoutTemplate, count: templates.length },
            ]}
          />

          {tab === 'activity' && (
            <ErrorNotification
              error={sessionsError}
              onRetry={() => refetchSessions()}
              retrying={fetching}
            />
          )}

          {tab === 'activity' ? (
            <SigningSessionList
              lawFirmId={lawFirmId}
              sessions={sessions}
              totalItems={totalItems}
              summary={summary}
              isLoading={!workspaceReady || loading}
              isFetching={fetching}
              search={search}
              onSearchChange={setSearch}
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
              page={page}
              rowsPerPage={rowsPerPage}
              onPageChange={setPage}
              onRowsPerPageChange={setRowsPerPage}
              onDownloadCertificate={downloadCertificate}
              onCancelSession={cancelSession}
              onSignNow={signNow}
              downloadingCert={downloadingCert}
              cancellingSession={cancellingSession}
            />
          ) : (
            <SigningTemplateGrid lawFirmId={lawFirmId} initialSearch={initialTemplateSearch} />
          )}

          {/* Kept mounted so its close animation plays; `signActionFile` holds the
              document so the dialog still has content on the way out. */}
          {signActionFile && (
            <SignActionModal
              isOpen={signActionOpen}
              onClose={() => setSignActionOpen(false)}
              fileName={signActionFile.name}
              objectPath={signActionFile.objectPath}
              lawFirmId={lawFirmId}
            />
          )}

          <FlattenPdfModal
            file={unflattenedFile}
            isOpen={flattenModalOpen}
            onClose={() => {
              setFlattenModalOpen(false);
              setUnflattenedFile(null);
            }}
            onSuccess={handleFlattenSuccess}
          />
        </div>
      </div>
    </SignatureDropZone>
  );
}
