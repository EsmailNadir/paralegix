import http from 'http';
import { executeRenderCommand, parseRenderCommand, renderFailureReason } from './shared/documentConversion/htmlPdf';
import { convertLocally } from './shared/documentConversion/localConverter';
import { executeConvertCommand, WorkerCommandError } from './shared/documentConversion/workerConvert';

const MAX_BODY_BYTES = 32 * 1024;
/** A render command carries a signed URL per template image, so it is allowed more room. */
const MAX_RENDER_BODY_BYTES = 128 * 1024;
const MAX_DOCUMENT_BYTES = Number(process.env.DOCUMENT_CONVERTER_MAX_BYTES) || 100 * 1024 * 1024;

async function readJson(request: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Command is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Filled HTML template to PDF. The API has already authorized the caller and
 * signed every URL in the command; the Chromium binary is the one the image
 * installs and names in CHROMIUM_PATH.
 */
async function handleRender(request: http.IncomingMessage, response: http.ServerResponse) {
  const renderId = request.headers['x-render-id'];
  const startedAt = Date.now();
  try {
    const executablePath = process.env.CHROMIUM_PATH;
    if (!executablePath) throw new Error('CHROMIUM_PATH is not set.');
    const command = parseRenderCommand(await readJson(request, MAX_RENDER_BODY_BYTES));
    if (command.renderId !== renderId) throw new Error('Invalid render command.');
    const { outputBytes, skippedAssets } = await executeRenderCommand(command, executablePath);
    console.info('[document-worker] render completed', {
      renderId, assets: Object.keys(command.assetUrls).length, skippedAssets, outputBytes, durationMs: Date.now() - startedAt,
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ renderId, skippedAssets }));
  } catch (error: any) {
    // The reason is a fixed code, never the browser's own text, so nothing
    // about the page or the command leaves the worker in a response.
    const reason = renderFailureReason(error);
    console.error('[document-worker] render failed', { renderId, reason, durationMs: Date.now() - startedAt, message: error.message });
    response.writeHead(422, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ error: 'PDF rendering failed.', reason }));
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ status: 'ok' }));
  }
  if (request.method === 'POST' && request.url === '/internal/render-pdf') {
    return handleRender(request, response);
  }
  if (request.method !== 'POST' || request.url !== '/internal/convert') {
    response.writeHead(404);
    return response.end();
  }

  const conversionId = request.headers['x-conversion-id'];
  const startedAt = Date.now();
  try {
    const command = await readJson(request);
    const { format, inputBytes, outputBytes } = await executeConvertCommand(
      command, String(conversionId), convertLocally, MAX_DOCUMENT_BYTES,
    );
    console.info('[document-worker] conversion completed', {
      conversionId, outputFormat: format, inputBytes, outputBytes, durationMs: Date.now() - startedAt,
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ conversionId }));
  } catch (error: any) {
    // 422 means the document could not be converted; 503 that the worker could
    // not reach storage or LibreOffice; 400 a malformed command. The API tells
    // the person "bad file" or "try again" from this, so it must not collapse.
    const status = error instanceof WorkerCommandError ? error.status : 400;
    console.error('[document-worker] conversion failed', {
      conversionId, status, durationMs: Date.now() - startedAt, message: error.message,
    });
    response.writeHead(status, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ error: 'Document conversion failed.' }));
  }
});

server.listen(Number(process.env.PORT) || 8080, () => console.info('[document-worker] listening'));
