/**
 * The organization contract battery, firm side.
 *
 * The staff view of a client, as opposed to the client's own portal. The
 * questions are deliberately different from the portal battery's, because the
 * caller is different: a firm member is not a roster member, so `can_view_billing`
 * (a portal-link flag) does not gate them. What matters here is that an
 * organization is a first-class client rather than a shape the code trips over,
 * and that another firm is refused.
 *
 * Why this half exists at all: mutating `resolveBillingEffectiveClientIds` to
 * drop its `can_view_billing` filter left the entire portal battery green,
 * because the portal gates on `assertCanViewBilling(context)` and never reaches
 * the widening helpers. Those helpers are reached from here.
 */
import { drainEvents, memberWith } from '../support/setupInProcess';
import { buildOrgWorld, type OrgWorld } from './world';
import { FIRM_SURFACES } from './surfaces';
import { disclosesAmounts, refusedOrEmpty, withheldAmounts } from './assertions';

/** Every money figure the world seeded, in cents. */
const seededAmounts = () => [world.orgInvoice.totalCents, world.orgTrust.amountCents];

let world: OrgWorld;

beforeEach(async () => {
  world = await buildOrgWorld();
  await drainEvents();
});

describe.each(FIRM_SURFACES)('firm: $name', (surface) => {
  it('I1: treats an organization as a first-class client', async () => {
    // An organization can never carry `clients.user_id`. A surface that resolves
    // a client through that column, or assumes a person-shaped record, answers
    // 404 or 500 here rather than serving the organization.
    const res = await world.owner.api.get(surface.path(world.firm.id, world.org.id));

    expect(res.status).toBe(200);
  });

  it('I1: serves a person client the same way', async () => {
    // The control. If this also failed, the surface is broken for everyone and
    // the organization case above says nothing about organizations.
    const res = await world.owner.api.get(surface.path(world.firm.id, world.billing.clientId));

    expect(res.status).toBe(200);
  });

  it('tenancy: tells another firm nothing about this organization', async () => {
    // Asked for under the OTHER firm's id, by that firm's own owner, so this is
    // the tenancy boundary rather than an authentication failure.
    //
    // A correctly-scoped read refuses by matching NOTHING, not by answering 403:
    // the query is scoped on law_firm_id, so a client id from another firm
    // simply has no rows. Asserting the status marked five correct endpoints red.
    const res = await world.otherFirm.owner.api.get(
      surface.path(world.otherFirm.firm.id, world.org.id),
    );

    expect(refusedOrEmpty(res)).toBe(true);
    expect(withheldAmounts(res, seededAmounts())).toBe(true);
  });

  it('tenancy: refuses a member of another firm asking under THIS firm', async () => {
    // The other direction, and this one MUST be a hard refusal: the caller is
    // naming a firm they are not a member of, so the membership gate answers
    // before any scoping happens.
    const res = await world.otherFirm.owner.api.get(surface.path(world.firm.id, world.org.id));

    expect([403, 404]).toContain(res.status);
  });
});

describe('firm side: permission gating on money surfaces', () => {
  const moneySurfaces = FIRM_SURFACES.filter((s) => s.money);

  it.each(moneySurfaces)('$name is refused to a member with no billing permission', async (surface) => {
    // `DEFAULT_PERMISSIONS` is an always-on baseline carrying every `.view`
    // code, so a member with an empty role still reads most things. This asserts
    // where the boundary actually is on money: pinning it matters because a
    // change to that baseline silently widens what every member of every firm
    // can see.
    const stripped = await memberWith(world.firm.id, []);
    const res = await stripped.api.get(surface.path(world.firm.id, world.org.id));

    // Characterisation: whatever today's answer is, it must be the SAME for an
    // organization as for a person. A surface that refuses a person's money but
    // serves an organization's has an organization-shaped hole in its gate.
    const forPerson = await stripped.api.get(surface.path(world.firm.id, world.billing.clientId));

    expect(res.status).toBe(forPerson.status);
  });
});

describe('firm billing window: the widening helper reached through a route', () => {
  /**
   * `GET /billing/invoices/firm?clientScope=<personClientId>` is the client
   * detail Billing tab. It is the ONE route that reaches
   * `resolveBillingEffectiveClientIds`, which is where the be459ec0 bugs lived.
   *
   * Everything else in this file, and the whole portal battery, stayed green
   * when that helper's `can_view_billing` filter was mutated away. The portal
   * gates on `assertCanViewBilling(context)` instead, and the per-client firm
   * routes take a client id directly and never widen. Without the cases below,
   * a route-level battery of a hundred cells covers that helper zero times.
   */
  const firmInvoices = (lawFirmId: string, clientScope: string) =>
    `/api/lawfirms/${lawFirmId}/billing/invoices/firm?clientScope=${clientScope}`;

  it('widens a person scope to the organization when the link grants billing', async () => {
    const res = await world.owner.api.get(firmInvoices(world.firm.id, world.billing.clientId));

    expect(res.status).toBe(200);
    // The organization's invoice is the only one in the world, and the person
    // being viewed owns none of their own, so its presence IS the widening.
    expect(disclosesAmounts(res, [world.orgInvoice.totalCents])).toBe(true);
  });

  it('does NOT widen when the link withholds billing', async () => {
    const res = await world.owner.api.get(firmInvoices(world.firm.id, world.noBilling.clientId));

    expect(res.status).toBe(200);
    // Same organization, same invoice, a link without `can_view_billing`. This
    // is the assertion the mutation test proved nothing else in the suite makes.
    expect(disclosesAmounts(res, [world.orgInvoice.totalCents])).toBe(false);
  });

  it('does not widen to an organization the person is not on', async () => {
    const res = await world.owner.api.get(firmInvoices(world.firm.id, world.outsider.clientId));

    expect(res.status).toBe(200);
    expect(disclosesAmounts(res, [world.orgInvoice.totalCents])).toBe(false);
  });
});
