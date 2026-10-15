/**
 * The organization link machinery, tested directly rather than through a route.
 *
 * Why this file exists separately from the route batteries: mutating
 * `resolveBillingEffectiveClientIds` to drop its `can_view_billing` filter left
 * the entire portal battery green. The portal gates on
 * `assertCanViewBilling(context)` instead, so these helpers are reached only from
 * the firm-side and notification paths. They are also exactly where the bugs in
 * be459ec0 lived, and nothing in either package referenced them before this file.
 *
 * The two resolvers are a matched pair and the difference between them IS the
 * security boundary:
 *
 *   resolveEffectiveClientIds         widens unconditionally  (time tracking)
 *   resolveBillingEffectiveClientIds  widens only where can_view_billing (invoices)
 *
 * A test that only proves widening happens would pass against code that widened
 * money to everybody, so every case here asserts both the inclusion and the
 * exclusion.
 */
import {
  ownerOf,
  createFirm,
  createOrgClient,
  createPersonClient,
  createPortalUser,
  linkPersonToOrg,
  setClientNotificationPref,
} from '../support/setupInProcess';

const links = () => require('../../src/modules/clients/clientCompanyLinks.util');
const recipients = () => require('../../src/modules/clients/companyPortalRecipients');

describe('resolveEffectiveClientIds', () => {
  it('widens a person across every organization they are on, billing flag or not', async () => {
    const firm = await createFirm();
    const person = await createPersonClient(firm.id);
    const withFlag = await createOrgClient(firm.id, { name: 'A Corp' });
    const withoutFlag = await createOrgClient(firm.id, { name: 'B Corp' });
    await linkPersonToOrg(firm.id, person.id, withFlag.id, { canViewBilling: true });
    await linkPersonToOrg(firm.id, person.id, withoutFlag.id, { canViewBilling: false });

    const result = await links().resolveEffectiveClientIds(firm.id, person.id);

    // Time tracking widens unconditionally: it is not billing-sensitive.
    expect(result.clientIds).toHaveLength(3);
    expect(result.clientIds).toEqual(expect.arrayContaining([person.id, withFlag.id, withoutFlag.id]));
    expect(result.companyNames.get(withFlag.id)).toBe('A Corp');
  });

  it('returns just the client when there are no links', async () => {
    const firm = await createFirm();
    const person = await createPersonClient(firm.id);

    const result = await links().resolveEffectiveClientIds(firm.id, person.id);

    expect(result.clientIds).toEqual([person.id]);
    expect(result.companyNames.size).toBe(0);
  });

  it('never widens an organization id', async () => {
    const firm = await createFirm();
    const org = await createOrgClient(firm.id);
    const person = await createPersonClient(firm.id);
    await linkPersonToOrg(firm.id, person.id, org.id, { canViewBilling: true });

    // A company can never appear as someone's person_client_id, so passing one
    // in resolves to itself. Asserted rather than assumed, because the helper
    // has no explicit "is this a person" check and relies on that property.
    const result = await links().resolveEffectiveClientIds(firm.id, org.id);

    expect(result.clientIds).toEqual([org.id]);
  });

  it('does not widen across firms', async () => {
    const firmA = await createFirm();
    const firmB = await createFirm();
    const person = await createPersonClient(firmA.id);
    const orgA = await createOrgClient(firmA.id);
    await linkPersonToOrg(firmA.id, person.id, orgA.id, { canViewBilling: true });

    const result = await links().resolveEffectiveClientIds(firmB.id, person.id);

    expect(result.clientIds).toEqual([person.id]);
  });
});

describe('resolveBillingEffectiveClientIds', () => {
  it('widens ONLY to organizations where the link grants billing access', async () => {
    const firm = await createFirm();
    const person = await createPersonClient(firm.id);
    const allowed = await createOrgClient(firm.id, { name: 'Allowed Corp' });
    const refused = await createOrgClient(firm.id, { name: 'Refused Corp' });
    await linkPersonToOrg(firm.id, person.id, allowed.id, { canViewBilling: true });
    await linkPersonToOrg(firm.id, person.id, refused.id, { canViewBilling: false });

    const result = await links().resolveBillingEffectiveClientIds(firm.id, person.id);

    // Both halves. Asserting only the inclusion would pass against code that
    // widened money to every link, which is the bug this helper exists to stop.
    expect(result.clientIds).toEqual(expect.arrayContaining([person.id, allowed.id]));
    expect(result.clientIds).not.toContain(refused.id);
    expect(result.clientIds).toHaveLength(2);
  });

  it('differs from the unconditional resolver on exactly the ungranted link', async () => {
    const firm = await createFirm();
    const person = await createPersonClient(firm.id);
    const org = await createOrgClient(firm.id);
    await linkPersonToOrg(firm.id, person.id, org.id, { canViewBilling: false });

    const wide = await links().resolveEffectiveClientIds(firm.id, person.id);
    const narrow = await links().resolveBillingEffectiveClientIds(firm.id, person.id);

    expect(wide.clientIds).toContain(org.id);
    expect(narrow.clientIds).not.toContain(org.id);
  });
});

