/**
 * When a client sees an invoice as overdue in the portal.
 *
 * An invoice is overdue once its due day is behind the client's today. That
 * used to be the UTC today, so an invoice due today read as overdue from 5pm
 * on its due day for a client in the Pacific zone.
 */
import {
  testPool,
  createFirm,
  createInvoice,
  createPersonClient,
  createPortalUser,
  as,
  tokenFor,
} from '../support/setupInProcess';
import { freezeClockAt } from '../support/clock';

async function seedWorld() {
  const firm = await createFirm({ planId: 'enterprise' });
  const portalUser = await createPortalUser();
  const client = await createPersonClient(firm.id, { name: 'Pat Client', userId: portalUser.uid, email: 'pat@example.test' });
  const invoice = await createInvoice(firm.id, client.id, { totalCents: 50_000 });
  await testPool.query(`update invoices set due_date = '2026-09-27' where id = $1`, [invoice.id]);
  const api = as(tokenFor({ uid: portalUser.uid }), 'America/Los_Angeles');
  return { firm, client, invoice, api };
}

describe('an invoice due today, seen in the portal at 8pm Pacific', () => {
  /** Goes red if "today" is the UTC day, where it is already the 28th. */
  test('is not overdue yet', async () => {
    const { firm, client, invoice, api } = await seedWorld();
    freezeClockAt('2026-09-27T20:00:00-07:00');

    const res = await api.get(`/api/client-portal/lawfirm/${firm.id}/invoices/${invoice.id}?clientRecordId=${client.id}`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('outstanding');
  });

  test('is overdue the next morning', async () => {
    const { firm, client, invoice, api } = await seedWorld();
    freezeClockAt('2026-09-28T08:00:00-07:00');

    const res = await api.get(`/api/client-portal/lawfirm/${firm.id}/invoices/${invoice.id}?clientRecordId=${client.id}`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('overdue');
  });

  /** The invoice list reads the same way. */
  test('reads as not overdue in the billing list too', async () => {
    const { firm, client, invoice, api } = await seedWorld();
    freezeClockAt('2026-09-27T20:00:00-07:00');

    const res = await api.get(`/api/client-portal/lawfirm/${firm.id}/billing?clientRecordId=${client.id}`);

    expect(res.status).toBe(200);
    const listed = (res.body.invoices || []).find((i: any) => i.id === invoice.id);
    expect(listed?.status).toBe('outstanding');
  });
});
