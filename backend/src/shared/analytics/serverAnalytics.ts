/**
 * Server-side product analytics, sent to PostHog.
 *
 * This is the only module that imports `posthog-node`. The backend reports the
 * handful of product events a browser cannot be trusted with because the server
 * is their source of truth: a firm being created, the subscription lifecycle
 * driven by Stripe webhooks, and a firm's client paying an invoice.
 *
 * NO CLIENT DATA LEAVES THROUGH HERE. Paralegix holds privileged legal material,
 * so an event carries ids, enums, counts and booleans only: never a name, an
 * email, a matter name, note or message text, or a money amount. Property values
 * are typed to primitives, and anything else that reaches this module through an
 * `any` is dropped at runtime rather than serialised.
 *
 * Behaviour callers rely on:
 *   - With no `POSTHOG_PROJECT_TOKEN` (local dev, the test suite, any environment
 *     without the variable) no client is ever constructed and every call is a
 *     silent no-op.
 *   - `captureServerEvent` never throws and never awaits the network. The client
 *     queues and batches in the background, so a capture inside a Stripe webhook
 *     cannot fail it or slow it down.
 *   - The queue is flushed on graceful shutdown through `onShutdown`, before the
 *     process exits.
 *
 * Every event carries `groups: { law_firm }` and a `law_firm_id` property. Group
 * analytics may not be enabled on the PostHog project, and the property is what
 * still lets an event be broken down by firm when it is not. The distinct id is
 * the acting user's `users.id` (which is their Firebase uid, the same id the
 * frontend identifies with) or, when no user is in play, `law_firm:<id>`.
 */
import { PostHog } from 'posthog-node';
import { onShutdown } from '../utils/shutdownHooks';

/** Every event the backend reports. snake_case, matching the frontend's names. */
export type ServerAnalyticsEvent =
  | 'law_firm_created'
  | 'subscription_started'
  | 'subscription_status_changed'
  | 'subscription_cancelled'
  | 'subscription_payment_failed'
  | 'client_invoice_paid';

type AnalyticsValue = string | number | boolean | null;

type CaptureInput = {
  event: ServerAnalyticsEvent;
  lawFirmId: string;
  /** The acting user's `users.id`. Omit when no user is in play, e.g. a webhook. */
  distinctId?: string | null;
  properties?: Record<string, AnalyticsValue>;
};

const DEFAULT_HOST = 'https://us.i.posthog.com';

/** Bounded under the 2s per-hook budget in `shutdownHooks.ts`. */
const SHUTDOWN_FLUSH_MS = 1500;

/** `undefined` until first use, then the client or `null` when disabled. */
let client: PostHog | null | undefined;

function getClient(): PostHog | null {
  if (client !== undefined) return client;
  const token = process.env.POSTHOG_PROJECT_TOKEN?.trim();
  if (!token) {
    client = null;
    return client;
  }
  try {
    const instance = new PostHog(token, { host: process.env.POSTHOG_HOST?.trim() || DEFAULT_HOST });
    // Delivery failures surface on the client's emitter, not to the caller.
    instance.on('error', (err: unknown) => {
      console.warn('[analytics] PostHog delivery failed:', (err as Error)?.message || err);
    });
    client = instance;
  } catch (err) {
    console.warn('[analytics] PostHog client could not be created:', (err as Error)?.message || err);
    client = null;
  }
  return client;
}

/** Keep only primitive values; an object or array could carry client data. */
function primitiveProperties(properties: Record<string, unknown> = {}): Record<string, AnalyticsValue> {
  const out: Record<string, AnalyticsValue> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Queue one product event for a law firm. Fire and forget: returns immediately,
 * never throws, and does nothing when analytics is not configured.
 */
export function captureServerEvent({ event, lawFirmId, distinctId, properties }: CaptureInput): void {
  try {
    if (!lawFirmId) return;
    const posthog = getClient();
    if (!posthog) return;
    posthog.capture({
      distinctId: distinctId || `law_firm:${lawFirmId}`,
      event,
      groups: { law_firm: lawFirmId },
      // Last, so a caller's property can never replace the firm the event is filed under.
      properties: { ...primitiveProperties(properties), law_firm_id: lawFirmId },
    });
  } catch (err) {
    console.warn(`[analytics] capture of ${event} failed:`, (err as Error)?.message || err);
  }
}

/** Private API host, for the calls a project token cannot make. US Cloud by default. */
const DEFAULT_API_HOST = 'https://us.posthog.com';
const DELETE_TIMEOUT_MS = 5000;

export type AnalyticsDeletion = 'deleted' | 'skipped' | 'failed';

/**
 * Delete one person, and every event and recording tied to them, from PostHog.
 * Called when an account is erased, so the product analytics go with it.
 *
 * Needs `POSTHOG_PERSONAL_API_KEY` (a personal key with the person write scope,
 * a secret unlike the project token) and `POSTHOG_PROJECT_ID`. Without either it
 * does nothing. PostHog queues the deletion and answers 202. Like capture, it
 * never throws: a failure is logged and reported, and never undoes an erasure
 * that has already happened in our own database.
 */
export async function deleteAnalyticsPerson(distinctId: string): Promise<AnalyticsDeletion> {
  const key = process.env.POSTHOG_PERSONAL_API_KEY?.trim();
  const projectId = process.env.POSTHOG_PROJECT_ID?.trim();
  if (!key || !projectId || !distinctId) return 'skipped';

  const host = (process.env.POSTHOG_API_HOST?.trim() || DEFAULT_API_HOST).replace(/\/$/, '');
  try {
    const res = await fetch(`${host}/api/projects/${projectId}/persons/bulk_delete/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ distinct_ids: [distinctId], delete_events: true, delete_recordings: true }),
      signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
    });
    if (res.ok) return 'deleted';
    console.warn(`[analytics] PostHog person deletion refused: HTTP ${res.status}`);
    return 'failed';
  } catch (err) {
    console.warn('[analytics] PostHog person deletion failed:', (err as Error)?.message || err);
    return 'failed';
  }
}

onShutdown('posthog-analytics', async () => {
  if (!client) return;
  await client.shutdown(SHUTDOWN_FLUSH_MS);
});
