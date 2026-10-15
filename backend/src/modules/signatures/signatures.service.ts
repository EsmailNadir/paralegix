import { createBusyGate } from '../../shared/utils/busyGate';
import { DOC_CONVERT_CONCURRENCY, DOC_CONVERT_QUEUE_TIMEOUT_MS } from './conversionLimits';
import {
  convertDocument as convertWithAdapter,
  convertStoredDocumentOrDownload as convertStoredWithAdapter,
  FORMAT_MAP,
} from '../../shared/documentConversion/converter';

/**
 * A conversion that waited out the queue deadline is refused as
 * `503 CONVERSION_BUSY` with a `Retry-After`, not a 500: the converter is
 * congested, and the same request will work once it drains.
 */
const CONVERT_LIMIT = createBusyGate(DOC_CONVERT_CONCURRENCY, {
  queueTimeoutMs: DOC_CONVERT_QUEUE_TIMEOUT_MS,
  message: 'Too many documents are being converted right now. Please try again in a moment.',
  code: 'CONVERSION_BUSY',
});

export { FORMAT_MAP };

/**
 * Convert a document buffer to the specified output format using LibreOffice.
 * @param {Buffer} inputBuffer - The input file buffer
 * @param {string} outputFormat - Target format key (pdf, docx, doc, odt, rtf, txt)
 * @returns {Promise<Buffer>}
 */
export async function convertDocument(inputBuffer: any, outputFormat = 'pdf', inputFilename = 'source.pdf') {
  return CONVERT_LIMIT(() => convertWithAdapter(inputBuffer, outputFormat, inputFilename));
}

/**
 * Whether conversion runs on the document worker rather than in this process.
 *
 * Read per call, as the adapter itself does. A caller that would stage a
 * document in storage for the converter checks this first: in local mode the
 * stored path downloads the staged copy straight back into this process, so
 * staging costs a round trip and saves nothing.
 */
export function convertsOnWorker(): boolean {
  return process.env.DOCUMENT_CONVERTER === 'worker';
}

/**
 * Convert a document already in storage, behind the SAME concurrency limit.
 *
 * The bytes do not pass through this process, but the work still does: each
 * conversion holds a worker slot, a queue position and an open socket, and in
 * local mode it spawns soffice here. So it counts against the same budget as a
 * buffered conversion and goes through the same limiter, which is also what
 * gives it the queue deadline rather than an unbounded wait.
 */
export async function convertStoredDocument(input: any) {
  return CONVERT_LIMIT(() => convertStoredWithAdapter(input));
}
