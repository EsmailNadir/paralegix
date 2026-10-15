/**
 * Upload deny-list policy - pure unit tests.
 *
 * This is the only bar an uploaded file clears before it lands in the firm's
 * bucket and becomes downloadable by every member and, through document
 * requests and share links, by clients. There is no AV scanning behind it.
 *
 * Both the declared mimetype and the filename are client-supplied and trivially
 * faked, which is why the policy checks each independently AND sniffs the actual
 * leading bytes. Those three checks only work as a set: any one of them passing
 * alone must not be enough to get an executable through. That is the property
 * pinned here, alongside the equally important negative - a firm uploading its
 * own contracts, scans and spreadsheets must never be refused.
 *
 *   __TEST_TOKEN__=offline npx jest tests/shared/uploadPolicy.test.ts
 */

const {
  findExecutableSignature,
  rejectUploadIfDangerous,
  assertUploadsAllowed,
} = require('../../src/shared/utils/uploadPolicy');

/** A buffer beginning with the given bytes, padded so it clears the length guard. */
const bytes = (...leading: number[]) => Buffer.concat([
  Buffer.from(leading),
  Buffer.alloc(64),
]);

const PDF = Buffer.from('%PDF-1.7\n...');

describe('findExecutableSignature', () => {
  test.each([
    ['Windows executable', bytes(0x4d, 0x5a, 0x90, 0x00)],
    ['Linux executable', bytes(0x7f, 0x45, 0x4c, 0x46)],
    ['macOS or Java executable', bytes(0xfe, 0xed, 0xfa, 0xce)],
    ['macOS or Java executable', bytes(0xfe, 0xed, 0xfa, 0xcf)],
    ['macOS or Java executable', bytes(0xce, 0xfa, 0xed, 0xfe)],
    ['macOS or Java executable', bytes(0xcf, 0xfa, 0xed, 0xfe)],
    ['macOS or Java executable', bytes(0xca, 0xfe, 0xba, 0xbe)],
  ])('recognizes a %s', (label, buffer) => {
    expect(findExecutableSignature(buffer)).toBe(label);
  });

  test.each([
    ['pdf', PDF],
    ['png', bytes(0x89, 0x50, 0x4e, 0x47)],
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0)],
    ['zip / docx / xlsx', bytes(0x50, 0x4b, 0x03, 0x04)],
    ['plain text', Buffer.from('Dear Mr. Smith, please find attached')],
  ])('leaves a %s alone', (_label, buffer) => {
    // A false positive here refuses a real document with no way to override it.
    expect(findExecutableSignature(buffer)).toBeNull();
  });

  test('a buffer too short to hold a signature is not a signature', () => {
    // `readUInt32BE(0)` throws on a 3-byte buffer, so the length guard is
    // load-bearing rather than cosmetic.
    expect(findExecutableSignature(Buffer.from([0x4d, 0x5a, 0x90]))).toBeNull();
    expect(findExecutableSignature(Buffer.alloc(0))).toBeNull();
  });

  test('a non-buffer is not a signature', () => {
    for (const value of [null, undefined, '', 'MZ', 42, {}, []]) {
      expect(findExecutableSignature(value)).toBeNull();
    }
  });
});

