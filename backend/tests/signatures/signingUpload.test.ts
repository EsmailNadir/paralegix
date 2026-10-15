/**
 * Opening and finalizing a direct-to-storage upload of a PDF to be signed.
 *
 * `/signing/upload` buffers the file through the API, which Cloud Run caps at
 * 32 MiB per request whatever the route's own limit says. These two routes let
 * the browser PUT a PDF straight into `signing-uploads/{firm}/{id}/` on a
 * resumable session, the way the files module already works. The session is
 * stamped with who opened it, and finalize refuses an object the caller did
 * not upload, an object that is not a PDF, and a path outside the firm's own
 * transient prefix, because each of those is a way to get someone else's
 * document, or a non-document, in front of a signer.
 *
 * The rich bucket from the files specs provides `createResumableUpload`, the
 * ranged `download` the PDF sniff uses, and `delete`.
 */
import { objects, putObject } from '../support/inMemoryBucket';
import { minimalPdfBytes } from '../support/minimalPdf';
import {
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import {
  installRichBucket,
  resetRichBucket,
  resumableSessions,
  completeResumableUpload,
} from '../files/richBucket';

installRichBucket();

let firm: Firm;
let owner: Actor;
/** A member who may look at signing but not send anything for signature. */
let viewer: Actor;

const NOT_PDF_HEAD = Buffer.from('MZ\x90\x00\x03\x00');

/**
 * A real one-page PDF.
 *
 * Finalize now parses the document rather than sniffing its first four bytes,
 * so a header in front of filler is refused. That is the point of the boundary:
 * every route that can reach a signer runs the same structural check.
 */
const PDF = minimalPdfBytes();

/**
 * The cap the routes enforce, read from the source rather than restated here.
 *
 * Restating it meant the boundary cases pinned a number instead of the rule, so
 * lowering the cap to what the container can actually survive broke two tests
 * that were supposed to be about behaviour at the boundary, wherever it sits.
 */
const { SIGNING_MAX_FILE_BYTES: CAP } = require('../../src/modules/signatures/signing.validation');

const init = (actor: Actor, body: Record<string, unknown>) =>
  actor.api.post('/api/signing/upload-init').send({ lawFirmId: firm.id, ...body });

const finalize = (actor: Actor, objectPath: string) =>
  actor.api.post('/api/signing/upload-finalize').send({ lawFirmId: firm.id, objectPath });

/** Open a session as `owner` for a PDF and hand back what the route returned. */
async function openSession(name = 'Retainer Agreement.pdf', size = 5000) {
  const res = await init(owner, { name, size, contentType: 'application/pdf' });
  expect(res.status).toBe(200);
  return res.body as { objectPath: string; fileName: string; uploadUrl: string };
}

beforeEach(async () => {
  resetRichBucket();
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  viewer = await memberWith(firm.id, ['signatures.view']);
});

describe('opening the upload', () => {
  it('opens a session under the firm signing-uploads prefix, stamped with the uploader', async () => {
    const session = await openSession();

    expect(session.objectPath.startsWith(`signing-uploads/${firm.id}/`)).toBe(true);
    // The stored name is sanitised; the returned name is the one the user chose.
    expect(session.objectPath.endsWith('/Retainer_Agreement.pdf')).toBe(true);
    expect(session.fileName).toBe('Retainer Agreement.pdf');
    expect(typeof session.uploadUrl).toBe('string');

    // `uploadedBy` is the entire authorization model for this prefix: preview,
    // send, re-send and save-as-template all key on it. A session without the
    // stamp opens an object nobody can use.
    const opened = resumableSessions.get(session.objectPath);
    expect(opened?.contentType).toBe('application/pdf');
    expect(opened?.custom.uploadedBy).toBe(owner.uid);
    expect(opened?.custom.originalFileName).toBe('Retainer Agreement.pdf');
  });

  it('refuses a name that is not a PDF, opening nothing', async () => {
    const res = await init(owner, { name: 'draft.docx', size: 10, contentType: 'application/msword' });

    // Conversion needs the bytes on the server; that is what /signing/upload
    // is for. Opening a session for a DOCX here would store a DOCX under a path
    // every reader treats as a PDF.
    expect(res.status).toBe(400);
    expect(resumableSessions.size).toBe(0);
  });

  it('accepts a PDF whose name has no extension, and normalizes the stored name', async () => {
    // The browser routes by MIME type, so a scanner output named "scan" with
    // contentType application/pdf takes the direct route. Refusing it by NAME
    // meant that file could not be signed at all: the direct path rejected it
    // and the browser never fell back.
    const res = await init(owner, { name: 'scan', size: 5000, contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    // Stored with an extension so every downstream reader and download sees a
    // PDF, while the user keeps the name they chose.
    expect(res.body.objectPath.endsWith('/scan.pdf')).toBe(true);
    expect(res.body.fileName).toBe('scan.pdf');
    // The declared type is never trusted on its own: finalize still sniffs the
    // leading bytes, which is what actually decides.
    expect(resumableSessions.get(res.body.objectPath)?.contentType).toBe('application/pdf');
  });

  it('still refuses a non-PDF content type with no extension', async () => {
    const res = await init(owner, { name: 'scan', size: 10, contentType: 'application/msword' });

    expect(res.status).toBe(400);
    expect(resumableSessions.size).toBe(0);
  });

  it('refuses a file over the cap with a 413, opening nothing', async () => {
    const res = await init(owner, { name: 'huge.pdf', size: CAP + 1, contentType: 'application/pdf' });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
    expect(resumableSessions.size).toBe(0);
  });

  it('accepts a file exactly at the cap', async () => {
    const res = await init(owner, { name: 'big.pdf', size: CAP, contentType: 'application/pdf' });

    expect(res.status).toBe(200);
  });

  it('refuses a member without signatures.send', async () => {
    const res = await init(viewer, { name: 'a.pdf', size: 10, contentType: 'application/pdf' });

    expect(res.status).toBe(403);
    expect(resumableSessions.size).toBe(0);
  });

  it('refuses a request with no firm', async () => {
    const res = await owner.api.post('/api/signing/upload-init')
      .send({ name: 'a.pdf', size: 10, contentType: 'application/pdf' });

    expect(res.status).toBe(400);
  });
});

describe('converting a direct signing upload', () => {
  it('converts a DOCX from storage and never leaves its temporary source behind', async () => {
    const source = await owner.api.post('/api/signing/convert-upload-init').send({
      lawFirmId: firm.id,
      name: 'retainer.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 16,
    });
    expect(source.status).toBe(200);
    completeResumableUpload(source.body.objectPath, { body: Buffer.from('docx source bytes') });

    const outputPath = 'document-conversion/signing-test/output/result.pdf';
    putObject(outputPath, { body: PDF, contentType: 'application/pdf' });
    const signaturesService = require('../../src/modules/signatures/signatures.service');
    const convertSpy = jest.spyOn(signaturesService, 'convertStoredDocument').mockResolvedValue({
      objectPath: outputPath,
      size: PDF.length,
      contentType: 'application/pdf',
      generation: String(objects.get(outputPath)!.generation),
      cleanup: async () => { objects.delete(outputPath); },
    });

    try {
      const finalized = await owner.api.post('/api/signing/convert-upload-finalize').send({
        lawFirmId: firm.id,
        objectPath: source.body.objectPath,
        name: 'retainer.docx',
      });

      expect(finalized.status).toBe(200);
      expect(convertSpy).toHaveBeenCalledWith(expect.objectContaining({
        sourceObjectPath: source.body.objectPath,
        inputFilename: 'retainer.docx',
      }));
      expect(finalized.body.fileName).toBe('retainer.pdf');
      expect(finalized.body.objectPath).toMatch(new RegExp(`^signing-uploads/${firm.id}/`));
      expect(objects.get(finalized.body.objectPath)?.body).toEqual(PDF);
      expect(objects.get(finalized.body.objectPath)?.custom?.uploadedBy).toBe(owner.uid);
      expect(objects.has(source.body.objectPath)).toBe(false);
      expect(objects.has(outputPath)).toBe(false);

      // The uploader can immediately preview the converted document
      const preview = await owner.api.get(
        `/api/signing/preview-url?objectPath=${encodeURIComponent(finalized.body.objectPath)}&lawFirmId=${firm.id}`,
      );
      expect(preview.status).toBe(200);
      expect(preview.body.url).toBeDefined();
    } finally {
      convertSpy.mockRestore();
    }
  });
});

describe('finalizing the upload', () => {
  it('returns the path and the original name once a PDF has landed', async () => {
    const session = await openSession();
    completeResumableUpload(session.objectPath, { body: PDF });

    const res = await finalize(owner, session.objectPath);

    expect(res.status).toBe(200);
    expect(res.body.objectPath).toBe(session.objectPath);
    expect(res.body.fileName).toBe('Retainer Agreement.pdf');
    // The response now carries the admitted source, because nothing downstream
    // may act on the bytes without one.
    expect(res.body.status).toBe('ready');
    expect(typeof res.body.sourceId).toBe('string');
    expect(typeof res.body.generation).toBe('string');
    expect(objects.has(session.objectPath)).toBe(true);
  });

  it('names an unstamped object from a constant rather than from its path', async () => {
    // `originalFileName` is the record of the name the user chose. Without it
    // there is nothing authoritative left to read: the path's last segment is a
    // sanitised copy at best, and for every other upload destination in the app
    // it is an opaque uuid. So the response says `document.pdf` instead of
    // dressing a storage path up as the user's own file name.
    const objectPath = `signing-uploads/${firm.id}/${'a'.repeat(24)}/Retainer_Agreement.pdf`;
    putObject(objectPath, {
      body: PDF, contentType: 'application/pdf', custom: { uploadedBy: owner.uid },
    });

    const res = await finalize(owner, objectPath);

    expect(res.status).toBe(200);
    expect(res.body.fileName).toBe('document.pdf');
  });

  it('answers 202 and a job id for a source too large to hash while someone waits', async () => {
    // Hashing a multi-gigabyte document behind an interactive request means the
    // request times out, the caller sees a failure, and the work carries on
    // invisibly until the instance is killed. The client polls instead.
    const { SIGNING_INLINE_PREPARE_BYTES } = require('../../src/modules/signatures/signing.validation');
    const session = await openSession('big.pdf', CAP);
    completeResumableUpload(session.objectPath, {
      body: minimalPdfBytes({ fillerBytes: SIGNING_INLINE_PREPARE_BYTES + 1024 }),
    });

    const res = await finalize(owner, session.objectPath);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending');
    expect(typeof res.body.jobId).toBe('string');
    // Nothing was hashed, so nothing claims to be prepared.
    expect(res.body.generation).toBeNull();
  });

  it('refuses an object somebody else uploaded', async () => {
    const session = await openSession();
    completeResumableUpload(session.objectPath, {
      body: PDF, custom: { uploadedBy: 'someone-else' },
    });

    const res = await finalize(owner, session.objectPath);

    // Adopting a colleague's upload would let a signatures.send holder put a
    // document they never had in front of a signer under their own name.
    expect(res.status).toBe(403);
  });

  it('refuses and DELETES bytes that are not a PDF', async () => {
    const session = await openSession();
    completeResumableUpload(session.objectPath, { body: NOT_PDF_HEAD });

    const res = await finalize(owner, session.objectPath);

    // The path says .pdf and every viewer downstream trusts that. Leaving the
    // object in place would dead-end the send flow with an unrenderable file.
    expect(res.status).toBe(400);
    expect(objects.has(session.objectPath)).toBe(false);
  });

  it('refuses and deletes an object that landed over the cap', async () => {
    const session = await openSession('big.pdf', CAP);
    // Declared at the cap, landed past it: the session URL has no ceiling of
    // its own. The object's SIZE is what finalize reads, from storage metadata,
    // so the body stays small: building a real file one byte over a 500 MB cap
    // would allocate half a gigabyte per worker to prove a comparison.
    completeResumableUpload(session.objectPath, {
      body: minimalPdfBytes(),
      sizeOverride: CAP + 1,
    });

    const res = await finalize(owner, session.objectPath);

    expect(res.status).toBe(413);
    expect(objects.has(session.objectPath)).toBe(false);
  });

  it('answers 404 when nothing landed', async () => {
    const session = await openSession();

    const res = await finalize(owner, session.objectPath);

    expect(res.status).toBe(404);
  });

  it('refuses a path outside the firm signing-uploads prefix, even one that exists', async () => {
    const elsewhere = `lawfirmids/${firm.id}/objects/8d4f2a10-0000-4000-8000-000000000001`;
    putObject(elsewhere, { bytes: 10, contentType: 'application/pdf', custom: { uploadedBy: owner.uid } });

    const res = await finalize(owner, elsewhere);

    // This route only ever vouches for the transient prefix. A firm document
    // reaches signing through /signature-links/prepare, which checks matter
    // membership; this route does not, and must not be a way around it.
    expect(res.status).toBe(404);
    expect(objects.has(elsewhere)).toBe(true);
  });

  it('refuses another firm prefix', async () => {
    const otherFirm = await createFirm({ name: 'Rival LLP' });
    const path = `signing-uploads/${otherFirm.id}/abc/a.pdf`;
    putObject(path, { bytes: 10, contentType: 'application/pdf', custom: { uploadedBy: owner.uid } });

    const res = await finalize(owner, path);

    expect(res.status).toBe(404);
  });

  it('refuses a member without signatures.send', async () => {
    const session = await openSession();
    completeResumableUpload(session.objectPath, { body: PDF });

    const res = await finalize(viewer, session.objectPath);

    expect(res.status).toBe(403);
  });
});
