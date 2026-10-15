/**
 * The general document conversion endpoint, with the bytes out of the API.
 *
 * It took a file as multipart, converted it, and sent the result as the
 * response body, so BOTH directions passed through a 512 MiB container that
 * serves eighty concurrent requests. A 100 MB input and its output were
 * resident at once, per caller.
 *
 * Now the browser PUTs to storage, the worker converts from storage to storage,
 * and the browser fetches the result from a signed url. Both callers still end
 * up with the bytes, which they need, but the API holds neither side.
 *
 * The scratch objects are the part worth guarding. This route's input is
 * temporary, unlike every other upload in the app, so:
 *
 *   The input path must be confined to the caller's own scratch prefix. Taken
 *   from the request unchecked, it converts and hands back any object in the
 *   bucket, which is a way to read another firm's documents.
 *
 *   The input must be cleaned up afterwards, or every conversion leaves a
 *   billed copy of the source behind.
 */
import { randomUUID } from 'crypto';

import { createFirm, ownerOf, request, type Actor, type Firm } from '../support/setupInProcess';
import {
  installInMemoryBucket, objects, landUpload, pathsUnder, putObject, signedUrlCalls,
} from '../support/inMemoryBucket';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;
let outsider: Actor;

const INIT = '/api/signatures/convert/upload-init';
const RUN = '/api/signatures/convert/run';

const init = (actor: Actor, body: Record<string, unknown> = {}) =>
  actor.api.post(INIT).send({ fileName: 'contract.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 4096, ...body });

const run = (actor: Actor, body: Record<string, unknown>) => actor.api.post(RUN).send(body);

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Convert LLP' });
  owner = await ownerOf(firm.id);
  const other = await createFirm({ name: 'Other LLP' });
  outsider = await ownerOf(other.id);
});

