/**
 * B05.2 scenario 3 (the plan's full state-change journeys): "Transfer a
 * matter/task client relationship. Query before and after from old and new
 * people and organizations; verify related files, money, events, and notes
 * use their documented scope."
 *
 * THE MECHANISM, confirmed by reading the source rather than assumed: there is
 * no dedicated "transfer" or "reassign client" endpoint, and `matters`/`tasks`
 * carry no `clientIds` field a caller can PUT directly (`matters.validation.ts`
 * only accepts `clients` at CREATE time). A matter's client roster changes
 * after creation through the two id-based junction routes:
 *
 *   DELETE .../matters/:matterId/clients/:clientId  (unlinks)
 *   POST   .../matters/:matterId/clients            (links, reusing an
 *                                                    existing client by id)
 *
 * `client_company_links` (`clientAssociation.resolver.ts`,
 * `regressions.test.ts` R4) is a DIFFERENT operation - merging two client
 * IDENTITIES - and does not apply here: this file's "old"/"new" are two
 * separate, both-real organizations, not a placeholder and its claim.
 *
 * WHAT "DOCUMENTED SCOPE" ACTUALLY MEANS PER ARTIFACT (read from
 * `portal.service.ts`, not guessed):
 *
 *   - Matter access (`ensureMatterAccess`) is gated by `context.matterIds`,
 *     which is read live from `matter_clients` on every request
 *     (`resolveMatterAndTaskIds` -> `clientsRepo.listMatterIds`). No caching
 *     beyond the 5s access-context TTL this file busts with `resetCaches()`.
 *   - Matter notes (`listPortalMatterNotes`), matter events
 *     (`listPortalEvents`) and matter files (`listClientVisibleMatterFiles`,
 *     via `listPortalMatterDocuments`) all gate through that SAME
 *     `ensureMatterAccess` call and nothing narrower for an unrestricted item
 *     - they follow the matter_clients link and move with the transfer
 *     immediately, both directions, in the same request.
 *   - An INVOICE does not. `invoices.client_id` is written once, at creation
 *     (`invoices.service.ts` `resolveInvoiceClientSnapshot`), and nothing in
 *     the junction routes touch it. `invoiceBelongsToClient`
 *     (used by both `getPortalInvoice` and `buildPortalBilling`) requires
 *     `invoice.clientId === context.clientRecordId`. So a PRE-EXISTING
 *     invoice's bill-to does not follow the transfer: it stays addressed to
 *     the org that no longer has matter access, and the org that now has
 *     matter access does not match its stored bill-to either. This is a
 *     CHARACTERISATION, not a contradiction of scenario 1: scenario 1 never
 *     changes which client a matter is attached to after the invoice exists.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  resetCaches,
  createFirm,
  createPersonClient,
  createPortalUser,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { rootOf, seedFile } from '../files/fileWorld';
import { objects, installInMemoryBucket, putObject } from '../support/inMemoryBucket';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;

const CLIENTS = () => `/api/lawfirms/${firm.id}/clients`;
const MATTERS = () => `/api/lawfirms/${firm.id}/matters`;
const portalPath = (suffix: string, clientRecordId: string) =>
  `/api/client-portal/lawfirm/${firm.id}/${suffix}?clientRecordId=${clientRecordId}`;
const portalMatterEventsPath = (matterId: string, clientRecordId: string) =>
  `/api/client-portal/lawfirm/${firm.id}/events?matterId=${matterId}&clientRecordId=${clientRecordId}`;

async function createOrg(name: string): Promise<string> {
  const res = await owner.api.post(CLIENTS()).send({ clientType: 'company', name });
  expect(res.status).toBe(201);
  return res.body.clientId;
}

async function rosterPerson(orgId: string, name: string, email: string) {
  const { uid } = await createPortalUser({ name });
  const client = await createPersonClient(firm.id, { name, userId: uid, email });
  const link = await owner.api.post(`${CLIENTS()}/${orgId}/contacts`).send({
    personClientId: client.id, canViewBilling: true, isEmailRecipient: true,
  });
  expect(link.status).toBe(201);
  return { uid, clientId: client.id, api: as(tokenFor({ uid })) };
}

/** A matter invoice, seeded directly: money setup, not the mechanism under test. */
async function seedMatterInvoice(matterId: string, clientId: string, totalCents: number) {
  const id = randomUUID();
  await testPool.query(
    `insert into invoices (id, law_firm_id, matter_id, client_id, context_type,
                           invoice_number, status, total_cents, invoice_date, due_date)
     values ($1, $2, $3, $4, 'matter', $5, 'outstanding', $6, current_date, current_date + 30)`,
    [id, firm.id, matterId, clientId, `INV-${id.slice(0, 8)}`, totalCents],
  );
  return id;
}

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Transfer Firm' });
  owner = await ownerOf(firm.id);
});

