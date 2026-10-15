/**
 * Filled HTML template to PDF, through headless Chromium.
 *
 * This is the half of template export that runs where Chromium is installed:
 * the document worker in a deployed environment, and the API process itself on
 * a developer machine (see `pdfRenderer.ts`, which picks). Either way it is
 * driven by a RENDER COMMAND rather than by bytes. The command names signed
 * storage URLs for the filled HTML, for each template image and for the output,
 * so the API never holds the images or the PDF, and the worker never holds a
 * credential.
 *
 * Chromium runs with JavaScript off and every network request refused except
 * `data:`, `blob:` and `about:`. Template images are the one exception: their
 * `src` points at `ASSET_ORIGIN`, and the request for it is answered from the
 * bytes this process already fetched, so nothing inside the page reaches the
 * network. They are deliberately NOT inlined as base64 data URLs: that put
 * several whole copies of every image in memory at once (the base64 text, the
 * HTML carrying it, the copy sent to the browser and the browser's own), which
 * took a template at the image ceilings to within a few MiB of the worker's
 * 1 GiB.
 *
 * Every render has a deadline, and a page that crashes fails it at once. When
 * Chromium runs out of memory its page process dies, and without either the
 * render waited out Puppeteer's 180-second protocol timeout while the worker
 * stayed busy. On any failure the browser process is killed, not just asked to
 * close.
 */
import type { Browser } from 'puppeteer-core';
import { isSignedStorageUrl } from './contract';
import { reflowFilledTemplate } from './templateReflow';

/** The largest filled HTML an export accepts, as the previous export route did. */
export const EXPORT_HTML_MAX_BYTES = 1_000_000;

/**
 * Template images: one, and all of one template's together.
 *
 * The same ceilings the template fill path puts on placement images. Inlined as
 * base64 they grow by a third, so the total is what bounds the page Chromium
 * loads.
 */
const EXPORT_ASSET_MAX_BYTES = 10 * 1024 * 1024;
const EXPORT_ASSETS_TOTAL_MAX_BYTES = 25 * 1024 * 1024;

/** More image URLs than any template carries; bounds the command's size. */
export const EXPORT_MAX_ASSETS = 50;

/** A rendered PDF larger than this is refused rather than stored. */
const EXPORT_OUTPUT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * The most one render may take, launch to PDF. Under the API's 55-second wait
 * for the worker, so the worker gives up and frees itself before the API
 * reports the export as unavailable.
 */
const RENDER_DEADLINE_MS = 40_000;

/** How long any single browser command may take before the render fails. */
const PROTOCOL_TIMEOUT_MS = 30_000;

/** How long a browser gets to close politely before it is killed. */
const BROWSER_CLOSE_GRACE_MS = 2_000;

/** Template image requests from the page are answered from memory under this origin. */
const ASSET_ORIGIN = 'https://template-asset.invalid/';

/** The editor's default page, used when the markup carries no page size. */
const DEFAULT_PAGE = { width: 892, height: 1263 };

const ALLOWED_RESOURCE_PROTOCOLS = new Set(['about:', 'data:', 'blob:']);
const TEMPLATE_IMAGE_TAG_RE = /<img\b[^>]*data-template-object-image=(?:"true"|'true')[^>]*>/gi;
const ASSET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RENDER_ID_RE = /^[0-9a-f-]{36}$/i;

const EXPORT_STYLE = `<style>
  html, body { background: #fff !important; margin: 0 !important; padding: 0 !important; }
  .pdf-page { margin: 0 !important; box-shadow: none !important; page-break-after: always; }
  .pdf-page-background { display: block !important; }
  .pdf-page p br,
  .pdf-page [data-template-text-box-editor] br { display: block !important; content: ''; margin-top: 0.5rem !important; }
  [data-placeholder-chip] { text-decoration: none !important; }
  img[data-template-object-image="true"] { display: block !important; max-width: none !important; }
</style>`;

/**
 * Why a render failed, in terms the person can act on.
 *
 * `TIMEOUT`: the deadline passed or a browser command timed out, so the
 * document is too slow to lay out. `TOO_LARGE`: the page crashed, the browser
 * died or printing failed, which is what running out of memory looked like in
 * the worker image, most often from one very large image. `FAILED`: anything
 * else. The worker sends this back; the API turns it into the message.
 */
export type RenderFailureReason = 'TIMEOUT' | 'TOO_LARGE' | 'FAILED';

export function renderFailureReason(error: unknown): RenderFailureReason {
  const message = error instanceof Error ? error.message : '';
  if (/took longer than|timed out/i.test(message)) return 'TIMEOUT';
  if (/crashed|exited while rendering|Printing failed|Target closed/i.test(message)) return 'TOO_LARGE';
  return 'FAILED';
}

export interface RenderCommand {
  renderId: string;
  htmlUrl: string;
  /** Template image id to a signed read URL for that image. */
  assetUrls: Record<string, string>;
  outputUrl: string;
}