describe('opening the upload', () => {
  it('hands back a session and a scratch object path', async () => {
    const res = await init(owner);

    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toBeTruthy();
    expect(res.body.objectPath).toContain('document-conversion/');
  });

  it('creates nothing until the browser uploads', async () => {
    await init(owner);

    expect(pathsUnder('document-conversion/')).toEqual([]);
  });

  it('refuses a dangerous extension the scratch path does not carry', async () => {
    // The scratch object is named `source`, with no extension of its own, so
    // the deny-list has nothing to read unless the name the CALLER chose
    // reaches it. A convertible content type is enough to pass the format gate
    // in front of this, which is exactly how an executable would arrive.
    const res = await init(owner, {
      fileName: 'payload.exe',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    expect(res.status).toBe(415);
    expect(res.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect(pathsUnder('document-conversion/')).toEqual([]);
  });

  it('refuses an anonymous caller', async () => {
    const res = await request().post(INIT).send({ fileName: 'x.docx', contentType: 'application/msword', size: 10 });

    expect(res.status).toBe(401);
  });

  it('scopes the scratch path to the caller, not to a name they chose', async () => {
    // Two callers converting `contract.docx` must not share a path, or one
    // overwrites the other's input mid-conversion.
    const mine = await init(owner);
    const theirs = await init(outsider);

    expect(mine.body.objectPath).not.toBe(theirs.body.objectPath);
  });
});

describe('running the conversion', () => {
  it('refuses an object path outside the conversion scratch area', async () => {
    // The path is echoed back by the client. Unchecked, this converts and hands
    // back a signed url for any object in the bucket.
    landUpload('lawfirmids/other/objects/secret.pdf', { bytes: 10, contentType: 'application/pdf' });

    const res = await run(owner, {
      objectPath: 'lawfirmids/other/objects/secret.pdf',
      format: 'pdf',
      fileName: 'secret.pdf',
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.signedUrl).toBeUndefined();
  });

  it('refuses another caller scratch path', async () => {
    const theirs = await init(outsider);
    landUpload(theirs.body.objectPath, { bytes: 10, contentType: 'application/pdf' });

    const res = await run(owner, { objectPath: theirs.body.objectPath, format: 'pdf', fileName: 'x.docx' });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses an upload that never landed', async () => {
    const opened = await init(owner);

    const res = await run(owner, { objectPath: opened.body.objectPath, format: 'pdf', fileName: 'contract.docx' });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

/**
 * A worker-shaped conversion: it writes its result to storage and hands back a
 * REFERENCE. Stubbed because the local adapter needs a real soffice binary, and
 * what these cases are about is the link the route mints from the result, not
 * the conversion itself.
 */
let conversionStub: jest.SpyInstance | null = null;

function stubConversion(output = Buffer.from('%PDF-1.4 converted output')) {
  const converter = require('../../src/shared/documentConversion/converter');
  conversionStub = jest.spyOn(converter, 'convertStoredDocumentOrDownload').mockImplementation(async () => {
    const outputPath = `document-conversion/${randomUUID()}/output/result.pdf`;
    putObject(outputPath, { body: output, contentType: 'application/pdf' });
    return {
      objectPath: outputPath,
      size: output.length,
      contentType: 'application/pdf',
      generation: objects.get(outputPath)!.generation,
      cleanup: async () => { objects.delete(outputPath); },
    };
  });
}

// This one spy, not `restoreAllMocks`: the in-memory bucket is itself installed
// as a spy at module scope, and restoring everything takes it away too, leaving
// every later case in this file talking to the inert storage double.
afterEach(() => {
  conversionStub?.mockRestore();
  conversionStub = null;
});

/** The signed-url call the route made, with the config it was minted under. */
const lastSigned = () => signedUrlCalls[signedUrlCalls.length - 1];

const convert = async (fileName = 'contract.docx') => {
  const opened = await init(owner, { fileName });
  landUpload(opened.body.objectPath, { bytes: 4096, contentType: 'application/pdf' });
  return run(owner, { objectPath: opened.body.objectPath, format: 'pdf', fileName });
};

describe('what it answers with', () => {
  it('never sends the converted document as the body', async () => {
    // Both directions used to pass through this process. A binary body here is
    // the output resident in the container on every conversion.
    const opened = await init(owner);
    landUpload(opened.body.objectPath, { bytes: 4096, contentType: 'application/pdf' });

    const res = await run(owner, { objectPath: opened.body.objectPath, format: 'pdf', fileName: 'contract.docx' });

    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('hands back a link that SAVES the document, under the name the caller sent', async () => {
    stubConversion();

    const res = await convert('contract.docx');

    expect(res.status).toBe(200);
    // `attachment`, which is what the multipart route's own Content-Disposition
    // said. The files module's `signObject` answers `inline` for a PDF, because
    // it decides disposition for a preview, so signing through it turned a
    // download into a tab that opens: a change no status code shows.
    expect(lastSigned().config.responseDisposition)
      .toBe('attachment; filename="contract.pdf"');
    expect(res.body.fileName).toBe('contract.pdf');
  });

  it('will not let the echoed name split the disposition', async () => {
    stubConversion();

    await convert('a".docx');

    // The name comes back from the request, and the storage provider builds a
    // header out of it.
    expect(lastSigned().config.responseDisposition)
      .toBe('attachment; filename="a_.pdf"');
  });

  it('pins the link to the version of the output it converted', async () => {
    stubConversion();

    const res = await convert();

    const outputPath = lastSigned().path;
    expect(lastSigned().generation).toBe(objects.get(outputPath)!.generation);
    expect(res.body.signedUrl).toContain(`generation=${res.body.generation}`);
  });

  it('gives the link minutes, not hours', async () => {
    stubConversion();

    await convert();
    const answeredAt = Date.now();

    // Nothing revokes a signed url already handed out, so its lifetime is the
    // whole of its revocation story. An hour was what signing through the files
    // module's attachment TTL gave it.
    const expires = Number(lastSigned().config.expires);
    expect(expires).toBeLessThanOrEqual(answeredAt + 15 * 60 * 1000);
    expect(expires).toBeGreaterThan(answeredAt + 60 * 1000);
  });

  it('signs NOTHING for an upload outside the caller scratch prefix', async () => {
    stubConversion();
    landUpload('lawfirmids/other/objects/secret.pdf', { bytes: 10, contentType: 'application/pdf' });
    signedUrlCalls.length = 0;

    const res = await run(owner, {
      objectPath: 'lawfirmids/other/objects/secret.pdf',
      format: 'pdf',
      fileName: 'secret.pdf',
    });

    // A url minted before the path is confined is a read credential for any
    // object in the bucket, and the refusal status hides that it was issued.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(signedUrlCalls).toHaveLength(0);
  });
});
