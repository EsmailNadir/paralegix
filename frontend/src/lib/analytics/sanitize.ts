import type { CaptureResult } from "posthog-js";

// Path segments that are bearer secrets: anyone holding the URL can open the
// shared document, intake form or payment link, so the segment after these prefixes must
// never reach a third party.
const SECRET_PATH_PREFIXES = ["share", "intake", "pay"];

// Replaces a secret path segment with this placeholder so the route shape still
// groups in reports without the token itself.
export const REDACTED_SEGMENT = ":token";

/**
 * Strips a URL down to origin and path, redacting secret path segments.
 *
 * Query strings and hashes are dropped entirely: invite, password-reset,
 * email-verification and signature links carry their tokens there
 * (`?token=`, `?oobCode=`), and a firm's search or filter state can carry a
 * client's name. Marketing `utm_*` values survive because posthog-js lifts them
 * into their own properties before `before_send` runs.
 */
export function sanitizeUrl(value: string): string {
  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  let url: URL;
  try {
    url = new URL(value, "http://relative.invalid");
  } catch {
    return "";
  }

  const segments = url.pathname.split("/");
  for (let i = 1; i < segments.length - 1; i++) {
    if (SECRET_PATH_PREFIXES.includes(segments[i]) && segments[i + 1]) {
      segments[i + 1] = REDACTED_SEGMENT;
    }
  }
  const path = segments.join("/");

  return isAbsolute ? `${url.origin}${path}` : path;
}

// PostHog's own URL-bearing properties ($current_url, $pathname, $referrer and
// their $initial_ / $session_entry_ / $prev_pageview_ variants) all contain one
// of these fragments.
const URL_KEY_PATTERN = /url|pathname|referrer/i;

// PostHog attaches the document title to pageviews. A title can name a matter
// or client, and the path already identifies the page, so it never leaves.
const DROPPED_KEYS = ["title"];

function scrubProperties<T extends Record<string, unknown> | undefined>(props: T): T {
  if (!props) return props;
  const next: Record<string, unknown> = { ...props };
  for (const key of DROPPED_KEYS) delete next[key];
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "string" && URL_KEY_PATTERN.test(key) && value !== "$direct") {
      next[key] = sanitizeUrl(value);
    }
  }
  return next as T;
}

// The parts of a stack frame that locate the failing code. Everything else a
// frame can carry (source lines, local variable values) may hold user data.
const FRAME_KEYS = ["platform", "filename", "abs_path", "function", "module", "lineno", "colno", "in_app", "chunk_id"];

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * An error message can quote what the user typed or what the server echoed back
 * (a client name, a note title), so an exception keeps only its type, how it was
 * caught, and where in the code it happened. This is an allow-list: any other
 * `$exception_*` property the SDK adds is dropped rather than trusted.
 */
function scrubException(props: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!key.startsWith("$exception_") || key === "$exception_level") next[key] = value;
  }
  const list = Array.isArray(props.$exception_list) ? props.$exception_list : [];
  next.$exception_list = list.map((entry: any) => {
    const frames = Array.isArray(entry?.stacktrace?.frames) ? entry.stacktrace.frames : [];
    return {
      type: entry?.type,
      mechanism: entry?.mechanism,
      stacktrace: {
        type: entry?.stacktrace?.type ?? "raw",
        frames: frames.map((frame: Record<string, unknown>) => pick(frame ?? {}, FRAME_KEYS)),
      },
    };
  });
  return next;
}

/**
 * The `before_send` hook: removes secrets from every URL on an event and on the
 * person properties it sets, so no capture path (pageviews, exceptions,
 * `$set_once` initial-URL properties) can leak a token, and reduces an
 * exception to its type and code location.
 */
export function scrubCapture(capture: CaptureResult | null): CaptureResult | null {
  if (!capture) return capture;
  const properties =
    capture.event === "$exception" && capture.properties
      ? scrubException(capture.properties)
      : capture.properties;
  return {
    ...capture,
    properties: scrubProperties(properties),
    $set: scrubProperties(capture.$set),
    $set_once: scrubProperties(capture.$set_once),
  };
}
