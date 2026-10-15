/**
 * An hourly line in the unbilled summary is priced in whole cents exactly as the stored time entry amount is (round half up of hundredths x rate).
 */
import {
  drainEvents, createFirm, createPersonClient, ownerOf, testPool,
  type Actor, type Firm, type ClientRecord,
} from '../../support/setupInProcess';

let firm: Firm; let owner: Actor; let client: ClientRecord;
beforeEach(async () => {
  firm = await createFirm(); owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'C' }); await drainEvents();
});

it.each([[0.3, 123.45, 3704], [0.03, 350.5, 1052], [0.41, 27.5, 1128]])(
  'summary line for %p h at $%p is %p cents, same as the stored entry',
  async (h, r, wantCents) => {
    const res = await owner.api.post(`/api/lawfirms/${firm.id}/billing/time-entries`).send({
      context: 'client', clientId: client.id, userId: owner.uid, hours: h, date: '2026-03-10', hourlyRate: r,
    });
    expect(res.status).toBe(201);
    const stored = Number((await testPool.query('select amount_cents from activities where id = $1', [res.body.timeEntry.id])).rows[0].amount_cents);
    expect(stored).toBe(wantCents);
    const sum = await owner.api.get(`/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}/unbilled-summary`);
    const line = sum.body.unbilledTimeEntries.find((e: any) => e.id === res.body.timeEntry.id);
    expect(Math.round(line.amount * 100)).toBe(wantCents);
  },
);
