/**
 * A template fill that ends in a document conversion, and which gate it waits in.
 *
 * Filling a DOCX to PDF is two steps with two different costs. The render
 * (docxtemplater, pdf-lib) holds whole documents in this process, which is what
 * the fill slot bounds. The conversion is LibreOffice, bounded by the
 * converter's own limiter (`DOC_CONVERT_CONCURRENCY`, one by default).
 *
 * The fill slot used to be held across both. With one converter and two fill
 * slots, two fills waiting for a conversion took both slots, so a fill that
 * needed no conversion at all (an overlay stamped to PDF) waited out its queue
 * deadline behind them and was refused. Under a 50-person staging load test
 * that was most of the TEMPLATE_FILL_BUSY answers.
 *
 * Now the slot covers the render only. The filled document is parked in storage
 * before the slot is released, so a fill waiting on the converter holds no
 * document in memory and no fill slot.
 *
 * Both queue deadlines are shortened through their env vars, set before the app
 * loads: the fill slot's well below the converter's, so a fill stuck behind the
 * slot is refused while the conversions in front of it are still waiting.
 */
import { randomUUID } from 'crypto';
import type { Actor, Firm } from '../support/setupInProcess';

process.env.TEMPLATE_FILL_QUEUE_TIMEOUT_MS = '300';
process.env.DOC_CONVERT_QUEUE_TIMEOUT_MS = '3000';

// Required, not imported, so the env above lands before the app loads.
const PizZip = require('pizzip');
const { PDFDocument } = require('pdf-lib');
const { testPool, createFirm, ownerOf, memberWith } = require('../support/setupInProcess');
const { objects, putObject } = require('../support/inMemoryBucket');
const { installRichBucket, filePathsAccessed } = require('../files/richBucket');

installRichBucket();

