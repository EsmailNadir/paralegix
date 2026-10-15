/**
 * Message attachments, uploaded straight to storage.
 *
 * This service used to build its own `XMLHttpRequest` and POST the files to the
 * API as multipart: up to five at a hundred megabytes each, all resident in the
 * API container before the handler ran. It was also the fourth hand-rolled
 * upload loop in the codebase, each with its own retry behaviour and its own
 * bugs.
 *
 * There is one uploader now, shared with the files, photo and logo paths. What
 * is worth pinning here is what the shared uploader cannot check for itself:
 *
 *   The bytes go to the storage session urls and those requests must NOT carry
 *   the API credential. A signed session url is already the authorization.
 *
 *   Finalize runs only after every PUT resolves, and echoes back what the
 *   server handed out. Called after a failure it records attachments pointing
 *   at objects that are not there.
 *
 *   Progress is reported across the whole batch, not per file, or the bar drops
 *   back to zero on each of five attachments.
 */
jest.unmock('@/services/messages.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { installXhrMock, type XhrMock } from '../../support/xhrMock';
import messagesService from '@/services/messages.service';

const FIRM = 'firm-1';
const CLIENT = 'portal-1';
const BASE = `/lawfirms/${FIRM}/messaging/attachments`;
const SESSION_A = 'https://storage.googleapis.com/upload/a';
const SESSION_B = 'https://storage.googleapis.com/upload/b';

let api: ApiMock;
let xhr: XhrMock;

const pdf = (name: string, size: number) => {
  const file = new File([new Uint8Array(size)], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

beforeEach(() => {
  api = installApiMock();
  xhr = installXhrMock();
});

afterEach(() => {
  api.restore();
  xhr.restore();
});

/** Two files opened, both PUTs succeeding, one finalize. */
function arrangeTwo() {
  api.post(`${BASE}/upload-init`, {
    uploads: [
      { uploadUrl: SESSION_A, objectPath: 'msg/a.pdf', fileName: 'a.pdf' },
      { uploadUrl: SESSION_B, objectPath: 'msg/b.pdf', fileName: 'b.pdf' },
    ],
    reservedBytes: 3000,
  });
  xhr.onExact('PUT', SESSION_A, { status: 200 });
  xhr.onExact('PUT', SESSION_B, { status: 200 });
  api.post(`${BASE}/upload-finalize`, {
    attachments: [{ id: '1', name: 'a.pdf', objectPath: 'msg/a.pdf', url: 'https://signed/a', mimeType: 'application/pdf', size: 1000 }],
    failures: [],
  });
}

describe('attaching files to a message', () => {
  it('returns the attachments the server recorded', async () => {
    arrangeTwo();

    const out = await messagesService.uploadAttachments(
      FIRM, { clientId: CLIENT }, [pdf('a.pdf', 1000), pdf('b.pdf', 2000)],
    );

    expect(out).toHaveLength(1);
    expect(out[0].objectPath).toBe('msg/a.pdf');
  });

  it('declares every file and the conversation before opening sessions', async () => {
    arrangeTwo();

    await messagesService.uploadAttachments(
      FIRM, { clientId: CLIENT }, [pdf('a.pdf', 1000), pdf('b.pdf', 2000)],
    );

    const [init] = api.callsTo(`${BASE}/upload-init`);
    expect(init.body).toMatchObject({ clientId: CLIENT });
    expect((init.body as any).files).toEqual([
      { fileName: 'a.pdf', contentType: 'application/pdf', size: 1000 },
      { fileName: 'b.pdf', contentType: 'application/pdf', size: 2000 },
    ]);
  });

  it('targets a group thread by conversation id instead', async () => {
    arrangeTwo();

    await messagesService.uploadAttachments(
      FIRM, { conversationId: 'conv-9' }, [pdf('a.pdf', 1000), pdf('b.pdf', 2000)],
    );

    const [init] = api.callsTo(`${BASE}/upload-init`);
    expect(init.body).toMatchObject({ conversationId: 'conv-9' });
    expect(init.body).not.toHaveProperty('clientId');
  });

  it('sends the bytes to storage, not through the API', async () => {
    arrangeTwo();

    await messagesService.uploadAttachments(
      FIRM, { clientId: CLIENT }, [pdf('a.pdf', 1000), pdf('b.pdf', 2000)],
    );

    const puts = xhr.calls().filter((c) => c.method === 'PUT').map((c) => c.url);
    expect(puts).toEqual(expect.arrayContaining([SESSION_A, SESSION_B]));
  });

  it('does not attach the API credential to the storage requests', async () => {
    arrangeTwo();

    await messagesService.uploadAttachments(
      FIRM, { clientId: CLIENT }, [pdf('a.pdf', 1000), pdf('b.pdf', 2000)],
    );

    for (const call of xhr.calls().filter((c) => c.method === 'PUT')) {
      const headers = Object.keys(call.headers ?? {}).map((h) => h.toLowerCase());
      expect(headers).not.toContain('authorization');
    }
  });

  it('finalizes with what the server handed out, not client-built paths', async () => {
    arrangeTwo();

    await messagesService.uploadAttachments(
      FIRM, { clientId: CLIENT }, [pdf('a.pdf', 1000), pdf('b.pdf', 2000)],
    );

    const [done] = api.callsTo(`${BASE}/upload-finalize`);
    // The reservation is derived on the server from the rows init claimed. A
    // number sent from here could release another uploader's reservation.
    expect((done.body as any).reservedBytes).toBeUndefined();
    expect((done.body as any).uploads.map((u: any) => u.objectPath)).toEqual(['msg/a.pdf', 'msg/b.pdf']);
  });

  it('reports progress across the batch, never dropping back', async () => {
    arrangeTwo();
    const seen: number[] = [];

    await messagesService.uploadAttachments(
      FIRM, { clientId: CLIENT }, [pdf('a.pdf', 1000), pdf('b.pdf', 2000)], (p) => seen.push(p),
    );

    // Per-file percentages would reset to 0 partway through, which reads as the
    // upload restarting.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[seen.length - 1]).toBeLessThanOrEqual(100);
  });

  it('does nothing at all for an empty selection', async () => {
    const out = await messagesService.uploadAttachments(FIRM, { clientId: CLIENT }, []);

    expect(out).toEqual([]);
    expect(api.calls()).toEqual([]);
  });
});

describe('when something goes wrong', () => {
  it('does not finalize when a PUT failed', async () => {
    api.post(`${BASE}/upload-init`, {
      uploads: [{ uploadUrl: SESSION_A, objectPath: 'msg/a.pdf', fileName: 'a.pdf' }],
      reservedBytes: 1000,
    });
    // 410 is the session being gone, which the uploader treats as terminal.
    xhr.onExact('PUT', SESSION_A, { status: 410 });
    api.allowUnhandled();

    await expect(messagesService.uploadAttachments(FIRM, { clientId: CLIENT }, [pdf('a.pdf', 1000)]))
      .rejects.toThrow();

    expect(api.callsTo(`${BASE}/upload-finalize`)).toEqual([]);
  });

  it('surfaces a quota refusal without uploading anything', async () => {
    // The firm's storage quota is reserved at init, so a firm at its limit is
    // refused before a byte moves.
    api.post(`${BASE}/upload-init`, {
      status: 413, body: { error: 'Storage limit reached', code: 'STORAGE_LIMIT_EXCEEDED' },
    });

    await expect(messagesService.uploadAttachments(FIRM, { clientId: CLIENT }, [pdf('a.pdf', 1000)]))
      .rejects.toThrow(/Storage limit/);

    expect(xhr.calls()).toEqual([]);
  });
});
