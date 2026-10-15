/**
 * Resending a pending invitation, member and client.
 *
 * Both routes had no coverage, and they share a claim step whose SQL carries no
 * tenant scope at all:
 *
 *   claimResendSlot(id)  ->  systemQuery ... where invitations.id = $1
 *
 * There is no `law_firm_id` in that predicate. The firm boundary is entirely
 * the lookup that runs BEFORE it (`findPendingByIdType(lawFirmId, ...)` for a
 * member, `findByEmailType(lawFirmId, ...)` for a pending client). If either
 * lookup ever loses its firm argument the claim will happily bump another
 * firm's invite and mail that firm's invitee, and nothing downstream would
 * notice. The cross-firm cases below exist to go red at that moment, and they
 * assert the untouched row as well as the status code, because a 404 returned
 * AFTER a write is still a write.
 *
 * The claim also carries the abuse limits: at most 10 resends ever, and at most
 * one per 24 hours. Those are the only thing standing between this route and an
 * unbounded mailer pointed at an address the firm typed in, so each is proved
 * against the ROW's resend count rather than against the response alone.
 *
 * `invitationSentAt` is seeded directly rather than by freezing the clock: the
 * cooldown is `now() - 24 hours` evaluated in Postgres, so moving the row is
 * both simpler and closer to what the predicate actually reads.
 */

import {
  createFirm,
  memberWith,
  ownerOf,
  recipientsOf,
  resetEmails,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedInvite } from '../support/rows';

let firm: Firm;
let owner: Actor;
let rival: Firm;
let rivalOwner: Actor;

const memberResend = (lawFirmId: string) =>
  `/api/lawfirms/${lawFirmId}/invitations/resend-member-invite`;
const clientResend = (lawFirmId: string) =>
  `/api/lawfirms/${lawFirmId}/invitations/resend-client-invite`;

async function inviteRow(id: string) {
  const { rows } = await testPool.query(
    'select invitation_resend_count, invitation_sent_at, status from invitations where id = $1',
    [id],
  );
  return rows[0];
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  rival = await createFirm({ name: 'Rival LLP' });
  rivalOwner = await ownerOf(rival.id);
  resetEmails();
});

describe('resending a member invitation', () => {
  it('sends the invitation again and counts the resend', async () => {
    const email = 'pending.member@example.test';
    const inviteId = await seedInvite({ lawFirmId: firm.id, email, inviteType: 'member' });

    const res = await owner.api.post(memberResend(firm.id)).send({ inviteId });

    expect(res.status).toBe(200);
    // The count on the ROW, not the response: the response is what makes the
    // rate limit's own assertions below meaningful, and it is derived from this.
    expect((await inviteRow(inviteId)).invitation_resend_count).toBe(1);
    expect(recipientsOf(/invit/i)).toContain(email);
  });

  it('refuses a member without members.invite', async () => {
    const email = 'gated.member@example.test';
    const inviteId = await seedInvite({ lawFirmId: firm.id, email, inviteType: 'member' });
    // `clients.invite` is a neighbouring invite permission. Holding it must not
    // open the member route, or the two codes are one code wearing two names.
    const narrow = await memberWith(firm.id, ['clients.invite']);

    const res = await narrow.api.post(memberResend(firm.id)).send({ inviteId });

    expect(res.status).toBe(403);
    expect((await inviteRow(inviteId)).invitation_resend_count).toBe(0);
    expect(recipientsOf(/invit/i)).not.toContain(email);
  });

  it('does not let one firm resend another firm invitation', async () => {
    const email = 'their.member@example.test';
    const theirInvite = await seedInvite({ lawFirmId: rival.id, email, inviteType: 'member' });

    const res = await owner.api.post(memberResend(firm.id)).send({ inviteId: theirInvite });

    // `claimResendSlot` has no tenant predicate, so the 404 has to come from the
    // firm-scoped lookup ahead of it. The row and the mailbox are both checked:
    // a refusal that still bumped the count would have sent their invitee an
    // email from a firm they have never heard of.
    expect(res.status).toBe(404);
    expect((await inviteRow(theirInvite)).invitation_resend_count).toBe(0);
    expect(recipientsOf(/invit/i)).not.toContain(email);
  });

  it('answers not-found for an invitation that does not exist', async () => {
    const res = await owner.api.post(memberResend(firm.id))
      .send({ inviteId: '00000000-0000-0000-0000-000000000000' });

    expect(res.status).toBe(404);
  });

  it('refuses a malformed invitation id without a 500', async () => {
    const res = await owner.api.post(memberResend(firm.id)).send({ inviteId: 'not-a-uuid' });

    // `invitations.id` is uuid, so an unguarded value reaches Postgres as a cast
    // error and surfaces as an INTERNAL_ERROR. The caller sent bad input; the
    // answer is the same one a stranger's id gets.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('will not resend one already claimed inside the cooldown window', async () => {
    const email = 'cooled.member@example.test';
    const inviteId = await seedInvite({
      lawFirmId: firm.id, email, inviteType: 'member', sentAt: 'now', resendCount: 1,
    });

    const res = await owner.api.post(memberResend(firm.id)).send({ inviteId });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/24 hours/i);
    expect((await inviteRow(inviteId)).invitation_resend_count).toBe(1);
    expect(recipientsOf(/invit/i)).not.toContain(email);
  });

  it('resends again once the cooldown has passed', async () => {
    const email = 'thawed.member@example.test';
    const inviteId = await seedInvite({
      lawFirmId: firm.id, email, inviteType: 'member', sentAt: 'long ago', resendCount: 1,
    });

    const res = await owner.api.post(memberResend(firm.id)).send({ inviteId });

    // The other side of the window. Without this the cooldown could be rejecting
    // every resend and the case above would still pass.
    expect(res.status).toBe(200);
    expect((await inviteRow(inviteId)).invitation_resend_count).toBe(2);
    expect(recipientsOf(/invit/i)).toContain(email);
  });

  it('stops at ten resends however long the caller waits', async () => {
    const email = 'exhausted.member@example.test';
    const inviteId = await seedInvite({
      lawFirmId: firm.id, email, inviteType: 'member', sentAt: 'long ago', resendCount: 10,
    });

    const res = await owner.api.post(memberResend(firm.id)).send({ inviteId });

    // Seeded OUTSIDE the cooldown on purpose: the two limits are separate
    // predicates in one statement, and a fixture inside the window would report
    // the cooldown message and prove nothing about the cap.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Maximum number of resends/i);
    expect((await inviteRow(inviteId)).invitation_resend_count).toBe(10);
    expect(recipientsOf(/invit/i)).not.toContain(email);
  });

  it('will not resend an invitation that is no longer pending', async () => {
    const email = 'revoked.member@example.test';
    const inviteId = await seedInvite({
      lawFirmId: firm.id, email, inviteType: 'member', status: 'revoked',
    });

    const res = await owner.api.post(memberResend(firm.id)).send({ inviteId });

    // A revoked invite is a decision the firm already made. Resending one would
    // re-open access somebody deliberately closed.
    expect(res.status).toBe(404);
    expect(recipientsOf(/invit/i)).not.toContain(email);
  });

  it('will not resend a CLIENT invitation through the member route', async () => {
    const email = 'wrong.type@example.test';
    const inviteId = await seedInvite({ lawFirmId: firm.id, email, inviteType: 'client' });

    const res = await owner.api.post(memberResend(firm.id)).send({ inviteId });

    // The two types carry different permissions and land the recipient in
    // different places: a client invite claimed through the member path would
    // make an outside client a member of the firm.
    expect(res.status).toBe(404);
    expect((await inviteRow(inviteId)).invitation_resend_count).toBe(0);
  });
});

