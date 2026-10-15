/**
 * Render a filled HTML template to a PDF stored at a path the caller chose.
 *
 * The API stages the filled HTML in storage, signs short-lived URLs for it, for
 * each template image and for the output, and hands that command to Chromium.
 * The images and the PDF never enter the API process; only the HTML the browser
 * sent does, and it is capped at `EXPORT_HTML_MAX_BYTES`.
 *
 * Where Chromium runs follows `DOCUMENT_CONVERTER`, the same switch LibreOffice
 * conversion uses:
 *
 *   `worker`: the private document worker renders it (`POST /internal/render-pdf`).
 *
 *   anything else: this process renders it, which is only allowed OFF
 *   production. A deployed API is 512 MiB serving eighty concurrent requests, and
 *   a browser there is exactly what moving export to the worker removed, so a
 *   deployed API that has not been switched to the worker refuses instead. On a
 *   developer machine the browser is the one the `puppeteer` dev dependency
 *   installs, or `CHROMIUM_PATH`.
 *
 * Callers go through `withTemplateExportSlot` (templates), which bounds how many
 * renders one API instance asks for at once.
 */
import crypto from 'crypto';
import { AppError } from '../errors/AppError';
import {
  executeRenderCommand, renderFailureReason, type RenderCommand, type RenderFailureReason,
} from './htmlPdf';
import {
  bucket, CONVERSION_ROOT, getIdentityToken, URL_TTL_MS, WORKER_TIMEOUT_MS, workerUrl,
} from './workerClient';

export interface RenderAsset {
  id: string;
  objectPath: string;
}

function renderUnavailable() {
  return new AppError(
    'PDF export is temporarily unavailable. Please try again shortly.',
    503,
    'PDF_RENDER_UNAVAILABLE',
  );
}

/**
 * What the person is told when a render fails, by why it failed. The first two
 * point at something they can change; the last has nothing more specific to say.
 */
function renderFailed(reason: RenderFailureReason) {
  if (reason === 'TIMEOUT') {
    return new AppError(
      'This document took too long to turn into a PDF. Try removing large images or splitting it into smaller templates.',
      422,
      'PDF_RENDER_TIMEOUT',
    );
  }
  if (reason === 'TOO_LARGE') {
    return new AppError(
      'This document is too large to turn into a PDF, usually because of a very large image. Try smaller images or fewer pages.',
      422,
      'PDF_RENDER_TOO_LARGE',
    );
  }
  return new AppError('This document could not be turned into a PDF.', 422, 'PDF_RENDER_FAILED');
}

/** The reason the worker gave, or FAILED when it gave none this build recognises. */
async function workerFailureReason(response: Response): Promise<RenderFailureReason> {
  const body: any = await response.json().catch(() => null);
  return body?.reason === 'TIMEOUT' || body?.reason === 'TOO_LARGE' ? body.reason : 'FAILED';
}

/** The browser this process may launch, for local rendering on a developer machine. */
function localChromiumPath(): string {
  if (process.env.NODE_ENV === 'production') {
    throw new AppError(
      'PDF export needs the document worker, which this server is not configured to use.',
      503,
      'PDF_RENDER_NEEDS_WORKER',
    );
  }
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    // A dev dependency, absent from any deployed image; required here, never at load.
    return require('puppeteer').executablePath();
  } catch {
    throw new AppError(
      'No Chromium is available to render PDFs. Run `npm install` in backend/ or set CHROMIUM_PATH.',
      503,
      'PDF_RENDER_UNAVAILABLE',
    );
  }
}

/** Renders on the worker; resolves to how many template images it had to leave out. */
async function renderOnWorker(command: RenderCommand): Promise<number> {
  const target = workerUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${target}/internal/render-pdf`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await getIdentityToken(process.env.DOCUMENT_WORKER_AUDIENCE || target)}`,
        'Content-Type': 'application/json',
        'X-Render-Id': command.renderId,
      },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
  } catch (error: any) {
    console.error('[pdf-render] worker unreachable', { renderId: command.renderId, message: error.message });
    throw renderUnavailable();
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    console.error('[pdf-render] worker refused', { renderId: command.renderId, status: response.status });
    throw response.status === 422 ? renderFailed(await workerFailureReason(response)) : renderUnavailable();
  }
  const body: any = await response.json().catch(() => null);
  return Number.isInteger(body?.skippedAssets) && body.skippedAssets > 0 ? body.skippedAssets : 0;
}

async function renderLocally(command: RenderCommand): Promise<number> {
  const executablePath = localChromiumPath();
  try {
    const { skippedAssets } = await executeRenderCommand(command, executablePath);
    return skippedAssets;
  } catch (error: any) {
    console.error('[pdf-render] local render failed', { renderId: command.renderId, message: error.message });
    throw renderFailed(renderFailureReason(error));
  }
}

/** Resolves to how many template images the PDF had to go without. */
export async function renderHtmlToStoredPdf({
  html, assets, outputObjectPath,
}: { html: string; assets: RenderAsset[]; outputObjectPath: string }): Promise<{ skippedAssets: number }> {
  const useWorker = process.env.DOCUMENT_CONVERTER === 'worker';
  // Before anything is staged: a deployed API without the worker must not
  // write scratch objects for a render it is going to refuse.
  if (!useWorker) localChromiumPath();

  const renderId = crypto.randomUUID();
  const startedAt = Date.now();
  const storage = bucket();
  const staged = storage.file(`${CONVERSION_ROOT}/${renderId}/input/source.html`);

  try {
    await staged.save(Buffer.from(html, 'utf8'), {
      resumable: false,
      metadata: { contentType: 'text/html; charset=utf-8' },
    });

    const expires = Date.now() + URL_TTL_MS;
    const [[htmlUrl], [outputUrl], assetEntries] = await Promise.all([
      staged.getSignedUrl({ version: 'v4', action: 'read', expires }),
      storage.file(outputObjectPath).getSignedUrl({
        version: 'v4', action: 'write', expires, contentType: 'application/pdf',
      }),
      Promise.all(assets.map(async (asset) => {
        const [url] = await storage.file(asset.objectPath).getSignedUrl({ version: 'v4', action: 'read', expires });
        return [asset.id, url] as const;
      })),
    ]);
    const command: RenderCommand = {
      renderId, htmlUrl, outputUrl, assetUrls: Object.fromEntries(assetEntries),
    };

    const skippedAssets = useWorker ? await renderOnWorker(command) : await renderLocally(command);

    console.info('[pdf-render] render completed', {
      renderId, adapter: useWorker ? 'worker' : 'local', assets: assets.length, skippedAssets, durationMs: Date.now() - startedAt,
    });
    return { skippedAssets };
  } finally {
    await staged.delete({ ignoreNotFound: true }).catch((error: any) => {
      console.error('[pdf-render] staged HTML cleanup failed', { renderId, message: error.message });
    });
  }
}
