/**
 * The transport fake, proving itself against a REAL service.
 *
 * The point of `apiMock` is that the service layer stays real, so this file
 * drives `clients.service` rather than a stand-in: url building, query
 * parameters, response parsing and error handling all execute. If any of that
 * were stubbed, the fake would be no better than the global service Proxy it
 * replaces.
 *
 * `MOCK_FRONTEND_SERVICES=0` would disable that Proxy globally, but it is not set
 * here: the per-file `jest.unmock` below is enough and keeps this spec runnable
 * in the ordinary `npm run test:unit` pass.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

import { setupApiMock } from './apiMock';
import clientsService from '@/services/clients.service';

const api = setupApiMock();

describe('apiMock against the real clients service', () => {
  it('returns the parsed body the service asked for', async () => {
    api.get('/clients', { clients: [{ id: 'c1', name: 'Acme Client' }] });

    const result = await clientsService.listClients('firm-1');

    // The service unwrapped `{ clients: [...] }` itself. A stubbed service would
    // have returned whatever the stub said, proving nothing about that unwrap.
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Acme Client');
  });

  it('records the url the service actually built', async () => {
    api.get('/clients', { clients: [] });

    await clientsService.listClients('firm-42');

    const [call] = api.callsTo('/clients');
    // The firm id reaching the url is what a wrong-url bug breaks, and the global
    // service Proxy could never catch it.
    expect(call.pathname).toContain('firm-42');
    expect(call.method).toBe('GET');
  });

  it('THROWS on a request no handler covers', async () => {
    // The rule that makes the whole harness honest. Returning `{}` here is
    // exactly the behaviour that let 390 frontend tests pass against broken
    // organization code.
    api.allowUnhandled();
    await expect(clientsService.listClients('firm-1')).rejects.toThrow(/no handler for GET/);
  });

  it('lets a spec answer with an error status the service must handle', async () => {
    api.get('/clients', { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });

    // A component test can now assert what the UI does on a 403, which was
    // impossible while every service call resolved to `{}`.
    await expect(clientsService.listClients('firm-1')).rejects.toBeDefined();
  });

  it('lets a later handler override an earlier one', async () => {
    api.get('/clients', { clients: [{ id: 'first', name: 'First' }] });
    api.get('/clients', { clients: [{ id: 'second', name: 'Second' }] });

    const result = await clientsService.listClients('firm-1');

    // So a shared `beforeEach` handler can be overridden for one case without
    // unpicking the setup.
    expect(result[0].id).toBe('second');
  });

  it('treats a TOP-LEVEL string status as body data, not an HTTP status', async () => {
    // The trap this guards. `looksLikeEnvelope` used to fire on the mere
    // PRESENCE of a `status` key, and this app puts one on almost everything: a
    // client is `status: 'active'`, a matter `status: 'closed'`, a task
    // `status: 'open'`. A single-record body was therefore read as an envelope,
    // and the fake built a Response whose HTTP status was the string "active"
    // with an empty body.
    //
    // Driven through `fetch` directly rather than through a service, because the
    // ambiguity is in THIS helper and a service that unwraps an envelope key
    // would hide it: nesting the record one level down puts the `status` out of
    // reach of the check and the case proves nothing.
    api.get('/clients/c1', { id: 'c1', name: 'Acme', status: 'active' });

    const res = await fetch('/api/lawfirms/firm-1/clients/c1');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'c1', name: 'Acme', status: 'active' });
  });

  it('still treats a NUMERIC status as an envelope', async () => {
    api.get('/clients/c1', { status: 403, body: { error: 'Forbidden' } });

    const res = await fetch('/api/lawfirms/firm-1/clients/c1');

    // The other half. Narrowing the check must not stop a real envelope working,
    // or every error-path spec in the suite goes green against a 200.
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('names the registered routes when it throws, so the fix is obvious', async () => {
    // The refusal IS the subject here, so the teardown check is opted out.
    api.allowUnhandled();

    api.get('/matters', { matters: [] });

    await expect(clientsService.listClients('firm-1')).rejects.toThrow(/GET \/matters/);
  });

  it('makes an exact handler refuse the same route under another firm', async () => {
    // The refusal IS the subject here, so the teardown check is opted out.
    api.allowUnhandled();

    api.getExact('/api/lawfirms/firm-a/clients', { clients: [{ id: 'a', name: 'Firm A client' }] });

    await expect(clientsService.listClients('firm-b')).rejects.toThrow(
      /no handler for GET \/api\/lawfirms\/firm-b\/clients/,
    );

    expect((await clientsService.listClients('firm-a')).map(({ id, name }) => ({ id, name })))
      .toEqual([{ id: 'a', name: 'Firm A client' }]);
  });

  it('matches an exact handler against every query parameter, independent of parameter order', async () => {
    // The refusal IS the subject here, so the teardown check is opted out.
    api.allowUnhandled();

    api.getExact('/api/lawfirms/firm-a/clients?limit=10&status=active', { clients: [] });

    const allowed = await fetch('/api/lawfirms/firm-a/clients?status=active&limit=10');
    expect(allowed.status).toBe(200);

    await expect(fetch('/api/lawfirms/firm-a/clients?status=inactive&limit=10')).rejects.toThrow(
      /no handler for GET \/api\/lawfirms\/firm-a\/clients\?status=inactive&limit=10/,
    );
  });

  it('records repeated query values separately for a later assertion', async () => {
    api.getExact('/api/lawfirms/firm-a/clients?tag=one&tag=two', { clients: [] });

    await fetch('/api/lawfirms/firm-a/clients?tag=two&tag=one');

    const [call] = api.callsTo('/clients');
    expect(call.search).toBe('?tag=two&tag=one');
    expect(call.query).toEqual({ tag: ['two', 'one'] });
  });

  it('waits for an async handler so a test can control response ordering', async () => {
    let release: ((value: unknown) => void) | undefined;
    api.getExact('/api/lawfirms/firm-a/clients', () => new Promise((resolve) => {
      release = resolve;
    }));

    const pending = fetch('/api/lawfirms/firm-a/clients');
    expect(api.calls()).toHaveLength(1);

    release?.({ clients: [{ id: 'a' }] });
    await expect(pending.then((response) => response.json())).resolves.toEqual({ clients: [{ id: 'a' }] });
  });

  it('uses method and headers carried by a Request input', async () => {
    api.postExact('/api/lawfirms/firm-a/clients', { created: true });
    const request = {
      url: '/api/lawfirms/firm-a/clients',
      method: 'POST',
      headers: { Authorization: 'Bearer firm-a-token' },
    } as unknown as Request;

    const response = await fetch(request);

    expect(response.status).toBe(200);
    expect(api.calls()).toEqual([expect.objectContaining({
      method: 'POST',
      headers: { authorization: 'Bearer firm-a-token' },
    })]);
  });

  it('records the credentials mode a request was sent with', async () => {
    api.postExact('/api/auth/connect-google', { authUrl: 'x' });
    api.getExact('/api/clients', { clients: [] });

    await fetch('/api/auth/connect-google', { method: 'POST', credentials: 'include' });
    await fetch('/api/clients');

    // A cookie-bound flow fails only in a real browser when this is missing,
    // so a spec has to be able to read it off the recorded call.
    expect(api.calls().map((c) => c.credentials)).toEqual(['include', undefined]);
  });

  it('keeps suffix handlers available for existing broad test setup', async () => {
    api.get('/clients', { clients: [{ id: 'shared', name: 'Suffix control' }] });

    expect((await clientsService.listClients('firm-a')).map(({ id, name }) => ({ id, name })))
      .toEqual([{ id: 'shared', name: 'Suffix control' }]);
    expect((await clientsService.listClients('firm-b')).map(({ id, name }) => ({ id, name })))
      .toEqual([{ id: 'shared', name: 'Suffix control' }]);
  });
});

/**
 * The throw is not the whole guarantee.
 *
 * A rejected promise only reaches whoever awaits it. Real callers catch: a
 * service wraps the failure in its own message, a hook stores it in `error`
 * state, a component renders an error card. Every one of those turns "this spec
 * asked for a url it never set up" into a green test that looks like it proved
 * the error path on purpose.
 *
 * So the mismatch is recorded as well as thrown, and `restore()` fails the spec
 * on anything left over.
 */
