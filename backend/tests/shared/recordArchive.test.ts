/**
 * Preserved-record archive paths and the guard protecting them - pure unit tests.
 *
 * The archive is what lets a firm still produce a signed document, its
 * certificate, or an invoice exactly as it was emailed, long after the working
 * copies have been moved, edited or deleted.
 *
 * All of that rests on one thing staying true: the prefix the writers write to
 * and the prefix the guards refuse to touch must be the SAME prefix. If they
 * drift, nothing announces it. Deletes keep returning 200, the archive keeps
 * looking populated, and the loss only surfaces the day somebody needs the record
 * and it is not there. Hence tests that pin the shape rather than trusting
 * separate regexes in separate files to stay in step.
 *
 * These hit no server and no bucket. Run alone with:
 *
 *   __TEST_TOKEN__=offline npx jest tests/shared/recordArchive.test.js
 */

const archive = require('../../src/shared/storage/recordArchive');
const invoiceArchive = require('../../src/modules/billing/invoices/invoiceArchive');
const signingArchive = require('../../src/modules/signatures/signingArchive');

const FIRM = '1354e5d3-1b94-46b2-b78d-0e04faece7d4';
const RECORD = 'f65d23e34b752f533b9306da067d3f85b7b12a005b196899';

describe('archive placement', () => {
  test('every segment sits beside the browsable folders, never inside one', () => {
    // `general/`, `clients/`, `tasks/` and the per-matter uuid folders are what
    // the file browser lists. A path under any of them would be listable, and so
    // deletable, which is the whole thing being avoided.
    for (const segment of archive.ARCHIVE_SEGMENTS) {
      const path = archive.archivePath(FIRM, segment, RECORD, 'x.pdf');
      const afterFirm = path.slice(`lawfirmids/${FIRM}/`.length);
      expect(afterFirm.startsWith(`${segment}/`)).toBe(true);
      for (const browsable of ['general/', 'clients/', 'tasks/', 'messaging/']) {
        expect({ segment, browsable, nested: afterFirm.startsWith(browsable) })
          .toEqual({ segment, browsable, nested: false });
      }
    }
  });

  test('paths depend only on the firm, the segment and the record id', () => {
    // Nothing about the matter, the file name or any other row feeds the path, so
    // the bytes stay addressable however much of the database is gone.
    expect(archive.archivePath(FIRM, 'invoices', RECORD, 'a.pdf'))
      .toBe(`lawfirmids/${FIRM}/invoices/${RECORD}/a.pdf`);
    expect(archive.archivePrefix(FIRM, 'signatures', RECORD))
      .toBe(`lawfirmids/${FIRM}/signatures/${RECORD}/`);
  });

  test('each artifact path lives under its own record prefix', () => {
    for (const segment of archive.ARCHIVE_SEGMENTS) {
      const prefix = archive.archivePrefix(FIRM, segment, RECORD);
      expect(archive.archivePath(FIRM, segment, RECORD, 'x.pdf').startsWith(prefix)).toBe(true);
    }
  });
});

describe('isProtectedArchivePath', () => {
  test('recognizes every path the writers actually produce', () => {
    // Derived from the same module as the path builders; this asserts they agree
    // rather than merely looking similar.
    const written = [
      signingArchive.signingArchivePath(FIRM, RECORD, signingArchive.CERTIFICATE_ARTIFACT),
      signingArchive.signingArchivePath(FIRM, RECORD, signingArchive.SIGNED_DOCUMENT_ARTIFACT),
      invoiceArchive.invoiceArchivePath(FIRM, RECORD, invoiceArchive.sentCopyName('2026-07-27T12:00:00.000Z')),
    ];
    for (const path of written) {
      expect({ path, protected: archive.isProtectedArchivePath(path) })
        .toEqual({ path, protected: true });
    }
  });

  test('covers both segments for any firm and any record', () => {
    expect(archive.isProtectedArchivePath('lawfirmids/abc/signatures/t/signed-document.pdf')).toBe(true);
    expect(archive.isProtectedArchivePath('lawfirmids/abc/invoices/t/sent-2026.pdf')).toBe(true);
    expect(archive.isProtectedArchivePath('lawfirmids/abc/invoices/')).toBe(true);
  });

  test("leaves the firm's own documents alone", () => {
    // A false positive would refuse to delete ordinary files, so the guard has to
    // be narrow as well as complete.
    const ordinary = [
      `lawfirmids/${FIRM}/general/contract.pdf`,
      `lawfirmids/${FIRM}/clients/${FIRM}/letter.pdf`,
      `lawfirmids/${FIRM}/tasks/${FIRM}/notes.pdf`,
      `lawfirmids/${FIRM}/${FIRM}/Signed - Retainer.pdf`,
      // Folders a user happens to name "invoices" or "signatures" inside their
      // own matter or General Files are theirs, not ours.
      `lawfirmids/${FIRM}/${FIRM}/signatures/mine.pdf`,
      `lawfirmids/${FIRM}/${FIRM}/invoices/mine.pdf`,
      `lawfirmids/${FIRM}/general/invoices/mine.pdf`,
    ];
    for (const path of ordinary) {
      expect({ path, protected: archive.isProtectedArchivePath(path) })
        .toEqual({ path, protected: false });
    }
  });

  test('is not fooled by a lookalike prefix', () => {
    expect(archive.isProtectedArchivePath(`lawfirmids/${FIRM}/signatures-old/x.pdf`)).toBe(false);
    expect(archive.isProtectedArchivePath(`lawfirmids/${FIRM}/invoiced/x.pdf`)).toBe(false);
    expect(archive.isProtectedArchivePath(`otherroot/${FIRM}/invoices/${RECORD}/x.pdf`)).toBe(false);
    // Only a direct child of the firm segment counts, so a replay of the prefix
    // deeper in a user's own tree is not treated as archive.
    expect(archive.isProtectedArchivePath(`lawfirmids/${FIRM}/a/b/invoices/x.pdf`)).toBe(false);
  });

  test('handles missing and non-string input without throwing', () => {
    for (const value of [null, undefined, '', 0, {}, []]) {
      expect(archive.isProtectedArchivePath(value)).toBe(false);
    }
  });
});

