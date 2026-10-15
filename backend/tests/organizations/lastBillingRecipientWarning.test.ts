/**
 * B05.2 scenario 4 (the plan's full state-change journeys): "Attempt to
 * remove the last billing recipient. Exercise the established
 * warning/confirmation contract through the UI and API; do not invent a
 * hard prohibition if the product only warns."
 *
 * The contract, read from the code rather than assumed:
 *
 *   - `clients.service.ts`'s `updateClientContact` and `deleteClientContact`
 *     (the two write paths that can clear a roster member's
 *     `isEmailRecipient` flag or remove them entirely) have NO check at all
 *     for how many recipients remain. Nothing in the backend blocks leaving
 *     a company with zero.
 *   - The warning lives entirely on the READ side: `listClientCompanyRelationships`
 *     (`GET .../clients/:personId/company-relationships`, the PERSON's own
 *     view of the companies they belong to) computes and returns
 *     `companyEmailRecipientCount` - "so an editor here can tell whether
 *     clearing THIS person's flag would leave the company with nobody to
 *     bill" (the function's own comment). The frontend
 *     (`ClientContactModal.tsx`, `OrgAccessModal.tsx`, `ClientDetail.tsx`)
 *     reads exactly that field and shows a "Remove last email recipient?"
 *     CONFIRMATION dialog when it is `<= 1` - a warning the user can accept,
 *     never a refusal.
 *   - The real backstop is downstream, not at the roster edit, and it is not
 *     uniform: `billingRecipientSnapshot.service.ts`'s `assertHasRecipients`
 *     raises `NoBillingRecipientError` when a company genuinely has no email
 *     address to bill (no roster recipient AND no email on the company's own
 *     `clients` row), but only for callers that ask for it.
 *     `refreshInvoiceRecipients` (the `billing-recipients/refresh` route)
 *     calls it unconditionally, so that path is LOUD. `sendInvoiceToEmail`
 *     passes `requireRecipients: false`, so the exact same empty state comes
 *     back from THAT route as a 200 with `sent: false` - a result, not an
 *     error - because an email send already has a documented "not sent, here
 *     is why" contract the caller's UI renders.
 *
 * Not duplicated elsewhere: `billingAccessVsDelivery.test.ts` (O04) exercises
 * `is_email_recipient` as an independent access/delivery flag, but never
 * removes the LAST one or reads `companyEmailRecipientCount` at all.
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
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let org: ClientRecord;
let person: { uid: string; clientId: string };
let linkId: string;

async function relationshipCount(personClientId: string): Promise<number | undefined> {
  const res = await owner.api.get(`/api/lawfirms/${firm.id}/clients/${personClientId}/company-relationships`);
  expect(res.status).toBe(200);
  const rel = res.body.relationships.find((r: any) => r.companyClientId === org.id);
  return rel?.companyEmailRecipientCount;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  org = await createOrgClient(firm.id, { name: 'Acme Corporation', email: null });

  const { uid } = await createPortalUser();
  const client = await createPersonClient(firm.id, { name: 'Sole Recipient', userId: uid, email: `${uid}@example.test` });
  const link = await linkPersonToOrg(firm.id, client.id, org.id, { canViewBilling: true, isEmailRecipient: true });
  person = { uid, clientId: client.id };
  linkId = link.id;
});

describe('B05.2 #4: the last billing recipient can always be removed - only warned about', () => {
  it('the person-side read reports the count that drives the frontend warning, and it tracks the roster exactly', async () => {
    expect(await relationshipCount(person.clientId)).toBe(1);

    // A second recipient joins: the count for the FIRST person's own
    // relationship read must reflect the WHOLE roster, not just their own row.
    const second = await createPortalUser();
    const secondClient = await createPersonClient(firm.id, { name: 'Second Recipient', userId: second.uid, email: `${second.uid}@example.test` });
    await linkPersonToOrg(firm.id, secondClient.id, org.id, { canViewBilling: false, isEmailRecipient: true });

    expect(await relationshipCount(person.clientId)).toBe(2);

    // Back down to one: the second person is dropped from the recipient list
    // (not from the roster) - a bookkeeper who no longer wants email but still
    // has portal access, mirroring O04's "view-only" case.
    await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${(await testPool.query(
        'select id from client_company_links where person_client_id = $1 and company_client_id = $2',
        [secondClient.id, org.id],
      )).rows[0].id}`)
      .send({ isEmailRecipient: false });
    await drainEvents();

    expect(await relationshipCount(person.clientId)).toBe(1);
  });

  it('clearing the sole recipient flag via the API succeeds outright - no confirmation param, no block', async () => {
    expect(await relationshipCount(person.clientId)).toBe(1);

    // No "confirm: true" flag, no special header - the backend contract is a
    // WARNING the frontend shows before calling this, not an API-level guard.
    const res = await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${linkId}`)
      .send({ isEmailRecipient: false });

    expect(res.status).toBe(200);
    await drainEvents();

    expect(await relationshipCount(person.clientId)).toBe(0);
  });

  it('removing the sole recipient from the roster entirely also succeeds outright', async () => {
    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${linkId}`);
    expect(res.status).toBe(200);
    await drainEvents();

    const { rows } = await testPool.query(
      'select count(*)::int as n from client_company_links where company_client_id = $1 and is_email_recipient',
      [org.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('once zero recipients actually remain, downstream billing actions surface the gap instead of silently succeeding', async () => {
    await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${linkId}`)
      .send({ isEmailRecipient: false });
    await drainEvents();
    expect(await relationshipCount(person.clientId)).toBe(0);

    const invoice = await createInvoice(firm.id, org.id, { status: 'outstanding', totalCents: 400_00 });

    // The LOUD path: `refreshInvoiceRecipients` calls `assertHasRecipients`
    // unconditionally (no `requireRecipients: false` escape hatch), because
    // this route's entire purpose is producing a usable bill-to record - a
    // silent no-op here would be worse than useless.
    const refresh = await owner.api
      .post(`/api/lawfirms/${firm.id}/billing/invoices/client/${org.id}/${invoice.id}/billing-recipients/refresh`)
      .send({});
    expect(refresh.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refresh.body)).toMatch(/no email recipient/i);

    // The SOFT path: `sendInvoiceToEmail` calls the same resolver with
    // `requireRecipients: false`, so the exact same empty-roster state comes
    // back as a 200 carrying `sent: false` - a warning result, not an HTTP
    // error - because this route's contract already tolerates "nothing to
    // send to" as an answer the caller's UI renders, rather than a failure.
    const send = await owner.api
      .post(`/api/lawfirms/${firm.id}/billing/invoices/client/${org.id}/${invoice.id}/send-email`)
      .send({});
    expect(send.status).toBe(200);
    expect(send.body.sent).toBe(false);
    expect(send.body.reason).toMatch(/no recipient email/i);

    // Neither path took a snapshot from an empty resolution - the invoice is
    // left exactly as unissued-for-billing-purposes as before, so a later,
    // properly-addressed send can still take the record.
    const { rows } = await testPool.query(
      'select billing_snapshot_at from invoices where id = $1', [invoice.id],
    );
    expect(rows[0].billing_snapshot_at).toBeNull();
  });

  it('the same removal is harmless when the company has its own email on file - the roster warning is advisory, not a proxy for "no one gets billed"', async () => {
    // The narrowing control the plan's phrasing implies: "the last billing
    // recipient" is about the ROSTER specifically. A company with its own
    // `clients.email` still has somewhere for the bill to go even at roster
    // count zero, because `resolveCurrentBillingRecipients`'s company branch
    // falls back to it.
    await testPool.query('update clients set email = $1 where id = $2', ['ap@acme.example.test', org.id]);

    await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${linkId}`)
      .send({ isEmailRecipient: false });
    await drainEvents();
    expect(await relationshipCount(person.clientId)).toBe(0);

    const invoice = await createInvoice(firm.id, org.id, { status: 'outstanding', totalCents: 400_00 });
    const send = await owner.api
      .post(`/api/lawfirms/${firm.id}/billing/invoices/client/${org.id}/${invoice.id}/send-email`)
      .send({});

    expect(send.status).toBe(200);
    expect(send.body.sent).toBe(true);
    expect(send.body.to).toContain('ap@acme.example.test');
  });
});