describe('unmatched requests survive being caught', () => {
  // Runs before the file-level restore(), so a failed assertion inside a test
  // cannot also blow up in teardown and bury the real error under a second one.
  afterEach(() => {
    api.allowUnhandled();
  });

  it('still fails the spec when the caller swallows the transport error', async () => {
    // Stands in for every catch in the application. The caller is satisfied, and
    // without the record below this test would pass having proved nothing.
    let swallowed: unknown = null;
    try {
      await clientsService.listClients('firm-1');
    } catch (error) {
      swallowed = error;
    }

    expect(swallowed).toBeInstanceOf(Error);
    expect(api.unhandledRequests()).toEqual([expect.objectContaining({
      method: 'GET',
      pathname: '/api/lawfirms/firm-1/clients',
    })]);
    expect(() => api.assertNoUnhandledRequests()).toThrow(/matched no handler/);
  });

  it('reports every unmatched request, not just the first', async () => {
    await clientsService.listClients('firm-1').catch(() => {});
    await clientsService.listClients('firm-2').catch(() => {});

    expect(api.unhandledRequests().map((call) => call.pathname)).toEqual([
      '/api/lawfirms/firm-1/clients',
      '/api/lawfirms/firm-2/clients',
    ]);
    expect(() => api.assertNoUnhandledRequests()).toThrow(/2 request\(s\) matched no handler/);
  });

  it('fails from restore(), so no spec has to remember to check', async () => {
    const realFetch = global.fetch;
    await clientsService.listClients('firm-1').catch(() => {});

    expect(() => api.restore()).toThrow(/matched no handler/);
    // restore() puts the real fetch back BEFORE it asserts, so a failure here
    // cannot leak the fake into the next test in this file.
    expect(global.fetch).not.toBe(realFetch);
  });

  it('names the query string of the request that was missed', async () => {
    // Straight through the transport, because the message has to separate a
    // wrong FILTER from a missing route, and both look identical without it.
    await fetch('/api/lawfirms/firm-a/clients?status=archived').catch(() => {});

    expect(api.unhandledRequests()[0].search).toBe('?status=archived');
    expect(() => api.assertNoUnhandledRequests()).toThrow(/status=archived/);
  });

  it('an EXACT handler for another firm leaves the request unhandled', async () => {
    // The tenant-bleed case one level up: the request does not merely fail, it
    // is recorded as a route this spec never registered.
    api.getExact('/api/lawfirms/firm-a/clients', { clients: [] });

    await clientsService.listClients('firm-b').catch(() => {});

    expect(api.unhandledRequests().map((call) => call.pathname)).toEqual([
      '/api/lawfirms/firm-b/clients',
    ]);
  });

  it('a request a handler covers leaves nothing unhandled', async () => {
    api.get('/clients', { clients: [] });

    await clientsService.listClients('firm-1');

    expect(api.unhandledRequests()).toEqual([]);
    expect(() => api.assertNoUnhandledRequests()).not.toThrow();
  });

  it('allowUnhandled() opts out a spec whose subject IS the refusal', async () => {
    api.allowUnhandled();

    await clientsService.listClients('firm-1').catch(() => {});

    expect(api.unhandledRequests()).toHaveLength(1);
    expect(() => api.assertNoUnhandledRequests()).not.toThrow();
  });

  it('reset() clears both the record and the opt-out', async () => {
    api.allowUnhandled();
    await clientsService.listClients('firm-1').catch(() => {});
    expect(api.unhandledRequests()).toHaveLength(1);

    api.reset();

    expect(api.unhandledRequests()).toEqual([]);
    // The opt-out is per-spec state, so it must not survive a reset either.
    await clientsService.listClients('firm-3').catch(() => {});
    expect(() => api.assertNoUnhandledRequests()).toThrow(/matched no handler/);
  });
});
