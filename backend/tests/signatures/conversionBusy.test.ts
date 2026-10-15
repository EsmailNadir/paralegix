/**
 * What a caller is told when the document converter is saturated.
 *
 * Every conversion on an instance goes through one limiter
 * (`signatures.service.ts`, limits in `conversionLimits.ts`) with a queue deadline.
 * Under a staging load test the deadline fired and the caller got a generic
 * 500 INTERNAL_ERROR: the limiter's timeout carries no status, so the error
 * handler treated a full queue as a crash. It is a busy server, and the client
 * should be told so, and when to come back.
 *
 * The signing upload has a second half to the same problem. Its handler
 * deleted the temporary source in a `finally`, so a request refused for being
 * busy also destroyed the upload the retry needs. The person then had to pick
 * the file again, and the retry the 503 invites could not succeed.
 *
 * The queue deadline is shortened through its own env var, set before the app
 * loads, so the refusal arrives in milliseconds rather than 45 seconds.
 */
import type { Actor, Firm } from '../support/setupInProcess';

process.env.DOC_CONVERT_QUEUE_TIMEOUT_MS = '150';

// Required, not imported, so the env above lands before the app loads.
const { createFirm, ownerOf } = require('../support/setupInProcess');
const { objects, putObject } = require('../support/inMemoryBucket');
const { minimalPdfBytes } = require('../support/minimalPdf');
const { installRichBucket, resetRichBucket, completeResumableUpload } = require('../files/richBucket');

installRichBucket();

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let firm: Firm;
let owner: Actor;
let adapterSpy: jest.SpyInstance | null = null;

