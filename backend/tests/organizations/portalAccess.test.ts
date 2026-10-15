/**
 * How an organization's people reach the client portal.
 *
 * `portalInvariants.test.ts` asks every portal surface the same three contract
 * questions. This file goes the other way: it drives the ONE mechanism those
 * surfaces all sit on, `clientAssociation.resolver.ts` plus the access context
 * in `portal.service.ts`, which together decide which client records a portal
 * login may act as and whether it may see money.
 *
 * That module was at 36% and it is the single most consequential piece of
 * organization code there is. Everything a client sees in the portal, and every
 * refusal, is decided here.
 *
 * The four rules being pinned down:
 *
 *   I2  A person reaches an organization ONLY through an explicit
 *       `client_company_links` row. Never through a matching email.
 *   I3  `can_view_billing` on that link gates invoices, payments and trust.
 *   I4  A person's OWN billing is unconditional: they are the billing
 *       principal, so the flag does not apply to their own record.
 *   --  Revoking a link takes effect immediately, despite the resolver's
 *       five-second memoization.
 */
import {
  testPool,
  drainEvents,
  resetCaches,
  createOrgClient,
  createPersonClient,
  createPortalUser,
  linkPersonToOrg,
  createInvoice,
  as,
  tokenFor,
} from '../support/setupInProcess';
import { buildOrgWorld, linkIdFor, type OrgWorld } from './world';
import { disclosesAmounts } from './assertions';

let world: OrgWorld;

const portal = (suffix: string) => `/api/client-portal/lawfirm/${world.firm.id}${suffix}`;

/** Act as a specific client record, which multi-association callers must do. */
const asRecord = (suffix: string, clientRecordId: string) =>
  `${portal(suffix)}${suffix.includes('?') ? '&' : '?'}clientRecordId=${clientRecordId}`;

const associationIds = (body: any): string[] =>
  (body.associations || []).map((a: any) => a.clientRecordId);

const companyAssociation = (body: any) =>
  (body.associations || []).find((a: any) => a.clientType === 'company');

/**
 * True when the response states one of the organization's seeded figures.
 *
 * Goes through `disclosesAmounts` rather than a raw substring check, because the
 * portal renders money in DOLLARS while the fixtures are in cents. Searching the
 * body for "731900" finds nothing whether the data leaked or not, so a
 * `not.toContain` on the cents figure is a test that can never fail.
 */
const statesOrgMoney = (res: any) =>
  disclosesAmounts(res, [world.orgInvoice.totalCents, world.orgTrust.amountCents]);

beforeEach(async () => {
  world = await buildOrgWorld();
  await drainEvents();
});

describe('I2: an organization is reached only through an explicit link', () => {
  it('gives a linked person an association to the organization', async () => {
    const res = await world.billing.api.get(portal('/associations'));

    expect(res.status).toBe(200);
    // Two records: their own person row, and the organization they are on.
    // Losing the second is what makes an organization's people see an empty
    // portal while the firm sees their matters and invoices just fine.
    expect(associationIds(res.body)).toEqual(
      expect.arrayContaining([world.billing.clientId, world.org.id]),
    );
  });

  it('gives an UNLINKED person only their own record', async () => {
    const res = await world.outsider.api.get(portal('/associations'));

    expect(res.status).toBe(200);
    // The negative half, and the one that matters. A resolver that widened by
    // firm, or by anything other than the link row, would hand this person
    // another client's organization.
    expect(associationIds(res.body)).toEqual([world.outsider.clientId]);
    expect(companyAssociation(res.body)).toBeUndefined();
  });

  it('does NOT grant organization access through a matching email address', async () => {
    // Same email as a real roster member, different Firebase uid, no link row.
    const { rows } = await testPool.query(
      'select email from clients where id = $1', [world.billing.clientId],
    );
    const sharedEmail = rows[0].email;
    const impostor = await createPortalUser();
    await createPersonClient(world.firm.id, {
      name: 'Same Email Person',
      userId: impostor.uid,
      email: sharedEmail,
    });
    resetCaches();

    const res = await as(tokenFor({ uid: impostor.uid })).get(portal('/associations'));

    // The rule the resolver's own comment states: keyed off the uid's person
    // client id, never off email. Email is not an identity here (the `clients`
    // table does not even make it unique), so matching on it would let anyone
    // who registers with a roster member's address read that organization's
    // invoices.
    expect(res.status).toBe(200);
    expect(companyAssociation(res.body)).toBeUndefined();
  });

  it('lists every organization a person is on', async () => {
    const second = await createOrgClient(world.firm.id, { name: 'Second Corporation' });
    await linkPersonToOrg(world.firm.id, world.billing.clientId, second.id, {
      canViewBilling: false,
    });
    resetCaches();

    const res = await world.billing.api.get(portal('/associations'));

    // A person can sit on several organizations. Returning only the first
    // silently hides the rest of their work.
    expect(associationIds(res.body)).toEqual(
      expect.arrayContaining([world.billing.clientId, world.org.id, second.id]),
    );
  });

  it('does not leak an organization across firms', async () => {
    const res = await world.otherFirm.portal.api.get(
      `/api/client-portal/lawfirm/${world.otherFirm.firm.id}/associations`,
    );

    expect(res.status).toBe(200);
    // A portal user of another firm must never see this firm's organization,
    // by id or by name.
    expect(JSON.stringify(res.body)).not.toContain(world.org.id);
    expect(JSON.stringify(res.body)).not.toContain(world.orgName);
  });
});

