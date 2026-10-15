import crypto from 'crypto';
import {
  FORMAT_MAP, getOutputFormat, conversionError, conversionUnavailable, workerConversionError, type OutputFormat,
} from './contract';
import { convertLocally } from './localConverter';
import {
  bucket, CONVERSION_ROOT, getIdentityToken, URL_TTL_MS, WORKER_TIMEOUT_MS, workerUrl,
} from './workerClient';

const MAX_DOCUMENT_BYTES = Number(process.env.DOCUMENT_CONVERTER_MAX_BYTES) || 100 * 1024 * 1024;

function safeFilename(name: string) {
  return (name || 'source').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'source';
}

async function convertWithWorker(inputBuffer: Buffer, outputFormat: OutputFormat, inputFilename: string, conversionId: string): Promise<Buffer> {
  if (inputBuffer.length > MAX_DOCUMENT_BYTES) {
    const error: any = new Error('Document is too large to convert.');
    error.statusCode = 400;
    throw error;
  }

  const root = `${CONVERSION_ROOT}/${conversionId}`;
  const sourcePath = `${root}/input/${safeFilename(inputFilename)}`;
  const outputPath = `${root}/output/result.${FORMAT_MAP[outputFormat].ext}`;
  const storage = bucket();
  const source = storage.file(sourcePath);
  const output = storage.file(outputPath);

  try {
    await source.save(inputBuffer, { resumable: false, metadata: { contentType: 'application/octet-stream' } });
    const expires = Date.now() + URL_TTL_MS;
    const [[sourceUrl], [outputUrl]] = await Promise.all([
      source.getSignedUrl({ version: 'v4', action: 'read', expires }),
      output.getSignedUrl({ version: 'v4', action: 'write', expires, contentType: FORMAT_MAP[outputFormat].mime }),
    ]);
    const target = workerUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${target}/internal/convert`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await getIdentityToken(process.env.DOCUMENT_WORKER_AUDIENCE || target)}`,
          'Content-Type': 'application/json',
          'X-Conversion-Id': conversionId,
        },
        body: JSON.stringify({ conversionId, inputFilename: safeFilename(inputFilename), outputFormat, sourceUrl, outputUrl, maxBytes: MAX_DOCUMENT_BYTES }),
        signal: controller.signal,
      });
    } catch {
      // Unreachable, or past our own deadline: nothing is known about the
      // document, so this is "try again", never "the file is bad".
      throw conversionUnavailable();
    } finally {
      clearTimeout(timer);
    }
    if (!response!.ok) throw workerConversionError(response!.status);
    const [result] = await output.download();
    if (!result.length || result.length > MAX_DOCUMENT_BYTES) throw new Error('Document conversion produced an invalid output.');
    return result;
  } catch (error: any) {
    throw conversionError(error);
  } finally {
    await storage.deleteFiles({ prefix: `${root}/`, force: true }).catch((error: any) => {
      console.error('[document-conversion] temporary object cleanup failed', { conversionId, message: error.message });
    });
  }
}

export interface StoredConversionInput {
  /** An object that already exists. Never written to, never deleted. */
  sourceObjectPath: string;
  outputFormat?: string;
  inputFilename?: string;
  /** Known source size, so an oversized document is refused before any work. */
  sourceBytes?: number;
  /**
   * The caller's own ceiling, when it is lower than the converter's. Refused
   * before any byte is read, in either adapter.
   */
  maxBytes?: number;
}

/** The ceiling one conversion runs under: the converter's, or the caller's if lower. */
function conversionCap(input: StoredConversionInput): number {
  const asked = Number(input.maxBytes);
  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_DOCUMENT_BYTES) : MAX_DOCUMENT_BYTES;
}

function conversionTooLarge(size: number, cap: number) {
  const error: any = new Error(`Document is ${size} bytes; the most this conversion accepts is ${cap}.`);
  error.statusCode = 413;
  error.code = 'CONVERSION_TOO_LARGE';
  return error;
}

export interface StoredConversionResult {
  objectPath: string;
  size: number;
  contentType: string;
  /**
   * The version of the output object this result describes.
   *
   * A caller that copies the output or signs a URL for it has to name the
   * version it was told about. Without it, anything that writes to the same
   * scratch path between this returning and the caller acting is taken instead,
   * under a decision made about other bytes.
   */
  generation: string;
  /** Remove the scratch output once the caller has copied or served it. */
  cleanup: () => Promise<void>;
}

