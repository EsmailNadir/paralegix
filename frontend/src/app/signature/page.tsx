'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { Clock, FileCheck, Lock, Shield } from 'lucide-react';
import type { PDFAnnotatorProps } from '@/components/signaturesComp/PDFAnnotator';
import type { SignatureField } from '@/types/signature';
import signaturesService from '@/services/signatures.service';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useRefreshingReadUrl } from '@/hooks/useRefreshingReadUrl';
import InvalidLinkPage from '@/components/ui/InvalidLinkPage';
import UnexpectedErrorPage from '@/components/ui/UnexpectedErrorPage';
import { getErrorMessage } from '@/lib/utils/apiErrors';

// The ?fileUrl= param is attacker-controllable (anyone can craft a /signature link),
// so the page must not fetch an arbitrary URL on the victim's behalf. Allow only
// local blob:/data: URLs, same-origin, and the known object-storage hosts where
// signing documents actually live.
const ALLOWED_SIGNATURE_FILE_HOSTS = ['storage.googleapis.com'];
try {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
    ALLOWED_SIGNATURE_FILE_HOSTS.push(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host);
  }
} catch {
  // Malformed env URL: keep the storage hosts.
}

function isAllowedSignatureFileUrl(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl, window.location.origin);
  } catch {
    return false;
  }
  if (u.protocol === 'blob:' || u.protocol === 'data:') return true;
  if (u.protocol !== 'https:') return false;
  if (u.origin === window.location.origin) return true;
  return ALLOWED_SIGNATURE_FILE_HOSTS.some((h) => u.host === h || u.host.endsWith('.' + h));
}

const PDFAnnotator = dynamic(
  () => import('@/components/signaturesComp/PDFAnnotator'),
  { ssr: false }
);

const SignatureFieldPlacer = dynamic(
  () => import('@/components/signaturesComp/SignatureFieldPlacer'),
  { ssr: false }
);

const RestrictedSigningView = dynamic(
  () => import('@/components/signaturesComp/RestrictedSigningView'),
  { ssr: false }
);

const InPersonSigningFlow = dynamic(
  () => import('@/components/signaturesComp/InPersonSigningFlow'),
  { ssr: false }
);

const AccessCodeGate = dynamic(
  () => import('@/components/signaturesComp/AccessCodeGate'),
  { ssr: false }
);

/** Navigate back to the signatures page for the law firm */
function navigateBack(lawFirmId?: string | null) {
  window.location.href = lawFirmId ? `/lawfirm/${lawFirmId}/signatures` : '/dashboard';
}

