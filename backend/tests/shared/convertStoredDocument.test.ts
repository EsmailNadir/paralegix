/**
 * Converting a document that is already in storage.
 *
 * `convertDocument` takes a Buffer, and in worker mode it saves that whole
 * buffer to storage itself before calling the worker. So the API holds the
 * entire input even though another service does the work: the bytes arrive as
 * multipart, sit in a 512 MiB container that serves eighty concurrent requests,
 * and are then written out again.
 *
 * `convertStoredDocument` takes an object path instead. The upload already put
 * the bytes in storage, so the API signs a read url for the object where it
 * already is and never touches the content.
 *
 * Two things it must get right, and both are about objects that are not its own:
 *
 *   It must NOT delete the caller's source object during cleanup. The buffer
 *   path wrote its input into a scratch prefix and removed the whole prefix
 *   afterwards; pointing that same cleanup at a caller's object destroys the
 *   document that was uploaded.
 *
 *   It must return a reference, not bytes. Downloading the result to hand it
 *   back would put the output in the process instead of the input, which moves
 *   the problem rather than removing it.
 */
const save = jest.fn();
const getSignedUrl = jest.fn();
const getMetadata = jest.fn();
const exists = jest.fn();
const deleteFiles = jest.fn();
const download = jest.fn();
const file = jest.fn((path: string) => ({
  name: path, save, getSignedUrl, getMetadata, exists, download,
}));

jest.mock('../../src/shared/database/firebase', () => ({
  admin: { storage: () => ({ bucket: () => ({ file, deleteFiles }) }) },
}));

const convertLocally = jest.fn();
jest.mock('../../src/shared/documentConversion/localConverter', () => ({
  convertLocally: (...a: unknown[]) => convertLocally.apply(null, a as []),
}));

import { convertDocument, convertStoredDocument, convertStoredDocumentOrDownload } from '../../src/shared/documentConversion/converter';

const SOURCE = 'lawfirmids/firm-1/objects/contract.docx';
const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DOCUMENT_CONVERTER = 'worker';
  process.env.DOCUMENT_WORKER_URL = 'https://worker.test';
  process.env.DOCUMENT_WORKER_ID_TOKEN = 'test-token';
  getSignedUrl.mockResolvedValue(['https://signed.test/url']);
  exists.mockResolvedValue([true]);
  getMetadata.mockResolvedValue([{ size: '4096', contentType: 'application/pdf' }]);
  deleteFiles.mockResolvedValue(undefined);
  global.fetch = jest.fn(async () => ({ ok: true, status: 200 })) as never;
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.DOCUMENT_CONVERTER;
  delete process.env.DOCUMENT_WORKER_URL;
  delete process.env.DOCUMENT_WORKER_ID_TOKEN;
});

describe('what it hands the worker', () => {
  it('signs the caller own object rather than copying it', async () => {
    await convertStoredDocument({ sourceObjectPath: SOURCE, outputFormat: 'pdf', inputFilename: 'contract.docx' });

    // A copy would mean reading the object into this process and writing it out
    // again, which is the whole cost being removed.
    expect(save).not.toHaveBeenCalled();
    expect(file).toHaveBeenCalledWith(SOURCE);
  });

  it('gives the worker a read url for the source and a write url for the result', async () => {
    await convertStoredDocument({ sourceObjectPath: SOURCE, outputFormat: 'pdf', inputFilename: 'contract.docx' });

    const actions = getSignedUrl.mock.calls.map(([opts]: any[]) => opts.action);
    expect(actions).toEqual(expect.arrayContaining(['read', 'write']));
  });

  it('returns a reference to the output, not its bytes', async () => {
    const result = await convertStoredDocument({
      sourceObjectPath: SOURCE, outputFormat: 'pdf', inputFilename: 'contract.docx',
    });

    // Downloading the result to return it would put the OUTPUT in the process
    // instead of the input. That moves the problem rather than removing it.
    expect(result.objectPath).toEqual(expect.any(String));
    expect(result.size).toBe(4096);
    expect(Buffer.isBuffer(result as never)).toBe(false);
  });
});

describe('cleanup', () => {
  it('never deletes the caller source object', async () => {
    // The buffer path wrote its input into a scratch prefix and removed the
    // whole prefix afterwards. Pointed at a caller's object, that same cleanup
    // destroys the document they just uploaded.
    await convertStoredDocument({ sourceObjectPath: SOURCE, outputFormat: 'pdf', inputFilename: 'contract.docx' });

    for (const [opts] of deleteFiles.mock.calls) {
      expect(SOURCE.startsWith(opts.prefix)).toBe(false);
    }
  });

  it('cleans up its own scratch output even when the worker fails', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 })) as never;

    await convertStoredDocument({
      sourceObjectPath: SOURCE, outputFormat: 'pdf', inputFilename: 'contract.docx',
    }).catch(() => {});

    expect(deleteFiles).toHaveBeenCalled();
  });
});

