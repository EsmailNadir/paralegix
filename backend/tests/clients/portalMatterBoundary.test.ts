/**
 * One firm, two clients, and the line between their matters.
 *
 * Cross-FIRM isolation (`portalCrossFirmIsolation.test.ts`) is the loud failure:
 * one wrong predicate and a stranger reads a whole other practice. This file
 * covers the quiet one. Both callers here are legitimate clients of the same
 * firm, both hold a valid association, and both pass every tenancy check in the
 * request. Everything that keeps one of them out of the other's matter is the
 * per-matter access check inside the handler, and a route that forgot it looks
 * completely healthy from the outside: it returns 200, with somebody else's
 * discovery documents in it.
 *
 * `portalScopedReads.test.ts` already covers the reads that return rows out of
 * Postgres (matter notes, the agenda, invoices, the aggregate dashboard). What
 * it does not cover, and what this file is for, is the DOCUMENT half and the
 * WRITES: the object-storage routes, whose scope is decided by parsing a client-
 * supplied path rather than by a SQL predicate, and the four endpoints through
 * which a portal client puts something into the firm.
 *
 * THE CAST, rebuilt per test:
 *
 *   `mine`    a person client of the firm, on `myMatter` and on `sharedMatter`.
 *   `theirs`  a second person client of the SAME firm, on `theirMatter` and on
 *             `sharedMatter`.
 *
 * `sharedMatter` is the sharpest fixture in the file. Both clients can open it,
 * so any check that stops at "can this caller see this matter" passes. What must
 * still hold is that a document request addressed to one of them, and the file
 * filed against it, stays theirs.
 *
 * ON STORAGE. GCS is deliberately unavailable in the in-process harness, and
 * that turns out to be useful rather than limiting: the access checks on these
 * routes all run BEFORE the first object is touched. So a refusal (403, or the
 * 404 the path parser produces) proves the request was stopped by an access
 * rule, and a storage-level failure proves it was not. The two are asserted as a
 * pair everywhere below, because either one alone can be produced by a broken
 * endpoint that refuses everybody.
 */
import {
  createFirm,
  createPersonClient,
  ownerOf,
  testPool,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import {
  bodyText,
  firmFileRows,
  fulfillmentCount,
  portalPath,
  portalPerson,
  seedDocumentRequest,
  seedEvent,
  seedMatter,
  type PortalPerson,
} from './portalWorld';
import { rootOf, seedFile } from '../files/fileWorld';
import { portalUpload } from '../support/portalUpload';

let firm: Firm;
let owner: Actor;
let mine: PortalPerson;
let theirs: PortalPerson;
let myMatter: string;
let theirMatter: string;
let sharedMatter: string;

/** A path under the firm's storage root, in the shape the portal parses. */
const objectPathIn = (matterId: string, fileName: string) =>
  `lawfirmids/${firm.id}/${matterId}/${fileName}`;

const P = (suffix: string) => portalPath(firm.id, suffix);

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  mine = await portalPerson(firm.id, 'Mia Client');
  theirs = await portalPerson(firm.id, 'Otto Other');

  myMatter = await seedMatter(firm.id, 'Mia Only', [mine.clientId]);
  theirMatter = await seedMatter(firm.id, 'Otto Only', [theirs.clientId]);
  sharedMatter = await seedMatter(firm.id, 'Joint Venture', [mine.clientId, theirs.clientId]);

  await drainEvents();
});

/* ------------------------------------------------------------------ */
/*  The matter a client is not on                                      */
/* ------------------------------------------------------------------ */

