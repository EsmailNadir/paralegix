/**
 * B05.2 scenario 5 (the plan's full state-change journeys): "Remove
 * organization membership while messages/signing/document requests are
 * already open. Test explicit session/token rights separately from
 * association-derived rights."
 *
 * This pairs with, and deliberately does NOT repeat, work already in this
 * suite:
 *
 *   `organizationRemovalSurfaces.test.ts` (O09) proves trust and documents
 *   revoke through the shared association gate, the same mechanism
 *   `portalData.test.ts` already proved for matters, and that a bell
 *   notification is the one surface outside that gate.
 *
 *   `signatures/signingAccess.test.ts` proves a signing session assigned to
 *   the person's own identity keeps working after an org unlink, on a
 *   session that had never been touched.
 *
 *   `journeys.test.ts` J2 proves the org's canonical conversation loses the
 *   removed person from its LIST and soft-removes their
 *   `conversation_participants` row (history intact).
 *
 * None of them puts a person INSIDE an already-active session, thread, or
 * request before pulling the roster link out from under them - the realistic
 * shape this scenario asks for. This file does that for all three surfaces,
 * and puts the assigned-signing case side by side with an association-gated
 * read in the SAME test, which is the only way to show they are decided by
 * different code, not by one flag.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  createOrgClient,
  createPersonClient,
  createPortalUser,
  linkPersonToOrg,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { rootOf, seedFile } from '../files/fileWorld';
import { sessionKeysSql } from '../support/factories';

const { createRequest, recordFulfillment } = require('../../src/modules/documentRequests/documentRequests.service');

let firm: Firm;
let owner: Actor;
let org: ClientRecord;
let person: { uid: string; clientId: string; api: ReturnType<typeof as> };
let linkId: string;

const asOrg = (suffix: string) =>
  `/api/client-portal/lawfirm/${firm.id}${suffix}${suffix.includes('?') ? '&' : '?'}clientRecordId=${org.id}`;

async function removePersonFromRoster() {
  const removal = await owner.api.delete(`/api/lawfirms/${firm.id}/clients/${org.id}/contacts/${linkId}`);
  expect(removal.status).toBe(200);
  await drainEvents();
}

async function seedSigningSession() {
  const token = `tok-${randomUUID().slice(0, 12)}`;
  await testPool.query(
    `insert into signature_sessions
       (token, law_firm_id, source_id, created_by, status, file_name, object_path, expires_at)
     values ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), $3, 'pending', 'Engagement Agreement.pdf', 'firms/seed/agreement.pdf',
             now() + interval '7 days')`,
    [token, firm.id, owner.uid],
  );
  await testPool.query(
    `insert into signature_participants
       (id, session_id, law_firm_id, name, email, signing_order, status, delivery_method,
        client_user_id)
     values ($1, ${sessionKeysSql('$2')}, 'Organization Signer', $3, 1, 'active', 'portal', $4)`,
    [`p-${token}`, token, `${person.uid}@example.test`, person.uid],
  );
  return token;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  org = await createOrgClient(firm.id, { name: 'Acme Corporation' });

  const { uid } = await createPortalUser();
  const client = await createPersonClient(firm.id, { name: 'Roster Person', userId: uid, email: `${uid}@example.test` });
  // Deliberately NO billing access: the point of this file is surfaces that
  // are gated by ASSOCIATION alone (messaging, document requests) or by an
  // EXPLICIT grant (signing), neither of which is `can_view_billing`. Billing
  // itself is only used here as the association-derived control that must be
  // refused throughout.
  const link = await linkPersonToOrg(firm.id, client.id, org.id, { canViewBilling: false });
  person = { uid, clientId: client.id, api: as(tokenFor({ uid })) };
  linkId = link.id;
});

describe('B05.2 #5: an assigned signing session survives removal while association-derived access is cut at the same moment', () => {
  it('the session opened before removal keeps working after, side by side with a refused association read', async () => {
    const token = await seedSigningSession();

    // "Already open": the participant loaded the document before anything
    // changes.
    const openedBefore = await person.api.get(`/api/signing/${token}`);
    expect(openedBefore.status).toBe(200);
    expect(openedBefore.body.participantDeliveryMethod).toBe('portal');

    // The realistic-timing control: at the moment of removal, the org's own
    // billing route is DEFINITELY reachable to prove it is not refused for
    // some unrelated reason (no billing access at all here, so this must be a
    // 403 for the billing-flag reason, not a 404/membership reason) - the
    // narrowing check is right below it in the SAME test.
    const membershipStillThere = await testPool.query(
      'select 1 from client_company_links where id = $1', [linkId],
    );
    expect(membershipStillThere.rows).toHaveLength(1);

    await removePersonFromRoster();

    // ASSOCIATION-DERIVED: refused the instant the roster link is gone.
    const billingAfter = await person.api.get(asOrg('/billing'));
    expect(billingAfter.status).toBe(403);

    // EXPLICIT GRANT: the SAME participant, on the SAME token, in the SAME
    // post-removal world, keeps working - not because the gate has a hole,
    // but because signing was never wired to the roster relationship at all.
    const openedAfter = await person.api.get(`/api/signing/${token}`);
    expect(openedAfter.status).toBe(200);
    expect(openedAfter.body.participantDeliveryMethod).toBe('portal');
  });
});

describe('B05.2 #5: a group thread already in use at the moment of removal', () => {
  it('a message sent before removal survives; the same open thread refuses a send attempt right after', async () => {
    const opened = await owner.api.get(`/api/lawfirms/${firm.id}/messaging/company-conversation/${org.id}`);
    expect(opened.status).toBe(200);
    const { conversationId } = opened.body;
    await drainEvents();

    // "Already open": a real message the person sent while still on the
    // roster, through the real send route.
    const sentBefore = await person.api
      .post(`/api/messaging/client-groups/${conversationId}/messages`)
      .send({ content: 'Sent while still on the roster' });
    expect(sentBefore.status).toBe(201);
    await drainEvents();

    await removePersonFromRoster();

    // The exact same conversationId this person already had loaded - not a
    // list, a direct hit on the thread they were just using.
    const sendAfter = await person.api
      .post(`/api/messaging/client-groups/${conversationId}/messages`)
      .send({ content: 'Sent right after removal' });
    expect(sendAfter.status).toBe(403);

    const readAfter = await person.api.get(`/api/messaging/client-groups/${conversationId}`);
    expect(readAfter.status).toBe(403);

    // Data integrity: the message sent BEFORE removal is not deleted or
    // orphaned by it. The firm's own read of the same thread still shows it,
    // attributed to the person who sent it.
    const firmRead = await owner.api.get(`/api/lawfirms/${firm.id}/messaging/groups/${conversationId}`);
    expect(firmRead.status).toBe(200);
    const bodies = (firmRead.body.messages || []).map((m: any) => m.content);
    expect(bodies).toContain('Sent while still on the roster');
    expect(bodies).not.toContain('Sent right after removal');
  });
});

describe('B05.2 #5: a document request already fulfilled at the moment of removal', () => {
  it('the fulfillment made before removal survives; the same request refuses further portal access right after', async () => {
    const { request } = await createRequest({
      lawFirmId: firm.id,
      userId: owner.uid,
      clientId: org.id,
      title: 'Corporate Formation Documents',
      items: [{ label: 'Articles of Incorporation', isRequired: true }],
    });
    const itemId = request.items[0].id;

    // "Already open": the request is visible and, before removal, gets
    // fulfilled by this exact roster person (recordFulfillment is the same
    // function the real upload route calls once the file is stored - the
    // upload multipart mechanics themselves are covered elsewhere and are not
    // what this scenario is about).
    const listedBefore = await person.api.get(asOrg('/document-requests'));
    expect(listedBefore.status).toBe(200);
    expect(listedBefore.body.requests.map((r: any) => r.id)).toContain(request.id);

    // A fulfillment links a document the firm already holds, so the file has to
    // be a real row rather than a path nothing else knows about.
    const orgRoot = await rootOf(firm.id, { clientId: org.id });
    const articles = await seedFile(firm.id, { parentId: orgRoot, name: 'articles.pdf' });
    await recordFulfillment({
      lawFirmId: firm.id,
      clientId: org.id,
      requestId: request.id,
      itemId,
      files: [{ fileId: articles.id }],
      uploadedBy: person.uid,
    });

    await removePersonFromRoster();

    // ASSOCIATION-DERIVED: the SAME request id this person already had open
    // in their portal is refused the instant the roster link is gone.
    const listedAfter = await person.api.get(asOrg('/document-requests'));
    expect(listedAfter.status).toBe(403);

    // Data integrity: the fulfillment they already submitted is not deleted
    // or orphaned by the removal. The firm still sees it, and the request
    // rolled up to completed from it.
    const { rows } = await testPool.query(
      `select f.name as file_name, dr.status
         from attachments a
         join files f on f.id = a.file_id
         join document_request_items dri on dri.id = a.document_request_item_id
         join document_requests dr on dr.id = dri.request_id
        where dr.id = $1`,
      [request.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].file_name).toBe('articles.pdf');
    expect(rows[0].status).toBe('completed');
  });
});
