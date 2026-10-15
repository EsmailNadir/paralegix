/**
 * The XHR fake, proving itself against a REAL upload service.
 *
 * Uploads are the one path `apiMock` cannot see. They need a per-byte progress
 * event, `fetch` has no request-progress API, so every upload in this app runs
 * on `XMLHttpRequest` and is invisible to a fetch fake.
 *
 * What that leg IS changed. It used to be a multipart POST to our own API, with
 * the file under a named field and the credential attached by hand. The bytes
 * now go straight to a storage session url, so the properties worth proving
 * inverted with it: the credential must be ABSENT, and the url is a third-party
 * host rather than one of our routes. Both halves are asserted below, because
 * both would pass silently if the fake answered anything.
 *
 * This file drives `messages.service`, not a stand-in. The url building, the
 * session handling and the status handling all execute; `apiMock` covers the
 * two JSON legs around the upload.
 */
jest.unmock('@/services/messages.service');
jest.unmock('@/services/requestDeduplicator');

import messagesService from '@/services/messages.service';

import { setupApiMock } from './apiMock';
import { installXhrMock, type XhrMock } from './xhrMock';

const FIRM_A = 'firm-a';
const FIRM_B = 'firm-b';
const SESSION_A = 'https://storage.googleapis.com/upload/session-a';
const SESSION_B = 'https://storage.googleapis.com/upload/session-b';

let xhr: XhrMock;
const api = setupApiMock();

function aFile(name = 'contract.pdf'): File {
  return new File(['bytes'], name, { type: 'application/pdf' });
}

/** Answer the two JSON legs, so only the storage leg is under test. */
function arrangeJsonLegs(firm: string, sessionUrl: string) {
  api.post(`/lawfirms/${firm}/messaging/attachments/upload-init`, {
    uploads: [{ uploadUrl: sessionUrl, objectPath: 'msg/a.pdf', fileName: 'contract.pdf' }],
    reservedBytes: 5,
  });
  api.post(`/lawfirms/${firm}/messaging/attachments/upload-finalize`, {
    attachments: [{ name: 'contract.pdf' }], failures: [],
  });
}

const upload = (firm: string) =>
  messagesService.uploadAttachments(firm, { clientId: 'client-1' }, [aFile()]);

beforeEach(() => {
  xhr = installXhrMock();
});

describe('an upload url is matched exactly when the spec asks for it', () => {
  it('answers the session it was registered for', async () => {
    arrangeJsonLegs(FIRM_A, SESSION_A);
    xhr.onExact('PUT', SESSION_A, { status: 200 });

    const attachments = await upload(FIRM_A);

    expect(attachments).toEqual([{ name: 'contract.pdf' }]);
    expect(xhr.calls()[0].url).toBe(SESSION_A);
    xhr.restore();
  });

  it('refuses a session url it was not registered for', () => {
    // Session urls differ per upload, so a fake that answered any of them would
    // hide a service sending bytes to the wrong destination.
    //
    // Driven raw rather than through the service, here and in the unhandled
    // cases below. The uploader retries a failed transport with real backoff,
    // so routing an intentionally-unmatched request through it spends a minute
    // proving something about the RETRY policy instead of about the fake.
    xhr.onExact('PUT', SESSION_A, { status: 200 });

    const request = new XMLHttpRequest();
    request.open('PUT', SESSION_B);

    expect(() => request.send('bytes')).toThrow(/no handler for PUT/);

    xhr.allowUnhandled();
    xhr.restore();
  });

  it('refuses a LONGER url that merely contains the registered one', async () => {
    // Driven through a raw XMLHttpRequest because no service pairs two routes
    // of this shape. This is what separates `onExact` from `on`.
    xhr.onExact('POST', '/api/lawfirms/firm-a/files', { body: {} });

    const request = new XMLHttpRequest();
    request.open('POST', '/api/lawfirms/firm-a/files/archive');

    expect(() => request.send(null)).toThrow(/no handler for POST/);

    xhr.allowUnhandled();
    xhr.restore();
  });

  it('the substring form DOES answer that longer url, which is why it is opt-in', async () => {
    // The same request, the same registration, the other matcher. Kept as the
    // positive half: without it the assertion above would also pass against a
    // fake that refused everything.
    xhr.on('POST', '/api/lawfirms/firm-a/files', { body: { ok: true } });

    const request = new XMLHttpRequest();
    request.open('POST', '/api/lawfirms/firm-a/files/archive');

    expect(() => request.send(null)).not.toThrow();
    xhr.restore();
  });

  it('keeps the substring form available for existing broad setups', async () => {
    // `on` stays deliberately broad. It is the compact form for a spec whose
    // subject is not the url; `onExact` is for one where it is.
    arrangeJsonLegs(FIRM_B, SESSION_B);
    xhr.on('PUT', 'storage.googleapis.com', { status: 200 });

    await expect(upload(FIRM_B)).resolves.toEqual([{ name: 'contract.pdf' }]);
    xhr.restore();
  });
});

