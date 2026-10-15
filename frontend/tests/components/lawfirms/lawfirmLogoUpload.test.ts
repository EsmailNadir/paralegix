/**
 * The firm logo, uploaded straight to storage.
 *
 * The upload used to be hand-rolled inside the settings page: a multipart POST
 * to the API with a bearer token, which held the whole image in a container
 * that serves many requests at once. It lives in the service now, and it shares
 * `uploadResumable` with the files and profile-picture paths rather than being
 * a fourth implementation of the same three steps.
 *
 * Two properties are worth pinning here because neither is visible from the
 * page:
 *
 *   The bytes go to the storage session url and that request must NOT carry the
 *   API credential. A signed session url is already the authorization; a bearer
 *   token sends the user's credential to a host that never needed it.
 *
 *   Finalize must not run when the upload failed. Reached anyway it points the
 *   firm's branding at an object that is not there, and reports success.
 */
jest.unmock('@/services/lawfirm.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { installXhrMock, type XhrMock } from '../../support/xhrMock';
import LawFirmService from '@/services/lawfirm.service';

const FIRM = 'firm-1';
const OBJECT_PATH = 'lawfirmids/firm-1/logo/logo.png';
const SESSION_URL = 'https://storage.googleapis.com/upload/logo-session';

let api: ApiMock;
let xhr: XhrMock;

const pngFile = (size = 2048) => {
  const file = new File([new Uint8Array(size)], 'logo.png', { type: 'image/png' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

beforeEach(() => {
  api = installApiMock();
  xhr = installXhrMock();
});

afterEach(() => {
  api.restore();
  xhr.restore();
});

function arrangeSuccess() {
  api.post(`/lawfirms/${FIRM}/logo/upload-init`, { uploadUrl: SESSION_URL, objectPath: OBJECT_PATH });
  xhr.onExact('PUT', SESSION_URL, { status: 200 });
  api.post(`/lawfirms/${FIRM}/logo/upload-finalize`, {
    message: 'Logo uploaded successfully', lawFirm: { id: FIRM, name: 'Brand LLP' },
  });
}

describe('uploading a logo', () => {
  it('returns the updated firm', async () => {
    arrangeSuccess();

    const result = await LawFirmService.uploadLogo(FIRM, pngFile());

    expect(result.lawFirm).toMatchObject({ id: FIRM });
  });

  it('declares the type and size before asking for a session', async () => {
    // The server refuses a bad type or an oversized image here, which saves
    // uploading bytes it is going to throw away.
    arrangeSuccess();

    await LawFirmService.uploadLogo(FIRM, pngFile(4096));

    const [init] = api.callsTo(`/lawfirms/${FIRM}/logo/upload-init`);
    expect(init.body).toMatchObject({ contentType: 'image/png', fileName: 'logo.png', size: 4096 });
  });

  it('sends the bytes to storage, not through the API', async () => {
    arrangeSuccess();

    await LawFirmService.uploadLogo(FIRM, pngFile());

    expect(xhr.calls().some((c) => c.url === SESSION_URL && c.method === 'PUT')).toBe(true);
  });

  it('does not attach the API credential to the storage request', async () => {
    arrangeSuccess();

    await LawFirmService.uploadLogo(FIRM, pngFile());

    const put = xhr.calls().find((c) => c.url === SESSION_URL);
    const headers = Object.keys(put?.headers ?? {}).map((h) => h.toLowerCase());
    expect(headers).not.toContain('authorization');
  });

  it('finalizes with the object path the server chose', async () => {
    arrangeSuccess();

    await LawFirmService.uploadLogo(FIRM, pngFile());

    const [done] = api.callsTo(`/lawfirms/${FIRM}/logo/upload-finalize`);
    expect(done.body).toMatchObject({ objectPath: OBJECT_PATH });
  });
});

describe('when something goes wrong', () => {
  it('does not finalize an upload that failed', async () => {
    // A 410 is the session being gone, which the uploader treats as terminal.
    api.post(`/lawfirms/${FIRM}/logo/upload-init`, { uploadUrl: SESSION_URL, objectPath: OBJECT_PATH });
    xhr.onExact('PUT', SESSION_URL, { status: 410 });
    api.allowUnhandled();

    await expect(LawFirmService.uploadLogo(FIRM, pngFile())).rejects.toThrow();

    expect(api.callsTo(`/lawfirms/${FIRM}/logo/upload-finalize`)).toEqual([]);
  });

  it('surfaces a permission refusal without uploading anything', async () => {
    // `firm.manageBranding` is checked at init. A member without it must not
    // move a single byte.
    api.post(`/lawfirms/${FIRM}/logo/upload-init`, {
      status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' },
    });

    await expect(LawFirmService.uploadLogo(FIRM, pngFile())).rejects.toThrow();

    expect(xhr.calls()).toEqual([]);
  });
});
