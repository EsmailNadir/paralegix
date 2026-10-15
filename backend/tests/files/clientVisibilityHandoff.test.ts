/**
 * Sharing a document with the client portal, proved from the client's side.
 *
 * `PATCH /client-visibility` is a firm-side route that writes one string of
 * custom metadata. On its own that is unfalsifiable: `fileMutations` already
 * shows the flag is written, and a flag can be written perfectly while the
 * portal reads a different one, scans a different prefix, or ignores the
 * per-client restriction entirely. The share is only real if a client can then
 * open the document, and only safe if the clients the firm did NOT share with
 * still cannot.
 *
 * So every case here is a round trip: the firm flips visibility through the
 * files route, and the answer is read from `/api/client-portal/...` as the
 * client. Nothing seeds the metadata directly, because a fixture written by hand
 * cannot show the two sides agreeing about its format.
 *
 * THE CAST, rebuilt per test:
 *
 *   `client`    a person client of Hale & Co, on `matterId`.
 *   `coClient`  a second person client of the SAME firm on the SAME matter.
 *               Every "must not see" below is checked against them, and they
 *               fetch the same document successfully whenever the firm shared it
 *               with them, so an absence is never just an empty world.
 *   `outsider`  a client of a DIFFERENT firm. The tenancy case.
 */
import { randomUUID } from 'crypto';

import {
  createFirm,
  createPersonClient,
  createPortalUser,
  ownerOf,
  as,
  tokenFor,
  testPool,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installRichBucket, resetRichBucket } from './richBucket';
import { rootOf, seedFile, seedFolder, seedMatter } from './fileWorld';

installRichBucket();

interface PortalPerson extends Actor {
  /** The `clients` row this portal user owns. */
  clientId: string;
}

let firm: Firm;
let owner: Actor;
let matterId: string;
let matterRoot: string;
/** The matter-root document every case above the folder section shares. */
let agreement: { id: string; objectPath: string };
let client: PortalPerson;
let coClient: PortalPerson;

let rival: Firm;
let outsider: PortalPerson;

const F = () => `/api/lawfirms/${firm.id}/files`;
const portalMatterDocs = (person: PortalPerson, lawFirmId = firm.id, matter = matterId) =>
  person.api.get(`/api/client-portal/lawfirm/${lawFirmId}/matters/${matter}/documents`);

const setVisibility = (body: Record<string, unknown>) =>
  owner.api.patch(`${F()}/client-visibility`).send({ matterId, ...body });

/** A portal user, their `clients` row, and their seat on a matter. */
async function portalPerson(
  lawFirmId: string,
  name: string,
  matter: string | null,
): Promise<PortalPerson> {
  const { uid } = await createPortalUser({ name });
  const record = await createPersonClient(lawFirmId, {
    name, userId: uid, email: `${uid}@example.test`,
  });
  if (matter) {
    const { rowCount } = await testPool.query(
      'insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)',
      [matter, record.id, lawFirmId],
    );
    // The junction IS the portal's definition of matter access. A missing row
    // turns every positive case below into a 403 and every negative one into a
    // vacuous pass.
    expect(rowCount).toBe(1);
  }
  return { uid, clientId: record.id, api: as(tokenFor({ uid })) };
}

/** The document names one client is served for the matter. */
async function documentNamesFor(person: PortalPerson): Promise<string[]> {
  const res = await portalMatterDocs(person);
  expect(res.status).toBe(200);
  return res.body.documents.map((d: any) => d.name).sort();
}

beforeEach(async () => {
  resetRichBucket();

  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Hollis v. Denton');
  matterRoot = await rootOf(firm.id, { matterId });

  client = await portalPerson(firm.id, 'Marisol Vance', matterId);
  coClient = await portalPerson(firm.id, 'Desmond Orrick', matterId);

  rival = await createFirm({ name: 'Rival LLP' });
  const rivalMatter = await seedMatter(rival.id, (await ownerOf(rival.id)).uid, 'Unrelated');
  outsider = await portalPerson(rival.id, 'Priya Nandakumar', rivalMatter);

  agreement = await seedFile(firm.id, {
    parentId: matterRoot, name: 'Settlement Agreement.pdf', bytes: 2048,
  });
});

