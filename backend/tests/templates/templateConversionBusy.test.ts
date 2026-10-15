/**
 * DOCX template preview and overlay upload, the two template routes that convert
 * a stored document, when the converter or the render slot is saturated.
 *
 * Both used to wrap EVERY converter error in a 502 "could not convert", so a
 * converter that was merely busy read as a broken document. A busy refusal is
 * `503` with a `Retry-After`, as it is on every other route: the same request
 * works once the queue drains. A conversion that ran and failed is still the
 * route's own 502.
 *
 * The preview also held its fill slot across the conversion wait. On the
 * worker it holds no document while it converts, so the slot is not taken at
 * all, and the worker reads the stored DOCX where it sits. In local mode the
 * DOCX is converted in this process, so the slot is held as a fill holds it.
 *
 * Both queue deadlines are shortened through their env vars, set before the
 * app loads: the fill slot's well below the converter's, so a render stuck
 * behind the slot is refused while the conversions in front of it still wait.
 */
import { randomUUID } from 'crypto';
import type { Actor, Firm } from '../support/setupInProcess';

process.env.TEMPLATE_FILL_QUEUE_TIMEOUT_MS = '200';
process.env.DOC_CONVERT_QUEUE_TIMEOUT_MS = '1500';

// Required, not imported, so the env above lands before the app loads.
const PizZip = require('pizzip');
const { PDFDocument } = require('pdf-lib');
const { testPool, createFirm, ownerOf, memberWith } = require('../support/setupInProcess');
const { objects, putObject } = require('../support/inMemoryBucket');
const {
  installRichBucket, completeResumableUpload, bytesRead, resetBytesRead,
} = require('../files/richBucket');

installRichBucket();

const WORKER = 'https://worker.test';
const T = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/templates`;
const pathOf = (url: string) =>
  decodeURIComponent(String(url).replace(/^https:\/\/signed\.test\//, '').split('?')[0]);
const WORKER_OUTPUT = Buffer.from('%PDF-1.7 converted by the worker');
const LOCAL_OUTPUT = Buffer.from('%PDF-1.7 converted in process');
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const originalFetch = global.fetch;
const originalConverter = process.env.DOCUMENT_CONVERTER;

/** What each conversion was given, worker or local, in arrival order. */
let converterInputs: Buffer[] = [];
/** While set, every conversion waits for it. */
let held: Promise<void> | null = null;
/** While set, every conversion fails with it, after being counted. */
let failWith: Error | null = null;
let localSpy: jest.SpyInstance;
let onePagePdf: Buffer;

let firm: Firm;
let owner: Actor;

beforeAll(async () => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  onePagePdf = Buffer.from(await doc.save());
});

beforeEach(async () => {
  objects.clear();
  resetBytesRead();
  converterInputs = [];
  held = null;
  failWith = null;
  delete process.env.DOCUMENT_CONVERTER;
  process.env.DOCUMENT_WORKER_URL = WORKER;
  process.env.DOCUMENT_WORKER_ID_TOKEN = 'worker-test-token';
  global.fetch = jest.fn(async (url: string, init: any = {}) => {
    if (!String(url).startsWith(`${WORKER}/`)) throw new Error(`Unexpected fetch in test: ${url}`);
    const command = JSON.parse(init.body);
    converterInputs.push(objects.get(pathOf(command.sourceUrl))!.body);
    if (held) await held;
    if (failWith) return new Response(JSON.stringify({ error: failWith.message }), { status: 500 });
    putObject(pathOf(command.outputUrl), { body: WORKER_OUTPUT, contentType: 'application/pdf' });
    return new Response('{}', { status: 200 });
  }) as never;
  const localConverter = require('../../src/shared/documentConversion/localConverter');
  localSpy = jest.spyOn(localConverter, 'convertLocally').mockImplementation(async (input: any) => {
    converterInputs.push(input);
    if (held) await held;
    if (failWith) throw failWith;
    return LOCAL_OUTPUT;
  });

  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

afterEach(() => {
  global.fetch = originalFetch;
  localSpy.mockRestore();
  if (originalConverter === undefined) delete process.env.DOCUMENT_CONVERTER;
  else process.env.DOCUMENT_CONVERTER = originalConverter;
  delete process.env.DOCUMENT_WORKER_URL;
  delete process.env.DOCUMENT_WORKER_ID_TOKEN;
});

const useWorker = () => { process.env.DOCUMENT_CONVERTER = 'worker'; };

function buildDocx(text: string): Buffer {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`);
  return zip.generate({ type: 'nodebuffer' });
}

