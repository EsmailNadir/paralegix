import { ApiError, isApiError } from '@/lib/utils/apiErrors';
import AuthService from './auth.service';
import { BaseApiService, type ApiRequestOptions } from './base.service';
import type { ExistingEventSyncItem } from '@/lib/utils/existingEventsSyncPayload';
import type { CalendarAuthStatus, CalendarConnectionState } from '@/types/preferences';

export const OUTLOOK_CALENDAR_RECONNECT_CODE = 'OUTLOOK_CALENDAR_RECONNECT_REQUIRED' as const;
export const OUTLOOK_CALENDAR_RECONNECT_EVENT = 'paralegix-outlook-calendar-reconnect' as const;

export class OutlookCalendarReconnectRequiredError extends Error {
  readonly code = OUTLOOK_CALENDAR_RECONNECT_CODE;

  constructor(message = 'Microsoft Calendar needs to be reconnected. Open Settings -> General.') {
    super(message);
    this.name = 'OutlookCalendarReconnectRequiredError';
    Object.setPrototypeOf(this, OutlookCalendarReconnectRequiredError.prototype);
  }
}

export function isOutlookCalendarReconnectRequiredError(
  e: unknown
): e is OutlookCalendarReconnectRequiredError {
  if (e instanceof OutlookCalendarReconnectRequiredError) return true;
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: string }).code === OUTLOOK_CALENDAR_RECONNECT_CODE
  );
}

/**
 * A stale Microsoft grant is reported via the reconnect event only -- it never
 * redirects on its own. This runs from the background sync loop as much as
 * from an explicit user action, and an unprompted full-page redirect to
 * Microsoft's OAuth screen would yank the user off whatever they're doing.
 * Reconnecting is the OutlookCalendarReconnectBanner's job: it listens for
 * this event and lets the user opt in via Settings -> General.
 */
function triggerOutlookReconnect(message?: string): never {
  throw new OutlookCalendarReconnectRequiredError(announceOutlookCalendarReconnect(message));
}

/**
 * Raise the firm shell's Microsoft reconnect banner without redirecting. The
 * background sync also calls this when the API already reports the grant as
 * needing a reconnect. Returns the message it announced.
 */
export function announceOutlookCalendarReconnect(message?: string): string {
  const reconnectMessage = message?.trim()
    || 'Microsoft Calendar needs to be reconnected. Open Settings -> General.';

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(OUTLOOK_CALENDAR_RECONNECT_EVENT, {
        detail: { message: reconnectMessage },
      }),
    );
  }
  return reconnectMessage;
}

/** Skip all Outlook Calendar API calls on localhost (OAuth redirect URIs don't match) */
function isLocalDev(): boolean {
  return typeof window !== 'undefined' && window.location.hostname === 'localhost';
}

/**
 * Ask the backend to refresh the stored Microsoft grant. The token stays
 * server-side.
 *
 * Returns `'REFRESHED'`, `'NEEDS_REAUTH'` when only the user can restore the
 * grant, or null when there is no signed-in user to refresh for.
 */
async function ensureValidToken(): Promise<'REFRESHED' | 'NEEDS_REAUTH' | null> {
  const { auth } = await import('@/lib/firebase/config');
  if (!auth) {
    return null;
  }
  try {
    const user = auth.currentUser;
    if (!user) return null;

    try {
      if (await AuthService.refreshMicrosoftToken()) return 'REFRESHED';
    } catch (error) {
      console.warn('[OutlookCalendarSync] Token refresh failed, needs re-auth:', error);
    }

    return 'NEEDS_REAUTH';
  } catch (error) {
    console.warn('[OutlookCalendarSync] ensureValidToken failed:', error);
    return 'NEEDS_REAUTH';
  }
}

/**
 * Transport for the Outlook sync endpoints.
 *
 * A 401 from these routes is about the user's MICROSOFT grant, not their
 * Paralegix session, and recovering from it means refreshing the stored
 * Microsoft token server-side and retrying - a dance that used to be copied
 * inline at five call sites, each with its own hand-built Bearer header and
 * bare `fetch`. `apiFetch` only claims a 401 carrying a session code, so these
 * can now share the app's transport (timeout budget, network-error
 * classification, one credential path) while keeping their own recovery.
 */