/**
 * Convert a document that is ALREADY in storage, without its bytes entering
 * this process.
 *
 * `convertDocument` takes a Buffer, and in worker mode it writes that whole
 * buffer to storage itself before calling the worker. So the API holds the
 * entire input even though another service does the work: the bytes arrive as
 * multipart, sit in a 512 MiB container serving eighty concurrent requests, and
 * are then written out again.
 *
 * Here the upload has already put the bytes in storage, so the API signs a read
 * url for the object where it already is. Two consequences worth stating:
 *
 * The source is never written and never deleted. The buffer path put its input
 * in a scratch prefix and removed the whole prefix afterwards; pointing that
 * cleanup at a caller's object would destroy the document they uploaded. Only
 * the output prefix is cleaned, and the caller decides when.
 *
 * The result is a REFERENCE. Downloading it to return a Buffer would put the
 * output in the process instead of the input, which moves the problem rather
 * than removing it.
 *
 * Worker mode only. `convertLocally` takes a Buffer and has no way to read from
 * storage, so the local adapter could only satisfy this by downloading the
 * source, which is the thing being avoided. It refuses instead of quietly
 * holding the bytes.
 */
export async function convertStoredDocument(
  input: StoredConversionInput,
): Promise<StoredConversionResult> {
  const { sourceObjectPath, outputFormat = 'pdf', inputFilename = 'source.pdf', sourceBytes } = input;
  const format = getOutputFormat(outputFormat);

  if (process.env.DOCUMENT_CONVERTER !== 'worker') {
    const error: any = new Error(
      'Converting from storage needs the document worker (DOCUMENT_CONVERTER=worker). '
      + 'The local adapter can only convert bytes already in this process.',
    );
    error.statusCode = 503;
    throw error;
  }

  if (input.maxBytes && Number.isFinite(sourceBytes) && Number(sourceBytes) > conversionCap(input)) {
    throw conversionTooLarge(Number(sourceBytes), conversionCap(input));
  }
  if (Number.isFinite(sourceBytes) && Number(sourceBytes) > MAX_DOCUMENT_BYTES) {
    const error: any = new Error('Document is too large to convert.');
    error.statusCode = 400;
    throw error;
  }

  const conversionId = crypto.randomUUID();
  const startedAt = Date.now();
  const outputRoot = `${CONVERSION_ROOT}/${conversionId}/output`;
  const outputPath = `${outputRoot}/result.${FORMAT_MAP[format].ext}`;
  const storage = bucket();
  const source = storage.file(sourceObjectPath);
  const output = storage.file(outputPath);

  const cleanup = async () => {
    // Only the scratch OUTPUT prefix. The source belongs to the caller.
    await storage.deleteFiles({ prefix: `${outputRoot}/`, force: true }).catch((error: any) => {
      console.error('[document-conversion] output cleanup failed', { conversionId, message: error.message });
    });
  };

  try {
    const [sourceExists] = await source.exists();
    if (!sourceExists) {
      const error: any = new Error('The document to convert was not found.');
      error.statusCode = 404;
      throw error;
    }

    const expires = Date.now() + URL_TTL_MS;
    const [[sourceUrl], [outputUrl]] = await Promise.all([
      source.getSignedUrl({ version: 'v4', action: 'read', expires }),
      output.getSignedUrl({ version: 'v4', action: 'write', expires, contentType: FORMAT_MAP[format].mime }),
    ]);

    const target = workerUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${target}/internal/convert`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await getIdentityToken(process.env.DOCUMENT_WORKER_AUDIENCE || target)}`,
          'Content-Type': 'application/json',
          'X-Conversion-Id': conversionId,
        },
        body: JSON.stringify({
          conversionId,
          inputFilename: safeFilename(inputFilename),
          outputFormat: format,
          sourceUrl,
          outputUrl,
          maxBytes: conversionCap(input),
        }),
        signal: controller.signal,
      });
    } catch {
      // Unreachable, or past our own deadline: nothing is known about the
      // document, so this is "try again", never "the file is bad".
      throw conversionUnavailable();
    } finally {
      clearTimeout(timer);
    }

    if (!response!.ok) throw workerConversionError(response!.status);

    // The worker answering 200 is not proof it wrote anything. Without this the
    // caller is handed a reference to an object that is not there.
    const [meta] = await output.getMetadata();
    const size = Number(meta?.size || 0);
    if (!size || size > MAX_DOCUMENT_BYTES) {
      throw new Error('Document conversion produced an invalid output.');
    }

    console.info('[document-conversion] stored conversion completed', {
      conversionId, outputFormat: format, outputBytes: size, durationMs: Date.now() - startedAt,
    });
    return {
      objectPath: outputPath,
      size,
      contentType: meta?.contentType || FORMAT_MAP[format].mime,
      generation: String(meta?.generation ?? ''),
      cleanup,
    };
  } catch (error: any) {
    await cleanup();
    console.error('[document-conversion] stored conversion failed', {
      conversionId, outputFormat: format, durationMs: Date.now() - startedAt, message: error.message,
    });
    throw conversionError(error);
  }
}