describe('I3: can_view_billing gates the organization money', () => {
  it('lets a permitted roster member read the organization invoices', async () => {
    const res = await world.billing.api.get(asRecord('/billing', world.org.id));

    expect(res.status).toBe(200);
    // The positive half. Without it, a route that refused EVERYONE would pass
    // the refusal case below while the organization's billing contact could not
    // see a single invoice.
    expect(JSON.stringify(res.body)).toContain(world.orgInvoice.id);
  });

  it('refuses a roster member whose link has the flag off', async () => {
    const res = await world.noBilling.api.get(asRecord('/billing', world.org.id));

    expect(res.status).toBe(403);
  });

  it('discloses no invoice amount to a refused roster member', async () => {
    const res = await world.noBilling.api.get(asRecord('/billing', world.org.id));

    // Asserting the CONTENT, not only the status. A 403 whose body still named
    // the total would leak the number it was refusing to show, and a status-only
    // assertion cannot tell the difference.
    expect(statesOrgMoney(res)).toBe(false);
  });

  it('reflects the flag on the association itself', async () => {
    const permitted = await world.billing.api.get(portal('/associations'));
    const refused = await world.noBilling.api.get(portal('/associations'));

    expect(companyAssociation(permitted.body).canViewBilling).toBe(true);
    expect(companyAssociation(refused.body).canViewBilling).toBe(false);
  });

  it('gates the organization trust balance the same way', async () => {
    const permitted = await world.billing.api.get(asRecord('/trust/balance', world.org.id));
    const refused = await world.noBilling.api.get(asRecord('/trust/balance', world.org.id));

    // Trust is client money. A roster member kept off the invoices must not
    // read the balance through a side door.
    expect(permitted.status).toBe(200);
    expect(refused.status).toBe(403);
  });

  it('gates the organization trust ledger the same way', async () => {
    const refused = await world.noBilling.api.get(asRecord('/trust/ledger', world.org.id));

    expect(refused.status).toBe(403);
    expect(statesOrgMoney(refused)).toBe(false);
  });

  it('refuses an UNLINKED person who names the organization directly', async () => {
    const res = await world.outsider.api.get(asRecord('/billing', world.org.id));

    // Passing `clientRecordId` is a request, not a grant. A handler that trusted
    // the parameter would hand any portal user in the firm any organization's
    // invoices for the price of guessing an id.
    expect(res.status).toBe(403);
    expect(statesOrgMoney(res)).toBe(false);
  });

  it('refuses a portal user of ANOTHER firm who names the organization', async () => {
    const res = await world.otherFirm.portal.api.get(
      `/api/client-portal/lawfirm/${world.otherFirm.firm.id}/billing?clientRecordId=${world.org.id}`,
    );

    expect(res.status).toBe(403);
    expect(statesOrgMoney(res)).toBe(false);
  });
});

describe('I4: a person own billing is unconditional', () => {
  it('lets a flag-off roster member read their OWN invoices', async () => {
    const ownInvoice = await createInvoice(world.firm.id, world.noBilling.clientId, {
      totalCents: 123_400,
    });
    resetCaches();

    const res = await world.noBilling.api.get(asRecord('/billing', world.noBilling.clientId));

    // `can_view_billing` is a property of a LINK to an organization, not of the
    // person. Letting it suppress their own invoices would hide a client's bill
    // from the client, and they would have no way to pay it.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(ownInvoice.id);
  });

  it('reports canViewBilling true on every person association', async () => {
    const res = await world.noBilling.api.get(portal('/associations'));

    const person = (res.body.associations || [])
      .find((a: any) => a.clientType === 'person');
    expect(person.canViewBilling).toBe(true);
  });

  it('does not let their own access spill onto the organization', async () => {
    const own = await world.noBilling.api.get(asRecord('/billing', world.noBilling.clientId));
    const org = await world.noBilling.api.get(asRecord('/billing', world.org.id));

    // Both halves in one case, because the failure mode is a context resolved
    // once and reused: read your own invoices, then the organization's, and the
    // second call answers from the first call's authorization.
    expect(own.status).toBe(200);
    expect(org.status).toBe(403);
  });
});