class OutlookCalendarTransport extends BaseApiService {
  constructor() {
    super('outlook-calendar-sync');
  }

  /**
   * A request that recovers from a stale Microsoft grant.
   *
   * `reconnectMessage` is what the user is told if the grant cannot be restored
   * automatically; passing none opts the call out of recovery entirely, which
   * matches the endpoints that never attempted it (the read-only probes and the
   * to-Outlook pushes).
   */
  async send<T>(
    path: string,
    options: ApiRequestOptions,
    fallbackMessage: string,
    reconnectMessage?: string,
  ): Promise<T> {
    const url = `${this.baseUrl}/${path}`;
    const init = { errorMessage: fallbackMessage, ...options };

    try {
      return await this.request<T>(url, init);
    } catch (error) {
      if (!reconnectMessage || !isApiError(error) || error.status !== 401) throw error;

      // The refresh token is gone; only the user can restore the grant.
      if (error.code === 'NO_REFRESH_TOKEN') return triggerOutlookReconnect(reconnectMessage);

      const refreshed = await ensureValidToken();
      if (refreshed === 'NEEDS_REAUTH') return triggerOutlookReconnect(reconnectMessage);
      if (!refreshed) throw new ApiError('Failed to refresh Microsoft token', { status: 401 });

      // The retry deliberately does not force a fresh Firebase ID token the way
      // this code used to. `apiFetch` owns Firebase-session 401s now - they
      // carry a session code and never reach here - so at this point the session
      // is known good and the Microsoft token was the only stale credential.
      return await this.request<T>(url, init);
    }
  }
}

const transport = new OutlookCalendarTransport();

/**
 * The backend reports a calendar it could not provision through the generic
 * error channel; these endpoints have always replaced that text with something
 * a user can act on.
 */
function remapCalendarInitFailure(error: unknown, replacement: string): unknown {
  if (isApiError(error) && error.message.includes('Failed to get or create Paralegix calendar')) {
    return new ApiError(replacement, {
      status: error.status,
      code: error.code,
      details: error.details,
      requestId: error.requestId,
    });
  }
  return error;
}

export class OutlookCalendarSync {
  // Sync tasks from Outlook Calendar to Paralegix - never throws, returns result
  static async syncFromOutlook(lawFirmId: string): Promise<{ success: boolean; error?: string; [key: string]: any }> {
    const { auth } = await import('@/lib/firebase/config');
    if (!auth || isLocalDev()) {
      return { success: false, skipped: true };
    }
    try {
      return await transport.send(
        'sync-from-outlook',
        { method: 'POST', body: { lawFirmId } },
        'Failed to sync from Outlook Calendar',
        'Microsoft Calendar needs to be reconnected before syncing from Outlook.',
      );
    } catch (error) {
      const remapped = remapCalendarInitFailure(
        error,
        'Failed to initialize Paralegix calendar. Please try again.',
      );
      const msg = (remapped as Error)?.message || 'Failed to sync from Outlook Calendar';
      return { success: false, error: msg };
    }
  }

