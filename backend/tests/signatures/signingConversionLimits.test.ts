/**
 * How large a Word (or other non-PDF) document can be converted, and what the
 * person is told when theirs is too large.
 *
 * THE CAP FOLLOWS WHERE CONVERSION RUNS. On the document worker the API never
 * holds the file, and a 92 MB image-heavy DOCX converted there in 4.2 s at 564
 * of its 1024 MiB, so signing takes the converter's own 100 MB. Converted in
 * the API process instead (`DOCUMENT_CONVERTER` not `worker`), the local
 * adapter reads the whole file into a 512 MiB container serving eighty
 * requests, so signing stays at 25 MB there.
 *
 * THE REFUSAL SAYS WHY. "That file is larger than the 25 MB limit for this
 * upload" read as a limit on signing itself, while the same document saved as a
 * PDF is accepted up to 500 MB. The message now names the conversion as the
 * reason and says what to do instead.
 */
import { randomUUID } from 'crypto';
import { objects, putObject } from '../support/inMemoryBucket';
import { minimalPdfBytes } from '../support/minimalPdf';
import {
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import {
  installRichBucket,
  resetRichBucket,
  resumableSessions,
  completeResumableUpload,
  bytesRead,
} from '../files/richBucket';

installRichBucket();

const MB = 1024 * 1024;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const originalConverter = process.env.DOCUMENT_CONVERTER;
const signaturesService = require('../../src/modules/signatures/signatures.service');

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  resetRichBucket();
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

/** Spies this spec installed, restored one by one: `jest.restoreAllMocks()`
 *  would also undo the storage double `installRichBucket()` put in place. */
const spies: jest.SpyInstance[] = [];
const originalFetch = global.fetch;

afterEach(() => {
  if (originalConverter === undefined) delete process.env.DOCUMENT_CONVERTER;
  else process.env.DOCUMENT_CONVERTER = originalConverter;
  delete process.env.DOCUMENT_WORKER_URL;
  delete process.env.DOCUMENT_WORKER_ID_TOKEN;
  global.fetch = originalFetch;
  while (spies.length) spies.pop()!.mockRestore();
});

const openSigningConversion = (size: number) => owner.api.post('/api/signing/convert-upload-init')
  .send({ lawFirmId: firm.id, name: 'Brief.docx', contentType: DOCX, size });

/** The converter, answering with a real PDF, so a route that reaches it completes. */
function stubConverter() {
  const outputPath = `document-conversion/${randomUUID()}/output/result.pdf`;
  const pdf = minimalPdfBytes();
  putObject(outputPath, { body: pdf, contentType: 'application/pdf' });
  const spy = jest.spyOn(signaturesService, 'convertStoredDocument').mockResolvedValue({
    objectPath: outputPath,
    size: pdf.length,
    contentType: 'application/pdf',
    generation: String(objects.get(outputPath)!.generation),
    cleanup: async () => { objects.delete(outputPath); },
  });
  spies.push(spy);
  return spy;
}

/**
 * The document worker, faked at the network. It records the command the API
 * sent and writes a real PDF where the command says, as the worker does.
 */
function fakeWorker() {
  const commands: any[] = [];
  process.env.DOCUMENT_WORKER_URL = 'https://worker.test';
  process.env.DOCUMENT_WORKER_ID_TOKEN = 'worker-test-token';
  global.fetch = jest.fn(async (_url: string, init: any = {}) => {
    const command = JSON.parse(init.body);
    commands.push(command);
    const outputPath = decodeURIComponent(String(command.outputUrl).replace(/^https:\/\/signed\.test\//, '').split('?')[0]);
    putObject(outputPath, { body: minimalPdfBytes(), contentType: 'application/pdf' });
    return new Response('{}', { status: 200 });
  }) as never;
  return commands;
}

describe('a Word document uploaded to be signed', () => {
  it('is accepted up to 100 MB when the document worker converts it', async () => {
    process.env.DOCUMENT_CONVERTER = 'worker';

    const res = await openSigningConversion(90 * MB);

    expect(res.status).toBe(200);
    expect(resumableSessions.size).toBe(1);
  });

  it('is refused above 100 MB with a message that names the conversion and the PDF alternative', async () => {
    process.env.DOCUMENT_CONVERTER = 'worker';

    const res = await openSigningConversion(101 * MB);

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
    expect(res.body.error).toBe(
      'This file is 101 MB. Word and other documents are converted to PDF before signing, which works up to 100 MB. Save it as a PDF to send files up to 500 MB.',
    );
    expect(resumableSessions.size).toBe(0);
  });

  it('stays at 25 MB when conversion runs inside the API', async () => {
    process.env.DOCUMENT_CONVERTER = 'local';

    const res = await openSigningConversion(26 * MB);

    expect(res.status).toBe(413);
    expect(res.body.error).toBe(
      'This file is 26 MB. Word and other documents are converted to PDF before signing, which works up to 25 MB. Save it as a PDF to send files up to 500 MB.',
    );
  });

  it('is measured again once it lands, with the same message', async () => {
    // The declared size is the browser's word. The stored object is the truth.
    process.env.DOCUMENT_CONVERTER = 'worker';
    const opened = await openSigningConversion(10 * MB);
    completeResumableUpload(opened.body.objectPath, { bytes: 101 * MB });
    const convert = stubConverter();

    const res = await owner.api.post('/api/signing/convert-upload-finalize')
      .send({ lawFirmId: firm.id, objectPath: opened.body.objectPath, name: 'Brief.docx' });

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/^This file is 101 MB\. Word and other documents are converted to PDF before signing/);
    expect(convert).not.toHaveBeenCalled();
  });
});

describe('a firm Word document sent for signing from the file manager', () => {
  const firmDocx = (bytes: number) => {
    const objectPath = `lawfirmids/${firm.id}/objects/${randomUUID()}`;
    putObject(objectPath, { bytes, contentType: DOCX });
    return objectPath;
  };
  const prepare = (objectPath: string) => owner.api.post(`/api/lawfirms/${firm.id}/signature-links/prepare`)
    .send({ objectPath, fileName: 'Brief.docx' });

  it('is converted on the worker under a 100 MB cap', async () => {
    process.env.DOCUMENT_CONVERTER = 'worker';
    const commands = fakeWorker();

    const res = await prepare(firmDocx(60 * MB));

    expect(res.status).toBe(200);
    expect(commands).toHaveLength(1);
    expect(commands[0].maxBytes).toBe(100 * MB);
  });

  it('is refused above the cap with the same explanation, before any of it is read', async () => {
    // A firm document can be any size its plan allows. Converting it for
    // signing is capped at 25 MiB, the same cap a direct signing upload meets,
    // and the refusal has to come before the bytes are read. Real bytes are
    // stored so a read would have something to hand out.
    process.env.DOCUMENT_CONVERTER = 'local';
    const objectPath = `lawfirmids/${firm.id}/objects/${randomUUID()}`;
    putObject(objectPath, { body: Buffer.alloc(30 * MB, 0x50), contentType: DOCX });

    const res = await prepare(objectPath);

    expect(res.status).toBe(413);
    expect(bytesRead()).toBe(0);
    expect(res.body.code).toBe('SIGNING_CONVERSION_TOO_LARGE');
    expect(res.body.error).toBe(
      'This file is 30 MB. Word and other documents are converted to PDF before signing, which works up to 25 MB. Save it as a PDF to send files up to 500 MB.',
    );
  });
});

describe('a document uploaded for conversion to another format', () => {
  it('is refused above 100 MB with a message that says the limit is the conversion', async () => {
    const res = await owner.api.post('/api/signatures/convert/upload-init')
      .send({ fileName: 'Exhibits.docx', contentType: DOCX, size: 101 * MB });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
    expect(res.body.error).toBe('This file is 101 MB. Documents can be converted up to 100 MB.');
  });
});