describe('refusals', () => {
  it('refuses a source that is not there', async () => {
    exists.mockResolvedValue([false]);

    await expect(convertStoredDocument({
      sourceObjectPath: SOURCE, outputFormat: 'pdf', inputFilename: 'contract.docx',
    })).rejects.toThrow();
  });

  it('refuses an output the worker did not produce', async () => {
    // A worker that answered 200 without writing anything would otherwise leave
    // the caller with a reference to an object that is not there.
    getMetadata.mockRejectedValue(Object.assign(new Error('No such object'), { code: 404 }));

    await expect(convertStoredDocument({
      sourceObjectPath: SOURCE, outputFormat: 'pdf', inputFilename: 'contract.docx',
    })).rejects.toThrow();
  });

  it('refuses an empty output', async () => {
    getMetadata.mockResolvedValue([{ size: '0', contentType: 'application/pdf' }]);

    await expect(convertStoredDocument({
      sourceObjectPath: SOURCE, outputFormat: 'pdf', inputFilename: 'contract.docx',
    })).rejects.toThrow();
  });

  it('refuses a source larger than the converter accepts', async () => {
    await expect(convertStoredDocument({
      sourceObjectPath: SOURCE,
      outputFormat: 'pdf',
      inputFilename: 'contract.docx',
      sourceBytes: 200 * 1024 * 1024,
    })).rejects.toThrow(/too large/i);

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('the local adapter', () => {
  it('says plainly that it holds the bytes, and is not the deployed path', async () => {
    // The local adapter has no way to read from storage: `convertLocally` takes
    // a Buffer. So this path DOES download the source into the process. It is
    // the developer default, and production runs the worker; the refusal to
    // pretend otherwise is the point of this case.
    process.env.DOCUMENT_CONVERTER = 'local';

    await expect(convertStoredDocument({
      sourceObjectPath: SOURCE, outputFormat: 'pdf', inputFilename: 'contract.docx',
    })).rejects.toThrow(/worker/i);
  });
});

describe('a caller cap on the conversion input', () => {
  // Signing converts at most 25 MiB. The converter's own ceiling is 100 MiB, so
  // without the caller's cap a signing preparation could hand it four times
  // what signing accepts, and the local adapter would download all of it into
  // the API process before converting.
  const CAP = 25 * 1024 * 1024;

  it('refuses a local conversion above the cap before reading a byte', async () => {
    process.env.DOCUMENT_CONVERTER = 'local';
    getMetadata.mockResolvedValue([{ size: String(CAP + 1), contentType: 'application/msword' }]);

    await expect(convertStoredDocumentOrDownload({ sourceObjectPath: SOURCE, maxBytes: CAP }))
      .rejects.toMatchObject({ statusCode: 413, code: 'CONVERSION_TOO_LARGE' });
    expect(download).not.toHaveBeenCalled();
    expect(convertLocally).not.toHaveBeenCalled();
  });

  it('refuses a worker conversion above the cap before calling the worker', async () => {
    await expect(convertStoredDocument({ sourceObjectPath: SOURCE, sourceBytes: CAP + 1, maxBytes: CAP }))
      .rejects.toMatchObject({ statusCode: 413, code: 'CONVERSION_TOO_LARGE' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('what the person is told when the worker cannot convert', () => {
  // The worker answers 422 when LibreOffice fails on the document itself: it is
  // corrupt, password-protected or not really the format it claims. Telling
  // that person the service is "temporarily unavailable" sends them to retry a
  // file that will fail every time.
  const CANNOT_CONVERT = 'This document could not be converted. It may be corrupt, password-protected, or in an unsupported format.';

  it('says the document could not be converted when the worker refuses it', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 422 })) as never;

    await expect(convertStoredDocument({ sourceObjectPath: SOURCE, outputFormat: 'pdf', inputFilename: 'contract.docx' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'CONVERSION_FAILED', message: CANNOT_CONVERT });
    await expect(convertDocument(Buffer.from('not really a docx'), 'pdf', 'contract.docx'))
      .rejects.toMatchObject({ statusCode: 422, code: 'CONVERSION_FAILED', message: CANNOT_CONVERT });
  });

  it('keeps "temporarily unavailable" for a worker that is down or erroring', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 })) as never;

    await expect(convertStoredDocument({ sourceObjectPath: SOURCE, outputFormat: 'pdf', inputFilename: 'contract.docx' }))
      .rejects.toMatchObject({ statusCode: 503, code: 'CONVERSION_UNAVAILABLE', message: expect.stringMatching(/temporarily unavailable/i) });
    await expect(convertDocument(Buffer.from('docx'), 'pdf', 'contract.docx'))
      .rejects.toMatchObject({ statusCode: 503, code: 'CONVERSION_UNAVAILABLE' });
  });

  it('says "temporarily unavailable" when the worker cannot be reached at all', async () => {
    // A network failure or the API's own timeout on the call: nothing is known
    // about the document, so it must not be called corrupt.
    global.fetch = jest.fn(async () => { throw new TypeError('fetch failed'); }) as never;

    await expect(convertStoredDocument({ sourceObjectPath: SOURCE, outputFormat: 'pdf', inputFilename: 'contract.docx' }))
      .rejects.toMatchObject({ statusCode: 503, code: 'CONVERSION_UNAVAILABLE' });
    await expect(convertDocument(Buffer.from('docx'), 'pdf', 'contract.docx'))
      .rejects.toMatchObject({ statusCode: 503, code: 'CONVERSION_UNAVAILABLE' });
  });
});

