/**
 * Every billing count and total after the ledger changes under it: a payment
 * deleted, a credit note deleted, an invoice voided, an invoice deleted, a
 * late part-payment, an invoice paid off.
 *
 * Each case builds the full world, asserts every surface agrees with the
 * seeded ledger (the control), applies one change to both the system and the
 * ledger, and asserts again.
 *
 * RED IF: any surface keeps a figure from before the change.
 */
import {
  buildWorld, entry, urlFor, pay, writeOff, voidIt, type World,
} from './totalsWorld';
import { expectAllSurfacesAgree } from './totalsSurfaces';

let w: World;

beforeEach(async () => {
  w = await buildWorld();
  // The control: the untouched world agrees everywhere, so a failure after a
  // change is that change's, not the seed's.
  await expectAllSurfacesAgree(w);
});

it('after a payment on a part-paid invoice is deleted', async () => {
  const e = entry(w, 'partial');
  const res = await w.owner.api.delete(`${urlFor(w, e, '/payment')}?paymentIndex=0`);
  expect(res.status).toBe(200);
  e.paidCents = 0;

  await expectAllSurfacesAgree(w);
});

it('after the only payment on a fully paid invoice is deleted, it is owed in full again', async () => {
  const e = entry(w, 'paid');
  const res = await w.owner.api.delete(`${urlFor(w, e, '/payment')}?paymentIndex=0`);
  expect(res.status).toBe(200);
  e.paidCents = 0;

  await expectAllSurfacesAgree(w);
});

it('after the credit note that settled an invoice is deleted', async () => {
  const e = entry(w, 'credited');
  const detail = await w.owner.api.get(`/api/lawfirms/${w.firm.id}/billing/invoices/client/${e.clientId}`);
  const noteId = detail.body.invoices.find((i: any) => i.id === e.id).creditNotes[0].id;
  const res = await w.owner.api.delete(`${urlFor(w, e, '/credit-note')}?creditNoteId=${noteId}`);
  expect(res.status).toBe(200);
  e.writtenOffCents = 0;

  await expectAllSurfacesAgree(w);
});

it('after a live invoice is voided', async () => {
  await voidIt(w, entry(w, 'live'));

  await expectAllSurfacesAgree(w);
});

it('after a late invoice is voided it leaves the overdue figures', async () => {
  await voidIt(w, entry(w, 'orgOverdue'));

  await expectAllSurfacesAgree(w);
});

it('after an unpaid invoice is deleted it is gone from every count', async () => {
  const e = entry(w, 'due7');
  const res = await w.owner.api.delete(urlFor(w, e));
  expect(res.status).toBe(200);
  w.ledger.splice(w.ledger.indexOf(e), 1);

  await expectAllSurfacesAgree(w);
});

it('after a late invoice is part-paid it stays overdue once, with the smaller balance', async () => {
  await pay(w, entry(w, 'dueYesterday'), 5022);

  await expectAllSurfacesAgree(w);
});

it('after a live invoice is paid off it leaves awaiting and the part-paid count', async () => {
  await pay(w, entry(w, 'partial'), 74_945);

  await expectAllSurfacesAgree(w);
});

it('after a write-off clears the balance of a part-paid invoice', async () => {
  await writeOff(w, entry(w, 'trustPaid'), 25_000);

  await expectAllSurfacesAgree(w);
});

describe('refused money changes leave every surface alone', () => {
  it('a payment one cent over the balance is refused and nothing moves', async () => {
    const e = entry(w, 'live');
    const res = await w.owner.api.put(urlFor(w, e, '/payment')).send({ paymentAmount: 400.01 });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    await expectAllSurfacesAgree(w);
  });

  it('a payment larger than the balance left by an earlier part-payment is refused', async () => {
    const e = entry(w, 'partial');
    const res = await w.owner.api.put(urlFor(w, e, '/payment')).send({ paymentAmount: 749.46 });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    await expectAllSurfacesAgree(w);
  });

  it('a write-off one cent over the balance is refused and nothing moves', async () => {
    const e = entry(w, 'trustPaid');
    const res = await w.owner.api.post(urlFor(w, e, '/credit-note'))
      .send({ amount: 250.01, type: 'write_off', description: 'too much' });

    expect(res.status).toBe(400);
    await expectAllSurfacesAgree(w);
  });

  it('a payment on a voided invoice is refused and the collected total does not move', async () => {
    const e = entry(w, 'voided');
    const res = await w.owner.api.put(urlFor(w, e, '/payment')).send({ paymentAmount: 10 });

    expect(res.status).toBe(409);
    await expectAllSurfacesAgree(w);
  });
});
