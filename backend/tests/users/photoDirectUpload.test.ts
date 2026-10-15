/**
 * The profile picture, uploaded straight to storage.
 *
 * It used to arrive as multipart and sit in the container's heap before the
 * handler ran. One 5 MB picture is nothing; eighty concurrent requests on a
 * 512 MiB instance that is also signing documents is the reason it moved.
 *
 * The bytes now go from the browser to storage. Everything the old route
 * checked has to still happen, and the reason to be careful is that all of it
 * used to run on `req.file`, which no longer exists. A check that quietly runs
 * on nothing passes every test written around a legitimate picture, so the
 * cases here are mostly refusals.
 *
 * The picture also reuses one object path across re-uploads, which is why the
 * finalize step still has to clear the other extensions and the cached URLs. A
 * transport change that dropped that would show as "my new photo did not save".
 */
import {
  createFirm,
  ownerOf,
  testPool,
  type Actor,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects, landUpload, pathsUnder } from '../support/inMemoryBucket';

installInMemoryBucket();

let owner: Actor;

const INIT = '/api/users/me/photo/upload-init';
const FINALIZE = '/api/users/me/photo/upload-finalize';

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The DOS header every Windows executable starts with. */
const EXE_HEAD = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

const init = (body: Record<string, unknown> = {}) =>
  owner.api.post(INIT).send({ contentType: 'image/png', fileName: 'me.png', size: 2048, ...body });

const finalize = (objectPath: string) => owner.api.post(FINALIZE).send({ objectPath });

beforeEach(async () => {
  objects.clear();
  const firm = await createFirm({ name: 'Photo LLP' });
  owner = await ownerOf(firm.id);
});

describe('opening the upload', () => {
  it('hands back a session url and the object it will land at', async () => {
    const res = await init();

    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toMatch(/^https:\/\/upload\.test\//);
    expect(res.body.objectPath).toContain(`users/${owner.uid}/avatar/`);
  });

  it('creates nothing until the browser uploads', async () => {
    await init();

    // A session is not an object. Writing one here would leave every abandoned
    // upload as a stored file nothing points at.
    expect(pathsUnder(`users/${owner.uid}/`)).toEqual([]);
  });

  it('refuses a file type that is not an image', async () => {
    // The old route enforced this in multer's fileFilter. That code is gone, so
    // if this does not hold, the policy is simply absent.
    const res = await init({ contentType: 'application/pdf', fileName: 'resume.pdf' });

    expect(res.status).toBe(415);
  });

  it('refuses a declared size over the 5 MB cap', async () => {
    // Going direct removes the buffering, not the limit.
    const res = await init({ size: 5 * 1024 * 1024 + 1 });

    expect(res.status).toBe(413);
  });
});

describe('finishing the upload', () => {
  it('saves the picture and answers with a url for it', async () => {
    const opened = await init();
    landUpload(opened.body.objectPath, { bytes: 2048, contentType: 'image/png', head: PNG_HEAD });

    const res = await finalize(opened.body.objectPath);

    expect(res.status).toBe(200);
    expect(res.body.photoUrl).toBeTruthy();
    const { rows } = await testPool.query('select photo_object_path from users where id = $1', [owner.uid]);
    expect(rows[0].photo_object_path).toBe(opened.body.objectPath);
  });

  it('refuses when the browser never uploaded', async () => {
    const opened = await init();

    const res = await finalize(opened.body.objectPath);

    expect(res.status).toBe(400);
    const { rows } = await testPool.query('select photo_object_path from users where id = $1', [owner.uid]);
    expect(rows[0].photo_object_path).toBeNull();
  });

  it('enforces the cap on the bytes that actually landed', async () => {
    // The session URL has no size ceiling of its own, so the declared size at
    // init is only a claim. Without this a caller declares 1 KB and PUTs 500 MB.
    const opened = await init({ size: 1024 });
    landUpload(opened.body.objectPath, { bytes: 6 * 1024 * 1024, contentType: 'image/png', head: PNG_HEAD });

    const res = await finalize(opened.body.objectPath);

    expect(res.status).toBe(413);
    expect(objects.has(opened.body.objectPath)).toBe(false);
  });

  it('rejects an executable renamed as a png', async () => {
    // The magic-byte sniff, moved from the request buffer to a ranged read.
    // Dropped, this is stored under the user's avatar path and served.
    const opened = await init();
    landUpload(opened.body.objectPath, { bytes: 2048, contentType: 'image/png', head: EXE_HEAD });

    const res = await finalize(opened.body.objectPath);

    expect(res.status).toBe(415);
    expect(objects.has(opened.body.objectPath)).toBe(false);
  });

  it('rejects bytes that landed as a type the route does not accept', async () => {
    const opened = await init();
    landUpload(opened.body.objectPath, { bytes: 2048, contentType: 'text/html', head: Buffer.alloc(8) });

    const res = await finalize(opened.body.objectPath);

    expect(res.status).toBe(415);
  });

  it('will not let one user finalize another user own upload', async () => {
    // Same avatar folder is impossible, so this aims at the general rule: the
    // object carries who opened it, and a different caller cannot adopt it.
    const opened = await init();
    landUpload(opened.body.objectPath, {
      bytes: 2048, contentType: 'image/png', head: PNG_HEAD, custom: { uploadedBy: 'someone-else' },
    });

    const res = await finalize(opened.body.objectPath);

    expect(res.status).toBe(403);
  });

  it('refuses an object path outside the caller own avatar folder', async () => {
    // The path arrives from the client at finalize. Trusted, it is a way to
    // point the user row at any object in the bucket.
    const opened = await init();
    landUpload(opened.body.objectPath, { bytes: 2048, contentType: 'image/png', head: PNG_HEAD });
    landUpload('lawfirmids/other/objects/secret.pdf', { bytes: 10, contentType: 'image/png', head: PNG_HEAD });

    const res = await finalize('lawfirmids/other/objects/secret.pdf');

    expect(res.status).toBeGreaterThanOrEqual(400);
    const { rows } = await testPool.query('select photo_object_path from users where id = $1', [owner.uid]);
    expect(rows[0].photo_object_path).not.toBe('lawfirmids/other/objects/secret.pdf');
  });

  it('clears an avatar left at another extension by an earlier upload', async () => {
    // The path is reused per extension, so a jpg then a png leaves two objects
    // and the wrong one can win. The old route deleted the leftovers and so
    // must this one.
    const first = await init({ contentType: 'image/jpeg', fileName: 'me.jpg' });
    landUpload(first.body.objectPath, { bytes: 100, contentType: 'image/jpeg', head: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]) });
    await finalize(first.body.objectPath);

    const second = await init({ contentType: 'image/png', fileName: 'me.png' });
    landUpload(second.body.objectPath, { bytes: 100, contentType: 'image/png', head: PNG_HEAD });
    await finalize(second.body.objectPath);

    expect(pathsUnder(`users/${owner.uid}/avatar/`)).toEqual([second.body.objectPath]);
  });
});