describe('a matter at the same firm that this client is not on', () => {
  it('is refused by id, while its own client is served', async () => {
    const refused = await mine.api.get(P(`matters/${theirMatter}`));
    const served = await theirs.api.get(P(`matters/${theirMatter}`));

    expect(refused.status).toBe(403);
    expect(bodyText(refused)).not.toContain('Otto Only');
    // Same id, same firm, a different caller: the matter is live and readable,
    // which is what makes the refusal above an access rule rather than a
    // missing fixture.
    expect(served.status).toBe(200);
    expect(bodyText(served)).toContain('Otto Only');
  });

  it('refuses its document listing', async () => {
    const refused = await mine.api.get(P(`matters/${theirMatter}/documents`));
    const served = await theirs.api.get(P(`matters/${theirMatter}/documents`));

    // The listing itself is a storage scan and comes back empty in this harness,
    // so the pair is the assertion: its own client reaches the scan (200) and
    // this one is stopped before it (403).
    expect(refused.status).toBe(403);
    expect(served.status).toBe(200);
  });

  it('refuses its document requests', async () => {
    await seedDocumentRequest(firm.id, theirs.clientId, theirMatter, {
      title: 'Otto medical records',
      itemLabel: 'Hospital discharge summary',
      fileName: 'otto-discharge.pdf',
      uploadedBy: theirs.uid,
    });

    const refused = await mine.api.get(P(`document-requests?matterId=${theirMatter}`));
    const served = await theirs.api.get(P(`document-requests?matterId=${theirMatter}`));

    expect(refused.status).toBe(403);
    expect(bodyText(refused)).not.toContain('Otto medical records');
    expect(served.status).toBe(200);
    expect(bodyText(served)).toContain('Otto medical records');
  });

  it('refuses another client matter agenda while its linked client can read it', async () => {
    await seedEvent(firm.id, theirMatter, { title: 'Otto suppression hearing' });

    const agenda = await mine.api.get(P(`events?matterId=${theirMatter}`));
    const ownerOfAgenda = await theirs.api.get(P(`events?matterId=${theirMatter}`));

    expect(agenda.status).toBe(403);
    expect(bodyText(agenda)).not.toContain('Otto suppression hearing');
    expect(bodyText(ownerOfAgenda)).toContain('Otto suppression hearing');
  });

  it('keeps the other client work out of the unfiltered agenda too', async () => {
    // Naming the matter is the obvious attack and the one above covers it. This
    // is the accidental version: the firm-wide agenda, asked for with no filter
    // at all, must still be built from the caller's own matters.
    await seedEvent(firm.id, myMatter, { title: 'Mia deposition' });
    await seedEvent(firm.id, theirMatter, { title: 'Otto suppression hearing' });

    const res = await mine.api.get(P('events'));

    expect(res.status).toBe(200);
    expect(res.body.events.map((e: any) => e.title)).toEqual(['Mia deposition']);
  });
});

/* ------------------------------------------------------------------ */
/*  Uploading into a matter                                            */
/* ------------------------------------------------------------------ */

