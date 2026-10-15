/**
 * Handing the browser a URL instead of the bytes.
 *
 * A single-file download used to be read through the API and written to the
 * response, so every download put a whole document in a 512 MiB container that
 * is also sealing PDFs, for as long as the client's connection lasted. The URL
 * removes all of that and moves one problem: it outlives the request that
 * minted it and needs no credential to use, so everything that limits it has to
 * be baked in at the moment it is signed.
 *
 * Three things do that here, and each case below breaks exactly one.
 *
 * THE GATE. Nothing is signed before `assertFileReadAccess` has passed, so a
 * refusal cannot leave a usable URL behind. The refusal cases assert that
 * NOTHING was signed, not merely that the response was a 4xx: a URL that was
 * minted and then discarded is still a URL that existed.
 *
 * THE GENERATION. The URL names one version of the object. Without it, a
 * document replaced after the caller was authorized is served under a URL that
 * was legitimately issued, and nothing anywhere reports it.
 *
 * THE DISPOSITION. Attachment, always. This is the Download button, not the
 * preview, and `dispositionFor` answers `inline` for a PDF, which would open
 * the document in a tab instead of saving it.
 */
import {
  createFirm,
  memberWith,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { objects, putObject, signedUrlCalls } from '../support/inMemoryBucket';
import { installRichBucket, resetRichBucket } from './richBucket';
import { joinMatter, rootOf, seedFile, seedFolder, seedMatter } from './fileWorld';

installRichBucket();

let firm: Firm;
let owner: Actor;
let matterId: string;
let matterRoot: string;

const F = (id: string) => `/api/lawfirms/${id}/files`;

const downloadUrl = (fileId: string, actor: Actor = owner, lawFirmId = firm.id) => actor.api
  .get(`${F(lawFirmId)}/download-url?lawFirmId=${lawFirmId}&fileId=${fileId}`);

beforeEach(async () => {
  resetRichBucket();
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Hollis v. Denton');
  matterRoot = await rootOf(firm.id, { matterId });
});

// ---------------------------------------------------------------------------

describe('minting a download URL', () => {
  it('pins the version of the document the caller was authorized for', async () => {
    const deed = await seedFile(firm.id, { parentId: matterRoot, name: 'Deed.pdf', bytes: 2048 });
    const generation = objects.get(deed.objectPath)!.generation;

    const res = await downloadUrl(deed.id);

    expect(res.status).toBe(200);
    expect(res.body.generation).toBe(generation);
    // The generation has to reach the URL. Reading it, reporting it, and then
    // signing an unpinned handle would satisfy the line above while serving
    // whatever happens to be at the path when the browser gets there.
    expect(res.body.downloadUrl).toContain(`generation=${generation}`);
    expect(signedUrlCalls.at(-1)!.generation).toBe(generation);
  });

  it('cannot serve a document replaced after it was minted', async () => {
    const deed = await seedFile(firm.id, { parentId: matterRoot, name: 'Deed.pdf', bytes: 2048 });

    const res = await downloadUrl(deed.id);
    const authorized = objects.get(deed.objectPath)!.generation;

    // Somebody replaces the object at that path. The URL is still live and
    // still needs no credential.
    putObject(deed.objectPath, { body: Buffer.from('SWAPPED'), contentType: 'application/pdf' });
    const replaced = objects.get(deed.objectPath)!.generation;

    expect(replaced).not.toBe(authorized);
    // The URL still names the version that was authorized, so it resolves to
    // that version or to nothing. What it can never do is quietly hand over the
    // new document under the old authorization.
    expect(res.body.downloadUrl).toContain(`generation=${authorized}`);
    expect(res.body.downloadUrl).not.toContain(`generation=${replaced}`);
  });

  it('forces the browser to save rather than open the document', async () => {
    const deed = await seedFile(firm.id, { parentId: matterRoot, name: 'Deed.pdf', bytes: 2048 });

    await downloadUrl(deed.id);

    // A PDF is inline-safe, so the shared preview helper answers `inline` for
    // it. This route is the Download button: inline would open the document in
    // a tab and never save it.
    const disposition = String(signedUrlCalls.at(-1)!.config.responseDisposition);
    expect(disposition).toBe('attachment; filename="Deed.pdf"');
  });

  it('neutralises a quote in a name rather than splitting the header', async () => {
    const odd = await seedFile(firm.id, { parentId: matterRoot, name: 'Q"uote.pdf', bytes: 64 });

    const res = await downloadUrl(odd.id);

    // Only path separators and control characters are stripped at upload, so a
    // quote reaches here intact and would close the header's filename early.
    expect(res.status).toBe(200);
    expect(String(signedUrlCalls.at(-1)!.config.responseDisposition))
      .toBe('attachment; filename="Q_uote.pdf"');
  });

  it('is short-lived', async () => {
    const deed = await seedFile(firm.id, { parentId: matterRoot, name: 'Deed.pdf', bytes: 64 });

    const res = await downloadUrl(deed.id);

    // Nothing revokes a URL already handed out, so its lifetime is the whole of
    // its revocation story. It has to outlast the START of a large download,
    // not the download.
    const expires = Number(signedUrlCalls.at(-1)!.config.expires);
    expect(expires - Date.now()).toBeGreaterThan(0);
    expect(expires - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
    expect(new Date(res.body.urlExpiresAt).getTime()).toBe(expires);
  });
});

describe('who may be handed one', () => {
  it('refuses another firm\'s document, and signs nothing on the way', async () => {
    const other = await createFirm({ name: 'Rival LLP' });
    const otherOwner = await ownerOf(other.id);
    const otherMatter = await seedMatter(other.id, otherOwner.uid, 'Vance v. Orrick');
    const otherRoot = await rootOf(other.id, { matterId: otherMatter });
    const theirs = await seedFile(other.id, { parentId: otherRoot, name: 'Private.pdf', bytes: 64 });

    signedUrlCalls.length = 0;
    const res = await downloadUrl(theirs.id);

    // Not found rather than forbidden, so probing cannot tell "not yours" from
    // "not there".
    expect(res.status).toBe(404);
    expect(res.body.downloadUrl).toBeUndefined();
    // The half that matters. A route that minted the URL and then decided not
    // to return it has already produced a bearer credential to the bytes.
    expect(signedUrlCalls).toEqual([]);
  });

  it('refuses a firm member who is not on the matter', async () => {
    const deed = await seedFile(firm.id, { parentId: matterRoot, name: 'Deed.pdf', bytes: 64 });
    const walled = await memberWith(firm.id, ['files.view']);

    signedUrlCalls.length = 0;
    const res = await downloadUrl(deed.id, walled);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.downloadUrl).toBeUndefined();
    expect(signedUrlCalls).toEqual([]);
  });

  it('serves a firm member who IS on the matter', async () => {
    const deed = await seedFile(firm.id, { parentId: matterRoot, name: 'Deed.pdf', bytes: 64 });
    const insider = await memberWith(firm.id, ['files.view']);
    await joinMatter(firm.id, matterId, insider.uid);

    const res = await downloadUrl(deed.id, insider);

    // Without this, the refusal above would pass against a route that refused
    // every non-owner.
    expect(res.status).toBe(200);
    expect(res.body.downloadUrl).toBeTruthy();
  });

  it('refuses a folder', async () => {
    const folder = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });

    signedUrlCalls.length = 0;
    const res = await downloadUrl(folder.id);

    // A folder is a row with no object behind it, so signing one would produce
    // a URL to nothing. Folders are exported as archives instead.
    expect(res.status).toBe(404);
    expect(signedUrlCalls).toEqual([]);
  });

  it('refuses a row whose object is no longer in storage', async () => {
    const deed = await seedFile(firm.id, { parentId: matterRoot, name: 'Deed.pdf', bytes: 64 });
    objects.delete(deed.objectPath);

    signedUrlCalls.length = 0;
    const res = await downloadUrl(deed.id);

    // Signing a path with nothing at it produces a URL that 404s from storage
    // some seconds later, which the browser reports as a failed download with
    // no explanation. Saying so here is the whole difference.
    expect(res.status).toBe(404);
    expect(signedUrlCalls).toEqual([]);
  });
});
