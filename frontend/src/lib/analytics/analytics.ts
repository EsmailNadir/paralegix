import posthog from "posthog-js";
import { scrubCapture } from "./sanitize";

/**
 * Product analytics, backed by PostHog. This module is the only code that may
 * import `posthog-js`; everything else goes through the functions below.
 *
 * Nothing about a firm's clients or their matters may leave through here: no
 * names, emails, note or message text, file names or money amounts. Event
 * properties are typed to primitives so a whole record cannot be passed by
 * accident; keep them to IDs, enums, counts and booleans.
 */

// Every product event the frontend sends. Dashboards and funnels are built on
// these names, so rename one only together with the insights that use it.
export type AnalyticsEvent =
  | "user_registered"
  | "user_logged_in"
  | "checkout_started"
  | "member_invited"
  | "client_invited"
  | "calendar_connected"
  | "matter_created"
  | "lead_converted"
  | "task_created"
  | "note_created"
  | "time_entry_created"
  | "invoice_created"
  | "invoice_sent"
  | "trust_transaction_recorded"
  | "message_sent"
  | "client_document_uploaded";

export type AnalyticsProperties = Record<string, string | number | boolean | null>;

export type AnalyticsUserType = "firm_member" | "client";

// Proxied through this app's own origin (see `rewrites` in next.config.ts), so
// ad blockers do not drop events and the CSP needs no third-party origin.
export const ANALYTICS_PROXY_PATH = "/ingest";

let initialized = false;
// Set when the visitor declines analytics. PostHog, once started, cannot be
// stopped, so it is opted out and every call below becomes a no-op.
let disabled = false;

// Who the app says is signed in, kept until PostHog starts. Where a visitor has
// to accept analytics first, sign-in usually happens before PostHog exists.
let pendingUserId: string | null = null;
let pendingContext: { userType: AnalyticsUserType; lawFirmId: string | null } | null = null;

function active(): boolean {
  return initialized && !disabled;
}

/**
 * Starts PostHog when the environment has a project token. Local, staging and
 * production each point at their own PostHog project, so test traffic never
 * mixes with real usage. A missing token is a silent no-op rather than an
 * error, so an environment without analytics configured (and every test) still
 * runs.
 */
export function initAnalytics(): void {
  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  if (initialized || disabled || !token || typeof window === "undefined") return;

  posthog.init(token, {
    api_host: ANALYTICS_PROXY_PATH,
    ui_host: process.env.NEXT_PUBLIC_POSTHOG_UI_HOST || "https://us.posthog.com",
    defaults: "2026-01-30",
    // Only the named events above plus pageviews. Autocapture would record the
    // text of clicked elements, which on this app is client and matter names.
    autocapture: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_performance: false,
    // Session replay would record privileged client information on screen.
    disable_session_recording: true,
    disable_surveys: true,
    capture_exceptions: true,
    person_profiles: "identified_only",
    // Once a visitor declines, PostHog stores nothing, rather than writing its
    // id back after `disableAnalytics` cleared it.
    opt_out_persistence_by_default: true,
    before_send: scrubCapture,
  });
  initialized = true;
  applyPending();
}

function applyPending(): void {
  if (pendingUserId) identifyNow(pendingUserId);
  if (pendingContext) contextNow(pendingContext.userType, pendingContext.lawFirmId);
  pendingUserId = null;
  pendingContext = null;
}

/** Turns analytics on after the visitor accepts: starts PostHog, or opts back in. */
export function enableAnalytics(): void {
  disabled = false;
  if (!initialized) {
    initAnalytics();
    return;
  }
  posthog.opt_in_capturing();
  applyPending();
}

/**
 * Turns analytics off after the visitor declines: stops capture and removes the
 * id PostHog stored in this browser, so nothing identifies them afterwards.
 */
export function disableAnalytics(): void {
  disabled = true;
  if (initialized) posthog.opt_out_capturing();
  clearPostHogStorage();
}

// PostHog keeps its id under `ph_<token>_posthog` in both a cookie and local
// storage. The cookie may be set on the parent domain to span subdomains, so it
// is expired on every suffix of the current host.
function clearPostHogStorage(): void {
  if (typeof window === "undefined") return;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("ph_")) localStorage.removeItem(key);
    }
  } catch {
    // Storage unavailable; nothing was stored there.
  }
  const labels = window.location.hostname.split(".");
  const domains = labels.map((_, i) => labels.slice(i).join("."));
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0].trim();
    if (!name.startsWith("ph_")) continue;
    document.cookie = `${name}=; Max-Age=0; path=/`;
    for (const domain of domains) {
      document.cookie = `${name}=; Max-Age=0; path=/; domain=${domain}`;
    }
  }
}

export function track(event: AnalyticsEvent, properties?: AnalyticsProperties): void {
  if (!active()) return;
  posthog.capture(event, properties);
}

/**
 * Ties this browser's events to a signed-in user. Only the user's id (the
 * Firebase UID, which is also `users.id` on the backend) is sent: no email or
 * name, so PostHog holds no directly identifying data.
 */
export function identifyUser(userId: string): void {
  if (!active()) {
    pendingUserId = userId;
    return;
  }
  identifyNow(userId);
}

function identifyNow(userId: string): void {
  if (posthog.get_distinct_id() === userId) return;
  posthog.identify(userId);
}

/**
 * Records which side of the product the user is on and which firm they are
 * working in. `law_firm_id` is registered on every later event so reports can
 * be split per firm even without PostHog's group analytics, and the
 * `law_firm` group feeds firm-level retention when group analytics is enabled.
 */
export function setAnalyticsContext(userType: AnalyticsUserType, lawFirmId: string | null): void {
  if (!active()) {
    pendingContext = { userType, lawFirmId };
    return;
  }
  contextNow(userType, lawFirmId);
}

function contextNow(userType: AnalyticsUserType, lawFirmId: string | null): void {
  posthog.register({ user_type: userType, law_firm_id: lawFirmId });
  posthog.setPersonProperties({ user_type: userType });
  if (lawFirmId) posthog.group("law_firm", lawFirmId);
}

/** Forgets the signed-in user so the next person on this browser starts fresh. */
export function resetAnalytics(): void {
  pendingUserId = null;
  pendingContext = null;
  if (!active()) return;
  posthog.reset();
}

export function captureAnalyticsException(error: unknown): void {
  if (!active()) return;
  posthog.captureException(error);
}
