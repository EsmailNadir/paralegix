/**
 * The three messaging routes keyed on the CALLER's identity rather than on a
 * firm in the path, and the one preference route that carries no
 * `requirePermission` at all.
 *
 * They had no coverage. Each one is a different shape of the same question:
 * what stops this caller seeing somebody else's thread?
 *
 *   GET /api/messaging/realtime-token
 *     Mints a Supabase JWT. There is no firm in the path and no permission
 *     gate, deliberately: it serves firm members and portal clients alike, and
 *     Supabase RLS authorizes per row against the `sub` claim. That makes `sub`
 *     the whole authorization story. A token minted for one caller carrying
 *     another caller's uid would hand them every row RLS grants that person,
 *     over a channel no route in this codebase sees again.
 *
 *   GET /api/messaging/client-conversations
 *     A portal read gated only by `requireUserType(['client'])`, with the uid
 *     taken from the token. Nothing in the path says which firm, so the query
 *     is the only boundary.
 *
 *   GET/PUT /api/lawfirms/:lawFirmId/messaging/present-as-firm
 *     Firm-scoped by path but carrying NO `requirePermission`. The only thing
 *     between a non-member and another firm's row is the
 *     `assertLawFirmMembership` call inside the service. These cases go red if
 *     that call is ever dropped, which is otherwise a silent one-line change.
 *
 * Every absence below is measured against a second firm and a second client
 * that really do have rows, so "not there" is a statement about the boundary
 * rather than about an empty database.
 */
import jwt from 'jsonwebtoken';

import {
  createFirm,
  createPersonClient,
  createPortalUser,
  drainEvents,
  ownerOf,
  memberWith,
  stranger,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let rival: Firm;
let rivalOwner: Actor;

/** A caller with no bearer token at all. */
const anonymous = () => as('');

const presentAsFirmPath = (lawFirmId: string) =>
  `/api/lawfirms/${lawFirmId}/messaging/present-as-firm`;

/** A portal client of `lawFirmId` with a real thread against it. */
async function seedClientWithThread(lawFirmId: string, sender: Actor, name: string) {
  const portal = await createPortalUser();
  await createPersonClient(lawFirmId, { name, userId: portal.uid });
  const sent = await sender.api
    .post(`/api/lawfirms/${lawFirmId}/messaging/send`)
    .send({ clientId: portal.uid, content: `Hello ${name}` });
  expect(sent.status).toBe(201);
  await drainEvents();
  return { uid: portal.uid, api: as(tokenFor({ uid: portal.uid })) };
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  rival = await createFirm({ name: 'Rival LLP' });
  rivalOwner = await ownerOf(rival.id);
  await drainEvents();
});

describe('GET /api/messaging/realtime-token', () => {
  it('refuses an anonymous caller', async () => {
    const res = await anonymous().get('/api/messaging/realtime-token');

    expect(res.status).toBe(401);
  });

  it('signs the CALLING uid, never one supplied by the request', async () => {
    const other = await ownerOf(rival.id);

    // The uid is deliberately offered every way a caller could offer one. None
    // of them may reach the payload: `sub` is the entire authorization input
    // Supabase RLS gets, so a route that read a caller-supplied uid would let
    // anyone mint a token for anyone.
    const res = await owner.api
      .get(`/api/messaging/realtime-token?uid=${other.uid}&sub=${other.uid}`)
      .send({ uid: other.uid });

    expect(res.status).toBe(200);
    const claims = jwt.decode(res.body.token) as Record<string, unknown>;
    expect(claims.sub).toBe(owner.uid);
    expect(claims.sub).not.toBe(other.uid);
  });

  it('serves a portal client as well as a firm member, each with their own sub', async () => {
    const client = await seedClientWithThread(firm.id, owner, 'Threaded Client');

    const forClient = await client.api.get('/api/messaging/realtime-token');
    const forOwner = await owner.api.get('/api/messaging/realtime-token');

    // Both halves matter. The route has no permission gate precisely because a
    // client must be able to call it; asserting only the member case would pass
    // against a gate that locked clients out entirely.
    expect(forClient.status).toBe(200);
    expect((jwt.decode(forClient.body.token) as any).sub).toBe(client.uid);
    expect((jwt.decode(forOwner.body.token) as any).sub).toBe(owner.uid);
  });

  it('carries a short expiry and the authenticated role Supabase expects', async () => {
    const res = await owner.api.get('/api/messaging/realtime-token');

    const claims = jwt.decode(res.body.token) as any;
    // A token with no `exp`, or a far-future one, stays usable long after the
    // session that minted it. The reported `expiresIn` and the signed `exp`
    // are asserted together: a mismatch means the caller refreshes on a
    // schedule the token does not actually keep to.
    expect(res.body.expiresIn).toBeGreaterThan(0);
    expect(res.body.expiresIn).toBeLessThanOrEqual(60 * 60);
    expect(claims.exp - claims.iat).toBe(res.body.expiresIn);
    expect(claims.role).toBe('authenticated');
    expect(claims.aud).toBe('authenticated');
  });

  it('is signed with the configured secret, so a forged token cannot pass', async () => {
    const res = await owner.api.get('/api/messaging/realtime-token');

    // Verifying with the real secret proves the signature is genuine; verifying
    // with a wrong one proves the check is doing something. Without the second
    // half an unsigned (`alg: none`) token would satisfy this test.
    expect(() => jwt.verify(res.body.token, process.env.SUPABASE_JWT_SECRET as string)).not.toThrow();
    expect(() => jwt.verify(res.body.token, 'not-the-secret')).toThrow();
  });
});

