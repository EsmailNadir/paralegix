import { getUserTimeZone } from '@/lib/utils/timezone';
import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { toApiError } from '@/lib/utils/apiErrors';
import type { MatterEvent, MatterEventType, MatterEventStatus, LinkedFile, RecurrenceRule, EventGraphNode } from '@/types/matterEvent';
import { authenticatedHeaders } from './base.service';


export interface CreateMatterEventRequest {
  type: MatterEventType;
  title: string;
  date: string;
  /** An all-day end is the exclusive day after the last day. */
  endsAt?: string;
  notes?: string;
  locationName?: string;
  location?: string;
  status?: MatterEventStatus;
  assignedTo?: string[];
  assignedToName?: string[];
  /** Directory contacts attending. Replace-set: sending [] clears them. */
  contactIds?: string[];
  linkedFiles?: Omit<LinkedFile, 'linkedBy' | 'linkedAt'>[];
  dependsOn?: string[];
  recurrence?: RecurrenceRule;
  clientVisible?: boolean;
  clientDescription?: string | null;
  timeZone?: string | null;
  allDay?: boolean;
}

export interface UpdateMatterEventRequest {
  type?: MatterEventType;
  title?: string;
  date?: string;
  /** Null removes the end. An all-day end is the exclusive day after the last day. */
  endsAt?: string | null;
  notes?: string | null;
  locationName?: string | null;
  location?: string | null;
  status?: MatterEventStatus;
  assignedTo?: string[];
  assignedToName?: string[];
  /** Directory contacts attending. Replace-set: sending [] clears them. */
  contactIds?: string[];
  linkedFiles?: Omit<LinkedFile, 'linkedBy' | 'linkedAt'>[];
  dependsOn?: string[];
  clientVisible?: boolean;
  clientDescription?: string | null;
  timeZone?: string | null;
  allDay?: boolean;
}

export interface MatterEventsResponse {
  events: MatterEvent[];
  totalEvents: number;
}

export interface MatterEventResponse {
  message: string;
  eventId: string;
  event: MatterEvent;
}

class MatterEventsService {
  private baseApi: string;

  constructor() {
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    this.baseApi = API_URL.replace(/\/$/, '');
  }

  private eventsUrl(lawFirmId: string, matterId: string, eventId?: string): string {
    const base = `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/matters/${encodeURIComponent(matterId)}/events`;
    return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
  }

  private async authHeaders(extra: Record<string, string> = {}) {
    return authenticatedHeaders(extra);
  }

  /**
   * Firm-wide matter events for the calendar.
   *
   * `window` bounds the read to the days being drawn. Omitting it returns every
   * event across the viewer's matters, which is the old behaviour and is only
   * appropriate for a caller that genuinely needs the whole history.
   */
  async listAllEvents(lawFirmId: string, window?: { from: string; to: string }): Promise<MatterEventsResponse> {
    const tz = getUserTimeZone();
    const url = new URL(`${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/matters/events`);
    url.searchParams.append('tz', tz);
    if (window) {
      url.searchParams.append('from', window.from);
      url.searchParams.append('to', window.to);
    }

    const res = await apiFetch(url.toString(), {
      headers: await this.authHeaders(),
    });
    if (!res.ok) {
      throw await toApiError(res, 'Failed to load matter events');
    }
    return res.json();
  }

  /**
   * The matter's event dependency graph: id / title / status / date / dependsOn.
   *
   * Deliberately separate from `listEvents`, which can be a page. Dependency
   * blocking resolves against this, and a dependency that was merely not loaded
   * is dropped by the resolver and reads as "no dependency" - which looks exactly
   * like "not blocked" on a deadline that is blocked.
   */
  async getEventGraph(lawFirmId: string, matterId: string): Promise<{ events: EventGraphNode[] }> {
    const res = await apiFetch(`${this.eventsUrl(lawFirmId, matterId)}/graph`, {
      headers: await this.authHeaders(),
    });
    if (!res.ok) {
      throw await toApiError(res, 'Failed to load event dependencies');
    }
    return res.json();
  }

  /**
   * One status section of the matter's events, paged by the server. Serves the
   * LIST only; blocking reads the graph above.
   */
  async getEventsPage(
    lawFirmId: string,
    matterId: string,
    params: { status?: string; page?: number; limit?: number },
  ): Promise<MatterEventsResponse> {
    const url = new URL(this.eventsUrl(lawFirmId, matterId));
    url.searchParams.append('tz', getUserTimeZone());
    if (params.status) url.searchParams.set('status', params.status);
    if (params.page) url.searchParams.set('page', String(params.page));
    if (params.limit) url.searchParams.set('limit', String(params.limit));

    const res = await apiFetch(url.toString(), {
      headers: await this.authHeaders(),
    });
    if (!res.ok) {
      throw await toApiError(res, 'Failed to load matter events');
    }
    return res.json();
  }

  async listEvents(lawFirmId: string, matterId: string): Promise<MatterEventsResponse> {
    const url = new URL(this.eventsUrl(lawFirmId, matterId));
    url.searchParams.append('tz', getUserTimeZone());

    const res = await apiFetch(url.toString(), {
      headers: await this.authHeaders(),
    });
    if (!res.ok) {
      throw await toApiError(res, 'Failed to load matter events');
    }
    return res.json();
  }

  async createEvent(lawFirmId: string, matterId: string, payload: CreateMatterEventRequest): Promise<MatterEventResponse> {
    const res = await apiFetch(this.eventsUrl(lawFirmId, matterId), {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw await toApiError(res, 'Failed to create matter event');
    }
    return res.json();
  }

  async updateEvent(lawFirmId: string, matterId: string, eventId: string, payload: UpdateMatterEventRequest): Promise<{ message: string; event: MatterEvent }> {
    const res = await apiFetch(this.eventsUrl(lawFirmId, matterId, eventId), {
      method: 'PUT',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw await toApiError(res, 'Failed to update matter event');
    }
    return res.json();
  }

  async deleteEvent(lawFirmId: string, matterId: string, eventId: string): Promise<{ message: string; eventId: string }> {
    const res = await apiFetch(this.eventsUrl(lawFirmId, matterId, eventId), {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });
    if (!res.ok) {
      throw await toApiError(res, 'Failed to delete matter event');
    }
    return res.json();
  }

  async postponeEvent(lawFirmId: string, matterId: string, eventId: string, payload: { newDate: string; reason?: string }): Promise<{ message: string; event: MatterEvent }> {
    const res = await apiFetch(`${this.eventsUrl(lawFirmId, matterId, eventId)}/postpone`, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw await toApiError(res, 'Failed to postpone event');
    }
    return res.json();
  }

  async cancelEvent(lawFirmId: string, matterId: string, eventId: string, payload: { reason: string }): Promise<{ message: string; event: MatterEvent }> {
    const res = await apiFetch(`${this.eventsUrl(lawFirmId, matterId, eventId)}/cancel`, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw await toApiError(res, 'Failed to cancel event');
    }
    return res.json();
  }

  async deleteRecurrenceGroup(lawFirmId: string, matterId: string, groupId: string): Promise<{ message: string }> {
    const res = await apiFetch(`${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/matters/${encodeURIComponent(matterId)}/events/recurrence/${encodeURIComponent(groupId)}`, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });
    if (!res.ok) {
      throw await toApiError(res, 'Failed to delete recurring events');
    }
    return res.json();
  }
}

const matterEventsService = new MatterEventsService();

export default matterEventsService;
