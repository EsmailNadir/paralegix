/**
 * The one place a 402 becomes "this firm is locked".
 *
 * `isBillingLocked` decides the lock from the status the layout fetched at
 * mount. That status can be stale: a trial that ends mid-session, a Stripe
 * webhook that lands after the page loaded, or a plan the firm owner cancelled
 * in another tab. The client keeps rendering the workspace, and every request
 * inside it fails with a 402 that each page reports as its own red error banner.
 *
 * `apiFetch` announces every 402 here instead, and the firm layout raises the
 * lock screen. One paywall for the whole workspace, whichever gate noticed
 * first.
 *
 * Listeners live only in the client bundle, so nothing here runs on the server.
 */

export interface BillingLockSignal {
  /** Firm the failing request was scoped to, when the URL names one. */
  lawFirmId: string | null;
  /** `details.billingStatus` from the 402 body: 'past_due', 'canceled', ... */
  billingStatus: string | null;
}

type BillingLockListener = (signal: BillingLockSignal) => void;

const listeners = new Set<BillingLockListener>();

/** Subscribe to 402 responses. Returns the unsubscribe function. */
export function onBillingLock(listener: BillingLockListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Announce a 402. A listener that throws must not take down the request that
 * triggered it, so each one is called defensively.
 */
export function emitBillingLock(signal: BillingLockSignal): void {
  listeners.forEach((listener) => {
    try {
      listener(signal);
    } catch (error) {
      console.error('Billing lock listener failed:', error);
    }
  });
}

/**
 * The firm id a request URL is scoped to. Covers the firm workspace
 * (`/api/lawfirms/<id>/...`) and the client portal (`/api/client-portal/lawfirm/<id>/...`),
 * the two mounts the billing gate answers 402 from. Returns null for anything
 * else, which a subscriber reads as "unknown firm" rather than "another firm".
 */
export function lawFirmIdFromUrl(url: string): string | null {
  const match = /\/lawfirms?\/([^/?#]+)/i.exec(url);
  return match ? decodeURIComponent(match[1]) : null;
}

/** The billing status a 402 body carries in `details`, when it carries one. */
export function billingStatusFromBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const details = (body as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return null;
  const status = (details as { billingStatus?: unknown }).billingStatus;
  return typeof status === 'string' && status ? status : null;
}
