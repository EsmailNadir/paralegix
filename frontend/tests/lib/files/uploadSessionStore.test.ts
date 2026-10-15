/**
 * The per-file memory of an open upload session.
 *
 * A resumable session URL lives seven days on the GCS side and the backend's
 * unfinalized-row sweeper keeps the row for 24 hours. Between those, a page
 * reload during a 3 GB upload would lose the URL and start over. This store
 * keeps the descriptor `upload-init` returned, keyed by what identifies the
 * SAME file being picked again, and forgets it before the sweeper would have.
 */
import {
  saveUploadSession,
  loadUploadSession,
  clearUploadSession,
  uploadSessionKey,
  UPLOAD_SESSION_MAX_AGE_MS,
  type UploadDestination,
} from '@/lib/files/uploadSessionStore';

const FIRM = 'firm-1';

/** Everything that decides WHERE an upload lands, and WHO is uploading it. */
const DEST: UploadDestination = {
  lawFirmId: FIRM,
  userId: 'user-1',
  context: 'matter',
  matterId: 'matter-9',
  taskId: null,
  clientId: null,
  folderId: 'folder-3',
};
const to = (over: Partial<UploadDestination> = {}): UploadDestination => ({ ...DEST, ...over });

const session = {
  fileId: '8d4f2a10-0000-4000-8000-000000000001',
  name: 'deposition.mp4',
  objectPath: 'lawfirmids/firm-1/objects/8d4f2a10-0000-4000-8000-000000000001',
  uploadUrl: 'https://storage.googleapis.com/upload/session-1',
  contentType: 'video/mp4',
  declaredSize: 3_000_000_000,
};

/** The SHA-256 of the file's content, streamed from its slices before any byte is sent. */
const FINGERPRINT = 'a'.repeat(64);

const fileLike = (
  overrides: Partial<{ name: string; size: number; lastModified: number; fingerprint: string }> = {},
) => ({
  name: 'deposition.mp4',
  size: 3_000_000_000,
  lastModified: 1_700_000_000_000,
  fingerprint: FINGERPRINT,
  ...overrides,
});

beforeEach(() => {
  window.localStorage.clear();
  jest.useRealTimers();
});

it('recalls what it saved for the same file', () => {
  saveUploadSession(DEST, fileLike(), session);

  expect(loadUploadSession(DEST, fileLike())).toEqual(session);
});

it('keys on name, size and last-modified together', () => {
  saveUploadSession(DEST, fileLike(), session);

  // A different file with the same name is a different upload. Resuming the
  // old session would write the new file's bytes after the old file's bytes.
  expect(loadUploadSession(DEST, fileLike({ size: 1 }))).toBeNull();
  expect(loadUploadSession(DEST, fileLike({ lastModified: 1 }))).toBeNull();
  expect(loadUploadSession(DEST, fileLike({ name: 'other.mp4' }))).toBeNull();
});

describe('the content fingerprint', () => {
  it('separates two files whose name, size and mtime all agree', () => {
    saveUploadSession(DEST, fileLike(), session);

    // Metadata is not content. A document re-exported from the same template,
    // or two scans off one device saved in the same millisecond, agree on all
    // three of the old key fields. Resuming across that appends the second
    // file's bytes to the first file's and stores one object holding the front
    // of one document and the back of another, at a size that looks correct.
    expect(loadUploadSession(DEST, fileLike({ fingerprint: 'b'.repeat(64) }))).toBeNull();
  });

  it('resumes only when the fingerprint matches', () => {
    saveUploadSession(DEST, fileLike(), session);

    expect(loadUploadSession(DEST, fileLike({ fingerprint: FINGERPRINT }))).toEqual(session);
  });

  it('refuses a record saved before the fingerprint was part of it', () => {
    // Written straight to the key this build computes, so the key cannot be
    // what rejects it: only the stored record's own fingerprint can. A
    // descriptor with no proof of content is a descriptor that could belong to
    // any file, which is the state this whole field exists to end.
    window.localStorage.setItem(
      uploadSessionKey(DEST, fileLike()),
      JSON.stringify({ session, savedAt: Date.now() }),
    );

    expect(loadUploadSession(DEST, fileLike())).toBeNull();
    expect(window.localStorage.getItem(uploadSessionKey(DEST, fileLike()))).toBeNull();
  });

  it('refuses a record whose stored fingerprint contradicts the file', () => {
    // Belt and braces over the key. If a future change ever drops the
    // fingerprint from the key, this still stops the resume, because the check
    // happens on the record itself before a byte is sent.
    window.localStorage.setItem(
      uploadSessionKey(DEST, fileLike()),
      JSON.stringify({ session, savedAt: Date.now(), fingerprint: 'c'.repeat(64) }),
    );

    expect(loadUploadSession(DEST, fileLike())).toBeNull();
  });
});

