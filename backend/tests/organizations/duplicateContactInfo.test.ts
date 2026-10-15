/**
 * O06 (the plan's association-and-rights matrix): two DISTINCT, unrelated
 * client records that happen to share an email, and whether that coincidence
 * ever lets one portal identity see the other's money.
 *
 * `tests/clients/portalScopedReads.test.ts` deliberately gives its two test
 * clients DIFFERENT emails, and says so in its own header, precisely because
 * two of the ownership checks in `portal.service.ts` match on email as a
 * FALLBACK: `findMatterClientDocIds` treats any matter-client row whose email
 * equals the caller's own login email as belonging to the caller, and
 * `invoiceBelongsToClient` does the same against an invoice's `billing_email`.
 * That fallback exists on purpose, to resolve a PLACEHOLDER client record (one
 * a firm added to a matter before the person ever signed up for the portal) to
 * the real portal user once they do. Nothing in the code checks whether the
 * matching row is actually a never-claimed placeholder, versus a second, real,
 * independently-claimed client who coincidentally shares the address - a
 * shared paralegal inbox, a married couple who share an email, or a plain
 * firm data-entry mistake.
 *
 * This file is the case portalScopedReads.test.ts's header names but does not
 * test: two REAL, CLAIMED client records sharing one email address.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createPersonClient,
  createPortalUser,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

interface PortalPerson extends Actor {
  clientId: string;
  email: string;
}

let firm: Firm;
let owner: Actor;

const P = (lawFirmId: string) => `/api/client-portal/lawfirm/${lawFirmId}`;

/**
 * A claimed portal client. `email` is caller-supplied so two people can share
 * it.
 *
 * `context.clientEmail` in `portal.service.ts` comes from the CALLER's own
 * `users.email` (their login identity), not from the `clients.email` column a
 * firm typed in. `createPortalUser` unconditionally seeds `users.email` as
 * `${uid}@example.test`, which is unique per uid by construction and cannot be
 * made to collide by passing an option to it. The direct UPDATE below is what
 * actually creates the coincidence this file is about: two different people,
 * signed in with what their identity provider reports as the same address.
 */
async function portalPerson(lawFirmId: string, name: string, email: string): Promise<PortalPerson> {
  const { uid } = await createPortalUser({ name });
  await testPool.query('update users set email = $1 where id = $2', [email, uid]);
  const client = await createPersonClient(lawFirmId, { name, userId: uid, email });
  return { uid, clientId: client.id, email, api: as(tokenFor({ uid })) };
}

async function seedMatter(lawFirmId: string, name: string, clientIds: string[]) {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1, $2, $3, $4, 'active')`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  for (const clientId of clientIds) {
    // eslint-disable-next-line no-await-in-loop -- a handful of rows, order irrelevant
    await testPool.query(
      `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
      [id, clientId, lawFirmId],
    );
  }
  return id;
}

/** A matter-context invoice addressed to exactly one client on the matter. */
async function seedMatterInvoice(
  lawFirmId: string, matterId: string, billedTo: PortalPerson, totalCents = 500_00,
) {
  const id = randomUUID();
  await testPool.query(
    `insert into invoices (id, law_firm_id, matter_id, client_id, matter_client_id,
                           context_type, billing_email, invoice_number, status,
                           total_cents, invoice_date, due_date)
     values ($1, $2, $3, $4, $4, 'matter', $5, $6, 'outstanding', $7,
             current_date, current_date + 30)`,
    [id, lawFirmId, matterId, billedTo.clientId, billedTo.email, `INV-${id.slice(0, 8)}`, totalCents],
  );
  return { id, totalCents };
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
});