// ---------------------------------------------------------------------------

describe('a document nobody has shared', () => {
  it('is not served to a client on the matter', async () => {
    expect(await documentNamesFor(client)).toEqual([]);
  });

  it('cannot be opened by naming its path directly', async () => {
    const res = await client.api
      .post(`/api/client-portal/lawfirm/${firm.id}/matters/${matterId}/documents/refresh-url`)
      .send({ fileId: agreement.id });

    // The list is not the boundary: the signing endpoint re-checks visibility,
    // because a client who once saw a document keeps its path forever.
    expect(res.status).toBe(404);
    expect(res.body.downloadUrl).toBeUndefined();
  });
});

describe('sharing a document', () => {
  it('puts it in the client document list', async () => {
    const shared = await setVisibility({
      fileId: agreement.id, clientVisible: true,
    });

    expect(shared.status).toBe(200);
    expect(await documentNamesFor(client)).toEqual(['Settlement Agreement.pdf']);
  });

  it('lets the client sign a download url for it', async () => {
    await setVisibility({ fileId: agreement.id, clientVisible: true });

    const res = await client.api
      .post(`/api/client-portal/lawfirm/${firm.id}/matters/${matterId}/documents/refresh-url`)
      .send({ fileId: agreement.id });

    // Listing a document the client cannot then open is the same as not sharing
    // it, so both halves belong in the same file.
    expect(res.status).toBe(200);
    expect(res.body.downloadUrl).toEqual(expect.any(String));
  });

  it('carries the size and type the firm stored', async () => {
    await setVisibility({ fileId: agreement.id, clientVisible: true });

    const res = await portalMatterDocs(client);

    expect(res.body.documents[0])
      .toMatchObject({ size: 2048, type: 'application/pdf', objectPath: agreement.objectPath });
  });

  it('takes it away again when the firm un-shares it', async () => {
    await setVisibility({ fileId: agreement.id, clientVisible: true });
    expect(await documentNamesFor(client)).toEqual(['Settlement Agreement.pdf']);

    await setVisibility({ fileId: agreement.id, clientVisible: false });

    // Withdrawing access has to reach the same place granting it did. The
    // before-assertion is what makes the empty list afterwards mean something.
    expect(await documentNamesFor(client)).toEqual([]);
  });

  it('stops the client re-opening it from a path they already hold', async () => {
    await setVisibility({ fileId: agreement.id, clientVisible: true });
    const opened = await client.api
      .post(`/api/client-portal/lawfirm/${firm.id}/matters/${matterId}/documents/refresh-url`)
      .send({ fileId: agreement.id });
    expect(opened.status).toBe(200);

    await setVisibility({ fileId: agreement.id, clientVisible: false });
    const res = await client.api
      .post(`/api/client-portal/lawfirm/${firm.id}/matters/${matterId}/documents/refresh-url`)
      .send({ fileId: agreement.id });

    expect(res.status).toBe(404);
  });
});

describe('sharing with SOME of the clients on a matter', () => {
  it('serves it to the client named', async () => {
    await setVisibility({
      fileId: agreement.id,
      clientVisible: true,
      visibleClientIds: [client.clientId],
    });

    expect(await documentNamesFor(client)).toEqual(['Settlement Agreement.pdf']);
  });

  it('withholds it from the co-client on the SAME matter', async () => {
    await setVisibility({
      fileId: agreement.id,
      clientVisible: true,
      visibleClientIds: [client.clientId],
    });

    // The co-client is on the matter and the flag reads `true` for everyone: the
    // per-client list is the only thing separating them. Opposing parties on one
    // matter is the ordinary case for this, not an exotic one.
    expect(await documentNamesFor(coClient)).toEqual([]);
  });

  it('refuses to sign a url for the client it was not shared with', async () => {
    await setVisibility({
      fileId: agreement.id,
      clientVisible: true,
      visibleClientIds: [client.clientId],
    });

    const res = await coClient.api
      .post(`/api/client-portal/lawfirm/${firm.id}/matters/${matterId}/documents/refresh-url`)
      .send({ fileId: agreement.id });

    expect(res.status).toBe(404);
  });

  it('serves it to BOTH when the firm shares with everyone', async () => {
    await setVisibility({ fileId: agreement.id, clientVisible: true });

    // No restriction means every client on the matter, which is what makes the
    // withholding above a decision rather than a broken read.
    expect(await documentNamesFor(client)).toEqual(['Settlement Agreement.pdf']);
    expect(await documentNamesFor(coClient)).toEqual(['Settlement Agreement.pdf']);
  });
});