function invalidCommand(): Error {
  return new Error('Invalid render command.');
}

/** The command, or a throw. Nothing outside the command's own URLs is fetched. */
export function parseRenderCommand(raw: any): RenderCommand {
  if (!raw || typeof raw !== 'object') throw invalidCommand();
  const { renderId, htmlUrl, assetUrls, outputUrl } = raw;
  if (typeof renderId !== 'string' || !RENDER_ID_RE.test(renderId)) throw invalidCommand();
  if (!isSignedStorageUrl(htmlUrl) || !isSignedStorageUrl(outputUrl)) throw invalidCommand();
  if (!assetUrls || typeof assetUrls !== 'object' || Array.isArray(assetUrls)) throw invalidCommand();
  const entries = Object.entries(assetUrls);
  if (entries.length > EXPORT_MAX_ASSETS) throw invalidCommand();
  for (const [assetId, url] of entries) {
    if (!ASSET_ID_RE.test(assetId) || !isSignedStorageUrl(url)) throw invalidCommand();
  }
  return { renderId, htmlUrl, assetUrls: Object.fromEntries(entries) as Record<string, string>, outputUrl };
}

/**
 * The PDF page size, taken from the first `.pdf-page`.
 *
 * `data-base-min-height` is preferred over `min-height`, which grows when
 * repeater rows overflow into the next page. Using it keeps every PDF page the
 * template's own size, with no A4 reflow and no grey borders.
 */
export function exportPageSize(html: string): { width: number; height: number } {
  const widthMatch = html.match(/class="pdf-page"[^>]*style="[^"]*width:(\d+(?:\.\d+)?)px/);
  const baseHeightMatch = html.match(/class="pdf-page"[^>]*data-base-min-height="(\d+(?:\.\d+)?)"/);
  const heightMatch = baseHeightMatch ?? html.match(/class="pdf-page"[^>]*style="[^"]*min-height:(\d+(?:\.\d+)?)px/);
  return {
    width: widthMatch ? Math.round(parseFloat(widthMatch[1])) : DEFAULT_PAGE.width,
    height: heightMatch ? Math.round(parseFloat(heightMatch[1])) : DEFAULT_PAGE.height,
  };
}

function getTagAttribute(tag: string, attributeName: string) {
  const match = new RegExp(`${attributeName}=(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? '') : null;
}

function setTagAttribute(tag: string, attributeName: string, value: string) {
  const pattern = new RegExp(`\\s${attributeName}=(?:"[^"]*"|'[^']*')`, 'i');
  const serialized = ` ${attributeName}="${value.replace(/"/g, '&quot;')}"`;
  if (pattern.test(tag)) return tag.replace(pattern, serialized);
  return tag.replace(/\/?>$/, `${serialized}$&`);
}

/** Point each template image whose bytes were fetched at `ASSET_ORIGIN`; leave the rest as they are. */
export function hydrateTemplateAssetImages(html: string, fetchedAssetIds: Set<string>) {
  if (!html || fetchedAssetIds.size === 0) return html;
  return html.replace(TEMPLATE_IMAGE_TAG_RE, (tag) => {
    const assetId = getTagAttribute(tag, 'data-template-asset-id');
    return assetId && fetchedAssetIds.has(assetId) ? setTagAttribute(tag, 'src', `${ASSET_ORIGIN}${assetId}`) : tag;
  });
}

function withExportStyles(html: string) {
  return html.includes('</head>') ? html.replace('</head>', `${EXPORT_STYLE}</head>`) : `${EXPORT_STYLE}${html}`;
}

async function fetchFilledHtml(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('The document to export is unavailable.');
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > EXPORT_HTML_MAX_BYTES) throw new Error('The document to export is too large.');
  const body = Buffer.from(await response.arrayBuffer());
  if (!body.length) throw new Error('The document to export is empty.');
  if (body.length > EXPORT_HTML_MAX_BYTES) throw new Error('The document to export is too large.');
  return body.toString('utf8');
}

interface FetchedAsset {
  contentType: string;
  body: Buffer;
}

/**
 * Each template image's bytes, fetched one at a time under a running total.
 *
 * An image that cannot be fetched, is not an image, or would break a ceiling is
 * skipped and logged: the document still renders, without that image, which is
 * how export has always treated an unreachable asset.
 */
async function fetchAssets(assetUrls: Record<string, string>, renderId: string) {
  const assets = new Map<string, FetchedAsset>();
  let skipped = 0;
  let total = 0;
  for (const [assetId, url] of Object.entries(assetUrls)) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one image in memory at a time
      const response = await fetch(url);
      if (!response.ok) throw new Error(`status ${response.status}`);
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || '';
      if (!contentType.startsWith('image/') || contentType.includes('svg')) throw new Error(`type ${contentType || 'unknown'}`);
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > EXPORT_ASSET_MAX_BYTES || total + declared > EXPORT_ASSETS_TOTAL_MAX_BYTES) throw new Error('too large');
      // eslint-disable-next-line no-await-in-loop -- one image in memory at a time
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > EXPORT_ASSET_MAX_BYTES || total + body.length > EXPORT_ASSETS_TOTAL_MAX_BYTES) throw new Error('too large');
      total += body.length;
      assets.set(assetId, { contentType, body });
    } catch (error: any) {
      console.warn('[html-pdf] skipping template image', { renderId, assetId, reason: error.message });
      skipped += 1;
    }
  }
  return { assets, skipped };
}

