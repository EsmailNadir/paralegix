import { ApiError, isApiError } from '@/lib/utils/apiErrors';
import { BaseApiService, type ApiRequestOptions } from './base.service';
import type { ExistingEventSyncItem } from '@/lib/utils/existingEventsSyncPayload';
import type { CalendarAuthStatus, CalendarConnectionState } from '@/types/preferences';

/** Thrown when the API returns 401. User must reconnect Google in Settings (no automatic OAuth redirect). */
export const GOOGLE_CALENDAR_RECONNECT_CODE = 'GOOGLE_CALENDAR_RECONNECT_REQUIRED' as const;

/**
 * The code the backend stamps on a 401 from this module, marking it as "the
 * Google grant needs reconnecting" rather than "the Paralegix session expired".
 * The bare-401 check below is kept alongside it so this file behaves correctly
 * against a backend that predates the code - the two deploy independently.
 */
const GOOGLE_REAUTH_CODE = 'GOOGLE_REAUTH_REQUIRED';

export class GoogleCalendarReconnectRequiredError extends Error {
  readonly code = GOOGLE_CALENDAR_RECONNECT_CODE;
  constructor(message = 'Google Calendar needs to be reconnected. Open Settings → General.') {
    super(message);
    this.name = 'GoogleCalendarReconnectRequiredError';
    Object.setPrototypeOf(this, GoogleCalendarReconnectRequiredError.prototype);
  }
}

export function isGoogleCalendarReconnectRequiredError(
  e: unknown
): e is GoogleCalendarReconnectRequiredError {
  if (e instanceof GoogleCalendarReconnectRequiredError) return true;
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: string }).code === GOOGLE_CALENDAR_RECONNECT_CODE
  );
}

export const GOOGLE_CALENDAR_RECONNECT_EVENT = 'paralegix-google-calendar-reconnect' as const;

const GOOGLE_RECONNECT_DEFAULT_MESSAGE = 'Google Calendar needs to be reconnected. Open Settings → General.';

/**
 * Raise the firm shell's Google reconnect banner. A 401 from a sync call raises
 * it, and so does the background sync when the API already reports the grant
 * as needing a reconnect. Returns the message it announced.
 */
export function announceGoogleCalendarReconnect(message?: string): string {
  const reconnectMessage = message?.trim() || GOOGLE_RECONNECT_DEFAULT_MESSAGE;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(GOOGLE_CALENDAR_RECONNECT_EVENT, { detail: { message: reconnectMessage } })
    );
  }
  return reconnectMessage;
}

/** Skip all Google Calendar API calls on localhost (OAuth redirect URIs don't match) */
function isLocalDev(): boolean {
  return typeof window !== 'undefined' && window.location.hostname === 'localhost';
}

/**
 * Transport for the Google sync endpoints.
 *
 * These calls used to bypass `apiFetch` and build their own Bearer headers off
 * `auth.currentUser.getIdToken()`. That skipped the shared timeout budget and
 * network-error classification, but it was not simply an oversight: a 401 here
 * means the Google grant is stale, and `apiFetch`'s generic 401 recovery
 * (refresh the Firebase token, retry, then reload the page) cannot fix that and
 * would reload on a loop. `apiFetch` now only claims a 401 that carries a
 * session code, so these can use the shared transport and still raise their own
 * reconnect prompt.
 */
class GoogleCalendarTransport extends BaseApiService {
  constructor() {
    super('google-calendar-sync');
  }

  /**
   * Translate a failed request into the reconnect signal when the server says
   * the Google grant is the problem, and preserve the long-standing special case
   * for a calendar that could not be provisioned.
   */
  private static rethrow(error: unknown, fallbackMessage: string, reconnectOn401: boolean): never {
    if (reconnectOn401 && isApiError(error) && (error.status === 401 || error.code === GOOGLE_REAUTH_CODE)) {
      const message = announceGoogleCalendarReconnect(error.message);
      throw new GoogleCalendarReconnectRequiredError(message);
    }

    if (isApiError(error) && error.message.includes('Failed to get or create Paralegix calendar')) {
      throw new ApiError('Failed to initialize Paralegix calendar. Please try again.', {
        status: error.status,
        code: error.code,
        details: error.details,
        requestId: error.requestId,
      });
    }

    if (isApiError(error)) throw error;
    throw new ApiError(fallbackMessage, {});
  }

  /**
   * `reconnectOn401` mirrors which calls historically inspected the status: the
   * sync and mutation endpoints prompt for a reconnect, while the read-only
   * probes (`check-auth`, `silent-sync-status`) report a negative result
   * silently. A probe must not raise the banner - it is what the settings screen
   * calls to decide whether to offer a connect button in the first place.
   */
  async send<T>(
    path: string,
    options: ApiRequestOptions,
    fallbackMessage: string,
    { reconnectOn401 = true }: { reconnectOn401?: boolean } = {},
  ): Promise<T> {
    try {
      return await this.request<T>(`${this.baseUrl}/${path}`, { errorMessage: fallbackMessage, ...options });
    } catch (error) {
      GoogleCalendarTransport.rethrow(error, fallbackMessage, reconnectOn401);
    }
  }
}

const transport = new GoogleCalendarTransport();

export class GoogleCalendarSync {
  // Sync tasks from Google Calendar to Paralegix
  static async syncFromGoogle(lawFirmId: string): Promise<any> {
    const { auth } = await import('@/lib/firebase/config');
    if (!auth || isLocalDev()) {
      return { success: false, skipped: true };
    }
    try {
      return await transport.send(
        'sync-from-google',
        { method: 'POST', body: { lawFirmId } },
        'Failed to sync from Google Calendar',
      );
    } catch (error) {
      console.error('Failed to sync from Google Calendar:', error);
      throw error;
    }
  }

