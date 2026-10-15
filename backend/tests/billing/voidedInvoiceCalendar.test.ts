/**
 * A voided invoice leaves the billing calendar.
 *
 * Drives the real routes: an invoice is created (which pushes its due date to
 * the owner's connected Google calendar), then voided. Voiding has to clear the
 * payment-dates feed AND delete the entry already sitting on the external
 * calendar, which is the only copy a lawyer would actually see.
 *
 * Google is reached through the shared network wall, so the assertions are on
 * the recorded outbound calls.
 */
import {
  installGoogleFetchWall,
  uninstallGoogleFetchWall,
  resetGoogleFetch,
  route,
  googleCalls,
} from '../calendar/support/googleFetch';

// Before the app graph loads, so nothing can reach the network on the way in.
installGoogleFetchWall();

import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  drainEvents,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';

const EVENTS_URL = '/calendars/primary/events';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices`;
const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const posts = () => googleCalls().filter((c) => c.method === 'POST' && c.url.includes(EVENTS_URL));
const deletes = () => googleCalls().filter((c) => c.method === 'DELETE' && c.url.includes(EVENTS_URL));

async function connectOwnerToGoogle() {
  const uid = (await testPool.query(
    'select user_id from members where law_firm_id = $1 and is_owner = true', [firm.id],
  )).rows[0]?.user_id;
  expect(uid).toBeTruthy();
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token)
     values ($1, 'google', 'tok-owner', 'refresh-seed')`, [uid],
  );
  expect(tokens.rowCount).toBe(1);
  const settings = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'google', true, true)
     on conflict (user_id, provider) do update set is_sync_to_provider = true, is_sync_from_provider = true`,
    [uid],
  );
  expect(settings.rowCount).toBe(1);
}

async function createInvoice(): Promise<string> {
  const res = await owner.api.post(`${B()}/client/${client.id}`).send({
    invoiceName: 'Calendar bill',
    invoiceDate: dayOffset(-1),
    dueDate: dayOffset(10),
    totalAmount: 1000,
    flatFeesAmount: 1000,
    flatFees: [{ description: 'Fixed fee', amount: 1000 }],
  });
  expect(res.status).toBe(201);
  return res.body.invoice.id as string;
}

async function paymentDatesFor(invoiceId: string) {
  const res = await owner.api.get(
    `${B()}/calendar-payment-dates?from=${dayOffset(-5)}&to=${dayOffset(30)}`,
  );
  expect(res.status).toBe(200);
  return (res.body.paymentDates as any[]).filter((e) => e.invoiceId === invoiceId);
}

beforeEach(async () => {
  resetGoogleFetch();
  firm = await createFirm({ name: 'Calendar LLP' });
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Pat Payer', email: 'payer@calendar.test' });
  await connectOwnerToGoogle();
  route(EVENTS_URL, () => ({ status: 200, json: { id: 'g-bill-1' } }), { method: 'POST' });
  route(`${EVENTS_URL}/g-bill-1`, { status: 204 }, { method: 'DELETE' });
});

afterEach(async () => {
  await drainEvents();
});

afterAll(() => {
  uninstallGoogleFetchWall();
});

describe('voiding an invoice', () => {
  /**
   * RED IF getBillingCalendarItems stops excluding voided: the voided invoice
   * keeps its due-date entry in the feed.
   */
  it('removes its due date from the payment-dates feed', async () => {
    const id = await createInvoice();
    await drainEvents();

    const before = await paymentDatesFor(id);
    expect(before.length).toBeGreaterThan(0);

    const voided = await owner.api.post(`${B()}/client/${client.id}/${id}/void`).send({});
    expect(voided.status).toBe(200);
    await drainEvents();

    expect(await paymentDatesFor(id)).toEqual([]);
  });

  /**
   * RED IF voiding emits no calendar update, or the adapter still returns items
   * for a voided invoice: the synced entry is never deleted from Google.
   */
  it('deletes the entry already synced to the external calendar', async () => {
    const id = await createInvoice();
    await drainEvents();
    expect(posts()).toHaveLength(1);
    expect(deletes()).toHaveLength(0);

    const voided = await owner.api.post(`${B()}/client/${client.id}/${id}/void`).send({});
    expect(voided.status).toBe(200);
    await drainEvents();

    expect(deletes()).toHaveLength(1);
    expect(deletes()[0].url).toContain('/events/g-bill-1');
    expect(deletes()[0].bearer).toBe('tok-owner');
  });
});
