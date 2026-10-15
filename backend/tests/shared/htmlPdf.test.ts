/**
 * Turning a filled HTML template into a PDF, the half that runs on the
 * document worker.
 *
 * The worker receives a small command from the API: a signed read URL for the
 * filled HTML, one per template image, and a signed write URL for the PDF. The
 * worker has no database and no application secrets, so the command is the
 * whole of what it may touch. What has to hold:
 *
 *   IT ONLY FOLLOWS SHORT-LIVED STORAGE URLS. The previous export route fetched
 *   whatever asset URL the browser sent and so had to keep its own host
 *   allowlist against SSRF. Here a command naming any other host, or a signed
 *   URL that lives longer than the API ever mints, is refused before a byte is
 *   fetched.
 *
 *   ONE BAD IMAGE DOES NOT FAIL THE DOCUMENT. An expired or missing image
 *   renders as a missing image, as it did before.
 *
 *   THE PAGE IS THE TEMPLATE'S PAGE. The PDF takes its size from the first
 *   `.pdf-page`, so an export neither reflows onto A4 nor grows grey margins.
 *
 * The Chromium cases need a browser. Locally that is the one the `puppeteer`
 * dev dependency installs; where none is installed they are skipped and say so.
 */
import fs from 'fs';
import { execSync } from 'child_process';
import {
  EXPORT_HTML_MAX_BYTES,
  EXPORT_MAX_ASSETS,
  executeRenderCommand,
  exportPageSize,
  hydrateTemplateAssetImages,
  parseRenderCommand,
  renderFailureReason,
} from '../../src/shared/documentConversion/htmlPdf';

const { PDFDocument } = require('pdf-lib');

const RENDER_ID = '0b4a1c9e-3f59-4c1f-9a51-2d2f3b7e8a10';
const signed = (objectPath: string, expires = 90) =>
  `https://storage.googleapis.com/lawfirms/${objectPath}?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Expires=${expires}&X-Goog-Signature=abc`;

const validCommand = () => ({
  renderId: RENDER_ID,
  htmlUrl: signed('document-conversion/r/input/source.html'),
  assetUrls: { 'asset-1': signed('lawfirmids/f/templates/t/assets/asset-1.png') },
  outputUrl: signed('lawfirmids/f/template-renders/t/u/export.pdf'),
});

/** The first page of a template, as the editor serializes it. */
const page = (body: string, { width = 892, height = 1263 } = {}) =>
  `<div class="pdf-page" data-base-min-height="${height}" style="position:relative;width:${width}px;min-height:${height}px">${body}</div>`;

describe('the page size an export uses', () => {
  it('reads the width and the original height off the first page', () => {
    const html = page('', { width: 612, height: 792 })
      .replace('min-height:792px', 'min-height:1600px');

    // `min-height` grows when repeater rows overflow; the base height is the
    // template's real page, which is what every page of the PDF must be.
    expect(exportPageSize(html)).toEqual({ width: 612, height: 792 });
  });

  it('falls back to min-height when a page carries no base height', () => {
    const html = '<div class="pdf-page" style="width:700px;min-height:900px"></div>';
    expect(exportPageSize(html)).toEqual({ width: 700, height: 900 });
  });

  it('uses the editor default for markup without a page', () => {
    expect(exportPageSize('<p>hello</p>')).toEqual({ width: 892, height: 1263 });
  });
});

describe('pointing template images at their fetched bytes', () => {
  const img = (assetId: string) =>
    `<img data-template-object-image="true" data-template-asset-id="${assetId}" src="https://expired.example/x.png">`;

  it('points the src of a template image at the address its bytes are served from', () => {
    // Not a data: URL. Base64 inside the HTML put several whole copies of every
    // image in memory at once, which is what took the largest allowed template
    // to within a few MiB of the worker's 1 GiB.
    const out = hydrateTemplateAssetImages(img('asset-1'), new Set(['asset-1']));
    expect(out).toContain('src="https://template-asset.invalid/asset-1"');
    expect(out).not.toContain('expired.example');
    expect(out).not.toContain('base64');
  });

  it('leaves an image it has no bytes for, and an image that is not a template image, alone', () => {
    const other = '<img src="https://expired.example/logo.png">';
    const html = `${img('asset-2')}${other}`;
    expect(hydrateTemplateAssetImages(html, new Set(['asset-1']))).toBe(html);
  });
});