describe('isSystemObjectPath', () => {
  // Two questions with different answers, hence two predicates. Everything the
  // system placed under the firm prefix is excluded from the quota AND refused by
  // the generic file-read gates; only the archives are additionally refused by
  // delete/rename/move. A scratch copy is transient and its own session sweeps it.
  test('covers the archives and the scratch prefix an open session works in', () => {
    const system = [
      `lawfirmids/${FIRM}/signatures/${RECORD}/signed-document.pdf`,
      `lawfirmids/${FIRM}/invoices/${RECORD}/sent-2026.pdf`,
      `lawfirmids/${FIRM}/signing-work/${RECORD}/shared.pdf`,
      `lawfirmids/${FIRM}/signing-work/${RECORD}/participant-1.pdf`,
    ];
    for (const path of system) {
      expect({ path, system: archive.isSystemObjectPath(path) })
        .toEqual({ path, system: true });
    }
  });

  test('is wider than the delete guard, and only there', () => {
    // A working copy is a system object (no quota, no generic read) but NOT a
    // preserved record: nothing has to refuse to delete one, because the session
    // that owns it does exactly that when it finishes.
    const working = `lawfirmids/${FIRM}/signing-work/${RECORD}/shared.pdf`;
    expect(archive.isSystemObjectPath(working)).toBe(true);
    expect(archive.isProtectedArchivePath(working)).toBe(false);
  });

  test("leaves the firm's own documents alone", () => {
    // A false positive here hides a real file from its owner, so this must be as
    // narrow as the delete guard.
    const ordinary = [
      `lawfirmids/${FIRM}/general/contract.pdf`,
      `lawfirmids/${FIRM}/${FIRM}/Signed - Retainer.pdf`,
      `lawfirmids/${FIRM}/messaging/${FIRM}_uid/attachment.pdf`,
      // A folder a user named "signing-work" inside their own matter is theirs.
      `lawfirmids/${FIRM}/${FIRM}/signing-work/mine.pdf`,
      `lawfirmids/${FIRM}/signing-workshop/x.pdf`,
    ];
    for (const path of ordinary) {
      expect({ path, system: archive.isSystemObjectPath(path) })
        .toEqual({ path, system: false });
    }
  });

  test('handles missing and non-string input without throwing', () => {
    for (const value of [null, undefined, '', 0, {}, []]) {
      expect(archive.isSystemObjectPath(value)).toBe(false);
    }
  });
});

describe('putArtifact guards', () => {
  test('refuses to write without a path or bytes, rather than throwing', async () => {
    // Every caller treats archiving as best-effort and must not fail a send or a
    // signing request over it.
    const path = archive.archivePath(FIRM, 'invoices', RECORD, 'x.pdf');
    expect(await archive.putArtifact('', Buffer.from('x'))).toBe(false);
    expect(await archive.putArtifact(path, null)).toBe(false);
    expect(await archive.putArtifact(path, Buffer.alloc(0))).toBe(false);
  });

  test('reading without a path yields nothing rather than throwing', async () => {
    expect(await archive.getArtifact('')).toBeNull();
    expect(await archive.getArtifact(null)).toBeNull();
  });

  test('listing without a prefix yields an empty list', async () => {
    expect(await archive.listArtifacts('')).toEqual([]);
  });
});

describe('invoice sent copies', () => {
  test('names a copy after the moment it was sent', () => {
    // The timestamp is in the NAME, not only in object metadata, so the send
    // history stays readable and two sends can never collide.
    expect(invoiceArchive.sentCopyName('2026-07-27T12:34:56.789Z'))
      .toBe('sent-2026-07-27T12-34-56-789Z.pdf');
  });

  test('two sends a millisecond apart get different names', () => {
    expect(invoiceArchive.sentCopyName('2026-07-27T12:34:56.001Z'))
      .not.toBe(invoiceArchive.sentCopyName('2026-07-27T12:34:56.002Z'));
  });

  test('archiving nothing stores nothing', async () => {
    // A reminder email carries no attachment; there is no as-sent invoice to keep.
    expect(await invoiceArchive.archiveSentCopy({ lawFirmId: FIRM, invoiceId: RECORD })).toBeNull();
    expect(await invoiceArchive.archiveSentCopy({
      lawFirmId: FIRM, invoiceId: RECORD, pdfBuffer: Buffer.alloc(0),
    })).toBeNull();
  });

  test('a traversing name cannot read outside the invoice', async () => {
    // The name reaches this from the URL, so it must not be able to walk up into
    // another record's archive.
    for (const name of ['../x.pdf', 'a/b.pdf', '..\\x.pdf', '../../signatures/t/signed-document.pdf']) {
      expect({ name, bytes: await invoiceArchive.getSentCopy(FIRM, RECORD, name) })
        .toEqual({ name, bytes: null });
    }
  });

  test('listing without a firm or invoice yields an empty list', async () => {
    expect(await invoiceArchive.listSentCopies(null, RECORD)).toEqual([]);
    expect(await invoiceArchive.listSentCopies(FIRM, null)).toEqual([]);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