  // Get user's Outlook Calendars
  static async getOutlookCalendars(): Promise<Array<{
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
        'Failed to fetch Outlook Calendars',
      );
      return data.calendars || [];
    } catch (error) {
      console.error('Failed to fetch Outlook Calendars:', error);
      throw error;
    }
  }

  // Get Paralegix calendar specifically
  static async getParalegixCalendar(): Promise<{
    id: string;
    name: string;
    color: string;
  } | null> {
    try {
      const calendars = await this.getOutlookCalendars();
      const paralegixCalendar = calendars.find(cal => cal.name === 'Paralegix');
      return paralegixCalendar ? {
        id: paralegixCalendar.id,
        name: paralegixCalendar.name,
        color: paralegixCalendar.color
      } : null;
    } catch (error) {
      console.error('Failed to get Paralegix calendar:', error);
      return null;
    }
  }

  // Enable silent sync (creates a Microsoft Graph subscription)
  static async enableSilentSync(lawFirmId: string): Promise<{ success: boolean; expirationDateTime?: string }> {
    const { auth } = await import('@/lib/firebase/config');
    if (!auth || isLocalDev()) return { success: false };

    return transport.send(
      'enable-silent-sync',
      { method: 'POST', body: { lawFirmId } },
      'Failed to enable silent sync',
    );
  }

  // Disable silent sync (stops all subscriptions)
  static async disableSilentSync(): Promise<void> {
    const { auth } = await import('@/lib/firebase/config');
    if (!auth || isLocalDev()) return;

    await transport.send(
      'disable-silent-sync',
      { method: 'POST' },
      'Failed to disable silent sync',
    );
  }

  // Sync tasks to Outlook Calendar
  static async syncTasksToOutlook(tasks: Array<{
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
        'sync-tasks-to-outlook',
        { method: 'POST', body: { tasks } },
        'Failed to sync tasks to Outlook Calendar',
      );
    } catch (error) {
      console.error('Failed to sync tasks to Outlook Calendar:', error);
      throw remapCalendarInitFailure(error, 'Failed to initialize Paralegix calendar. Please try again.');
    }
  }

  // Sync matter and client events to Outlook Calendar
  static async syncEventsToOutlook(events: ExistingEventSyncItem[]): Promise<any> {
    const { auth } = await import('@/lib/firebase/config');
    if (!auth || isLocalDev()) {
      return { success: false, skipped: true };
    }
    try {
      return await transport.send(
        'sync-events-to-outlook',
        { method: 'POST', body: { events } },
        'Failed to sync events to Outlook Calendar',
      );
    } catch (error) {
      console.error('Failed to sync events to Outlook Calendar:', error);
      throw remapCalendarInitFailure(error, 'Failed to initialize Paralegix calendar. Please try again.');
    }
  }

  // Check if user is authenticated with Outlook
  /**
   * The API's reading of the stored grant. `state` is present only when the
   * API answered, so a caller can tell "not connected" from "could not ask".
   */
  static async checkOutlookAuth(): Promise<CalendarAuthStatus> {
    const { auth } = await import('@/lib/firebase/config');
    if (!auth || isLocalDev()) {
      return { authenticated: false };
    }
    // A signed-out user has no Microsoft grant to report on. This probe is what
    // the settings screen calls to decide whether to offer a connect button, so
    // it reports a negative result rather than prompting for a reconnect.
    if (!auth.currentUser) return { authenticated: false };

    try {
      const data = await transport.send<{ authenticated?: boolean; state?: CalendarConnectionState; email?: string | null }>(
        'check-auth',
        { method: 'GET' },
        'Failed to check Outlook auth',
      );
      return {
        authenticated: data.authenticated === true,
        state: data.state ?? 'disconnected',
        email: data.email || undefined,
      };
    } catch (error) {
      console.error('Failed to check Outlook auth:', error);
      return { authenticated: false };
    }
  }

  // Initialize Paralegix calendar - never throws, returns result object
  static async initParalegixCalendar(): Promise<{
    success: boolean;
    message?: string;
    calendar?: {
      id: string;
      name: string;
      color: string;
    };
    error?: string;
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
        'Microsoft Calendar needs to be reconnected before initializing the Outlook calendar.',
      );
    } catch (error) {
      const msg = (error as Error)?.message || 'Failed to initialize Paralegix calendar';
      return { success: false, error: msg };
    }
  }

  // Utility method to refresh Microsoft tokens when they're invalid
  static async refreshMicrosoftTokens(): Promise<boolean> {
    try {
      // Try automatic refresh first
      if ((await ensureValidToken()) === 'REFRESHED') return true;

      await triggerOutlookReconnect('Microsoft Calendar needs to be reconnected before continuing.');
      return false;
    } catch (error) {
      console.error('❌ Error refreshing Microsoft tokens:', error);
      return false;
    }
  }
}
