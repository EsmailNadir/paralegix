/**
 * The Word-first editor reaches upload-docx and replace-source through
 * wordTemplatesService, which turns a failed answer into a thrown error.
 *
 * The editor treats an ordinary upload failure as non-fatal and carries on
 * importing without the stored .docx. A refusal from the client-details check
 * must NOT be treated that way: carrying on puts the same client text into the
 * editor's copy with no warning. The service is where the two are told apart,
 * so this pins it: a marked refusal becomes a ClientTextCheckError (with the
 * leftovers when there are some), and anything else stays an ordinary error.
 */
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { installXhrMock, type XhrMock } from '../../support/xhrMock';
import { ClientTextCheckError, wordTemplatesService } from '@/services/wordTemplates.service';

const BASE = '/api/lawfirms/firm/word-templates';
const SESSION = 'https://storage.example/upload';
const file = new File([new Uint8Array([1])], 'precedent.docx');
const leftover = {
  literal: 'Quillon Vantress',
  canonicalId: 'client_name',
  occurrences: 1,
  contextSnippet: 'Quillon Vantress',
  parts: ['body' as const],
};

let api: ApiMock;
let xhr: XhrMock;

beforeEach(() => {
  api = installApiMock();
  xhr = installXhrMock();
  api.postExact(`${BASE}/upload-init`, { uploadUrl: SESSION, objectPath: 'obj/precedent.docx', contentType: 'application/octet-stream' });
  xhr.onExact('PUT', SESSION, { status: 200 });
});

afterEach(() => {
  api.restore();
  xhr.restore();
});

async function thrown(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
}

describe('word templates service: client-details refusals', () => {
  it('carries the leftovers on a refusal that found client details', async () => {
    api.postExact(`${BASE}/upload-docx`, { status: 409, body: { error: 'held', code: 'TEMPLATE_CLIENT_TEXT', details: { clientTextRefused: true, leftovers: [leftover] } } });
    const err = await thrown(wordTemplatesService.uploadDocxTemplate('firm', file, 'precedent'));
    expect(err).toBeInstanceOf(ClientTextCheckError);
    expect((err as ClientTextCheckError).leftovers).toEqual([leftover]);
  });

  it('marks a refusal that could not check, with no leftovers to ask about', async () => {
    api.postExact(`${BASE}/tpl-1/replace-source`, { status: 403, body: { error: 'Ask an admin to save it.', code: 'TEMPLATE_CLIENT_TEXT_UNCHECKABLE', details: { clientTextRefused: true } } });
    const err = await thrown(wordTemplatesService.replaceDocx('firm', 'tpl-1', file));
    expect(err).toBeInstanceOf(ClientTextCheckError);
    expect((err as ClientTextCheckError).leftovers).toBeNull();
    expect(err.message).toBe('Ask an admin to save it.');
  });

  it('leaves an ordinary failure a plain error', async () => {
    api.postExact(`${BASE}/upload-docx`, { status: 500, body: { error: 'Storage upload failed.' } });
    const err = await thrown(wordTemplatesService.uploadDocxTemplate('firm', file, 'precedent'));
    expect(err).not.toBeInstanceOf(ClientTextCheckError);
    expect(err.message).toBe('Storage upload failed.');
  });

  it('sends the acknowledged values with the retry', async () => {
    api.postExact(`${BASE}/upload-docx`, { status: 500, body: { error: 'x' } });
    await thrown(
      wordTemplatesService.uploadDocxTemplate('firm', file, 'precedent', { acknowledgedLeftovers: ['Quillon Vantress'] }),
    );
    const body = api.callsTo(`${BASE}/upload-docx`).at(-1)!.body as { acknowledgedLeftovers?: string[] };
    expect(body.acknowledgedLeftovers).toEqual(['Quillon Vantress']);
  });
});