describe('resending a pending client invitation', () => {
  it('sends it again and counts the resend, addressed by email', async () => {
    const email = 'pending.client@example.test';
    const inviteId = await seedInvite({ lawFirmId: firm.id, email, inviteType: 'client' });

    // Before a `clients` row exists the identifier IS the email; the route
    // resolves which meaning applies. This is the pre-client branch.
    const res = await owner.api.post(clientResend(firm.id)).send({ clientId: email });

    expect(res.status).toBe(200);
    expect((await inviteRow(inviteId)).invitation_resend_count).toBe(1);
    expect(recipientsOf(/invit/i)).toContain(email);
  });

  it('refuses a member without clients.invite', async () => {
    const email = 'gated.client@example.test';
    const inviteId = await seedInvite({ lawFirmId: firm.id, email, inviteType: 'client' });
    const narrow = await memberWith(firm.id, ['members.invite']);

    const res = await narrow.api.post(clientResend(firm.id)).send({ clientId: email });

    expect(res.status).toBe(403);
    expect((await inviteRow(inviteId)).invitation_resend_count).toBe(0);
    expect(recipientsOf(/invit/i)).not.toContain(email);
  });

  it('does not let one firm resend another firm pending client invite', async () => {
    const email = 'their.client@example.test';
    const theirInvite = await seedInvite({ lawFirmId: rival.id, email, inviteType: 'client' });

    const res = await owner.api.post(clientResend(firm.id)).send({ clientId: email });

    // The email is the lookup key here, and an email is not firm-specific: the
    // same address can be pending at two firms at once. Only the firm scope on
    // the lookup separates them.
    expect(res.status).toBe(404);
    expect((await inviteRow(theirInvite)).invitation_resend_count).toBe(0);
    expect(recipientsOf(/invit/i)).not.toContain(email);
  });

  it('resends each firm own invite when the same address is pending at both', async () => {
    const email = 'shared.address@example.test';
    const mine = await seedInvite({ lawFirmId: firm.id, email, inviteType: 'client' });
    const theirs = await seedInvite({ lawFirmId: rival.id, email, inviteType: 'client' });

    const res = await owner.api.post(clientResend(firm.id)).send({ clientId: email });

    // The sharpest version of the case above: one address, two real pending
    // invites, and the lookup must pick this firm's. A query that dropped the
    // firm scope would still answer 200 here and bump the wrong row, which the
    // status code alone cannot tell apart.
    expect(res.status).toBe(200);
    expect((await inviteRow(mine)).invitation_resend_count).toBe(1);
    expect((await inviteRow(theirs)).invitation_resend_count).toBe(0);
  });

  it('answers not-found for an address with no pending invite', async () => {
    const res = await owner.api.post(clientResend(firm.id))
      .send({ clientId: 'nobody@example.test' });

    expect(res.status).toBe(404);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so its
// top-level bindings stay file-scoped rather than colliding across specs.
export {};