beforeEach(async () => {
  resetRichBucket();
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

afterEach(() => {
  adapterSpy?.mockRestore();
  adapterSpy = null;
});

/** A converter result written to storage, the shape the worker adapter returns. */
function convertedPdf() {
  const outputPath = `document-conversion/${Math.random().toString(36).slice(2)}/output/result.pdf`;
  const pdf = minimalPdfBytes();
  putObject(outputPath, { body: pdf, contentType: 'application/pdf' });
  return {
    objectPath: outputPath,
    size: pdf.length,
    contentType: 'application/pdf',
    generation: String(objects.get(outputPath)!.generation),
    cleanup: async () => { objects.delete(outputPath); },
  };
}

/**
 * Occupy the instance's only conversion slot until `release` is called. The
 * holder goes through the real limiter, the same one the route uses.
 */
function holdConversionSlot() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const converter = require('../../src/shared/documentConversion/converter');
  adapterSpy = jest.spyOn(converter, 'convertStoredDocumentOrDownload')
    .mockImplementationOnce(async () => { await gate; return convertedPdf(); })
    .mockImplementation(async () => convertedPdf());
  const signaturesService = require('../../src/modules/signatures/signatures.service');
  const holder = signaturesService.convertStoredDocument({ sourceObjectPath: 'held', outputFormat: 'pdf' });
  return { release, holder };
}

async function uploadedDocx() {
  const opened = await owner.api.post('/api/signing/convert-upload-init')
    .send({ lawFirmId: firm.id, name: 'Brief.docx', contentType: DOCX, size: 64 });
  expect(opened.status).toBe(200);
  completeResumableUpload(opened.body.objectPath, { body: Buffer.from('docx source bytes') });
  return opened.body.objectPath as string;
}

const finalize = (objectPath: string) => owner.api.post('/api/signing/convert-upload-finalize')
  .send({ lawFirmId: firm.id, objectPath, name: 'Brief.docx' });

describe('a signing conversion that cannot get a converter slot', () => {
  it('is refused with 503 CONVERSION_BUSY and a Retry-After, not a 500', async () => {
    const sourcePath = await uploadedDocx();
    const { release, holder } = holdConversionSlot();

    const res = await finalize(sourcePath);
    release();
    await holder;

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('CONVERSION_BUSY');
    expect(res.body.error).toMatch(/try again/i);
    expect(res.headers['retry-after']).toBe('5');
    // The adapter was reached once, by the holder: the refused request never converted.
    expect(adapterSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps the uploaded source, so retrying the same finalize converts it', async () => {
    const sourcePath = await uploadedDocx();
    const { release, holder } = holdConversionSlot();

    const refused = await finalize(sourcePath);
    release();
    await holder;
    expect(refused.status).toBe(503);
    expect(objects.has(sourcePath)).toBe(true);

    const retried = await finalize(sourcePath);

    expect(retried.status).toBe(200);
    expect(retried.body.fileName).toBe('Brief.pdf');
    expect(objects.has(retried.body.objectPath)).toBe(true);
    // Once it has been converted the source is scratch again, and goes.
    expect(objects.has(sourcePath)).toBe(false);
  });

  it('still deletes the source when the conversion itself fails', async () => {
    // Only a busy refusal is worth keeping the upload for. A converter that
    // ran and failed will fail the same way again.
    const sourcePath = await uploadedDocx();
    const converter = require('../../src/shared/documentConversion/converter');
    adapterSpy = jest.spyOn(converter, 'convertStoredDocumentOrDownload')
      .mockRejectedValue(new Error('soffice exited 1'));

    const res = await finalize(sourcePath);

    expect(res.status).toBe(500);
    expect(adapterSpy).toHaveBeenCalledTimes(1);
    expect(objects.has(sourcePath)).toBe(false);
  });
});

/**
 * The general conversion route, `POST /api/signatures/convert/run`, has the
 * same shape: its input is a scratch upload deleted when the request ends. The
 * frontend retries a busy 503 there too, so a refusal that deleted the input
 * guaranteed the retry failed on a missing upload.
 */
describe('a general conversion that cannot get a converter slot', () => {
  const DOCX_TYPE = DOCX;

  async function uploadedConvertSource() {
    const opened = await owner.api.post('/api/signatures/convert/upload-init')
      .send({ fileName: 'contract.docx', contentType: DOCX_TYPE, size: 64 });
    expect(opened.status).toBe(200);
    putObject(opened.body.objectPath, { body: Buffer.from('docx source bytes'), contentType: DOCX_TYPE });
    return opened.body.objectPath as string;
  }

  const runConversion = (objectPath: string) => owner.api.post('/api/signatures/convert/run')
    .send({ objectPath, format: 'pdf', fileName: 'contract.docx' });

  it('is refused with 503 CONVERSION_BUSY and a Retry-After, and keeps the source', async () => {
    const sourcePath = await uploadedConvertSource();
    const { release, holder } = holdConversionSlot();

    const res = await runConversion(sourcePath);
    release();
    await holder;

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('CONVERSION_BUSY');
    expect(res.headers['retry-after']).toBe('5');
    expect(adapterSpy).toHaveBeenCalledTimes(1);
    expect(objects.has(sourcePath)).toBe(true);
  });

  it('converts on the retry the 503 invites, then deletes the source', async () => {
    const sourcePath = await uploadedConvertSource();
    const { release, holder } = holdConversionSlot();

    const refused = await runConversion(sourcePath);
    release();
    await holder;
    expect(refused.status).toBe(503);
    // The real converter reads the source from storage; so does this one, so a
    // refusal that deleted it fails the retry here as it would in production.
    adapterSpy!.mockImplementation(async (input: any) => {
      if (!objects.has(input.sourceObjectPath)) throw new Error('No such object');
      return convertedPdf();
    });

    const retried = await runConversion(sourcePath);

    expect(retried.status).toBe(200);
    expect(retried.body.fileName).toBe('contract.pdf');
    expect(retried.body.signedUrl).toBeTruthy();
    expect(objects.has(sourcePath)).toBe(false);
  });

  it('still deletes the source when the conversion itself fails', async () => {
    const sourcePath = await uploadedConvertSource();
    const converter = require('../../src/shared/documentConversion/converter');
    adapterSpy = jest.spyOn(converter, 'convertStoredDocumentOrDownload')
      .mockRejectedValue(new Error('soffice exited 1'));

    const res = await runConversion(sourcePath);

    expect(res.status).toBe(500);
    expect(adapterSpy).toHaveBeenCalledTimes(1);
    expect(objects.has(sourcePath)).toBe(false);
  });
});
