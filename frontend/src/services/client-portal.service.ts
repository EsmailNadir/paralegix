import { getFirebaseToken } from '@/lib/utils/auth';
import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { toApiError, ApiError } from '@/lib/utils/apiErrors';
import { authenticatedHeaders } from './base.service';
import requestDeduplicator from './requestDeduplicator';
import type { FirmFeatures } from '@/types/preferences';
import type { MessageAttachment, Conversation, GroupConversationResponse, MessageSearchResult, PortalConversationSummary } from '@/types';
import { uploadResumable, UploadCancelledError } from '@/lib/files/resumableUpload';
import type { CardConfirmResult, CardQuote, CardSetup } from '@/types/cardFees';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';

interface LawFirm {
  id: string;
  name: string;
  logoUrl?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  features?: Partial<FirmFeatures>;
  // True when the firm's subscription is inactive; its portal is paused.
  billingLocked?: boolean;
}

interface FirmSummary extends LawFirm {
  matterCount: number;
  // Outstanding balance in integer cents (the backend's money unit). The
  // dashboard divides by 100 for display.
  outstandingBalanceCents: number;
}

interface Matter {
  id: string;
  title: string;
  matterNumber?: string;
  status: string;
  matterType?: string;
  // The matter's pipeline stage (distinct from the coarse status above), e.g.
  // "Discovery" or "Awaiting Signature". Null when the matter has no stage set.
  stageName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface Invoice {
  id: string;
  contextType?: 'matter' | 'client' | string | null;
  entityId?: string | null;
  matterId?: string | null;
  clientContextId?: string | null;
  invoiceName?: string | null;
  invoiceDate?: any;
  dueDate?: any;
  paidDate?: any;
  billingEmail?: string | null;
  notes?: string | null;
  remitTo?: {
    name?: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
  } | null;
  timeEntries?: Array<{
    id: string;
    name: string;
    description?: string;
    rate: number;
    hours: number;
    amount: number;
  }>;
  flatFees?: Array<{
    id: string;
    description: string;
    amount: number;
  }>;
  totalHours?: number;
  totalAmount?: number;
  flatFeesAmount?: number;
  isPaid?: boolean;
  amountPaid?: number;
  payments?: Array<{
    amount: number;
    date: string;
    note?: string | null;
    recordedBy?: string;
    description?: string | null;
    paymentMethod?: string | null;
    paymentSource?: 'trust' | 'external' | 'stripe';
    trustTransactionId?: string;
    trustAccountId?: string;
    /** The processing fee the client paid on top of `amount`, in cents; 0 when none. */
    surchargeCents?: number;
  }>;
  nextPaymentDate?: any;
  createdAt?: string | null;
  createdBy?: string | null;
  // Derived fields
  status?: string | null;
  remainingBalance?: number;
  creditNotes?: Array<{ id: string; amount: number; description: string; label?: string; createdAt: string }>;
  totalWrittenOff?: number;
  paymentPlan?: any;
  // Stripe payment fields
  stripePaymentRequested?: boolean;
  stripePaymentStatus?: 'pending' | 'completed' | 'voided' | null;

}

interface BillingResponse {
  invoices: Invoice[];
  /** Size of the whole matching set, not of `invoices`. */
  totalItems: number;
  summary: {
    totalBilled: number;
    totalPaid: number;
    totalOutstanding: number;
  };
  /** Counts per status across EVERY invoice, so the filter chips ignore paging. */
  statusCounts: Record<string, number>;
}

/** Window + filter for the invoice list. Omit `limit` to get every invoice. */
export interface PortalBillingQuery {
  page?: number;
  limit?: number;
  status?: string;
  clientRecordId?: string;
}

interface Message {
  id: string;
  content: string;
  senderId: string;
  senderType: 'client' | 'firm';
  timestamp: string | null;
  matterId?: string;
  readByClient?: boolean;
  readByFirm?: boolean;
  editedAt?: string | null;
  deleted?: boolean;
}

interface Document {
  id: string;
  contextType?: 'matter' | 'client' | string | null;
  entityId?: string | null;
  matterId?: string;
  name: string;
  type: string;
  size: number;
  uploadedAt: string | null;
  downloadUrl: string;
  // GCS object path for matter documents. Lets the UI lazily re-sign a fresh
  // download URL on open via refreshMatterDocumentUrl, instead of relying on the
  // (30-min) URL baked into the list response.
  objectPath?: string | null;
  sourceLabel?: string;
  // True until the client first opens/downloads this shared document - drives the
  // "New" badge on the Documents page.
  isNew?: boolean;
}

// A client-facing in-app notification (the portal bell). Shared `notifications`
// table; the client only ever sees their own rows.
export type PaymentMethodKind = 'card' | 'bank';

/** What paying one invoice online costs by each method, fee included. */
export interface PaymentOptions {
  invoiceCents: number;
  methods: Array<{ method: PaymentMethodKind; feeCents: number; totalCents: number }>;
  /** How a card payment is taken: our card form when the client pays the card fee. */
  card: CardSetup;
}

export interface PortalNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  entityType?: string | null;
  matterId?: string | null;
  actionUrl?: string | null;
  createdAt: string | null;
}

// Per-folder color (chosen by the firm) for a client-visible folder. `matterId`
// is null for client-/task-scoped folders (grouped under "Client files");
// `relPath` is the folder's path within its group.
export interface PortalFolderColor {
  matterId: string | null;
  relPath: string;
  folderColor: string | null;
}

interface Event {
  id: string;
  matterId: string;
  title: string;
  date: string | null;
  description?: string;
  type?: string;
}

// A single file attached to a request item (a client upload or a file the
// firm linked in). id/objectPath/uploadedBy aren't populated by the older
// caller of this type but are always present on what the backend returns.
export interface DocumentRequestFulfillment {
  id: string;
  fileName: string;
  objectPath: string;
  uploadedBy: string | null;
  // Display name of whoever uploaded the file - the client themselves, or a
  // firm member who attached it on the client's behalf.
  uploadedByName: string | null;
  uploadedAt: string;
}

// One checklist line the firm asked the client to provide.
export interface DocumentRequestItem {
  id: string;
  requestId: string;
  label: string;
  // Optional detail from the firm explaining what exactly is needed for this item.
  description: string;
  status: 'pending' | 'received' | 'waived';
  fulfillments: DocumentRequestFulfillment[];
}

// A firm-initiated request for documents, scoped to a matter, with its checklist.
export interface DocumentRequest {
  id: string;
  /** Null for a "General" request, not tied to any matter. */
  matterId: string | null;
  clientId: string;
  title: string;
  note: string | null;
  status: 'open' | 'completed' | 'cancelled';
  dueDate: string | null;
  createdAt: string;
  items: DocumentRequestItem[];
}

