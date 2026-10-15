/**
 * The firm's credit card fee setting. Turning it on decides that clients are
 * charged extra, so the route must refuse every firm the card rules do not
 * allow (no Stripe, a banned state, no notice to Stripe 30 days back), and
 * must refuse every caller outside the firm.
 */
import {
  createFirm, ownerOf, memberWith, testPool, freezeClockAt, unfreezeClock, type Firm, type Actor,
} from '../support/setupInProcess';
import { getFirmBillingSettings } from '../../src/modules/billing/shared/billingSettings';

let firm: Firm;
let owner: Actor;
const url = (lawFirmId = firm.id) => `/api/lawfirms/${lawFirmId}/billing/card-fees`;
const turnOn = {
  clientPays: true, debitCards: 'decline', internationalCards: 'absorb', ratePercent: 2.9, fixedCents: 30,
  stripeNotifiedOn: '2026-08-01', engagementLetterConfirmed: true,
};
const turnOff = { clientPays: false, debitCards: 'absorb', internationalCards: 'absorb', ratePercent: 2.9, fixedCents: 30 };

const storedCardChoice = async () => {
  const stored = await testPool.query(`select settings->'billing'->'processingFees' as p from law_firms where id = $1`, [firm.id]);
  return stored.rows[0].p?.card ?? 'firm';
};

beforeEach(async () => {
  freezeClockAt('2026-10-10T12:00:00-04:00');
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await testPool.query(
    `update law_firms set stripe_account_id = 'acct_cardfees', stripe_charges_enabled = true,
            direct_charges_enabled = true, state = 'Texas' where id = $1`, [firm.id]);
});

afterEach(() => unfreezeClock());

it("refuses another firm's owner and stores nothing", async () => {
  const other = await ownerOf((await createFirm()).id);
  expect((await other.api.put(url()).send(turnOn)).status).toBe(403);
  expect((await other.api.get(url())).status).toBe(403);
  expect(await storedCardChoice()).toBe('firm');
});

it('refuses a member without settings.manageFirm', async () => {
  const member = await memberWith(firm.id, ['billing.viewInvoices']);
  expect((await member.api.put(url()).send(turnOn)).status).toBe(403);
  expect(await storedCardChoice()).toBe('firm');
});

it('lets a member who views invoices read the setting', async () => {
  const member = await memberWith(firm.id, ['billing.viewInvoices']);
  const res = await member.api.get(url());
  expect(res.status).toBe(200);
  expect(res.body.clientPays).toBe(false);
});

it('turns card fees on for an eligible firm and records who confirmed', async () => {
  const res = await owner.api.put(url()).send(turnOn);
  expect(res.status).toBe(200);
  expect(res.body.clientPays).toBe(true);
  expect(res.body.debitCards).toBe('decline');
  expect(res.body.confirmation).toEqual({
    stripeNotifiedOn: '2026-08-01', engagementLetterConfirmed: true, confirmedBy: owner.uid,
    confirmedAt: '2026-10-10T16:00:00.000Z',
  });
  expect(res.body.eligibility).toEqual({
    eligible: true, reasons: [], state: 'TX', capPercent: 3, availableFrom: '2026-08-31',
  });
  expect(await storedCardChoice()).toBe('client');
  expect((await getFirmBillingSettings(firm.id)).cardFees.debitCards).toBe('decline');
});

it('keeps the bank fee choice when the card fee is switched', async () => {
  await testPool.query(
    `update law_firms set settings = jsonb_set(coalesce(settings,'{}'), '{billing}', '{"processingFees":{"card":"firm","bank":"client"}}') where id = $1`,
    [firm.id]);
  await owner.api.put(url()).send(turnOn).expect(200);
  expect((await getFirmBillingSettings(firm.id)).processingFees).toEqual({ card: 'client', bank: 'client' });
});

it('refuses a firm whose Stripe account is not connected and leaves the fee off', async () => {
  await testPool.query(`update law_firms set stripe_charges_enabled = false where id = $1`, [firm.id]);
  const res = await owner.api.put(url()).send(turnOn);
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('Connect Stripe under Settings > Payments first.');
  expect(await storedCardChoice()).toBe('firm');
  expect((await getFirmBillingSettings(firm.id)).cardFees.confirmation).toBeNull();
});

