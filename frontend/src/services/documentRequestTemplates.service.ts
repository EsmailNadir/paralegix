import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { toApiError } from '@/lib/utils/apiErrors';
import requestDeduplicator from './requestDeduplicator';
import { authenticatedHeaders } from './base.service';

/** One checklist item on a preset: a label plus an optional description shown to the client. */
export interface DocumentRequestTemplateItem {
  label: string;
  description: string | null;
}

/** A firm-level reusable preset applied when creating a document request. */
export interface DocumentRequestTemplate {
  id: string;
  name: string;
  defaultTitle: string;
  defaultNote: string | null;
  items: DocumentRequestTemplateItem[];
  archived: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDocumentRequestTemplatePayload {
  name: string;
  defaultTitle: string;
  defaultNote?: string | null;
  items?: DocumentRequestTemplateItem[];
}

export interface UpdateDocumentRequestTemplatePayload {
  name?: string;
  defaultTitle?: string;
  defaultNote?: string | null;
  items?: DocumentRequestTemplateItem[];
  archived?: boolean;
}

class DocumentRequestTemplatesService {
  private apiRoot: string;

  constructor() {
    const API_ROOT = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    this.apiRoot = API_ROOT.replace(/\/$/, '');
  }

  private base(lawFirmId: string): string {
    return `${this.apiRoot}/lawfirms/${encodeURIComponent(lawFirmId)}/document-request-templates`;
  }

  private async authHeaders(extra: Record<string, string> = {}) {
    return authenticatedHeaders({
      'Content-Type': 'application/json',
      ...extra,
    });
  }

  /** All non-archived templates for a firm. Deduplicated GET. */
  async list(lawFirmId: string, includeArchived = false): Promise<DocumentRequestTemplate[]> {
    const url = new URL(this.base(lawFirmId));
    if (includeArchived) url.searchParams.set('includeArchived', 'true');

    const response = await requestDeduplicator.execute<{ templates?: DocumentRequestTemplate[] }>(
      url.toString(),
      { method: 'GET', headers: await this.authHeaders() },
    );
    return response?.templates ?? [];
  }

  async create(
    lawFirmId: string,
    payload: CreateDocumentRequestTemplatePayload,
  ): Promise<{ message: string; templateId: string; template: DocumentRequestTemplate }> {
    const response = await apiFetch(this.base(lawFirmId), {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw await toApiError(response, 'Failed to create template');
    return body;
  }

  async update(
    lawFirmId: string,
    id: string,
    payload: UpdateDocumentRequestTemplatePayload,
  ): Promise<{ message: string; template: DocumentRequestTemplate }> {
    const response = await apiFetch(`${this.base(lawFirmId)}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: await this.authHeaders(),
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw await toApiError(response, 'Failed to update template');
    return body;
  }

  /** Archives (soft-deletes) a template. */
  async remove(lawFirmId: string, id: string): Promise<{ message: string; templateId: string }> {
    const response = await apiFetch(`${this.base(lawFirmId)}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw await toApiError(response, 'Failed to delete template');
    return body;
  }
}

const documentRequestTemplatesService = new DocumentRequestTemplatesService();

export default documentRequestTemplatesService;