describe('O06: two real, claimed clients sharing an email address', () => {
  it('CHARACTERISATION: one client can open the other one invoice on a shared matter', async () => {
    const sharedEmail = `shared-${randomUUID().slice(0, 8)}@example.test`;
    // Real people, real distinct portal accounts, no relationship to each
    // other beyond the coincidence being set up here and both being clients
    // on the same matter (which the firm legitimately put them both on -
    // co-counsel's client and the firm's own client on a joint engagement, say).
    const alice = await portalPerson(firm.id, 'Alice A', sharedEmail);
    const bob = await portalPerson(firm.id, 'Bob B', sharedEmail);
    const matter = await seedMatter(firm.id, 'Joint Engagement', [alice.clientId, bob.clientId]);

    // Addressed to Bob specifically: client_id AND matter_client_id both point
    // at Bob's row, and billing_email is Bob's own email (which happens to
    // equal Alice's).
    const bobsInvoice = await seedMatterInvoice(firm.id, matter, bob);

    const res = await alice.api.get(`${P(firm.id)}/invoices/${bobsInvoice.id}`);

    // WHAT SHOULD HAPPEN: Alice is not the invoice's client_id, is not its
    // matter_client_id, and has no relationship to Bob beyond a matching
    // string. This should be a 404, exactly as it is in
    // portalScopedReads.test.ts's shared-matter case where the two clients'
    // emails differ.
    //
    // WHAT ACTUALLY HAPPENS: `findMatterClientDocIds` walks every client on
    // the matter and adds Bob's client id to Alice's own doc-id set purely
    // because `normalizeEmail(bob.email) === alice.clientEmail` - the same
    // branch that exists to resolve an unclaimed PLACEHOLDER to a newly
    // signed-up portal user, firing against a second real, independently
    // claimed account instead. `invoiceBelongsToClient` then finds Bob's
    // matter_client_id in that set and calls the invoice Alice's.
    //
    // Pinned rather than asserted-away: the fix is a product decision (should
    // the email fallback ever apply to a client row that ALREADY has its own
    // `user_id`, i.e. is not a placeholder at all?), not something to change
    // here. Update this expectation and the two below together if it is fixed.
    expect(res.status).toBe(200);
    expect(res.body.invoice.id).toBe(bobsInvoice.id);
    expect(res.body.invoice.totalAmount).toBe(500);

    // The control that makes this a causal claim rather than a coincidence:
    // Bob himself reaches the same invoice through the legitimate path, so the
    // fixture is real and the leak above is not a missing row.
    const bobsOwnRead = await bob.api.get(`${P(firm.id)}/invoices/${bobsInvoice.id}`);
    expect(bobsOwnRead.status).toBe(200);
    expect(bobsOwnRead.body.invoice.id).toBe(bobsInvoice.id);
  });

  it('does not happen when the two clients have different emails', async () => {
    // The isolating case. Same shape as above in every respect except the one
    // variable under test, which is what proves the leak above is caused by
    // the email match and not by some broader "co-clients on a shared matter
    // can see each other's invoices" rule.
    const alice = await portalPerson(firm.id, 'Alice A', `alice-${randomUUID().slice(0, 8)}@example.test`);
    const bob = await portalPerson(firm.id, 'Bob B', `bob-${randomUUID().slice(0, 8)}@example.test`);
    const matter = await seedMatter(firm.id, 'Joint Engagement', [alice.clientId, bob.clientId]);
    const bobsInvoice = await seedMatterInvoice(firm.id, matter, bob);

    const res = await alice.api.get(`${P(firm.id)}/invoices/${bobsInvoice.id}`);

    expect(res.status).toBe(404);
  });

  it('CHARACTERISATION: the same coincidence surfaces the invoice in the aggregate billing list too', async () => {
    // The single-invoice route above is reachable only by guessing or being
    // handed an invoice id. `buildPortalBilling`, behind GET .../billing, is
    // what a client actually browses to, and it shares the exact same
    // `findMatterClientDocIdsForMatters` / `invoiceBelongsToClient` pair. This
    // proves the leak is not confined to the id-guessing entry point: Bob's
    // invoice appears in Alice's own billing history unprompted.
    const sharedEmail = `shared-${randomUUID().slice(0, 8)}@example.test`;
    const alice = await portalPerson(firm.id, 'Alice A', sharedEmail);
    const bob = await portalPerson(firm.id, 'Bob B', sharedEmail);
    const matter = await seedMatter(firm.id, 'Joint Engagement', [alice.clientId, bob.clientId]);
    const bobsInvoice = await seedMatterInvoice(firm.id, matter, bob);

    const res = await alice.api.get(`${P(firm.id)}/billing`);

    expect(res.status).toBe(200);
    expect(res.body.invoices.map((inv: any) => inv.id)).toContain(bobsInvoice.id);
  });

  it('a firm administrator reading the SAME two clients firm-side sees them as separate people', async () => {
    // The narrowing fact: this is a portal-resolution defect, not a data
    // problem. The firm's own view of its client roster never merges the two
    // rows just because the email column matches - there are two distinct
    // `clients` rows, two distinct ids, and the firm-side client list route
    // (which has no such email fallback) shows both.
    const sharedEmail = `shared-${randomUUID().slice(0, 8)}@example.test`;
    const alice = await portalPerson(firm.id, 'Alice A', sharedEmail);
    const bob = await portalPerson(firm.id, 'Bob B', sharedEmail);

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/clients`);

    expect(res.status).toBe(200);
    const ids = res.body.clients.map((c: any) => c.id);
    expect(ids).toContain(alice.clientId);
    expect(ids).toContain(bob.clientId);
    expect(alice.clientId).not.toBe(bob.clientId);
  });
});