/**
 * A share's audience is not fixed at the moment it is created: the firm can
 * come back and narrow an all-clients share down to one client, or widen a
 * restricted one to add another, without ever un-sharing and re-sharing the
 * document. Every case above proves the audience is enforced correctly the
 * FIRST time a document is shared; none of them re-share the same object with
 * a different `visibleClientIds` list, so a route that only computed the
 * restriction correctly on a fresh share (and, say, ignored a change to an
 * EXISTING one) would pass every test above and still leak the document to a
 * client who was supposed to lose access, or spam a client who has had it all
 * along.
 */
describe('changing an existing share\'s audience', () => {
  it('revokes the removed co-client\'s access to the document list', async () => {
    await setVisibility({ fileId: agreement.id, clientVisible: true });
    expect(await documentNamesFor(coClient)).toEqual(['Settlement Agreement.pdf']);

    // Narrow the SAME object to just one client. This is not an unshare
    // followed by a fresh restricted share: `clientVisible` never goes false.
    await setVisibility({
      fileId: agreement.id, clientVisible: true, visibleClientIds: [client.clientId],
    });

    expect(await documentNamesFor(coClient)).toEqual([]);
    // The remaining client is unaffected by the narrowing.
    expect(await documentNamesFor(client)).toEqual(['Settlement Agreement.pdf']);
  });

  it('revokes the removed co-client\'s ability to sign a fresh download url', async () => {
    await setVisibility({ fileId: agreement.id, clientVisible: true });
    const before = await coClient.api
      .post(`/api/client-portal/lawfirm/${firm.id}/matters/${matterId}/documents/refresh-url`)
      .send({ fileId: agreement.id });
    expect(before.status).toBe(200);

    await setVisibility({
      fileId: agreement.id, clientVisible: true, visibleClientIds: [client.clientId],
    });

    const after = await coClient.api
      .post(`/api/client-portal/lawfirm/${firm.id}/matters/${matterId}/documents/refresh-url`)
      .send({ fileId: agreement.id });

    // Narrowing has to close the same door un-sharing does. A client who
    // already holds the object path from before the narrowing must not be
    // able to mint a fresh signed url with it.
    expect(after.status).toBe(404);
  });

  it('grants a newly added client access when the audience widens', async () => {
    await setVisibility({
      fileId: agreement.id, clientVisible: true, visibleClientIds: [client.clientId],
    });
    expect(await documentNamesFor(coClient)).toEqual([]);

    await setVisibility({
      fileId: agreement.id,
      clientVisible: true,
      visibleClientIds: [client.clientId, coClient.clientId],
    });

    expect(await documentNamesFor(coClient)).toEqual(['Settlement Agreement.pdf']);
    expect(await documentNamesFor(client)).toEqual(['Settlement Agreement.pdf']);
  });

  /**
   * The pending-notification table dedupes an unsent row for the same
   * (client, object) pair via a partial unique index, so re-attempting to
   * queue a client who already has an UNSENT row silently no-ops and proves
   * nothing about whether the route correctly excluded them. Marking the
   * earlier row `notified_at` first (simulating the digest having already
   * gone out) removes that safety net: a route that wrongly re-queues an
   * already-notified client produces a genuine SECOND, fresh, unsent row.
   */
  async function markNotified(fileId: string): Promise<void> {
    await testPool.query(
      `update file_client_access set notified_at = now()
       where law_firm_id = $1 and file_id = $2 and notified_at is null`,
      [firm.id, fileId],
    );
  }

  const unsentRecipients = async (fileId: string): Promise<string[]> => {
    const rows = await testPool.query(
      `select client_user_id from file_client_access
       where law_firm_id = $1 and file_id = $2 and notified_at is null`,
      [firm.id, fileId],
    );
    return rows.rows.map((r) => r.client_user_id).sort();
  };

  it('queues a share notification only for the client newly reached by a widened audience', async () => {
    const path = agreement.id;
    await setVisibility({ fileId: path, clientVisible: true, visibleClientIds: [client.clientId] });
    await drainEvents();
    expect(await unsentRecipients(path)).toEqual([client.uid]);
    // The first share's digest already went out; client's row is no longer
    // "pending", so a wrongful re-queue on the next change is observable.
    await markNotified(path);

    await setVisibility({
      fileId: path, clientVisible: true, visibleClientIds: [client.clientId, coClient.clientId],
    });
    await drainEvents();

    // Only the newly-reached coClient gets a fresh pending row. Re-queuing
    // client, who has had access all along, would spam them about a document
    // they already opened.
    expect(await unsentRecipients(path)).toEqual([coClient.uid]);
  });

  it('does not create a fresh notification for anyone when the audience only narrows', async () => {
    const path = agreement.id;
    await setVisibility({ fileId: path, clientVisible: true });
    await drainEvents();
    expect(await unsentRecipients(path)).toEqual([client.uid, coClient.uid].sort());
    // Both digests already went out; a narrowing that wrongly re-queues
    // either client is now observable as a fresh unsent row.
    await markNotified(path);

    await setVisibility({
      fileId: path, clientVisible: true, visibleClientIds: [client.clientId],
    });
    await drainEvents();

    // Narrowing removes access; it must never read as a fresh share to the
    // client keeping access, or to the client losing it.
    expect(await unsentRecipients(path)).toEqual([]);
  });
});

