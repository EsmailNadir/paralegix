/**
 * B05.2 scenario 1 (the plan's full state-change journeys): "Create
 * organization, add two people, assign different billing flags, attach a
 * matter, create billable work and an invoice, then query both portal
 * identities. Assert content and delivery separately."
 *
 * Every individual link in this chain is already proven elsewhere:
 * `billingAccessVsDelivery.test.ts` (O04) crosses `can_view_billing` and
 * `is_email_recipient` on a fixture-seeded roster, and
 * `billingRecipientSnapshotTiming.test.ts` covers the draft/issued recipient
 * rule. Neither runs the chain that actually PRODUCES that world: an
 * organization created through the API, two real people added to it through
 * the real roster endpoint, a real matter attached to the organization, real
 * billable work logged against it, and a real invoice issued from that work -
 * with nothing pre-seeded by SQL except the identities a portal login needs
 * (a Firebase uid and the Person `clients` row it authenticates, which is
 * infrastructure no route exists to create end-to-end, not the business
 * action under test).
 *
 * The value of doing it this way over seeding the end state directly: a step
 * earlier in the chain that quietly attaches the wrong client, drops a link,
 * or bills the wrong context would still leave a fixture-seeded world looking
 * correct. Only building the world through the real routes can catch that.
 *
 * The read side pins two rules that are easy to conflate but are NOT the same
 * gate (`clientAssociation.resolver.ts`, `portal.service.ts`):
 *
 *   - Matter/notes/file access follows roster MEMBERSHIP alone. Every person
 *     `client_company_links` names, regardless of `can_view_billing`, gets an
 *     association that can select `clientRecordId=<org>` and see what that
 *     record is attached to.
 *   - Billing CONTENT (`GET .../billing`, `GET .../invoices/:id`) is refused
 *     by `assertCanViewBilling` unless that specific link's `can_view_billing`
 *     is true - independent of the roster membership above.
 *   - Billing DELIVERY (who is actually emailed) follows `is_email_recipient`
 *     alone, resolved by `fetchCompanyBillingContacts`, and never reads
 *     `can_view_billing` at all.
 *
 * So a roster member can be refused the invoice's CONTENT while still being
 * able to see the matter it belongs to, and can be excluded from DELIVERY
 * independently of both.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  createPortalUser,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { recipientsOf } from '../support/email.mock';

let firm: Firm;
let owner: Actor;

const CLIENTS = () => `/api/lawfirms/${firm.id}/clients`;
const MATTERS = () => `/api/lawfirms/${firm.id}/matters`;
const TIME_ENTRIES = () => `/api/lawfirms/${firm.id}/billing/time-entries`;
const INVOICES = () => `/api/lawfirms/${firm.id}/billing/invoices`;
const portalPath = (suffix: string, clientRecordId: string) =>
  `/api/client-portal/lawfirm/${firm.id}/${suffix}?clientRecordId=${clientRecordId}`;

beforeEach(async () => {
  firm = await createFirm({ name: 'Journey Firm' });
  owner = await ownerOf(firm.id);
});

describe('B05.2 #1: organization -> roster -> matter -> billable work -> invoice -> both portals', () => {
  it('walks the full chain through real routes, then checks content and delivery separately for each roster identity', async () => {
    // 1. The organization, through the real client-creation route.
    const orgRes = await owner.api.post(CLIENTS()).send({ clientType: 'company', name: 'Acme Corporation' });
    expect(orgRes.status).toBe(201);
    const orgId = orgRes.body.clientId;

    // 2. Two people, added to the roster through the real contacts route with
    // opposite billing flags. The Firebase uid + Person `clients` row is
    // created directly - a portal login's identity, not the roster-add action
    // itself, which runs through the real endpoint below.
    const { uid: aliceUid } = await createPortalUser({ name: 'Alice Billing' });
    const alice = await createPersonClient(firm.id, {
      name: 'Alice Billing', userId: aliceUid, email: 'alice-billing@example.test',
    });
    const aliceLink = await owner.api.post(`${CLIENTS()}/${orgId}/contacts`).send({
      personClientId: alice.id, canViewBilling: true, isEmailRecipient: true,
    });
    expect(aliceLink.status).toBe(201);

    const { uid: bobUid } = await createPortalUser({ name: 'Bob NoBilling' });
    const bob = await createPersonClient(firm.id, {
      name: 'Bob NoBilling', userId: bobUid, email: 'bob-nobilling@example.test',
    });
    const bobLink = await owner.api.post(`${CLIENTS()}/${orgId}/contacts`).send({
      personClientId: bob.id, canViewBilling: false, isEmailRecipient: false,
    });
    expect(bobLink.status).toBe(201);
    await drainEvents();

    // 3. A real matter, attached to the organization at creation time.
    const matterRes = await owner.api.post(MATTERS()).send({
      name: 'Acme Acquisition',
      clients: [{ clientId: orgId, name: 'Acme Corporation' }],
    });
    expect(matterRes.status).toBe(201);
    const matterId = matterRes.body.matterId;
    const linkedRow = await testPool.query(
      'select 1 from matter_clients where matter_id = $1 and client_id = $2',
      [matterId, orgId],
    );
    expect(linkedRow.rows).toHaveLength(1);

    // 4. Real billable work against that matter.
    const timeEntryRes = await owner.api.post(TIME_ENTRIES()).send({
      matterId, userId: owner.uid, hours: 5, date: '2026-03-10',
      hourlyRate: 200, description: 'Due diligence review',
    });
    expect(timeEntryRes.status).toBe(201);
    const timeEntry = timeEntryRes.body.timeEntry;
    const lineAmount = timeEntry.hours * timeEntry.hourlyRate;

    // 5. A real invoice for that work, billed to the organization.
    const invoiceRes = await owner.api.post(INVOICES()).send({
      matterId,
      clientId: orgId,
      invoiceName: 'INV-JOURNEY-1',
      invoiceDate: '2026-03-15',
      dueDate: '2026-04-14',
      timeEntries: [{
        id: timeEntry.id, description: timeEntry.description,
        hours: timeEntry.hours, rate: timeEntry.hourlyRate, amount: lineAmount,
      }],
      totalAmount: lineAmount,
      totalHours: timeEntry.hours,
    });
    expect(invoiceRes.status).toBe(201);
    const invoiceId = invoiceRes.body.invoice.id;
    expect(invoiceRes.body.invoice.clientId).toBe(orgId);

    // Issue it: the invoice's first external send is what actually freezes and
    // delivers the recipient list (`billingRecipientSnapshotTiming.test.ts`
    // covers the freeze itself; this file only needs the delivery it produces).
    const sendRes = await owner.api.post(`${INVOICES()}/matter/${matterId}/${invoiceId}/send-email`).send({});
    expect(sendRes.status).toBe(200);
    expect(sendRes.body.sent).toBe(true);
    await drainEvents();

    const aliceApi = as(tokenFor({ uid: aliceUid }));
    const bobApi = as(tokenFor({ uid: bobUid }));

    // 6a. CONTENT - checked separately per identity, and separately per
    // surface. Both roster members reach the organization's MATTER: that gate
    // is membership, not the billing flag.
    const aliceMatter = await aliceApi.get(portalPath(`matters/${matterId}`, orgId));
    expect(aliceMatter.status).toBe(200);
    expect(aliceMatter.body.matter.id).toBe(matterId);

    const bobMatter = await bobApi.get(portalPath(`matters/${matterId}`, orgId));
    expect(bobMatter.status).toBe(200);
    expect(bobMatter.body.matter.id).toBe(matterId);

    // The billing-enabled person reaches the invoice; the billing-disabled one
    // is refused the SAME organization's money outright, even though he can
    // see its matter one assertion above.
    const aliceBilling = await aliceApi.get(portalPath('billing', orgId));
    expect(aliceBilling.status).toBe(200);
    expect(aliceBilling.body.invoices.map((inv: any) => inv.id)).toContain(invoiceId);

    const bobBilling = await bobApi.get(portalPath('billing', orgId));
    expect(bobBilling.status).toBe(403);

    // 6b. DELIVERY - checked independently of content, against what the
    // mocked transport actually received (not the resolver function directly,
    // since the point of this file is the real `send-email` route).
    expect(sendRes.body.to).toContain('alice-billing@example.test');
    expect(sendRes.body.to).not.toContain('bob-nobilling@example.test');
    expect(recipientsOf('INV-JOURNEY-1')).toContain('alice-billing@example.test');
    expect(recipientsOf('INV-JOURNEY-1')).not.toContain('bob-nobilling@example.test');
  });
});