export async function convertDocument(inputBuffer: Buffer, outputFormat = 'pdf', inputFilename = 'source.pdf'): Promise<Buffer> {
  const format = getOutputFormat(outputFormat);
  const adapter = process.env.DOCUMENT_CONVERTER === 'worker' ? 'worker' : 'local';
  const conversionId = crypto.randomUUID();
  const startedAt = Date.now();
  try {
    const result = adapter === 'worker'
      ? await convertWithWorker(inputBuffer, format, inputFilename, conversionId)
      : await convertLocally(inputBuffer, format, inputFilename);
    console.info('[document-conversion] conversion completed', {
      conversionId, adapter, outputFormat: format, inputBytes: inputBuffer.length, outputBytes: result.length, durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error: any) {
    console.error('[document-conversion] conversion failed', {
      conversionId, adapter, outputFormat: format, inputBytes: inputBuffer.length, durationMs: Date.now() - startedAt, message: error.message,
    });
    throw error;
  }
}

export { FORMAT_MAP };

/**
 * Convert a stored document, downloading it first when the worker is not
 * configured.
 *
 * This exists because `DOCUMENT_CONVERTER` defaults to `local` and the switch to
 * `worker` is a deliberate deploy step, so a route cannot simply assume the
 * worker is there. Both paths are here rather than repeated at each call site,
 * so there is ONE place that holds conversion bytes and it says so.
 *
 * In worker mode nothing is downloaded: `convertStoredDocument` signs the object
 * where it is. In local mode the source IS pulled into this process, because
 * `convertLocally` takes a Buffer and there is no other way to reach it. That is
 * the developer default; on a 512 MiB instance serving many callers it is the
 * cost this whole change removes, which is why the worker cutover is what makes
 * the saving real.
 */
export async function convertStoredDocumentOrDownload(
  input: StoredConversionInput,
): Promise<StoredConversionResult> {
  if (process.env.DOCUMENT_CONVERTER === 'worker') {
    return convertStoredDocument(input);
  }

  const { sourceObjectPath, outputFormat = 'pdf', inputFilename = 'source.pdf' } = input;
  const format = getOutputFormat(outputFormat);
  const storage = bucket();

  console.warn('[document-conversion] downloading a source into this process', {
    reason: 'DOCUMENT_CONVERTER is not "worker"',
    sourceObjectPath,
  });

  // Measured before it is read. This adapter holds the whole source in the API
  // process, so the size is the one thing it cannot find out afterwards.
  const [sourceMeta] = await storage.file(sourceObjectPath).getMetadata();
  const sourceSize = Number(sourceMeta?.size || 0);
  if (sourceSize > conversionCap(input)) throw conversionTooLarge(sourceSize, conversionCap(input));

  const [sourceBuffer] = await storage.file(sourceObjectPath).download();
  const converted = await convertLocally(sourceBuffer, format, safeFilename(inputFilename));

  // Written to the same scratch shape the worker path produces, so the caller
  // is handed a reference either way and does not branch on the adapter.
  const conversionId = crypto.randomUUID();
  const outputRoot = `${CONVERSION_ROOT}/${conversionId}/output`;
  const outputPath = `${outputRoot}/result.${FORMAT_MAP[format].ext}`;
  await storage.file(outputPath).save(converted, {
    resumable: false,
    metadata: { contentType: FORMAT_MAP[format].mime },
  });
  // Read back rather than assumed, so the reference this hands out names the
  // version that actually landed, exactly as the worker path does.
  const [outputMeta] = await storage.file(outputPath).getMetadata();

  return {
    objectPath: outputPath,
    size: converted.length,
    contentType: FORMAT_MAP[format].mime,
    generation: String(outputMeta?.generation ?? ''),
    cleanup: async () => {
      await storage.deleteFiles({ prefix: `${outputRoot}/`, force: true }).catch((error: any) => {
        console.error('[document-conversion] output cleanup failed', { conversionId, message: error.message });
      });
    },
  };
}
