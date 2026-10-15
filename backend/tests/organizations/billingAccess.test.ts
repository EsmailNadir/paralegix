/** Organization billing routes must apply the link-level billing flag to
 * both collection and single-resource paths. */
import { testPool, resetCaches, drainEvents, createInvoice } from '../support/setupInProcess';
import { buildOrgWorld, type OrgWorld } from './world';
import { disclosesAmounts } from './assertions';

let world: OrgWorld;

const portal = (suffix: string, clientRecordId = world.org.id) =>
  `/api/client-portal/lawfirm/${world.firm.id}${suffix}?clientRecordId=${clientRecordId}`;

beforeEach(async () => {
  world = await buildOrgWorld();
  await drainEvents();
});

describe('organization invoice detail', () => {
  it('returns the selected organization invoice to a billing-enabled member', async () => {
    const res = await world.billing.api.get(portal(`/invoices/${world.orgInvoice.id}`));

    expect(res.status).toBe(200);
    expect(res.body.invoice.id).toBe(world.orgInvoice.id);
    expect(disclosesAmounts(res, [world.orgInvoice.totalCents])).toBe(true);
  });

  it('does not return organization invoice details to a flag-off member', async () => {
    const res = await world.noBilling.api.get(portal(`/invoices/${world.orgInvoice.id}`));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(disclosesAmounts(res, [world.orgInvoice.totalCents])).toBe(false);
  });

  it('does not let a member use the organization route for their own invoice', async () => {
    const own = await createInvoice(world.firm.id, world.billing.clientId, {
      totalCents: 884_400,
    });
    resetCaches();

    const res = await world.billing.api.get(portal(`/invoices/${own.id}`));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(disclosesAmounts(res, [884_400])).toBe(false);
  });

  it('does not let a billing-enabled member read another client invoice by id', async () => {
    const other = await createInvoice(world.firm.id, world.outsider.clientId, {
      totalCents: 992_200,
    });
    resetCaches();

    const res = await world.billing.api.get(portal(`/invoices/${other.id}`));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(disclosesAmounts(res, [992_200])).toBe(false);
  });
});

describe('organization payment checkout authorization', () => {
  it('refuses checkout for a member without billing access before creating a payment', async () => {
    const res = await world.noBilling.api.get(portal(`/billing/pay/${world.orgInvoice.id}`));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(disclosesAmounts(res, [world.orgInvoice.totalCents])).toBe(false);
  });

  it('refuses checkout for an unlinked portal user', async () => {
    const res = await world.outsider.api.get(portal(`/billing/pay/${world.orgInvoice.id}`));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(disclosesAmounts(res, [world.orgInvoice.totalCents])).toBe(false);
  });
});