// The slim descriptor the backend returns for each stored file after an upload.
export interface UploadedMatterDocument {
  /** The file row init claimed and finalize stamped. */
  fileId: string;
  name: string;
  objectPath: string;
  mimeType: string;
  size: number;
}

/** A picked file that was not filed, why, and its position in the selection. */
export interface PortalUploadFailure {
  name: string;
  error: string;
  index: number;
}

/**
 * Files one portal document init accepts. Mirrors `PORTAL_DOCUMENT_MAX_FILES`
 * in the backend's `portal.service.ts`, which refuses a longer list outright.
 */
const PORTAL_DOCUMENTS_PER_REQUEST = 10;

/**
 * Files one portal document upload may carry: the most one finalize (or
 * cancel) accepts. Mirrors `PORTAL_DOCUMENT_MAX_FINALIZE` in the backend's
 * `portal.service.ts`. A selection is finalized in one call so the firm hears
 * of it once, which is why this is a cap on the selection and not a group size.
 */
export const PORTAL_DOCUMENTS_PER_UPLOAD = 50;

// One client-record association the authenticated portal uid holds in one firm
// (organization-clients plan, Phase 5): a person client record, or one company
// client_company_links relationship. `GET /lawfirm/:lawFirmId/associations`
// returns every one of these up front so the portal can auto-select the sole
// one, or offer a switcher/picker when there is more than one (e.g. Pat, on
// two companies).
export interface PortalAssociation {
  clientRecordId: string;
  clientType: 'person' | 'company';
  clientName: string;
  companyLinkId: string | null;
  canViewBilling: boolean;
}

class ClientPortalService {
  private baseUrl: string;
  private uploadFileIds = new WeakMap<File, string>();
  private uploadActions = new WeakMap<File, Map<string, string>>();

  constructor() {
    this.baseUrl = `${API_URL}/client-portal`;
  }

