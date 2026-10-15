/**
 * O05 (the plan's association-and-rights matrix): "Assert explicit
 * primary-only rules where they exist, not ASSUMED billing rights or
 * elevated authorization."
 *
 * There are none. `is_primary` is read in exactly one place in the whole
 * application: display ordering (roster lists sort primary-first) and the
 * seat-management mechanic itself (a partial unique index enforces at most one
 * primary per organization, and `linkOrgIdentity`/merge code moves the seat
 * when a link is removed or two people are merged). Nowhere does
 * `portal.service.ts`, or anything on the money or document surfaces, read
 * `is_primary` to decide what a roster member may see or do. The actual rights
 * flags are `can_view_billing` and `is_email_recipient`, both independent
 * columns on the same `client_company_links` row.
 *
 * `journeys.test.ts` J5 covers the SEAT mechanic (moving the primary flag, the
 * one-primary-per-company constraint). It never crosses primary status against
 * billing rights, so the assumption this scenario exists to rule out - "surely
 * the primary contact has the billing rights" - has never actually been
 * checked in either direction. This file inverts the pairing `world.ts`'s
 * shared fixture happens to use (its `billing` actor is ALSO primary, so nothing
 * in the suite distinguishes the two) and proves each flag acts alone.
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
  as,
  tokenFor,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

interface RosterActor extends Actor {
  clientId: string;
}

let firm: Firm;
let org: { id: string };

const P = () => `/api/client-portal/lawfirm/${firm.id}`;

async function rosterActor(lawFirmId: string, name: string): Promise<RosterActor> {
  const { uid } = await createPortalUser();
  const client = await createPersonClient(lawFirmId, { name, userId: uid, email: `${uid}@example.test` });
  return { uid, clientId: client.id, api: as(tokenFor({ uid })) };
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  org = await createOrgClient(firm.id, { name: 'Acme Corporation' });
});

describe('O05: primary status carries no rights of its own', () => {
  it('a PRIMARY roster member with billing OFF cannot see the organization invoices', async () => {
    const primaryNoBilling = await rosterActor(firm.id, 'Primary, No Billing');
    await linkPersonToOrg(firm.id, primaryNoBilling.clientId, org.id, {
      canViewBilling: false,
      isPrimary: true,
    });
    const invoice = await createInvoice(firm.id, org.id, { totalCents: 750_00 });

    const res = await primaryNoBilling.api
      .get(`${P()}/billing`)
      .query({ clientRecordId: org.id });

    // If the code ever assumed "primary implies billing", this would be a 200
    // carrying the invoice. It has to refuse exactly as it would for any other
    // non-billing roster member.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).not.toContain(invoice.id);
  });

  it('a NON-PRIMARY roster member with billing ON can see the organization invoices', async () => {
    // The primary seat is occupied by someone else entirely, who does NOT have
    // billing rights - so if the code ever gated billing on `is_primary`
    // instead of `can_view_billing`, this member (and only the primary) would
    // be refused, and this case would fail instead.
    const primaryNoBilling = await rosterActor(firm.id, 'Primary, No Billing');
    await linkPersonToOrg(firm.id, primaryNoBilling.clientId, org.id, {
      canViewBilling: false,
      isPrimary: true,
    });
    const nonPrimaryBilling = await rosterActor(firm.id, 'Not Primary, Has Billing');
    await linkPersonToOrg(firm.id, nonPrimaryBilling.clientId, org.id, {
      canViewBilling: true,
      isPrimary: false,
    });
    const invoice = await createInvoice(firm.id, org.id, { totalCents: 750_00 });

    const res = await nonPrimaryBilling.api
      .get(`${P()}/billing`)
      .query({ clientRecordId: org.id });

    expect(res.status).toBe(200);
    expect(res.body.invoices.map((inv: any) => inv.id)).toContain(invoice.id);
  });

  it('moving the primary seat does not move billing rights along with it', async () => {
    // The seat-management mechanic (J5) and the rights flag are independent
    // columns, so exercising the seat move must not perturb billing at all.
    const alice = await rosterActor(firm.id, 'Alice');
    await linkPersonToOrg(firm.id, alice.clientId, org.id, { canViewBilling: true, isPrimary: true });
    const bob = await rosterActor(firm.id, 'Bob');
    await linkPersonToOrg(firm.id, bob.clientId, org.id, { canViewBilling: false, isPrimary: false });
    const invoice = await createInvoice(firm.id, org.id, { totalCents: 400_00 });
    const owner = await ownerOf(firm.id);

    // Move the seat to Bob, through the same route J5 exercises: the firm-side
    // /contacts/:linkId route, keyed by the LINK row's own id, not the
    // person's client id.
    const { rows } = await testPool.query(
      'select id from client_company_links where person_client_id = $1 and company_client_id = $2',
      [bob.clientId, org.id],
    );
    const move = await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${rows[0].id}`)
      .send({ isPrimary: true });
    expect(move.status).toBe(200);

    const [aliceRead, bobRead] = await Promise.all([
      alice.api.get(`${P()}/billing`).query({ clientRecordId: org.id }),
      bob.api.get(`${P()}/billing`).query({ clientRecordId: org.id }),
    ]);

    // Alice lost the primary seat but kept her billing right; Bob gained the
    // seat but is still refused. A move that dragged billing along with the
    // seat would flip both of these.
    expect(aliceRead.status).toBe(200);
    expect(aliceRead.body.invoices.map((inv: any) => inv.id)).toContain(invoice.id);
    expect(bobRead.status).toBeGreaterThanOrEqual(400);
  });

  it('the roster read itself shows the flags as independent, for a case seeded distinctly enough to tell them apart', async () => {
    const primaryNoBilling = await rosterActor(firm.id, 'Primary, No Billing');
    await linkPersonToOrg(firm.id, primaryNoBilling.clientId, org.id, {
      canViewBilling: false,
      isPrimary: true,
    });
    const nonPrimaryBilling = await rosterActor(firm.id, 'Not Primary, Has Billing');
    await linkPersonToOrg(firm.id, nonPrimaryBilling.clientId, org.id, {
      canViewBilling: true,
      isPrimary: false,
    });

    // Read the roster from the firm side, the source both portal decisions
    // above ultimately read from.
    const { rows } = await testPool.query(
      `select person_client_id, is_primary, can_view_billing
         from client_company_links where company_client_id = $1
         order by person_client_id`,
      [org.id],
    );
    const byClient = Object.fromEntries(rows.map((r: any) => [r.person_client_id, r]));

    expect(byClient[primaryNoBilling.clientId]).toMatchObject({
      is_primary: true, can_view_billing: false,
    });
    expect(byClient[nonPrimaryBilling.clientId]).toMatchObject({
      is_primary: false, can_view_billing: true,
    });
  });
});
