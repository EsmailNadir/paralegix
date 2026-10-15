/**
 * Who pays the online processing fee, per payment method: the firm (the
 * default) or the client. The setting decides what a client is charged at
 * checkout, so a write that lands on the wrong firm, or silently resets the
 * other method, changes real charges without anything looking wrong on screen.
 */
import { createFirm, ownerOf, memberWith, testPool, type Actor, type Firm } from '../support/setupInProcess';
import { getFirmBillingSettings, setFirmBillingSettings } from '../../src/modules/billing/shared/billingSettings';

let firm: Firm;
let owner: Actor;

const firmSettings = (lawFirmId = firm.id) => `/api/lawfirms/${lawFirmId}/settings/firm`;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

it('refuses the owner of another firm and stores nothing', async () => {
  const other = await createFirm();
  const outsider = await ownerOf(other.id);

  const res = await outsider.api.put(firmSettings())
    .send({ settings: { billing: { processingFees: { card: 'client' } } } });

  expect(res.status).toBe(403);
  expect((await getFirmBillingSettings(firm.id)).processingFees).toEqual({ card: 'firm', bank: 'firm' });
});

it('refuses a member without the firm settings permission', async () => {
  const member = await memberWith(firm.id, []);

  const res = await member.api.put(firmSettings())
    .send({ settings: { billing: { processingFees: { card: 'client' } } } });

  expect(res.status).toBe(403);
  expect((await getFirmBillingSettings(firm.id)).processingFees.card).toBe('firm');
});

it('defaults both methods to the firm paying', async () => {
  expect((await getFirmBillingSettings(firm.id)).processingFees).toEqual({ card: 'firm', bank: 'firm' });
});

it('saves one method without resetting the other', async () => {
  await setFirmBillingSettings(firm.id, { processingFees: { card: 'client', bank: 'firm' } });
  await owner.api.put(firmSettings()).send({ settings: { billing: { processingFees: { bank: 'client' } } } }).expect(200);

  // Breaks if the nested group is replaced rather than merged field by field:
  // the second write would put card back to the firm.
  expect((await getFirmBillingSettings(firm.id)).processingFees).toEqual({ card: 'client', bank: 'client' });
});

it('reads a partly stored group back with the missing method defaulted', async () => {
  await owner.api.put(firmSettings()).send({ settings: { billing: { processingFees: { bank: 'client' } } } }).expect(200);

  expect((await getFirmBillingSettings(firm.id)).processingFees).toEqual({ card: 'firm', bank: 'client' });
});

it('rejects a value other than firm or client and stores nothing', async () => {
  const res = await owner.api.put(firmSettings()).send({ settings: { billing: { processingFees: { card: 'nobody' } } } });

  expect(res.status).toBe(400);
  expect((await getFirmBillingSettings(firm.id)).processingFees.card).toBe('firm');
});

it('reads default card fee settings for a firm that never saved any', async () => {
  const res = await owner.api.get(`/api/lawfirms/${firm.id}/billing/settings`);
  expect(res.status).toBe(200);
  expect(res.body.settings.cardFees).toEqual({
    debitCards: 'absorb', internationalCards: 'absorb', ratePercent: 2.9, fixedCents: 30, confirmation: null,
  });
});

it('refuses to switch the card fee on through the generic firm settings route', async () => {
  const res = await owner.api.put(firmSettings())
    .send({ settings: { billing: { processingFees: { card: 'client' } } } });
  expect(res.status).toBe(400);
  const stored = await testPool.query(`select settings->'billing'->'processingFees' as p from law_firms where id = $1`, [firm.id]);
  expect(stored.rows[0].p?.card ?? 'firm').toBe('firm');
});

it('refuses card fee settings written through the generic firm settings route', async () => {
  const res = await owner.api.put(firmSettings())
    .send({ settings: { billing: { cardFees: { debitCards: 'decline' } } } });
  expect(res.status).toBe(400);
  expect((await getFirmBillingSettings(firm.id)).cardFees.debitCards).toBe('absorb');
});

it('still lets the generic route turn the bank fee on and the card fee off', async () => {
  await setFirmBillingSettings(firm.id, { processingFees: { card: 'client', bank: 'firm' } });
  const res = await owner.api.put(firmSettings())
    .send({ settings: { billing: { processingFees: { card: 'firm', bank: 'client' } } } });
  expect(res.status).toBe(200);
  expect((await getFirmBillingSettings(firm.id)).processingFees).toEqual({ card: 'firm', bank: 'client' });
});
