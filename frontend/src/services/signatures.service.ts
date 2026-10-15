import { apiFetch, publicFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { REQUEST_TIMEOUT_MS } from '@/lib/constants/requestTimeouts';
import {
  toApiError,
  ApiError,
  isApiError,
  NETWORK_UNREACHABLE_CODE,
  REQUEST_TIMEOUT_CODE,
} from '@/lib/utils/apiErrors';
import { retryWhileBusy } from '@/lib/utils/busyRetry';
import { uploadResumable, UploadCancelledError, UploadSessionGoneError } from '@/lib/files/resumableUpload';
import {
  saveUploadSession,
  loadUploadSession,
  clearUploadSession,
  uploadSessionKey,
  type UploadDestination,
  type FileIdentity,
} from '@/lib/files/uploadSessionStore';
import { fingerprintFile } from '@/lib/files/fileFingerprint';
import { claimUploadSession } from '@/lib/files/uploadOwnership';
import { runWithUploadLimit } from '@/lib/files/uploadConcurrency';
import { getFirebaseUid } from '@/lib/utils/auth';
import requestDeduplicator from './requestDeduplicator';
import { authenticatedHeaders } from './base.service';
import type {
  RoutingMode,
  SignatureField,
  SigningFieldValue,
  SigningParticipant,
  SigningRecipient,
  SigningSessionSummary,
  SigningTemplate,
} from '@/types/signature';


/** What `/signing/upload-init` hands back for one PDF. */
interface SigningUploadSession {
  objectPath: string;
  fileName: string;
  uploadUrl: string;
}

/**
 * How a signing upload is driven from the page.
 *
 * All optional, so the existing call sites are unchanged. `chunkSize` and
 * `retryDelaysMs` exist for tests: a spec must be able to force a multi-chunk
 * transfer, or exhaust the retry budget, without waiting out a schedule that
 * represents a minute of real patience.
 */
export interface SigningUploadOptions {
  /** 0-100, monotonic, and only 100 once the API has vouched for the object. */
  onProgress?: (percent: number) => void;
  /** Stops the upload. Rejects with `UploadCancelledError`. */
  signal?: AbortSignal;
  chunkSize?: number;
  retryDelaysMs?: number[];
}

/**
 * What a signing completion answers with: the backend's `completionBody`.
 * `state` is the field to switch on; `consentRecorded` says the signature
 * landed even when the executed document is not ready yet.
 */
export interface SigningCompletionResult {
  success: boolean;
  state?: string;
  completed?: boolean;
  waitingForNextSigner?: boolean;
  nextSignerName?: string | null;
  consentRecorded?: boolean;
}

/**
 * A completion that got no answer: the gateway gave up (504), the client's
 * deadline ran out, or the connection dropped. Each says nothing about whether
 * the server recorded the signature, which it may well have.
 */
function isUncertainCompletionFailure(error: unknown): boolean {
  if (!isApiError(error)) return false;
  return error.status === 504
    || error.code === REQUEST_TIMEOUT_CODE
    || error.code === NETWORK_UNREACHABLE_CODE;
}

/**
 * A completion refused because this signer, or the whole document, is already
 * recorded as complete. A same-key retry that reaches the consent write while
 * the request it repeats still holds the row lock is answered this way rather
 * than with the replay, so on its own it does not mean the signature failed.
 */
function isAlreadyCompletedConflict(error: unknown): boolean {
  if (!isApiError(error) || error.status !== 409) return false;
  return /already completed their turn|already been completed/i.test(error.message);
}

/**
 * How long a recovery waits before re-reading the status and sending the
 * completion again. The request that got no answer may still be running, and a
 * retry that arrives while it holds the consent row loses with a 409.
 */
const COMPLETION_RETRY_SETTLE_MS = 1500;

/**
 * Session states in which a recorded signature will never be sealed into an
 * executed document, so the signer has to be pointed at the sender.
 */
const UNSEALABLE_SESSION_STATUSES = new Set(['cancelled', 'expired']);

class SignaturesService {
  private baseApi: string;

  constructor() {
    this.baseApi = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
  }

  private normalizeSigningLink(link: string | undefined | null): string {
    if (!link) return '';

    if (typeof window === 'undefined') {
      return link;
    }

    try {
      const parsed = new URL(link);
      return `${window.location.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return link;
    }
  }

  private async authHeaders(
    extra: Record<string, string> = {},
    { json = true }: { json?: boolean } = {},
  ) {
    return authenticatedHeaders(
      json ? { 'Content-Type': 'application/json', ...extra } : extra,
      { requireToken: true },
    );
  }

  /**
   * Resolve a stored firm document into a signing-ready PDF server-side.
   * Non-PDFs are converted (and PDFs frozen) in storage without the bytes ever
   * travelling through the browser; the returned objectPath is what every
   * signing flow should be handed.
   */
  async prepareForSigning(
    lawFirmId: string,
    objectPath: string,
    fileName: string,
    requireFlatteningConfirmation = false,
  ): Promise<{ objectPath: string; fileName: string }> {
    const headers = await this.authHeaders();
    const response = await apiFetch(
      `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/signature-links/prepare`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ objectPath, fileName, requireFlatteningConfirmation }),
      }
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to prepare document for signing');
    }

    return response.json();
  }

  async generateLink(
    lawFirmId: string,
    objectPath: string,
    fileName: string,
    fields?: SignatureField[],
    signers?: SigningParticipant[],
    destinationPath?: string,
    destinationLabel?: string,
    clientId?: string,
    accessCode?: string,
    routingMode?: RoutingMode,
    emailSignersOnComplete?: boolean
  ): Promise<{ link: string; token: string; sessionToken?: string }> {
    const headers = await this.authHeaders();
    const response = await apiFetch(
      `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/signature-links/generate`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          objectPath,
          fileName,
          fields: fields || undefined,
          signers: signers || undefined,
          destinationPath: destinationPath || undefined,
          destinationLabel: destinationLabel || undefined,
          clientId: clientId || undefined,
          accessCode: accessCode || undefined,
          routingMode: routingMode || undefined,
          emailSignersOnComplete: emailSignersOnComplete || undefined,
        }),
      }
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to generate signing link');
    }

    const result = await response.json();
    return {
      ...result,
      link: this.normalizeSigningLink(result.link),
    };
  }

  async sendSigningEmail(
    lawFirmId: string,
      data: {
        recipientEmail: string;
        recipientName?: string;
        objectPath: string;
        fileName: string;
        fields?: SignatureField[];
        message?: string;
        replyToEmail?: string;
        destinationPath?: string;
        destinationLabel?: string;
        accessCode?: string;
        routingMode?: RoutingMode;
        emailSignersOnComplete?: boolean;
      }
  ): Promise<{ sent: boolean; messageId?: string; sessionToken?: string }> {
    const headers = await this.authHeaders();
    const response = await apiFetch(
      `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/signature-links/send-email`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(data),
      }
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to send signing email');
    }

    return response.json();
  }

  async sendSigningRequest(
    lawFirmId: string,
    data: {
      objectPath: string;
      fileName: string;
      // Optional only for a single signer, who may sign without placed fields.
      fields?: SignatureField[];
      signers: SigningParticipant[];
      routingMode?: RoutingMode;
      message?: string;
      replyToEmail?: string;
      destinationPath?: string;
      destinationLabel?: string;
      emailSignersOnComplete?: boolean;
    }
  ): Promise<{ sent: boolean; sessionToken: string; firstParticipantToken?: string | null; copyLinks?: { participantId: string; name: string; link: string }[] }> {
    const headers = await this.authHeaders();
    const response = await apiFetch(
      `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/signature-links/send`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(data),
      }
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to send signing request');
    }

    const result = await response.json();
    return {
      ...result,
      copyLinks: Array.isArray(result.copyLinks)
        ? result.copyLinks.map((entry: { participantId: string; name: string; link: string }) => ({
            ...entry,
            link: this.normalizeSigningLink(entry.link),
          }))
        : result.copyLinks,
    };
  }

  /**
   * Addressable recipients for an account-backed (portal / internal-dashboard)
   * signing request: person clients AND company roster contacts, blended into
   * one typed list. Deliberately separate from `clientsService.lookupClients`,
   * whose `portalOnly` filter only tests `clients.user_id` and so cannot see a
   * company's roster contacts at all.
   */
  async listSigningRecipients(
    lawFirmId: string,
    params: { search?: string; clientId?: string; limit?: number } = {}
  ): Promise<{ items: SigningRecipient[]; hasMore: boolean }> {
    const headers = await this.authHeaders();
    const query = new URLSearchParams();
    if (params.search) query.set('search', params.search);
    if (params.clientId) query.set('clientId', params.clientId);
    if (params.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return requestDeduplicator.execute(
      `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/signature-links/recipients${qs ? `?${qs}` : ''}`,
      { headers }
    );
  }

  /** Try to get a Firebase auth token for optional auth on public endpoints */
  private async optionalAuthHeaders(): Promise<Record<string, string>> {
    try {
      return await authenticatedHeaders();
    } catch {
      // Anonymous signing, no token available
    }
    return {};
  }

  /** Verify an access code for a signing session (public) */
  async verifyAccessCode(token: string, code: string): Promise<{
    verified: boolean;
    error?: string;
    attemptsRemaining?: number;
    lockedSeconds?: number;
  }> {
    const response = await publicFetch(`${this.baseApi}/signing/${encodeURIComponent(token)}/verify-access-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        verified: false,
        error: data?.error || 'Verification failed',
        attemptsRemaining: data?.attemptsRemaining,
        lockedSeconds: data?.lockedSeconds,
      };
    }

    return { verified: true };
  }

  /** Fetch signing session metadata (public, optional auth) */
  async getSigningSession(token: string): Promise<{
    fileName: string;
    fields?: SignatureField[] | null;
    objectPath?: string;
    lawFirmId?: string;
    destinationPath?: string | null;
    destinationLabel?: string | null;
    status: string;
    maskedEmail?: string;
    requiresAccessCode?: boolean;
    accessCodeVerified?: boolean;
    participantStatus?: string | null;
    participantRole?: string | null;
    participantName?: string | null;
    participantDeliveryMethod?: string | null;
    activeSignerName?: string | null;
    activeSignerRole?: string | null;
    completedParticipants?: number;
    totalParticipants?: number;
    routingMode?: string;
    emailSignersOnComplete?: boolean;
    publicToken?: string | null;
    facilitatedSigning?: boolean;
    // ISO session expiry (7-day TTL). Used to stop the waiting-screen poll once
    // the session can no longer be acted on.
    expiresAt?: string | null;
    // Item 1: returned when a CONSUMED single-use link is reloaded by a signer
    // who already completed. Lets the page show the "complete" state instead of
    // the generic invalid-link screen.
    alreadySigned?: boolean;
    // Revision fingerprint of the document and fields the signer was shown.
    sourceRevision?: string | null;
  }> {
    const headers = await this.optionalAuthHeaders();
    // Route through requestDeduplicator so concurrent callers (e.g. gate
    // handlers + the page loader) share a single in-flight GET.
    return requestDeduplicator.execute(
      `${this.baseApi}/signing/${encodeURIComponent(token)}`,
      { headers }
    );
  }

  /**
   * Lightweight status poll for a signing session (public, optional auth).
   * Returns only status counters (no full session load and no writes) so it
   * is cheap to poll while a participant waits for their turn.
   */
  async getSigningStatus(token: string): Promise<{
    sessionStatus: string;
    participantStatus: string | null;
    totalParticipants: number;
    completedParticipants: number;
  }> {
    const headers = await this.optionalAuthHeaders();
    return requestDeduplicator.execute(
      `${this.baseApi}/signing/${encodeURIComponent(token)}/status`,
      { headers }
    );
  }

  /**
   * A short-lived, generation-pinned read url for a document the caller may
   * preview without a signing session.
   *
   * The API used to stream the object through itself here. It answers with a
   * link instead, so the viewer reads the ranges it needs and the document is
   * never resident in the tab or in the container.
   */
  async getPreviewReadMetadata(objectPath: string, lawFirmId?: string | null): Promise<{
    url: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    generation: string;
    expiresAt: string;
  }> {
    const query = new URLSearchParams({ objectPath });
    if (lawFirmId) query.set('lawFirmId', lawFirmId);
    const response = await apiFetch(
      `${this.baseApi}/signing/preview-url?${query.toString()}`,
      { headers: await this.authHeaders() },
    );
    if (!response.ok) throw await toApiError(response, 'Failed to open the document');
    return response.json();
  }

  /** Get the endpoint that mints a short-lived storage URL for a signing session. */
  getSigningFileUrl(token: string): string {
    return `${this.baseApi}/signing/${encodeURIComponent(token)}/file`;
  }

  /**
   * Get the generation-pinned storage read URL and metadata for a signing session.
   * Enables pdfjs-dist range requests directly against GCS without pulling the entire
   * document into browser heap.
   */
  async getSigningReadMetadata(
    token: string,
    disposition: 'inline' | 'attachment' = 'inline'
  ): Promise<{
    url: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    generation: string;
    expiresAt: string;
  }> {
    const headers = await this.optionalAuthHeaders();
    const query = new URLSearchParams();
    if (disposition) query.set('disposition', disposition);
    const qs = query.toString();
    const endpoint = `${this.getSigningFileUrl(token)}${qs ? `?${qs}` : ''}`;
    const opened = await publicFetch(endpoint, { headers });
    if (!opened.ok) {
      throw await toApiError(opened, 'Failed to open signing document');
    }
    const body = await opened.json() as {
      url: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
      generation: string;
      expiresAt: string;
    };
    if (!body.url) throw new Error('The signing service did not return a read URL.');
    return body;
  }

  /**
   * Convert a document to another format (authenticated, firm-side).
   *
   * Three steps, because conversion used to send the file to the API and the
   * result back through it: a 100 MB input and its output resident at once in a
   * container serving many callers. The browser now PUTs to storage, the worker
   * converts storage to storage, and the browser fetches the result from a
   * signed url. The bytes still end up here, which is what the caller needs
   * them for; they no longer pass through the API.
   *
   * `uploadResumable` is the shared uploader and carries no API credential: a
   * signed session url is already the authorization.
   */
  async convertDocument(file: Blob, format: string, fileName: string): Promise<Blob> {
    const opened = await this.postConvertJson<{ uploadUrl: string; objectPath: string }>(
      `${this.baseApi}/signatures/convert/upload-init`,
      {
        fileName,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
      },
    );

    await uploadResumable({
      file: file as File,
      sessionUrl: opened.uploadUrl,
      contentType: file.type || 'application/octet-stream',
    });

    const converted = await this.postConvertJson<{ signedUrl: string }>(
      `${this.baseApi}/signatures/convert/run`,
      { objectPath: opened.objectPath, format, fileName },
    );

    // Fetched straight from storage, so the converted document never travels
    // through the API either. `publicFetch` rather than `apiFetch`: the signed
    // url IS the authorization, and attaching the user's bearer token would send
    // their API credential to a host that never needed it. It still carries the
    // shared deadline, so a stalled storage read cannot hang the caller.
    const result = await publicFetch(converted.signedUrl, { timeoutMs: REQUEST_TIMEOUT_MS.upload });
    if (!result.ok) throw new Error('Failed to convert document');
    return result.blob();
  }

  /**
   * POST JSON to a conversion route with the caller's credential, or throw.
   *
   * Sent again only when the server said the converter was busy, which it says
   * before touching anything. Never after a 504 or a dropped connection: the
   * finalize step deletes its uploaded source when a conversion fails, so a
   * blind retry of one that may have run reports a missing file.
   */
  private async postConvertJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return retryWhileBusy(async () => {
      const response = await apiFetch(url, {
        method: 'POST',
        headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        timeoutMs: REQUEST_TIMEOUT_MS.upload,
        signal,
      });
      if (!response.ok) {
        throw await toApiError(response, 'Failed to convert document');
      }
      return response.json() as Promise<T>;
    }, { signal });
  }

  /**
   * Send a completion, and recover when it got no answer.
   *
   * Asks the status route whether this signer is already recorded and, if so,
   * reports that outcome instead of a failure. Otherwise it waits briefly, so a
   * first request still running on the server can finish, asks once more, and
   * only then sends it again: the caller's idempotency key is unchanged, so the
   * server replays rather than records twice.
   */
  private async completeWithRecovery(
    token: string,
    send: () => Promise<SigningCompletionResult>,
  ): Promise<SigningCompletionResult> {
    try {
      return await this.sendReadingConflicts(token, send);
    } catch (error) {
      if (!isUncertainCompletionFailure(error)) throw error;
      const recorded = await this.recordedCompletion(token);
      if (recorded) return recorded;
      await new Promise((resolve) => setTimeout(resolve, COMPLETION_RETRY_SETTLE_MS));
      const settled = await this.recordedCompletion(token);
      if (settled) return settled;
      return this.sendReadingConflicts(token, send);
    }
  }

  /**
   * Send a completion, and answer an "already completed" 409 with the recorded
   * outcome when the status route confirms this signer is recorded. Any other
   * refusal, or a 409 the status does not back, is thrown as it came.
   */
  private async sendReadingConflicts(
    token: string,
    send: () => Promise<SigningCompletionResult>,
  ): Promise<SigningCompletionResult> {
    try {
      return await send();
    } catch (error) {
      if (!isAlreadyCompletedConflict(error)) throw error;
      const recorded = await this.recordedCompletion(token);
      if (recorded) return recorded;
      throw error;
    }
  }

  /**
   * The completion outcome for a signer the status route says is recorded, or
   * null when they are not (or the status could not be read). Follows the
   * backend's `replayState`, except that a cancelled or expired session reads as
   * `permanent_refusal`: it will never be sealed, so neither "waiting for the
   * others" nor "still being produced" would be true.
   */
  private async recordedCompletion(token: string): Promise<SigningCompletionResult | null> {
    let status: Awaited<ReturnType<SignaturesService['getSigningStatus']>>;
    try {
      status = await this.getSigningStatus(token);
    } catch {
      return null;
    }
    if (status.participantStatus !== 'completed') return null;
    const outstanding = status.totalParticipants - status.completedParticipants;
    const state = status.sessionStatus === 'completed'
      ? 'completed'
      : UNSEALABLE_SESSION_STATUSES.has(status.sessionStatus)
        ? 'permanent_refusal'
        : outstanding > 0 ? 'waiting_for_others' : 'processing';
    return {
      success: state === 'completed' || state === 'waiting_for_others',
      state,
      consentRecorded: true,
      completed: state === 'completed',
      waitingForNextSigner: state === 'waiting_for_others',
      nextSignerName: null,
    };
  }

  /**
   * Finish a FIELDLESS session with the document the annotator produced.
   *
   * Such a session has no placed fields, so nothing on the server can reproduce
   * its marks: they were drawn freehand here. The bytes still have to reach the
   * server, but they no longer travel through it. They go to STORAGE on their
   * own leg and the completion names the object.
   *
   * That request used to be a multipart body, which made it the last route in
   * the signatures module holding a whole document in the API process. The
   * upload carries no API credential: the session url IS the authorization, and
   * sending a bearer token to a storage host widens where it has been.
   *
   * `onUploaded` reports the stored object before the completion is sent, and
   * `signedObjectPath` hands it back on a retry so no second upload is opened:
   * once the signature lands the token is consumed, and asking for another
   * upload then answers 404, which reads to the signer as an expired link.
   */
  async submitSignedDocument(
    token: string,
    signedPdfBytes: Uint8Array,
    fileName: string,
    consent: {
      consentAgreed: boolean;
      consentName: string;
      consentTimestamp: string;
      sourceRevision: string;
      idempotencyKey: string;
    },
    options: {
      signal?: AbortSignal;
      signedObjectPath?: string;
      onUploaded?: (objectPath: string) => void;
    } = {},
  ): Promise<SigningCompletionResult> {
    const headers = await this.optionalAuthHeaders();
    headers['Content-Type'] = 'application/json';
    const base = `${this.baseApi}/signing/${encodeURIComponent(token)}`;

    const signedObjectPath = options.signedObjectPath
      ?? await this.uploadSignedDocument(base, headers, signedPdfBytes, fileName, options.signal);
    options.onUploaded?.(signedObjectPath);

    // Only after the PUT resolves. Sent before it, this completes a session
    // against an object that is not there, and the signature is recorded
    // against a document nobody can open.
    return this.completeWithRecovery(token, async () => {
      const response = await publicFetch(`${base}/complete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...consent, signedObjectPath }),
      });
      const body = await response.json().catch(() => ({} as any));
      // A 503 `recoverable_failure` still recorded the signature; only the
      // executed document is pending, so it is an outcome, not a failure.
      if (!response.ok && !body.consentRecorded) {
        throw ApiError.fromResponse(response, body, 'Failed to submit signed document');
      }
      return body;
    });
  }

  /** Put a fieldless session's executed document in storage and name the object. */
  private async uploadSignedDocument(
    base: string,
    headers: Record<string, string>,
    signedPdfBytes: Uint8Array,
    fileName: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const opened = await publicFetch(`${base}/complete-upload-init`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ fileName, size: signedPdfBytes.byteLength }),
    });
    const session = await opened.json().catch(() => ({} as any));
    if (!opened.ok) {
      throw ApiError.fromResponse(opened, session, 'Failed to submit signed document');
    }

    await uploadResumable({
      file: new File([signedPdfBytes as Uint8Array<ArrayBuffer>], fileName, { type: 'application/pdf' }),
      sessionUrl: session.uploadUrl,
      contentType: 'application/pdf',
      signal,
    });
    return session.objectPath;
  }

  /**
   * Submit JSON consent and participant field values (public, optional auth).
   * The server executes the incremental PDF signing pipeline directly on the
   * stored source document, keeping full document bytes out of the browser.
   */
  async completeSigning(
    token: string,
    payload: {
      consentAgreed: boolean;
      consentName: string;
      consentTimestamp: string;
      sourceRevision: string;
      idempotencyKey: string;
      fieldValues?: SigningFieldValue[];
    }
  ): Promise<SigningCompletionResult> {
    const headers = await this.optionalAuthHeaders();
    headers['Content-Type'] = 'application/json';

    return this.completeWithRecovery(token, async () => {
      const response = await publicFetch(
        `${this.baseApi}/signing/${encodeURIComponent(token)}/complete`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            consentAgreed: payload.consentAgreed,
            consentName: payload.consentName,
            consentTimestamp: payload.consentTimestamp,
            sourceRevision: payload.sourceRevision,
            idempotencyKey: payload.idempotencyKey,
            fieldValues: payload.fieldValues || [],
          }),
          timeoutMs: REQUEST_TIMEOUT_MS.write,
        }
      );

      const body = await response.json().catch(() => ({} as any));
      if (!response.ok && !body.consentRecorded) {
        throw ApiError.fromResponse(response, body, 'Failed to submit signature');
      }
      return body;
    });
  }

  /** Decline to sign a document (public, optional auth) */
  async declineToSign(token: string, reason?: string): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    try {
      const authHeaders = await this.optionalAuthHeaders();
      Object.assign(headers, authHeaders);
    } catch {
      // Anonymous signing
    }

    const response = await publicFetch(
      `${this.baseApi}/signing/${encodeURIComponent(token)}/decline`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ reason: reason || undefined }),
      }
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to decline signing');
    }
  }

  /** Fetch the full audit trail for a signing session (authenticated) */
  async getAuditTrail(token: string): Promise<{
    session: {
      token: string;
      fileName: string;
      status: string;
      signerName: string | null;
      createdAt: string | null;
      completedAt: string | null;
      originalDocumentHash: string | null;
      signedDocumentHash: string | null;
    };
    events: Array<{
      eventId: string;
      eventType: string;
      timestamp: string | null;
      ip: string | null;
      userAgent: string | null;
      metadata: Record<string, unknown> | null;
    }>;
  }> {
    const headers = await this.authHeaders();
    const response = await apiFetch(
      `${this.baseApi}/signing/${encodeURIComponent(token)}/audit`,
      { headers }
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch audit trail');
    }

    return response.json();
  }

  /**
   * Get the Certificate of Completion URL (JSON format, authenticated).
   * Mints a short-lived generation-pinned signed URL to the archived certificate.
   */
  async getCertificateUrl(
    token: string,
    disposition: 'inline' | 'attachment' = 'attachment'
  ): Promise<{ url: string; fileName: string }> {
    const query = new URLSearchParams();
    query.set('format', 'json');
    if (disposition) query.set('disposition', disposition);
    const qs = query.toString();
    const endpoint = `${this.baseApi}/signing/${encodeURIComponent(token)}/certificate${qs ? `?${qs}` : ''}`;
    const headers = await this.authHeaders();
    const response = await apiFetch(endpoint, { headers });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch certificate URL');
    }
    return response.json();
  }

  /** Download the Certificate of Completion PDF for a completed signing session */
  async downloadCertificate(token: string): Promise<void> {
    const { url, fileName } = await this.getCertificateUrl(token, 'attachment');
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /**
   * Cryptographically verify an executed session artifact stored in GCS (authenticated).
   * Streams the stored PDF through the ByteRange/CMS detached signature verifier
   * and checks coverage and cryptographic integrity.
   */
  async verifyStoredArtifact(
    token: string,
    copy?: 'filed' | 'delivered'
  ): Promise<{
    token: string;
    copy: 'filed' | 'delivered';
    identityMatch: boolean;
    sealed: boolean;
    sealValid: boolean;
    coversWholeFile: boolean;
    signedDigestHex?: string;
    signerCommonName?: string;
    signingTime?: string;
    reason?: string;
  }> {
    const query = new URLSearchParams();
    if (copy) query.set('copy', copy);
    const qs = query.toString();
    const endpoint = `${this.baseApi}/signing/${encodeURIComponent(token)}/verification${qs ? `?${qs}` : ''}`;
    const headers = await this.authHeaders();
    const response = await apiFetch(endpoint, { headers });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to cryptographically verify document');
    }
    return response.json();
  }

  /** Get the download URL for the final signed PDF without buffering in memory. */
  async getSignedDocumentUrl(
    token: string,
    disposition: 'inline' | 'attachment' = 'attachment',
    copy?: 'without-certificate'
  ): Promise<{ url: string; fileName: string }> {
    const response = await apiFetch(
      `${this.baseApi}/signing/${encodeURIComponent(token)}/signed-document?disposition=${disposition}${copy ? `&copy=${copy}` : ''}&format=json`,
      { headers: await this.authHeaders({}, { json: true }) }
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to load the signed document');
    }

    return response.json();
  }

  /** Download the final signed PDF for a completed session. */
  async downloadSignedDocument(token: string): Promise<void> {
    const { url, fileName } = await this.getSignedDocumentUrl(token, 'attachment');
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'Signed Document.pdf';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /**
   * Check whether a PDF is one this system executed, unaltered (public).
   *
   * The browser hashes the file, in a worker, one slice at a time, and posts
   * the digest. The whole document used to travel to the API so the same 32
   * bytes could be computed there, which held a request open for the length of
   * the transfer and put a two-gigabyte ceiling on an unauthenticated route.
   *
   * A completed session produces two sealed PDFs: the copy filed in the firm's
   * documents, with the Signature Certificate page appended, and the copy sent
   * to signers and portal clients, without it. Both are genuine and they hash
   * differently, so `matchedCopy` says which one was checked.
   */
  async verifyDocument(file: File): Promise<{
    valid: boolean;
    fileName?: string;
    signerName?: string | null;
    signedAt?: string | null;
    transactionId?: string;
    matchedCopy?: 'filed' | 'delivered';
    message?: string;
  }> {
    const hash = await fingerprintFile(file);

    const response = await publicFetch(`${this.baseApi}/signing/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to verify document');
    }

    return response.json();
  }

  /**
   * One page of a law firm's signing sessions (authenticated). The endpoint
   * pages, filters and counts in SQL, so `totalItems` is the size of the whole
   * filtered history, not of the returned page.
   */
  async listSigningSessions(
    lawFirmId: string,
    params: { page?: number; limit?: number; status?: string; search?: string } = {}
  ): Promise<{
    totalItems: number;
    sessions: Array<{
      token: string;
      sessionToken?: string;
      fileName: string;
      status: string;
      signerName: string | null;
      recipientEmail: string | null;
      createdAt: string | null;
      completedAt: string | null;
      destinationLabel?: string | null;
      routingMode?: string;
      totalParticipants?: number;
      completedParticipants?: number;
      currentSignerOrder?: number | null;
      currentSignerName?: string | null;
      currentSignerRole?: string | null;
      readyForCurrentUser?: boolean;
      currentUserSigningToken?: string | null;
      signers?: Array<{
        participantId: string;
        roleLabel: string;
        name: string | null;
        email: string | null;
        status: string;
        order: number;
        deliveryMethod: string;
        completedAt?: string | null;
        isCurrentUser?: boolean;
      }>;
    }>;
  }> {
    const headers = await this.authHeaders();
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.status) query.set('status', params.status);
    if (params.search) query.set('search', params.search);
    const qs = query.toString();
    return requestDeduplicator.execute(
      `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/signature-links/sessions${qs ? `?${qs}` : ''}`,
      { headers }
    );
  }

  /**
   * Everything the signatures page opens with, in one response: a page of
   * sessions, the per-status summary, the member's pending documents and the
   * template list. Each part is the unchanged body of its own endpoint
   * (`listSigningSessions`, `getSigningSessionSummary`, `getPendingForUser`,
   * `listSigningTemplates`), behind the same permission and feature gate.
   */
  async getSigningWorkspace(
    lawFirmId: string,
    params: { page?: number; limit?: number; status?: string; search?: string } = {},
  ): Promise<{
    sessions: Awaited<ReturnType<SignaturesService['listSigningSessions']>>;
    summary: SigningSessionSummary;
    pendingForUser: Awaited<ReturnType<SignaturesService['getPendingForUser']>>;
    templates: { templates: SigningTemplate[] };
  }> {
    const headers = await this.authHeaders();
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.status) query.set('status', params.status);
    if (params.search) query.set('search', params.search);
    const qs = query.toString();
    return requestDeduplicator.execute(
      `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/signature-links/workspace${qs ? `?${qs}` : ''}`,
      { headers }
    );
  }

  /**
   * How many sessions sit in each status across the firm's whole signing
   * history - what the status filters label themselves with. Not affected by the
   * filter or search currently applied to the list.
   */
  async getSigningSessionSummary(lawFirmId: string): Promise<SigningSessionSummary> {
    const headers = await this.authHeaders();
    return requestDeduplicator.execute(
      `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/signature-links/sessions/summary`,
      { headers }
    );
  }

  async cancelSigningSession(token: string): Promise<{ success: boolean; status: string }> {
    const headers = await this.authHeaders();
    const response = await apiFetch(
      `${this.baseApi}/signing/${encodeURIComponent(token)}/cancel`,
      { method: 'POST', headers }
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to cancel signing session');
    }

    return response.json();
  }

  async resendParticipant(
    lawFirmId: string,
    sessionToken: string,
    participantId: string
  ): Promise<{ sent: boolean; participantId: string; reminderCount?: number; lastReminderSentAt?: string | null }> {
    const headers = await this.authHeaders();
    const response = await apiFetch(
      `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/signature-links/${encodeURIComponent(sessionToken)}/resend-participant/${encodeURIComponent(participantId)}`,
      { method: 'POST', headers }
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to resend signing request');
    }

    return response.json();
  }

  async getPendingForUser(lawFirmId: string): Promise<{
    needsMySignature: Array<{
      sessionToken: string;
      fileName: string;
      routingMode: RoutingMode;
      createdAt: string | null;
      participantId: string;
      participantRole: string;
      publicToken: string | null;
      totalParticipants: number;
      completedParticipants: number;
    }>;
    createdByMe: Array<{
      sessionToken: string;
      fileName: string;
      status: string;
      routingMode: RoutingMode;
      createdAt: string | null;
      totalParticipants: number;
      completedParticipants: number;
    }>;
  }> {
    const headers = await this.authHeaders();
    return requestDeduplicator.execute(
      `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/signature-links/pending-for-user`,
      { headers }
    );
  }

  /**
   * The documents waiting on the signed-in client's signature.
   *
   * Answers across every firm they sign for unless `lawFirmId` narrows it, and
   * `totalItems` counts the whole matching set rather than the returned page, so
   * a caller showing "N waiting" stays right however few rows it asked for.
   * `singleLawFirmId` is the one firm holding all of them, or null when they span
   * firms and no single signing list would show them all.
   */
  async getPendingForClient(opts?: {
    lawFirmId?: string;
    limit?: number;
    offset?: number;
    page?: number;
  }): Promise<{
    pendingDocuments: Array<{
      sessionToken: string;
      lawFirmId: string;
      fileName: string;
      routingMode: RoutingMode;
      createdAt: string | null;
      participantId: string;
      participantRole: string;
      participantName: string | null;
      publicToken: string | null;
      totalParticipants: number;
      completedParticipants: number;
    }>;
    totalItems: number;
    singleLawFirmId: string | null;
  }> {
    const headers = await this.authHeaders();
    const q = new URLSearchParams();
    if (opts?.lawFirmId) q.set('lawFirmId', opts.lawFirmId);
    if (opts?.limit != null) q.set('limit', String(opts.limit));
    if (opts?.offset != null) q.set('offset', String(opts.offset));
    if (opts?.page != null) q.set('page', String(opts.page));
    const qs = q.toString() ? `?${q.toString()}` : '';
    return requestDeduplicator.execute(
      `${this.baseApi}/signing/pending-for-client${qs}`,
      { headers }
    );
  }

  async listSigningTemplates(lawFirmId: string): Promise<{ templates: SigningTemplate[] }> {
    const headers = await this.authHeaders();
    const response = await apiFetch(
      `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/signing-templates`,
      { headers }
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch signing templates');
    }

    return response.json();
  }

  async getSigningTemplate(lawFirmId: string, templateId: string): Promise<{ template: SigningTemplate }> {
    const headers = await this.authHeaders();
    const response = await apiFetch(
      `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/signing-templates/${encodeURIComponent(templateId)}`,
      { headers }
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to fetch signing template');
    }

    return response.json();
  }

  async createSigningTemplate(
    lawFirmId: string,
    data: {
      name: string;
      description?: string;
      fields: SignatureField[];
      signerRoles: Array<{ roleLabel: string; order: number; deliveryMethod?: string }>;
      sourceFileName?: string;
      sourceObjectPath?: string;
      routingMode?: RoutingMode;
    }
  ): Promise<{ template: SigningTemplate }> {
    const headers = await this.authHeaders();
    const response = await apiFetch(
      `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/signing-templates`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(data),
      }
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to save signing template');
    }

    return response.json();
  }

  async updateSigningTemplate(
    lawFirmId: string,
    templateId: string,
      data: Partial<{
      name: string;
      description: string;
      fields: SignatureField[];
      signerRoles: Array<{ roleLabel: string; order: number; deliveryMethod?: string }>;
      sourceFileName: string;
      sourceObjectPath: string;
      routingMode: RoutingMode;
    }>
  ): Promise<{ template: SigningTemplate }> {
    const headers = await this.authHeaders();
    const response = await apiFetch(
      `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/signing-templates/${encodeURIComponent(templateId)}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify(data),
      }
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to update signing template');
    }

    return response.json();
  }

  async deleteSigningTemplate(lawFirmId: string, templateId: string): Promise<{ success: boolean }> {
    const headers = await this.authHeaders();
    const response = await apiFetch(
      `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/signing-templates/${encodeURIComponent(templateId)}`,
      {
        method: 'DELETE',
        headers,
      }
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to delete signing template');
    }

    return response.json();
  }

  /**
   * Upload a local file to storage for signing (authenticated).
   *
   * A PDF goes straight to GCS: `/signing/upload-init` opens a resumable
   * session under the firm's transient prefix, the bytes are PUT there in
   * chunks (`lib/files/resumableUpload`), and `/signing/upload-finalize`
   * vouches for what landed. That is what lifts Cloud Run's 32 MiB request cap
   * off a PDF, since it never passes through the API.
   *
   * Non-PDF sources use the parallel `/signing/convert-upload-init` and
   * `/signing/convert-upload-finalize` flow. The converter reads the temporary
   * object from storage and publishes a PDF back to storage, so neither source
   * nor converted bytes travel in an API request.
   */
  async uploadForSigning(
    file: File,
    lawFirmId: string,
    options: SigningUploadOptions = {},
  ): Promise<{ objectPath: string; fileName: string }> {
    const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    // Every upload path needs the firm: it is the storage prefix the object
    // lands under and the tenant the source row belongs to. There used to be a
    // fallback here that posted the file to the API instead, for a caller with
    // no firm; there is no such caller, and that route is gone.
    if (!lawFirmId) throw new Error('A law firm is required to upload a document for signing.');
    if (!isPdf) return this.uploadNonPdfForSigning(file, lawFirmId, options);

    // A signing upload is remembered the same way a files upload is: keyed on
    // who is uploading, where it lands, and WHICH document it is. The content
    // fingerprint is streamed from the file's slices, never from the whole
    // file, because a 90 MB scan is the case this route exists for.
    const identity: FileIdentity = {
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      fingerprint: await fingerprintFile(file),
    };
    const destination: UploadDestination = {
      lawFirmId,
      userId: (await getFirebaseUid()) ?? 'anonymous',
      // Its own context: the transient signing prefix is not the firm's file
      // tree, so the same PDF uploaded for signature and filed under a matter
      // are two uploads to two places and must not resume into each other.
      context: 'signing',
      matterId: null,
      taskId: null,
      clientId: null,
      folderId: null,
    };

    // Only one tab may drive a session. Without the proof, the descriptor is
    // left alone and this tab opens its own: two tabs PUTting into one session
    // from the same offset interleave their bytes, and the document that
    // reaches the signer is corrupt with nothing on either screen to say so.
    const claim = await claimUploadSession(uploadSessionKey(destination, identity));
    try {
      if (options.signal?.aborted) throw new UploadCancelledError();
      return await this.sendSigningUpload(file, lawFirmId, identity, destination, claim.owned, options);
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new UploadCancelledError();
      }
      throw error;
    } finally {
      claim.release();
    }
  }

  /** The signing upload itself, once ownership of its session is settled. */
  private async sendSigningUpload(
    file: File,
    lawFirmId: string,
    identity: FileIdentity,
    destination: UploadDestination,
    owned: boolean,
    options: SigningUploadOptions,
  ): Promise<{ objectPath: string; fileName: string }> {
    const { onProgress, signal, chunkSize, retryDelaysMs } = options;

    if (signal?.aborted) throw new UploadCancelledError();

    const openSession = async (): Promise<SigningUploadSession> => {
      if (signal?.aborted) throw new UploadCancelledError();
      const initResponse = await apiFetch(`${this.baseApi}/signing/upload-init`, {
        method: 'POST',
        headers: await this.authHeaders(),
        body: JSON.stringify({
          lawFirmId, name: file.name, size: file.size, contentType: 'application/pdf',
        }),
        signal,
      });
      if (!initResponse.ok) {
        throw await toApiError(initResponse, 'Failed to upload file');
      }
      return (await initResponse.json()) as SigningUploadSession;
    };

    // The stored descriptor is the shared shape, so the transient object path
    // stands in for the row id: this route claims no row, and the path is what
    // finalize names.
    const asDescriptor = (session: SigningUploadSession) => ({
      fileId: session.objectPath,
      name: session.fileName,
      objectPath: session.objectPath,
      uploadUrl: session.uploadUrl,
      contentType: 'application/pdf',
      declaredSize: file.size,
    });

    const remembered = owned ? loadUploadSession(destination, identity) : null;
    let session: SigningUploadSession = remembered
      ? { objectPath: remembered.objectPath, fileName: remembered.name, uploadUrl: remembered.uploadUrl }
      : await openSession();

    if (signal?.aborted) throw new UploadCancelledError();

    // Saved BEFORE the first byte goes out. Saved after, the descriptor would
    // exist only outside the window in which a refresh loses the upload.
    if (owned && !remembered) saveUploadSession(destination, identity, asDescriptor(session));

    const send = (from: 0 | 'query') => uploadResumable({
      file,
      sessionUrl: session.uploadUrl,
      contentType: 'application/pdf',
      startOffset: from,
      // The bar follows TRANSPORT bytes so it moves smoothly inside a chunk,
      // and is held below 100 until the API has vouched for the object, which
      // is the moment the document becomes usable.
      onTransportBytes: onProgress
        ? (bytes) => onProgress(Math.min(99, Math.round((bytes / (file.size || 1)) * 100)))
        : undefined,
      ...(chunkSize !== undefined ? { chunkSize } : {}),
      ...(retryDelaysMs !== undefined ? { retryDelaysMs } : {}),
      signal,
    });

    try {
      // The gate is shared with every other upload in the tab: a document sent
      // for signature and a batch dropped on the files page are one uplink.
      await runWithUploadLimit(async () => {
        try {
          await send(remembered ? 'query' : 0);
        } catch (err) {
          if (signal?.aborted) throw new UploadCancelledError();
          if (!(err instanceof UploadSessionGoneError)) throw err;
          // A dead session can never take another byte, so its descriptor is
          // released rather than left to be resumed into. A retry with it still
          // in place would ask a dead url where it got to, forever.
          if (owned) clearUploadSession(destination, identity);
          if (!remembered) throw err;
          // The session recalled from an earlier page load has expired in the
          // meantime. Open a fresh one rather than telling the user a link
          // expired for something they did not do just now.
          session = await openSession();
          if (owned) saveUploadSession(destination, identity, asDescriptor(session));
          await send(0);
        }
      });

      if (signal?.aborted) throw new UploadCancelledError();

      const finalizeResponse = await apiFetch(`${this.baseApi}/signing/upload-finalize`, {
        method: 'POST',
        headers: await this.authHeaders(),
        body: JSON.stringify({ lawFirmId, objectPath: session.objectPath }),
        signal,
      });
      if (!finalizeResponse.ok) {
        // The route deletes a source it refuses, so the transient object is gone
        // and nothing can resume into it. Forgetting the descriptor is what stops
        // the next attempt asking a dead session where it got to.
        if (owned) clearUploadSession(destination, identity);
        throw await toApiError(finalizeResponse, 'Failed to upload file');
      }
      // Finalized: the session is closed and a resume would PUT into a finished
      // object.
      if (owned) clearUploadSession(destination, identity);
      if (onProgress) onProgress(100);
      return finalizeResponse.json();
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        if (owned) clearUploadSession(destination, identity);
        throw new UploadCancelledError();
      }
      throw error;
    }
  }

  /** A non-PDF is converted from storage, never from a multipart request body. */
  private async uploadNonPdfForSigning(
    file: File,
    lawFirmId: string,
    options: SigningUploadOptions,
  ): Promise<{ objectPath: string; fileName: string }> {
    try {
      const opened = await this.postConvertJson<{ uploadUrl: string; objectPath: string }>(
        `${this.baseApi}/signing/convert-upload-init`,
        { lawFirmId, name: file.name, contentType: file.type || 'application/octet-stream', size: file.size },
        options.signal,
      );
      await uploadResumable({
        file,
        sessionUrl: opened.uploadUrl,
        contentType: file.type || 'application/octet-stream',
        onTransportBytes: options.onProgress
          ? (bytes) => options.onProgress!(Math.min(99, Math.round((bytes / (file.size || 1)) * 100)))
          : undefined,
        ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}),
        ...(options.retryDelaysMs !== undefined ? { retryDelaysMs: options.retryDelaysMs } : {}),
        signal: options.signal,
      });
      const finalized = await this.postConvertJson<{ objectPath: string; fileName: string }>(
        `${this.baseApi}/signing/convert-upload-finalize`,
        { lawFirmId, objectPath: opened.objectPath, name: file.name },
        options.signal,
      );
      options.onProgress?.(100);
      return finalized;
    } catch (error) {
      if (options.signal?.aborted) throw new UploadCancelledError();
      throw error;
    }
  }
}

const signaturesService = new SignaturesService();
export default signaturesService;
