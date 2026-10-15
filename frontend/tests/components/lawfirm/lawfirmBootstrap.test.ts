/**
 * The read the workspace shell blocks on, tested against a server that is still
 * booting.
 *
 * The API deploys with `min-instances=0`. The first request after an idle period
 * therefore waits for a container to start and for a fresh Postgres connection
 * before any handler runs, and the user watching that wait is on the law firm
 * layout, which has nothing to render until this one call answers.
 *
 * Two behaviours have to hold together, and neither is provable from the other:
 *
 * 1. THE BUDGET. `getLawFirmById` waits past the ordinary read deadline, because
 *    giving up at twenty seconds reports a connection failure for a server that
 *    was merely starting. The contrast case (`getLawFirmMembers`) is what makes
 *    this a real assertion: raising the budget for EVERY read would pass the
 *    first case and fail the second.
 *
 * 2. THE RETRY. When the deadline does expire, the shell asks once more instead
 *    of rendering the full-page connection error. The attempt that timed out is
 *    what woke the container, so the second one answers.
 *
 * The transport is real throughout. Only `fetch` is faked, and it honours the
 * abort signal, so the deadline under test is the one `apiFetch` actually arms.
 */
jest.unmock('@/services/lawfirm.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/lib/utils/auth', () => ({
  getFirebaseToken: jest.fn(async () => 'test-token'),
  clearTokenCache: jest.fn(),
}));

import lawfirmService from '@/services/lawfirm.service';
import { REQUEST_TIMEOUT_MS } from '@/lib/constants/requestTimeouts';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { isApiError, REQUEST_TIMEOUT_CODE } from '@/lib/utils/apiErrors';

const LAW_FIRM_ID = 'firm-1';
const FIRM_BODY = { lawFirm: { id: LAW_FIRM_ID, name: 'Boot Test LLP' } };

type FetchOutcome = 'hang' | { body: unknown };

function jsonResponse(body: unknown): Response {
  const payload = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    statusText: '200',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => JSON.parse(payload),
    text: async () => payload,
    clone() { return this; },
  } as unknown as Response;
}

/**
 * A `fetch` that can be told to never answer.
 *
 * A hanging call rejects only when its signal aborts, which is exactly what a
 * booting container looks like from the browser: the socket is open and nothing
 * comes back. Resolving on a timer instead would test the timer, not the
 * deadline.
 */
function installFetch(outcomes: FetchOutcome[]) {
  const original = global.fetch;
  let call = 0;
  const fetchMock = jest.fn((_input: unknown, init: RequestInit = {}) => {
    const outcome = outcomes[Math.min(call, outcomes.length - 1)];
    call += 1;
    if (outcome !== 'hang') return Promise.resolve(jsonResponse(outcome.body));

    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (!signal) return;
      signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')));
    });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, restore: () => { global.fetch = original; } };
}

/** Tracks settlement without consuming the rejection, so a case can assert on it later. */
function watch<T>(promise: Promise<T>) {
  const state = { settled: false };
  const tracked = promise.finally(() => { state.settled = true; });
  // Nothing is asserted about this copy; it exists so an unhandled rejection
  // between the advance steps cannot fail the run.
  tracked.catch(() => {});
  return { state, tracked };
}

let installed: ReturnType<typeof installFetch>;

beforeEach(() => {
  jest.useFakeTimers();
  // Several cases read the same endpoint, which trips the dev-only duplicate-GET
  // warning and buries the real output.
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  installed?.restore();
  jest.useRealTimers();
});

describe('the budget on the workspace bootstrap read', () => {
  it('is still waiting after the ordinary read deadline would have given up', async () => {
    installed = installFetch(['hang']);

    const { state, tracked } = watch(lawfirmService.getLawFirmById(LAW_FIRM_ID));

    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS.read + 1);

    // Twenty seconds is around where a cold Cloud Run boot plus a first database
    // connection lands. Reporting a connection failure here is the bug.
    expect(state.settled).toBe(false);

    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS.bootstrap);
    await expect(tracked).rejects.toMatchObject({ code: REQUEST_TIMEOUT_CODE });
  });

  it('still gives up eventually, at the bootstrap deadline', async () => {
    installed = installFetch(['hang']);

    const { state, tracked } = watch(lawfirmService.getLawFirmById(LAW_FIRM_ID));

    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS.bootstrap - 1);
    expect(state.settled).toBe(false);

    // A longer wait is not an unbounded one. Without a ceiling the shell would
    // spin forever against a server that is down rather than starting.
    await jest.advanceTimersByTimeAsync(2);
    await expect(tracked).rejects.toMatchObject({ code: REQUEST_TIMEOUT_CODE });
  });

  it('does NOT extend the deadline for ordinary firm reads', async () => {
    installed = installFetch(['hang']);

    const { tracked } = watch(lawfirmService.getLawFirmMembers(LAW_FIRM_ID));

    // The member list renders inside an already-loaded shell, so the API is warm
    // by the time it runs. It keeps the shorter budget: a read that has taken
    // twenty seconds there has already failed the user.
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS.read + 1);
    await expect(tracked).rejects.toMatchObject({ code: REQUEST_TIMEOUT_CODE });
  });
});

describe('the workspace shell recovering from a cold start', () => {
  it('answers with the firm after a first attempt times out', async () => {
    installed = installFetch(['hang', { body: FIRM_BODY }]);

    // The call the layout makes, verbatim.
    const { tracked } = watch(lawfirmService.getLawFirmForWorkspace(LAW_FIRM_ID));

    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS.bootstrap + 1);
    await jest.advanceTimersByTimeAsync(2000);

    // The user sees a longer spinner. Before the retry they saw a full-page
    // "trouble reaching the server" and had to press a button to get here.
    await expect(tracked).resolves.toMatchObject({ id: LAW_FIRM_ID });
    expect(installed.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a refusal immediately instead of asking twice', async () => {
    installed = installFetch([{ body: FIRM_BODY }]);
    const forbidden = {
      ok: false,
      status: 403,
      statusText: '403',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ error: 'Forbidden' }),
      text: async () => '{"error":"Forbidden"}',
      clone() { return this; },
    } as unknown as Response;
    installed.fetchMock.mockImplementation(() => Promise.resolve(forbidden));

    const { tracked } = watch(lawfirmService.getLawFirmForWorkspace(LAW_FIRM_ID));

    await jest.advanceTimersByTimeAsync(2000);

    // A 403 is the answer, not a symptom of a cold start. The shell renders the
    // access-denied screen, and a second request would only delay it.
    const error = await tracked.catch((e: unknown) => e);
    expect(isApiError(error) && error.status).toBe(403);
    expect(installed.fetchMock).toHaveBeenCalledTimes(1);
  });
});
