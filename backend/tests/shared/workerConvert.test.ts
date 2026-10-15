/**
 * The status the document worker answers a conversion with.
 *
 * The API reads it to decide what the person is told: 422 is "this document
 * could not be converted" (it is corrupt, protected or not what it claims), and
 * anything else is "conversion is temporarily unavailable, try again". The
 * worker used to answer 422 for everything, including its own failures to
 * reach storage, so a network blip told the person their document was corrupt,
 * and until the API read 422 correctly a corrupt document told them to retry.
 */
import { conversionFailed, conversionUnavailable } from '../../src/shared/documentConversion/contract';
import { executeConvertCommand } from '../../src/shared/documentConversion/workerConvert';

const MB = 1024 * 1024;
const CONVERSION_ID = '0b4a1c9e-3f59-4c1f-9a51-2d2f3b7e8a10';
const signed = (objectPath: string) =>
  `https://storage.googleapis.com/lawfirms/${objectPath}?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Expires=90&X-Goog-Signature=abc`;

const command = () => ({
  conversionId: CONVERSION_ID,
  inputFilename: 'contract.docx',
  outputFormat: 'pdf',
  sourceUrl: signed('document-conversion/c/input/contract.docx'),
  outputUrl: signed('document-conversion/c/output/result.pdf'),
  maxBytes: 25 * MB,
});

const originalFetch = global.fetch;
let uploaded: Buffer | undefined;

/** Storage as the worker reaches it: the source, and the PUT of the result. */
function storage({ source = 200, put = 200, down = false }: { source?: number; put?: number; down?: boolean } = {}) {
  uploaded = undefined;
  global.fetch = jest.fn(async (_url: string, init: any = {}) => {
    if (down) throw new TypeError('fetch failed');
    if (init.method === 'PUT') {
      uploaded = Buffer.from(init.body);
      return new Response(null, { status: put });
    }
    return new Response(source === 200 ? new Uint8Array(Buffer.from('docx bytes')) : 'gone', { status: source });
  }) as never;
}

const converts = async () => Buffer.from('%PDF-1.7 converted');

afterEach(() => {
  global.fetch = originalFetch;
});

it('converts, stores the result, and reports the sizes', async () => {
  storage();

  const result = await executeConvertCommand(command(), CONVERSION_ID, converts, 100 * MB);

  expect(uploaded?.toString()).toBe('%PDF-1.7 converted');
  expect(result).toEqual({ format: 'pdf', inputBytes: 10, outputBytes: 18 });
});

it('answers 422 when LibreOffice cannot convert the document', async () => {
  storage();

  await expect(executeConvertCommand(command(), CONVERSION_ID, async () => { throw conversionFailed(); }, 100 * MB))
    .rejects.toMatchObject({ status: 422 });
});

it('answers 503 when LibreOffice itself is not available', async () => {
  storage();

  await expect(executeConvertCommand(command(), CONVERSION_ID, async () => { throw conversionUnavailable(); }, 100 * MB))
    .rejects.toMatchObject({ status: 503 });
});

it.each([
  ['the source cannot be read', { source: 500 }],
  ['the result cannot be stored', { put: 403 }],
  ['storage cannot be reached at all', { down: true }],
])('answers 503 when %s, which is not the document\'s fault', async (_case, options) => {
  storage(options);

  await expect(executeConvertCommand(command(), CONVERSION_ID, converts, 100 * MB))
    .rejects.toMatchObject({ status: 503 });
});

it('answers 400 for a command the API should never have sent', async () => {
  storage();

  await expect(executeConvertCommand({ ...command(), sourceUrl: 'https://evil.test/a.docx?X-Goog-Expires=60' }, CONVERSION_ID, converts, 100 * MB))
    .rejects.toMatchObject({ status: 400 });
  await expect(executeConvertCommand(command(), 'not-the-header-id', converts, 100 * MB))
    .rejects.toMatchObject({ status: 400 });
});
