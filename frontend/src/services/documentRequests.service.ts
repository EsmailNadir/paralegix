import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { toApiError } from '@/lib/utils/apiErrors';
import requestDeduplicator from './requestDeduplicator';
import { authenticatedHeaders } from './base.service';

/** ===== Types (align with backend) ===== */

export type DocumentRequestStatus = 'open' | 'completed' | 'cancelled';
export type DocumentRequestItemStatus = 'pending' | 'received' | 'waived';

/** A single file a client uploaded to satisfy a checklist item. */
export interface Fulfillment {
  id: string;
  itemId: string;
  objectPath: string;
  fileName: string;
  uploadedBy: string;
  uploadedByName: string;
  uploadedAt: string;
}

/** One checklist line on a document request (e.g. "2023 tax return"). */
export interface DocumentRequestItem {
  id: string;
  requestId: string;
  label: string;
  /** Optional detail shown to the client explaining what exactly is needed. */
  description: string;
  status: DocumentRequestItemStatus;
  sortOrder: number;
  fulfillments: Fulfillment[];
}

/** One checklist item as submitted from the create/update forms. */
export interface DocumentRequestItemInput {
  label: string;
  description?: string;
}

/** A request the firm sends a client asking for one or more documents.
 *  `matterId` is null for a "General" request, not tied to any matter. */
export interface DocumentRequest {
  id: string;
  lawFirmId: string;
  matterId: string | null;
  clientId: string;
  title: string;
  note: string | null;
  status: DocumentRequestStatus;
  dueDate: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  items: DocumentRequestItem[];
}

export interface CreateDocumentRequestPayload {
  /** Omit (or pass null) for a "General" request, not tied to any matter. */
  matterId?: string | null;
  clientId: string;
  title: string;
  note?: string;
  dueDate?: string | null;
  items?: DocumentRequestItemInput[];
}

export interface UpdateDocumentRequestPayload {
  title?: string;
  note?: string;
  status?: DocumentRequestStatus;
  dueDate?: string | null;
  addItems?: DocumentRequestItemInput[];
}

/** ===== Service ===== */

class DocumentRequestsService {
  private apiRoot: string;

  constructor() {
    const API_ROOT = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    this.apiRoot = API_ROOT.replace(/\/$/, '');
  }

  private base(lawFirmId: string): string {
    return `${this.apiRoot}/lawfirms/${encodeURIComponent(lawFirmId)}/document-requests`;
  }

  private async authHeaders(extra: Record<string, string> = {}) {
    return authenticatedHeaders({
      'Content-Type': 'application/json',
      ...extra,
    });
  }

  /** List every document request on a matter. Deduplicated GET. */
  /**
   * One page of a matter's document requests. Requests are never pruned, so a
   * long-running matter accumulates them and the list is windowed by the server.
   */
  async list(
    lawFirmId: string,
    matterId: string,
    params: { page?: number; limit?: number } = {},
  ): Promise<{ requests: DocumentRequest[]; totalRequests: number }> {
    const url = new URL(this.base(lawFirmId));
    url.searchParams.set('matterId', matterId);
    if (params.page) url.searchParams.set('page', String(params.page));
    if (params.limit) url.searchParams.set('limit', String(params.limit));

    const response = await requestDeduplicator.execute<{
      requests?: DocumentRequest[];
      totalRequests?: number;
    }>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });
    const requests = response?.requests ?? [];
    return { requests, totalRequests: response?.totalRequests ?? requests.length };
  }

  /**
   * Every document request addressed to a client, across every matter they're
   * on plus any "General" (no-matter) requests. Unlike `list`, this is not
   * paginated: the client-detail aggregate view reads the whole thing at once.
   * Cancelled requests are excluded server-side.
   */
  async listForClient(lawFirmId: string, clientId: string): Promise<DocumentRequest[]> {
    const url = `${this.base(lawFirmId)}/clients/${encodeURIComponent(clientId)}`;
    const response = await requestDeduplicator.execute<{ requests?: DocumentRequest[] }>(url, {
      method: 'GET',
      headers: await this.authHeaders(),
    });
    return response?.requests ?? [];
  }

  /** Create a new document request on a matter for a client. */
  async create(lawFirmId: string, payload: CreateDocumentRequestPayload): Promise<DocumentRequest> {
    const response = await apiFetch(this.base(lawFirmId), {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw await toApiError(response, 'Failed to create document request');
    return body.request as DocumentRequest;
  }

  /** Update a request's details, status, or append new checklist items. */
  async update(
    lawFirmId: string,
    id: string,
    payload: UpdateDocumentRequestPayload
  ): Promise<DocumentRequest> {
    const response = await apiFetch(`${this.base(lawFirmId)}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: await this.authHeaders(),
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw await toApiError(response, 'Failed to update document request');
    return body.request as DocumentRequest;
  }

  /** Delete a document request. */
  async remove(lawFirmId: string, id: string): Promise<{ message: string; requestId: string }> {
    const response = await apiFetch(`${this.base(lawFirmId)}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw await toApiError(response, 'Failed to delete document request');
    return body as { message: string; requestId: string };
  }

  /** Mark a single checklist item received or waived. */
  async setItemStatus(
    lawFirmId: string,
    id: string,
    itemId: string,
    status: DocumentRequestItemStatus
  ): Promise<DocumentRequest> {
    const response = await apiFetch(
      `${this.base(lawFirmId)}/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`,
      {
        method: 'PATCH',
        headers: await this.authHeaders(),
        body: JSON.stringify({ status }),
      }
    );
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw await toApiError(response, 'Failed to update item');
    return body.request as DocumentRequest;
  }

  /** Attach a document the firm already holds to an item, marking it received. */
  async linkFile(
    lawFirmId: string,
    id: string,
    itemId: string,
    fileId: string
  ): Promise<DocumentRequest> {
    const response = await apiFetch(
      `${this.base(lawFirmId)}/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/link-file`,
      {
        method: 'POST',
        headers: await this.authHeaders(),
        body: JSON.stringify({ fileId }),
      }
    );
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw await toApiError(response, 'Failed to link file');
    return body.request as DocumentRequest;
  }

  /** Remove an uploaded or linked file from an item. */
  async unlinkFile(
    lawFirmId: string,
    id: string,
    itemId: string,
    fulfillmentId: string
  ): Promise<DocumentRequest> {
    const response = await apiFetch(
      `${this.base(lawFirmId)}/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/files/${encodeURIComponent(fulfillmentId)}`,
      {
        method: 'DELETE',
        headers: await this.authHeaders(),
      }
    );
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw await toApiError(response, 'Failed to remove file');
    return body.request as DocumentRequest;
  }
}

const documentRequestsService = new DocumentRequestsService();

export default documentRequestsService;
