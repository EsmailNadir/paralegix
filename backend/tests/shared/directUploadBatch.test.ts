/**
 * Uploading several files at once, and the storage quota that makes it
 * different from a loop.
 *
 * A batch reserves every declared size, one reservation per file, before any
 * session is minted, so a firm at its limit is refused before a byte moves.
 * Settling charges what LANDED and deletes the reservations the uploads name;
 * discarding deletes them early and removes partial objects that are provably
 * this caller's upload still in flight.
 *
 * Usage is charged for what landed because declared and landed bytes disagree
 * routinely:
 *
 *   nothing landed        an abandoned upload
 *   less landed           the browser sent a smaller file than it declared
 *   MORE landed           a resumable session has no size ceiling of its own
 *   some files failed     one bad file must not discard the others
 */
const exists = jest.fn();
const getMetadata = jest.fn();
const download = jest.fn();
const del = jest.fn();
const createResumableUpload = jest.fn();
const file = jest.fn((_path?: string) => ({ exists, getMetadata, download, delete: del, createResumableUpload }));

jest.mock('../../src/shared/database/firebase', () => ({
  admin: { storage: () => ({ bucket: () => ({ file }) }) },
}));

const reserveStorageUsage = jest.fn();
const releaseStorageReservations = jest.fn();
const adjustStorageUsageByDelta = jest.fn();
const storageLimitError = jest.fn(() => Object.assign(new Error('over quota'), { statusCode: 413 }));

jest.mock('../../src/shared/utils/storageUsage', () => ({
  reserveStorageUsage: (...a: unknown[]) => reserveStorageUsage.apply(null, a as []),
  releaseStorageReservations: (...a: unknown[]) => releaseStorageReservations.apply(null, a as []),
  adjustStorageUsageByDelta: (...a: unknown[]) => adjustStorageUsageByDelta.apply(null, a as []),
  storageLimitError: (...a: unknown[]) => storageLimitError.apply(null, a as []),
}));

import {
  beginDirectUploadBatch,
  discardDirectUploadBatch,
  settleDirectUploadBatch,
  DirectUploadRejected,
} from '../../src/shared/storage/directUpload';

const FIRM = 'firm-1';
const CAP = 100 * 1024 * 1024;
const PDF_HEAD = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

const declared = (name: string, size: number) => ({
  fileName: name, contentType: 'application/pdf', size,
});

const begin = (files: any[], over: Record<string, unknown> = {}) => beginDirectUploadBatch({
  lawFirmId: FIRM,
  uploadedBy: 'user-1',
  files,
  maxBytes: CAP,
  resolvePath: (f: any, i: number) => `messages/${i}_${f.fileName}`,
  ...over,
} as any);

/** Every object lands at the given size. */
function allLanded(size: number) {
  exists.mockResolvedValue([true]);
  getMetadata.mockResolvedValue([{
    size, contentType: 'application/pdf', metadata: { uploadedBy: 'user-1' },
  }]);
  download.mockResolvedValue([PDF_HEAD]);
}

const settle = (uploads: any[], onSettled = async (s: any) => s.objectPath) =>
  settleDirectUploadBatch({
    lawFirmId: FIRM,
    uploadedBy: 'user-1',
    uploads,
    maxBytes: CAP,
    onSettled,
  } as any);

/** The ids the last release was asked to delete, and for whom. */
const lastRelease = () => {
  const calls = releaseStorageReservations.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : null;
};

beforeEach(() => {
  jest.clearAllMocks();
  createResumableUpload.mockResolvedValue(['https://upload.test/session']);
  reserveStorageUsage.mockImplementation(async ({ sizes }: any) => ({
    reserved: true,
    reservationIds: sizes.map((_: unknown, i: number) => `res-${i}`),
    usedBytes: 0,
    heldBytes: 0,
  }));
  releaseStorageReservations.mockImplementation(async ({ reservationIds }: any) =>
    reservationIds.filter((id: unknown) => typeof id === 'string'));
  allLanded(1000);
  del.mockResolvedValue(undefined);
});

