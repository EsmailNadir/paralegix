import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { ApiError } from '@/lib/utils/apiErrors';
import requestDeduplicator from './requestDeduplicator';
import { authenticatedHeaders } from './base.service';

// Mirrors the `entity_type` check constraint on the notifications table.
export type NotificationEntityType =
  | 'task'
  | 'matter'
  | 'invoice'
  | 'message'
  | 'note'
  | 'file'
  | null;

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  entityType: NotificationEntityType;
  entityId: string | null;
  matterId: string | null;
  lawFirmId: string;
  actionUrl: string | null;
  createdAt: string | null;
  createdBy: string | null;
}

export interface ListNotificationsResponse {
  notifications: Notification[];
  // Rows matching the current filters, not the size of this page.
  total: number;
  // Composite cursor for the next page (both null when this is the last page).
  // `nextBeforeId` breaks ties between rows sharing a created_at.
  nextBefore?: string | null;
  nextBeforeId?: string | null;
}

export interface UnreadCountResponse {
  unreadCount: number;
}

export interface NotificationFeedResponse {
  notifications: Notification[];
  total: number;
  unreadCount: number;
}


class NotificationsService {
  private apiRoot: string;

  constructor() {
    this.apiRoot = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
  }

  private async authHeaders(extra: Record<string, string> = {}) {
    return authenticatedHeaders({
      'Content-Type': 'application/json',
      ...extra,
    });
  }

  private baseUrl(lawFirmId: string): string {
    return `${this.apiRoot}/lawfirms/${encodeURIComponent(lawFirmId)}/notifications`;
  }

  async list(
    lawFirmId: string,
    opts?: { unreadOnly?: boolean; types?: string[]; limit?: number; before?: string; beforeId?: string },
  ): Promise<ListNotificationsResponse> {
    const url = new URL(this.baseUrl(lawFirmId));
    if (opts?.unreadOnly) url.searchParams.set('unreadOnly', 'true');
    if (opts?.types?.length) url.searchParams.set('types', opts.types.join(','));
    if (opts?.limit) url.searchParams.set('limit', String(opts.limit));
    if (opts?.before) url.searchParams.set('before', opts.before);
    if (opts?.beforeId) url.searchParams.set('beforeId', opts.beforeId);

    return requestDeduplicator.execute<ListNotificationsResponse>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });
  }

  async getUnreadCount(lawFirmId: string): Promise<UnreadCountResponse> {
    return requestDeduplicator.execute<UnreadCountResponse>(`${this.baseUrl(lawFirmId)}/count`, {
      method: 'GET',
      headers: await this.authHeaders(),
    });
  }

  async getFeed(lawFirmId: string, opts?: { unreadOnly?: boolean; limit?: number }): Promise<NotificationFeedResponse> {
    const url = new URL(`${this.baseUrl(lawFirmId)}/feed`);
    if (opts?.unreadOnly) url.searchParams.set('unreadOnly', 'true');
    if (opts?.limit) url.searchParams.set('limit', String(opts.limit));

    return requestDeduplicator.execute<NotificationFeedResponse>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });
  }

  async markRead(lawFirmId: string, notificationId: string): Promise<{ message: string }> {
    const res = await apiFetch(`${this.baseUrl(lawFirmId)}/${encodeURIComponent(notificationId)}/read`, {
      method: 'POST',
      headers: await this.authHeaders(),
    });
    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Something went wrong.');
    return body;
  }

  async markUnread(lawFirmId: string, notificationId: string): Promise<{ message: string }> {
    const res = await apiFetch(`${this.baseUrl(lawFirmId)}/${encodeURIComponent(notificationId)}/unread`, {
      method: 'POST',
      headers: await this.authHeaders(),
    });
    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Something went wrong.');
    return body;
  }

  async markAllRead(lawFirmId: string): Promise<{ message: string; updated: number }> {
    const res = await apiFetch(`${this.baseUrl(lawFirmId)}/mark-all-read`, {
      method: 'POST',
      headers: await this.authHeaders(),
    });
    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Something went wrong.');
    return body;
  }

  async remove(lawFirmId: string, notificationId: string): Promise<{ message: string }> {
    const res = await apiFetch(`${this.baseUrl(lawFirmId)}/${encodeURIComponent(notificationId)}`, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });
    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Something went wrong.');
    return body;
  }
}

const notificationsService = new NotificationsService();
export default notificationsService;
