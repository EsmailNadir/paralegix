import { getUserTimeZone } from '@/lib/utils/timezone';
import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { toApiError } from '@/lib/utils/apiErrors';
import type {
  Contact, ContactCategory, ContactMatterLink, ContactUpsertPayload,
} from '@/types/contact';
import requestDeduplicator from './requestDeduplicator';
import { applyListSortSearch, applyListWindow } from '@/lib/utils/listQuery';
import { authenticatedHeaders } from './base.service';

// The lookup envelope is declared once, alongside the matters service, because
// every /lookup endpoint answers in the same shape.
import type { LookupResult } from './matters.service';
export type { LookupItem, FullLookupItem, LookupResult } from './matters.service';

export interface ContactListParams {
  page?: number;
  limit?: number;
  offset?: number;
  search?: string;
  category?: ContactCategory | '';
  /** Only the contacts on this matter / at this court. */
  matterId?: string;
  courtId?: string;
  /** Every contact tied to any court, for the courts settings page. */
  hasCourt?: boolean;
  tags?: string[];
  /** Archived contacts are hidden by default. */
  archived?: 'true' | 'false' | 'all';
  /** One-time contacts (created just for a single matter) are hidden by default. */
  oneTime?: 'true' | 'false' | 'all';
  sortBy?: string;
  order?: 'asc' | 'desc';
  sort?: Array<{ field: string; sort: 'asc' | 'desc' }>;
}

export interface CreateContactResponse {
  message: string;
  contactId: string;
  contact: Contact;
}

export interface DeleteContactResponse {
  message: string;
  contactId: string;
  /** How many matters the contact was removed from by the delete. */
  unlinkedMatters: number;
}

class ContactsService {
  private apiRoot: string;

  constructor() {
    const API_ROOT = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    this.apiRoot = API_ROOT.replace(/\/$/, '');
  }

  private contactsBase(lawFirmId: string): string {
    return `${this.apiRoot}/lawfirms/${encodeURIComponent(lawFirmId)}/contacts`;
  }

  private contactUrl(lawFirmId: string, contactId: string): string {
    return `${this.contactsBase(lawFirmId)}/${encodeURIComponent(contactId)}`;
  }

  private async authHeaders(extra: Record<string, string> = {}) {
    return authenticatedHeaders(extra);
  }

  /** One server page of the directory. */
  async listContactsPaged(
    lawFirmId: string,
    params: ContactListParams = {},
  ): Promise<{ contacts: Contact[]; totalItems: number }> {
    const url = new URL(this.contactsBase(lawFirmId));
    applyListWindow(url, params, { maxLimit: 500 });

    if (params.category) url.searchParams.set('category', params.category);
    if (params.matterId) url.searchParams.set('matterId', params.matterId);
    if (params.courtId) url.searchParams.set('courtId', params.courtId);
    if (params.hasCourt) url.searchParams.set('hasCourt', 'true');
    if (params.tags?.length) url.searchParams.set('tags', params.tags.join(','));
    if (params.archived) url.searchParams.set('archived', params.archived);
    if (params.oneTime) url.searchParams.set('oneTime', params.oneTime);
    applyListSortSearch(url, params);

    const response = await requestDeduplicator.execute<{ contacts?: Contact[]; totalItems?: number }>(
      url.toString(),
      {
        method: 'GET',
        headers: await this.authHeaders({ 'X-Timezone': getUserTimeZone() }),
      },
    );

    const contacts = response?.contacts ?? [];
    return { contacts, totalItems: response?.totalItems ?? contacts.length };
  }

