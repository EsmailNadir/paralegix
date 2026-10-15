/**
 * Public file share links: an UNAUTHENTICATED url that hands out a document.
 *
 * `/api/share/:token` has no `verifyToken`. The token in the url is the entire
 * credential, and the thing behind it is a client's file. That makes this one of
 * the two most exposed surfaces in the product, alongside the signing routes.
 *
 * Links are seeded with SQL rather than created through the API. Creating one
 * goes through `bucket.file(objectPath).exists()`, and GCS is inert in this
 * harness, so a fixture that used the create route would fail at the fixture.
 * Seeding also puts a link into states the API cannot produce on demand: expired,
 * revoked, and password-protected with a known plaintext.
 *
 * The property most worth protecting here is what the PUBLIC metadata route
 * discloses. It answers before any password is supplied, so anything it returns
 * is readable by anyone holding the link.
 */
import { randomBytes } from 'crypto';

import { objects, installInMemoryBucket, putObject } from '../support/inMemoryBucket';
import { countRows, hashSharePassword, rootOf, seedFile } from './fileWorld';
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

// `shareLinks.service.ts` holds its bucket handle at module load. Install this
// before the first request so the public download route can be tested all the
// way through signed-URL selection instead of stopping at the inert default.
installInMemoryBucket();

let firm: Firm;
let owner: Actor;

const anonymous = () => as('');
/** The document every link in this file points at. Seeded per test. */
let doc: { id: string; objectPath: string };

async function seedLink(overrides: Record<string, unknown> = {}) {
  const token = `shr_${randomBytes(12).toString('hex')}`;
  const values = {
    displayName: 'Engagement Letter.pdf',
    permission: 'download',
    passwordHash: null as string | null,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    revoked: false,
    lawFirmId: firm.id,
    fileId: doc.id,
    ...overrides,
  };
  await testPool.query(
    `insert into file_share_links
       (token, law_firm_id, file_id, display_name, mime_type, permission,
        password_hash, expires_at, revoked_at, created_by)
     values ($1,$2,$3,$4,'application/pdf',$5,$6,$7,$8,$9)`,
    [
      token, values.lawFirmId, values.fileId, values.displayName,
      values.permission, values.passwordHash, values.expiresAt,
      values.revoked ? new Date() : null,
      owner.uid,
    ],
  );
  return token;
}

const linkRow = async (token: string) => {
  const { rows } = await testPool.query(
    `select revoked_at is not null as revoked, access_count, password_hash
       from file_share_links where token = $1`,
    [token],
  );
  return rows[0];
};

beforeEach(async () => {
  objects.clear();
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const firmRoot = await rootOf(firm.id, {});
  doc = await seedFile(firm.id, { parentId: firmRoot, name: 'Engagement Letter.pdf' });
  await drainEvents();
});