const documentXmlOf = (docx: Buffer) => new PizZip(docx).files['word/document.xml'].asText();

async function docxTemplate(lawFirmId: string) {
  const templateId = randomUUID();
  const docxPath = `lawfirmids/${lawFirmId}/templates/${templateId}.docx`;
  putObject(docxPath, { body: buildDocx('Dear {client_name},'), contentType: 'application/msword' });
  await testPool.query(
    `insert into templates (id, law_firm_id, name, type, docx_object_path)
     values ($1, $2, 'Engagement Letter', 'docx', $3)`,
    [templateId, lawFirmId, docxPath],
  );
  return { templateId, docxPath };
}

/** An overlay template, which fills with pdf-lib in this process and needs no conversion. */
async function overlayTemplate(lawFirmId: string) {
  const templateId = randomUUID();
  const pdfPath = `lawfirmids/${lawFirmId}/templates/${templateId}/overlay.pdf`;
  putObject(pdfPath, { body: onePagePdf, contentType: 'application/pdf' });
  await testPool.query(
    `insert into templates (id, law_firm_id, name, type, overlay_pdf_object_path, overlay_source_object_path)
     values ($1, $2, 'Court Form', 'overlay', $3, $3)`,
    [templateId, lawFirmId, pdfPath],
  );
  return templateId;
}

const preview = (actor: Actor, templateId: string) =>
  actor.api.get(`${T(firm.id)}/${templateId}/preview`);
const fillOverlay = (actor: Actor, templateId: string) =>
  actor.api.post(`${T(firm.id)}/${templateId}/fill`).send({ values: {}, format: 'pdf' });

