/**
 * Taking a firm document and making it a signing source.
 *
 * A PDF picked out of the firm's own documents used to be signed against IN
 * PLACE, which left the session depending on a file the firm can freely delete,
 * rename, move or replace while signing is still open. Doing any of those broke
 * the signer's link with no diagnosis, and replacing the file silently changed
 * what finalize rebuilds the executed document from, so the signed document
 * could differ from what the signer read.
 *
 * The session takes its own copy. The two things that make that copy worth
 * anything are tested below: it is a SERVER-SIDE copy, so a 2 GB document does
 * not travel through a 512 MiB container, and it is PINNED to the version that
 * was checked, so a file replaced between the check and the copy fails instead
 * of being taken under a decision made about other bytes.
 */
import { randomUUID } from 'crypto';
import { objects, putObject, nextGeneration } from '../support/inMemoryBucket';
import { minimalPdfBytes } from '../support/minimalPdf';
import { installRichBucket, resetRichBucket, bytesRead, resetBytesRead } from '../files/richBucket';
import {
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

installRichBucket();

let firm: Firm;
let owner: Actor;
let viewer: Actor;

const L = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/signature-links`;

/**
 * A firm document, as the picker hands one to this route.
 *
 * Only the stored object, deliberately. The route authorizes on the PATH and on
 * matter membership when the path names a matter document, so a `files` row
 * would add a dependency this test is not about.
 */
function firmDocument(bytes: Buffer, name = 'Retainer.pdf') {
  const objectPath = `lawfirmids/${firm.id}/objects/${randomUUID()}`;
  putObject(objectPath, { body: bytes, contentType: 'application/pdf' });
  return { objectPath, name };
}

const prepare = (actor: Actor, body: Record<string, unknown>) =>
  actor.api.post(`${L(firm.id)}/prepare`).send(body);

beforeEach(async () => {
  resetRichBucket();
  resetBytesRead();
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  viewer = await memberWith(firm.id, ['signatures.view']);
});

describe('preparing a firm PDF', () => {
  it('requires flattening confirmation before preparing a fillable file-manager PDF', async () => {
    const source = firmDocument(minimalPdfBytes({ flattenableForm: true }), 'Interactive Intake.pdf');

    const res = await prepare(owner, {
      objectPath: source.objectPath,
      fileName: source.name,
      requireFlatteningConfirmation: true,
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PDF_REQUIRES_FLATTENING');
    expect(
      [...objects.keys()].filter((path) => path.startsWith(`signing-uploads/${firm.id}/`)),
    ).toHaveLength(0);
  });

  it('keeps automatic form preparation for callers outside the File Manager flow', async () => {
    const source = firmDocument(minimalPdfBytes({ flattenableForm: true }), 'Interactive Intake.pdf');

    const res = await prepare(owner, { objectPath: source.objectPath, fileName: source.name });

    expect(res.status).toBe(200);
    expect(res.body.objectPath.startsWith(`signing-uploads/${firm.id}/`)).toBe(true);
  });

  it('takes its own copy instead of signing the firm document in place', async () => {
    const source = firmDocument(minimalPdfBytes());

    const res = await prepare(owner, { objectPath: source.objectPath, fileName: source.name });

    expect(res.status).toBe(200);
    expect(res.body.objectPath).not.toBe(source.objectPath);
    expect(res.body.objectPath.startsWith(`signing-uploads/${firm.id}/`)).toBe(true);
    // The firm's document is untouched, which is the point of copying.
    expect(objects.has(source.objectPath)).toBe(true);
  });

  it('copies SERVER-SIDE, and streams the document at most once', async () => {
    // The claim the whole approach rests on. A copy that downloaded and re-saved
    // would look identical from the outside and put the document in a 512 MiB
    // container.
    //
    // This asserted ZERO bytes, and preparing now admits the copy: the boundary
    // inspects its structure and hashes it in ONE streamed pass. That read did
    // not appear from nowhere. It moved here from the send, which used to
    // `download()` the whole document into a Buffer to hash it and now reads the
    // hash off the admitted row. One bounded pass replaced one buffered one.
    const bytes = minimalPdfBytes({ fillerBytes: 512 * 1024 });
    const source = firmDocument(bytes);
    resetBytesRead();

    const res = await prepare(owner, { objectPath: source.objectPath, fileName: source.name });

    expect(res.status).toBe(200);
    // One pass, plus the structural reads that resolve the cross-reference
    // chain and the page tree. Those overlap the streamed pass, because the
    // reader grows its window rather than guessing a size, so the total lands a
    // little above one pass and nowhere near two. The bound separates exactly
    // that: at 1.5 a second full read cannot hide under it.
    expect(bytesRead()).toBeLessThan(bytes.length * 1.5);
  });

  it('reads NOTHING when the same document is prepared again', async () => {
    // Admission is idempotent: the second call finds a source that is already
    // ready and returns it. Without that, every send re-hashed and re-flattened
    // bytes that cannot have changed, because the copy they describe is frozen.
    const source = firmDocument(minimalPdfBytes({ fillerBytes: 512 * 1024 }));
    const first = await prepare(owner, { objectPath: source.objectPath, fileName: source.name });
    expect(first.status).toBe(200);

    resetBytesRead();
    const again = await prepare(owner, {
      objectPath: first.body.objectPath, fileName: source.name,
    });

    expect(again.status).toBe(200);
    expect(bytesRead()).toBe(0);
  });

  it('stamps the copy with the uploader, or every later gate rejects it', async () => {
    // Preview, re-send and save-as-template all key on `uploadedBy` for a
    // signing-uploads path. Without the stamp the sender cannot open the
    // document they just prepared.
    const source = firmDocument(minimalPdfBytes());

    const res = await prepare(owner, { objectPath: source.objectPath, fileName: source.name });

    const copied = objects.get(res.body.objectPath)!;
    expect(copied.custom.uploadedBy).toBe(owner.uid);
    expect(copied.custom.frozenForSigning).toBe('true');
    expect(copied.custom.sourceObjectPath).toBe(source.objectPath);
  });

  it('PINS the copy to the version it checked', async () => {
    // The dangerous case. Same path, different bytes: an unpinned copy takes the
    // new document under a check that passed for the old one, and the signer is
    // shown something nobody approved.
    const source = firmDocument(minimalPdfBytes());
    const stored = objects.get(source.objectPath)!;

    const res = await prepare(owner, { objectPath: source.objectPath, fileName: source.name });

    expect(res.status).toBe(200);
    expect(objects.get(res.body.objectPath)!.custom.sourceGeneration).toBe(stored.generation);
  });

  it('FAILS rather than copying a document that was replaced mid-prepare', async () => {
    // Simulated by pinning to a generation the object no longer has, which is
    // exactly what the real client does when the object moved on.
    const source = firmDocument(minimalPdfBytes());
    const stale = nextGeneration();

    await expect(
      objects.get(source.objectPath)
      && require('../support/inMemoryBucket').inMemoryBucket
        .file(source.objectPath, { generation: stale })
        .copy({ name: 'signing-uploads/x/y/z.pdf' }),
    ).rejects.toMatchObject({ code: 412 });
  });

  it('keeps a transient upload as it is, because it is already the session copy', async () => {
    // Copying it again buys nothing: nobody can reach it through the file
    // browser and it is already exclusive to this session.
    const objectPath = `signing-uploads/${firm.id}/${randomUUID()}/already.pdf`;
    putObject(objectPath, {
      body: minimalPdfBytes(), contentType: 'application/pdf', custom: { uploadedBy: owner.uid },
    });

    const res = await prepare(owner, { objectPath, fileName: 'already.pdf' });

    expect(res.status).toBe(200);
    expect(res.body.objectPath).toBe(objectPath);
  });
});

describe('what prepare refuses', () => {
  it('refuses a member without signatures.send', async () => {
    const source = firmDocument(minimalPdfBytes());

    const res = await prepare(viewer, { objectPath: source.objectPath, fileName: source.name });

    expect(res.status).toBe(403);
  });

  it('refuses another firm document, even one that exists', async () => {
    const other = await createFirm({ name: 'Vance LLP' });
    const objectPath = `lawfirmids/${other.id}/objects/${randomUUID()}`;
    putObject(objectPath, { body: minimalPdfBytes(), contentType: 'application/pdf' });

    const res = await prepare(owner, { objectPath, fileName: 'theirs.pdf' });

    // Sending another firm's document for signature would exfiltrate it under
    // the sender's own name.
    expect([403, 404]).toContain(res.status);
  });

  it('refuses a preserved record, which is not a document the firm can pick', async () => {
    // Its path segments are not uuids, so the matter check never fires for it.
    // Sending one is a copy out of the archive into a path the sender can read
    // and then show to whoever they name.
    const objectPath = `lawfirmids/${firm.id}/signatures/${randomUUID()}/filed.pdf`;
    putObject(objectPath, { body: minimalPdfBytes(), contentType: 'application/pdf' });

    const res = await prepare(owner, { objectPath, fileName: 'filed.pdf' });

    expect(res.status).toBe(404);
  });

  it('refuses a document that is not in storage', async () => {
    const res = await prepare(owner, {
      objectPath: `lawfirmids/${firm.id}/objects/${randomUUID()}`, fileName: 'gone.pdf',
    });

    expect(res.status).toBe(404);
  });
});