describe('an unmatched upload survives being caught', () => {
  afterEach(() => {
    // Runs before each test's own restore, so a failed assertion inside a test
    // cannot also blow up in teardown and bury the real error.
    xhr.allowUnhandled();
  });

  /** An upload nobody registered a handler for, with the throw swallowed. */
  function unmatchedPut(url: string) {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    // Every upload path wraps a transport failure in its own Error, which is
    // exactly how an unregistered request becomes an invisible one. Swallowing
    // it here models that.
    try { request.send('bytes'); } catch { /* swallowed, like a service would */ }
  }

  it('still records the request when the caller swallows the throw', () => {
    unmatchedPut(SESSION_A);

    expect(xhr.unhandledRequests()).toEqual([expect.objectContaining({ method: 'PUT' })]);
    expect(() => xhr.assertNoUnhandledRequests()).toThrow(/matched no handler/);
  });

  it('names the url that was missed', () => {
    unmatchedPut(SESSION_B);

    expect(() => xhr.assertNoUnhandledRequests()).toThrow(/session-b/);
  });

  it('fails from restore(), so no spec has to remember to check', () => {
    unmatchedPut(SESSION_A);

    expect(() => xhr.restore()).toThrow(/matched no handler/);
    // restore() puts the real XMLHttpRequest back BEFORE it asserts, so the
    // failure cannot leak the fake into the next test in this file.
    expect((globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest).not.toBe(undefined);
  });

  it('a matched upload leaves nothing unhandled', async () => {
    arrangeJsonLegs(FIRM_A, SESSION_A);
    xhr.onExact('PUT', SESSION_A, { status: 200 });

    await upload(FIRM_A);

    expect(xhr.unhandledRequests()).toEqual([]);
    expect(() => xhr.assertNoUnhandledRequests()).not.toThrow();
  });
});

describe('what an upload actually puts on the wire', () => {
  afterEach(() => xhr.restore());

  it('sends the file bytes to the storage session, not to our API', async () => {
    arrangeJsonLegs(FIRM_A, SESSION_A);
    xhr.onExact('PUT', SESSION_A, { status: 200 });

    await upload(FIRM_A);

    const [call] = xhr.calls();
    expect(call.method).toBe('PUT');
    expect(call.url).toBe(SESSION_A);
    // A FormData body would mean the multipart path came back, and with it the
    // whole file resident in the API container.
    expect(call.body).not.toBeInstanceOf(FormData);
  });

  it('does NOT carry the API credential to storage', async () => {
    // Inverted from the multipart path, where the service attached the token by
    // hand. A signed session url IS the authorization; a bearer token here
    // sends the user's API credential to a third-party host.
    arrangeJsonLegs(FIRM_A, SESSION_A);
    xhr.onExact('PUT', SESSION_A, { status: 200 });

    await upload(FIRM_A);

    const headers = Object.keys(xhr.calls()[0].headers).map((h) => h.toLowerCase());
    expect(headers).not.toContain('authorization');
  });
});

describe('cancelling a request', () => {
  it('emits abort when the caller aborts it, and drops the scripted reply', async () => {
    const xhr = installXhrMock();
    xhr.on('PUT', '/upload', { status: 200 });
    const events: string[] = [];
    try {
      const request = new (globalThis as any).XMLHttpRequest();
      request.addEventListener('load', () => events.push('load'));
      request.addEventListener('abort', () => events.push('abort'));
      request.open('PUT', 'https://storage.example/upload');
      request.send(null);
      request.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      xhr.restore();
    }

    // An upload driven by an AbortSignal calls `abort()` from the signal's own
    // listener, where a thrown TypeError is swallowed by the event dispatch. A
    // fake without this looks cancelled while the cancellation never reached
    // the request, and every spec about it passes.
    expect(events).toEqual(['abort']);
  });
});