it('tells a firm with no state where to add it', async () => {
  await testPool.query(`update law_firms set state = null where id = $1`, [firm.id]);
  const res = await owner.api.put(url()).send(turnOn);
  expect(res.status).toBe(400);
  expect(res.body.error).toBe("Choose your firm's state first.");
  expect(await storedCardChoice()).toBe('firm');
});

it('refuses a firm in Connecticut', async () => {
  await testPool.query(`update law_firms set state = 'CT' where id = $1`, [firm.id]);
  const res = await owner.api.put(url()).send(turnOn);
  expect(res.status).toBe(400);
  expect(res.body.error).toBe("Card fees aren't allowed in Connecticut.");
  expect(await storedCardChoice()).toBe('firm');
});

it('refuses until 30 days after the firm told Stripe', async () => {
  const res = await owner.api.put(url()).send({ ...turnOn, stripeNotifiedOn: '2026-10-05' });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('Available from 2026-11-04.');
  expect(await storedCardChoice()).toBe('firm');
});

it('counts the 30 days on the firm calendar day, not the UTC day', async () => {
  // 23:00 on 30 October in Los Angeles is already 31 October in UTC.
  unfreezeClock();
  freezeClockAt('2026-10-31T06:00:00Z');
  await testPool.query(
    `update law_firms set settings = jsonb_set(coalesce(settings,'{}'), '{timezone}', '"America/Los_Angeles"') where id = $1`,
    [firm.id]);
  const early = await owner.api.put(url()).send({ ...turnOn, stripeNotifiedOn: '2026-10-01' });
  expect(early.status).toBe(400);
  expect(early.body.error).toBe('Available from 2026-10-31.');

  unfreezeClock();
  freezeClockAt('2026-10-31T08:00:00Z');
  const onTime = await owner.api.put(url()).send({ ...turnOn, stripeNotifiedOn: '2026-10-01' });
  expect(onTime.status).toBe(200);
});

it('refuses turning the fee on without the engagement letter confirmation', async () => {
  const res = await owner.api.put(url()).send({ ...turnOn, engagementLetterConfirmed: false });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('Enter the date you told Stripe and confirm your engagement letters mention this fee.');
  expect(await storedCardChoice()).toBe('firm');
});

it('lets the firm turn card fees off without any confirmation, keeping the earlier one', async () => {
  await owner.api.put(url()).send(turnOn).expect(200);
  const res = await owner.api.put(url()).send(turnOff);
  expect(res.status).toBe(200);
  expect(res.body.clientPays).toBe(false);
  expect(res.body.confirmation).toMatchObject({ stripeNotifiedOn: '2026-08-01', confirmedBy: owner.uid });
  expect(await storedCardChoice()).toBe('firm');
});

it('lets an ineligible firm save its choices with the fee off', async () => {
  await testPool.query(`update law_firms set state = 'CT' where id = $1`, [firm.id]);
  const res = await owner.api.put(url()).send({ ...turnOff, debitCards: 'decline' });
  expect(res.status).toBe(200);
  expect(res.body.debitCards).toBe('decline');
  expect(res.body.eligibility.reasons).toEqual(['state_banned', 'not_confirmed']);
});

it('reports eligibility and reasons on GET', async () => {
  await testPool.query(`update law_firms set state = null where id = $1`, [firm.id]);
  const res = await owner.api.get(url());
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    clientPays: false, debitCards: 'absorb', internationalCards: 'absorb', ratePercent: 2.9, fixedCents: 30,
    confirmation: null,
    eligibility: { eligible: false, reasons: ['state_missing', 'not_confirmed'], state: null, capPercent: 0, availableFrom: null },
  });
});

it('rejects a rate above Stripe standard pricing plus margin of error', async () => {
  const res = await owner.api.put(url()).send({ ...turnOn, ratePercent: 9 });
  expect(res.status).toBe(400);
  expect(await storedCardChoice()).toBe('firm');
});

it('rejects a notice date that is not a real calendar day', async () => {
  const res = await owner.api.put(url()).send({ ...turnOn, stripeNotifiedOn: '2026-02-30' });
  expect(res.status).toBe(400);
  expect(await storedCardChoice()).toBe('firm');
});