describe('what the public metadata route discloses', () => {
  it('serves a live link to an anonymous caller without disclosing storage', async () => {
    const token = await seedLink();

    const res = await anonymous().get(`/api/share/${token}`);

    // Deliberately public: the recipient has to see what they were sent before
    // deciding to download it, and they have no account.
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Engagement Letter.pdf');
    // Every seeded link in this file stores 'application/pdf'; a client-side
    // preview built on this route needs the value itself, not just its presence.
    expect(res.body.contentType).toBe('application/pdf');
    // The negative half of the password case below. A route that always claimed
    // a password was needed would make every open link unusable.
    expect(res.body.requiresPassword).toBe(false);
    // The object path names the firm id, the matter or client id, and the
    // internal filename. Returning it hands an anonymous caller the shape of the
    // firm's storage layout, which is the map for guessing other paths.
    expect(JSON.stringify(res.body)).not.toContain(doc.objectPath);
    expect(JSON.stringify(res.body)).not.toContain(firm.id);
  });

  it('says a password is required WITHOUT revealing the hash', async () => {
    const token = await seedLink({ passwordHash: hashSharePassword('correct horse') });

    const res = await anonymous().get(`/api/share/${token}`);

    // The flag has to be there, or the recipient cannot be prompted. The hash
    // must not be, or the link's own metadata endpoint hands out the material
    // for an offline attack on it.
    expect(res.body.requiresPassword).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('scrypt');
    expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe('what the download route returns', () => {
  it('includes the content type and display name alongside the signed url', async () => {
    const token = await seedLink();
    putObject(doc.objectPath);

    const res = await anonymous().post(`/api/share/${token}/download`).send({});

    // A client-side preview (rather than an immediate navigation to `url`) needs
    // both of these to decide how to render the file and what to label it.
    expect(res.status).toBe(200);
    expect(res.body.contentType).toBe('application/pdf');
    expect(res.body.displayName).toBe('Engagement Letter.pdf');
  });
});

describe('the states a link can be in', () => {
  it('keeps a token bound to its original firm object, then refuses it after expiry or revocation', async () => {
    const token = await seedLink();
    const otherFirm = await createFirm();
    const otherRoot = await rootOf(otherFirm.id, {});
    const otherDoc = await seedFile(otherFirm.id, { parentId: otherRoot, name: 'Other Firm Privileged.pdf' });
    const otherObjectPath = otherDoc.objectPath;
    const expiredToken = await seedLink({ expiresAt: new Date(Date.now() + 24 * 3600 * 1000) });
    const revokedToken = await seedLink({ expiresAt: new Date(Date.now() + 24 * 3600 * 1000) });

    putObject(doc.objectPath);
    putObject(otherObjectPath);

    // The capability is the token, not anything the caller supplies alongside
    // it. Naming another firm document in either request location cannot
    // redirect this token to that firm bytes.
    const liveMeta = await anonymous().get(`/api/share/${token}?fileId=${otherDoc.id}`);
    const liveDownload = await anonymous().post(`/api/share/${token}/download?fileId=${otherDoc.id}`)
      .send({ fileId: otherDoc.id });

    expect(liveMeta.status).toBe(200);
    expect(liveMeta.body.displayName).toBe('Engagement Letter.pdf');
    expect(liveDownload.status).toBe(200);
    expect(liveDownload.body.url).toContain(encodeURIComponent(doc.objectPath));
    expect(liveDownload.body.url).not.toContain(encodeURIComponent(otherObjectPath));

    // Each recipient has already loaded the landing page before the durable
    // state changes. Download must re-check that state, rather than trusting
    // what the page observed or returning its filename/path in an error.
    expect((await anonymous().get(`/api/share/${expiredToken}`)).status).toBe(200);
    await testPool.query(
      'update file_share_links set expires_at = now() - interval \'1 second\' where token = $1',
      [expiredToken],
    );
    const expired = await anonymous().post(`/api/share/${expiredToken}/download`).send({});

    expect(expired.status).toBe(410);
    expect(expired.body.code).toBe('SHARE_LINK_EXPIRED');
    expect(JSON.stringify(expired.body)).not.toContain('Engagement Letter.pdf');
    expect(JSON.stringify(expired.body)).not.toContain(doc.objectPath);

    expect((await anonymous().get(`/api/share/${revokedToken}`)).status).toBe(200);
    await testPool.query('update file_share_links set revoked_at = now() where token = $1', [revokedToken]);
    const revoked = await anonymous().post(`/api/share/${revokedToken}/download`).send({});

    expect(revoked.status).toBe(404);
    expect(JSON.stringify(revoked.body)).not.toContain('Engagement Letter.pdf');
    expect(JSON.stringify(revoked.body)).not.toContain(doc.objectPath);
  });

  it('refuses a REVOKED link', async () => {
    const token = await seedLink({ revoked: true });

    const res = await anonymous().get(`/api/share/${token}`);

    // Revoking is how a firm un-sends a document. If the url still resolves
    // afterwards, revoking is theatre and the file stays public.
    expect(res.status).toBe(404);
  });

  it('distinguishes expired from never-existed', async () => {
    const expired = await seedLink({ expiresAt: new Date(Date.now() - 3600 * 1000) });

    const gone = await anonymous().get(`/api/share/${expired}`);
    const missing = await anonymous().get('/api/share/shr_never_existed');

    // 410 versus 404. A recipient whose link has aged out needs to be told to
    // ask for a new one, not that the document never existed.
    expect(gone.status).toBe(410);
    expect(gone.body.code).toBe('SHARE_LINK_EXPIRED');
    expect(missing.status).toBe(404);
  });
});

describe('password protection', () => {
  it('refuses a download with the WRONG password', async () => {
    const token = await seedLink({ passwordHash: hashSharePassword('correct horse') });

    const res = await anonymous().post(`/api/share/${token}/download`)
      .send({ password: 'wrong horse' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SHARE_LINK_PASSWORD');
  });

  it('refuses a download with NO password when one is set', async () => {
    const token = await seedLink({ passwordHash: hashSharePassword('correct horse') });

    const res = await anonymous().post(`/api/share/${token}/download`).send({});

    // An absent password must not compare equal to a set one. `scryptSync('')`
    // against the stored salt is what the implementation does, so this pins that
    // the empty case goes through the same comparison rather than short-circuiting.
    expect(res.status).toBe(401);
  });

  it('refuses an EMPTY-STRING password', async () => {
    const token = await seedLink({ passwordHash: hashSharePassword('correct horse') });

    const res = await anonymous().post(`/api/share/${token}/download`)
      .send({ password: '' });

    expect(res.status).toBe(401);
  });

  it('gets PAST the password check with the right one', async () => {
    const token = await seedLink({ passwordHash: hashSharePassword('correct horse') });
    putObject(doc.objectPath);

    const res = await anonymous().post(`/api/share/${token}/download`)
      .send({ password: 'correct horse' });

    // The positive half. Without it, a gate that refused every password would
    // satisfy all three refusals above and lock every recipient out of their
    // own document.
    expect(res.status).toBe(200);
    expect(res.body.url).toContain(encodeURIComponent(doc.objectPath));
  });

  it('does not leak the password back in any response', async () => {
    const token = await seedLink({ passwordHash: hashSharePassword('correct horse') });

    const meta = await anonymous().get(`/api/share/${token}`);
    const refused = await anonymous().post(`/api/share/${token}/download`)
      .send({ password: 'wrong horse' });

    expect(JSON.stringify(meta.body)).not.toContain('correct horse');
    expect(JSON.stringify(refused.body)).not.toContain('correct horse');
  });
});

describe('the firm side of a link', () => {
  const links = () => `/api/lawfirms/${firm.id}/file-share-links`;

  it('lists the links on one object', async () => {
    await seedLink();

    const res = await owner.api.get(`${links()}?fileId=${doc.id}`);

    expect(res.status).toBe(200);
    expect(res.body.links).toHaveLength(1);
  });

  it('never exposes the password hash in that listing', async () => {
    await seedLink({ passwordHash: hashSharePassword('correct horse') });

    const res = await owner.api.get(`${links()}?fileId=${doc.id}`);

    // A firm member seeing the hash is a smaller problem than an anonymous
    // caller seeing it, and it is still material for an offline attack on a link
    // the firm may have shared outside.
    expect(JSON.stringify(res.body)).not.toContain('password_hash');
    expect(res.body.links[0].passwordHash).toBeUndefined();
    expect(res.body.links[0].hasPassword).toBe(true);
  });

  it('revokes a link, and the public url stops working', async () => {
    const token = await seedLink();

    const res = await owner.api.delete(`${links()}/${token}`);

    expect(res.status).toBe(200);
    expect((await linkRow(token)).revoked).toBe(true);

    const publicRead = await anonymous().get(`/api/share/${token}`);

    // The end-to-end property. Revoking that flipped a column without closing
    // the public url would look successful on the firm's screen and change
    // nothing for whoever holds the link.
    expect(publicRead.status).toBe(404);
  });

  it('answers not-found revoking a token that does not exist', async () => {
    const res = await owner.api.delete(`${links()}/shr_not_a_real_token`);

    expect(res.status).toBe(404);
  });

  it('does NOT let one firm revoke another firm link', async () => {
    const token = await seedLink();
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .delete(`/api/lawfirms/${otherFirm.id}/file-share-links/${token}`);

    // The token is globally unique and the route takes it from the url, so
    // scoping the revoke by firm is the only thing stopping one firm closing
    // another firm's links.
    expect(res.status).toBe(404);
    expect((await linkRow(token)).revoked).toBe(false);
  });

  it('does NOT list another firm links', async () => {
    await seedLink();
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .get(`/api/lawfirms/${otherFirm.id}/file-share-links?fileId=${doc.id}`);

    // The object path belongs to this firm's prefix, so the request is asking
    // about someone else's file by name.
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(doc.objectPath);
  });

  it('refuses a member without the permission', async () => {
    const token = await seedLink();
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi.delete(`${links()}/${token}`);

    expect(res.status).toBe(403);
    expect((await linkRow(token)).revoked).toBe(false);
  });

  it('refuses an anonymous caller on the firm-side listing', async () => {
    await seedLink();

    const res = await anonymous()
      .get(`${links()}?fileId=${doc.id}`);

    // The public route is public by design; this one is not.
    expect(res.status).toBe(401);
  });
});

describe('creating a link', () => {
  const links = () => `/api/lawfirms/${firm.id}/file-share-links`;

  it('refuses a path outside the firm own prefix', async () => {
    const otherFirm = await createFirm();

    const res = await owner.api.post(links()).send({
      objectPath: `lawfirmids/${otherFirm.id}/general/Their Document.pdf`,
    });

    // The validation runs before any storage call, so this is reachable here.
    // Without it, a firm could mint a public url for another firm's file.
    expect(res.status).toBe(400);
    expect(await countRows('file_share_links')).toBe(0);
  });

  it('refuses a password longer than two hundred characters before minting a link', async () => {
    const res = await owner.api.post(links()).send({
      fileId: doc.id,
      password: 'p'.repeat(201),
    });

    // The password is deliberately bounded before the service derives an
    // expensive scrypt hash and before a durable public credential is created.
    expect(res.status).toBe(400);
    expect(await countRows('file_share_links', 'law_firm_id = $1', [firm.id])).toBe(0);
  });

  it.each([
    // The cap is what keeps "temporary" meaningful.
    ['an expiry beyond a year', { expiresInHours: 24 * 400 }],
    ['a zero expiry', { expiresInHours: 0 }],
    ['a negative expiry', { expiresInHours: -5 }],
    // Only `view` and `download` exist. An unrecognised value falling through
    // to a default would grant whatever that default is.
    ['an unrecognised permission', { permission: 'edit' }],
  ])('refuses %s without writing a link', async (_label, body) => {
    const res = await owner.api.post(links()).send({ fileId: doc.id, ...body });

    expect(res.status).toBe(400);
    expect(await countRows('file_share_links')).toBe(0);
  });
});
