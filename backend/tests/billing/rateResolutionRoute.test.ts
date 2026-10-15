/**
 * B06.2 M03: "Rate precedence... existing pure tests plus one route integration
 * per precedence boundary that can drift."
 *
 * `tests/billing/rateResolution.test.ts` already pins the pure
 * `resolveRate()` function tier by tier, calling it directly with hand-built
 * params. That never proves `getUnbilledSummary` (invoices.service.ts) wires
 * the REAL data - matter members read off `matters.repository`, a client's
 * `billing_rates` jsonb, a charge code row, a firm member's
 * `default_hourly_rate_cents`, and the firm's `settings.billing.defaultRate`
 * - into those same params in the right shape and order.
 *
 * This drives the actual route, `GET .../billing/invoices/matter/:matterId/
 * unbilled-summary`, and walks ONE unbilled time entry up the full 9-tier
 * ladder from `docs`, configuring one additional (higher-priority) rate
 * source at a time through the real setter routes and asserting the exposed
 * `rate` flips to the new source every single step - proving each adjacent
 * boundary, not just that each tier works in isolation.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

async function createMatter(lawFirmId: string): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, $3, $4)`,
    [id, lawFirmId, 'Rate precedence matter', `REF-${id.slice(0, 8)}`],
  );
  return id;
}

async function createTimeEntry(lawFirmId: string, matterId: string, userId: string): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into activities (kind, id, law_firm_id, matter_id, user_id, activity_date, hours, name)
     values ('time', $1, $2, $3, $4, current_date, 2, 'Precedence entry')`,
    [id, lawFirmId, matterId, userId],
  );
  return id;
}

let firm: Firm;
let owner: Actor;
let matterId: string;
let entryId: string;

const invoicesBase = () => `/api/lawfirms/${firm.id}/billing/invoices`;

/** The resolved rate the route reports for the one seeded unbilled entry. */
async function unbilledRate(): Promise<number> {
  const res = await owner.api.get(`${invoicesBase()}/matter/${matterId}/unbilled-summary`);
  expect(res.status).toBe(200);
  const entry = res.body.unbilledTimeEntries.find((e: any) => e.id === entryId);
  expect(entry).toBeTruthy();
  return entry.rate;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  matterId = await createMatter(firm.id);
  // No hourlyRate on the entry itself, so every tier below "time entry
  // override" is reachable; rate_cents stays null until the final step.
  entryId = await createTimeEntry(firm.id, matterId, owner.uid);
  await drainEvents();
});

describe('rate resolution precedence, walked boundary by boundary through the real route', () => {
  it('climbs from no rate configured up to the explicit time-entry override, one tier at a time', async () => {
    // Tier 9 -> nothing configured anywhere: falls all the way to 0.
    expect(await unbilledRate()).toBe(0);

    // Tier 8: firm default rate. Set directly on `law_firms.settings`
    // (fixture data, not the behavior under test - there is no dedicated
    // "set firm default billing rate" route in this codebase).
    await testPool.query(
      `update law_firms set settings = settings || jsonb_build_object('billing', jsonb_build_object('defaultRate', 100::numeric)) where id = $1`,
      [firm.id],
    );
    expect(await unbilledRate()).toBe(100); // boundary 9 -> 8

    // Tier 7: this user's firm-wide default hourly rate. Must beat the firm default.
    const memberRateRes = await owner.api.put(`/api/lawfirms/${firm.id}/members/${owner.uid}/default-hourly-rate`)
      .send({ defaultHourlyRate: 200 });
    expect(memberRateRes.status).toBe(200);
    expect(await unbilledRate()).toBe(200); // boundary 8 -> 7

    // Tier 6: a charge code's default rate, assigned to the entry. Must beat
    // the user's firm-wide default even though both are "firm-wide" in scope.
    const codeRes = await owner.api.post(`/api/lawfirms/${firm.id}/billing/charge-codes`)
      .send({ code: 'PREC01', name: 'Precedence code', defaultRate: 300 });
    expect(codeRes.status).toBe(201);
    const chargeCodeId = codeRes.body.chargeCodeId;
    expect(chargeCodeId).toBeTruthy();
    await testPool.query(`update activities set billing_code_id = $2 where kind = 'time' and id = $1`, [entryId, chargeCodeId]);
    expect(await unbilledRate()).toBe(300); // boundary 7 -> 6

    // Tier 5: a per-member override on that SAME charge code. Must beat the
    // code's own default even for the same code.
    const codeMemberRes = await owner.api.put(`/api/lawfirms/${firm.id}/billing/charge-codes/${chargeCodeId}`)
      .send({ memberRates: { [owner.uid]: 400 } });
    expect(codeMemberRes.status).toBe(200);
    expect(await unbilledRate()).toBe(400); // boundary 6 -> 5

    // Tier 4: the matter's billing client's default rate. Attach an existing
    // client to the matter (fixture data via matter_clients) and set its
    // billing-rates default through the real client billing-rates route.
    const clientRes = await owner.api.post(`/api/lawfirms/${firm.id}/clients`)
      .send({ clientType: 'person', name: 'Precedence Client', email: 'precedence-client@example.test' });
    expect(clientRes.status).toBe(201);
    const clientId = clientRes.body.clientId ?? clientRes.body.client?.id;
    expect(clientId).toBeTruthy();
    await testPool.query(
      `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
      [matterId, clientId, firm.id],
    );
    const clientDefaultRes = await owner.api.put(`/api/lawfirms/${firm.id}/clients/${clientId}/billing-rates`)
      .send({ defaultRate: 500 });
    expect(clientDefaultRes.status).toBe(200);
    expect(await unbilledRate()).toBe(500); // boundary 5 -> 4

    // Tier 3: a per-member rate on that SAME client. Must beat the client's
    // own default for the same client.
    const clientMemberRes = await owner.api.put(`/api/lawfirms/${firm.id}/clients/${clientId}/billing-rates`)
      .send({ memberRates: { [owner.uid]: 600 } });
    expect(clientMemberRes.status).toBe(200);
    expect(await unbilledRate()).toBe(600); // boundary 4 -> 3

    // Tier 2: a per-matter, per-member rate. Add this user to the matter (the
    // real "add matter member" route), then set their matter hourly rate.
    const addMemberRes = await owner.api.post(`/api/lawfirms/${firm.id}/matters/${matterId}/members`)
      .send({ targetUserIds: [owner.uid], role: 'member' });
    expect(addMemberRes.status).toBe(200);
    const matterRateRes = await owner.api.put(`/api/lawfirms/${firm.id}/matters/${matterId}/members/hourly-rate`)
      .send({ userId: owner.uid, hourlyRate: 700 });
    expect(matterRateRes.status).toBe(200);
    expect(await unbilledRate()).toBe(700); // boundary 3 -> 2

    // Tier 1: an explicit rate on the time entry itself. Must beat every
    // configured source above it, including a deliberately LOWER value, since
    // an explicit override is a deliberate choice even when it undercuts every
    // configured default.
    const overrideRes = await owner.api.put(`/api/lawfirms/${firm.id}/billing/time-entries/matter/${matterId}/${entryId}`)
      .send({ hourlyRate: 1 });
    expect(overrideRes.status).toBe(200);
    expect(await unbilledRate()).toBe(1); // boundary 2 -> 1
  });
});
