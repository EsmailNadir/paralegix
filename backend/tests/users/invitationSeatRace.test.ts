/**
 * B10.3: "plan-count races" for member invitations.
 *
 * `acceptMemberInviteByToken` checks the firm's seat limit
 * (`enforceCountLimit(..., 'maxMembers', () => repo.countMembers(...))`)
 * before inserting the new `members` row, all inside one transaction per
 * invite. But two DIFFERENT invitations accepted at the same instant run in
 * two DIFFERENT transactions, each locking only its own `invitations` row
 * (see `withInviteClaimTxn`). Nothing serialized the seat COUNT itself, so
 * both transactions could read the same "one seat free" snapshot before
 * either committed its insert, and both would succeed — landing the firm
 * over its paid seat count with nothing on screen ever showing an error.
 *
 * The fix serializes the two transactions on the firm's own row (a real
 * Postgres lock, not a mock), so once it's in place the two accepts can no
 * longer be proven to overlap AT the count itself — one blocks the other
 * there by design. The gate instead holds both requests at `repo.isMember`,
 * the join's first repository call, made BEFORE either transaction reaches
 * the lock. `gate.arrived(2)` is still proof the two HTTP requests are
 * genuinely concurrent, not sequential; releasing them there and then
 * trusting Postgres's real lock to serialize what follows is what actually
 * exercises the fix, rather than gating the very serialization being tested.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  seedRole,
  createFirmMember,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod, type Gate } from '../support/gate';

const repo = require('../../src/modules/invitations/invitations.repository');

let firm: Firm;
let owner: Actor;
let gate: Gate | null = null;

const I = () => `/api/lawfirms/${firm.id}/invitations`;

/**
 * A pending member invitation, straight into the table.
 *
 * Seeded directly rather than through `POST /invite-member`, because that
 * route enforces its OWN (separately racy, out of scope here) seat
 * reservation at invite time — `countMembersAndPendingMembers` counts a
 * pending invite as a held seat, so it refuses to let a second invitation
 * out once one is pending for the last open slot. This file is about the
 * ACCEPT-time race between two invitations that already exist, so the
 * fixture puts both directly into the same state two real, sequential
 * `/invite-member` calls would have left them in.
 */
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

async function memberCount(): Promise<number> {
  const { rows } = await testPool.query(
    'select count(*)::int as n from members where law_firm_id = $1', [firm.id],
  );
  return rows[0].n;
}

afterEach(() => {
  gate?.restore();
  gate = null;
});

describe('two invitations racing the last open seat', () => {
  it('never lets both land: the firm ends at or below its member limit', async () => {
    // Starter caps at 3 members. The owner is 1; one more brings it to 2,
    // leaving exactly ONE open seat for two different invitees to race for.
    firm = await createFirm({ planId: 'starter' });
    owner = await ownerOf(firm.id);
    await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    expect(await memberCount()).toBe(2);

    const role = await seedRole(firm.id, { name: 'Paralegal', permissions: ['tasks.view'] });
    const uidA = `race-a-${randomUUID().slice(0, 8)}`;
    const uidB = `race-b-${randomUUID().slice(0, 8)}`;

    const tokenA = await seedMemberInvite(`${uidA}@example.test`, role);
    const tokenB = await seedMemberInvite(`${uidB}@example.test`, role);
    await registerUnaffiliatedMember(uidA);
    await registerUnaffiliatedMember(uidB);
    await drainEvents();

    gate = gateMethod(repo, 'isMember');

    // A bare `as(token).post(url).send(body)` assigned to a variable is an
    // INERT, unsent supertest `Test` object — superagent only dispatches once
    // something calls `.then()`/`.end()` on it, which a plain assignment or
    // `gate.arrived()` never does (see the identical note in
    // `tests/billing/invoiceConcurrency.test.ts`). Wrapping each in an
    // `async function` that RETURNS the chain makes the language itself call
    // `.then()` on the return value, which is what actually sends it.
    async function acceptA() {
      return as(tokenFor({ uid: uidA })).post('/api/invitations/member-accept').send({ token: tokenA });
    }
    async function acceptB() {
      return as(tokenFor({ uid: uidB })).post('/api/invitations/member-accept').send({ token: tokenB });
    }

    const pA = acceptA();
    const pB = acceptB();

    // PROOF the two requests are genuinely concurrent going into the join's
    // critical section, not a hope that Promise.all interleaved them.
    await gate.arrived(2);
    gate.open();

    const [resA, resB] = await Promise.all([pA, pB]);
    await drainEvents();

    const statuses = [resA.status, resB.status].sort();
    const succeeded = statuses.filter((s) => s === 200).length;

    // The property the seat limit exists to guarantee: at most one of two
    // requests contending for the LAST seat may succeed, and the loser gets
    // a real error rather than a silent no-op.
    expect(succeeded).toBe(1);
    expect(statuses).toContain(200);
    const failing = resA.status === 200 ? resB : resA;
    expect(failing.status).toBeGreaterThanOrEqual(400);
    expect(failing.body.code).toBe('PLAN_LIMIT_REACHED');

    // The row-level consequence, not just the HTTP status: the firm never
    // actually exceeds the seats it paid for.
    expect(await memberCount()).toBe(3);
  });
});
