/**
 * The firm logo, uploaded straight to storage.
 *
 * Same move as the profile picture and for the same reason: the file used to
 * sit in the container's heap before the handler ran, on an instance that
 * serves 80 concurrent requests on 512 MiB and signs documents at the same
 * time.
 *
 * The logo has one check the profile picture does not, and it is the one worth
 * guarding hardest. Uploading it needs `firm.manageBranding`. That permission
 * sat on a route that no longer exists, so it has to sit on BOTH new routes:
 * a finalize anyone can reach is a way to change a firm's branding without the
 * permission, and it is reachable by anyone who can guess an object path.
 *
 * The rest mirrors the picture: the size and type rules apply to what storage
 * recorded, not to what the caller declared, because a resumable session URL
 * enforces neither.
 */
import {
  createFirm,
  memberWith,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects, landUpload, pathsUnder } from '../support/inMemoryBucket';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;
/** A member of the same firm with every permission EXCEPT branding. */
let plainMember: Actor;
/** An owner of a different firm. */
let outsider: Actor;

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EXE_HEAD = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

const initPath = (id: string) => `/api/lawfirms/${id}/logo/upload-init`;
const finalizePath = (id: string) => `/api/lawfirms/${id}/logo/upload-finalize`;

const init = (actor: Actor, body: Record<string, unknown> = {}, id = firm.id) =>
  actor.api.post(initPath(id)).send({ contentType: 'image/png', fileName: 'logo.png', size: 2048, ...body });

const finalize = (actor: Actor, objectPath: string, id = firm.id) =>
  actor.api.post(finalizePath(id)).send({ objectPath });

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Brand LLP' });
  owner = await ownerOf(firm.id);
  plainMember = await memberWith(firm.id, ['matters.view']);
  const other = await createFirm({ name: 'Other LLP' });
  outsider = await ownerOf(other.id);
});

describe('who may change the branding', () => {
  it('lets an owner open the upload', async () => {
    const res = await init(owner);

    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toBeTruthy();
  });

  it('refuses a member without the branding permission at init', async () => {
    const res = await init(plainMember);

    expect(res.status).toBe(403);
  });

  it('refuses a member without the branding permission at FINALIZE', async () => {
    // The permission used to sit on one route. Split in two, a finalize that
    // does not carry it is a way to change the firm's branding without it.
    const opened = await init(owner);
    landUpload(opened.body.objectPath, { bytes: 2048, contentType: 'image/png', head: PNG_HEAD });

    const res = await finalize(plainMember, opened.body.objectPath);

    expect(res.status).toBe(403);
  });

  it('refuses another firm owner on both steps', async () => {
    expect((await init(outsider)).status).toBe(403);
    expect((await finalize(outsider, `lawfirmids/${firm.id}/logo/logo.png`)).status).toBe(403);
  });
});

describe('opening the upload', () => {
  it('lands the logo under the firm own folder', async () => {
    const res = await init(owner);

    expect(res.body.objectPath).toBe(`lawfirmids/${firm.id}/logo/logo.png`);
  });

  it('creates nothing until the browser uploads', async () => {
    await init(owner);

    expect(pathsUnder(`lawfirmids/${firm.id}/logo/`)).toEqual([]);
  });

  it('refuses a type that is not an image', async () => {
    const res = await init(owner, { contentType: 'application/pdf', fileName: 'brochure.pdf' });

    expect(res.status).toBe(415);
  });

  it('keeps the 5 MB cap', async () => {
    // Going direct removes the buffering, not the limit.
    const res = await init(owner, { size: 5 * 1024 * 1024 + 1 });

    expect(res.status).toBe(413);
  });
});

describe('finishing the upload', () => {
  it('saves the logo and answers with the firm', async () => {
    const opened = await init(owner);
    landUpload(opened.body.objectPath, { bytes: 2048, contentType: 'image/png', head: PNG_HEAD });

    const res = await finalize(owner, opened.body.objectPath);

    expect(res.status).toBe(200);
    expect(res.body.lawFirm).toBeTruthy();
    const { rows } = await testPool.query('select logo_object_path from law_firms where id = $1', [firm.id]);
    expect(rows[0].logo_object_path).toBe(opened.body.objectPath);
  });

  it('refuses when the browser never uploaded', async () => {
    const opened = await init(owner);

    const res = await finalize(owner, opened.body.objectPath);

    expect(res.status).toBe(400);
  });

  it('enforces the cap on the bytes that landed', async () => {
    const opened = await init(owner, { size: 1024 });
    landUpload(opened.body.objectPath, { bytes: 6 * 1024 * 1024, contentType: 'image/png', head: PNG_HEAD });

    const res = await finalize(owner, opened.body.objectPath);

    expect(res.status).toBe(413);
    expect(objects.has(opened.body.objectPath)).toBe(false);
  });

  it('rejects an executable renamed as a png', async () => {
    const opened = await init(owner);
    landUpload(opened.body.objectPath, { bytes: 2048, contentType: 'image/png', head: EXE_HEAD });

    const res = await finalize(owner, opened.body.objectPath);

    expect(res.status).toBe(415);
    expect(objects.has(opened.body.objectPath)).toBe(false);
  });

  it('refuses an object path outside this firm logo folder', async () => {
    // The path comes from the client. Trusted, it points the firm's branding at
    // any object in the bucket, including another firm's document.
    landUpload(`lawfirmids/${firm.id}/objects/contract.pdf`, {
      bytes: 10, contentType: 'image/png', head: PNG_HEAD,
    });

    const res = await finalize(owner, `lawfirmids/${firm.id}/objects/contract.pdf`);

    expect(res.status).toBeGreaterThanOrEqual(400);
    const { rows } = await testPool.query('select logo_object_path from law_firms where id = $1', [firm.id]);
    // Null, because nothing was ever saved. Asserted as "not that path" rather
    // than "is null" so the case still holds once a logo exists first.
    expect(String(rows[0].logo_object_path ?? '')).not.toContain('contract.pdf');
  });

  it('refuses another firm object path even from its own owner', async () => {
    // The firm in the route and the firm in the path must be the same one.
    const opened = await init(owner);
    landUpload(opened.body.objectPath, { bytes: 2048, contentType: 'image/png', head: PNG_HEAD });

    const res = await finalize(owner, `lawfirmids/${outsider.uid}/logo/logo.png`);

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('clears a logo left at another extension by an earlier upload', async () => {
    const first = await init(owner, { contentType: 'image/jpeg', fileName: 'logo.jpg' });
    landUpload(first.body.objectPath, {
      bytes: 100, contentType: 'image/jpeg', head: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]),
    });
    await finalize(owner, first.body.objectPath);

    const second = await init(owner, { contentType: 'image/png', fileName: 'logo.png' });
    landUpload(second.body.objectPath, { bytes: 100, contentType: 'image/png', head: PNG_HEAD });
    await finalize(owner, second.body.objectPath);

    expect(pathsUnder(`lawfirmids/${firm.id}/logo/`)).toEqual([second.body.objectPath]);
  });
});
