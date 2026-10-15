/**
 * `POST /:templateId/export-pdf`: a filled HTML template, rendered to PDF by
 * Chromium on the document worker.
 *
 * This replaces the frontend's `/api/export` route, which ran Chromium inside a
 * Vercel function. The browser still builds the filled HTML; what moved is the
 * render. The cases that matter:
 *
 *   NOTHING IS SIGNED OR RENDERED BEFORE THE CALLER IS AUTHORIZED. Every refusal
 *   asserts the worker was never called and no URL was minted, because a route
 *   that rendered first and checked second answers the same status codes.
 *
 *   THE WORKER GETS THIS TEMPLATE'S IMAGES AND NOTHING ELSE. The old route
 *   fetched whatever image URLs the browser sent, behind a host allowlist. Now
 *   the API signs the template's own stored assets, so a caller cannot point the
 *   render at another template's images or at an arbitrary host.
 *
 *   THE PDF NEVER PASSES THROUGH THE API. The worker writes it straight to the
 *   caller's render slot, and the response is a signed link to it.
 *
 *   ONE RENDER AT A TIME PER API INSTANCE. The worker runs one job per instance
 *   at two instances, and the LibreOffice conversion slot holds the other.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  ownerOf,
  portalUser,
  stranger,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { objects, putObject, signedUrlCalls } from '../support/inMemoryBucket';
import { installRichBucket } from '../files/richBucket';

installRichBucket();

const WORKER = 'https://worker.test';
const T = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/templates`;
const FILLED_HTML = '<html><head></head><body><div class="pdf-page" style="width:612px;min-height:792px"><p>Dear Jane Smith,</p></div></body></html>';

/** The storage path a test-bucket signed URL names. */
const pathOf = (url: string) =>
  decodeURIComponent(String(url).replace(/^https:\/\/signed\.test\//, '').split('?')[0]);

interface WorkerCall {
  command: any;
  headers: Record<string, string>;
  /** The filled HTML as it sat in storage when the worker was asked to render it. */
  htmlAtCall: string | undefined;
}

let workerCalls: WorkerCall[];
/** What the fake worker does after recording a call. Defaults to writing a PDF. */
let workerBehaviour: (call: WorkerCall) => Promise<Response>;
const originalFetch = global.fetch;
const originalConverter = process.env.DOCUMENT_CONVERTER;

const writePdf = async (call: WorkerCall) => {
  putObject(pathOf(call.command.outputUrl), { body: Buffer.from('%PDF-1.7 rendered'), contentType: 'application/pdf' });
  return new Response(JSON.stringify({ renderId: call.command.renderId }), { status: 200 });
};

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  objects.clear();
  workerCalls = [];
  workerBehaviour = writePdf;
  process.env.DOCUMENT_CONVERTER = 'worker';
  process.env.DOCUMENT_WORKER_URL = WORKER;
  process.env.DOCUMENT_WORKER_ID_TOKEN = 'worker-test-token';
  global.fetch = jest.fn(async (url: string, init: any = {}) => {
    if (!String(url).startsWith(`${WORKER}/`)) throw new Error(`Unexpected fetch in test: ${url}`);
    const command = JSON.parse(init.body);
    const html = objects.get(pathOf(command.htmlUrl));
    const call: WorkerCall = {
      command,
      headers: init.headers,
      htmlAtCall: html?.body?.toString('utf8'),
    };
    workerCalls.push(call);
    return workerBehaviour(call);
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

/** An HTML template with two stored images. */
async function htmlTemplate(lawFirmId: string) {
  const templateId = randomUUID();
  const htmlPath = `lawfirmids/${lawFirmId}/templates/${templateId}.html`;
  putObject(htmlPath, { body: Buffer.from('<p>{{client_name}}</p>'), contentType: 'text/html' });
  const assets = [randomUUID(), randomUUID()].map((id) => {
    const objectPath = `lawfirmids/${lawFirmId}/templates/${templateId}/assets/${id}.png`;
    putObject(objectPath, { body: Buffer.from('png'), contentType: 'image/png' });
    return { id, objectPath, fileName: `${id}.png`, mimeType: 'image/png' };
  });
  await testPool.query(
    `insert into templates (id, law_firm_id, name, type, html_object_path, assets)
     values ($1, $2, 'Engagement Letter', 'html', $3, $4)`,
    [templateId, lawFirmId, htmlPath, JSON.stringify(assets)],
  );
  return { templateId, assets };
}

const exportPdf = (actor: Actor, lawFirmId: string, templateId: string, body: Record<string, unknown> = {}) =>
  actor.api.post(`${T(lawFirmId)}/${templateId}/export-pdf`).send({ html: FILLED_HTML, ...body });

describe('who may export', () => {
  it('refuses the owner of another firm, through either firm, without rendering or signing', async () => {
    const { templateId } = await htmlTemplate(firm.id);
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const direct = await exportPdf(otherOwner, firm.id, templateId);
    const viaOwnFirm = await exportPdf(otherOwner, otherFirm.id, templateId);

    expect(direct.status).toBe(403);
    expect(viaOwnFirm.status).toBe(404);
    expect(workerCalls).toHaveLength(0);
    expect(signedUrlCalls).toHaveLength(0);
  });

  it('refuses a signed-in stranger and a portal client', async () => {
    const { templateId } = await htmlTemplate(firm.id);
    const client = await portalUser();

    expect((await exportPdf(stranger(), firm.id, templateId)).status).toBe(403);
    expect((await exportPdf(client, firm.id, templateId)).status).toBe(403);
    expect(workerCalls).toHaveLength(0);
    expect(signedUrlCalls).toHaveLength(0);
  });
});

describe('a successful export', () => {
  it('answers with a link to the PDF in the caller render slot, under the name they chose', async () => {
    const { templateId } = await htmlTemplate(firm.id);

    const res = await exportPdf(owner, firm.id, templateId, { fileName: 'Smith Engagement' });

    expect(res.status).toBe(200);
    expect(pathOf(res.body.downloadUrl))
      .toBe(`lawfirmids/${firm.id}/template-renders/${templateId}/${owner.uid}/export.pdf`);
    expect(res.body.fileName).toBe('Smith Engagement.pdf');
    expect(res.body.disposition).toBe('attachment');
    const signed = signedUrlCalls.find((c) => c.path === pathOf(res.body.downloadUrl) && c.config.action === 'read');
    expect(signed?.config.responseDisposition).toBe('attachment; filename="Smith Engagement.pdf"');
    // Pinned to the version the worker wrote, like every other render link.
    expect(signed?.generation).toBe(objects.get(pathOf(res.body.downloadUrl))!.generation);
  });

  it('hands the worker the filled HTML, a write URL for that slot, and only this template images', async () => {
    const { templateId, assets } = await htmlTemplate(firm.id);
    // Another template in the same firm, whose images must not be offered.
    await htmlTemplate(firm.id);

    await exportPdf(owner, firm.id, templateId);

    expect(workerCalls).toHaveLength(1);
    const [{ command, headers, htmlAtCall }] = workerCalls;
    expect(htmlAtCall).toBe(FILLED_HTML);
    expect(headers['X-Render-Id']).toBe(command.renderId);
    expect(headers.Authorization).toBe('Bearer worker-test-token');
    expect(Object.keys(command.assetUrls).sort()).toEqual(assets.map((a) => a.id).sort());
    for (const asset of assets) expect(pathOf(command.assetUrls[asset.id])).toBe(asset.objectPath);
    expect(pathOf(command.outputUrl))
      .toBe(`lawfirmids/${firm.id}/template-renders/${templateId}/${owner.uid}/export.pdf`);
    const outputSigning = signedUrlCalls.find((c) => c.path === pathOf(command.outputUrl) && c.config.action === 'write');
    expect(outputSigning?.config.contentType).toBe('application/pdf');
  });

  it('reports how many template images the PDF had to go without', async () => {
    const { templateId } = await htmlTemplate(firm.id);
    workerBehaviour = async (call) => {
      await writePdf(call);
      return new Response(JSON.stringify({ renderId: call.command.renderId, skippedAssets: 2 }), { status: 200 });
    };

    const res = await exportPdf(owner, firm.id, templateId);

    expect(res.status).toBe(200);
    expect(res.body.skippedImages).toBe(2);
  });

  it('reports none missing when every image made it in', async () => {
    const { templateId } = await htmlTemplate(firm.id);

    const res = await exportPdf(owner, firm.id, templateId);

    expect(res.body.skippedImages).toBe(0);
  });

  it('removes the filled HTML it staged for the worker', async () => {
    const { templateId } = await htmlTemplate(firm.id);

    await exportPdf(owner, firm.id, templateId);

    const staged = pathOf(workerCalls[0].command.htmlUrl);
    expect(staged).toMatch(/^document-conversion\//);
    expect(objects.has(staged)).toBe(false);
  });
});

describe('refusals', () => {
  it('refuses HTML over the export ceiling before staging anything', async () => {
    const { templateId } = await htmlTemplate(firm.id);

    const res = await exportPdf(owner, firm.id, templateId, { html: 'x'.repeat(1_000_001) });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('TEMPLATE_EXPORT_TOO_LARGE');
    expect(workerCalls).toHaveLength(0);
    expect(signedUrlCalls).toHaveLength(0);
  });

  it('refuses a body over 2 MB while it is still arriving, before the route runs', async () => {
    const { templateId } = await htmlTemplate(firm.id);

    const res = await exportPdf(owner, firm.id, templateId, { html: 'x'.repeat(2 * 1024 * 1024 + 1024) });

    // PAYLOAD_TOO_LARGE is the body parser's answer; the service's own size
    // check would say TEMPLATE_EXPORT_TOO_LARGE. So the body was refused on its
    // declared length, not read into this 512 MiB process and then measured.
    // Every other /templates route still accepts 50 MB for the editor's save.
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(workerCalls).toHaveLength(0);
    expect(signedUrlCalls).toHaveLength(0);
  });

  it('leaves the rest of /templates on its larger limit', async () => {
    // The template editor PUTs the whole template, pasted images and all. The
    // export route's tighter cap must not reach it.
    const { templateId } = await htmlTemplate(firm.id);

    const res = await owner.api.put(`${T(firm.id)}/${templateId}`)
      .send({ name: 'Engagement Letter', html: `<p>${'x'.repeat(3 * 1024 * 1024)}</p>` });

    expect(res.status).toBe(200);
  });

  it('refuses a template that has no editable HTML', async () => {
    const templateId = randomUUID();
    await testPool.query(
      `insert into templates (id, law_firm_id, name, type, overlay_pdf_object_path)
       values ($1, $2, 'Court Form', 'overlay', 'lawfirmids/x/overlay.pdf')`,
      [templateId, firm.id],
    );

    const res = await exportPdf(owner, firm.id, templateId);

    expect(res.status).toBe(400);
    expect(workerCalls).toHaveLength(0);
  });

  it('reports a worker failure as unavailable, and still removes the staged HTML', async () => {
    const { templateId } = await htmlTemplate(firm.id);
    workerBehaviour = async () => new Response('{}', { status: 500 });

    const res = await exportPdf(owner, firm.id, templateId);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PDF_RENDER_UNAVAILABLE');
    expect(objects.has(pathOf(workerCalls[0].command.htmlUrl))).toBe(false);
  });

  it.each([
    ['TIMEOUT', 'PDF_RENDER_TIMEOUT',
      'This document took too long to turn into a PDF. Try removing large images or splitting it into smaller templates.'],
    ['TOO_LARGE', 'PDF_RENDER_TOO_LARGE',
      'This document is too large to turn into a PDF, usually because of a very large image. Try smaller images or fewer pages.'],
    [undefined, 'PDF_RENDER_FAILED', 'This document could not be turned into a PDF.'],
  ])('tells the person why the worker could not render it (%s)', async (reason, code, message) => {
    const { templateId } = await htmlTemplate(firm.id);
    workerBehaviour = async () => new Response(JSON.stringify({ error: 'PDF rendering failed.', reason }), { status: 422 });

    const res = await exportPdf(owner, firm.id, templateId);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe(code);
    expect(res.body.error).toBe(message);
  });

  it('refuses a worker that answered 200 without writing the PDF', async () => {
    const { templateId } = await htmlTemplate(firm.id);
    workerBehaviour = async () => new Response('{}', { status: 200 });

    const res = await exportPdf(owner, firm.id, templateId);

    expect(res.status).toBe(502);
    expect(res.body.downloadUrl).toBeUndefined();
  });

  it('will not start Chromium inside a deployed API that has not been switched to the worker', async () => {
    const { templateId } = await htmlTemplate(firm.id);
    process.env.DOCUMENT_CONVERTER = 'local';
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const res = await exportPdf(owner, firm.id, templateId);

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('PDF_RENDER_NEEDS_WORKER');
    } finally {
      process.env.NODE_ENV = nodeEnv;
    }
    expect(workerCalls).toHaveLength(0);
  });
});

describe('concurrency', () => {
  it('renders one export at a time on an instance, queueing the next', async () => {
    const { templateId } = await htmlTemplate(firm.id);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    workerBehaviour = async (call) => {
      if (workerCalls.length === 1) await held;
      return writePdf(call);
    };

    const first = exportPdf(owner, firm.id, templateId).then((r) => r);
    const second = exportPdf(owner, firm.id, templateId).then((r) => r);
    // Both requests have had time to reach the slot; only one got through it.
    for (let i = 0; i < 50 && workerCalls.length === 0; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(workerCalls).toHaveLength(1);

    release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(workerCalls).toHaveLength(2);
  });
});