describe('B05.2 #3: transferring a matter\'s client relationship between organizations', () => {
  it('files, notes and events follow the transfer live; a pre-existing invoice follows neither side', async () => {
    const orgAId = await createOrg('Acme Corporation A');
    const orgBId = await createOrg('Acme Corporation B');
    const personA = await rosterPerson(orgAId, 'Alice on A', 'alice-on-a@example.test');
    const personB = await rosterPerson(orgBId, 'Bob on B', 'bob-on-b@example.test');
    await drainEvents();

    // A matter attached to org A at creation.
    const matterRes = await owner.api.post(MATTERS()).send({
      name: 'Transferable Matter',
      clients: [{ clientId: orgAId, name: 'Acme Corporation A' }],
    });
    expect(matterRes.status).toBe(201);
    const matterId = matterRes.body.matterId;

    // Money: a real, issued matter invoice billed to org A.
    const invoiceId = await seedMatterInvoice(matterId, orgAId, 150_000);

    // Events: a real, client-visible matter event.
    const eventRes = await owner.api.post(`${MATTERS()}/${matterId}/events`).send({
      type: 'meeting', title: 'Kickoff call', date: '2027-01-15', clientVisible: true,
    });
    expect(eventRes.status).toBe(201);

    // Files: a client-visible matter document, no per-client restriction.
    const matterRoot = await rootOf(firm.id, { matterId });
    const engagementLetter = await seedFile(firm.id, {
      parentId: matterRoot, name: 'Engagement Letter.pdf', clientVisible: true,
    });

    await drainEvents();

    // ── BEFORE: org A's roster reaches everything; org B's roster reaches nothing ──
    const beforeAMatter = await personA.api.get(portalPath(`matters/${matterId}`, orgAId));
    expect(beforeAMatter.status).toBe(200);
    const beforeAEvents = await personA.api.get(portalMatterEventsPath(matterId, orgAId));
    expect(beforeAEvents.body.events.map((e: any) => e.id)).toContain(eventRes.body.eventId);
    const beforeAFiles = await personA.api.get(portalPath(`matters/${matterId}/documents`, orgAId));
    expect(beforeAFiles.body.documents.map((d: any) => d.id)).toContain(engagementLetter.id);
    const beforeABilling = await personA.api.get(portalPath('billing', orgAId));
    expect(beforeABilling.body.invoices.map((i: any) => i.id)).toContain(invoiceId);

    const beforeBMatter = await personB.api.get(portalPath(`matters/${matterId}`, orgBId));
    expect(beforeBMatter.status).toBe(403);

    // ── THE TRANSFER: two real, independent endpoint calls ──
    const removed = await owner.api.delete(`${MATTERS()}/${matterId}/clients/${orgAId}`);
    expect(removed.status).toBe(200);
    const added = await owner.api.post(`${MATTERS()}/${matterId}/clients`).send({
      client: { clientId: orgBId, clientType: 'company', name: 'Acme Corporation B' },
    });
    expect(added.status).toBe(201);

    const linkRows = await testPool.query(
      'select client_id from matter_clients where matter_id = $1', [matterId],
    );
    expect(linkRows.rows.map((r: any) => r.client_id)).toEqual([orgBId]);

    // Busts the 5s portal access-context TTL: without this the "after" reads
    // below would still see the pre-transfer matterIds and every assertion
    // would pass for the wrong reason (a stale cache, not the real gate).
    resetCaches();

    // ── AFTER, org A: matter access - and everything gated by it - is gone ──
    const afterAMatter = await personA.api.get(portalPath(`matters/${matterId}`, orgAId));
    expect(afterAMatter.status).toBe(403);
    const afterAEvents = await personA.api.get(portalMatterEventsPath(matterId, orgAId));
    expect(afterAEvents.status).toBe(403);
    const afterAFiles = await personA.api.get(portalPath(`matters/${matterId}/documents`, orgAId));
    expect(afterAFiles.status).toBe(403);

    // The invoice is gone from org A's list (matterId dropped out of its
    // matterIds, so buildPortalBilling never even loads it) AND refused
    // outright on direct fetch (ensureMatterAccess denies the matter itself).
    const afterABilling = await personA.api.get(portalPath('billing', orgAId));
    expect(afterABilling.status).toBe(200);
    expect(afterABilling.body.invoices.map((i: any) => i.id)).not.toContain(invoiceId);
    const afterAInvoice = await personA.api.get(portalPath(`invoices/${invoiceId}`, orgAId));
    expect(afterAInvoice.status).toBe(403);

    // ── AFTER, org B: matter access - and everything gated by it - is granted ──
    const afterBMatter = await personB.api.get(portalPath(`matters/${matterId}`, orgBId));
    expect(afterBMatter.status).toBe(200);
    expect(afterBMatter.body.matter.id).toBe(matterId);
    const afterBEvents = await personB.api.get(portalMatterEventsPath(matterId, orgBId));
    expect(afterBEvents.status).toBe(200);
    expect(afterBEvents.body.events.map((e: any) => e.id)).toContain(eventRes.body.eventId);
    const afterBFiles = await personB.api.get(portalPath(`matters/${matterId}/documents`, orgBId));
    expect(afterBFiles.status).toBe(200);
    expect(afterBFiles.body.documents.map((d: any) => d.id)).toContain(engagementLetter.id);

    // CHARACTERISATION: org B now has full matter access, but the
    // pre-existing invoice's frozen bill-to is still org A, so it belongs to
    // NEITHER side after the transfer - not org A (no matter access left) and
    // not org B (matter access, but invoiceBelongsToClient fails on the
    // stored client_id). Files/events move with the matter; this one
    // piece of money does not.
    const afterBBilling = await personB.api.get(portalPath('billing', orgBId));
    expect(afterBBilling.status).toBe(200);
    expect(afterBBilling.body.invoices.map((i: any) => i.id)).not.toContain(invoiceId);
    const afterBInvoice = await personB.api.get(portalPath(`invoices/${invoiceId}`, orgBId));
    expect(afterBInvoice.status).toBe(404);
  });
});
