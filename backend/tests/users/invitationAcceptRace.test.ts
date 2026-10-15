/**
 * Two ways to end up as a firm member, colliding in time.
 *
 * `tests/users/invitationSeatRace.test.ts` already proved the plan-count race
 * between two DIFFERENT pending invitations to the same firm. This file
 * covers two races the B10.3 plan calls out separately: the SAME invitation
 * accepted twice at once, and an invitation accepted at the exact moment
 * someone else adds that same person to the firm through a completely
 * different route.
 *
 * `acceptMemberInviteByToken`'s join is written to be idempotent on purpose
 * ("an already-member (idempotent re-accept) just commits the claim with no
 * insert" - see the comment above it in invitations.service.ts), and
 * `invitations.repository.addMember` inserts with `ON CONFLICT DO NOTHING` on
 * the `(law_firm_id, user_id)` primary key. Both cases below exist to prove
 * that design actually holds under genuine concurrency, not just when the two
 * writes happen to land one after the other.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  seedRole,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod, type Gate } from '../support/gate';

const repo = require('../../src/modules/invitations/invitations.repository');
const usersRepo = require('../../src/modules/users/users.repository');

let firm: Firm;
let owner: Actor;
let gate: Gate | null = null;

const inviteUrl = () => `/api/lawfirms/${firm.id}/invitations/invite-member`;

async function seedMemberInvite(email: string, roleId: string): Promise<string> {
  const token = randomUUID().replace(/-/g, '');
  await testPool.query(
    `insert into invitations (law_firm_id, email, invite_type, role_id, token, status, invited_by)
     values ($1, $2, 'member', $3, $4, 'pending', $5)`,
    [firm.id, email, roleId, token, owner.uid],
  );
  return token;
}

/** A registered firm_member-type account that belongs to no firm yet. */
async function registerUnaffiliatedMember(uid: string) {
  await testPool.query(
    `insert into users (id, email, name, user_type)
     values ($1, $2, $3, 'firm_member')`,
    [uid, `${uid}@example.test`, `Invitee ${uid.slice(-4)}`],
  );
}

async function memberRowsFor(userId: string) {
  const { rows } = await testPool.query(
    'select user_id, role_id from members where law_firm_id = $1 and user_id = $2',
    [firm.id, userId],
  );
  return rows;
}

async function inviteRow(token: string) {
  const { rows } = await testPool.query(
    'select status, accepted_by from invitations where token = $1', [token],
  );
  return rows[0];
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Race Firm' });
  owner = await ownerOf(firm.id);
  await drainEvents();
});

afterEach(() => {
  gate?.restore();
  gate = null;
});

describe('two simultaneous accepts of the SAME invitation token', () => {
  it('lets exactly one through and cleanly refuses the other', async () => {
    const role = await seedRole(firm.id, { name: 'Paralegal', permissions: ['tasks.view'] });
    const uid = `dup-accept-${randomUUID().slice(0, 8)}`;
    const token = await seedMemberInvite(`${uid}@example.test`, role);
    await registerUnaffiliatedMember(uid);
    await drainEvents();

    // Gated at the entry of the first serializing step: the accept
    // transaction's `lockForMembershipChange`, a `FOR NO KEY UPDATE` on the
    // invitee's users row taken before the token is even looked up. Both
    // requests have opened their transactions but neither holds the lock yet,
    // so two calls paused here is proof of genuine overlap, and what happens
    // after `open()` is the real Postgres lock, not the gate. A gate on any
    // later call (`findByToken`, the claim's `SELECT ... FOR UPDATE`) can only
    // ever see one request: the other is already blocked on the users row.
    gate = gateMethod(usersRepo, 'lockForMembershipChange');

    async function accept() {
      return as(tokenFor({ uid })).post('/api/invitations/member-accept').send({ token });
    }

    const pA = accept();
    const pB = accept();

    // A generous window: under a full-suite run (four workers, heavy DB
    // truncation between every spec) the event loop can be slow enough that
    // two requests fired back-to-back still take longer than the gate's
    // 5s default to both reach the gated call. Widening the wait does not
    // weaken the assertion -- it still requires genuine two-way overlap,
    // just tolerates variable host load instead of the request's own speed.
    await gate.arrived(2, 20_000);
    gate.open();

    const [resA, resB] = await Promise.all([pA, pB]);
    await drainEvents();

    const succeeded = [resA.status, resB.status].filter((s) => s === 200);
    expect(succeeded).toHaveLength(1);
    const failing = resA.status === 200 ? resB : resA;
    // A clean refusal because the second transaction finds the invitation
    // already accepted, not a crash from two writers racing the same row.
    expect(failing.status).toBeGreaterThanOrEqual(400);
    expect(failing.status).toBeLessThan(500);

    // One membership, one acceptance recorded, however many HTTP requests hit it.
    const members = await memberRowsFor(uid);
    expect(members).toHaveLength(1);
    const row = await inviteRow(token);
    expect(row.status).toBe('accepted');
    expect(row.accepted_by).toBe(uid);
  });
});