describe('uploading a document into a matter', () => {
  it('is refused for a matter this client is not on, and files nothing', async () => {
    const res = await portalUpload(mine, P(`matters/${theirMatter}/documents`), [{ name: 'planted.txt', size: Buffer.byteLength(Buffer.from('not my matter')) }]);

    expect(res.status).toBe(403);
    // The claim that matters. Portal uploads mirror every stored object into
    // `files`, so an upload that passed the access check and only failed at
    // storage would still have left a row naming the other client's matter.
    expect(await firmFileRows(firm.id)).toHaveLength(0);
  });

  it('gets past the access check for a matter this client IS on', async () => {
    const res = await portalUpload(mine, P(`matters/${myMatter}/documents`), [{ name: 'mine.txt', size: Buffer.byteLength(Buffer.from('my own matter')) }]);

    // Not a 201: object storage is unavailable here, so a permitted upload dies
    // at the bucket. That is exactly the point. The 403 above is produced BEFORE
    // storage is reached and this one only after, so the two statuses tell the
    // access check apart from a route that refuses everybody. An endpoint that
    // dropped `ensureMatterAccess` would answer this same failure to both.
    expect(res.status).toBe(500);
    expect(bodyText(res)).not.toContain('do not have access');
  });

  it('is refused with no files at all, before anything is stored', async () => {
    // Through init, which is where the refusal now lands: an empty selection
    // never gets a session, so there is nothing to finalize.
    const res = await mine.api.post(P(`matters/${myMatter}/documents/upload-init`)).send({ files: [] });

    expect(res.status).toBe(400);
    expect(await firmFileRows(firm.id)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Signing a URL for a document                                       */
/* ------------------------------------------------------------------ */

describe('minting a download URL for a document the client names', () => {
  /** A document in one matter's tree, shared with the portal. */
  async function sharedDocIn(matterId: string, name: string) {
    const root = await rootOf(firm.id, { matterId });
    return seedFile(firm.id, { parentId: root, name, clientVisible: true });
  }

  /** A document in one client's own file area, shared with the portal. */
  async function sharedDocFor(clientId: string, name: string) {
    const root = await rootOf(firm.id, { clientId });
    return seedFile(firm.id, { parentId: root, name, clientVisible: true });
  }

  it('refuses a document in a matter this client is not on', async () => {
    const theirDoc = await sharedDocIn(theirMatter, 'otto-discharge.pdf');

    const res = await mine.api
      .post(P('documents/refresh-url'))
      .send({ fileId: theirDoc.id });

    // The ROW carries the matter, and the matter is checked against this
    // caller's own before any object is read. It used to be parsed out of a
    // client-supplied path, which put the wall at the mercy of a string.
    expect(res.status).toBe(404);
  });

  it('accepts a document in a matter this client IS on', async () => {
    const myDoc = await sharedDocIn(myMatter, 'mine.pdf');

    const res = await mine.api
      .post(P('documents/refresh-url'))
      .send({ fileId: myDoc.id });

    // The paired positive, which is what makes the refusal above a scope
    // decision rather than this endpoint refusing everything it is given. The
    // access check passes and the request dies at storage instead, because the
    // harness deliberately leaves the bucket unavailable.
    expect(res.status).toBe(500);
  });

  it('refuses a document in another client own file area', async () => {
    const theirDoc = await sharedDocFor(theirs.clientId, 'otto-passport.pdf');

    const res = await mine.api
      .post(P('documents/refresh-url'))
      .send({ fileId: theirDoc.id });

    expect(res.status).toBe(404);
  });

  it('accepts a document in this client own file area', async () => {
    const myDoc = await sharedDocFor(mine.clientId, 'mia-passport.pdf');

    const res = await mine.api
      .post(P('documents/refresh-url'))
      .send({ fileId: myDoc.id });

    expect(res.status).toBe(500);
  });

  it('refuses a document belonging to another firm', async () => {
    const other = await createFirm({ name: 'Vale LLP' });
    await ownerOf(other.id);
    const otherMatter = await seedMatter(other.id, 'Theirs', []);
    const otherRoot = await rootOf(other.id, { matterId: otherMatter });
    const theirs2 = await seedFile(other.id, {
      parentId: otherRoot, name: 'secret.pdf', clientVisible: true,
    });

    const res = await mine.api
      .post(P('documents/refresh-url'))
      .send({ fileId: theirs2.id });

    // There used to be two ways to name another firm's storage prefix: climbing
    // out of this firm's root with `..`, and simply writing the other firm's id.
    // Neither exists now, because the lookup is scoped to the firm in the URL
    // and there is no path for a request to spell.
    expect(res.status).toBe(404);
  });

  it('refuses a document this firm never shared with the portal', async () => {
    const root = await rootOf(firm.id, { matterId: myMatter });
    const internal = await seedFile(firm.id, { parentId: root, name: 'internal-memo.pdf' });

    const res = await mine.api
      .post(P('documents/refresh-url'))
      .send({ fileId: internal.id });

    // Being on the matter is not enough. Most of a matter's documents are the
    // firm's own work, and the share flag is what separates the two.
    expect(res.status).toBe(404);
  });

  it('refuses the matter-scoped variant for a matter this client is not on', async () => {
    const theirDoc = await sharedDocIn(theirMatter, 'otto-discharge.pdf');

    // The same signing service behind a route that ALSO names the matter in the
    // URL. Both the matter parameter and the document belong to the other
    // client, so this fails at the first of the two checks.
    const res = await mine.api
      .post(P(`matters/${theirMatter}/documents/refresh-url`))
      .send({ fileId: theirDoc.id });

    expect(res.status).toBe(403);
  });

  it('refuses a document in another matter even when the URL names an allowed one', async () => {
    const theirDoc = await sharedDocIn(theirMatter, 'otto-discharge.pdf');

    // The mismatch case, and the reason the row is read at all rather than
    // trusted once the URL's matter has been authorized. The route's matter
    // parameter is one this client is genuinely on; the document is not.
    const res = await mine.api
      .post(P(`matters/${myMatter}/documents/refresh-url`))
      .send({ fileId: theirDoc.id });

    expect(res.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/*  Another client's document request                                  */
/* ------------------------------------------------------------------ */

describe('a document request addressed to another client', () => {
  /** The other client's request, hung off the matter BOTH clients are on. */
  const theirRequestOnSharedMatter = () => seedDocumentRequest(
    firm.id, theirs.clientId, sharedMatter,
    {
      title: 'Otto financial disclosure',
      itemLabel: 'Bank statements',
      fileName: 'otto-bank-statements.pdf',
      uploadedBy: theirs.uid,
    },
  );

  it('does not appear in this client list, even on a shared matter', async () => {
    const request = await theirRequestOnSharedMatter();

    const forMe = await mine.api.get(P(`document-requests?matterId=${sharedMatter}`));
    const forThem = await theirs.api.get(P(`document-requests?matterId=${sharedMatter}`));

    // Matter access is not request access. I can open this matter, so a listing
    // scoped by matter alone would hand me the other client's checklist.
    expect(forMe.status).toBe(200);
    expect(forMe.body.requests.map((r: any) => r.id)).not.toContain(request.requestId);
    expect(forThem.body.requests.map((r: any) => r.id)).toEqual([request.requestId]);
  });

  it('cannot be fulfilled by this client, and records no fulfillment', async () => {
    const request = await theirRequestOnSharedMatter();

    const before = await firmFileRows(firm.id);

    const res = await portalUpload(mine, P(`document-requests/${request.requestId}/items/${request.itemId}/fulfill`), [{ name: 'planted.pdf', size: Buffer.byteLength(Buffer.from('planted statement')) }]);

    expect(res.status).toBe(403);
    // One fulfillment: the seeded one. A request that got through would have
    // recorded a second against somebody else's checklist item, and mirrored a
    // file into the shared matter under their name.
    expect(await fulfillmentCount(request.itemId)).toBe(1);
    // The seeded fulfillment now carries a `files` row of its own: a fulfillment
    // became an `attachments` row keyed on a file (migration 0236), so the seed
    // creates one. What must not appear is a SECOND row from the refused call.
    expect(await firmFileRows(firm.id)).toEqual(before);
  });

  it('cannot have its uploaded file removed by this client', async () => {
    const request = await theirRequestOnSharedMatter();
    const suffix = `document-requests/${request.requestId}`
      + `/items/${request.itemId}/fulfillments/${request.fulfillmentId}`;

    const refused = await mine.api.delete(P(suffix));

    expect(refused.status).toBe(403);
    expect(await fulfillmentCount(request.itemId)).toBe(1);

    // The client it is addressed to removes it themselves, which proves the id,
    // the route and the delete all work. Without this the survival above would
    // also be satisfied by an endpoint that never deletes anything.
    const allowed = await theirs.api.delete(P(suffix));
    expect(allowed.status).toBe(200);
    expect(await fulfillmentCount(request.itemId)).toBe(0);
  });

  it('cannot have its uploaded file signed for download by this client', async () => {
    const request = await theirRequestOnSharedMatter();
    const suffix = `document-requests/${request.requestId}`
      + `/items/${request.itemId}/fulfillments/${request.fulfillmentId}/url`;

    const refused = await mine.api.get(P(suffix));
    const allowed = await theirs.api.get(P(suffix));

    // 403 versus a storage failure. The client the request belongs to gets past
    // the ownership check and is stopped only by the unavailable bucket; this
    // one never reaches it, and nothing about the stored object comes back.
    expect(refused.status).toBe(403);
    expect(bodyText(refused)).not.toContain(request.objectPath);
    expect(allowed.status).toBe(500);
  });
});

/* ------------------------------------------------------------------ */
/*  The firm's own view is unaffected                                  */
/* ------------------------------------------------------------------ */

describe('the firm side of the same data', () => {
  it('still sees both matters, so the portal refusals are portal-only', async () => {
    // A guard against the wrong fix. Every refusal above could also be produced
    // by data that is simply missing or unreadable, and this is the cheapest way
    // to rule that out for the whole file at once.
    const res = await owner.api.get(`/api/lawfirms/${firm.id}/matters`);

    expect(res.status).toBe(200);
    const names = (res.body.matters ?? res.body.items ?? []).map((m: any) => m.name).sort();
    expect(names).toEqual(['Joint Venture', 'Mia Only', 'Otto Only']);
  });

  it('holds exactly the three matter-client links the fixtures asked for', async () => {
    const { rows } = await testPool.query(
      `select client_id, count(*)::int as matters
         from matter_clients where law_firm_id = $1 group by client_id order by client_id`,
      [firm.id],
    );

    // Both clients are on two matters each. If a fixture had silently failed,
    // the "not on this matter" cases would be refusals against a client with no
    // matters at all, which is a much weaker thing to have proved.
    expect(rows.map((r: any) => r.matters).sort()).toEqual([2, 2]);
  });
});

/* ------------------------------------------------------------------ */
/*  the matter-id fallback                                             */
/* ------------------------------------------------------------------ */

describe('a client record on no matter', () => {
  /**
   * Two `clients` rows in one firm can share a Firebase uid: the same human is
   * both a personal client and a person on a company roster. The portal scopes
   * every read to ONE of those records at a time (`clientRecordId`).
   *
   * The matter list for the selected record comes from the `matter_clients`
   * junction keyed on that record. A record on no matter must therefore see no
   * matters, even when the OTHER record the same uid holds is on one.
   */
  it('sees no matters from another client record sharing its uid', async () => {
    const jane = await portalPerson(firm.id, 'Jane Personal');

    // A second clients row for the same human, on a matter of its own.
    const rosterRecord = await createPersonClient(firm.id, {
      name: 'Jane On Roster',
      userId: jane.uid,
      email: `${jane.uid}+roster@example.test`,
    });
    const rosterMatter = await seedMatter(firm.id, 'Roster Only Matter', [rosterRecord.id]);

    // Scoped to her personal record, which is on no matter at all.
    const res = await jane.api.get(
      `/api/client-portal/lawfirm/${firm.id}/matters?clientRecordId=${jane.clientId}`,
    );

    expect(res.status).toBe(200);
    expect(bodyText(res)).not.toContain(rosterMatter);
  });
});
