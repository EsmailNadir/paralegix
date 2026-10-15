/**
 * B05.2 scenario 2 (the plan's full state-change journeys): "Change recipient
 * flags after a draft exists and after an invoice is issued. Confirm whether
 * each artifact uses live recipients or a saved recipient snapshot; assert
 * the rule from the service, not a guessed uniform policy."
 *
 * The rule, read from `billingRecipientSnapshot.service.ts` rather than
 * assumed:
 *
 *   DRAFT (never issued)   `resolveInvoiceRecipients` -> `readInvoiceSnapshot`
 *                          finds no `billing_snapshot_at` and falls through to
 *                          `resolveCurrentBillingRecipients`, which re-reads
 *                          `client_company_links` on every call. A draft's
 *                          "who gets this" therefore tracks the roster live,
 *                          with no lag.
 *
 *   ISSUED                 The invoice's FIRST external send
 *                          (`sendInvoiceToEmail` -> `snapshotInvoiceRecipients`)
 *                          freezes the roster into `invoices.billing_*` at that
 *                          moment. Every later read of that invoice's
 *                          recipients (`readInvoiceSnapshot` finds
 *                          `billing_snapshot_at` set) returns the FROZEN list,
 *                          not a re-resolve - a roster change afterwards must
 *                          not silently rewrite who invoice history says was
 *                          billed.
 *
 *   DELIBERATE CORRECTION  `refreshInvoiceRecipients` (the
 *                          `billing-recipients/refresh` route,
 *                          `billing.manageInvoices`) is the one sanctioned way
 *                          to overwrite an existing snapshot with today's
 *                          roster, audited as `invoice.billing_recipients.refreshed`.
 *
 * This is not duplicated by `billingAccessVsDelivery.test.ts` (O04, which
 * covers view-access vs. email-delivery as two independent flags on a link) or
 * `journeys.test.ts` J3 (which covers `can_view_billing` revocation on the
 * PORTAL READ side, not the delivery-recipient snapshot at all). Neither
 * exercises the actual issue moment or the frozen-vs-live distinction.
 */