describe('rejectUploadIfDangerous', () => {
  test('an ordinary document is allowed', () => {
    expect(rejectUploadIfDangerous({
      mimetype: 'application/pdf',
      originalname: 'Retainer Agreement.pdf',
      buffer: PDF,
    })).toBeNull();
  });

  test('a blocked extension is refused with 415 FILE_TYPE_NOT_ALLOWED', () => {
    const err = rejectUploadIfDangerous({ mimetype: 'application/pdf', originalname: 'invoice.exe' });
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(415);
    expect(err.code).toBe('FILE_TYPE_NOT_ALLOWED');
    // The message names the file so a firm member can tell which upload failed.
    expect(err.message).toContain('invoice.exe');
  });

  test('a blocked mimetype is refused even when the name looks harmless', () => {
    expect(rejectUploadIfDangerous({
      mimetype: 'application/x-msdownload',
      originalname: 'resume.pdf',
    })).not.toBeNull();
  });

  test('lying about BOTH the name and the type is caught by the bytes', () => {
    // The case the signature sniffing exists for: nothing in the declared
    // metadata is wrong, and the payload is still a Windows binary.
    const err = rejectUploadIfDangerous({
      mimetype: 'application/pdf',
      originalname: 'resume.pdf',
      buffer: bytes(0x4d, 0x5a, 0x90, 0x00),
    });
    expect(err).not.toBeNull();
    expect(err.status).toBe(415);
    expect(err.message).toContain('Windows executable');
  });

  test.each([
    'run.sh', 'setup.msi', 'macro.vbs', 'deploy.ps1', 'shell.php', 'page.jsp',
    'app.jar', 'installer.dmg', 'pkg.deb', 'legacy.hta', 'x.PHTML', 'X.EXE',
  ])('%s is refused whatever it claims to be', (originalname) => {
    expect({ originalname, allowed: rejectUploadIfDangerous({
      mimetype: 'application/octet-stream', originalname,
    }) === null }).toEqual({ originalname, allowed: false });
  });

  test.each([
    'Contract.pdf', 'Scan 001.jpeg', 'Ledger.xlsx', 'Brief.docx', 'notes.txt',
    'deposition.mp4', 'photos.zip', 'evidence.heic',
  ])('%s is allowed', (originalname) => {
    expect({ originalname, allowed: rejectUploadIfDangerous({
      mimetype: 'application/octet-stream', originalname,
    }) === null }).toEqual({ originalname, allowed: true });
  });

  test('an extension is the final segment, not any substring of the name', () => {
    // A refusal here would reject legitimate files whose name mentions a blocked
    // type; an acceptance of the reverse would let a real one through.
    expect(rejectUploadIfDangerous({ originalname: 'how-to-run-exe-files.pdf' })).toBeNull();
    expect(rejectUploadIfDangerous({ originalname: 'archive.pdf.exe' })).not.toBeNull();
  });

  test('a file with no name and no type is allowed on metadata alone', () => {
    // Rejecting it here would break the many callers that hand over a buffer
    // with no filename; the bytes are what still get checked.
    expect(rejectUploadIfDangerous({})).toBeNull();
    expect(rejectUploadIfDangerous(null)).toBeNull();
    expect(rejectUploadIfDangerous({ buffer: bytes(0x7f, 0x45, 0x4c, 0x46) })).not.toBeNull();
  });

  test('a mimetype with a charset parameter still matches the deny-list', () => {
    expect(rejectUploadIfDangerous({
      mimetype: 'application/x-sh; charset=utf-8',
      originalname: 'notes',
    })).not.toBeNull();
  });
});

describe('assertUploadsAllowed', () => {
  test('passes a batch of ordinary files', () => {
    expect(() => assertUploadsAllowed([
      { mimetype: 'application/pdf', originalname: 'a.pdf', buffer: PDF },
      { mimetype: 'image/png', originalname: 'b.png' },
    ])).not.toThrow();
  });

  test('one bad file in a batch rejects the whole batch', () => {
    // A partial accept would store the safe files and leave the caller thinking
    // the upload failed, which is a worse outcome than an outright refusal.
    expect(() => assertUploadsAllowed([
      { mimetype: 'application/pdf', originalname: 'a.pdf', buffer: PDF },
      { mimetype: 'application/pdf', originalname: 'b.exe' },
    ])).toThrow(/not allowed/);
  });

  test('the last file in a batch is checked, not just the first', () => {
    expect(() => assertUploadsAllowed([
      { originalname: 'a.pdf' }, { originalname: 'b.pdf' }, { originalname: 'c.bat' },
    ])).toThrow();
  });

  test('an empty or absent list is a no-op', () => {
    expect(() => assertUploadsAllowed([])).not.toThrow();
    expect(() => assertUploadsAllowed(null)).not.toThrow();
    expect(() => assertUploadsAllowed(undefined)).not.toThrow();
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
