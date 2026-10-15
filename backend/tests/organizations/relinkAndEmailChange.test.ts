/**
 * O10 (the plan's association-and-rights matrix): "Link re-added or email
 * changed. Access and delivery caches update; no duplicate recipients;
 * existing account identity is not silently reassigned by an email edit."
 *
 * Three separate claims, three separate risks, checked against the real
 * source rather than assumed:
 *
 * 1. CACHE STALENESS ON RELINK. `createClientContact` (clients.service.ts)
 *    calls `invalidatePortalAccessContext(lawFirmId, personRow.userId)` after
 *    inserting the link, dropping BOTH `clientAssociation.resolver.ts`'s
 *    5-second association cache and `portal.service.ts`'s access-context
 *    cache. Removing a roster member seeds a "this uid has zero associations
 *    here" entry in the FIRST of those caches the moment the removed member's
 *    own next portal read is denied (`resolveClientAssociations` caches
 *    whatever it resolves, empty or not, unconditionally). If the re-add path
 *    ever dropped its invalidation call, a person re-added within that
 *    5-second window would read the stale empty list and stay locked out of
 *    an organization they are, at that moment, actually back on - exactly the
 *    kind of bug that never reproduces by hand because nobody re-adds someone
 *    and checks within 5 seconds.
 *
 * 2. DUPLICATE RECIPIENTS. The roster table's own unique constraint
 *    `(law_firm_id, person_client_id, company_client_id)` makes a duplicate
 *    ROW impossible for one person's own client id. But `clients.user_id`
 *    carries no unique constraint at all (documented in
 *    `clientAssociation.resolver.ts`'s own `fetchPersonRows` comment), so
 *    nothing stops two DIFFERENT client rows in one firm from naming the same
 *    Firebase uid. If that ever happens and both rows end up on the same
 *    organization's roster, `eligibleCompanyPortalUserIds`
 *    (`companyPortalRecipients.ts`) would resolve the same recipient twice at
 *    the query level - masked only by its own `Array.from(new Set(...))` at
 *    the end. A test that seeds only the ordinary one-row-per-person case
 *    would never exercise that dedup at all.
 *
 * 3. IDENTITY NOT REASSIGNED BY AN EMAIL EDIT. Searched for where this app
 *    actually changes `users.email` for an ALREADY-registered user:
 *    `auth.service.ts`'s `login()` only calls `upsertUserRow` (which is what
 *    writes `users.email`) in the "new OAuth user" and "still pending"
 *    branches. Once `existing.userType` is a real, non-pending type, the
 *    "Fully registered" tail of `login()` never touches `users.email` again -
 *    there is no route in this backend that changes a live user's login
 *    email post-registration. The one place `users.email` for an
 *    already-linked person could still end up out of step with reality is a
 *    direct write to the identity row (an admin correction, a future
 *    provider-sync feature); this file simulates exactly that, the same way
 *    `duplicateContactInfo.test.ts` simulates its email collision with a
 *    direct `update users set email = ...`.
 *
 *    `portal.service.ts`'s `selfHealPersonAssociation` is the only place
 *    `clientEmail` (sourced from `users.email`) ever touches identity
 *    resolution, and it starts with `if (existingPerson) return false;` -
 *    already-linked identity short-circuits before email is even read. Prove
 *    that guard is load-bearing: give the firm an unrelated, unclaimed
 *    placeholder client row that happens to share the new email and its own
 *    matter, edit `users.email` to collide with it, and confirm the
 *    already-linked person's association and matter access are unchanged -
 *    they neither switch identity nor silently ABSORB the placeholder's data
 *    (`linkClientIdentityToFirm`'s merge path moves matters, invoices, trust
 *    history and more onto whichever row is already linked, then deletes the
 *    placeholder - exactly what would happen here if the guard were gone).
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createOrgClient,
  createPersonClient,
  createPortalUser,
  linkPersonToOrg,
  resetCaches,
  as,
  tokenFor,
  ownerOf,
  type Actor,
} from '../support/setupInProcess';
import { buildOrgWorld, linkIdFor } from './world';

const recipients = () => require('../../src/modules/clients/companyPortalRecipients');

const P = (lawFirmId: string) => `/api/client-portal/lawfirm/${lawFirmId}`;
const contactsPath = (firmId: string, orgId: string) => `/api/lawfirms/${firmId}/clients/${orgId}/contacts`;

/** A bare matter with one client attached, mirroring duplicateContactInfo.test.ts's seedMatter. */
async function seedMatter(lawFirmId: string, name: string, clientIds: string[]): Promise<string> {
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

describe('O10: a re-added roster link restores access/delivery without a cache wait', () => {
  it('portal billing access is back on the very next request, not after the 5s association-cache TTL', async () => {
    const world = await buildOrgWorld();

    const before = await world.billing.api.get(`${P(world.firm.id)}/billing`).query({ clientRecordId: world.org.id });
    expect(before.status).toBe(200);
    expect(before.body.invoices.map((inv: any) => inv.id)).toContain(world.orgInvoice.id);

    const linkId = await linkIdFor(world.firm.id, world.billing.clientId, world.org.id);
    const removed = await world.owner.api.delete(`${contactsPath(world.firm.id, world.org.id)}/${linkId}`);
    expect(removed.status).toBe(200);

    // Confirm the removal actually took effect. This read is not decoration: it
    // is also what SEEDS the association resolver's "this uid has zero
    // associations in this firm besides their own record" cache entry for the
    // next 5 seconds - the exact entry a broken re-add invalidation would leave
    // stale for the assertion below.
    const denied = await world.billing.api.get(`${P(world.firm.id)}/billing`).query({ clientRecordId: world.org.id });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(denied.body)).not.toContain(world.orgInvoice.id);

    // Re-add the SAME person (their own existing client id, not a fresh
    // record) to the SAME organization.
    const relinked = await world.owner.api.post(contactsPath(world.firm.id, world.org.id)).send({
      personClientId: world.billing.clientId,
      canViewBilling: true,
    });
    expect(relinked.status).toBe(201);

    // If this reads stale, it is reading the cache entry the denied check just
    // wrote, well within its 5s TTL - proof the create path's own invalidation
    // call is what makes this pass, not the clock.
    const after = await world.billing.api.get(`${P(world.firm.id)}/billing`).query({ clientRecordId: world.org.id });
    expect(after.status).toBe(200);
    expect(after.body.invoices.map((inv: any) => inv.id)).toContain(world.orgInvoice.id);

    // Delivery agrees with access: back on the recipient list, exactly once,
    // and the roster carries exactly one row for the pair - not a stale one
    // left behind by an incomplete removal plus a fresh one from the re-add.
    const ids: string[] = await recipients().eligibleCompanyPortalUserIds(world.firm.id, world.org.id);
    expect(ids.filter((id) => id === world.billing.uid)).toHaveLength(1);

    const { rows } = await testPool.query(
      'select count(*)::int as n from client_company_links where person_client_id = $1 and company_client_id = $2',
      [world.billing.clientId, world.org.id],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('O10: no duplicate recipients', () => {
  it('a person whose two client rows share one Firebase uid is still only delivered to once', async () => {
    // `clients.user_id` carries no unique constraint (clientAssociation
    // .resolver.ts says so explicitly). Two SEPARATE client rows naming the
    // same uid is exactly the shape a re-add-as-a-new-contact mistake would
    // produce instead of reusing the person's existing record, and each one
    // can independently roster onto the same organization - the composite
    // unique constraint is keyed on person_client_id, not on the identity
    // behind it, so it does not see this as a duplicate at all.
    const firm = await createFirm({ name: 'Hale & Co' });
    const org = await createOrgClient(firm.id, { name: 'Acme Corporation' });
    const { uid } = await createPortalUser({ name: 'One Person, Two Rows' });

    const rowA = await createPersonClient(firm.id, { name: 'Row A', userId: uid, email: `${uid}-a@example.test` });
    const rowB = await createPersonClient(firm.id, { name: 'Row B', userId: uid, email: `${uid}-b@example.test` });
    await linkPersonToOrg(firm.id, rowA.id, org.id, { canViewBilling: true });
    await linkPersonToOrg(firm.id, rowB.id, org.id, { canViewBilling: true });

    const ids: string[] = await recipients().eligibleCompanyPortalUserIds(firm.id, org.id);

    // Not `toContain`: that passes whether the uid appears once or twice.
    // Naming the actual count is what a duplicate insert would flip.
    expect(ids.filter((id) => id === uid)).toHaveLength(1);
  });
});

describe('O10: an email edit does not silently reassign an already-linked identity', () => {
  it('a login-email collision with an unrelated, unclaimed placeholder record never merges it in', async () => {
    const firm = await createFirm({ name: 'Hale & Co' });
    const owner: Actor = await ownerOf(firm.id);
    void owner; // establishes the firm's membership row; not otherwise used

    const { uid } = await createPortalUser({ name: 'Established Person' });
    const established = await createPersonClient(firm.id, {
      name: 'Established Person', userId: uid, email: `${uid}@example.test`,
    });
    const api = as(tokenFor({ uid }));

    // An unrelated, real client record the firm entered from some other
    // source (a matter contact, an intake form) and nobody has ever claimed:
    // `user_id` is null. It carries its own matter, so a merge that folded it
    // into someone else's identity would hand that matter over too.
    const decoyEmail = 'decoy-placeholder@example.test';
    const decoy = await createPersonClient(firm.id, {
      name: 'Decoy Placeholder', userId: null, email: decoyEmail,
    });
    const decoyMatterId = await seedMatter(firm.id, 'Decoy Matter', [decoy.id]);

    const beforeMatters = await api.get(`${P(firm.id)}/matters`).query({ clientRecordId: established.id });
    expect(beforeMatters.status).toBe(200);
    expect(beforeMatters.body.matters.map((m: any) => m.id)).not.toContain(decoyMatterId);

    // The established person's login email now happens to equal the decoy's
    // email. There is no route in this app that changes `users.email` for an
    // already-registered user (see the file header), so this stands in for
    // the one place it could genuinely happen: a direct write to the identity
    // row, same technique `duplicateContactInfo.test.ts` uses for its own
    // email-collision setup.
    await testPool.query('update users set email = $1 where id = $2', [decoyEmail, uid]);
    resetCaches();

    const afterAssociations = await api.get(`${P(firm.id)}/associations`);
    expect(afterAssociations.status).toBe(200);
    expect(afterAssociations.body.associations.map((a: any) => a.clientRecordId)).toEqual([established.id]);

    const afterMatters = await api.get(`${P(firm.id)}/matters`).query({ clientRecordId: established.id });
    expect(afterMatters.status).toBe(200);
    // The smoking gun: if self-heal ever ran for an ALREADY-linked identity,
    // it would find the decoy by the now-matching email and merge it in,
    // carrying the decoy's matter onto the established person's own record.
    expect(afterMatters.body.matters.map((m: any) => m.id)).not.toContain(decoyMatterId);

    // And the decoy record itself must survive, unclaimed - not merged away
    // and deleted, which is what `linkClientIdentityToFirm`'s merge path does
    // to a placeholder once it adopts it.
    const { rows } = await testPool.query('select user_id from clients where id = $1', [decoy.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
  });
});