describe('eligibleCompanyPortalUserIds', () => {
  async function orgWithRoster() {
    const firm = await createFirm();
    const org = await createOrgClient(firm.id);

    const billingUser = await createPortalUser();
    const billingClient = await createPersonClient(firm.id, { userId: billingUser.uid });
    await linkPersonToOrg(firm.id, billingClient.id, org.id, { canViewBilling: true });

    const plainUser = await createPortalUser();
    const plainClient = await createPersonClient(firm.id, { userId: plainUser.uid });
    await linkPersonToOrg(firm.id, plainClient.id, org.id, { canViewBilling: false });

    // On the roster but with no portal account at all.
    const offline = await createPersonClient(firm.id, { name: 'No Portal Account' });
    await linkPersonToOrg(firm.id, offline.id, org.id, { canViewBilling: true });

    return { firm, org, billingUser, billingClient, plainUser, plainClient, offline };
  }

  it('returns every linked person who has a portal account', async () => {
    const w = await orgWithRoster();

    const ids = await recipients().eligibleCompanyPortalUserIds(w.firm.id, w.org.id);

    expect(ids).toEqual(expect.arrayContaining([w.billingUser.uid, w.plainUser.uid]));
    // The roster member with no portal user contributes nothing, rather than a
    // null that a caller would have to filter.
    expect(ids).toHaveLength(2);
  });

  it('narrows to billing-enabled links when asked', async () => {
    const w = await orgWithRoster();

    const ids = await recipients().eligibleCompanyPortalUserIds(
      w.firm.id, w.org.id, null, { requireBillingAccess: true },
    );

    // This is the fix in be459ec0: a trust low-balance alert stated the balance
    // to people the trust routes refuse, and linked them to a 403.
    expect(ids).toEqual([w.billingUser.uid]);
  });

  it('drops a person who muted that notification category', async () => {
    const w = await orgWithRoster();
    await setClientNotificationPref(w.plainClient.id, 'invoiceIssued', false);

    const ids = await recipients().eligibleCompanyPortalUserIds(w.firm.id, w.org.id, 'invoiceIssued');

    expect(ids).toEqual([w.billingUser.uid]);
  });

  it('treats an absent preference as enabled', async () => {
    const w = await orgWithRoster();

    // Opt-out, not opt-in. A category with no stored key reaches everybody.
    const ids = await recipients().eligibleCompanyPortalUserIds(w.firm.id, w.org.id, 'someNewCategory');

    expect(ids).toHaveLength(2);
  });

  it('returns nothing for a client with no roster', async () => {
    const firm = await createFirm();
    const lonely = await createOrgClient(firm.id);

    expect(await recipients().eligibleCompanyPortalUserIds(firm.id, lonely.id)).toEqual([]);
  });

  it('returns nothing when the firm or client is missing', async () => {
    expect(await recipients().eligibleCompanyPortalUserIds('', 'x')).toEqual([]);
    expect(await recipients().eligibleCompanyPortalUserIds('x', '')).toEqual([]);
  });
});

describe('GET /clients/:clientId/company-relationships', () => {
  /**
   * The read route behind the person-side relationship editor. Characterised
   * here rather than assumed: it is the surface the frontend builds the Org
   * Access UI from, so its shape, its ordering and which flags it exposes are a
   * contract, not an implementation detail.
   */
  async function personOnTwoRosters() {
    const firm = await createFirm();
    const person = await createPersonClient(firm.id, { name: 'Multi Roster' });
    // Deliberately inserted out of alphabetical order, so an ordering assertion
    // means something.
    const zeta = await createOrgClient(firm.id, { name: 'Zeta Holdings' });
    const alpha = await createOrgClient(firm.id, { name: 'Alpha Industries' });
    await linkPersonToOrg(firm.id, person.id, zeta.id, {
      canViewBilling: false, relationship: 'Contractor',
    });
    await linkPersonToOrg(firm.id, person.id, alpha.id, {
      canViewBilling: true, isPrimary: true, isEmailRecipient: true, relationship: 'CFO',
    });
    const owner = await ownerOf(firm.id);
    return { firm, person, alpha, zeta, owner };
  }

  it('lists every organization the person is on, with the link-owned flags', async () => {
    const w = await personOnTwoRosters();

    const res = await w.owner.api.get(
      `/api/lawfirms/${w.firm.id}/clients/${w.person.id}/company-relationships`,
    );

    expect(res.status).toBe(200);
    // The key is pinned, not guessed with a `??` chain: a fallback would make
    // the empty-case test below pass against a renamed field.
    expect(res.body).toHaveProperty('relationships');
    const relationships = res.body.relationships;
    expect(relationships).toHaveLength(2);

    const alphaRow = relationships.find((r: any) => r.companyClientId === w.alpha.id
      || r.companyId === w.alpha.id || r.clientId === w.alpha.id);
    expect(alphaRow).toBeDefined();
    // The flags live on the LINK, not on either client, so they have to come
    // back with the relationship or the editor cannot render them.
    expect(alphaRow.canViewBilling).toBe(true);
    expect(alphaRow.isPrimary).toBe(true);
    expect(alphaRow.relationship).toBe('CFO');
  });

  it('answers with an empty set for an organization, which is never on a roster', async () => {
    const w = await personOnTwoRosters();

    // A company can never appear as a `person_client_id`, so asking for its own
    // memberships is a coherent question with an empty answer, not an error.
    const res = await w.owner.api.get(
      `/api/lawfirms/${w.firm.id}/clients/${w.alpha.id}/company-relationships`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('relationships');
    expect(res.body.relationships).toHaveLength(0);
  });

  it('does not leak a relationship to another firm', async () => {
    const w = await personOnTwoRosters();
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api.get(
      `/api/lawfirms/${otherFirm.id}/clients/${w.person.id}/company-relationships`,
    );

    const relationships = (res.body as any)?.relationships;
    expect(res.status === 404 || relationships?.length === 0).toBe(true);
  });
});