describe('opening a batch', () => {
  it('reserves every declared size in one call, before minting any session', async () => {
    await begin([declared('a.pdf', 1000), declared('b.pdf', 2000)]);

    expect(reserveStorageUsage).toHaveBeenCalledTimes(1);
    expect(reserveStorageUsage).toHaveBeenCalledWith({ lawFirmId: FIRM, createdBy: 'user-1', sizes: [1000, 2000] });
  });

  it('hands each upload its own reservation, and stamps it on the object', async () => {
    const opened = await begin([declared('a.pdf', 1000), declared('b.pdf', 2000)]);

    expect(opened.uploads.map((u) => u.reservationId)).toEqual(['res-0', 'res-1']);
    // The stamp is how a later cancel tells this upload's object from any
    // other: it must name the same reservation the request names.
    expect(createResumableUpload.mock.calls.map((c: any[]) => c[0].metadata.metadata.reservationId))
      .toEqual(['res-0', 'res-1']);
  });

  it('refuses a firm over its quota without opening anything', async () => {
    reserveStorageUsage.mockResolvedValue({
      reserved: false, reservationIds: [], usedBytes: 9, heldBytes: 0, quotaBytes: 10,
    });

    await expect(begin([declared('a.pdf', 1000)])).rejects.toThrow();

    expect(createResumableUpload).not.toHaveBeenCalled();
  });

  it('refuses a forbidden type WITHOUT touching the quota', async () => {
    // Admission runs first on purpose. Reserving and then refusing would mean
    // unwinding a reservation for a request that was never valid.
    await expect(begin([
      declared('ok.pdf', 10),
      { fileName: 'virus.exe', contentType: 'application/x-msdownload', size: 10 },
    ])).rejects.toThrow(DirectUploadRejected);

    expect(reserveStorageUsage).not.toHaveBeenCalled();
  });

  it('refuses a single file over the per-file cap', async () => {
    await expect(begin([declared('huge.pdf', CAP + 1)])).rejects.toThrow(DirectUploadRejected);
  });

  it('caps how many files one request may carry', async () => {
    // The array is caller-controlled, so it needs a ceiling of its own.
    const many = Array.from({ length: 21 }, (_, i) => declared(`f${i}.pdf`, 1));

    await expect(begin(many, { maxFiles: 20 })).rejects.toThrow(/at most 20/);
  });

  it('gives the reservation back if a session cannot be opened', async () => {
    // A partial batch must not leave the firm charged for files it can never
    // upload.
    createResumableUpload.mockRejectedValueOnce(new Error('storage down'));

    await expect(begin([declared('a.pdf', 1000)])).rejects.toThrow();

    expect(releaseStorageReservations).toHaveBeenCalledWith({
      lawFirmId: FIRM, createdBy: 'user-1', reservationIds: ['res-0'],
    });
  });
});

describe('settling what landed', () => {
  const twoUploads = [
    { objectPath: 'messages/0_a.pdf', fileName: 'a.pdf', reservationId: 'res-0' },
    { objectPath: 'messages/1_b.pdf', fileName: 'b.pdf', reservationId: 'res-1' },
  ];

  it('records every file that landed', async () => {
    const out = await settle(twoUploads);

    expect(out.results).toHaveLength(2);
    expect(out.failures).toEqual([]);
    expect(out.savedBytes).toBe(2000);
  });

  it('charges exactly what landed when LESS landed than declared', async () => {
    allLanded(400);

    await settle(twoUploads);

    expect(adjustStorageUsageByDelta).toHaveBeenCalledWith(FIRM, 800);
  });

  it('charges exactly what landed when MORE landed than declared', async () => {
    // A resumable session has no size ceiling, so a file can land larger than
    // it declared. Charging the declaration would under-count the firm.
    allLanded(1500);

    await settle(twoUploads);

    expect(adjustStorageUsageByDelta).toHaveBeenCalledWith(FIRM, 3000);
  });

  it('deletes the reservations the uploads name, for this caller only', async () => {
    await settle(twoUploads);

    expect(lastRelease()).toEqual({ lawFirmId: FIRM, createdBy: 'user-1', reservationIds: ['res-0', 'res-1'] });
  });

  it('charges nothing and still releases when nothing landed', async () => {
    // Every session was abandoned. Left standing, the reservations would hold
    // space the firm is not using until they lapse.
    exists.mockResolvedValue([false]);

    const out = await settle(twoUploads);

    expect(out.results).toEqual([]);
    expect(adjustStorageUsageByDelta).not.toHaveBeenCalled();
    expect(lastRelease().reservationIds).toEqual(['res-0', 'res-1']);
  });

  it('claims its reservations before verifying anything, so a racing cancel deletes nothing', async () => {
    // Reservations as the table holds them: a release deletes only what is
    // still live and answers with what it deleted.
    const live = new Set(['res-0', 'res-1']);
    releaseStorageReservations.mockImplementation(async ({ reservationIds }: any) =>
      reservationIds.filter((id: string) => live.delete(id)));
    getMetadata.mockResolvedValue([{
      size: 1000, contentType: 'application/pdf', metadata: { uploadedBy: 'user-1', reservationId: 'res-0' },
    }]);

    // A cancel for the same upload lands while finalize is recording the file
    // it has just verified. Releasing only at the end left the reservation live
    // here, so the cancel deleted bytes this finalize was about to hand back.
    await settle(twoUploads.slice(0, 1), async (settled: any) => {
      await discardDirectUploadBatch({
        lawFirmId: FIRM, uploadedBy: 'user-1', uploads: [twoUploads[0]], mayDeleteObject: () => true,
      });
      return settled.objectPath;
    });

    expect(del).not.toHaveBeenCalled();
    expect(adjustStorageUsageByDelta).toHaveBeenCalledWith(FIRM, 1000);
  });

  it('charges only the file that was saved when another fails', async () => {
    getMetadata
      .mockResolvedValueOnce([{ size: 1000, contentType: 'application/pdf', metadata: { uploadedBy: 'user-1' } }])
      .mockResolvedValueOnce([{ size: 1000, contentType: 'application/pdf', metadata: { uploadedBy: 'someone-else' } }]);

    const out = await settle(twoUploads);

    expect(out.results).toHaveLength(1);
    expect(out.failures).toHaveLength(1);
    expect(adjustStorageUsageByDelta).toHaveBeenCalledWith(FIRM, 1000);
    expect(releaseStorageReservations).toHaveBeenCalledTimes(1);
  });

  it('keeps the good files when one is refused', async () => {
    // The multipart path never discarded a whole message because one
    // attachment was bad, and neither does this.
    getMetadata
      .mockResolvedValueOnce([{ size: 1000, contentType: 'application/pdf', metadata: { uploadedBy: 'user-1' } }])
      .mockResolvedValueOnce([{ size: 1000, contentType: 'application/pdf', metadata: { uploadedBy: 'user-1' } }]);
    download
      .mockResolvedValueOnce([PDF_HEAD])
      .mockResolvedValueOnce([Buffer.from([0x4d, 0x5a, 0x90, 0, 0, 0, 0, 0])]);

    const out = await settle(twoUploads);

    expect(out.results).toHaveLength(1);
    expect(out.failures[0].fileName).toBe('b.pdf');
  });

  it('fails only the file whose row could not be written', async () => {
    let calls = 0;
    const out = await settle(twoUploads, async (s: any) => {
      calls += 1;
      if (calls === 2) throw new Error('row write failed');
      return s.objectPath;
    });

    expect(out.results).toHaveLength(1);
    expect(out.failures).toHaveLength(1);
    // The failed file's bytes are not the firm's usage.
    expect(adjustStorageUsageByDelta).toHaveBeenCalledWith(FIRM, 1000);
  });

  it('charges what a result reports it added, and keeps that figure out of the result', async () => {
    // A re-stamped row that was already counted adds nothing to usage. Charged
    // for what landed instead, a retried finalize bills the firm twice.
    const out = await settle(twoUploads, async (s: any) => ({ objectPath: s.objectPath, chargedBytes: 0 }));

    expect(out.results).toEqual([{ objectPath: 'messages/0_a.pdf' }, { objectPath: 'messages/1_b.pdf' }]);
    expect(out.savedBytes).toBe(0);
    expect(adjustStorageUsageByDelta).not.toHaveBeenCalled();
  });

  it('releases the reservations even when the loop throws unexpectedly', async () => {
    // The release runs before the loop, so nothing thrown inside it can skip it.
    exists.mockImplementation(() => { throw new Error('unexpected'); });

    await settle(twoUploads).catch(() => {});

    expect(lastRelease().reservationIds).toEqual(['res-0', 'res-1']);
  });
});