  private asNumber(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private normalizeDocument(document: Partial<Document> & { id?: string }): Document {
    const contextType = document.contextType || (document.matterId ? 'matter' : 'client');
    return {
      id: document.id || '',
      contextType,
      entityId: document.entityId ?? document.matterId ?? null,
      matterId: document.matterId,
      name: document.name || 'Untitled document',
      type: document.type || 'application/octet-stream',
      size: this.asNumber(document.size),
      uploadedAt: document.uploadedAt || null,
      downloadUrl: document.downloadUrl || '',
      objectPath: document.objectPath ?? null,
      sourceLabel: contextType === 'matter' ? 'Matter file' : 'Client file',
      isNew: document.isNew === true,
    };
  }

  /**
   * Append `clientRecordId` as a query param, matching how every route in
   * `portal.routes.ts` reads it: query string first, falling back to the body
   * only on routes whose body isn't `.strict()`-validated. Using the query
   * string uniformly here means every method below (GET, upload, or JSON
   * mutation) forwards it the same way, and, as a side effect, partitions
   * `requestDeduplicator`'s in-flight coalescing and this app's normal HTTP
   * caching by clientRecordId automatically, since it becomes part of the URL.
   */
  private withClientRecordId(url: string, clientRecordId?: string | null): string {
    if (!clientRecordId) return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}clientRecordId=${encodeURIComponent(clientRecordId)}`;
  }

  // Every client-record association (person and/or company roster links) this
  // portal uid holds in one firm. Called once per firm view so the portal can
  // auto-select the sole association, or drive a switcher/picker when there is
  // more than one.
  async getAssociations(lawFirmId: string): Promise<{ associations: PortalAssociation[] }> {
    const response = await requestDeduplicator.execute<{ associations?: PortalAssociation[] }>(
      `${this.baseUrl}/lawfirm/${lawFirmId}/associations`,
      {
        method: 'GET',
        headers: await authenticatedHeaders(),
      }
    );
    return { associations: Array.isArray(response?.associations) ? response.associations : [] };
  }

  // Get all law firms the client is associated with
  async getMyLawFirms(): Promise<{ lawFirms: LawFirm[] }> {
    return requestDeduplicator.execute<{ lawFirms: LawFirm[] }>(
      `${this.baseUrl}/my-lawfirms`,
      {
        method: 'GET',
        headers: await authenticatedHeaders(),
      }
    );
  }

  // Get every firm the client belongs to, each with its dashboard counts
  // (matterCount + outstandingBalanceCents) computed server-side in one request,
  // avoids a per-firm matters+billing fan-out just to read a count and a balance.
  // outstandingBalanceCents is integer cents (the backend's money unit).
  async getFirmSummaries(): Promise<{ lawFirms: FirmSummary[] }> {
    const response = await requestDeduplicator.execute<{ lawFirms: FirmSummary[] }>(
      `${this.baseUrl}/firm-summaries`,
      {
        method: 'GET',
        headers: await authenticatedHeaders(),
      }
    );

    return { lawFirms: Array.isArray(response?.lawFirms) ? response.lawFirms : [] };
  }

  async getLawFirmFeatures(lawFirmId: string): Promise<Partial<FirmFeatures> | null> {
    const response = await this.getMyLawFirms();
    const lawFirm = response.lawFirms.find((firm) => firm.id === lawFirmId);
    return lawFirm?.features || null;
  }

  // Get matters for a specific law firm
  async getMatters(lawFirmId: string, clientRecordId?: string): Promise<{ matters: Matter[] }> {
    return requestDeduplicator.execute<{ matters: Matter[] }>(
      this.withClientRecordId(`${this.baseUrl}/lawfirm/${lawFirmId}/matters`, clientRecordId),
      {
        method: 'GET',
        headers: await authenticatedHeaders(),
      }
    );
  }

  // Get a specific matter
  async getMatter(lawFirmId: string, matterId: string, clientRecordId?: string): Promise<{ matter: Matter }> {
    return requestDeduplicator.execute<{ matter: Matter }>(
      this.withClientRecordId(`${this.baseUrl}/lawfirm/${lawFirmId}/matters/${matterId}`, clientRecordId),
      {
        method: 'GET',
        headers: await authenticatedHeaders(),
      }
    );
  }

  // Get billing information
  async getBilling(lawFirmId: string, query: PortalBillingQuery = {}): Promise<BillingResponse> {
    // The backend (portal.service serializePortalInvoice + summary reducer)
    // already returns fully-derived invoice fields (status, remainingBalance,
    // amountPaid, totalWrittenOff, amount, ...) and a billing summary. Trust the
    // payload directly instead of re-deriving on the client.
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.limit) params.set('limit', String(query.limit));
    if (query.status) params.set('status', query.status);
    const qs = params.toString();

    const response = await requestDeduplicator.execute<BillingResponse>(
      this.withClientRecordId(`${this.baseUrl}/lawfirm/${lawFirmId}/billing${qs ? `?${qs}` : ''}`, query.clientRecordId),
      {
        method: 'GET',
        headers: await authenticatedHeaders(),
      }
    );

    const invoices = Array.isArray(response?.invoices) ? response.invoices : [];
    return {
      invoices,
      // Older responses carried no count; the page length is the honest fallback.
      totalItems: typeof response?.totalItems === 'number' ? response.totalItems : invoices.length,
      summary: response?.summary ?? { totalBilled: 0, totalPaid: 0, totalOutstanding: 0 },
      statusCounts: response?.statusCounts ?? {},
    };
  }

  // Get a single invoice by id, instead of the client's whole billing history.
  // Used by the invoice-detail page, which used to fetch every invoice via
  // getBilling() just to find() the one it needed.
  async getInvoice(lawFirmId: string, invoiceId: string, clientRecordId?: string): Promise<{ invoice: Invoice }> {
    const response = await apiFetch(
      this.withClientRecordId(`${this.baseUrl}/lawfirm/${lawFirmId}/invoices/${encodeURIComponent(invoiceId)}`, clientRecordId),
      {
        method: 'GET',
        headers: await authenticatedHeaders(),
      }
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to load invoice');
    }

    return response.json();
  }

  // Get aggregated client documents (matter-level visible docs + client-level docs)
  // `truncated` means the server stopped scanning storage before the end, so the
  // client is looking at a partial list of what the firm shared with them.
  async getDocuments(lawFirmId: string, clientRecordId?: string): Promise<{ documents: Document[]; folders: PortalFolderColor[]; truncated: boolean }> {
    const response = await requestDeduplicator.execute<{ documents: Document[]; folders?: PortalFolderColor[]; truncated?: boolean }>(
      this.withClientRecordId(`${this.baseUrl}/lawfirm/${lawFirmId}/documents`, clientRecordId),
      {
        method: 'GET',
        headers: await authenticatedHeaders(),
      }
    );

    return {
      documents: Array.isArray(response?.documents)
        ? response.documents.map((document) => this.normalizeDocument(document))
        : [],
      folders: Array.isArray(response?.folders) ? response.folders : [],
      truncated: !!response?.truncated,
    };
  }

  /**
   * The client-visible documents on one matter.
   *
   * Scans that matter's storage prefix alone. Prefer this over filtering
   * `getDocuments()`, which walks the prefix of every matter the client is on.
   */
  async getMatterDocuments(
    lawFirmId: string,
    matterId: string,
    clientRecordId?: string,
  ): Promise<{ documents: Document[]; truncated: boolean }> {
    const response = await requestDeduplicator.execute<{ documents?: Document[]; truncated?: boolean }>(
      this.withClientRecordId(`${this.baseUrl}/lawfirm/${lawFirmId}/matters/${matterId}/documents`, clientRecordId),
      {
        method: 'GET',
        headers: await authenticatedHeaders(),
      }
    );

    return {
      documents: Array.isArray(response?.documents)
        ? response.documents.map((document) => this.normalizeDocument(document))
        : [],
      truncated: !!response?.truncated,
    };
  }

  /**
   * Sign a download URL for one document the client is opening, whichever place
   * it came from: a matter, their own file area, or a standalone task.
   *
   * Listings carry no URL, so this is how a document is opened. The server
   * resolves the scope from the object path and re-checks that this client may
   * read it, so a document un-shared since the list loaded cannot be fetched.
   */
  async refreshDocumentUrl(
    lawFirmId: string,
    objectPath: string,
    clientRecordId?: string
  ): Promise<{ downloadUrl: string }> {
    const response = await apiFetch(
      this.withClientRecordId(`${this.baseUrl}/lawfirm/${lawFirmId}/documents/refresh-url`, clientRecordId),
      {
        method: 'POST',
        headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ objectPath }),
      }
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to open this document');
    }

    return response.json();
  }

  // Matter-scoped variant, kept for callers that already know the matter.
  async refreshMatterDocumentUrl(
    lawFirmId: string,
    matterId: string,
    objectPath: string,
    clientRecordId?: string
  ): Promise<{ downloadUrl: string }> {
    const response = await apiFetch(
      this.withClientRecordId(`${this.baseUrl}/lawfirm/${lawFirmId}/matters/${matterId}/documents/refresh-url`, clientRecordId),
      {
        method: 'POST',
        headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ objectPath }),
      }
    );

    if (!response.ok) {
      throw await toApiError(response, 'Failed to refresh document link');
    }

    return response.json();
  }

  // List the firm's document requests for this client. Pass matterId to scope to
  // a single matter's requests. Returns open + completed/cancelled requests with
  // their checklist items and any files already uploaded per item.
  async getDocumentRequests(lawFirmId: string, matterId?: string, clientRecordId?: string): Promise<DocumentRequest[]> {
    const qs = matterId ? `?matterId=${encodeURIComponent(matterId)}` : '';

    const response = await requestDeduplicator.execute<{ requests?: DocumentRequest[] }>(
      this.withClientRecordId(`${this.baseUrl}/lawfirm/${lawFirmId}/document-requests${qs}`, clientRecordId),
      {
        method: 'GET',
        headers: await authenticatedHeaders(),
      }
    );

    return Array.isArray(response?.requests) ? response.requests : [];
  }

  /**
   * Upload one selection through a direct-upload route and file what landed.
   *
   * Shared by the two document uploads below, which differ only in their route
   * and what the server does after the files land. `uploadResumable` is the one
   * uploader every path in the app uses; it carries no API credential, because
   * a signed session url is already the authorization and a bearer token would
   * send this client's credential to a third-party host.
   *
   * The server takes at most `PORTAL_DOCUMENTS_PER_REQUEST` files per init, so
   * a longer selection is declared in groups. It is still sent and filed as ONE
   * batch, in ONE finalize: nothing is filed until every byte of every group
   * has landed, so a cancel anywhere before that files nothing at all, and the
   * firm is told of the upload once. A selection over
   * `PORTAL_DOCUMENTS_PER_UPLOAD` is refused before anything is opened.
   *
   * `signal` cancels, rejecting with `UploadCancelledError`. It never reaches
   * finalize, including a cancel that lands after the last byte, because
   * finalize is what turns landed bytes into filed documents. `onFinalizing`
   * fires just before finalize goes out, the point past which a cancel stops
   * nothing.
   *
   * A file that is not filed is named in `failures` rather than dropped: a group
   * init refused, or one finalize refused or did not stamp. The call rejects
   * only when nothing was filed, so a refused single file is an error and not
   * an empty success.
   *
   * Init claims a row per file and holds a quota reservation for it until
   * finalize or the cancel route gives it back (it lapses after two hours). So
   * a batch that stops short of finalize, cancelled or failed, sends the cancel
   * route every session every group opened, including one from an init that
   * answers after the cancel. It is not awaited: the rejection reaches the
   * caller at once, and a release that fails is not reported.
   */
  private async sendDirectUpload(
    baseUrl: string,
    files: File[],
    options: {
      clientRecordId?: string;
      onProgress?: (progress: number) => void;
      signal?: AbortSignal;
      onFinalizing?: () => void;
    },
  ): Promise<{ documents: UploadedMatterDocument[]; failures: PortalUploadFailure[] }> {
    const { clientRecordId, onProgress, signal, onFinalizing } = options;
    const failures: PortalUploadFailure[] = [];
    if (files.length === 0) return { documents: [], failures };
    // Refused before any init: past this the single finalize would be refused
    // after every row was claimed and every byte sent.
    if (files.length > PORTAL_DOCUMENTS_PER_UPLOAD) {
      throw new Error(`Only ${PORTAL_DOCUMENTS_PER_UPLOAD} files can be uploaded at once.`);
    }

    type Opened = { uploadUrl: string; objectPath: string; fileId: string; fileName: string; reservationId?: string; isFinalized?: boolean };
    const groups: Array<{ start: number; uploads: Opened[] }> = [];
    const actionKeys: Array<{ file: File; scope: string }> = [];
    const requestUpload = baseUrl.includes('/document-requests/');
    const actionFor = (group: File[]) => {
      const scope = `${baseUrl}:${clientRecordId || ''}:${group.map((file) => {
        let id = this.uploadFileIds.get(file);
        if (!id) { id = crypto.randomUUID(); this.uploadFileIds.set(file, id); }
        return id;
      }).join(',')}`;
      const first = group[0];
      let actions = this.uploadActions.get(first);
      if (!actions) { actions = new Map(); this.uploadActions.set(first, actions); }
      let actionKey = actions.get(scope);
      if (!actionKey) { actionKey = crypto.randomUUID(); actions.set(scope, actionKey); }
      actionKeys.push({ file: first, scope });
      return actionKey;
    };
    const forgetActions = () => {
      for (const { file, scope } of actionKeys) this.uploadActions.get(file)?.delete(scope);
    };

    /**
     * Give back what init opened, once, without the caller waiting on it. A
     * hold this misses still lapses on its own, so its failure is not reported.
     */
    let released = false;
    const releaseOpened = (late: Opened[] = []) => {
      const uploads = [...groups.flatMap((group) => group.uploads), ...late]
        .map((upload) => ({ fileId: upload.fileId, reservationId: upload.reservationId }));
      if (released || uploads.length === 0) return;
      released = true;
      forgetActions();
      this.postJson(this.withClientRecordId(`${baseUrl}/upload-cancel`, clientRecordId), { uploads })
        .catch(() => {});
    };

    const stopIfCancelled = () => {
      if (signal?.aborted) {
        releaseOpened();
        throw new UploadCancelledError();
      }
    };
    /**
     * Settles as cancelled the moment the signal fires. Init goes through the
     * shared `postJson`, which takes no signal, so the request runs on and
     * claims its rows either way; they are released with the rest when it
     * answers, and the user is not kept waiting on a reply to something they
     * withdrew.
     */
    const unlessCancelled = (work: Promise<{ uploads: Opened[] }>): Promise<{ uploads: Opened[] }> => {
      if (!signal) return work;
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          work.then((late) => releaseOpened(late.uploads || []), () => releaseOpened());
          reject(new UploadCancelledError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        // Removed as the answer lands rather than a turn later, so a cancel
        // after that is handled once, by the caller, and not also here.
        const settle = () => signal.removeEventListener('abort', onAbort);
        work.then((value) => { settle(); resolve(value); }, (err) => { settle(); reject(err); });
      });
    };

    let firstRefusal: unknown = null;
    const failAll = (start: number, count: number, err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      for (let i = start; i < start + count; i += 1) failures.push({ name: files[i].name, error, index: i });
    };

    for (let start = 0; start < files.length; start += PORTAL_DOCUMENTS_PER_REQUEST) {
      // Before each group, since every init claims rows and reserves quota.
      stopIfCancelled();
      const group = files.slice(start, start + PORTAL_DOCUMENTS_PER_REQUEST);
      try {
        const opened = await unlessCancelled(this.postJson<{ uploads: Opened[] }>(
          this.withClientRecordId(`${baseUrl}/upload-init`, clientRecordId),
          {
            ...(requestUpload ? { actionKey: actionFor(group) } : {}),
            files: group.map((file) => ({
              fileName: file.name,
              contentType: file.type || 'application/octet-stream',
              size: file.size,
            })),
          },
        ));
        groups.push({ start, uploads: opened.uploads || [] });
      } catch (err) {
        if (err instanceof UploadCancelledError) throw err;
        // A refused group costs only its own files; the groups already opened
        // go on to be sent and filed.
        firstRefusal ??= err;
        failAll(start, group.length, err);
      }
    }
    if (groups.length === 0) throw firstRefusal;

    // Progress spans the batch, so one bar tracks the upload rather than
    // dropping back to zero on each document.
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0) || 1;
    const sentPerFile = new Array<number>(files.length).fill(0);
    const report = () => {
      if (!onProgress) return;
      const sent = sentPerFile.reduce((sum, n) => sum + n, 0);
      onProgress(Math.min(100, Math.round((sent / totalBytes) * 100)));
    };

    try {
      for (const { start, uploads } of groups) {
        for (let j = 0; j < uploads.length; j += 1) {
          const i = start + j;
          // Sequential uploading keeps the browser
          // holding one file's worth of upload buffer rather than ten.
          if (uploads[j].isFinalized) {
            sentPerFile[i] = files[i].size;
            report();
            continue;
          }
          await uploadResumable({
            file: files[i],
            sessionUrl: uploads[j].uploadUrl,
            contentType: files[i].type || 'application/octet-stream',
            onTransportBytes: (bytes: number) => { sentPerFile[i] = bytes; report(); },
            signal,
          });
        }
      }
    } catch (err) {
      // Nothing opened is finalized now, cancelled or failed.
      releaseOpened();
      // An abort can surface from the transport as a plain network error (an
      // empty file's single PUT), so the signal decides, not the error type.
      if (signal?.aborted || err instanceof UploadCancelledError) throw new UploadCancelledError();
      throw err;
    }

    // A cancel after the last byte landed aborted no request, so nothing above
    // threw. Finalize has not run, and must not.
    stopIfCancelled();
    onFinalizing?.();

    // Every group in one call. Finalize is what tells the firm a client
    // uploaded (and records a checklist item's fulfilment), so a call per
    // group announced one selection several times.
    const opened = groups.flatMap(({ start, uploads }) => uploads.map((upload, j) => ({ upload, index: start + j })));
    type Settled = {
      documents?: UploadedMatterDocument[];
      failures?: Array<{ objectPath?: string | null; error: string }>;
    };
    const documents: UploadedMatterDocument[] = [];
    let settled: Settled | null = null;
    try {
      settled = await this.postJson<Settled>(
        this.withClientRecordId(`${baseUrl}/upload-finalize`, clientRecordId),
        // Each upload carries back its `reservationId`, which finalize deletes.
        { uploads: opened.map(({ upload }) => upload) },
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      for (const { index } of opened) failures.push({ name: files[index].name, error, index });
    }
    if (settled) {
      const filed = settled.documents || [];
      documents.push(...filed);
      // Every file sent to finalize and not stamped by it failed THERE. The
      // server names a refusal by object path; one it did not recognise at
      // all is known only by being absent from `documents`.
      const filedIds = new Set(filed.map((doc) => doc.fileId));
      const refusedBecause = new Map(
        (settled.failures || [])
          .filter((f) => !!f.objectPath)
          .map((f): [string, string] => [String(f.objectPath), f.error]),
      );
      for (const { upload, index } of opened) {
        if (filedIds.has(upload.fileId)) continue;
        failures.push({
          name: files[index].name,
          error: refusedBecause.get(upload.objectPath) ?? 'The file could not be saved. Please try again.',
          index,
        });
      }
    }

    if (failures.length === 0) forgetActions();
    failures.sort((a, b) => a.index - b.index);
    if (documents.length === 0 && failures.length > 0) throw new Error(failures[0].error);
    return { documents, failures };
  }

  /**
   * Upload files straight into a matter, not tied to a request.
   *
   * These used to be POSTed to the API as multipart through a hand-rolled
   * XMLHttpRequest here: ten files at a hundred megabytes each, all resident in
   * the API container before the handler ran.
   */
  async uploadMatterDocuments(
    lawFirmId: string,
    matterId: string,
    files: File[],
    onProgress?: (progress: number) => void,
    clientRecordId?: string,
    signal?: AbortSignal,
    onFinalizing?: () => void,
  ): Promise<{ documents: UploadedMatterDocument[]; failures: PortalUploadFailure[] }> {
    const base = `${this.baseUrl}/lawfirm/${lawFirmId}/matters/${matterId}/documents`;
    return this.sendDirectUpload(base, files, { clientRecordId, onProgress, signal, onFinalizing });
  }

  /**
   * Fulfil one checklist item on a document request by uploading files for it.
   *
   * Returns the stored documents plus the request and item ids, so the caller
   * can move that one checklist line to "received" without refetching.
   */
  async fulfillRequestItem(
    lawFirmId: string,
    requestId: string,
    itemId: string,
    files: File[],
    onProgress?: (progress: number) => void,
    clientRecordId?: string,
    signal?: AbortSignal,
    onFinalizing?: () => void,
  ): Promise<{ documents: UploadedMatterDocument[]; failures: PortalUploadFailure[]; requestId: string; itemId: string }> {
    const base = `${this.baseUrl}/lawfirm/${lawFirmId}/document-requests/${requestId}/items/${itemId}/fulfill`;
    const { documents, failures } = await this.sendDirectUpload(
      base, files, { clientRecordId, onProgress, signal, onFinalizing },
    );
    return { documents, failures, requestId, itemId };
  }

  /**
   * A short-lived signed URL for a file attached to a document-request
   * checklist item, so the client can preview or download it. Works for a
   * file the client uploaded themselves as well as one the firm attached.
   */
  async getRequestFulfillmentUrl(
    lawFirmId: string,
    requestId: string,
    itemId: string,
    fulfillmentId: string,
    clientRecordId?: string
  ): Promise<{ signedUrl: string; fileName: string; contentType: string; size: number }> {
    const response = await apiFetch(
      this.withClientRecordId(`${this.baseUrl}/lawfirm/${lawFirmId}/document-requests/${requestId}/items/${itemId}/fulfillments/${fulfillmentId}/url`, clientRecordId),
      { headers: await authenticatedHeaders() }
    );
    if (!response.ok) {
      throw await toApiError(response, 'Failed to open this file');
    }
    return response.json();
  }

  /** Remove a file the client uploaded themselves against a checklist item. */
  async deleteRequestFulfillment(
    lawFirmId: string,
    requestId: string,
    itemId: string,
    fulfillmentId: string,
    clientRecordId?: string
  ): Promise<DocumentRequest> {
    const response = await apiFetch(
      this.withClientRecordId(`${this.baseUrl}/lawfirm/${lawFirmId}/document-requests/${requestId}/items/${itemId}/fulfillments/${fulfillmentId}`, clientRecordId),
      { method: 'DELETE', headers: await authenticatedHeaders() }
    );
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) {
      throw await toApiError(response, 'Failed to remove this file');
    }
    return body.request as DocumentRequest;
  }

  // Every conversation the client participates in for one firm - their own direct
  // thread (if any) plus every group thread (a company's canonical conversation
  // for each company association, and any ad-hoc group), tagged with which client
  // record each belongs to. Organization-clients plan Phase 7.
  async listConversations(lawFirmId: string): Promise<{ conversations: PortalConversationSummary[]; totalItems: number }> {
    return requestDeduplicator.execute<{ conversations: PortalConversationSummary[]; totalItems: number }>(
      `${this.baseUrl}/lawfirm/${lawFirmId}/messages/conversations`,
      {
        method: 'GET',
        headers: await authenticatedHeaders(),
      }
    );
  }

  // One page of the direct thread with a law firm, newest first. `lastMessageId`
  // is the oldest message already held, so passing it returns the page before it
  // (the same cursor contract the group thread uses). `hasMore` says whether an
  // older page exists.
  async getMessages(
    lawFirmId: string,
    opts: { limit?: number; lastMessageId?: string } = {}
  ): Promise<{ messages: Message[]; hasMore?: boolean }> {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.lastMessageId) params.set('lastMessageId', opts.lastMessageId);
    const qs = params.toString();

    return requestDeduplicator.execute<{ messages: Message[]; hasMore?: boolean }>(
      `${this.baseUrl}/lawfirm/${lawFirmId}/messages${qs ? `?${qs}` : ''}`,
      {
        method: 'GET',
        headers: await authenticatedHeaders(),
      }
    );
  }

  /**
   * Discard attachments the client uploaded but never sent, so their bytes stop
   * counting against the firm's storage. The personal thread's
   * `${lawFirmId}_${uid}` key is not a conversation id, so it discards with
   * none, exactly as it uploads. The server deletes only the client's own
   * finalized objects that no message names, and a repeat is harmless.
   */
  async discardMessageAttachments(
    lawFirmId: string,
    objectPaths: string[],
    conversationId?: string,
  ): Promise<{ discarded: number }> {
    if (objectPaths.length === 0) return { discarded: 0 };
    const isDirectKey = !!conversationId && conversationId.startsWith(`${lawFirmId}_`);
    const scope = conversationId && !isDirectKey ? { conversationId } : {};
    return this.postJson<{ discarded: number }>(
      `${this.baseUrl}/lawfirm/${lawFirmId}/messages/attachments/discard`,
      { ...scope, objectPaths },
    );
  }

  /**
   * Upload attachment files before sending a portal message.
   *
   * Pass `conversationId` for group threads so the server stores the files
   * under the group's folder; the group send endpoint only accepts attachments
   * from it, and the server refuses outright if this client is not a
   * participant.
   *
   * The files used to be POSTed to the API as multipart through a hand-rolled
   * XMLHttpRequest here: five at a hundred megabytes each, all resident in the
   * API container before the handler ran. Three steps now, and the middle one
   * goes browser to storage. `uploadResumable` is shared with every other
   * upload path, and it carries no API credential: the signed session url is
   * already the authorization, so a bearer token would send this client's
   * credential to a host that never needed it.
   *
   * `signal` cancels. Any step it interrupts rejects with `UploadCancelledError`,
   * and a cancel never reaches finalize, including one that lands after the
   * last byte: finalize is what turns landed bytes into attachments.
   * `onFinalizing` fires just before finalize goes out, the point past which a
   * cancel can no longer withdraw anything.
   *
   * Init holds a quota reservation per file that only finalize or the cancel
   * route gives back before it lapses (two hours). So a batch that stops short
   * of finalize, cancelled or failed, sends the cancel route every session init
   * opened, without the rejection waiting on it.
   */
  async uploadMessageAttachments(
    lawFirmId: string,
    files: File[],
    onProgress?: (progress: number) => void,
    conversationId?: string,
    options: {
      signal?: AbortSignal;
      onFinalizing?: () => void;
      // Called with the files finalize refused (a type or content check, say),
      // by name. The rest still come back as attachments.
      onRejected?: (rejected: Array<{ name: string; error: string }>) => void;
    } = {}
  ): Promise<MessageAttachment[]> {
    if (files.length === 0) return [];
    const { signal, onFinalizing, onRejected } = options;
    const base = `${this.baseUrl}/lawfirm/${lawFirmId}/messages/attachments`;
    // The personal thread is keyed `${lawFirmId}_${uid}` on the portal until (and
    // after) its row exists. That key is not a conversation id, and the route
    // refuses one, so the direct thread uploads with no conversation id at all.
    const isDirectKey = !!conversationId && conversationId.startsWith(`${lawFirmId}_`);
    const scope = conversationId && !isDirectKey ? { conversationId } : {};

    type Opened = { uploads: Array<{ uploadUrl: string; objectPath: string; fileName: string; reservationId?: string }> };
    /**
     * Give back what init opened, once. Best effort and not awaited: the client
     * has already moved on, and a hold this misses still lapses on its own.
     */
    let released = false;
    const release = (batch: Opened | null | undefined) => {
      const uploads = (batch?.uploads || [])
        .map((u) => ({ objectPath: u.objectPath, reservationId: u.reservationId }));
      if (released || uploads.length === 0) return;
      released = true;
      this.postJson(`${base}/upload-cancel`, { ...scope, uploads }).catch(() => {});
    };

    /**
     * Settles as cancelled the moment the signal fires, whatever `work` does.
     * Init goes through the shared `postJson`, which takes no signal, so the
     * request itself runs to completion and reserves; what it opened is
     * released when it answers, without the client waiting on it.
     */
    const unlessCancelled = (work: Promise<Opened>): Promise<Opened> => {
      if (!signal) return work;
      return new Promise<Opened>((resolve, reject) => {
        const onAbort = () => {
          work.then(release, () => {});
          reject(new UploadCancelledError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        // Removed as the answer lands rather than a turn later, so a cancel
        // after that is handled once, by the caller, and not also here.
        const settle = () => signal.removeEventListener('abort', onAbort);
        work.then((value) => { settle(); resolve(value); }, (err) => { settle(); reject(err); });
      });
    };

    // Null until init answers, so a failure before then has nothing to release.
    let opened: Opened | null = null;
    try {
      // Checked before init as well, since init reserves quota for the batch.
      if (signal?.aborted) throw new UploadCancelledError();
      opened = await unlessCancelled(this.postJson<Opened>(`${base}/upload-init`, {
        ...scope,
        files: files.map((file) => ({
          fileName: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
        })),
      }));

      // Progress spans the whole batch, so one bar tracks the send rather than
      // dropping back to zero on each attachment.
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0) || 1;
      const sentPerFile = new Array<number>(files.length).fill(0);
      const report = () => {
        if (!onProgress) return;
        const sent = sentPerFile.reduce((sum, n) => sum + n, 0);
        onProgress(Math.min(100, Math.round((sent / totalBytes) * 100)));
      };

      for (let i = 0; i < files.length; i += 1) {
        // Sequential uploading keeps the browser
        // holding one file's worth of upload buffer rather than five.
        await uploadResumable({
          file: files[i],
          sessionUrl: opened.uploads[i].uploadUrl,
          contentType: files[i].type || 'application/octet-stream',
          onTransportBytes: (bytes: number) => { sentPerFile[i] = bytes; report(); },
          signal,
        });
      }
    } catch (err) {
      // Whatever init opened is never finalized now. An init that is still
      // answering is released by the abort handler above instead.
      release(opened);
      if (signal?.aborted || err instanceof UploadCancelledError) throw new UploadCancelledError();
      throw err;
    }

    // A cancel that arrived after the last byte landed interrupted nothing, so
    // only the signal says the client withdrew these files.
    if (signal?.aborted) {
      release(opened);
      throw new UploadCancelledError();
    }

    onFinalizing?.();
    const settled = await this.postJson<{
      attachments: MessageAttachment[];
      failures?: Array<{ objectPath?: string | null; fileName?: string; error?: string }>;
    }>(
      `${base}/upload-finalize`,
      // Each upload carries back its `reservationId`, which finalize deletes.
      { ...scope, uploads: opened.uploads },
    );
    const refused = settled.failures || [];
    if (refused.length > 0) {
      const batch = opened.uploads;
      onRejected?.(refused.map((f) => ({
        name: f.fileName || batch.find((u) => u.objectPath === f.objectPath)?.fileName || 'A file',
        error: f.error || '',
      })));
    }
    return settled.attachments || [];
  }

  /** POST JSON to the portal API with the caller's credential, or throw. */
  private async postJson<T>(url: string, body: unknown): Promise<T> {
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => ({} as any));
    if (!response.ok) {
      throw new Error(parsed?.error || 'Upload failed');
    }
    return parsed as T;
  }

  // Send a message to a law firm
  async sendMessage(
    lawFirmId: string,
    content: string,
    matterId?: string,
    attachments?: MessageAttachment[]
  ): Promise<{ messageId: string }> {
    const response = await apiFetch(`${this.baseUrl}/lawfirm/${lawFirmId}/messages`, {
      method: 'POST',
      headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ content, matterId, attachments }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to send message');
    }

    return response.json();
  }

  // Edit one of the client's own messages (direct or group; sender-only server-side).
  async editMessage(messageId: string, content: string): Promise<{ messageId: string; editedAt: string }> {
    const response = await apiFetch(`${API_URL}/messaging/messages/${messageId}`, {
      method: 'PATCH',
      headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ content }),
    });
    if (!response.ok) throw await toApiError(response, 'Failed to edit message');
    return response.json();
  }

  // Soft-delete one of the client's own messages (rendered as a tombstone).
  async deleteMessage(messageId: string): Promise<{ messageId: string }> {
    const response = await apiFetch(`${API_URL}/messaging/messages/${messageId}`, {
      method: 'DELETE',
      headers: await authenticatedHeaders(),
    });
    if (!response.ok) throw await toApiError(response, 'Failed to delete message');
    return response.json();
  }

  // Search message content across the conversations this client participates in.
  async searchMessages(q: string): Promise<MessageSearchResult[]> {
    const params = new URLSearchParams({ q });
    const response = await apiFetch(`${API_URL}/messaging/search?${params}`, {
      headers: await authenticatedHeaders(),
    });
    if (!response.ok) throw await toApiError(response, 'Failed to search messages');
    const data = await response.json();
    return data.results || [];
  }

  // Mark messages as read for client portal
  async markAsRead(lawFirmId: string, messageIds: string[]): Promise<void> {
    const response = await apiFetch(`${this.baseUrl}/lawfirm/${lawFirmId}/messages/mark-read`, {
      method: 'PUT',
      headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ messageIds }),
    });
    if (!response.ok) throw await toApiError(response, 'Failed to mark messages as read');
  }

  // Get unread message count (used by polling, force token refresh to avoid 401 spam)
  //
  // Left on a direct getFirebaseToken(true) call rather than the shared
  // authenticatedHeaders() helper: this deliberately forces a fresh Firebase
  // token on every poll (authenticatedHeaders() always uses the 5-minute
  // cache), and that distinction is the whole point of the comment above.
  async getUnreadCount(): Promise<{ totalUnread: number; unreadByFirm: { [key: string]: number } }> {
    const token = await getFirebaseToken(true);

    return requestDeduplicator.execute<{ totalUnread: number; unreadByFirm: { [key: string]: number } }>(
      `${this.baseUrl}/unread-count`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  }

  // Get Stripe checkout URL for an invoice payment. `method` restricts the
  // session to card or bank transfer and applies any fee the firm passes on.
  async getPaymentCheckoutUrl(
    lawFirmId: string,
    invoiceId: string,
    clientRecordId?: string,
    method?: PaymentMethodKind,
  ): Promise<{ checkoutUrl: string }> {
    const base = `${this.baseUrl}/lawfirm/${lawFirmId}/billing/pay/${encodeURIComponent(invoiceId)}`;
    return this.getPaymentResource(
      this.withClientRecordId(method ? `${base}?method=${method}` : base, clientRecordId),
      'Failed to get payment URL',
    );
  }

  // What paying an invoice online costs by each method, for the method chooser.
  async getPaymentOptions(lawFirmId: string, invoiceId: string, clientRecordId?: string): Promise<PaymentOptions> {
    return this.getPaymentResource(
      this.withClientRecordId(
        `${this.baseUrl}/lawfirm/${lawFirmId}/billing/pay/${encodeURIComponent(invoiceId)}/options`,
        clientRecordId,
      ),
      'Failed to load payment options',
    );
  }

  /** What the entered card pays on this invoice. Charges nothing. */
  quoteCard(lawFirmId: string, invoiceId: string, clientRecordId: string | undefined, confirmationTokenId: string): Promise<CardQuote> {
    return this.postCardStep(lawFirmId, invoiceId, clientRecordId, 'quote', { confirmationTokenId }, "We couldn't check this card");
  }

  /** Charge the card, refused unless the total is still the one the client saw. */
  confirmCard(
    lawFirmId: string,
    invoiceId: string,
    clientRecordId: string | undefined,
    confirmationTokenId: string,
    expectedTotalCents: number,
  ): Promise<CardConfirmResult> {
    return this.postCardStep(
      lawFirmId, invoiceId, clientRecordId, 'confirm', { confirmationTokenId, expectedTotalCents }, "The payment didn't go through",
    );
  }

  /** Record the payment once the client's bank verification step is done. */
  completeCard(lawFirmId: string, invoiceId: string, clientRecordId: string | undefined, paymentIntentId: string): Promise<CardConfirmResult> {
    return this.postCardStep(lawFirmId, invoiceId, clientRecordId, 'complete', { paymentIntentId }, "The payment didn't go through");
  }

  // Unlike `postJson`, a refusal keeps its ApiError code: the card form tells a
  // changed fee (FEE_CHANGED) apart from a declined card by it.
  private async postCardStep<T>(
    lawFirmId: string,
    invoiceId: string,
    clientRecordId: string | undefined,
    step: 'quote' | 'confirm' | 'complete',
    body: unknown,
    fallbackMessage: string,
  ): Promise<T> {
    const url = this.withClientRecordId(
      `${this.baseUrl}/lawfirm/${lawFirmId}/billing/pay/${encodeURIComponent(invoiceId)}/card/${step}`,
      clientRecordId,
    );
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await toApiError(response, fallbackMessage);
    return response.json();
  }

  private async getPaymentResource<T>(url: string, fallbackMessage: string): Promise<T> {
    const response = await apiFetch(url, {
      method: 'GET',
      headers: await authenticatedHeaders(),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const apiError = ApiError.fromResponse(response, error, fallbackMessage);
      // Extract specific validation detail if available
      const detail = error.details?.invoice?.[0] || error.details?.stripe?.[0] || error.details?.method?.[0];
      throw typeof detail === 'string' && detail ? new ApiError(detail, apiError) : apiError;
    }

    return response.json();
  }

  // Get trust balance for the current client
  async getTrustBalance(lawFirmId: string, clientRecordId?: string): Promise<{
    clientId: string;
    totalBalanceCents: number;
    accountBalances: Array<{ clientId: string; trustAccountId: string; accountName: string; balanceCents: number }>;
  }> {
    return requestDeduplicator.execute(
      this.withClientRecordId(`${this.baseUrl}/lawfirm/${lawFirmId}/trust/balance`, clientRecordId),
      {
        method: 'GET',
        headers: await authenticatedHeaders(),
      }
    );
  }

  // Get trust transaction ledger for the current client.
  // The backend paginates (validated limit 1-200 / offset >= 0) and returns
  // totalItems; thread both through so the portal can page rather than silently
  // truncating at the backend default page.
  async getTrustLedger(
    lawFirmId: string,
    opts: { limit?: number; offset?: number; clientRecordId?: string } = {}
  ): Promise<{
    transactions: Array<{
      id: string;
      type: 'deposit' | 'withdrawal' | 'transfer' | 'refund';
      amountCents: number;
      date: string;
      description: string;
      status: string;
      clientBalanceAfter: number;
      createdAt: string;
    }>;
    totalItems: number;
  }> {
    const params = new URLSearchParams();
    if (typeof opts.limit === 'number') params.set('limit', String(opts.limit));
    if (typeof opts.offset === 'number') params.set('offset', String(opts.offset));
    const qs = params.toString();

    return requestDeduplicator.execute(
      this.withClientRecordId(`${this.baseUrl}/lawfirm/${lawFirmId}/trust/ledger${qs ? `?${qs}` : ''}`, opts.clientRecordId),
      {
        method: 'GET',
        headers: await authenticatedHeaders(),
      }
    );
  }

  // Get upcoming events
  /**
   * The client's upcoming, client-visible matter events.
   *
   * `matterId` scopes the read to one matter rather than leaving the caller to
   * filter the firm-wide list: the server caps the agenda, so a matter's events
   * can sit entirely past the cap of the wider list. `truncated` says the cap was
   * reached, so a page can tell the client the agenda is partial.
   */
  async getEvents(
    lawFirmId: string,
    opts?: { matterId?: string; clientRecordId?: string },
  ): Promise<{ events: Event[]; truncated: boolean }> {
    const qs = opts?.matterId ? `?matterId=${encodeURIComponent(opts.matterId)}` : '';
    const response = await requestDeduplicator.execute<{ events?: Event[]; truncated?: boolean }>(
      this.withClientRecordId(`${this.baseUrl}/lawfirm/${lawFirmId}/events${qs}`, opts?.clientRecordId),
      {
        method: 'GET',
        headers: await authenticatedHeaders(),
      }
    );

    return {
      events: Array.isArray(response?.events) ? response.events : [],
      truncated: !!response?.truncated,
    };
  }

  // ── Group conversations (client side) ────────────────────────────────────
  // These routes live under `${API_URL}/messaging/client-groups`, NOT the
  // `client-portal` base, so they build off API_URL directly.

  // List the group threads this client participates in (across all their firms).
  async listGroups(): Promise<Conversation[]> {
    const response = await requestDeduplicator.execute<{ conversations?: Conversation[] }>(
      `${API_URL}/messaging/client-groups`,
      {
        method: 'GET',
        headers: await authenticatedHeaders(),
      }
    );
    return Array.isArray(response?.conversations) ? response.conversations : [];
  }

  // Load a single group thread: metadata, participants, and a page of messages.
  async getGroup(
    conversationId: string,
    opts: { limit?: number; lastMessageId?: string } = {}
  ): Promise<GroupConversationResponse> {
    const params = new URLSearchParams();
    if (opts.limit != null) params.set('limit', String(opts.limit));
    if (opts.lastMessageId) params.set('lastMessageId', opts.lastMessageId);
    const qs = params.toString();
    const response = await apiFetch(
      `${API_URL}/messaging/client-groups/${conversationId}${qs ? `?${qs}` : ''}`,
      {
        method: 'GET',
        headers: await authenticatedHeaders(),
      }
    );
    if (!response.ok) throw await toApiError(response, 'Failed to load group');
    return response.json();
  }

  async sendGroupMessage(
    conversationId: string,
    content: string,
    attachments?: MessageAttachment[]
  ): Promise<{ messageId: string; conversationId: string }> {
    const response = await apiFetch(`${API_URL}/messaging/client-groups/${conversationId}/messages`, {
      method: 'POST',
      headers: await authenticatedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ content, attachments }),
    });
    if (!response.ok) throw await toApiError(response, 'Failed to send message');
    return response.json();
  }

  async markGroupRead(conversationId: string): Promise<void> {
    const response = await apiFetch(`${API_URL}/messaging/client-groups/${conversationId}/mark-read`, {
      method: 'PUT',
      headers: await authenticatedHeaders(),
    });
    if (!response.ok) throw await toApiError(response, 'Failed to mark group as read');
  }


  // The client's in-app notification feed for a firm, plus their unread count.
  async getNotifications(
    lawFirmId: string,
    opts?: { unreadOnly?: boolean; limit?: number; before?: string; beforeId?: string },
  ): Promise<{
    notifications: PortalNotification[];
    unreadCount: number;
    nextBefore: string | null;
    nextBeforeId: string | null;
  }> {
    const q = new URLSearchParams();
    if (opts?.unreadOnly) q.set('unreadOnly', 'true');
    if (opts?.limit) q.set('limit', String(opts.limit));
    if (opts?.before) q.set('before', opts.before);
    if (opts?.beforeId) q.set('beforeId', opts.beforeId);
    const qs = q.toString() ? `?${q.toString()}` : '';
    const response = await requestDeduplicator.execute<{
      notifications?: PortalNotification[];
      unreadCount?: number;
      nextBefore?: string | null;
      nextBeforeId?: string | null;
    }>(
      `${this.baseUrl}/lawfirm/${lawFirmId}/notifications${qs}`,
      { method: 'GET', headers: await authenticatedHeaders() },
    );
    return {
      notifications: Array.isArray(response?.notifications) ? response.notifications : [],
      unreadCount: this.asNumber(response?.unreadCount),
      nextBefore: response?.nextBefore ?? null,
      nextBeforeId: response?.nextBeforeId ?? null,
    };
  }

  async markNotificationRead(lawFirmId: string, notificationId: string): Promise<void> {
    const response = await apiFetch(
      `${this.baseUrl}/lawfirm/${lawFirmId}/notifications/${notificationId}/read`,
      { method: 'POST', headers: await authenticatedHeaders() },
    );
    if (!response.ok) throw await toApiError(response, 'Failed to update notification');
  }

  async markAllNotificationsRead(lawFirmId: string): Promise<void> {
    const response = await apiFetch(
      `${this.baseUrl}/lawfirm/${lawFirmId}/notifications/mark-all-read`,
      { method: 'POST', headers: await authenticatedHeaders() },
    );
    if (!response.ok) throw await toApiError(response, 'Failed to update notifications');
  }
}

const clientPortalService = new ClientPortalService();
export default clientPortalService;
