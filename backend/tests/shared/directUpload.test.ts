/**
 * The one direct-to-storage upload helper, and the checks it must not lose.
 *
 * The cases here are mostly refusals, and each names what gets through if
 * the check is dropped:
 *
 *   The size cap has to be enforced against the bytes that LANDED. The
 *   resumable URL carries no ceiling of its own, so a caller that declares
 *   1 MB at init can PUT a gigabyte.
 *
 *   The object has to belong to the caller who opened it. Otherwise a caller
 *   finalizes an object someone else uploaded to the same place.
 *
 *   The magic-byte sniff moves from the request buffer to a ranged read of the
 *   first bytes. Dropped, a disguised executable is stored and served.
 */
const exists = jest.fn();
const getMetadata = jest.fn();
const download = jest.fn();
const del = jest.fn();
const createResumableUpload = jest.fn();
const file = jest.fn(() => ({ exists, getMetadata, download, delete: del, createResumableUpload }));

jest.mock('../../src/shared/database/firebase', () => ({
  admin: { storage: () => ({ bucket: () => ({ file }) }) },
}));

import {
  beginDirectUpload,
  settleDirectUpload,
  DirectUploadRejected,
} from '../../src/shared/storage/directUpload';

const OBJECT = 'users/u1/avatar/photo.png';
const CAP = 5 * 1024 * 1024;

/** A landed object of the given size and type. */
function landed({ size = 1000, contentType = 'image/png', uploadedBy = 'user-1', head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) } = {}) {
  exists.mockResolvedValue([true]);
  getMetadata.mockResolvedValue([{ size, contentType, metadata: { uploadedBy } }]);
  download.mockResolvedValue([head]);
}

beforeEach(() => {
  jest.clearAllMocks();
  createResumableUpload.mockResolvedValue(['https://storage.googleapis.com/upload/session-1']);
  landed();
  del.mockResolvedValue(undefined);
});

describe('opening an upload', () => {
  it('returns a session url the browser PUTs to, and never touches the bytes', async () => {
    const opened = await beginDirectUpload({
      objectPath: OBJECT, contentType: 'image/png', uploadedBy: 'user-1', maxBytes: CAP,
      fileName: 'photo.png',
    });

    expect(opened.uploadUrl).toBe('https://storage.googleapis.com/upload/session-1');
    expect(opened.objectPath).toBe(OBJECT);
  });

  it('stamps who opened it, which is what finalize checks later', async () => {
    await beginDirectUpload({
      objectPath: OBJECT, contentType: 'image/png', uploadedBy: 'user-1', maxBytes: CAP,
      fileName: 'photo.png',
    });

    const [[options]] = createResumableUpload.mock.calls;
    expect(options.metadata.metadata.uploadedBy).toBe('user-1');
    expect(options.metadata.contentType).toBe('image/png');
  });

  it('refuses a content type the caller does not allow', async () => {
    // The logo and photo routes accept four image types. Without this the
    // content-type allowlist is simply gone.
    await expect(beginDirectUpload({
      objectPath: OBJECT, contentType: 'application/x-msdownload', uploadedBy: 'user-1',
      maxBytes: CAP, allowedContentTypes: ['image/png', 'image/jpeg'], fileName: 'photo.png',
    })).rejects.toThrow(DirectUploadRejected);

    expect(createResumableUpload).not.toHaveBeenCalled();
  });

  it('refuses a dangerous type even when the caller allows everything', async () => {
    // No allow list means "any ordinary document", never "any bytes at all".
    await expect(beginDirectUpload({
      objectPath: 'files/x/thing.exe', contentType: 'application/x-msdownload', uploadedBy: 'user-1',
      maxBytes: CAP, fileName: 'thing.exe',
    })).rejects.toThrow(DirectUploadRejected);
  });

  it('refuses to open an upload that carries no file name', async () => {
    // The name is what the executable deny-list reads, and it used to be
    // derived from the object path when the caller left it out. An object path
    // is opaque: several destinations name the object themselves ("source",
    // "avatar.png", a uuid), so the extension checked was one the file never
    // had and the caller's own ".exe" was never looked at. A missing name is
    // now a caller error rather than something to invent.
    await expect(beginDirectUpload({
      objectPath: OBJECT, contentType: 'image/png', uploadedBy: 'user-1', maxBytes: CAP,
    } as any)).rejects.toMatchObject({ code: 'VALIDATION' });

    expect(createResumableUpload).not.toHaveBeenCalled();
  });

  it('refuses a declared size over the cap before opening anything', async () => {
    // Cheap and early. The real enforcement is at finalize, because a declared
    // size is a claim, but refusing here saves the round trip.
    await expect(beginDirectUpload({
      objectPath: OBJECT, contentType: 'image/png', uploadedBy: 'user-1',
      maxBytes: CAP, declaredSize: CAP + 1, fileName: 'photo.png',
    })).rejects.toThrow(DirectUploadRejected);

    expect(createResumableUpload).not.toHaveBeenCalled();
  });
});

