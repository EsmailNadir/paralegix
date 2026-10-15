/**
 * GET /api/signing/pending-for-client — the portal's "documents waiting for you"
 * list. It had no coverage.
 *
 * This route is identity-scoped, not firm-scoped: there is no `:lawFirmId` in
 * the path, and one person can be a client of several firms at once. The whole
 * boundary is a single join predicate:
 *
 *     join signature_participants p
 *       on p.session_id = s.id
 *      and p.client_user_id = $1
 *      and p.status = 'active'
 *
 * Two different mistakes in that one clause leak in opposite directions, and
 * neither shows on screen:
 *
 *  - Lose `client_user_id = $1` and every client sees every firm's pending
 *    signature requests, complete with file names.
 *  - Lose `status = 'active'` and a client is shown a document that is not their
 *    turn, or one they already signed. Both invite a second signature on a
 *    sequential envelope.
 *
 * So every absence below is measured against a document that really exists and
 * really is pending for SOMEONE, seeded through the same helpers. An empty
 * answer from an empty table would prove nothing.
 */
import { randomUUID } from 'crypto';

import {
  createFirm,
  ensureUser,
  createPersonClient,
  createPortalUser,
  ownerOf,
  testPool,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedSigningSession, seedSigningParticipant } from '../support/signing';

let firm: Firm;
let owner: Actor;
let rival: Firm;
let rivalOwner: Actor;
/** The portal person this file is about. */
let me: Actor;

const PATH = '/api/signing/pending-for-client';
const anonymous = () => as('');

async function seedSession(options: {
  lawFirmId: string;
  status?: string;
  fileName?: string;
}): Promise<string> {
  const token = `sess-${randomUUID().slice(0, 12)}`;
  await ensureUser('creator-uid');
  await seedSigningSession({
    lawFirmId: options.lawFirmId,
    createdBy: 'creator-uid',
    token,
    session: {
      status: options.status ?? 'pending',
      file_name: options.fileName ?? 'Engagement Agreement.pdf',
      object_path: `lawfirmids/${options.lawFirmId}/general/${token}.pdf`,
      current_signer_order: 1,
    },
  });
  return token;
}

async function seedParticipant(sessionToken: string, options: {
  clientUserId?: string | null;
  memberUserId?: string | null;
  status?: string;
  order?: number;
}) {
  await ensureUser(options.memberUserId);
  await ensureUser(options.clientUserId);
  const suffix = randomUUID().slice(0, 12);
  await seedSigningParticipant({ sessionToken }, {
    roleLabel: 'Signer',
    order: options.order ?? 1,
    name: 'Signer One',
    email: `${suffix}@example.test`,
    status: options.status ?? 'active',
    deliveryMethod: 'portal',
    columns: {
      member_user_id: options.memberUserId ?? null,
      client_user_id: options.clientUserId ?? null,
    },
    token: false,
  }, { index: 0, idSuffix: suffix });
}

/** One pending document waiting on `clientUid` at `lawFirmId`. */
async function seedPendingFor(lawFirmId: string, clientUid: string, fileName: string) {
  const token = await seedSession({ lawFirmId, fileName });
  await seedParticipant(token, { clientUserId: clientUid });
  return token;
}

const fileNames = (body: any) => body.pendingDocuments.map((d: any) => d.fileName);

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  rival = await createFirm({ name: 'Rival LLP' });
  rivalOwner = await ownerOf(rival.id);

  const portal = await createPortalUser();
  me = { uid: portal.uid, api: as(tokenFor({ uid: portal.uid })) };
  await createPersonClient(firm.id, { name: 'Me The Client', userId: portal.uid });
});

describe('who may call it', () => {
  it('refuses an anonymous caller', async () => {
    const res = await anonymous().get(PATH);

    expect(res.status).toBe(401);
  });

  it('refuses a firm member, who is not a client', async () => {
    const res = await owner.api.get(PATH);

    expect(res.status).toBe(403);
  });
});

describe('what a client is shown', () => {
  it('does not list a document waiting on a DIFFERENT client', async () => {
    const other = await createPortalUser();
    await createPersonClient(firm.id, { name: 'Other Client', userId: other.uid });
    await seedPendingFor(firm.id, other.uid, 'Not Mine.pdf');

    const res = await me.api.get(PATH);

    // Same firm, both real clients, one real pending document. There is no
    // law_firm_id difference to accidentally save this: `client_user_id` is the
    // only thing separating the two people.
    expect(res.status).toBe(200);
    expect(fileNames(res.body)).toEqual([]);
  });

  it('does not list a document from a firm this person is not a client of', async () => {
    const theirClient = await createPortalUser();
    await createPersonClient(rival.id, { name: 'Rival Client', userId: theirClient.uid });
    await seedPendingFor(rival.id, theirClient.uid, 'Rival Confidential.pdf');
    await seedPendingFor(firm.id, me.uid, 'Mine.pdf');

    const res = await me.api.get(PATH);

    // Paired with the positive: asserting only the absence would pass against a
    // route that returned nothing at all.
    expect(fileNames(res.body)).toEqual(['Mine.pdf']);
  });

  it('does not list a document where their turn has not come yet', async () => {
    const token = await seedSession({ lawFirmId: firm.id, fileName: 'Waiting My Turn.pdf' });
    await seedParticipant(token, { memberUserId: owner.uid, status: 'active', order: 1 });
    await seedParticipant(token, { clientUserId: me.uid, status: 'waiting', order: 2 });

    const res = await me.api.get(PATH);

    // A sequential envelope. Showing it now invites a signature out of order on
    // a document the first signer may still change.
    expect(fileNames(res.body)).not.toContain('Waiting My Turn.pdf');
  });

  it('does not list a document they have already signed', async () => {
    const token = await seedSession({ lawFirmId: firm.id, fileName: 'Already Signed.pdf', status: 'in_progress' });
    await seedParticipant(token, { clientUserId: me.uid, status: 'completed', order: 1 });

    const res = await me.api.get(PATH);

    // The session is still open for the NEXT signer, so it is the participant's
    // own status that has to take it off this person's list.
    expect(fileNames(res.body)).not.toContain('Already Signed.pdf');
  });

  it.each([
    ['completed', 'Finished.pdf'],
    ['cancelled', 'Called Off.pdf'],
    ['expired', 'Lapsed.pdf'],
  ])('does not list a %s session', async (status, fileName) => {
    const token = await seedSession({ lawFirmId: firm.id, status, fileName });
    await seedParticipant(token, { clientUserId: me.uid, status: 'active' });

    const res = await me.api.get(PATH);

    // The participant row still says active in each of these; only the SESSION
    // status moved. A list built from the participant alone would keep offering
    // a document nobody can sign any more.
    expect(fileNames(res.body)).not.toContain(fileName);
  });

  it('lists documents across every firm this person is a client of, and narrows to one when asked', async () => {
    await createPersonClient(rival.id, { name: 'Me At The Rival', userId: me.uid });
    await seedPendingFor(firm.id, me.uid, 'From Hale.pdf');
    await seedPendingFor(rival.id, me.uid, 'From Rival.pdf');

    const everyFirm = await me.api.get(PATH);
    const oneFirm = await me.api.get(`${PATH}?lawFirmId=${firm.id}`);

    // The route is deliberately account-wide: one person can be a client of
    // several firms, and the portal's badge counts all of them.
    expect(fileNames(everyFirm.body).sort()).toEqual(['From Hale.pdf', 'From Rival.pdf']);
    expect(fileNames(oneFirm.body)).toEqual(['From Hale.pdf']);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so its
// top-level bindings stay file-scoped rather than colliding across specs.
export {};