describe('discarding a batch', () => {
  const upload = { objectPath: 'messages/0_a.pdf', reservationId: 'res-0' };
  const discardWith = (mayDeleteObject?: (p: string) => boolean | Promise<boolean>, uploads = [upload]) =>
    discardDirectUploadBatch({ lawFirmId: FIRM, uploadedBy: 'user-1', uploads, mayDeleteObject });

  function objectStamped(custom: Record<string, string>) {
    getMetadata.mockResolvedValue([{ size: 10, contentType: 'application/pdf', metadata: custom }]);
  }

  it('releases the reservations and reports how many', async () => {
    const out = await discardWith();

    expect(out).toEqual({ cancelled: 1 });
    expect(lastRelease()).toEqual({ lawFirmId: FIRM, createdBy: 'user-1', reservationIds: ['res-0'] });
  });

  it('deletes a partial object that is provably this caller upload in flight', async () => {
    objectStamped({ uploadedBy: 'user-1', reservationId: 'res-0' });

    await discardWith(() => true);

    expect(file).toHaveBeenCalledWith('messages/0_a.pdf');
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('leaves every object alone when the caller gives no deletion check', async () => {
    objectStamped({ uploadedBy: 'user-1', reservationId: 'res-0' });

    await discardWith(undefined);

    expect(del).not.toHaveBeenCalled();
  });

  it('leaves an object the caller check refuses', async () => {
    objectStamped({ uploadedBy: 'user-1', reservationId: 'res-0' });

    await discardWith(() => false);

    expect(del).not.toHaveBeenCalled();
  });

  it('leaves an object stamped by somebody else', async () => {
    objectStamped({ uploadedBy: 'someone-else', reservationId: 'res-0' });

    await discardWith(() => true);

    expect(del).not.toHaveBeenCalled();
  });

  it('leaves an object whose stamp names a different reservation', async () => {
    // A live reservation of the caller's paired with another of their objects,
    // one that may already be settled and sent.
    objectStamped({ uploadedBy: 'user-1', reservationId: 'res-9' });

    await discardWith(() => true);

    expect(del).not.toHaveBeenCalled();
  });

  it('leaves an object whose reservation was no longer live', async () => {
    // Settling deletes the reservation, so an upload that finished has none
    // left for this call to release, and its object is never touched.
    objectStamped({ uploadedBy: 'user-1', reservationId: 'res-0' });
    releaseStorageReservations.mockResolvedValue([]);

    const out = await discardWith(() => true);

    expect(out).toEqual({ cancelled: 0 });
    expect(del).not.toHaveBeenCalled();
  });
});
