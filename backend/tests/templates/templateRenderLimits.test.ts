/**
 * How much template rendering one person can ask for.
 *
 * Export, fill and preview each end in a render on a shared, deliberately
 * small resource: one export at a time per API instance, two fills, and a
 * document worker with two instances. The queues in front of them are FIFO, so
 * without a per-person bound one script, or one person with several tabs,
 * fills the queue and everyone else's export waits out its deadline and fails.
 *
 * Two bounds, for two shapes of that:
 *
 *   AT MOST TWO IN FLIGHT PER PERSON, across all three routes. A third render
 *   is refused at once rather than queued, so one person can hold at most two
 *   places in any queue and other people's exports still go through. The
 *   buttons are disabled while a render runs, so a person using the app
 *   normally never reaches this.
 *
 *   SIXTY PER FIFTEEN MINUTES PER PERSON, across all three routes, in the
 *   shared Postgres limiter store. The in-flight cap alone lets a script run
 *   renders back to back forever.
 */
import { randomUUID } from 'crypto';

const { PDFDocument } = require('pdf-lib');

import {
  testPool,
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { objects, putObject } from '../support/inMemoryBucket';
import { installRichBucket } from '../files/richBucket';

installRichBucket();

const WORKER = 'https://worker.test';
const T = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/templates`;
const HTML = '<div class="pdf-page" style="width:612px;min-height:792px"><p>Dear Jane Smith,</p></div>';
const pathOf = (url: string) =>
  decodeURIComponent(String(url).replace(/^https:\/\/signed\.test\//, '').split('?')[0]);

const originalFetch = global.fetch;
const originalConverter = process.env.DOCUMENT_CONVERTER;

/** Renders the fake worker has been asked for. */
let workerCalls = 0;
/** While set, the fake worker holds every render until it resolves. */
let held: Promise<void> | null;
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
  workerCalls = 0;
  held = null;
  process.env.DOCUMENT_CONVERTER = 'worker';
  process.env.DOCUMENT_WORKER_URL = WORKER;
  process.env.DOCUMENT_WORKER_ID_TOKEN = 'worker-test-token';
  global.fetch = jest.fn(async (url: string, init: any = {}) => {
    if (!String(url).startsWith(`${WORKER}/`)) throw new Error(`Unexpected fetch in test: ${url}`);
    const command = JSON.parse(init.body);
    workerCalls += 1;
    if (held) await held;
    putObject(pathOf(command.outputUrl), { body: Buffer.from('%PDF-1.7 rendered'), contentType: 'application/pdf' });
    return new Response('{}', { status: 200 });
  }) as never;

  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env.DOCUMENT_CONVERTER = originalConverter;
  delete process.env.DOCUMENT_WORKER_URL;
  delete process.env.DOCUMENT_WORKER_ID_TOKEN;
});

async function htmlTemplate(lawFirmId: string) {
  const templateId = randomUUID();
  const htmlPath = `lawfirmids/${lawFirmId}/templates/${templateId}.html`;
  putObject(htmlPath, { body: Buffer.from('<p>{{client_name}}</p>'), contentType: 'text/html' });
  await testPool.query(
    `insert into templates (id, law_firm_id, name, type, html_object_path)
     values ($1, $2, 'Engagement Letter', 'html', $3)`,
    [templateId, lawFirmId, htmlPath],
  );
  return templateId;
}

/** An overlay template, which fills with pdf-lib in this process and needs no worker. */
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

const exportPdf = (actor: Actor, lawFirmId: string, templateId: string) =>
  actor.api.post(`${T(lawFirmId)}/${templateId}/export-pdf`).send({ html: HTML });
const fill = (actor: Actor, lawFirmId: string, templateId: string) =>
  actor.api.post(`${T(lawFirmId)}/${templateId}/fill`).send({ values: {}, format: 'pdf' });
const preview = (actor: Actor, lawFirmId: string, templateId: string) =>
  actor.api.get(`${T(lawFirmId)}/${templateId}/preview`);

/** Wait until the fake worker has been asked for `n` renders. */
async function workerReached(n: number) {
  for (let i = 0; i < 200 && workerCalls < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  expect(workerCalls).toBe(n);
}

describe('renders in flight per person', () => {
  it('refuses a third at once, across export and fill, while another person still gets through', async () => {
    const templateId = await htmlTemplate(firm.id);
    const overlayId = await overlayTemplate(firm.id);
    const colleague = await memberWith(firm.id, []);
    let release!: () => void;
    held = new Promise<void>((resolve) => { release = resolve; });

    // One running on the worker, one queued behind it in the export slot.
    const first = exportPdf(owner, firm.id, templateId).then((r) => r);
    let second: Promise<any> = Promise.resolve(null);
    let colleagues: Promise<any> = Promise.resolve(null);
    try {
      await workerReached(1);
      second = exportPdf(owner, firm.id, templateId).then((r) => r);
      colleagues = exportPdf(colleague, firm.id, templateId).then((r) => r);
      await new Promise((resolve) => { setTimeout(resolve, 100); });

      const third = await exportPdf(owner, firm.id, templateId);
      const thirdAsFill = await fill(owner, firm.id, overlayId);

      expect(third.status).toBe(429);
      expect(third.body.code).toBe('TEMPLATE_RENDER_IN_PROGRESS');
      // The cap is per person, not per route: a fill counts against the same two.
      expect(thirdAsFill.status).toBe(429);
      expect(thirdAsFill.body.code).toBe('TEMPLATE_RENDER_IN_PROGRESS');
    } finally {
      release();
    }
    const settled = await Promise.all([first, second, colleagues]);
    expect(settled.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(workerCalls).toBe(3);

    // Finished renders give their places back.
    expect((await exportPdf(owner, firm.id, templateId)).status).toBe(200);
  });

  it('gives the place back when a render fails', async () => {
    const templateId = await htmlTemplate(firm.id);
    global.fetch = jest.fn(async () => new Response('{}', { status: 500 })) as never;

    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await exportPdf(owner, firm.id, templateId)).status).toBe(503);
    }
  });
});

describe('renders per person per fifteen minutes', () => {
  const originalDisabled = process.env.RATE_LIMITS_DISABLED;

  afterEach(() => {
    process.env.RATE_LIMITS_DISABLED = originalDisabled;
  });

  it('refuses the sixty-first across export, fill and preview, and leaves other people alone', async () => {
    const templateId = await htmlTemplate(firm.id);
    const overlayId = await overlayTemplate(firm.id);
    const colleague = await memberWith(firm.id, []);
    // The in-process harness turns every limiter off; this spec is about one.
    process.env.RATE_LIMITS_DISABLED = 'false';

    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const [a, b, c] = await Promise.all([
        exportPdf(owner, firm.id, templateId),
        fill(owner, firm.id, overlayId),
        preview(owner, firm.id, overlayId),
      ].map((p) => p.then((r) => r)));
      expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    }
    const rendersBefore = workerCalls;

    const refused = await Promise.all([
      exportPdf(owner, firm.id, templateId),
      fill(owner, firm.id, overlayId),
      preview(owner, firm.id, overlayId),
    ].map((p) => p.then((r) => r)));

    expect(refused.map((r) => [r.status, r.body.code])).toEqual([
      [429, 'RATE_LIMITED'], [429, 'RATE_LIMITED'], [429, 'RATE_LIMITED'],
    ]);
    expect(workerCalls).toBe(rendersBefore);
    expect((await exportPdf(colleague, firm.id, templateId)).status).toBe(200);
  });
});
