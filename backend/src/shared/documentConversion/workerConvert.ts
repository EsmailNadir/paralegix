/**
 * One conversion command, as the document worker runs it: fetch the source from
 * its signed URL, convert it, PUT the result to its signed URL.
 *
 * What matters here is the STATUS a failure carries, because the API turns it
 * into what the person is told (`workerConversionError`):
 *
 *   422: the document itself could not be converted. Retrying will not help.
 *   503: the worker could not reach storage, or LibreOffice is unavailable.
 *        The same file may well convert on a later try.
 *   400: a command the API should never have sent.
 *
 * The converter is passed in rather than imported, so LibreOffice stays reached
 * from exactly the worker entry point and the API's adapter switch.
 */
import { FORMAT_MAP, getOutputFormat, isSignedStorageUrl } from './contract';

export class WorkerCommandError extends Error {
  constructor(message: string, readonly status: 400 | 422 | 503) {
    super(message);
  }
}

const invalid = () => new WorkerCommandError('Invalid conversion command.', 400);
const storageUnavailable = (message: string) => new WorkerCommandError(message, 503);

async function reachStorage(url: string, init: RequestInit | undefined, failure: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw storageUnavailable(failure);
  }
  if (!response.ok) throw storageUnavailable(failure);
  return response;
}

export async function executeConvertCommand(
  command: any,
  conversionId: string,
  convert: (input: Buffer, format: string, fileName: string) => Promise<Buffer>,
  maxDocumentBytes: number,
) {
  if (!/^[0-9a-f-]{36}$/i.test(String(conversionId)) || command?.conversionId !== conversionId) throw invalid();
  if (!isSignedStorageUrl(command.sourceUrl) || !isSignedStorageUrl(command.outputUrl)) throw invalid();
  if (typeof command.inputFilename !== 'string' || command.inputFilename !== command.inputFilename.replace(/[^a-zA-Z0-9._-]/g, '_')) throw invalid();
  if (!Number.isInteger(command.maxBytes) || command.maxBytes < 1 || command.maxBytes > maxDocumentBytes) throw invalid();
  let format: string;
  try {
    format = getOutputFormat(command.outputFormat);
  } catch {
    throw invalid();
  }

  const source = await reachStorage(command.sourceUrl, undefined, 'Source document is unavailable.');
  const input = Buffer.from(await source.arrayBuffer());
  if (!input.length || input.length > command.maxBytes) {
    throw new WorkerCommandError('Source document exceeds the allowed size.', 422);
  }

  let result: Buffer;
  try {
    result = await convert(input, format, command.inputFilename);
  } catch (error: any) {
    throw new WorkerCommandError(error?.message || 'Conversion failed.', error?.statusCode === 503 ? 503 : 422);
  }
  if (!result.length || result.length > command.maxBytes) {
    throw new WorkerCommandError('Converted document exceeds the allowed size.', 422);
  }

  await reachStorage(command.outputUrl, {
    method: 'PUT',
    headers: { 'Content-Type': FORMAT_MAP[format as keyof typeof FORMAT_MAP].mime },
    body: new Uint8Array(result),
  }, 'Unable to store converted document.');

  return { format, inputBytes: input.length, outputBytes: result.length };
}