describe('what the worker accepts as a command', () => {
  it('accepts one the API would send', () => {
    expect(parseRenderCommand(validCommand())).toEqual(validCommand());
  });

  it('refuses a URL on any host but storage', () => {
    expect(() => parseRenderCommand({
      ...validCommand(),
      assetUrls: { 'asset-1': 'http://169.254.169.254/computeMetadata/v1/?X-Goog-Expires=60' },
    })).toThrow(/invalid render command/i);
    expect(() => parseRenderCommand({ ...validCommand(), htmlUrl: 'https://evil.test/a.html?X-Goog-Expires=60' }))
      .toThrow(/invalid render command/i);
  });

  it('refuses a signed URL that outlives what the API mints', () => {
    expect(() => parseRenderCommand({ ...validCommand(), outputUrl: signed('x.pdf', 3600) }))
      .toThrow(/invalid render command/i);
  });

  it('refuses more images than a template may carry', () => {
    const assetUrls = Object.fromEntries(
      Array.from({ length: EXPORT_MAX_ASSETS + 1 }, (_, i) => [`asset-${i}`, signed(`a/${i}.png`)]),
    );
    expect(() => parseRenderCommand({ ...validCommand(), assetUrls })).toThrow(/invalid render command/i);
  });

  it('refuses a render id that is not a uuid', () => {
    expect(() => parseRenderCommand({ ...validCommand(), renderId: '../../etc' }))
      .toThrow(/invalid render command/i);
  });
});

/** A 1x1 PNG, so the PDF has an image to embed. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const originalFetch = global.fetch;

/**
 * Storage, as the worker sees it through its signed URLs. Anything written to
 * the output URL lands in `uploaded`.
 */
function serveStorage(files: Record<string, { body: Buffer | string; type: string; status?: number }>) {
  const uploaded: { body?: Buffer; contentType?: string } = {};
  global.fetch = jest.fn(async (url: string, init: any = {}) => {
    if (init.method === 'PUT') {
      uploaded.body = Buffer.from(init.body);
      uploaded.contentType = init.headers['Content-Type'];
      return new Response(null, { status: 200 });
    }
    const file = files[url];
    if (!file) return new Response('not found', { status: 404 });
    const body = typeof file.body === 'string' ? file.body : new Uint8Array(file.body);
    return new Response(body, { status: file.status ?? 200, headers: { 'Content-Type': file.type } });
  }) as never;
  return uploaded;
}

afterEach(() => {
  global.fetch = originalFetch;
});

describe('why a render failed, as the person will be told', () => {
  // The API turns this into the message: "took too long, split it" and "too
  // large, use smaller images" each point at something the person can change,
  // where a bare "could not be rendered" points at nothing.
  it('reads a deadline or a browser command timing out as taking too long', () => {
    expect(renderFailureReason(new Error('The render took longer than 40 seconds.'))).toBe('TIMEOUT');
    expect(renderFailureReason(new Error('Runtime.callFunctionOn timed out. Increase the protocolTimeout setting'))).toBe('TIMEOUT');
  });

  it('reads a crashed page, a browser that died, or a print that failed as too large', () => {
    // Each of these is what running out of memory looked like in the worker image.
    expect(renderFailureReason(new Error('The browser page crashed while rendering.'))).toBe('TOO_LARGE');
    expect(renderFailureReason(new Error('The browser exited while rendering.'))).toBe('TOO_LARGE');
    expect(renderFailureReason(new Error('Protocol error (Page.printToPDF): Printing failed'))).toBe('TOO_LARGE');
  });

  it('calls anything else a plain failure', () => {
    expect(renderFailureReason(new Error('Unable to store the rendered PDF.'))).toBe('FAILED');
    expect(renderFailureReason('not even an error')).toBe('FAILED');
  });
});