import {
  testPool,
  drainEvents,
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
import { linkIdFor as linkIdInFirm } from './world';
import { recipientsOf } from '../support/email.mock';

let firm: Firm;
let owner: Actor;
let org: ClientRecord;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${org.id}`;

interface RosterPerson {
  uid: string;
  clientId: string;
  email: string;
}

async function rosterPerson(name: string, email: string): Promise<RosterPerson> {
  const { uid } = await createPortalUser();
  const client = await createPersonClient(firm.id, { name, userId: uid, email });
  // `is_primary` is a partial-unique seat per company; only "attn" needs it,
  // and it plays no part in the recipient rule under test here, so it is left
  // false for everyone rather than juggling exactly one `true`.
  await linkPersonToOrg(firm.id, client.id, org.id, { canViewBilling: true, isEmailRecipient: true });
  return { uid, clientId: client.id, email };
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  org = await createOrgClient(firm.id, { name: 'Acme Corporation', email: null });
});

describe('B05.2 #2: a draft tracks the live roster, an issued invoice freezes it', () => {
  it('a draft re-resolves recipients on every read, before AND after issue changes the roster', async () => {
    const alice = await rosterPerson('Alice Attn', 'alice@example.test');
    const invoice = await createInvoice(firm.id, org.id, { status: 'draft', totalCents: 500_00 });

    const beforeSecondPerson = await owner.api.get(`${B()}/${invoice.id}/billing-recipients`);
    expect(beforeSecondPerson.status).toBe(200);
    expect(beforeSecondPerson.body.billingRecipients.source).toBe('current');
    expect(beforeSecondPerson.body.billingRecipients.emails).toEqual([alice.email]);

    // The roster changes while the invoice is STILL a draft.
    const bob = await rosterPerson('Bob Second', 'bob@example.test');
    await drainEvents();

    const afterSecondPerson = await owner.api.get(`${B()}/${invoice.id}/billing-recipients`);
    expect(afterSecondPerson.status).toBe(200);
    // Still 'current': nothing has been issued yet, so there is nothing frozen
    // to fall back to - a live resolve is the only answer this route can give.
    expect(afterSecondPerson.body.billingRecipients.source).toBe('current');
    expect(afterSecondPerson.body.billingRecipients.emails.sort()).toEqual([alice.email, bob.email].sort());
  });

  it('the first external send freezes exactly the roster at that moment, and a later roster change does not reach an already-issued invoice', async () => {
    const alice = await rosterPerson('Alice Attn', 'alice@example.test');
    const bob = await rosterPerson('Bob Second', 'bob@example.test');
    const invoice = await createInvoice(firm.id, org.id, { status: 'outstanding', totalCents: 750_00, invoiceNumber: 'INV-SNAPSHOT-1' });

    // The moment of issue: emailing the invoice is its first external send,
    // which is exactly where `sendInvoiceToEmail` calls `snapshotInvoiceRecipients`.
    const sendRes = await owner.api.post(`${B()}/${invoice.id}/send-email`).send({});
    expect(sendRes.status).toBe(200);
    expect(sendRes.body.sent).toBe(true);
    expect(sendRes.body.to.sort()).toEqual([alice.email, bob.email].sort());

    // Delivery, checked separately from content: the mocked transport actually
    // received a message addressed to both of them.
    expect(recipientsOf('INV-SNAPSHOT-1').sort()).toEqual([alice.email, bob.email].sort());

    const justIssued = await owner.api.get(`${B()}/${invoice.id}/billing-recipients`);
    expect(justIssued.status).toBe(200);
    expect(justIssued.body.billingRecipients.source).toBe('snapshot');
    expect(justIssued.body.billingRecipients.emails.sort()).toEqual([alice.email, bob.email].sort());
    expect(justIssued.body.billingRecipients.snapshotAt).not.toBeNull();

    // Roster changes AFTER issue: Bob leaves the email-recipient list, and a
    // third person joins as one.
    const bobLinkId = await linkIdInFirm(firm.id, bob.clientId, org.id);
    await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${bobLinkId}`)
      .send({ isEmailRecipient: false });
    const carol = await rosterPerson('Carol Third', 'carol@example.test');
    await drainEvents();

    // The CURRENT roster, if this route re-resolved, would now be [alice, carol].
    const afterRosterChange = await owner.api.get(`${B()}/${invoice.id}/billing-recipients`);
    expect(afterRosterChange.status).toBe(200);
    expect(afterRosterChange.body.billingRecipients.source).toBe('snapshot');
    // THE RULE UNDER TEST: the frozen record from the moment of issue survives
    // unchanged. Bob (removed since) is still on it; Carol (added since) is
    // not - the opposite of what a live re-resolve would show.
    expect(afterRosterChange.body.billingRecipients.emails.sort()).toEqual([alice.email, bob.email].sort());

    // A second send of the SAME already-issued invoice must reach the FROZEN
    // list, not today's roster - Carol must not receive an invoice the
        // snapshot says she was never billed.
    const resendRes = await owner.api.post(`${B()}/${invoice.id}/send-email`).send({});
    expect(resendRes.status).toBe(200);
    expect(resendRes.body.to.sort()).toEqual([alice.email, bob.email].sort());
    expect(resendRes.body.to).not.toContain(carol.email);
  });

  it('billing-recipients/refresh is the one sanctioned way to overwrite an issued snapshot with the current roster', async () => {
    const alice = await rosterPerson('Alice Attn', 'alice@example.test');
    const invoice = await createInvoice(firm.id, org.id, { status: 'outstanding', totalCents: 300_00 });

    await owner.api.post(`${B()}/${invoice.id}/send-email`).send({});

    const bob = await rosterPerson('Bob Second', 'bob@example.test');
    await drainEvents();

    // Without a refresh, the snapshot still excludes Bob (pinned above); this
    // spec is about the deliberate override, so it moves straight to it.
    const refreshed = await owner.api.post(`${B()}/${invoice.id}/billing-recipients/refresh`).send({});
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.billingRecipients.source).toBe('snapshot');
    expect(refreshed.body.billingRecipients.emails.sort()).toEqual([alice.email, bob.email].sort());

    // The rewrite is audited, per the service's own doc comment.
    const { rows: auditRows } = await testPool.query(
      `select action, metadata from audit_events
        where law_firm_id = $1 and resource_id = $2 and action = 'invoice.billing_recipients.refreshed'`,
      [firm.id, invoice.id],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].metadata.newEmails.sort()).toEqual([alice.email, bob.email].sort());
    expect(auditRows[0].metadata.previousEmails).toEqual([alice.email]);
  });
});