describe('sharing a folder', () => {
  let closing: { id: string };
  let deed: { id: string };
  let finalDeed: { id: string };

  beforeEach(async () => {
    closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    deed = await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 1024 });
    const signed = await seedFolder(firm.id, { parentId: closing.id, name: 'Signed' });
    finalDeed = await seedFile(firm.id, { parentId: signed.id, name: 'Final Deed.pdf', bytes: 512 });
  });

  it('serves everything under it without sharing each document', async () => {
    const res = await setVisibility({
      fileId: closing.id, clientVisible: true,
    });

    // Folder sharing is how a firm hands over a production. Marking the marker
    // and expecting the client to see nothing inside would be a share that does
    // nothing, silently.
    expect(res.status).toBe(200);
    expect(await documentNamesFor(client)).toEqual(['Closing/Deed.pdf', 'Closing/Signed/Final Deed.pdf']);
  });

  it('does not serve documents OUTSIDE the shared folder', async () => {
    await setVisibility({ fileId: closing.id, clientVisible: true });

    // `Settlement Agreement.pdf` sits at the matter root and was never shared.
    // Inheritance that reached it would publish the whole matter on one click.
    const names = await documentNamesFor(client);
    expect(names).not.toContain('Settlement Agreement.pdf');
  });

  it('lets the client sign a url for a document it inherited visibility from', async () => {
    await setVisibility({ fileId: closing.id, clientVisible: true });

    const res = await client.api
      .post(`/api/client-portal/lawfirm/${firm.id}/matters/${matterId}/documents/refresh-url`)
      .send({ fileId: finalDeed.id });

    // The signing endpoint walks the ancestor chain rather than reading the
    // file's own flag, which is a separate implementation from the list scan and
    // so a separate way for the two to disagree.
    expect(res.status).toBe(200);
    expect(res.body.downloadUrl).toEqual(expect.any(String));
  });

  it('withholds a shared folder from a client it was restricted away from', async () => {
    await setVisibility({
      fileId: closing.id,
      clientVisible: true,
      visibleClientIds: [client.clientId],
    });

    expect(await documentNamesFor(client)).toEqual(['Closing/Deed.pdf', 'Closing/Signed/Final Deed.pdf']);
    // The restriction is stored on the marker and inherited by everything under
    // it, so a scan that honoured the flag but not the list would hand the
    // co-client the whole folder.
    expect(await documentNamesFor(coClient)).toEqual([]);
  });

  it('closes the folder again when it is un-shared', async () => {
    await setVisibility({ fileId: closing.id, clientVisible: true });

    await setVisibility({ fileId: closing.id, clientVisible: false });

    expect(await documentNamesFor(client)).toEqual([]);
  });
});

