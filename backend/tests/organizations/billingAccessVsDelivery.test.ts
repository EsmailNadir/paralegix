/**
 * O04 (the plan's association-and-rights matrix): "Billing visibility on/off
 * crossed with billing delivery on/off. All four combinations: invoice
 * viewing/payment exposure follows access; email audience follows delivery;
 * one flag does not imply the other."
 *
 * `client_company_links` carries two independent columns for this:
 * `can_view_billing` (gates the portal's `assertCanViewBilling`, everything a
 * roster member can SEE and PAY) and `is_email_recipient` (the sole filter
 * `fetchCompanyBillingContacts` applies when resolving who an invoice reminder
 * or receipt is actually mailed to - it never reads `can_view_billing` at
 * all). The design is deliberately two knobs: a firm can grant portal access
 * to someone who should not be emailed unsolicited (a bookkeeper who checks in
 * occasionally) and can email a decision-maker who has no portal login to
 * check.
 *
 * Every existing fixture in this suite sets both flags to the SAME value
 * (`administration.test.ts`, `invitations.test.ts`, `linkSubsystem.test.ts`,
 * `regressions.test.ts` R2/R3), so the independence the design relies on has
 * never actually been exercised. This file crosses them: all four
 * combinations, on four distinct roster people of one organization, checked
 * against both surfaces at once.
 */
import { randomUUID } from 'crypto';
import {
  createFirm,
  createOrgClient,
  createPersonClient,
  createPortalUser,
  linkPersonToOrg,
  createInvoice,
  as,
  tokenFor,
  type Firm,
} from '../support/setupInProcess';

const { resolveCurrentBillingRecipients } = require('../../src/modules/billing/shared/billingRecipientSnapshot.service');

let firm: Firm;
let org: { id: string };

const P = () => `/api/client-portal/lawfirm/${firm.id}`;

interface RosterPerson {
  uid: string;
  clientId: string;
  email: string;
  api: ReturnType<typeof as>;
}

async function rosterPerson(
  lawFirmId: string, name: string, flags: { canViewBilling: boolean; isEmailRecipient: boolean },
): Promise<RosterPerson> {
  const { uid } = await createPortalUser();
  const email = `${uid}@example.test`;
  const client = await createPersonClient(lawFirmId, { name, userId: uid, email });
  await linkPersonToOrg(lawFirmId, client.id, org.id, flags);
  return { uid, clientId: client.id, email, api: as(tokenFor({ uid })) };
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  org = await createOrgClient(firm.id, { name: 'Acme Corporation', email: null });
});

describe('O04: view access and email delivery are independent knobs', () => {
  it('all four combinations, checked against both surfaces at once', async () => {
    const viewAndDeliver = await rosterPerson(firm.id, 'Views and Emailed', {
      canViewBilling: true, isEmailRecipient: true,
    });
    const viewOnly = await rosterPerson(firm.id, 'Views Only (bookkeeper)', {
      canViewBilling: true, isEmailRecipient: false,
    });
    const deliverOnly = await rosterPerson(firm.id, 'Emailed Only (decision-maker, no login)', {
      canViewBilling: false, isEmailRecipient: true,
    });
    const neither = await rosterPerson(firm.id, 'Neither', {
      canViewBilling: false, isEmailRecipient: false,
    });

    // The VIEW surface: portal billing access follows can_view_billing alone.
    // No invoice needs to exist - this checks whether the ENDPOINT admits the
    // caller, not what it returns once admitted.
    const reads = await Promise.all(
      [viewAndDeliver, viewOnly, deliverOnly, neither].map((p) =>
        p.api.get(`${P()}/billing`).query({ clientRecordId: org.id }).then((r) => r.status)),
    );
    expect(reads).toEqual([200, 200, 403, 403]);

    // The DELIVERY surface: the actual function every reminder/receipt path
    // calls to resolve who gets emailed, following is_email_recipient alone.
    const recipients = await resolveCurrentBillingRecipients({ lawFirmId: firm.id, clientId: org.id });

    expect(recipients.emails).toContain(viewAndDeliver.email);
    expect(recipients.emails).toContain(deliverOnly.email);
    // The sharpest pair: viewOnly can SEE the invoice but must not be emailed
    // about it (an unsolicited notice to someone the firm deliberately did not
    // flag as a recipient), and neither can see it NOR gets mailed.
    expect(recipients.emails).not.toContain(viewOnly.email);
    expect(recipients.emails).not.toContain(neither.email);

    // Named so a fixture typo (all four collapsing to the same email) cannot
    // pass this by coincidence.
    expect(new Set([viewAndDeliver.email, viewOnly.email, deliverOnly.email, neither.email]).size).toBe(4);
  });

  it('a view-only bookkeeper reaches the invoice list itself, proving the refusal above is not a dead account', async () => {
    const viewOnly = await rosterPerson(firm.id, 'Views Only', { canViewBilling: true, isEmailRecipient: false });
    const invoice = await createInvoice(firm.id, org.id, { totalCents: 200_00 });

    const res = await viewOnly.api.get(`${P()}/billing`).query({ clientRecordId: org.id });

    expect(res.status).toBe(200);
    expect(res.body.invoices.map((inv: any) => inv.id)).toContain(invoice.id);
  });

  it('a delivery-only contact with no portal login still receives the email, proving the delivery result above is not a dead address', async () => {
    // "No portal login to check" from the header comment, made concrete: this
    // person is never given a portal uid at all, only a roster link.
    const personEmail = `never-signed-up-${randomUUID().slice(0, 8)}@example.test`;
    const person = await createPersonClient(firm.id, { name: 'Never Signed Up', email: personEmail });
    await linkPersonToOrg(firm.id, person.id, org.id, { canViewBilling: false, isEmailRecipient: true });

    const recipients = await resolveCurrentBillingRecipients({ lawFirmId: firm.id, clientId: org.id });

    expect(recipients.emails).toContain(personEmail);
  });
});
