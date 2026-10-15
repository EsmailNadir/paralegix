/**
 * How long a request may run before the client stops waiting.
 *
 * This is the single place these budgets are set. Every call through `apiFetch`
 * picks one automatically from its HTTP method, so a change here moves the whole
 * app; a call that genuinely needs different treatment passes `timeoutMs`.
 *
 * The values are chosen relative to the server's own limits, which is why they
 * are not symmetric:
 *
 * - `read` EQUALS the backend's read deadline (`DEFAULT_READ_REQUEST_TIMEOUT_MS`,
 *   20s) on purpose. A read that has taken twenty seconds has already failed the
 *   user; waiting for the server's verdict adds nothing they want, and a server
 *   that kept working past it would be answering nobody. This clock starts
 *   first, so the browser gives up at or before the server does. Change both
 *   together: `backend/tests/shared/requestTimeout.test.ts` pins that they match.
 * - `write` sits ABOVE the backend's write deadline (40s) on purpose. Aborting a
 *   write in the browser does not roll it back on the server - the row may well
 *   be committed. Outlasting the backend's own deadline means the client
 *   receives the real answer instead of leaving the user to guess whether their
 *   invoice was created.
 * - `upload` covers work whose duration is set by the payload rather than by the
 *   query: file transfer, DOCX/PDF conversion, bulk generation. These routes are
 *   exempt from the backend deadline too (`middleware/requestTimeout.js`).
 * - `bootstrap` is the read a screen cannot render without, and is therefore the
 *   read most likely to be the one that wakes the API. The backend deploys with
 *   `min-instances=0`, so the first request after an idle period waits for a
 *   container to boot and for a fresh Postgres connection before the handler
 *   even starts. That can outlast the `read` budget, and the user gets a
 *   connection error for a server that was merely starting. Waiting longer here
 *   costs nothing when the API is warm, because a warm answer arrives in
 *   milliseconds either way. The backend holds that one route
 *   (`GET /api/lawfirms/:lawFirmId`) to its 40s write deadline rather than its
 *   20s read deadline, so it answers before this budget runs out instead of
 *   cutting off a request the browser is still waiting on. Any other read given
 *   this budget needs the same exemption in `requestTimeout.ts`.
 */
export const REQUEST_TIMEOUT_MS = {
  read: 20_000,
  write: 45_000,
  bootstrap: 45_000,
  upload: 300_000,
  /** Opt out entirely. Use only where a deadline would break a working feature. */
  none: 0,
} as const;

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The budget a request gets when it does not ask for one.
 *
 * Defaults to the read budget rather than the write budget: an unrecognised or
 * absent method is a GET as far as `fetch` is concerned.
 */
export function timeoutForMethod(method?: string): number {
  const normalized = (method || 'GET').toUpperCase();
  return WRITE_METHODS.has(normalized) ? REQUEST_TIMEOUT_MS.write : REQUEST_TIMEOUT_MS.read;
}
