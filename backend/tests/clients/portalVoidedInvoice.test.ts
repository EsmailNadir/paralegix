/**
 * A client sees a voided invoice as cancelled.
 *
 * RED IF: the portal serializer derives a voided invoice's status from its
 * balance, the billing summary or the firm card sums it, or the pay route
 * hands out a checkout for it.
 */
import {
  createFirm, createPersonClient, createPortalUser, ownerOf, as, tokenFor, drainEvents,
} from '../support/setupInProcess';

const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function seedWorld() {
  const firm = await createFirm({ planId: 'enterprise' });
  const owner = await ownerOf(firm.id);
  const portalUser = await createPortalUser();
  const client = await createPersonClient(firm.id, { name: 'Pat Client', userId: portalUser.uid, email: 'pat@example.test' });
  const B = `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
  const issue = async (name: string, dollars: number) => {
    const res = await owner.api.post(B).send({
      invoiceName: name, invoiceDate: dayOffset(-40), dueDate: dayOffset(-10),
      totalAmount: dollars, flatFeesAmount: dollars, flatFees: [{ description: name, amount: dollars }],
    });
    expect(res.status).toBe(201);
    return res.body.invoice.id as string;
  };
  const liveId = await issue('Live', 300);
  const voidedId = await issue('Cancelled', 1000);
  const api = as(tokenFor({ uid: portalUser.uid }));
  const P = `/api/client-portal/lawfirm/${firm.id}`;
  return { firm, owner, client, B, liveId, voidedId, api, P };
}

describe('after the firm voids an invoice', () => {
  it('lists it as voided with nothing to pay, and leaves it out of the summary', async () => {
    const w = await seedWorld();
    // Control: the client is told they owe both before the void.
    const before = await w.api.get(`${w.P}/billing?clientRecordId=${w.client.id}`);
    expect(before.body.summary.totalOutstanding).toBe(1300);

    expect((await w.owner.api.post(`${w.B}/${w.voidedId}/void`)).status).toBe(200);
    await drainEvents();

    const res = await w.api.get(`${w.P}/billing?clientRecordId=${w.client.id}`);
    expect(res.status).toBe(200);
    const listed = res.body.invoices.find((i: any) => i.id === w.voidedId);
    expect(listed).toMatchObject({ status: 'voided', remainingBalance: 0 });
    expect(res.body.summary).toEqual({ totalBilled: 300, totalPaid: 0, totalOutstanding: 300 });
    expect(res.body.statusCounts).toMatchObject({ voided: 1, overdue: 1 });

    const one = await w.api.get(`${w.P}/invoices/${w.voidedId}?clientRecordId=${w.client.id}`);
    expect(one.body.invoice.status).toBe('voided');
  });

  it('leaves it out of the firm card balance, in cents', async () => {
    const w = await seedWorld();
    // Control: the card carries both balances before the void.
    const before = await w.api.get('/api/client-portal/firm-summaries');
    expect(before.body.lawFirms.find((f: any) => f.id === w.firm.id).outstandingBalanceCents).toBe(130_000);

    expect((await w.owner.api.post(`${w.B}/${w.voidedId}/void`)).status).toBe(200);

    const res = await w.api.get('/api/client-portal/firm-summaries');
    expect(res.status).toBe(200);
    expect(res.body.lawFirms.find((f: any) => f.id === w.firm.id).outstandingBalanceCents).toBe(30_000);
  });

  it('refuses to open a payment for it', async () => {
    const w = await seedWorld();
    expect((await w.owner.api.post(`${w.B}/${w.voidedId}/void`)).status).toBe(200);

    const res = await w.api.get(`${w.P}/billing/pay/${w.voidedId}?clientRecordId=${w.client.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/voided/i);
  });
});