describe('settling an upload', () => {
  it('reports the bytes that actually landed', async () => {
    landed({ size: 4321, contentType: 'image/png' });

    const settled = await settleDirectUpload({ objectPath: OBJECT, uploadedBy: 'user-1', maxBytes: CAP, fileName: 'photo.png' });

    expect(settled.size).toBe(4321);
    expect(settled.contentType).toBe('image/png');
  });

  it('refuses an object that was never uploaded', async () => {
    exists.mockResolvedValue([false]);

    await expect(settleDirectUpload({ objectPath: OBJECT, uploadedBy: 'user-1', maxBytes: CAP, fileName: 'photo.png' }))
      .rejects.toThrow(DirectUploadRejected);
  });

  it('refuses to settle an object somebody else opened', async () => {
    // Same destination, different caller. Without this, one user finalizes
    // another user's bytes as their own upload.
    landed({ uploadedBy: 'user-2' });

    await expect(settleDirectUpload({ objectPath: OBJECT, uploadedBy: 'user-1', maxBytes: CAP, fileName: 'photo.png' }))
      .rejects.toThrow(/not uploaded by you/i);
  });

  it('enforces the cap on the LANDED bytes, not the declared ones', async () => {
    // The whole reason the cap cannot stay at init: a resumable session URL has
    // no size ceiling, so a caller who declares one megabyte can PUT a gigabyte.
    landed({ size: CAP + 1 });

    await expect(settleDirectUpload({ objectPath: OBJECT, uploadedBy: 'user-1', maxBytes: CAP, fileName: 'photo.png' }))
      .rejects.toThrow(DirectUploadRejected);
  });

  it('deletes an oversized object rather than leaving it stored', async () => {
    landed({ size: CAP + 1 });

    await settleDirectUpload({ objectPath: OBJECT, uploadedBy: 'user-1', maxBytes: CAP, fileName: 'photo.png' }).catch(() => {});

    // Left behind it is billed storage nothing references, and it is still
    // readable by anyone who can guess or has the object path.
    expect(del).toHaveBeenCalled();
  });

  it('catches an executable disguised as an image', async () => {
    // The sniff that used to run on the multer buffer. It reads the first bytes
    // back from storage instead. Dropped, this file is stored and served.
    landed({ contentType: 'image/png', head: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0, 0, 0, 0]) });

    await expect(settleDirectUpload({ objectPath: OBJECT, uploadedBy: 'user-1', maxBytes: CAP, fileName: 'photo.png' }))
      .rejects.toThrow(/appears to be/i);
    expect(del).toHaveBeenCalled();
  });

  it('refuses a landed content type outside the allow list', async () => {
    // The type is only a claim at init. What storage recorded is what gets
    // served, so the allow list has to be applied to that too.
    landed({ contentType: 'text/html' });

    await expect(settleDirectUpload({
      objectPath: OBJECT, uploadedBy: 'user-1', maxBytes: CAP, fileName: 'photo.png',
      allowedContentTypes: ['image/png', 'image/jpeg'],
    })).rejects.toThrow(DirectUploadRejected);
  });

  it('reads only the first bytes, never the whole object', async () => {
    // A sniff that downloaded the object would put the file back in the process
    // and undo the entire point of uploading direct to storage.
    await settleDirectUpload({ objectPath: OBJECT, uploadedBy: 'user-1', maxBytes: CAP, fileName: 'photo.png' });

    const [[range]] = download.mock.calls;
    expect(range.start).toBe(0);
    expect(range.end).toBeLessThan(64);
  });

  it('treats an unreadable head as unverified rather than safe', async () => {
    // A sniff that cannot read the bytes has proved nothing. Passing on a failed
    // read turns the check into a check that is skipped whenever storage hiccups.
    download.mockRejectedValue(new Error('range read failed'));

    await expect(settleDirectUpload({ objectPath: OBJECT, uploadedBy: 'user-1', maxBytes: CAP, fileName: 'photo.png' }))
      .rejects.toThrow(DirectUploadRejected);
  });

  it('refuses to settle an upload that carries no file name', async () => {
    // Settle runs the executable deny-list a second time, against what actually
    // landed. The name it reads is the caller's, never the object path, so a
    // caller that states none is a caller error rather than a default.
    await expect(settleDirectUpload({
      objectPath: OBJECT, uploadedBy: 'user-1', maxBytes: CAP,
    } as any)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('accepts an object with no uploader stamp', async () => {
    // Objects written before the stamp existed. Permissive deliberately, and
    // narrowly: everything else still applies to them.
    landed({ uploadedBy: undefined });

    await expect(settleDirectUpload({ objectPath: OBJECT, uploadedBy: 'user-1', maxBytes: CAP, fileName: 'photo.png' }))
      .resolves.toMatchObject({ size: 1000 });
  });
});