const WORKER = 'https://worker.test';
const T = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/templates`;
const pathOf = (url: string) =>
  decodeURIComponent(String(url).replace(/^https:\/\/signed\.test\//, '').split('?')[0]);
const CONVERTED = Buffer.from('%PDF-1.7 converted by the worker');

const originalFetch = global.fetch;
const originalConverter = process.env.DOCUMENT_CONVERTER;

/** The bytes the worker was asked to convert, one entry per conversion. */
let workerInputs: Buffer[] = [];
/** While set, the fake worker holds every conversion until it resolves. */
let held: Promise<void> | null = null;
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
  workerInputs = [];
  held = null;
  process.env.DOCUMENT_CONVERTER = 'worker';
  process.env.DOCUMENT_WORKER_URL = WORKER;
  process.env.DOCUMENT_WORKER_ID_TOKEN = 'worker-test-token';
  global.fetch = jest.fn(async (url: string, init: any = {}) => {
    if (!String(url).startsWith(`${WORKER}/`)) throw new Error(`Unexpected fetch in test: ${url}`);
    const command = JSON.parse(init.body);
    workerInputs.push(objects.get(pathOf(command.sourceUrl))!.body);
    if (held) await held;
    putObject(pathOf(command.outputUrl), { body: CONVERTED, contentType: 'application/pdf' });
    return new Response('{}', { status: 200 });
  }) as never;

  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalConverter === undefined) delete process.env.DOCUMENT_CONVERTER;
  else process.env.DOCUMENT_CONVERTER = originalConverter;
  delete process.env.DOCUMENT_WORKER_URL;
  delete process.env.DOCUMENT_WORKER_ID_TOKEN;
});

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
  return templateId;
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

const fill = (actor: Actor, templateId: string, values: Record<string, string> = {}) =>
  actor.api.post(`${T(firm.id)}/${templateId}/fill`).send({ values, format: 'pdf' });

/** Wait until the fake worker has been asked for `n` conversions. */
async function workerReached(n: number) {
  for (let i = 0; i < 200 && workerInputs.length < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  expect(workerInputs.length).toBe(n);
}

const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Every object under the firm's render prefix other than finished renders. */
const stagedLeftovers = () => [...objects.keys()].filter(
  (path: string) => path.includes('/template-renders/') && !/\/fill\.[a-z]+$/.test(path),
);

describe('a DOCX fill converted to PDF', () => {
  it('sends the FILLED document to the converter and publishes what it produced', async () => {
    const templateId = await docxTemplate(firm.id);

    const res = await fill(owner, templateId, { client_name: 'Alice Chen' });

    expect(res.status).toBe(200);
    expect(workerInputs).toHaveLength(1);
    expect(documentXmlOf(workerInputs[0])).toContain('Dear Alice Chen,');
    const renderPath = pathOf(res.body.downloadUrl);
    expect(renderPath).toContain('/template-renders/');
    expect(objects.get(renderPath)!.body).toEqual(CONVERTED);
    expect(objects.get(renderPath)!.contentType).toBe('application/pdf');
  });

  it('leaves no scratch copy behind, in the render folder or the converter', async () => {
    const templateId = await docxTemplate(firm.id);

    const res = await fill(owner, templateId, { client_name: 'Alice Chen' });

    expect(res.status).toBe(200);
    expect(stagedLeftovers()).toEqual([]);
    expect([...objects.keys()].filter((p: string) => p.startsWith('document-conversion/'))).toEqual([]);
  });
});

describe('fills waiting on the converter', () => {
  it('do not hold the fill slots, so a fill that needs no conversion still goes through', async () => {
    const docxId = await docxTemplate(firm.id);
    const overlayId = await overlayTemplate(firm.id);
    const second = await memberWith(firm.id, ['templates.view']);
    const third = await memberWith(firm.id, ['templates.view']);
    let release!: () => void;
    held = new Promise<void>((resolve) => { release = resolve; });

    // One fill converting on the worker, one queued behind it for the converter.
    // Two people, so the per-person cap is not what refuses anyone.
    const converting = fill(owner, docxId).then((r: any) => r);
    let queued: Promise<any> = Promise.resolve(null);
    let overlay: any;
    try {
      await workerReached(1);
      queued = fill(second, docxId).then((r: any) => r);
      await pause(100);

      overlay = await fill(third, overlayId);
    } finally {
      release();
    }

    expect(overlay.status).toBe(200);
    const [a, b] = await Promise.all([converting, queued]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  it('are refused as CONVERSION_BUSY when the converter stays full, and clean up after themselves', async () => {
    const docxId = await docxTemplate(firm.id);
    const second = await memberWith(firm.id, ['templates.view']);
    let release!: () => void;
    held = new Promise<void>((resolve) => { release = resolve; });

    const converting = fill(owner, docxId).then((r: any) => r);
    let refused: any;
    try {
      await workerReached(1);
      refused = await fill(second, docxId);
    } finally {
      release();
    }
    await converting;

    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('CONVERSION_BUSY');
    expect(refused.headers['retry-after']).toBe('5');
    expect(stagedLeftovers()).toEqual([]);
  });
});

/**
 * The same fills with `DOCUMENT_CONVERTER` unset, which is how production runs
 * today: LibreOffice is spawned in this process.
 *
 * Here the staged round trip buys nothing. `convertLocally` takes a Buffer, so
 * a staged copy has to be downloaded straight back into the process that just
 * wrote it, which doubled the storage traffic of every fill and logged a
 * warning each time. Local mode converts the filled buffer in place, as it did
 * before the staging path existed.
 *
 * It also keeps its fill slot across the conversion. A fill waiting on the
 * converter holds its filled document in memory either way, so releasing the
 * slot would leave the documents queued for the converter bounded by nothing
 * but the per-person cap.
 */
describe('a fill converted in this process (DOCUMENT_CONVERTER unset)', () => {
  const LOCAL_OUTPUT = Buffer.from('%PDF-1.7 converted in process');
  let localInputs: Buffer[] = [];
  let localHeld: Promise<void> | null = null;
  let localSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.DOCUMENT_CONVERTER;
    localInputs = [];
    localHeld = null;
    filePathsAccessed.length = 0;
    const localConverter = require('../../src/shared/documentConversion/localConverter');
    localSpy = jest.spyOn(localConverter, 'convertLocally').mockImplementation(async (input: any) => {
      localInputs.push(input);
      if (localHeld) await localHeld;
      return LOCAL_OUTPUT;
    });
    warnSpy = jest.spyOn(console, 'warn');
  });

  afterEach(() => {
    localSpy.mockRestore();
    warnSpy.mockRestore();
  });

  /** Wait until the in-process converter has been asked for `n` conversions. */
  async function localReached(n: number) {
    for (let i = 0; i < 200 && localInputs.length < n; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await pause(10);
    }
    expect(localInputs.length).toBe(n);
  }

  it('converts the FILLED document and publishes what the converter produced', async () => {
    const templateId = await docxTemplate(firm.id);

    const res = await fill(owner, templateId, { client_name: 'Alice Chen' });

    expect(res.status).toBe(200);
    expect(localInputs).toHaveLength(1);
    expect(documentXmlOf(localInputs[0])).toContain('Dear Alice Chen,');
    const renderPath = pathOf(res.body.downloadUrl);
    expect(objects.get(renderPath)!.body).toEqual(LOCAL_OUTPUT);
    expect(objects.get(renderPath)!.contentType).toBe('application/pdf');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('never stages the filled document, so nothing is written, read back or left behind', async () => {
    const templateId = await docxTemplate(firm.id);

    const res = await fill(owner, templateId, { client_name: 'Alice Chen' });

    expect(res.status).toBe(200);
    expect(localInputs).toHaveLength(1);
    expect(filePathsAccessed.filter((p: string) => p.includes('/staged-'))).toEqual([]);
    expect(filePathsAccessed.filter((p: string) => p.startsWith('document-conversion/'))).toEqual([]);
    expect(stagedLeftovers()).toEqual([]);
    const downloading = warnSpy.mock.calls.filter((args) => String(args[0]).includes('downloading a source'));
    expect(downloading).toEqual([]);
  });

  it('holds the fill slot across the conversion, keeping queued documents inside the slot budget', async () => {
    const docxId = await docxTemplate(firm.id);
    const overlayId = await overlayTemplate(firm.id);
    const second = await memberWith(firm.id, ['templates.view']);
    const third = await memberWith(firm.id, ['templates.view']);
    let release!: () => void;
    localHeld = new Promise<void>((resolve) => { release = resolve; });

    // Both fill slots: one converting, one holding its filled document while it
    // queues for the converter. A third render has no slot to take.
    const converting = fill(owner, docxId).then((r: any) => r);
    let queued: Promise<any> = Promise.resolve(null);
    let overlay: any;
    try {
      await localReached(1);
      queued = fill(second, docxId).then((r: any) => r);
      await pause(100);

      overlay = await fill(third, overlayId);
    } finally {
      release();
    }

    expect(overlay.status).toBe(503);
    expect(overlay.body.code).toBe('TEMPLATE_FILL_BUSY');
    const [a, b] = await Promise.all([converting, queued]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });
});