describe('GET /api/messaging/client-conversations', () => {
  it('refuses a firm member, who is not a client', async () => {
    const res = await owner.api.get('/api/messaging/client-conversations');

    expect(res.status).toBe(403);
  });

  it('refuses an anonymous caller', async () => {
    const res = await anonymous().get('/api/messaging/client-conversations');

    expect(res.status).toBe(401);
  });

  it('serves the calling client their own thread and not another client of the same firm', async () => {
    const mine = await seedClientWithThread(firm.id, owner, 'My Client');
    const theirs = await seedClientWithThread(firm.id, owner, 'Their Client');

    const res = await mine.api.get('/api/messaging/client-conversations');

    // The co-client is seeded through the same route with a real message, so
    // the absence below is the query scoping and not a database with one row
    // in it. Two clients of ONE firm is the harder case than two firms: there
    // is no law_firm_id difference to accidentally save it.
    expect(res.status).toBe(200);
    const conversations = res.body.conversations ?? [];
    expect(conversations.length).toBe(1);
    expect(JSON.stringify(conversations)).not.toContain('Their Client');
    expect(JSON.stringify(conversations)).not.toContain(theirs.uid);
  });

  it('serves nothing to a portal user who is nobody\'s client', async () => {
    await seedClientWithThread(firm.id, owner, 'Real Client');
    const outsider = await createPortalUser();

    const res = await as(tokenFor({ uid: outsider.uid })).get('/api/messaging/client-conversations');

    // A firm's thread exists in the same table; this caller simply is not party
    // to it. The route reads the uid off the token alone, so this is the case
    // that proves it filters on that uid rather than returning the table.
    expect(res.status).toBe(200);
    expect(res.body.conversations ?? []).toEqual([]);
  });
});

describe('GET/PUT present-as-firm', () => {
  it('defaults to off for a member who has never set it', async () => {
    const res = await owner.api.get(presentAsFirmPath(firm.id));

    expect(res.status).toBe(200);
    expect(res.body.presentAsFirm).toBe(false);
  });

  it('round-trips the preference', async () => {
    const saved = await owner.api.put(presentAsFirmPath(firm.id)).send({ presentAsFirm: true });
    expect(saved.status).toBe(200);

    const on = await owner.api.get(presentAsFirmPath(firm.id));
    expect(on.body.presentAsFirm).toBe(true);

    // Turned back off as well: a write that stored `true` for any input would
    // pass a test that only ever enabled it.
    await owner.api.put(presentAsFirmPath(firm.id)).send({ presentAsFirm: false });
    expect((await owner.api.get(presentAsFirmPath(firm.id))).body.presentAsFirm).toBe(false);
  });

  it('keeps the preference per member, not per firm', async () => {
    const colleague = await memberWith(firm.id, ['messaging.send']);

    await owner.api.put(presentAsFirmPath(firm.id)).send({ presentAsFirm: true });

    // Same firm, different person. A row keyed on the firm alone would show the
    // colleague a preference they never set, and present their name as the
    // firm's in every client thread.
    expect((await colleague.api.get(presentAsFirmPath(firm.id))).body.presentAsFirm).toBe(false);
  });

  it('refuses a member of another firm, on read and on write', async () => {
    await rivalOwner.api.put(presentAsFirmPath(rival.id)).send({ presentAsFirm: true });

    const read = await owner.api.get(presentAsFirmPath(rival.id));
    const write = await owner.api.put(presentAsFirmPath(rival.id)).send({ presentAsFirm: false });

    // This route carries no `requirePermission`; `assertLawFirmMembership`
    // inside the service is the only gate. Both verbs are asserted because the
    // two service functions call it separately, so dropping it from one would
    // leave the other's case green.
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    // The rival's own value is untouched, so the refusal is a refusal rather
    // than a write that happened and then errored.
    expect((await rivalOwner.api.get(presentAsFirmPath(rival.id))).body.presentAsFirm).toBe(true);
  });

  it('refuses a signed-in caller who is a member of no firm', async () => {
    const nobody = stranger();

    const read = await nobody.api.get(presentAsFirmPath(firm.id));
    const write = await nobody.api.put(presentAsFirmPath(firm.id)).send({ presentAsFirm: true });

    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so its
// top-level bindings stay file-scoped rather than colliding across specs.
export {};