/** Wait until the converter has been asked for `n` conversions. */
async function converterReached(n: number) {
  for (let i = 0; i < 300 && converterInputs.length < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  expect(converterInputs.length).toBe(n);
}

const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Hold the converter with `first` running, then answer what `then` returns
 * while it is still held. Releases however `then` ends.
 */
async function whileConverterHeld<T>(first: () => Promise<any>, then: () => Promise<T>) {
  let release!: () => void;
  held = new Promise<void>((resolve) => { release = resolve; });
  // `.then` is what sends a supertest request; it is lazy until then.
  const running = first().then((r: any) => r);
  try {
    await converterReached(1);
    return { result: await then(), running };
  } finally {
    release();
    await running;
  }
}

describe('a DOCX preview converted in this process (DOCUMENT_CONVERTER unset)', () => {
  it('is refused as 503 CONVERSION_BUSY with a Retry-After when the converter stays full', async () => {
    const { templateId } = await docxTemplate(firm.id);
    const second = await memberWith(firm.id, ['templates.view']);

    const { result: refused } = await whileConverterHeld(
      () => preview(owner, templateId),
      () => preview(second, templateId),
    );

    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('CONVERSION_BUSY');
    expect(refused.headers['retry-after']).toBe('5');
    expect(converterInputs).toHaveLength(1);
  });

  it('is refused as 503 TEMPLATE_FILL_BUSY with a Retry-After when every render slot is taken', async () => {
    const { templateId } = await docxTemplate(firm.id);
    const second = await memberWith(firm.id, ['templates.view']);
    const third = await memberWith(firm.id, ['templates.view']);

    let queued: Promise<any> = Promise.resolve(null);
    const { result: refused } = await whileConverterHeld(
      () => preview(owner, templateId),
      async () => {
        queued = preview(second, templateId).then((r: any) => r);
        await pause(100);
        return preview(third, templateId);
      },
    );
    await queued;

    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('TEMPLATE_FILL_BUSY');
    expect(refused.headers['retry-after']).toBe('5');
  });

  it('still answers 502 when the conversion itself fails', async () => {
    const { templateId } = await docxTemplate(firm.id);
    failWith = new Error('soffice exited 1');

    const res = await preview(owner, templateId);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('TEMPLATE_PREVIEW_CONVERSION_FAILED');
    expect(converterInputs).toHaveLength(1);
  });
});

describe('a DOCX preview converted on the worker', () => {
  beforeEach(useWorker);

  it('converts the stored DOCX where it sits and publishes what the worker produced', async () => {
    const { templateId } = await docxTemplate(firm.id);

    const res = await preview(owner, templateId);

    expect(res.status).toBe(200);
    expect(converterInputs).toHaveLength(1);
    expect(documentXmlOf(converterInputs[0])).toContain('Dear {client_name},');
    const renderPath = pathOf(res.body.previewUrl);
    expect(renderPath).toContain('/template-renders/');
    expect(objects.get(renderPath)!.body).toEqual(WORKER_OUTPUT);
    expect(objects.get(renderPath)!.contentType).toBe('application/pdf');
    expect(res.body.fileName).toBe('Engagement Letter.pdf');
    // The worker read it by URL; this process downloaded nothing at all.
    expect(bytesRead()).toBe(0);
    expect([...objects.keys()].filter((p: string) => p.startsWith('document-conversion/'))).toEqual([]);
  });

  it('does not hold a render slot while it waits, so a fill needing no conversion still goes through', async () => {
    const { templateId } = await docxTemplate(firm.id);
    const overlayId = await overlayTemplate(firm.id);
    const second = await memberWith(firm.id, ['templates.view']);
    const third = await memberWith(firm.id, ['templates.view']);

    let queued: Promise<any> = Promise.resolve(null);
    const { result: overlay } = await whileConverterHeld(
      () => preview(owner, templateId),
      async () => {
        queued = preview(second, templateId).then((r: any) => r);
        await pause(100);
        return fillOverlay(third, overlayId);
      },
    );
    const queuedPreview = await queued;

    expect(overlay.status).toBe(200);
    expect(queuedPreview.status).toBe(200);
  });

  it('is refused as 503 CONVERSION_BUSY with a Retry-After when the converter stays full', async () => {
    const { templateId } = await docxTemplate(firm.id);
    const second = await memberWith(firm.id, ['templates.view']);

    const { result: refused } = await whileConverterHeld(
      () => preview(owner, templateId),
      () => preview(second, templateId),
    );

    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('CONVERSION_BUSY');
    expect(refused.headers['retry-after']).toBe('5');
  });

  it('still answers 502 when the conversion itself fails', async () => {
    const { templateId } = await docxTemplate(firm.id);
    failWith = new Error('soffice exited 1');

    const res = await preview(owner, templateId);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('TEMPLATE_PREVIEW_CONVERSION_FAILED');
    expect(converterInputs).toHaveLength(1);
  });
});

describe('an overlay upload that needs converting to PDF', () => {
  async function uploadedDocx(actor: Actor) {
    const opened = await actor.api.post(`${T(firm.id)}/upload-overlay-init`)
      .send({ fileName: 'Court Form.docx', contentType: DOCX_TYPE, size: 64 });
    expect(opened.status).toBe(200);
    completeResumableUpload(opened.body.objectPath, { body: buildDocx('Court form') });
    return opened.body.objectPath as string;
  }

  const finalize = (actor: Actor, objectPath: string) =>
    actor.api.post(`${T(firm.id)}/upload-overlay-finalize`)
      .send({ objectPath, fileName: 'Court Form.docx', name: 'Court Form' });

  const overlayRows = async () => (await testPool.query(
    `select id from templates where law_firm_id = $1 and type = 'overlay'`, [firm.id],
  )).rows;

  it('is refused as 503 CONVERSION_BUSY with a Retry-After, and keeps the upload for the retry', async () => {
    const firstSource = await uploadedDocx(owner);
    const sourcePath = await uploadedDocx(owner);

    const { result: refused } = await whileConverterHeld(
      () => finalize(owner, firstSource),
      () => finalize(owner, sourcePath),
    );

    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('CONVERSION_BUSY');
    expect(refused.headers['retry-after']).toBe('5');
    expect(objects.has(sourcePath)).toBe(true);

    const retried = await finalize(owner, sourcePath);

    expect(retried.status).toBe(201);
    expect(objects.get(retried.body.template.overlayPdfObjectPath)!.body).toEqual(LOCAL_OUTPUT);
    expect(objects.has(sourcePath)).toBe(false);
    // The refused attempt left no draft template behind: one per success.
    expect(await overlayRows()).toHaveLength(2);
  });

  it('still answers 502 and deletes the upload when the conversion itself fails', async () => {
    const sourcePath = await uploadedDocx(owner);
    failWith = new Error('soffice exited 1');

    const res = await finalize(owner, sourcePath);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('TEMPLATE_OVERLAY_CONVERSION_FAILED');
    expect(converterInputs).toHaveLength(1);
    expect(objects.has(sourcePath)).toBe(false);
    expect(await overlayRows()).toHaveLength(0);
  });
});
