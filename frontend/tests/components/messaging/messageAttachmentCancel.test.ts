/**
 * Cancelling a message attachment upload, firm side and client portal.
 *
 * Both composers upload in three steps: init opens one storage session per
 * file and reserves the firm's quota, the bytes go browser to storage, and
 * finalize verifies what landed and hands back ready-to-send attachments.
 *
 * A cancel is only honest if it holds at every step:
 *
 *   It stops the transfer. The storage PUT in flight is aborted and no later
 *   file is started, so a cancelled upload does not keep sending for minutes.
 *
 *   It never reaches finalize. Finalize is what turns landed bytes into
 *   attachments, so a cancel that slipped through it would hand back files the
 *   user asked not to send. That includes a cancel that arrives after the last
 *   byte landed but before finalize went out.
 *
 *   It rejects as `UploadCancelledError`, whichever step it interrupted. The
 *   composer shows no error for that one type, so an abort surfacing as a raw
 *   `AbortError` from init would be reported to the user as a failed upload.
 */
jest.unmock('@/services/messages.service');
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { installXhrMock, type XhrMock } from '../../support/xhrMock';
import { UploadCancelledError } from '@/lib/files/resumableUpload';
import messagesService from '@/services/messages.service';
import clientPortalService from '@/services/client-portal.service';
import type { MessageAttachment } from '@/types';

const FIRM = 'firm-1';
const SESSION_A = 'https://storage.googleapis.com/upload/a';
const SESSION_B = 'https://storage.googleapis.com/upload/b';

type Options = { signal?: AbortSignal; onFinalizing?: () => void };

interface Surface {
  name: string;
  base: string;
  /** The target every leg names, so the server resolves the same folder each time. */
  scope: Record<string, string>;
  upload: (
    files: File[],
    onProgress: ((p: number) => void) | undefined,
    options: Options,
  ) => Promise<MessageAttachment[]>;
}

const surfaces: Surface[] = [
  {
    name: 'firm side',
    base: `/lawfirms/${FIRM}/messaging/attachments`,
    scope: { clientId: 'client-1' },
    upload: (files, onProgress, options) =>
      messagesService.uploadAttachments(FIRM, { clientId: 'client-1' }, files, onProgress, options),
  },
  {
    name: 'client portal',
    base: `/client-portal/lawfirm/${FIRM}/messages/attachments`,
    scope: {},
    upload: (files, onProgress, options) =>
      clientPortalService.uploadMessageAttachments(FIRM, files, onProgress, undefined, options),
  },
];

let api: ApiMock;
let xhr: XhrMock;

const pdf = (name: string) => new File([new Uint8Array(1000)], name, { type: 'application/pdf' });

beforeEach(() => {
  api = installApiMock();
  xhr = installXhrMock();
});

afterEach(() => {
  api.restore();
  xhr.restore();
});