describe('a render command whose HTML is too large', () => {
  it('is refused before the browser starts', async () => {
    const command = validCommand();
    serveStorage({ [command.htmlUrl]: { body: 'x'.repeat(EXPORT_HTML_MAX_BYTES + 1), type: 'text/html' } });

    await expect(executeRenderCommand(command, '/nonexistent/chromium')).rejects.toThrow(/too large/i);
  });
});

function localChromium(): string | null {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    const candidate = require('puppeteer').executablePath();
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

const chromium = localChromium();
if (!chromium) {
  console.warn('[htmlPdf.test] No Chromium installed: skipping the cases that render a real PDF.');
}
const withChromium = chromium ? describe : describe.skip;

withChromium('rendering a real PDF', () => {
  jest.setTimeout(60_000);

  const imagePage = (assetId: string) => page(
    `<p style="position:absolute;top:80px;left:72px">Dear Jane Smith,</p>`
    + `<img data-template-object-image="true" data-template-asset-id="${assetId}" style="position:absolute;top:200px;left:72px;width:40px;height:40px">`,
    { width: 612, height: 792 },
  );

  it('writes a PDF at the template page size, with the template image embedded', async () => {
    const command = validCommand();
    const uploaded = serveStorage({
      [command.htmlUrl]: { body: `<html><head></head><body>${imagePage('asset-1')}</body></html>`, type: 'text/html' },
      [command.assetUrls['asset-1']]: { body: PNG_1PX, type: 'image/png' },
    });

    const result = await executeRenderCommand(command, chromium as string);

    expect(uploaded.contentType).toBe('application/pdf');
    expect(result.outputBytes).toBe(uploaded.body!.length);
    expect(result.skippedAssets).toBe(0);
    const pdf = await PDFDocument.load(uploaded.body!);
    // 612 x 792 CSS px, printed at 96 dpi into 72 dpi points.
    expect(pdf.getPageCount()).toBe(1);
    const { width, height } = pdf.getPage(0).getSize();
    expect(Math.round(width)).toBe(459);
    expect(Math.round(height)).toBe(594);
    expect(uploaded.body!.toString('latin1')).toMatch(/\/Subtype\s*\/Image/);
  });

  it('still renders when one image cannot be fetched', async () => {
    const command = validCommand();
    const uploaded = serveStorage({
      [command.htmlUrl]: { body: `<html><body>${imagePage('asset-1')}</body></html>`, type: 'text/html' },
      [command.assetUrls['asset-1']]: { body: 'gone', type: 'text/plain', status: 404 },
    });

    const result = await executeRenderCommand(command, chromium as string);

    const pdf = await PDFDocument.load(uploaded.body!);
    expect(pdf.getPageCount()).toBe(1);
    expect(uploaded.body!.toString('latin1')).not.toMatch(/\/Subtype\s*\/Image/);
    // Counted, so the person can be told the PDF is missing an image rather
    // than finding out when they read it.
    expect(result.skippedAssets).toBe(1);
  });

  it('gives up at its deadline, and leaves no browser running', async () => {
    const command = validCommand();
    serveStorage({
      [command.htmlUrl]: { body: `<html><body>${imagePage('asset-1')}</body></html>`, type: 'text/html' },
      [command.assetUrls['asset-1']]: { body: PNG_1PX, type: 'image/png' },
    });
    const browsers = () => execSync('ps -A -o command', { encoding: 'utf8' })
      .split('\n').filter((line) => line.startsWith(chromium as string)).length;
    const before = browsers();

    const started = Date.now();
    await expect(executeRenderCommand(command, chromium as string, { deadlineMs: 1 }))
      .rejects.toThrow(/took longer than/);

    // A render past its deadline is abandoned in seconds, not after the
    // browser's 180-second protocol timeout, and its Chromium is killed rather
    // than left holding the worker's memory.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(browsers()).toBe(before);
  });
});