async function launchChromium(executablePath: string): Promise<Browser> {
  const { default: puppeteer } = await import('puppeteer-core');
  return puppeteer.launch({
    executablePath,
    headless: true,
    timeout: PROTOCOL_TIMEOUT_MS,
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
    // No sandbox: the page runs with JavaScript off and no network, and the
    // worker already runs as an unprivileged user in its own container.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
}

/**
 * Close the browser, kill its process if it does not go within the grace
 * period, and wait for it to be gone. The worker takes its next job as soon as
 * this returns, and a browser still exiting would share its memory with it.
 */
async function shutDown(browser: Browser) {
  const child = browser.process();
  const running = () => Boolean(child && child.exitCode === null && child.signalCode === null);
  const grace = () => new Promise((resolve) => { setTimeout(resolve, BROWSER_CLOSE_GRACE_MS).unref(); });
  const exited = running() ? new Promise((resolve) => { child!.once('exit', resolve); }) : Promise.resolve();
  await Promise.race([browser.close().catch(() => {}), grace()]);
  if (running()) child!.kill('SIGKILL');
  await Promise.race([exited, grace()]);
}

async function printPage(
  browser: Browser,
  html: string,
  assets: Map<string, FetchedAsset>,
  onCrash: (error: Error) => void,
): Promise<Buffer> {
  const { width, height } = exportPageSize(html);
  const page = await browser.newPage();
  // Emitted when the page process dies, most often for want of memory.
  page.on('error', () => onCrash(new Error('The browser page crashed while rendering.')));
  await page.setJavaScriptEnabled(false);
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith(ASSET_ORIGIN)) {
      const asset = assets.get(url.slice(ASSET_ORIGIN.length));
      void (asset
        ? request.respond({ status: 200, contentType: asset.contentType, body: asset.body })
        : request.abort());
      return;
    }
    let allowed = false;
    try {
      allowed = ALLOWED_RESOURCE_PROTOCOLS.has(new URL(url).protocol);
    } catch {
      allowed = false;
    }
    void (allowed ? request.continue() : request.abort());
  });

  await page.setContent(withExportStyles(html), { waitUntil: 'load' });
  // Paragraphs that grew from placeholder replacement push later content
  // down, and content crossing a page boundary splits at a line, not mid-line.
  await page.evaluate(reflowFilledTemplate);

  const pdf = await page.pdf({
    width: `${width}px`,
    height: `${height}px`,
    printBackground: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
  });
  return Buffer.from(pdf);
}

/**
 * Render inside one browser, failing at the deadline, on a page crash or on the
 * browser exiting, whichever comes first. The browser is shut down either way.
 */
async function renderPdf(
  html: string,
  assets: Map<string, FetchedAsset>,
  executablePath: string,
  deadlineMs: number,
): Promise<Buffer> {
  const browser = await launchChromium(executablePath);
  let fail!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => { fail = reject; });
  // Settled after the race is decided more often than not; that is expected.
  failed.catch(() => {});
  const timer = setTimeout(
    () => fail(new Error(`The render took longer than ${Math.round(deadlineMs / 1000)} seconds.`)),
    deadlineMs,
  );
  browser.on('disconnected', () => fail(new Error('The browser exited while rendering.')));
  try {
    return await Promise.race([printPage(browser, html, assets, fail), failed]);
  } finally {
    clearTimeout(timer);
    await shutDown(browser);
  }
}

/**
 * Run one render command end to end: fetch, inline, render, store.
 *
 * `executablePath` is the Chromium binary. The worker image installs one; on a
 * developer machine the API passes the browser the `puppeteer` dev dependency
 * downloaded.
 */
export async function executeRenderCommand(
  command: RenderCommand,
  executablePath: string,
  { deadlineMs = RENDER_DEADLINE_MS }: { deadlineMs?: number } = {},
) {
  const html = await fetchFilledHtml(command.htmlUrl);
  const { assets, skipped } = await fetchAssets(command.assetUrls, command.renderId);
  const pdf = await renderPdf(
    hydrateTemplateAssetImages(html, new Set(assets.keys())),
    assets,
    executablePath,
    deadlineMs,
  );
  if (!pdf.length || pdf.length > EXPORT_OUTPUT_MAX_BYTES) throw new Error('The rendered PDF is not a size that can be stored.');

  const upload = await fetch(command.outputUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf' },
    body: new Uint8Array(pdf),
  });
  if (!upload.ok) throw new Error('Unable to store the rendered PDF.');
  return { outputBytes: pdf.length, skippedAssets: skipped };
}