function SignaturePageContent({ onReady }: { onReady: () => void }) {
  const searchParams = useSearchParams();

  // Token-based loading (shared signing links)
  const token = searchParams.get('token');

  // Direct file loading (sign yourself, designate mode)
  const fileUrl = searchParams.get('fileUrl');
  const fileName = searchParams.get('fileName');
  const objectPath = searchParams.get('objectPath');
  const mode = searchParams.get('mode'); // 'designate' = field placement mode
  const lawFirmId = searchParams.get('lawFirmId');
  const templateId = searchParams.get('templateId');

  // Destination overrides from URL params (designate mode without a session)
  const urlDestinationPath = searchParams.get('destinationPath');
  const urlDestinationLabel = searchParams.get('destinationLabel');

  const [preloadedFile, setPreloadedFile] = useState<PDFAnnotatorProps['file'] | undefined>(undefined);
  const [loading, setLoading] = useState(!!fileUrl || !!token || !!objectPath);
  const [error, setError] = useState<string | null>(null);

  // For token-based sessions: metadata from the backend
  const [designatedFields, setDesignatedFields] = useState<SignatureField[] | null>(null);
  const [sessionObjectPath, setSessionObjectPath] = useState<string | null>(null);
  const [sessionLawFirmId, setSessionLawFirmId] = useState<string | null>(null);
  const [sessionDestinationPath, setSessionDestinationPath] = useState<string | null>(null);
  const [sessionDestinationLabel, setSessionDestinationLabel] = useState<string | null>(null);
  const [participantStatus, setParticipantStatus] = useState<string | null>(null);
  const [participantRole, setParticipantRole] = useState<string | null>(null);
  const [participantName, setParticipantName] = useState<string | null>(null);
  const [participantDeliveryMethod, setParticipantDeliveryMethod] = useState<string | null>(null);
  const [activeSignerName, setActiveSignerName] = useState<string | null>(null);
  const [activeSignerRole, setActiveSignerRole] = useState<string | null>(null);
  const [facilitatedSigning, setFacilitatedSigning] = useState(false);
  const [sessionTotalParticipants, setSessionTotalParticipants] = useState<number>(0);
  const [sessionEmailSignersOnComplete, setSessionEmailSignersOnComplete] = useState(false);
  const [participantOrder, setParticipantOrder] = useState<number>(0);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<string | null>(null);

  // Email verification gate state

  // Access code gate state
  const [needsAccessCode, setNeedsAccessCode] = useState(false);
  const [accessCodeFileName, setAccessCodeFileName] = useState('');
  const [sourceRevision, setSourceRevision] = useState<string | null>(null);

  const refreshDocumentUrl = useCallback(async () => {
    if (token) return (await signaturesService.getSigningReadMetadata(token)).url;
    if (objectPath) return (await signaturesService.getPreviewReadMetadata(objectPath, lawFirmId)).url;
    throw new Error('This document cannot be refreshed.');
  }, [token, objectPath, lawFirmId]);
  const refreshingDocument = useRefreshingReadUrl({
    url: preloadedFile?.url || null,
    enabled: !!preloadedFile && (!!token || !!objectPath),
    refresh: refreshDocumentUrl,
  });
  const displayedFile = preloadedFile && refreshingDocument.readUrl
    ? { ...preloadedFile, url: refreshingDocument.readUrl }
    : preloadedFile;

  const loadSessionFile = useCallback(async (session: {
    publicToken?: string | null;
    fileName: string;
    facilitatedSigning?: boolean;
  }) => {
    const fileToken = session.facilitatedSigning ? token! : (session.publicToken || token!);

    const sessionFileName = session.fileName || 'document.pdf';
    // A session's source is a PDF: it was admitted as one, or converted to one
    // before the session existed. Asking the API to convert it here would be
    // asking it to fix something it already refused to accept.
    const read = await signaturesService.getSigningReadMetadata(fileToken);

    return { url: read.url, name: read.fileName || sessionFileName };
  }, [token]);

  type SigningSession = Awaited<ReturnType<typeof signaturesService.getSigningSession>>;

  // Apply a freshly-loaded session's participant/signer fields to component
  // state. Shared by the initial loader and both gate handlers so the mapping
  // lives in one place.
  const applyParticipantState = useCallback((session: SigningSession) => {
    setParticipantStatus(session.participantStatus || null);
    setParticipantRole(session.participantRole || null);
    setParticipantName(session.participantName || null);
    setParticipantDeliveryMethod(session.participantDeliveryMethod || null);
    setActiveSignerName(session.activeSignerName || null);
    setActiveSignerRole(session.activeSignerRole || null);
    setFacilitatedSigning(!!session.facilitatedSigning);
    setSessionExpiresAt(session.expiresAt ?? null);
    setSessionEmailSignersOnComplete(!!session.emailSignersOnComplete);
  }, []);

  // Load + render the document referenced by a session once all gates are
  // cleared. Shared by the gate handlers.
  const loadDocumentFromSession = useCallback(async (session: SigningSession) => {
    setSourceRevision(session.sourceRevision || null);
    const file = await loadSessionFile(session);
    setPreloadedFile({ url: file.url, name: file.name });
    setSessionObjectPath(session.objectPath || null);
    setSessionLawFirmId(session.lawFirmId || null);
    if (session.destinationPath) setSessionDestinationPath(session.destinationPath);
    if (session.destinationLabel) setSessionDestinationLabel(session.destinationLabel);
    if (session.fields && session.fields.length > 0) setDesignatedFields(session.fields);
  }, [loadSessionFile]);

  // Token-based loading: fetch session metadata + file from backend proxy
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    async function attempt() {
      const session = await signaturesService.getSigningSession(token!);
      if (session.sourceRevision) {
        setSourceRevision(session.sourceRevision);
      }

      // If access code is required and not yet verified, return early
      if (session.requiresAccessCode && !session.accessCodeVerified) {
        return { session, file: null, needsAccessCodeGate: true };
      }

      if (session.participantStatus && session.participantStatus !== 'active') {
        return { session, file: null, needsAccessCodeGate: false };
      }

      const file = await loadSessionFile(session);

      return { session, file, needsAccessCodeGate: false };
    }

    async function loadFromToken() {
      try {
        let result;
        try {
          result = await attempt();
        } catch (firstErr) {
          // Only retry on transient/network failures. A missing or invalid
          // link (404/410/4xx) won't recover, so retrying just re-downloads the
          // PDF for nothing. ApiError carries a numeric `status`; treat
          // network-unreachable (status 0/undefined) and 5xx as transient.
          const status = (firstErr as { status?: number })?.status;
          const isTransient = status === undefined || status === 0 || status >= 500;
          if (!isTransient) throw firstErr;
          await new Promise((r) => setTimeout(r, 2000));
          if (cancelled) return;
          result = await attempt();
        }

        const { session, file, needsAccessCodeGate } = result!;

        applyParticipantState(session);
        setSessionTotalParticipants(session.totalParticipants || 0);
        setParticipantOrder(session.completedParticipants ? (session.completedParticipants + 1) : 1);

        // Show access code gate first (out-of-band)
        if (needsAccessCodeGate) {
          if (cancelled) return;
          setNeedsAccessCode(true);
          // The file name is withheld pre-verification, so it may be absent here.
          setAccessCodeFileName(session.fileName || '');
          return;
        }

        if (session.participantStatus && session.participantStatus !== 'active') {
          return;
        }

        if (cancelled || !file) return;

        setPreloadedFile({ url: file.url, name: file.name });
        setSessionObjectPath(session.objectPath || null);
        setSessionLawFirmId(session.lawFirmId || null);
        if (session.destinationPath) setSessionDestinationPath(session.destinationPath);
        if (session.destinationLabel) setSessionDestinationLabel(session.destinationLabel);

        if (session.fields && session.fields.length > 0) {
          setDesignatedFields(session.fields);
        }
      } catch (err) {
        if (!cancelled) {
          setError(getErrorMessage(err, 'Failed to load document'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadFromToken();
    return () => { cancelled = true; };
  }, [loadSessionFile, token, applyParticipantState]);

  // Direct file loading (sign yourself / designate mode)
  useEffect(() => {
    if (!fileUrl || !fileName || token) return;
    let cancelled = false;

    async function loadFile() {
      if (!isAllowedSignatureFileUrl(fileUrl!)) {
        if (!cancelled) {
          setError('This document URL is not allowed.');
          setLoading(false);
        }
        return;
      }
      if (cancelled) return;
      // The url arrived already signed, from the files page. It is handed on as
      // it is. Fetching it here would put the whole document in the tab to
      // build a blob url for a viewer that reads ranges from a url on its own.
      setPreloadedFile({ url: fileUrl!, name: fileName! });
      setLoading(false);
    }

    loadFile();
    return () => { cancelled = true; };
  }, [fileUrl, fileName, token]);

  // ObjectPath-based loading (designate mode and self-sign). The modal has
  // already uploaded, converted and admitted the document, so the API only has
  // to authorize the caller and answer with a url. It no longer streams bytes.
  useEffect(() => {
    if (!objectPath || !fileName || token || fileUrl) return;
    let cancelled = false;

    async function loadFromObjectPath() {
      try {
        const read = await signaturesService.getPreviewReadMetadata(objectPath!, lawFirmId);
        if (cancelled) return;
        // `read.fileName` is derived from the opaque storage path and may be a
        // UUID. The explicit query value is the user-facing name selected in
        // the file browser (or returned by conversion), so it owns the label.
        setPreloadedFile({ url: read.url, name: fileName! });
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, 'Failed to load document'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadFromObjectPath();
    return () => { cancelled = true; };
  }, [objectPath, fileName, token, fileUrl, lawFirmId]);

  // Signal parent that content is ready (no more loading)
  useEffect(() => {
    if (!loading) onReady();
  }, [loading, onReady]);

  // Handle access code verification. One session GET is required here because
  // the access-code verify call changed server-side state; it's deduped at the
  // service layer. (A future backend change could return the refreshed session
  // from the verify endpoint to drop this GET entirely.)
  const handleAccessCodeVerified = useCallback(() => {
    setNeedsAccessCode(false);
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const session = await signaturesService.getSigningSession(token!);
        applyParticipantState(session);

        if (session.participantStatus && session.participantStatus !== 'active') {
          return;
        }

        // Gate cleared, load the document
        await loadDocumentFromSession(session);
      } catch (err) {
        setError(getErrorMessage(err, 'Failed to load document'));
      } finally {
        setLoading(false);
      }
    })();
  }, [token, applyParticipantState, loadDocumentFromSession]);

  // Pull the latest session and apply it in place. When the turn has arrived the
  // document is fetched FIRST and the active status is flipped last, so the
  // signing view swaps in seamlessly without a full page reload (a reload would
  // re-run the access-code gate flow the signer already cleared). For a
  // non-active state (still waiting, or a terminal cancelled/declined/completed)
  // it just applies the new status, which renders the matching screen.
  const refreshSession = useCallback(async () => {
    const session = await signaturesService.getSigningSession(token!);
    if (session.participantStatus === 'active') {
      await loadDocumentFromSession(session);
      setSessionTotalParticipants(session.totalParticipants || 0);
      setParticipantOrder(session.completedParticipants ? session.completedParticipants + 1 : 1);
    }
    applyParticipantState(session);
  }, [token, applyParticipantState, loadDocumentFromSession]);

  // Poll for this participant's turn while they wait. Public token signers can't
  // use Realtime, so we poll the lightweight status endpoint (one cheap query,
  // no writes). The delay backs off 90s → 5min and the loop stops once the
  // session passes its expiry, so an abandoned tab doesn't poll indefinitely.
  useEffect(() => {
    if (!token || participantStatus !== 'waiting') return;

    const MIN_DELAY = 90_000;
    const MAX_DELAY = 5 * 60_000;
    let delay = MIN_DELAY;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const expiryMs = sessionExpiresAt ? new Date(sessionExpiresAt).getTime() : NaN;

    const tick = async () => {
      if (stopped) return;
      // Past expiry: stop scheduling. An abandoned tab goes quiet rather than
      // polling a session that can no longer be signed.
      if (!Number.isNaN(expiryMs) && Date.now() > expiryMs) return;
      // Skip the request while the tab is backgrounded, but keep the loop alive.
      if (typeof document === 'undefined' || !document.hidden) {
        try {
          const status = await signaturesService.getSigningStatus(token);
          if (status.participantStatus && status.participantStatus !== 'waiting') {
            // Turn arrived (or a terminal state), refetch and apply in place.
            // The effect tears down once participantStatus changes, so don't
            // reschedule here.
            await refreshSession();
            return;
          }
        } catch {
          // Ignore transient errors; keep polling.
        }
      }
      if (stopped) return;
      delay = Math.min(delay * 1.5, MAX_DELAY);
      timer = setTimeout(tick, delay);
    };

    timer = setTimeout(tick, delay);
    return () => { stopped = true; clearTimeout(timer); };
  }, [participantStatus, token, sessionExpiresAt, refreshSession]);

  if (loading) return null;

  // Show access code gate first (out-of-band, harder gate)
  if (needsAccessCode && token) {
    return (
      <AccessCodeGate
        token={token}
        fileName={accessCodeFileName}
        onVerified={handleAccessCodeVerified}
      />
    );
  }

  if (error) {
    const looksLikeInvalidLink = token && /(404|not found|expired|invalid|session)/i.test(error);

    if (looksLikeInvalidLink) {
      return (
        <InvalidLinkPage
          title="This signing link is no longer valid"
          description={error}
          primaryAction={{
            label: "Back home",
            href: "/",
          }}
        />
      );
    }

    return (
      <UnexpectedErrorPage
        title="We couldn't open this signing session"
        description="The document or signing workspace failed to load completely."
        onRetry={() => window.location.reload()}
        details={error}
        secondaryHref="/"
      />
    );
  }

  if (token && participantStatus && participantStatus !== 'active') {
    if (participantStatus === 'waiting') {
      return (
        <div className="flex-1 flex items-center justify-center p-6">
          <div
            role="status"
            aria-live="polite"
            className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6"
          >
            <Clock size={40} className="text-on-surface-muted mb-4 animate-pulse" />
            <h2 className="text-lg font-semibold text-on-surface mb-2">Waiting for Your Turn</h2>
            <p className="text-sm text-on-surface-secondary max-w-md">
              This document requires signatures in order.
              {sessionTotalParticipants > 0 && ` You are signer ${participantOrder} of ${sessionTotalParticipants}.`}
              {' '}We&apos;ll notify you when it&apos;s your turn.
            </p>
            <p className="text-xs text-on-surface-muted mt-4">This page refreshes automatically.</p>
          </div>
        </div>
      );
    }

    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div role="status" aria-live="polite" className="text-center max-w-md space-y-3">
          <h2 className="text-xl font-semibold text-on-surface">
            {participantStatus === 'completed' ? 'Your Signature Is Complete' : 'Signing Session Unavailable'}
          </h2>
          <p className="text-sm text-on-surface-muted">
            {participantStatus === 'completed'
              ? `${participantRole || 'This signer'} has already completed their turn.`
              : 'This signing session is no longer available for you to edit.'}
          </p>
        </div>
      </div>
    );
  }

  // Designate mode: lawyer places signature fields on the document
  // objectPath/lawFirmId can come from query params (direct) or from the signing session (token-based)
  const resolvedObjectPath = objectPath || sessionObjectPath;
  const resolvedLawFirmId = lawFirmId || sessionLawFirmId;

  if (mode === 'designate' && displayedFile && resolvedLawFirmId && resolvedObjectPath) {
    return (
      <SignatureFieldPlacer
        file={displayedFile}
        lawFirmId={resolvedLawFirmId}
        objectPath={resolvedObjectPath}
        templateId={templateId || undefined}
        onBack={() => navigateBack(resolvedLawFirmId)}
        initialDestinationPath={urlDestinationPath || sessionDestinationPath || undefined}
        initialDestinationLabel={urlDestinationLabel || sessionDestinationLabel || undefined}
      />
    );
  }

  // Token-based session with designated fields: restricted signing view
  if (token && designatedFields && designatedFields.length > 0 && displayedFile) {
    if (participantDeliveryMethod === 'in_person' || facilitatedSigning) {
      return (
        <InPersonSigningFlow
          file={displayedFile}
          fields={designatedFields}
          token={token}
          sourceRevision={sourceRevision}
          signerName={participantName || activeSignerName}
          signerRole={participantRole || activeSignerRole}
        />
      );
    }

    return (
      <div className="flex flex-col min-h-screen">
        <div className="text-center py-2">
          <p className="text-xs text-on-surface-muted">
            Powered by Paralegix &middot; Secure Electronic Signatures
          </p>
        </div>
        <RestrictedSigningView
          file={displayedFile}
          fields={designatedFields}
          token={token}
          sourceRevision={sourceRevision}
          totalParticipants={sessionTotalParticipants}
          emailSignersOnComplete={sessionEmailSignersOnComplete}
        />
        <div className="mt-auto py-4 flex items-center justify-center gap-4 text-xs text-on-surface-muted">
          <div className="flex items-center gap-1.5">
            <Shield size={14} />
            <span>256-bit encrypted</span>
          </div>
          <div className="w-px h-3 bg-outline" />
          <div className="flex items-center gap-1.5">
            <Lock size={14} />
            <span>Digitally sealed</span>
          </div>
          <div className="w-px h-3 bg-outline" />
          <div className="flex items-center gap-1.5">
            <FileCheck size={14} />
            <span>Tamper-evident</span>
          </div>
        </div>
      </div>
    );
  }

  if (!displayedFile) {
    return (
      <UnexpectedErrorPage
        title="We couldn't prepare this document"
        description="The signing page loaded, but there was no document ready to display."
        onRetry={() => window.location.reload()}
        secondaryHref="/"
      />
    );
  }

  // Default: full annotator (open signing)
  return (
    <PDFAnnotator
      file={displayedFile}
      onChangeFile={() => navigateBack(resolvedLawFirmId)}
      token={token || undefined}
      sourceRevision={sourceRevision}
    />
  );
}

export default function SignaturePage() {
  const [ready, setReady] = useState(false);
  const handleReady = useCallback(() => setReady(true), []);

  return (
    <>
      {!ready && (
        <div className="flex-1 flex items-center justify-center">
          <LoadingSpinner />
        </div>
      )}
      <div style={ready ? undefined : { visibility: 'hidden', position: 'absolute' }}>
        <Suspense fallback={null}>
          <SignaturePageContent onReady={handleReady} />
        </Suspense>
      </div>
    </>
  );
}
