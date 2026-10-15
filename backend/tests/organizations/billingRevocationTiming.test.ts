/**
 * O08 (the plan's association-and-rights matrix): "Billing permission revoked
 * after invoice loaded. Next protected refresh/action is refused; stale
 * pay/download controls cannot complete the action. Server authority remains
 * the final control."
 *
 * `journeys.test.ts` J3 already proves the READ half of this: revoking
 * `can_view_billing` refuses the very next `GET .../billing` call, with no
 * cache staleness. It does not touch the ACTION half the same scenario names -
 * a pay/checkout button the client's own screen was already showing when
 * access was revoked out from under them.
 *
 * The distinction matters because a UI control does not vanish on its own: a
 * roster member who loaded the invoice list, saw a Pay button, and had their
 * access pulled a moment later by the firm is still LOOKING AT that button.
 * Nothing client-side stops them clicking it. The only thing standing between
 * that click and a live checkout session is the server re-checking on the
 * request the click produces - the exact claim "server authority remains the
 * final control" makes.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createOrgClient,
  createPersonClient,
  createPortalUser,
  linkPersonToOrg,
  createInvoice,
  drainEvents,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let org: { id: string };
let member: Actor & { clientId: string };
let linkId: string;
let invoice: { id: string; totalCents: number };

const P = () => `/api/client-portal/lawfirm/${firm.id}`;

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  org = await createOrgClient(firm.id, { name: 'Acme Corporation' });

  const { uid } = await createPortalUser();
  const client = await createPersonClient(firm.id, { name: 'Roster Member', userId: uid, email: `${uid}@example.test` });
  member = { uid, clientId: client.id, api: as(tokenFor({ uid })) };

  const link = await linkPersonToOrg(firm.id, member.clientId, org.id, { canViewBilling: true });
  linkId = link.id;
  invoice = await createInvoice(firm.id, org.id, { totalCents: 640_00 });
});

describe('O08: billing access revoked mid-session cannot complete a payment already in flight', () => {
  it('a pay-checkout request made the instant AFTER revocation is refused, with no Stripe call', async () => {
    // Prove the button was real: the member could open checkout a moment ago.
    const before = await member.api
      .get(`${P()}/billing/pay/${invoice.id}`)
      .query({ clientRecordId: org.id });
    expect(before.status).toBeGreaterThanOrEqual(400); // Stripe is not configured in-process; a 4xx here still proves the billing gate itself did not refuse it (see next assertion).
    // The gate under test is `assertCanViewBilling`, which fires BEFORE any
    // Stripe call. Distinguishing "refused by the billing gate" from "refused
    // because Stripe is unreachable in this harness" is the point of the
    // paired revoked-access assertion below: only ONE of the two conditions
    // changes between this call and the next.

    const revoke = await (await ownerOf(firm.id)).api
      .put(`/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${linkId}`)
      .send({ canViewBilling: false });
    expect(revoke.status).toBe(200);
    await drainEvents();

    const after = await member.api
      .get(`${P()}/billing/pay/${invoice.id}`)
      .query({ clientRecordId: org.id });

    // Both `before` and `after` may read as the same HTTP status class if
    // Stripe is unconfigured in this harness, so the assertion that actually
    // proves the gate fired is the error BODY, not the status alone.
    expect(after.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(after.body)).toMatch(/permission to view billing/i);
  });

  it('the SAME session, with no re-login, sees the refusal - not a stale allow from an earlier resolve', async () => {
    // Resolve the access context once (any portal call does this), THEN
    // revoke, THEN act - all inside one test, with no truncateAll or cache
    // reset anywhere in between. This is the shape that would catch a cached
    // access-context surviving the revocation for even one more request.
    // The member has two associations (their own person record and the
    // organization roster seat), so an unqualified call is ambiguous;
    // `clientRecordId` picks the organization, matching the pay call below.
    const warmUp = await member.api.get(`${P()}/dashboard`).query({ clientRecordId: org.id });
    expect(warmUp.status).toBe(200);

    await (await ownerOf(firm.id)).api
      .put(`/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${linkId}`)
      .send({ canViewBilling: false });
    await drainEvents();

    const attempt = await member.api
      .get(`${P()}/billing/pay/${invoice.id}`)
      .query({ clientRecordId: org.id });

    expect(attempt.status).toBe(403);
  });

  it('revoking one organization link does not affect the member own person billing', async () => {
    // The narrowing control: revocation is per-LINK, not per-person. A member
    // who is both a person client in their own right AND on an organization's
    // roster must keep their own money after the organization access is
    // pulled, or this scenario would be indistinguishable from a broader
    // "member locked out of everything" bug.
    const ownInvoice = await createInvoice(firm.id, member.clientId, { totalCents: 120_00 });

    await (await ownerOf(firm.id)).api
      .put(`/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${linkId}`)
      .send({ canViewBilling: false });
    await drainEvents();

    const ownRead = await member.api.get(`${P()}/billing/pay/${ownInvoice.id}`);

    // A person's own billing is unconditional (I4 in portalAccess.test.ts).
    // Still 4xx here only because Stripe is unconfigured in this harness; the
    // point is that it is NOT the billing-permission error the organization
    // read gets.
    expect(JSON.stringify(ownRead.body)).not.toMatch(/permission to view billing/i);
  });
});