  /**
   * Typeahead source for contact pickers. `excludeMatterId` drops the contacts
   * already on that matter, so the "add to matter" picker doesn't offer a
   * duplicate the link endpoint would then reject.
   */
  async lookupContacts(
    lawFirmId: string,
    {
      search,
      ids,
      category,
      excludeMatterId,
      limit,
      full,
    }: {
      search?: string;
      ids?: string[];
      category?: ContactCategory;
      excludeMatterId?: string;
      limit?: number;
      /** Return the whole contact on each item, for pickers that pre-fill a form. */
      full?: boolean;
    } = {},
  ): Promise<LookupResult> {
    const url = new URL(`${this.contactsBase(lawFirmId)}/lookup`);
    if (search) url.searchParams.set('search', search);
    if (ids?.length) url.searchParams.set('ids', ids.join(','));
    if (category) url.searchParams.set('category', category);
    if (excludeMatterId) url.searchParams.set('excludeMatterId', excludeMatterId);
    if (limit != null) url.searchParams.set('limit', String(limit));
    if (full) url.searchParams.set('full', 'true');

    const response = await requestDeduplicator.execute<Partial<LookupResult>>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders({ 'X-Timezone': getUserTimeZone() }),
    });

    return { items: response?.items ?? [], hasMore: response?.hasMore ?? false };
  }

  /** One contact plus the matters it appears on. */
  async getContact(
    lawFirmId: string,
    contactId: string,
  ): Promise<{ contact: Contact; matters: ContactMatterLink[] }> {
    const url = this.contactUrl(lawFirmId, contactId);

    const response = await requestDeduplicator.execute<{
      contact?: Contact;
      matters?: ContactMatterLink[];
    }>(url, {
      method: 'GET',
      headers: await this.authHeaders(),
      params: { lawFirmId, contactId },
    });

    if (!response?.contact) throw new Error('Contact not found');
    return {
      contact: response.contact,
      matters: response.matters ?? [],
    };
  }

  /**
   * Import contacts from a CSV or vCard file. The raw text is parsed server-side
   * so both dialects are defined in one place. Rows matching an existing contact
   * are skipped rather than duplicated, and the response says how many.
   */
  async importContacts(
    lawFirmId: string,
    format: 'csv' | 'vcard',
    content: string,
  ): Promise<{
    message: string;
    imported: number;
    skipped: Array<{ row: number; name: string; existingContactId: string }>;
    failed: Array<{ row: number; reason: string }>;
  }> {
    const url = `${this.contactsBase(lawFirmId)}/import`;
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ format, content }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to import contacts', { method: 'POST', url });
    }

    return response.json();
  }

  /**
   * Download the directory as a file. Answers with the file body rather than
   * JSON, and carries the current list filters so the export matches what is on
   * screen.
   */
  async exportContacts(
    lawFirmId: string,
    format: 'csv' | 'vcard',
    filters: { search?: string; category?: string; tags?: string[]; archived?: string } = {},
  ): Promise<Blob> {
    const url = new URL(`${this.contactsBase(lawFirmId)}/export`);
    url.searchParams.set('format', format);
    if (filters.search) url.searchParams.set('search', filters.search);
    if (filters.category) url.searchParams.set('category', filters.category);
    if (filters.tags?.length) url.searchParams.set('tags', filters.tags.join(','));
    if (filters.archived) url.searchParams.set('archived', filters.archived);

    const response = await apiFetch(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to export contacts', { method: 'GET', url: url.toString() });
    }

    return response.blob();
  }

  /** The distinct tags in use across the directory, for the filter menu. */
  async listTags(lawFirmId: string): Promise<string[]> {
    const url = `${this.contactsBase(lawFirmId)}/tags`;

    const response = await requestDeduplicator.execute<{ tags?: string[] }>(url, {
      method: 'GET',
      headers: await this.authHeaders(),
      params: { lawFirmId },
    });

    return response?.tags ?? [];
  }

  /**
   * Advisory near-match check for the create form: never throws on a match,
   * just reports what it found so the caller can show a warning while the
   * user is still typing.
   */
  async checkDuplicates(lawFirmId: string, { name, email }: { name?: string; email?: string }): Promise<{ duplicates: Contact[] }> {
    const url = new URL(`${this.contactsBase(lawFirmId)}/duplicate-check`);
    if (name) url.searchParams.set('name', name);
    if (email) url.searchParams.set('email', email);

    const response = await requestDeduplicator.execute<{ duplicates?: Contact[] }>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });

    return { duplicates: response?.duplicates ?? [] };
  }

  /** Add a contact to the directory. */
  async createContact(lawFirmId: string, payload: ContactUpsertPayload & { name: string }): Promise<CreateContactResponse> {
    const url = this.contactsBase(lawFirmId);
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to create contact', { method: 'POST', url });
    }

    return response.json();
  }

  async updateContact(
    lawFirmId: string,
    contactId: string,
    payload: ContactUpsertPayload,
  ): Promise<{ message: string; contact: Contact }> {
    const url = this.contactUrl(lawFirmId, contactId);
    const response = await apiFetch(url, {
      method: 'PUT',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to update contact', { method: 'PUT', url });
    }

    return response.json();
  }

  /** Deleting cascades to the matter links; the response reports how many. */
  async deleteContact(lawFirmId: string, contactId: string): Promise<DeleteContactResponse> {
    const url = this.contactUrl(lawFirmId, contactId);
    const response = await apiFetch(url, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to delete contact', { method: 'DELETE', url });
    }

    return response.json();
  }
}

const contactsService = new ContactsService();
export default contactsService;