  // Get user's Google Calendars
  static async getGoogleCalendars(): Promise<Array<{
    id: string;
    name: string;
    isDefault: boolean;
    color: string;
    canEdit: boolean;
  }>> {
    const { auth } = await import('@/lib/firebase/config');
    if (!auth || isLocalDev()) {
      return [];
    }
    try {
      const data = await transport.send<{ calendars?: any[] }>(
        'calendars',
        { method: 'GET' },
        'Failed to fetch Google Calendars',
      );
      return data.calendars || [];
    } catch (error) {
      console.error('Failed to fetch Google Calendars:', error);
      throw error;
    }
  }

  // Sync tasks to Google Calendar
  static async syncTasksToGoogle(tasks: Array<{
    taskId: string;
    lawFirmId: string;
    title: string;
    description?: string;
    location?: string | null;
    dueDate: any;
    dueDateTimeZone?: string | null;
  }>): Promise<any> {
    const { auth } = await import('@/lib/firebase/config');
    if (!auth || isLocalDev()) {
      return { success: false, skipped: true };
    }
    try {
      return await transport.send(
        'sync-tasks-to-google',
        { method: 'POST', body: { tasks } },
        'Failed to sync tasks to Google Calendar',
      );
    } catch (error) {
      console.error('Failed to sync tasks to Google Calendar:', error);
      throw error;
    }
  }

  // Sync matter and client events to Google Calendar
  static async syncEventsToGoogle(events: ExistingEventSyncItem[]): Promise<any> {
    const { auth } = await import('@/lib/firebase/config');
    if (!auth || isLocalDev()) {
      return { success: false, skipped: true };
    }
    try {
      return await transport.send(
        'sync-events-to-google',
        { method: 'POST', body: { events } },
        'Failed to sync events to Google Calendar',
      );
    } catch (error) {
      console.error('Failed to sync events to Google Calendar:', error);
      throw error;
    }
  }

  // Check if user is authenticated with Google
  /**
   * The API's reading of the stored grant. `state` is present only when the
   * API answered, so a caller can tell "not connected" from "could not ask".
   */
  static async checkGoogleAuth(): Promise<CalendarAuthStatus> {
    const { auth } = await import('@/lib/firebase/config');
    if (!auth || isLocalDev()) {
      return { authenticated: false };
    }
    // A signed-out user has no Google grant to report on, and this probe must
    // stay silent rather than raising the reconnect prompt.
    if (!auth.currentUser) return { authenticated: false };

    try {
      const data = await transport.send<{ authenticated?: boolean; state?: CalendarConnectionState; email?: string | null }>(
        'check-auth',
        { method: 'GET' },
        'Failed to check Google auth',
        { reconnectOn401: false },
      );
      return {
        authenticated: data.authenticated === true,
        state: data.state ?? 'disconnected',
        email: data.email || undefined,
      };
    } catch (error) {
      console.error('Failed to check Google auth:', error);
      return { authenticated: false };
    }
  }

  // Initialize Paralegix calendar
  static async initParalegixCalendar(): Promise<{
    success: boolean;
    message: string;
    calendar?: {
      id: string;
      name: string;
      color: string;
    };
  }> {
    const { auth } = await import('@/lib/firebase/config');
    if (!auth || isLocalDev()) {
      return { success: false, message: 'Skipped on localhost' };
    }
    try {
      return await transport.send(
        'init-paralegix-calendar',
        { method: 'POST' },
        'Failed to initialize Paralegix calendar',
      );
    } catch (error) {
      console.error('Failed to initialize Paralegix calendar:', error);
      throw error;
    }
  }

  // Enable silent sync (creates a Google Watch channel)
  static async enableSilentSync(lawFirmId: string): Promise<{ success: boolean; expiration?: string }> {
    const { auth } = await import('@/lib/firebase/config');
    if (!auth || isLocalDev()) return { success: false };

    return transport.send(
      'enable-silent-sync',
      { method: 'POST', body: { lawFirmId } },
      'Failed to enable silent sync',
    );
  }

  // Disable silent sync (stops all watch channels)
  static async disableSilentSync(): Promise<void> {
    const { auth } = await import('@/lib/firebase/config');
    if (!auth || isLocalDev()) return;

    await transport.send(
      'disable-silent-sync',
      { method: 'POST' },
      'Failed to disable silent sync',
      { reconnectOn401: false },
    );
  }

  // Check silent sync status
  static async getSilentSyncStatus(): Promise<{ enabled: boolean; expiration?: string | null }> {
    const { auth } = await import('@/lib/firebase/config');
    if (!auth || isLocalDev()) return { enabled: false };
    if (!auth.currentUser) return { enabled: false };

    try {
      return await transport.send(
        'silent-sync-status',
        { method: 'GET' },
        'Failed to read silent sync status',
        { reconnectOn401: false },
      );
    } catch {
      return { enabled: false };
    }
  }

  // Get Paralegix calendar specifically
  static async getParalegixCalendar(): Promise<{
    id: string;
    name: string;
    color: string;
  } | null> {
    try {
      const calendars = await this.getGoogleCalendars();
      const paralegixCalendar = calendars.find(cal => cal.name === 'Paralegix');
      return paralegixCalendar ? {
        id: paralegixCalendar.id,
        name: paralegixCalendar.name,
        color: paralegixCalendar.color
      } : null;
    } catch (error) {
      if (isGoogleCalendarReconnectRequiredError(error)) throw error;
      console.error('Failed to get Paralegix calendar:', error);
      return null;
    }
  }
}