it('keys on the firm', () => {
  saveUploadSession(DEST, fileLike(), session);

  expect(loadUploadSession(to({ lawFirmId: 'firm-2' }), fileLike())).toBeNull();
});

it('forgets a session once cleared', () => {
  saveUploadSession(DEST, fileLike(), session);
  clearUploadSession(DEST, fileLike());

  expect(loadUploadSession(DEST, fileLike())).toBeNull();
  expect(window.localStorage.getItem(uploadSessionKey(DEST, fileLike()))).toBeNull();
});

it('drops a session older than the age limit', () => {
  jest.useFakeTimers({ now: 1_700_000_000_000 });
  saveUploadSession(DEST, fileLike(), session);

  jest.setSystemTime(1_700_000_000_000 + UPLOAD_SESSION_MAX_AGE_MS + 1);

  // The backend sweeper collects the row at 24 hours. A session recalled after
  // that would upload into an object nothing will ever finalize.
  expect(loadUploadSession(DEST, fileLike())).toBeNull();
  expect(window.localStorage.getItem(uploadSessionKey(DEST, fileLike()))).toBeNull();
});

it('keeps a session just inside the age limit', () => {
  jest.useFakeTimers({ now: 1_700_000_000_000 });
  saveUploadSession(DEST, fileLike(), session);

  jest.setSystemTime(1_700_000_000_000 + UPLOAD_SESSION_MAX_AGE_MS - 1);

  expect(loadUploadSession(DEST, fileLike())).toEqual(session);
});

it('survives storage that is unavailable', () => {
  const original = window.localStorage;
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError'); },
  });
  try {
    // A private window or a locked-down browser must not turn every upload
    // into an exception. The upload just runs without a memory.
    expect(() => saveUploadSession(DEST, fileLike(), session)).not.toThrow();
    expect(loadUploadSession(DEST, fileLike())).toBeNull();
    expect(() => clearUploadSession(DEST, fileLike())).not.toThrow();
  } finally {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: original });
  }
});

it('ignores a corrupt record', () => {
  window.localStorage.setItem(uploadSessionKey(DEST, fileLike()), '{not json');

  expect(loadUploadSession(DEST, fileLike())).toBeNull();
});

describe('the destination is part of the identity', () => {
  it('does not resume into a different folder', () => {
    saveUploadSession(DEST, fileLike(), session);

    // The same file picked again in another folder is a different upload. The
    // stored descriptor names a row already claimed in the ORIGINAL folder, so
    // resuming it finalizes the document where the user is not looking.
    expect(loadUploadSession(to({ folderId: 'folder-other' }), fileLike())).toBeNull();
  });

  it('does not resume into a different matter, task or client', () => {
    saveUploadSession(DEST, fileLike(), session);

    // Worse than the folder case: a different matter is a different permission
    // boundary, and the server rejects the mismatched row per file, which the
    // user sees as one file silently missing.
    expect(loadUploadSession(to({ matterId: 'matter-other' }), fileLike())).toBeNull();
    expect(loadUploadSession(to({ matterId: null, taskId: 'task-1', context: 'task' }), fileLike())).toBeNull();
    expect(loadUploadSession(to({ matterId: null, clientId: 'client-1', context: 'client' }), fileLike())).toBeNull();
  });

  it('does not resume another user session on a shared device', () => {
    saveUploadSession(DEST, fileLike(), session);

    expect(loadUploadSession(to({ userId: 'user-2' }), fileLike())).toBeNull();
  });

  it('resumes when every part of the destination matches', () => {
    saveUploadSession(DEST, fileLike(), session);

    expect(loadUploadSession(to(), fileLike())).toEqual(session);
  });

  it('cannot be confused by a delimiter inside a name', () => {
    // The key was built by joining fields with colons, so a file named with a
    // colon could produce the same key as a different file in a different
    // folder. JSON encoding removes the ambiguity.
    saveUploadSession(DEST, fileLike({ name: 'a:1:b.pdf' }), session);

    expect(loadUploadSession(DEST, fileLike({ name: 'a', size: 1 }))).toBeNull();
    expect(loadUploadSession(DEST, fileLike({ name: 'a:1:b.pdf' }))).toEqual(session);
  });
});