describe('a client of another firm', () => {
  it('cannot read the shared document through the firm that shared it', async () => {
    await setVisibility({ fileId: agreement.id, clientVisible: true });

    const res = await portalMatterDocs(outsider, firm.id, matterId);

    // Shared means shared with the clients on the matter, not published. The
    // outsider is a real portal user with a real client record at another firm,
    // so this exercises the association resolver rather than an unauthenticated
    // request.
    expect(res.status).toBe(403);
  });

  it('cannot sign a url for it either', async () => {
    await setVisibility({ fileId: agreement.id, clientVisible: true });

    const res = await outsider.api
      .post(`/api/client-portal/lawfirm/${firm.id}/matters/${matterId}/documents/refresh-url`)
      .send({ fileId: agreement.id });

    expect(res.status).toBe(403);
  });

  it('does not see it in their OWN firm document feed', async () => {
    await setVisibility({ fileId: agreement.id, clientVisible: true });

    const res = await outsider.api.get(`/api/client-portal/lawfirm/${rival.id}/documents`);

    // The other direction: a scan keyed on the object path rather than on the
    // firm would surface Hale & Co's document inside Rival LLP's portal.
    expect(res.status).toBe(200);
    expect(res.body.documents).toEqual([]);
  });

  it('serves the outsider their OWN firm shared document', async () => {
    const rivalOwner = await ownerOf(rival.id);
    const rivalMatterId = randomUUID();
    const created = await testPool.query(
      'insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, $3, $4)',
      [rivalMatterId, rival.id, 'Nandakumar v. Bell', `REF-${rivalMatterId.slice(0, 8)}`],
    );
    expect(created.rowCount).toBe(1);
    await testPool.query(
      `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
       values ($1, $2, $3, 'member', now())`,
      [rivalMatterId, rivalOwner.uid, rival.id],
    );
    await testPool.query(
      'insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)',
      [rivalMatterId, outsider.clientId, rival.id],
    );
    const theirRoot = await rootOf(rival.id, { matterId: rivalMatterId });
    const theirs = await seedFile(rival.id, {
      parentId: theirRoot, name: 'Their Retainer.pdf', bytes: 256,
    });

    await rivalOwner.api.patch(`/api/lawfirms/${rival.id}/files/client-visibility`)
      .send({ matterId: rivalMatterId, fileId: theirs.id, clientVisible: true });
    const res = await outsider.api.get(`/api/client-portal/lawfirm/${rival.id}/documents`);

    // Without this the three refusals above pass just as well against a portal
    // that serves nobody anything.
    expect(res.status).toBe(200);
    expect(res.body.documents.map((d: any) => d.name)).toEqual(['Their Retainer.pdf']);
  });
});

describe('a client of the firm who is not on the matter', () => {
  it('is refused the matter document list', async () => {
    const bystander = await portalPerson(firm.id, 'Tomas Aguilar', null);
    await setVisibility({ fileId: agreement.id, clientVisible: true });

    const res = await portalMatterDocs(bystander);

    expect(res.status).toBe(403);
  });

  it('does not pick the document up in their own feed', async () => {
    const bystander = await portalPerson(firm.id, 'Tomas Aguilar', null);
    await setVisibility({ fileId: agreement.id, clientVisible: true });

    const res = await bystander.api.get(`/api/client-portal/lawfirm/${firm.id}/documents`);

    // Same firm, so the firm-level association passes and only the matter
    // junction stands between this client and another client's settlement.
    expect(res.status).toBe(200);
    expect(res.body.documents).toEqual([]);
  });
});
