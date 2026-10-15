/**
 * The profile picture, uploaded straight to storage.
 *
 * The service used to POST the file as multipart to the API, which buffered the
 * whole picture in a 512 MiB container that serves 80 concurrent requests and
 * signs documents at the same time. It now asks for a session, PUTs the bytes
 * to storage, and tells the API where they landed.
 *
 * The component's call is unchanged on purpose: `setPhoto(file)` still resolves
 * to `{ photoUrl }`. What changed is underneath, and two things there are worth
 * pinning because neither is visible from the component:
 *
 *   The bytes must go to the storage session url, NOT to the API, and that one
 *   request must not carry the user's API credential. A signed session url is
 *   already the authorization; attaching a bearer token to a third-party host
 *   sends the credential somewhere it was never meant to go.
 *
 *   Finalize must be reached with the object path the server chose, not one the
 *   client made up, and must not run at all when the upload failed. Finalizing
 *   after a failed PUT points the profile at an object that is not there.
 */
jest.unmock('@/services/users.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { installXhrMock, type XhrMock } from '../../support/xhrMock';
import userService from '@/services/users.service';

const OBJECT_PATH = 'users/user-1/avatar/avatar.png';
const SESSION_URL = 'https://storage.googleapis.com/upload/session-1';

let api: ApiMock;
let xhr: XhrMock;

const pngFile = (size = 2048) => {
  const file = new File([new Uint8Array(size)], 'me.png', { type: 'image/png' });
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

/** The happy path: a session, a successful PUT, and a finalize. */
function arrangeSuccess(photoUrl = 'https://signed.example/avatar.png') {
  api.post('/users/me/photo/upload-init', { uploadUrl: SESSION_URL, objectPath: OBJECT_PATH });
  xhr.onExact('PUT', SESSION_URL, { status: 200 });
  api.post('/users/me/photo/upload-finalize', { message: 'Profile picture updated', photoUrl });
}

describe('uploading a profile picture', () => {
  it('returns the url the server minted', async () => {
    arrangeSuccess('https://signed.example/new.png');

    const result = await userService.setPhoto(pngFile());

    expect(result.photoUrl).toBe('https://signed.example/new.png');
  });

  it('tells the server the type and size before asking for a session', async () => {
    // The server refuses a bad type or an oversized picture here, which saves
    // uploading bytes it is going to throw away.
    arrangeSuccess();

    await userService.setPhoto(pngFile(4096));

    const [init] = api.callsTo('/users/me/photo/upload-init');
    expect(init.body).toMatchObject({ contentType: 'image/png', fileName: 'me.png', size: 4096 });
  });

  it('sends the bytes to storage, not through the API', async () => {
    // The whole point. A multipart POST to the API puts the picture back in the
    // container's heap.
    arrangeSuccess();

    await userService.setPhoto(pngFile());

    expect(xhr.calls().some((call) => call.url === SESSION_URL && call.method === 'PUT')).toBe(true);
    expect(api.callsTo('/users/me/photo').filter((c) => !c.url.includes('upload-'))).toEqual([]);
  });

  it('does not attach the API credential to the storage request', async () => {
    // A signed session url IS the authorization. Adding a bearer token sends
    // the user's API credential to a host that never needed it.
    arrangeSuccess();

    await userService.setPhoto(pngFile());

    const put = xhr.calls().find((call) => call.url === SESSION_URL);
    const headers = Object.keys(put?.headers ?? {}).map((h) => h.toLowerCase());
    expect(headers).not.toContain('authorization');
  });

  it('finalizes with the object path the server chose', async () => {
    arrangeSuccess();

    await userService.setPhoto(pngFile());

    const [done] = api.callsTo('/users/me/photo/upload-finalize');
    expect(done.body).toMatchObject({ objectPath: OBJECT_PATH });
  });
});

describe('when something goes wrong', () => {
  it('does not finalize an upload that failed', async () => {
    // A 410 is the session being gone, which the uploader treats as terminal
    // rather than retrying. Finalizing anyway points the profile at an object
    // that is not there, and tells the user their picture saved.
    api.post('/users/me/photo/upload-init', { uploadUrl: SESSION_URL, objectPath: OBJECT_PATH });
    xhr.onExact('PUT', SESSION_URL, { status: 410 });
    api.allowUnhandled();

    await expect(userService.setPhoto(pngFile())).rejects.toThrow();

    expect(api.callsTo('/users/me/photo/upload-finalize')).toEqual([]);
  });

  it('surfaces a server refusal at init without uploading anything', async () => {
    // An oversized or wrong-typed picture is refused before the bytes move.
    api.post('/users/me/photo/upload-init', {
      status: 415, body: { error: 'File type not allowed', code: 'FILE_TYPE_NOT_ALLOWED' },
    });

    await expect(userService.setPhoto(pngFile())).rejects.toThrow();

    expect(xhr.calls()).toEqual([]);
  });
});