describe('firm membership added elsewhere while the invitee is accepting', () => {
  it('an owner directly adding the invitee, racing their own accept, still lands exactly one membership', async () => {
    // Invited while unregistered, so the invite went out as a real pending
    // token rather than the direct-add branch (see invitations.test.ts's
    // `invitedUid` comment for why the order matters).
    const role = await seedRole(firm.id, { name: 'Paralegal', permissions: ['tasks.view'] });
    const uid = `elsewhere-${randomUUID().slice(0, 8)}`;
    const email = `${uid}@example.test`;
    const token = await seedMemberInvite(email, role);

    // The invitee has since registered, which is what makes the SECOND path
    // below possible: `inviteMember` now sees a registered, non-capped
    // existing user and takes the direct-add branch instead of issuing
    // another pending invite. It does not check for the still-pending
    // invitation first, which is the "added elsewhere" scenario: the owner
    // acts as if this is a fresh invite while one is already in flight.
    await registerUnaffiliatedMember(uid);
    await drainEvents();

    const directRole = await seedRole(firm.id, { name: 'Direct Add Role', permissions: ['tasks.view'] });

    // Both paths gate on the same repository call before deciding whether to
    // insert: acceptMemberInviteByToken's join, and inviteMember's own
    // already-a-member guard. Gating it here is what proves the two HTTP
    // requests are genuinely both mid-decision at once, not sequential.
    gate = gateMethod(repo, 'isMember');

    async function acceptViaToken() {
      return as(tokenFor({ uid })).post('/api/invitations/member-accept').send({ token });
    }
    async function addDirectly() {
      return owner.api.post(inviteUrl()).send({ email, roleId: directRole });
    }

    const pAccept = acceptViaToken();
    const pDirect = addDirectly();

    // See the matching comment on the sibling test above: widened for
    // resilience under a full-suite run's host load, not to weaken the
    // overlap requirement.
    await gate.arrived(2, 20_000);
    gate.open();

    const [acceptRes, directRes] = await Promise.all([pAccept, pDirect]);
    await drainEvents();

    // Neither side may 500. And the accept must not come back
    // `FIRM_SWITCH_REQUIRED`: that would mean the invitee is being told to
    // leave the very firm they are joining in order to join it, which is
    // exactly the confusion a same-firm race can cause if the "which firms is
    // this person already in" check does not exclude the firm they are in the
    // middle of accepting into.
    expect(acceptRes.status).toBeLessThan(500);
    expect(directRes.status).toBeLessThan(500);
    expect(acceptRes.body.code).not.toBe('FIRM_SWITCH_REQUIRED');

    // The property that actually matters: however the two requests
    // interleaved, the invitee ends up a member of this firm exactly once,
    // never twice, and never zero times.
    const members = await memberRowsFor(uid);
    expect(members).toHaveLength(1);

    // The token-based invitation is consumed (accepted) rather than left
    // dangling in 'pending' forever, regardless of which side actually
    // inserted the row.
    const row = await inviteRow(token);
    expect(row.status).toBe('accepted');
  });
});
