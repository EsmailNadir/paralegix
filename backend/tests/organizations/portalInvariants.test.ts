/**
 * The organization contract battery, portal half.
 *
 * Every client-facing surface is asked the same questions. The point is not that
 * any one of them is interesting; it is that a surface which has never heard of
 * organizations fails the same way on all of them, and this finds it without
 * anyone having guessed which surface to look at.
 *
 * Run as a REPORT first. A red cell here is a candidate, not a verdict: some
 * will be deliberate product behaviour and should become a `skip` with a reason
 * in surfaces.ts, and the rest are bugs.
 */
import { drainEvents } from '../support/setupInProcess';
import { buildOrgWorld, type OrgWorld } from './world';
import { PORTAL_SURFACES } from './surfaces';
import { disclosesAmounts, refusedOrEmpty } from './assertions';

/** Every money figure the world seeded, in cents. */
const seededAmounts = () => [world.orgInvoice.totalCents, world.orgTrust.amountCents];

/** True when the response states one of the organization's seeded figures. */
const statesOrgMoney = (res: { status: number; body: unknown }) =>
  disclosesAmounts(res, seededAmounts());

let world: OrgWorld;

beforeEach(async () => {
  world = await buildOrgWorld();
  await drainEvents();
});

describe.each(PORTAL_SURFACES)('portal: $name', (surface) => {
  const isSkipped = (key: 'I1' | 'I2' | 'I3') => Boolean(surface.skip?.[key]);

  it('I1: serves an organization record, which carries no portal user', async () => {
    // An organization can never satisfy `clients.user_id`. A surface that
    // resolves the caller's records through that column alone answers 403 or
    // 404 here, which is the shape of the invoice-notification bug.
    const res = await world.billing.api.get(surface.path(world.firm.id, world.org.id));

    expect([200, 204]).toContain(res.status);
  });

  (isSkipped('I2') ? it.skip : it)(
    'I2: widens to a person on the roster, and no further',
    async () => {
      const onRoster = await world.billing.api.get(surface.path(world.firm.id, world.org.id));
      expect([200, 204]).toContain(onRoster.status);

      // The other half, and the half that makes this a real test: a portal user
      // of the SAME firm who is on no roster must not reach the organization's
      // record. Without this, code that shows the organization to everybody
      // passes just as happily.
      //
      // A list endpoint refuses by returning NOTHING, not by answering 403, so
      // the assertion is on content. Checking the status alone marked three
      // correctly-behaving endpoints red on the first run.
      const offRoster = await world.outsider.api.get(surface.path(world.firm.id, world.org.id));
      if (surface.recordRows && offRoster.status === 200) {
        expect(surface.recordRows(offRoster.body)).toEqual([]);
      } else {
        expect(refusedOrEmpty(offRoster)).toBe(true);
      }
    },
  );

  (surface.money && !isSkipped('I3') ? it : it.skip)(
    'I3: refuses the organization money to a link without can_view_billing',
    async () => {
      const withFlag = await world.billing.api.get(surface.path(world.firm.id, world.org.id));
      const withoutFlag = await world.noBilling.api.get(surface.path(world.firm.id, world.org.id));

      // These surfaces state a balance, a total or a ledger figure. Those are
      // the values assertCanViewBilling refuses to serve a link without the
      // flag, so serving one here is the same disclosure through another door.
      //
      // The assertion is on the FIGURE, not the status, and the world seeds a
      // distinctive invoice total so its absence means something. A surface may
      // legitimately answer 200 with the money removed.
      if (withFlag.status === 200) {
        expect(statesOrgMoney(withFlag)).toBe(true);
      }
      expect(statesOrgMoney(withoutFlag)).toBe(false);
    },
  );

  it('tenancy: refuses a portal user of another firm', async () => {
    const res = await world.otherFirm.portal.api.get(surface.path(world.firm.id, world.org.id));

    expect(refusedOrEmpty(res)).toBe(true);
  });
});
