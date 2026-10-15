/**
 * The failure and body shapes the transport fake could not previously produce.
 *
 * `fetchWithDeadline` names three distinct outcomes and the application renders
 * each one differently: OUR deadline becomes a timeout `ApiError`, a CALLER
 * abort is rethrown untouched so React Query keeps treating it as a
 * cancellation, and an unreachable network becomes a third `ApiError`. The fake
 * never read `signal`, so none of those branches was reachable and a timed-out
 * request looked exactly like a valid empty response.
 *
 * The body side had the same shape of blindness. Every response was
 * `JSON.stringify(body ?? {})`, so `json()` could not reject, a deliberate
 * `null` became `{}`, a 204 carried a body, and the branch a service takes when
 * a proxy answers with an HTML error page did not exist.
 *
 * Driven through the real `apiFetch`, not a stand-in: the branch under test
 * lives in the transport, so stubbing it would proves nothing.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import {
  isApiError,
  NETWORK_UNREACHABLE_CODE,
  REQUEST_TIMEOUT_CODE,
} from '@/lib/utils/apiErrors';

import { setupApiMock } from './apiMock';

const api = setupApiMock();

describe('cancellation is distinguishable from failure', () => {
  it('rejects a request whose caller has already aborted, and never sends it', async () => {
    api.getExact('/api/lawfirms/firm-a/clients', { clients: [] });
    const controller = new AbortController();
    controller.abort();

    await expect(apiFetch('/api/lawfirms/firm-a/clients', { signal: controller.signal }))
      .rejects.toThrow(/aborted/i);

    // A real fetch given an aborted signal never reaches the network. Recording
    // the call would show a spec a request the application did not make.
    expect(api.calls()).toEqual([]);
  });

  it('rejects mid-flight when the caller aborts, without waiting for the response', async () => {
    let release: (() => void) | undefined;
    api.getExact('/api/lawfirms/firm-a/clients', () => new Promise((resolve) => {
      release = () => resolve({ clients: [{ id: 'too-late' }] });
    }));

    const controller = new AbortController();
    const pending = apiFetch('/api/lawfirms/firm-a/clients', { signal: controller.signal });
    const settled = pending.then(() => 'resolved', () => 'rejected');

    controller.abort();

    await expect(settled).resolves.toBe('rejected');
    // The handler is still holding a promise nobody is waiting on. Releasing it
    // must not resurrect the request.
    release?.();
    await expect(settled).resolves.toBe('rejected');
  });

  it('a caller abort is NOT reported as a timeout', async () => {
    api.getExact('/api/lawfirms/firm-a/clients', () => new Promise(() => {}));
    const controller = new AbortController();
    const pending = apiFetch('/api/lawfirms/firm-a/clients', {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    controller.abort();

    // The distinction the application depends on: React Query drops a query on
    // unmount, and turning that into a reportable timeout would put an error
    // banner on a page the user has already left.
    const error = await pending.catch((e) => e);
    expect(isApiError(error) && error.code === REQUEST_TIMEOUT_CODE).toBe(false);
    expect(String(error)).toMatch(/abort/i);
  });

  it('our own deadline becomes the timeout error the application renders', async () => {
    api.getExact('/api/lawfirms/firm-a/clients', { status: 200, body: { clients: [] }, delayMs: 200 });

    const error = await apiFetch('/api/lawfirms/firm-a/clients', { timeoutMs: 20 })
      .catch((e) => e);

    expect(isApiError(error)).toBe(true);
    expect(error.code).toBe(REQUEST_TIMEOUT_CODE);
    expect(error.status).toBe(0);
  });

  it('an unreachable network becomes its own error, not a timeout', async () => {
    api.getExact('/api/lawfirms/firm-a/clients', () => {
      // The wording a browser engine actually produces. The transport matches on
      // it to tell a dead API apart from a slow one.
      throw new TypeError('Failed to fetch');
    });

    const error = await apiFetch('/api/lawfirms/firm-a/clients').catch((e) => e);

    expect(isApiError(error)).toBe(true);
    expect(error.code).toBe(NETWORK_UNREACHABLE_CODE);
  });

  it('the same request succeeds when nothing aborts it', async () => {
    // The positive control. Without it every assertion above would also pass
    // against a transport that failed unconditionally.
    api.getExact('/api/lawfirms/firm-a/clients', { clients: [{ id: 'reachable' }] });

    const response = await apiFetch('/api/lawfirms/firm-a/clients', { timeoutMs: 5_000 });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clients: [{ id: 'reachable' }] });
  });
});

describe('response bodies keep their real shape', () => {
  it('a 204 carries no body, so json() rejects instead of resolving {}', async () => {
    api.deleteExact('/api/lawfirms/firm-a/clients/c1', { status: 204 });

    const response = await apiFetch('/api/lawfirms/firm-a/clients/c1', { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    await expect(response.json()).rejects.toThrow();
  });

  it('a deliberate null body stays null', async () => {
    // `body ?? {}` erased this. A service could not tell an endpoint that
    // answers null from one that answers an empty object, and those mean
    // different things: "no such record" against "a record with no fields".
    api.getExact('/api/lawfirms/firm-a/clients/c1', { status: 200, body: null });

    const response = await apiFetch('/api/lawfirms/firm-a/clients/c1');

    expect(await response.json()).toBeNull();
  });

  it('an empty object body is still an empty object', async () => {
    api.getExact('/api/lawfirms/firm-a/clients/c2', { status: 200, body: {} });

    expect(await (await apiFetch('/api/lawfirms/firm-a/clients/c2')).json()).toEqual({});
  });

  it('an HTML error page from a proxy rejects json() and keeps its content type', async () => {
    // What a gateway actually returns when the API is down behind it. A service
    // that assumes JSON throws a parse error here, and that is the branch this
    // makes reachable.
    api.getExact('/api/lawfirms/firm-a/clients', {
      status: 502,
      text: '<html><body>502 Bad Gateway</body></html>',
      headers: { 'content-type': 'text/html' },
    });

    const response = await apiFetch('/api/lawfirms/firm-a/clients').catch((e) => e);
    const settled = response instanceof Error ? null : response;

    expect(settled?.status).toBe(502);
    expect(settled?.headers.get('content-type')).toBe('text/html');
    expect(await settled?.text()).toContain('502 Bad Gateway');
    await expect(settled?.json()).rejects.toThrow();
  });

  it('truncated JSON rejects the way a real Response does', async () => {
    api.getExact('/api/lawfirms/firm-a/clients', { status: 200, text: '{"clients":[{"id":' });

    const response = await apiFetch('/api/lawfirms/firm-a/clients');

    await expect(response.json()).rejects.toThrow();
    expect(await response.text()).toBe('{"clients":[{"id":');
  });

  it('a custom response header is readable', async () => {
    api.getExact('/api/lawfirms/firm-a/clients', {
      status: 200,
      body: { clients: [] },
      headers: { 'x-total-count': '42' },
    });

    const response = await apiFetch('/api/lawfirms/firm-a/clients');

    expect(response.headers.get('x-total-count')).toBe('42');
    // The default is not lost when one is added.
    expect(response.headers.get('content-type')).toBe('application/json');
  });

  it('a bare object with a text field is still DATA, not a response envelope', async () => {
    // This app puts `text` on real records. Treating a bare `{ text: ... }` as
    // an envelope would make a note body silently become the whole response,
    // which is the same trap the numeric-status rule already guards.
    api.getExact('/api/lawfirms/firm-a/notes/n1', { text: 'A note body', id: 'n1' });

    const response = await apiFetch('/api/lawfirms/firm-a/notes/n1');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'A note body', id: 'n1' });
  });
});

describe('delayMs is honoured without an explicit envelope', () => {
  it('treats a bare delayMs as a response field, not as data', async () => {
    // It was read as DATA, so the delay did nothing and the response came back
    // instantly carrying `delayMs` as part of the body. Any spec asserting a
    // loading state, or a deadline, passed against an instant response.
    api.getExact('/api/lawfirms/firm-a/clients', { delayMs: 30 });

    const started = Date.now();
    const response = await apiFetch('/api/lawfirms/firm-a/clients');
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(await response.json()).toEqual({});
  });

  it('still treats a bare text field as data, because records carry one', async () => {
    // The boundary of the rule above: `delayMs` promotes an object to an
    // envelope, `text` does not. No record in this app has a `delayMs` field;
    // plenty have `text`.
    api.getExact('/api/lawfirms/firm-a/notes/n2', { text: 'Another note', id: 'n2' });

    expect(await (await apiFetch('/api/lawfirms/firm-a/notes/n2')).json())
      .toEqual({ text: 'Another note', id: 'n2' });
  });
});
