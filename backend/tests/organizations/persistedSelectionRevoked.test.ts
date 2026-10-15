/**
 * O07 (the plan's association-and-rights matrix): "Persisted selection is
 * deleted/revoked. Old content disappears; a valid sole remaining association
 * is handled according to selection policy; otherwise selection is required."
 *
 * The "old content disappears" half is already covered:
 * `portalAccess.test.ts`'s "revoking access takes effect" describe block
 * proves the association drops out of `/associations` and the organization's
 * billing refuses immediately, with no five-second cache staleness window.
 *
 * What nothing in the suite proves is the SELECTION-POLICY transition itself.
 * `selectActiveClientAssociation` auto-selects only at exactly one
 * association and demands a `clientRecordId` at two or more
 * (`clientAssociation.resolver.ts`). A roster member linked to one
 * organization always starts at exactly two (their own person record, plus
 * the organization), so they are the "select which one" case from the very
 * first request. Every existing test either keeps that count fixed or checks
 * the ASSOCIATION LIST after a revoke, never a plain, unqualified request
 * (the one a portal caller who had a stale `clientRecordId` in local storage
 * would actually make) on the far side of the transition FROM "must choose"
 * TO "exactly one, so choose for them."
 */
import {
  createInvoice,
  createOrgClient,
  drainEvents,
  linkPersonToOrg,
  resetCaches,
} from '../support/setupInProcess';
import { buildOrgWorld, type OrgWorld, removeFromRoster } from './world';

let world: OrgWorld;

const F = () => `/api/client-portal/lawfirm/${world.firm.id}`;

beforeEach(async () => {
  world = await buildOrgWorld();
});

describe('O07: dropping from several associations to exactly one changes the selection policy on the very next request', () => {
  it('an unqualified request demands a choice while two associations exist, then auto-selects the survivor once one is revoked', async () => {
    // Two associations from the start: `world.billing`'s own person record,
    // plus the organization link `buildOrgWorld` sets up.
    const before = await world.billing.api.get(`${F()}/billing`);
    expect(before.status).toBe(400);
    expect(before.body.code).toBe('CLIENT_SELECTION_REQUIRED');

    await removeFromRoster(world.firm.id, world.billing.clientId, world.org.id);

    // No `clientRecordId` on this request either - the exact shape of a
    // client whose UI had cached a selection for the organization it can no
    // longer act as, or one that never passed a selection at all now that
    // there is nothing left to choose between.
    const after = await world.billing.api.get(`${F()}/billing`);
    expect(after.status).toBe(200);
  });

  it('the survivor that gets auto-selected is the person own record, not a leftover reference to the removed organization', async () => {
    // A distinct invoice on `world.billing`'s OWN record, so the assertion
    // can tell "auto-selected the right one" apart from "auto-selected
    // something and it happened to 200" - the failure mode being ruled out is
    // the resolver handing back the ORGANIZATION's invoice (731_900 cents,
    // `world.orgInvoice`) after the org is no longer even an association.
    const ownInvoice = await createInvoice(world.firm.id, world.billing.clientId, {
      totalCents: 199_00,
    });
    await drainEvents();

    await removeFromRoster(world.firm.id, world.billing.clientId, world.org.id);

    const res = await world.billing.api.get(`${F()}/billing`);

    expect(res.status).toBe(200);
    const ids = res.body.invoices.map((inv: any) => inv.id);
    expect(ids).toContain(ownInvoice.id);
    expect(ids).not.toContain(world.orgInvoice.id);
  });

  it('still demands a choice if a second organization link survives the first revoke', async () => {
    // The narrowing control for the plan's "otherwise selection is required"
    // clause: dropping ONE of several links must not auto-select while a
    // second one still leaves more than one association standing.
    const secondOrg = await createOrgClient(world.firm.id, { name: 'Second Co' });
    await linkPersonToOrg(world.firm.id, world.billing.clientId, secondOrg.id, { canViewBilling: true });
    resetCaches();

    // Three associations now: own record, `world.org`, `secondOrg`.
    await removeFromRoster(world.firm.id, world.billing.clientId, world.org.id);
    // That removed the FIRST org link; two associations remain (own record
    // and `secondOrg`), so the selection requirement must still hold.

    const res = await world.billing.api.get(`${F()}/billing`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CLIENT_SELECTION_REQUIRED');
  });
});
