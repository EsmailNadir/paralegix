/**
 * O04/O09 crossed with B05.2 scenario 2's snapshot-timing rule: neither
 * `billingAccessVsDelivery.test.ts` (O04) nor `billingRecipientSnapshotTiming.test.ts`
 * (B05.2 #2) ever issues an invoice AND changes roster membership around that
 * same issue moment while also checking the portal VIEW side. Read separately:
 *
 *   - `assertCanViewBilling` (portal.service.ts) gates every billing read with a
 *     LIVE resolve of `client_company_links.can_view_billing` on every call. It
 *     never looks at an invoice's frozen `billing_*` snapshot columns at all.
 *   - `billingRecipientSnapshot.service.ts`'s snapshot freezes WHO GETS EMAILED
 *     at first issue and never re-derives it, by design ("a roster change
 *     months later does not rewrite the record of who received a bill in
 *     March").
 *
 * Two independent mechanisms nobody had composed: what does a roster change
 * made AFTER an invoice already issued do to the VIEW side, which the
 * snapshot itself has no opinion on? Traced to source before writing a single
 * assertion (both files read above). This pins two consequences that follow
 * directly from that independence and were not previously exercised:
 *
 *   1. Someone who joins the roster with billing access AFTER an invoice
 *      issued can see (and open) that invoice immediately, despite never
 *      having been part of the frozen recipient list that invoice was mailed
 *      to - membership access is current, the mailing list is historical.
 *   2. Someone removed from the roster loses VIEW of that same invoice on the
 *      very next request (the live gate), but a RESEND of that already-issued
 *      invoice still reaches their frozen address, because delivery reads the
 *      snapshot, not the roster. This is the deliberate design the snapshot's
 *      own header comment describes, not a bug, and is pinned as a
 *      characterisation rather than "fixed."
 */
import {
  drainEvents,
  resetCaches,
  createFirm,
  createOrgClient,
  createPersonClient,
  createPortalUser,
  linkPersonToOrg,
  createInvoice,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { removeFromRoster } from './world';

let firm: Firm;
let owner: Actor;
let org: ClientRecord;

const P = () => `/api/client-portal/lawfirm/${firm.id}`;
const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${org.id}`;

interface RosterPerson {
  uid: string;
  clientId: string;
  email: string;
  api: ReturnType<typeof as>;
}

async function rosterPerson(
  name: string,
  flags: { canViewBilling: boolean; isEmailRecipient: boolean },
): Promise<RosterPerson> {
  const { uid } = await createPortalUser();
  const email = `${uid}@example.test`;
  const client = await createPersonClient(firm.id, { name, userId: uid, email });
  await linkPersonToOrg(firm.id, client.id, org.id, flags);
  return { uid, clientId: client.id, email, api: as(tokenFor({ uid })) };
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  org = await createOrgClient(firm.id, { name: 'Acme Corporation', email: null });
});

describe('billing view access is live even when the invoice recipient list is frozen', () => {
  it('a roster member added after issue can view the invoice immediately despite being absent from the frozen recipient snapshot', async () => {
    const alice = await rosterPerson('Alice Attn', { canViewBilling: true, isEmailRecipient: true });
    const invoice = await createInvoice(firm.id, org.id, { totalCents: 500_00, status: 'outstanding', invoiceNumber: 'INV-VIEW-1' });

    const sendRes = await owner.api.post(`${B()}/${invoice.id}/send-email`).send({});
    expect(sendRes.status).toBe(200);
    expect(sendRes.body.to).toEqual([alice.email]);

    // Bob joins the roster strictly AFTER the invoice already issued.
    const bob = await rosterPerson('Bob Later', { canViewBilling: true, isEmailRecipient: true });
    await drainEvents();
    resetCaches();

    // The frozen snapshot is unaffected by Bob joining - this is the already-
    // pinned half (B05.2 #2), reconfirmed here as the premise the rest of this
    // test depends on.
    const recipients = await owner.api.get(`${B()}/${invoice.id}/billing-recipients`);
    expect(recipients.body.billingRecipients.source).toBe('snapshot');
    expect(recipients.body.billingRecipients.emails).toEqual([alice.email]);
    expect(recipients.body.billingRecipients.emails).not.toContain(bob.email);

    // The new, previously unexercised half: Bob's live membership is enough on
    // its own to see the same invoice, on both the list and the single-invoice
    // read, with no dependency on ever having been mailed it.
    const bobList = await bob.api.get(`${P()}/billing`).query({ clientRecordId: org.id });
    expect(bobList.status).toBe(200);
    expect(bobList.body.invoices.map((inv: any) => inv.id)).toContain(invoice.id);

    const bobSingle = await bob.api.get(`${P()}/invoices/${invoice.id}`).query({ clientRecordId: org.id });
    expect(bobSingle.status).toBe(200);
    expect(bobSingle.body.invoice.id).toBe(invoice.id);
  });

  it('removing a roster member revokes their view of an issued invoice at once, while a resend still reaches their permanently frozen address', async () => {
    const alice = await rosterPerson('Alice Attn', { canViewBilling: true, isEmailRecipient: true });
    const bob = await rosterPerson('Bob Departing', { canViewBilling: true, isEmailRecipient: true });
    const invoice = await createInvoice(firm.id, org.id, { totalCents: 640_00, status: 'outstanding', invoiceNumber: 'INV-VIEW-2' });

    const sendRes = await owner.api.post(`${B()}/${invoice.id}/send-email`).send({});
    expect(sendRes.status).toBe(200);
    expect(sendRes.body.to.sort()).toEqual([alice.email, bob.email].sort());

    // Prove the control first: Bob could see it a moment ago.
    const before = await bob.api.get(`${P()}/invoices/${invoice.id}`).query({ clientRecordId: org.id });
    expect(before.status).toBe(200);

    await removeFromRoster(firm.id, bob.clientId);

    // Live gate: the very next request is refused, no lingering allow from an
    // earlier resolve.
    const afterList = await bob.api.get(`${P()}/billing`).query({ clientRecordId: org.id });
    expect(afterList.status).toBeGreaterThanOrEqual(400);
    const afterSingle = await bob.api.get(`${P()}/invoices/${invoice.id}`).query({ clientRecordId: org.id });
    expect(afterSingle.status).toBeGreaterThanOrEqual(400);

    // The permanent record: a resend of the SAME already-issued invoice still
    // reaches Bob's frozen address, because delivery reads the snapshot taken
    // at issue time, not today's roster. Bob can no longer open the invoice
    // through the portal, yet the firm's own resend still mails him about it -
    // the two surfaces are governed by genuinely different rules, not merely
    // different timing of the same rule.
    const resend = await owner.api.post(`${B()}/${invoice.id}/send-email`).send({});
    expect(resend.status).toBe(200);
    expect(resend.body.to).toContain(bob.email);

    const recipientsAfterRemoval = await owner.api.get(`${B()}/${invoice.id}/billing-recipients`);
    expect(recipientsAfterRemoval.body.billingRecipients.source).toBe('snapshot');
    expect(recipientsAfterRemoval.body.billingRecipients.emails).toContain(bob.email);

    // Narrowing control: Alice, never removed, keeps both view and delivery
    // throughout - this is not a case of the whole organization losing access.
    const aliceStill = await alice.api.get(`${P()}/invoices/${invoice.id}`).query({ clientRecordId: org.id });
    expect(aliceStill.status).toBe(200);
  });
});
