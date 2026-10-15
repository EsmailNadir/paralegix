/**
 * B02.3 validation matrix, trust slice.
 *
 * `trustAccountsOps.test.ts`, `trustLedger.test.ts` and
 * `trustVoidAndReconciliation.test.ts` already cover the account/transaction
 * lifecycle and the malformed-id-is-not-found contract for the id-bearing
 * routes. This file covers what none of them do: money-field overflow and
 * type coercion, calendar-date validity (not just format), and that a
 * caller cannot hand the server a figure it is supposed to compute itself.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let accountId: string;

const CLIENT_NAME = 'Matrix Client';
const A = (lawFirmId: string, suffix = '') => `/api/lawfirms/${lawFirmId}/trust/accounts${suffix}`;
const TXN = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/trust/transactions`;
const MIN = (lawFirmId: string, suffix = '') => `/api/lawfirms/${lawFirmId}/trust/minimum-balances${suffix}`;

async function txnCount() {
  const { rows } = await testPool.query(
    'select count(*)::int c from trust_transactions where law_firm_id = $1', [firm.id],
  );
  return rows[0].c as number;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Validation Matrix Firm' });
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: CLIENT_NAME });

  const res = await owner.api.post(A(firm.id)).send({
    name: 'Matrix IOLTA',
    bankName: 'Matrix Bank',
    accountNumberLast4: '4321',
  });
  expect(res.status).toBe(201);
  accountId = res.body.account.id;
});

describe('money field overflow and type coercion', () => {
  it('rejects a JSON numeric-overflow amountCents (1e309) instead of storing an infinite deposit', async () => {
    // 1e309 exceeds the double range and JSON.parse hands it to us as
    // `Infinity`. `z.number().int().positive()` must reject that rather than
    // let it reach the append-only ledger, where nothing could ever undo it.
    const res = await owner.api.post(TXN(firm.id)).send({
      trustAccountId: accountId,
      clientId: client.id,
      clientName: CLIENT_NAME,
      type: 'deposit',
      amountCents: 1e309,
      date: '2026-07-01',
      description: 'Overflow attempt',
    });

    expect(res.status).toBe(400);
    expect(await txnCount()).toBe(0);
  });

  it('rejects a malformed numeric string for amountCents rather than coercing it', async () => {
    // The schema types amountCents as a strict number, not a string/number
    // union like the invoice line-item fields. A string must fail type
    // validation outright, not be silently coerced or parsed.
    const res = await owner.api.post(TXN(firm.id)).send({
      trustAccountId: accountId,
      clientId: client.id,
      clientName: CLIENT_NAME,
      type: 'deposit',
      amountCents: '500 dollars',
      date: '2026-07-01',
      description: 'Bad amount string',
    });

    expect(res.status).toBe(400);
    expect(await txnCount()).toBe(0);
  });
});

describe('calendar-date validity, not just format', () => {
  it('rejects an impossible calendar date (Feb 30) instead of a raw database error', async () => {
    // The regex `\d{4}-\d{2}-\d{2}` matches "2026-02-30" just fine; only
    // Postgres's own date parser knows February tops out at 28/29 days. Before
    // this endpoint validated calendar validity, that string reached
    // `txn_date` (a `date` column) unchanged and Postgres threw a raw
    // "date/time field value out of range" error, which the generic error
    // branch turns into an unhelpful scrubbed 500 instead of a clean 400
    // naming the bad field.
    const res = await owner.api.post(TXN(firm.id)).send({
      trustAccountId: accountId,
      clientId: client.id,
      clientName: CLIENT_NAME,
      type: 'deposit',
      amountCents: 5000,
      date: '2026-02-30',
      description: 'Impossible date',
    });

    expect(res.status).toBe(400);
    expect(await txnCount()).toBe(0);
  });

  it('still accepts a real calendar date after the validity check', async () => {
    // Control for the case above: the stricter check must not reject valid
    // dates, including the last day of a shorter month.
    const res = await owner.api.post(TXN(firm.id)).send({
      trustAccountId: accountId,
      clientId: client.id,
      clientName: CLIENT_NAME,
      type: 'deposit',
      amountCents: 5000,
      date: '2026-02-28',
      description: 'Last day of February',
    });

    expect(res.status).toBe(201);
    expect(res.body.transaction.date).toBe('2026-02-28');
  });

  it('rejects an impossible book-close date the same way', async () => {
    // `bookCloseSchema` shares the `dateStr` helper with the transaction date,
    // so the same class of bug (format-valid, calendar-invalid) applies here.
    const res = await owner.api.patch(A(firm.id, `/${accountId}/book-close`))
      .send({ bookCloseDate: '2026-04-31' });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      'select book_close_date from trust_accounts where id = $1', [accountId],
    );
    expect(rows[0].book_close_date).toBeNull();
  });
});

describe('server-owned fields on a transaction', () => {
  it('ignores a client-supplied balance-after figure and computes it server-side', async () => {
    // clientBalanceAfterCents / accountBalanceAfterCents are not in the create
    // schema at all, so they must be stripped before the service ever sees
    // them. A caller who could set these directly could make the ledger claim
    // any balance it wants, independent of the actual deposit total.
    const res = await owner.api.post(TXN(firm.id)).send({
      trustAccountId: accountId,
      clientId: client.id,
      clientName: CLIENT_NAME,
      type: 'deposit',
      amountCents: 7500,
      date: '2026-07-01',
      description: 'Balance spoof attempt',
      clientBalanceAfterCents: 999999999,
      accountBalanceAfterCents: 999999999,
    });

    expect(res.status).toBe(201);
    expect(res.body.transaction.clientBalanceAfter).toBe(7500);

    const { rows } = await testPool.query(
      'select account_balance_after_cents from trust_accounts a join trust_transactions t on t.trust_account_id = a.id where t.id = $1',
      [res.body.transaction.id],
    );
    expect(Number(rows[0].account_balance_after_cents)).toBe(7500);
  });
});

describe('account id validation on an unschematized route', () => {
  it('answers not found for a malformed minimum-balance id, not a database error', async () => {
    // `DELETE /minimum-balances/:id` carries no `validate()` middleware and no
    // Zod id schema at all, unlike every other id-bearing trust route. The
    // only thing standing between a malformed id and a raw uuid-cast error is
    // the service's own `assertUuid` call, so that guard is load-bearing here
    // in a way it is not for the other routes.
    const res = await owner.api.delete(MIN(firm.id, '/not-a-uuid'));

    expect(res.status).toBe(404);
  });

  it('answers not found for a well-formed but nonexistent minimum-balance id', async () => {
    const res = await owner.api.delete(MIN(firm.id, `/${randomUUID()}`));

    expect(res.status).toBe(404);
  });
});

describe('account creation field validation', () => {
  it('refuses a non-digit routing number even though it is the right length', async () => {
    // `accountNumberLast4` already has this exact protection tested in
    // trustAccountsOps.test.ts; `routingNumberLast4` shares the same regex but
    // has no rejection test of its own.
    const res = await owner.api.post(A(firm.id)).send({
      name: 'Bad Routing',
      bankName: 'Matrix Bank',
      accountNumberLast4: '1111',
      routingNumberLast4: 'ABCD',
    });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      "select 1 from trust_accounts where law_firm_id = $1 and name = 'Bad Routing'", [firm.id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('transfer shape', () => {
  const entry = (extra: Record<string, unknown>) => owner.api.post(TXN(firm.id)).send({
    trustAccountId: accountId, clientId: client.id, clientName: CLIENT_NAME,
    amountCents: 5000, date: '2026-07-01', description: 'Shape check', ...extra,
  });

  it('refuses a transfer with no destination', async () => {
    // A transfer moves money somewhere. Without a destination the ledger holds a
    // withdrawal-shaped row labelled transfer.
    expect((await entry({ type: 'transfer' })).status).toBe(400);
    expect(await txnCount()).toBe(0);
  });

  it('refuses a destination on anything that is not a transfer', async () => {
    // `transferTo: 'operating'` on a deposit would satisfy the fee rule's
    // "names an invoice" check for money that never left trust.
    expect((await entry({ type: 'deposit', transferTo: 'operating' })).status).toBe(400);
    expect(await txnCount()).toBe(0);
  });
});

describe('reconciliation snapshot', () => {
  it('answers a missing account id as a client error, like its sibling', async () => {
    const res = await owner.api.get(`/api/lawfirms/${firm.id}/trust/reconciliation-snapshot`);
    expect(res.status).toBe(400);
  });
});

describe('manual entry source', () => {
  it('refuses a hand-entered row labelled as Stripe-funded', async () => {
    // A `stripe` source is what the void route reads as "refund it in Stripe
    // instead". A manual entry has no Stripe charge behind it, so a row tagged
    // that way could never be voided by anyone.
    const res = await owner.api.post(TXN(firm.id)).send({
      trustAccountId: accountId, clientId: client.id, clientName: CLIENT_NAME,
      type: 'deposit', amountCents: 5000, date: '2026-07-01', source: 'stripe',
    });

    expect(res.status).toBe(400);
    expect(await txnCount()).toBe(0);
  });

  it('still accepts an ordinary manual source', async () => {
    const res = await owner.api.post(TXN(firm.id)).send({
      trustAccountId: accountId, clientId: client.id, clientName: CLIENT_NAME,
      type: 'deposit', amountCents: 5000, date: '2026-07-01', source: 'ach',
    });

    expect(res.status).toBe(201);
    expect(await txnCount()).toBe(1);
  });
});