describe.each(surfaces)('cancelling a message attachment upload ($name)', ({ base, scope, upload }) => {
  /**
   * Two sessions opened, both PUTs succeeding unless a spec overrides one, one
   * finalize, and the release a cancel sends.
   */
  function arrange(initDelayMs = 0) {
    api.post(`${base}/upload-init`, {
      delayMs: initDelayMs,
      body: {
        uploads: [
          { uploadUrl: SESSION_A, objectPath: 'msg/a.pdf', fileName: 'a.pdf', reservationId: 'res-a' },
          { uploadUrl: SESSION_B, objectPath: 'msg/b.pdf', fileName: 'b.pdf', reservationId: 'res-b' },
        ],
        reservedBytes: 2000,
      },
    });
    xhr.onExact('PUT', SESSION_A, { status: 200 });
    xhr.onExact('PUT', SESSION_B, { status: 200 });
    api.post(`${base}/upload-finalize`, {
      attachments: [{ id: '1', name: 'a.pdf', objectPath: 'msg/a.pdf' }],
      failures: [],
    });
    api.post(`${base}/upload-cancel`, { cancelled: 2 });
  }

  /** What the release names: every session init opened, by object and reservation. */
  const bothReleased = {
    ...scope,
    uploads: [
      { objectPath: 'msg/a.pdf', reservationId: 'res-a' },
      { objectPath: 'msg/b.pdf', reservationId: 'res-b' },
    ],
  };

  /** Poll until a condition holds, for the release the caller does not wait on. */
  async function waitFor(condition: () => boolean, turns = 100): Promise<void> {
    for (let i = 0; i < turns && !condition(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  // The release goes out without the rejection waiting on it, so it can still
  // be on its way when a spec ends. A moment here lands it in this spec's fake
  // rather than the next one's.
  afterEach(async () => {
    await waitFor(() => false, 5);
  });

  it('aborts the storage transfer in flight and never finalizes', async () => {
    arrange();
    const controller = new AbortController();
    // The user cancels while the first file's bytes are on the wire.
    xhr.onExact('PUT', SESSION_A, () => {
      controller.abort();
      return { status: 200 };
    });

    await expect(upload([pdf('a.pdf'), pdf('b.pdf')], undefined, { signal: controller.signal }))
      .rejects.toBeInstanceOf(UploadCancelledError);

    // Red if the signal never reaches the uploader: the aborted PUT would
    // resolve 200, the second file would go out, and finalize would record both.
    expect(xhr.calls('PUT').map((c) => c.url)).toEqual([SESSION_A]);
    expect(api.callsTo(`${base}/upload-finalize`)).toEqual([]);
  });

  it('skips finalize when the cancel lands after the last byte', async () => {
    arrange();
    const controller = new AbortController();

    // 100 is reported once every byte of the batch is out, which is the last
    // moment before finalize. Nothing is in flight for the abort to interrupt.
    await expect(upload(
      [pdf('a.pdf'), pdf('b.pdf')],
      (p) => { if (p === 100) controller.abort(); },
      { signal: controller.signal },
    )).rejects.toBeInstanceOf(UploadCancelledError);

    // Red without a check between the storage leg and finalize: every PUT
    // succeeded, so only the signal itself says the user withdrew the files.
    expect(xhr.calls('PUT')).toHaveLength(2);
    expect(api.callsTo(`${base}/upload-finalize`)).toEqual([]);
  });

  it('stops while init is still open, as a cancel rather than a failure', async () => {
    arrange(200);
    const controller = new AbortController();

    const pending = upload([pdf('a.pdf')], undefined, { signal: controller.signal });
    controller.abort();
    const outcome = await Promise.race([
      pending.then(() => 'resolved', (err) => err),
      new Promise((resolve) => setTimeout(() => resolve('still waiting on init'), 100)),
    ]);

    // Red if the cancel waits for init to answer (200 ms here, a slow network
    // in life) before the composer is released, or if the aborted fetch escapes
    // as a raw AbortError, which the composer would report as a failure.
    expect(outcome).toBeInstanceOf(UploadCancelledError);
    await expect(pending).rejects.toBeInstanceOf(UploadCancelledError);
    expect(xhr.calls()).toEqual([]);
    expect(api.callsTo(`${base}/upload-finalize`)).toEqual([]);
    // Init still answers, and what it opened is given back once it does. Red
    // if the late answer is dropped: its reservations would hold the firm's
    // quota for two hours for an upload nobody sent.
    await waitFor(() => api.callsTo(`${base}/upload-cancel`).length > 0, 400);
    expect(api.callsTo(`${base}/upload-cancel`).map((c) => c.body)).toEqual([bothReleased]);
  });

  it('sends nothing at all when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(upload([pdf('a.pdf')], undefined, { signal: controller.signal }))
      .rejects.toBeInstanceOf(UploadCancelledError);

    // Red if init goes out first: it reserves quota for a batch nobody sends.
    expect(api.calls()).toEqual([]);
    expect(xhr.calls()).toEqual([]);
  });

  it('echoes each reservation init handed out at finalize', async () => {
    arrange();

    await upload([pdf('a.pdf'), pdf('b.pdf')], undefined, {});

    // Finalize deletes the reservations the body names. One left out stays
    // held for two hours while the same bytes also count as saved.
    const [done] = api.callsTo(`${base}/upload-finalize`);
    expect((done.body as { uploads: Array<{ reservationId?: string }> }).uploads.map((u) => u.reservationId))
      .toEqual(['res-a', 'res-b']);
  });

  it('gives back every session init opened on a cancel', async () => {
    arrange();
    const controller = new AbortController();
    xhr.onExact('PUT', SESSION_A, () => {
      controller.abort();
      return { status: 200 };
    });

    await expect(upload([pdf('a.pdf'), pdf('b.pdf')], undefined, { signal: controller.signal }))
      .rejects.toBeInstanceOf(UploadCancelledError);

    // Red without the release: the second file was never sent, and both
    // reservations would hold the quota until they lapse two hours later. The
    // target travels too, since the route checks the paths against its folder.
    await waitFor(() => api.callsTo(`${base}/upload-cancel`).length > 0);
    expect(api.callsTo(`${base}/upload-cancel`).map((c) => c.body)).toEqual([bothReleased]);
  });

  it('does not hold the cancel back for the release, and never reports a refused one', async () => {
    arrange();
    let answerRelease!: (response: unknown) => void;
    api.post(`${base}/upload-cancel`, () => new Promise((resolve) => { answerRelease = resolve; }));
    const controller = new AbortController();
    xhr.onExact('PUT', SESSION_A, () => {
      controller.abort();
      return { status: 200 };
    });

    const pending = upload([pdf('a.pdf'), pdf('b.pdf')], undefined, { signal: controller.signal });
    const outcome = await Promise.race([
      pending.then(() => 'resolved', (err) => err),
      new Promise((resolve) => setTimeout(() => resolve('waiting on the release'), 200)),
    ]);

    // Red if the rejection waits for the release: the composer would keep its
    // cancel control up for a request the user has no reason to wait on.
    expect(outcome).toBeInstanceOf(UploadCancelledError);
    await waitFor(() => api.callsTo(`${base}/upload-cancel`).length > 0);
    // Red if a refused release escapes as an unhandled rejection.
    answerRelease({ status: 500, body: { error: 'Internal error' } });
    await waitFor(() => false, 5);
    expect(api.callsTo(`${base}/upload-cancel`)).toHaveLength(1);
  });

  it('gives back every session when a transfer fails before finalize', async () => {
    arrange();
    // 410 is the session being gone, which the uploader treats as terminal.
    xhr.onExact('PUT', SESSION_B, { status: 410 });

    const outcome = await upload([pdf('a.pdf'), pdf('b.pdf')], undefined, {}).then(() => 'resolved', (err) => err);

    // A failure, not a cancel, and it never reaches finalize. Red without the
    // release: nothing else gives back what init reserved for either file.
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(UploadCancelledError);
    expect(api.callsTo(`${base}/upload-finalize`)).toEqual([]);
    await waitFor(() => api.callsTo(`${base}/upload-cancel`).length > 0);
    expect(api.callsTo(`${base}/upload-cancel`).map((c) => c.body)).toEqual([bothReleased]);
  });

  it('announces finalize once every byte has landed and before it goes out', async () => {
    arrange();
    const seenAtFinalizing: Array<{ puts: number; finalizes: number }> = [];

    const out = await upload([pdf('a.pdf'), pdf('b.pdf')], undefined, {
      onFinalizing: () => seenAtFinalizing.push({
        puts: xhr.calls('PUT').length,
        finalizes: api.callsTo(`${base}/upload-finalize`).length,
      }),
    });

    // The composer withdraws its cancel control on this call, because past
    // this point a cancel could only discard attachments the server already
    // verified. Red if it is never called, called early, or called late.
    expect(seenAtFinalizing).toEqual([{ puts: 2, finalizes: 0 }]);
    expect(out.map((a) => a.objectPath)).toEqual(['msg/a.pdf']);
  });
});