describe('the portal selection contract', () => {
  it('refuses to guess when a caller has several records', async () => {
    const res = await world.billing.api.get(portal('/billing'));

    // Auto-picking here would show one client's money under another client's
    // name, and the caller would have no signal that a choice was made for them.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CLIENT_SELECTION_REQUIRED');
  });

  it('auto-selects for a caller with exactly one record', async () => {
    const res = await world.outsider.api.get(portal('/billing'));

    // Unambiguous, so demanding a selection would make a single-client portal
    // unusable for no benefit.
    expect(res.status).toBe(200);
  });

  it('honours an explicit selection', async () => {
    const res = await world.billing.api.get(asRecord('/billing', world.org.id));

    expect(res.status).toBe(200);
  });

  it('still lists associations without a selection', async () => {
    const res = await world.billing.api.get(portal('/associations'));

    // The escape hatch. If this route needed a selection too, a caller told to
    // choose would have no way to discover the options.
    //
    // Exactly their own person record plus the organization. A person row is
    // required just to look up an organization link, so a roster member can
    // never resolve to the organization alone, and "one organization
    // association auto-selects it" is a state this model cannot produce.
    expect(res.status).toBe(200);
    expect(res.body.associations.map((a: any) => a.clientType).sort()).toEqual(['company', 'person']);
  });

  it('refuses a client record id the caller has no association to', async () => {
    const strangerOrg = await createOrgClient(world.firm.id, { name: 'Not Mine Corp' });
    resetCaches();

    const res = await world.billing.api.get(asRecord('/billing', strangerOrg.id));

    expect(res.status).toBe(403);
  });
});

describe('the dashboard degrades rather than refusing', () => {
  it('serves organization matters to a roster member who cannot view billing', async () => {
    const res = await world.noBilling.api.get(asRecord('/dashboard', world.org.id));

    // The documented rule: the dashboard is a combined matters and billing view,
    // so refusing it outright would lock a roster member out of their own
    // matters over a billing flag.
    expect(res.status).toBe(200);
  });

  it('sends NO billing figures on that dashboard', async () => {
    const res = await world.noBilling.api.get(asRecord('/dashboard', world.org.id));

    // "Hidden UI is not authorization" cuts both ways. The backend must omit the
    // data, not send it and trust the frontend to hide it, or the number is one
    // network tab away.
    expect(res.status).toBe(200);
    expect(statesOrgMoney(res)).toBe(false);
  });

  it('DOES send them to a roster member who can', async () => {
    const res = await world.billing.api.get(asRecord('/dashboard', world.org.id));

    // The positive half. A dashboard that omitted billing for everyone would
    // satisfy the case above and show the organization's billing contact
    // nothing.
    expect(res.status).toBe(200);
    expect(statesOrgMoney(res)).toBe(true);
  });
});

describe('B02 A10: revocation through the REAL removal endpoint, with no manual cache clear', () => {
  // A revocation written with raw SQL plus `resetCaches()` proves only that
  // the RESOLVER reflects the database once told to look again; it does not
  // prove the firm-side removal ENDPOINT actually tells it to. A cache
  // invalidation call dropped from that endpoint in a future refactor would
  // leave a departed roster member reading the organization's invoices for
  // the rest of the five-second window.
  //
  // `DELETE /api/lawfirms/:lawFirmId/clients/:clientId/contacts/:linkId`
  // (`clients.routes.ts` -> `clientsService.deleteClientContact`) is the real
  // mechanism a firm uses to take someone off a roster. It calls
  // `invalidatePortalAccessContext`, which clears both the association cache
  // and the access-context cache for that uid. This test goes through that
  // exact endpoint and asserts the very next portal request, with nothing in
  // between clearing anything by hand.
  async function billingLinkId(): Promise<string> {
    const linkId = await linkIdFor(world.firm.id, world.billing.clientId, world.org.id);
    expect(linkId).toEqual(expect.any(String));
    return linkId as string;
  }

  it('drops the association on the very next request after the real DELETE call', async () => {
    // Warm the cache exactly like the "drops the association" case above.
    const before = await world.billing.api.get(portal('/associations'));
    expect(companyAssociation(before.body)).toBeDefined();

    const linkId = await billingLinkId();
    const removed = await world.owner.api.delete(
      `/api/lawfirms/${world.firm.id}/clients/${world.org.id}/contacts/${linkId}`,
    );
    expect(removed.status).toBe(200);

    // No resetCaches() call here. If the endpoint's own invalidation is
    // missing, this reads the memoized association list from before the
    // delete and still shows the organization.
    const after = await world.billing.api.get(portal('/associations'));
    expect(companyAssociation(after.body)).toBeUndefined();
  });

  it('refuses organization billing on the very next request after the real DELETE call', async () => {
    const granted = await world.billing.api.get(asRecord('/billing', world.org.id));
    expect(granted.status).toBe(200);

    const linkId = await billingLinkId();
    const removed = await world.owner.api.delete(
      `/api/lawfirms/${world.firm.id}/clients/${world.org.id}/contacts/${linkId}`,
    );
    expect(removed.status).toBe(200);

    const res = await world.billing.api.get(asRecord('/billing', world.org.id));
    expect(res.status).toBe(403);
    expect(statesOrgMoney(res)).toBe(false);
  });
});
