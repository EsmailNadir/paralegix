/**
 * The trust service, tested OFFLINE against a fake transport.
 *
 * `trust.service.ts` reports 0%. Trust is client money the firm holds but does
 * not own, so the failures here are not cosmetic: an amount sent in the wrong
 * unit, a movement attributed to the wrong client, or a request built against
 * the wrong path all change a real ledger balance and every one of them reports
 * success in exactly the same words.
 *
 * TWO INVARIANTS GET THE MOST ATTENTION.
 *
 * MONEY IS INTEGER CENTS. Every `*_cents` column is a bigint and the API speaks
 * the same unit, so the only correct assertion is on the integer that left the
 * browser. Asserting that a rendered dollar string is absent proves nothing,
 * because the API never renders dollars in the first place.
 *
 * DIRECTION AND ATTRIBUTION. A deposit and a withdrawal move money opposite
 * ways, and in this service they share ONE endpoint: the `type` field in the
 * body is the whole of the difference. That makes the body field load-bearing in
 * the way a path is elsewhere, so it is pinned per direction rather than assumed.
 * Where trust routes genuinely do differ by path (matter ledger vs client
 * ledger, status vs book-close, void vs update) each is pinned to its own url.
 */
jest.unmock('@/services/trust.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import trustService from '@/services/trust.service';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import type {
  CreateTransactionPayload,
  CreateReconciliationPayload,
} from '@/types/trust';

const LAW_FIRM_ID = 'firm-1';
const ACCOUNT_ID = 'acct-1';
const CLIENT_ID = 'client-7';
const MATTER_ID = 'matter-3';
const TRANSACTION_ID = 'txn-42';

/** $7,319.00 as the integer the ledger stores. */
const SEVEN_THOUSAND = 731900;

function transactionPayload(over: Partial<CreateTransactionPayload> = {}): CreateTransactionPayload {
  return {
    trustAccountId: ACCOUNT_ID,
    type: 'deposit',
    amountCents: SEVEN_THOUSAND,
    clientId: CLIENT_ID,
    clientName: 'Acme Holdings',
    date: '2026-03-04',
    ...over,
  };
}

function postBody(api: ApiMock, index = 0): Record<string, unknown> {
  return api.calls('POST')[index].body as Record<string, unknown>;
}

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  // Several cases read the same endpoint in consecutive tests, which trips the
  // dev-only duplicate-GET warning and buries the real output.
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  api.restore();
});

describe('an amount leaves the browser in the unit the server stores', () => {
  it('sends amountCents as the integer it was given', async () => {
    api.post('/transactions', { transaction: { id: TRANSACTION_ID } });

    await trustService.createTransaction(LAW_FIRM_ID, transactionPayload());

    // The server reads `amountCents` as cents. Any rescaling on the way out -
    // a stray /100 to "show dollars", a toFixed(2) that stringifies it - posts a
    // number a hundred times too small and the deposit is accepted.
    const body = postBody(api);
    expect(body.amountCents).toBe(SEVEN_THOUSAND);
    expect(Number.isInteger(body.amountCents)).toBe(true);
  });

  it('sends no dollar-denominated amount alongside it', async () => {
    api.post('/transactions', { transaction: { id: TRANSACTION_ID } });

    await trustService.createTransaction(LAW_FIRM_ID, transactionPayload());

    // One field, one unit. A second `amount` in dollars gives the server two
    // sources for the same fact that can disagree, and whichever it prefers is
    // then invisible from this side.
    const body = postBody(api);
    expect(body.amount).toBeUndefined();
    expect(body.amountDollars).toBeUndefined();
  });

  it('sends a reconciliation bank balance in cents too', async () => {
    api.post('/reconciliations', { reconciliation: { id: 'rec-1' } });

    const payload: CreateReconciliationPayload = {
      trustAccountId: ACCOUNT_ID,
      reconciliationDate: '2026-03-31',
      bankStatementBalanceCents: 1250075,
      adjustments: [{ description: 'Bank fee', amountCents: -1500, category: 'fee' }],
    };
    await trustService.createReconciliation(LAW_FIRM_ID, payload);

    // Reconciliation subtracts this from the book balance. A unit slip does not
    // fail loudly, it reports a discrepancy of roughly the whole account, or
    // hides a real shortfall inside a rounding difference.
    const body = postBody(api);
    expect(body.bankStatementBalanceCents).toBe(1250075);
    expect(body.adjustments).toEqual([
      { description: 'Bank fee', amountCents: -1500, category: 'fee' },
    ]);
  });

  it('sends a minimum balance threshold in cents', async () => {
    api.put('/minimum-balances', { minimumBalance: { id: 'min-1' } });

    await trustService.upsertMinimumBalance(LAW_FIRM_ID, {
      clientId: CLIENT_ID,
      trustAccountId: ACCOUNT_ID,
      minimumCents: 250000,
    });

    // The threshold that decides when the firm asks for another retainer. In
    // dollars it would fire two orders of magnitude too late.
    expect((api.calls('PUT')[0].body as Record<string, unknown>).minimumCents).toBe(250000);
  });

  it('returns the transaction from inside its envelope', async () => {
    api.post('/transactions', {
      transaction: { id: TRANSACTION_ID, amountCents: SEVEN_THOUSAND, type: 'deposit' },
    });

    const created = await trustService.createTransaction(LAW_FIRM_ID, transactionPayload());

    // Returning the whole envelope instead would hand the caller an object with
    // no `amountCents`, and the confirmation would render a blank amount for a
    // movement that did happen.
    expect(created.amountCents).toBe(SEVEN_THOUSAND);
    expect(created.id).toBe(TRANSACTION_ID);
  });

  it('CHARACTERISATION: does not refuse a negative or non-finite amount itself', async () => {
    api.post('/transactions', { transaction: { id: TRANSACTION_ID } });

    await trustService.createTransaction(LAW_FIRM_ID, transactionPayload({ amountCents: -500 }));

    // There is no amount validation in this layer: whatever the caller passes is
    // serialised and sent, and the refusal comes from the backend schema. The
    // only client-side guard lives in `TransactionForm`, which is where the
    // "refused before any request is built" rule is pinned
    // (`TransactionForm.test.tsx`). Recorded here so the division of
    // responsibility is visible, and so this goes red if a guard is added to the
    // service without the form's own guard being reconsidered.
    expect(postBody(api).amountCents).toBe(-500);
  });
});

describe('direction: a deposit and a withdrawal must not be confused', () => {
  it('sends type=deposit for money coming in', async () => {
    api.post('/transactions', { transaction: { id: TRANSACTION_ID } });

    await trustService.createTransaction(LAW_FIRM_ID, transactionPayload({ type: 'deposit' }));

    expect(postBody(api).type).toBe('deposit');
  });

  it('sends type=withdrawal for money going out', async () => {
    api.post('/transactions', { transaction: { id: TRANSACTION_ID } });

    await trustService.createTransaction(LAW_FIRM_ID, transactionPayload({
      type: 'withdrawal',
      payee: 'County Clerk',
    }));

    // The negative half of the case above. A service that defaulted or hardcoded
    // the type would satisfy the deposit case and turn every disbursement into a
    // deposit, which inflates the client's balance instead of reducing it.
    const body = postBody(api);
    expect(body.type).toBe('withdrawal');
    expect(body.payee).toBe('County Clerk');
  });

  it('carries the direction in the BODY, since both share one endpoint', async () => {
    api.post('/transactions', { transaction: { id: TRANSACTION_ID } });

    await trustService.createTransaction(LAW_FIRM_ID, transactionPayload({ type: 'deposit' }));
    await trustService.createTransaction(LAW_FIRM_ID, transactionPayload({ type: 'withdrawal' }));

    // Both directions POST to the same url, so the `type` field is the only
    // thing that decides which way the money moves. Dropping it, or letting it
    // fall back to a default, moves money the wrong way and the confirmation
    // reads identically either way - which is exactly why it is asserted rather
    // than assumed.
    const [deposit, withdrawal] = api.calls('POST');
    expect(deposit.pathname).toBe(withdrawal.pathname);
    expect((deposit.body as Record<string, unknown>).type).toBe('deposit');
    expect((withdrawal.body as Record<string, unknown>).type).toBe('withdrawal');
  });

  it('sends a transfer destination only on a transfer', async () => {
    api.post('/transactions', { transaction: { id: TRANSACTION_ID } });

    await trustService.createTransaction(LAW_FIRM_ID, transactionPayload({
      type: 'transfer',
      transferToAccountId: 'acct-2',
    }));

    // A trust-to-trust transfer is two legs the server writes together from this
    // one field. Losing it turns a transfer into an unmatched outflow, and the
    // destination account never receives its half.
    expect(postBody(api).transferToAccountId).toBe('acct-2');
  });
});

describe('attribution: whose money moved, and on which matter', () => {
  it('sends the client id and name the caller chose', async () => {
    api.post('/transactions', { transaction: { id: TRANSACTION_ID } });

    await trustService.createTransaction(LAW_FIRM_ID, transactionPayload({
      clientId: CLIENT_ID,
      clientName: 'Acme Holdings',
    }));

    // The client ledger is the record a bar audit reads. Attributing a movement
    // to the wrong client overstates one balance and understates another, and
    // the account total still reconciles, so nothing looks wrong.
    const body = postBody(api);
    expect(body.clientId).toBe(CLIENT_ID);
    expect(body.clientName).toBe('Acme Holdings');
  });

  it('keeps the matter fields distinct from the client fields', async () => {
    api.post('/transactions', { transaction: { id: TRANSACTION_ID } });

    await trustService.createTransaction(LAW_FIRM_ID, transactionPayload({
      clientId: CLIENT_ID,
      clientName: 'Acme Holdings',
      matterId: MATTER_ID,
      matterName: 'Acme v Widgets',
    }));

    // Four ids and names travelling together in one flat body is exactly the
    // shape a swap survives: both halves are non-empty strings, so nothing
    // downstream can tell that the matter id landed in the client field.
    const body = postBody(api);
    expect(body.clientId).toBe(CLIENT_ID);
    expect(body.matterId).toBe(MATTER_ID);
    expect(body.clientName).toBe('Acme Holdings');
    expect(body.matterName).toBe('Acme v Widgets');
  });

  it('omits the matter entirely when there is none', async () => {
    api.post('/transactions', { transaction: { id: TRANSACTION_ID } });

    await trustService.createTransaction(LAW_FIRM_ID, transactionPayload());

    // Trust money can sit against a client with no matter yet. Sending an empty
    // string or the literal "undefined" would attribute it to a matter that does
    // not exist, and the matter ledger it belongs on would never show it.
    const body = postBody(api);
    expect('matterId' in body).toBe(false);
    expect('matterName' in body).toBe(false);
  });
});

describe('ids stay inside their own path segment', () => {
  it('encodes a firm id that would otherwise escape the route', async () => {
    api.get('/accounts', { accounts: [] });

    await trustService.listAccounts('../evil-firm');

    // The firm id is interpolated straight into the url. Unencoded, `..` is
    // resolved away by the URL parser and the request leaves the firm-scoped
    // route entirely, which is the one thing multi-tenancy cannot survive.
    const { pathname } = api.calls('GET')[0];
    expect(pathname).toContain('/lawfirms/');
    expect(pathname).not.toContain('/lawfirms/../');
  });

  it('encodes an account id the same way', async () => {
    api.patch('/status', { account: { id: 'acct-1' } });

    await trustService.updateAccountStatus(LAW_FIRM_ID, '../../other', 'inactive');

    const { pathname } = api.calls('PATCH')[0];
    expect(pathname).toContain(`/lawfirms/${LAW_FIRM_ID}/trust/accounts/`);
    expect(pathname).not.toContain('/../');
  });
});

describe('transaction filters', () => {
  const PAGE = { transactions: [], totalItems: 0 };

  it('passes each filter through under its own key', async () => {
    api.get('/transactions', PAGE);

    await trustService.listTransactionsPaged(LAW_FIRM_ID, {
      trustAccountId: ACCOUNT_ID,
      clientId: CLIENT_ID,
      type: 'withdrawal',
      status: 'completed',
      startDate: '2026-01-01',
      endDate: '2026-03-31',
    });

    // Read back through URLSearchParams rather than decodeURIComponent: a query
    // string encodes a space as `+`, which decodeURIComponent leaves alone.
    const params = new URL(api.calls('GET')[0].url, 'http://x').searchParams;
    expect(params.get('trustAccountId')).toBe(ACCOUNT_ID);
    expect(params.get('clientId')).toBe(CLIENT_ID);
    expect(params.get('type')).toBe('withdrawal');
    expect(params.get('status')).toBe('completed');
    expect(params.get('startDate')).toBe('2026-01-01');
    expect(params.get('endDate')).toBe('2026-03-31');
  });

  it('omits a filter that was not given', async () => {
    api.get('/transactions', PAGE);

    await trustService.listTransactionsPaged(LAW_FIRM_ID, { clientId: CLIENT_ID });

    // `clientId=undefined` matches no client, so the ledger renders empty and
    // reads as "this client has no trust history".
    const params = new URL(api.calls('GET')[0].url, 'http://x').searchParams;
    expect(params.has('type')).toBe(false);
    expect(params.has('trustAccountId')).toBe(false);
  });

  it('sends a zero offset rather than dropping it', async () => {
    api.get('/transactions', PAGE);

    await trustService.listTransactionsPaged(LAW_FIRM_ID, { limit: 50, offset: 0 });

    // The guard tests for undefined and null, not truthiness. A truthiness check
    // silently drops `offset=0`, which is the first page of every ledger, and
    // the server's own default then decides the window instead of the caller.
    const params = new URL(api.calls('GET')[0].url, 'http://x').searchParams;
    expect(params.get('offset')).toBe('0');
    expect(params.get('limit')).toBe('50');
  });

  it('reports the filtered total independently of the page window', async () => {
    api.get('/transactions', { transactions: [{ id: 't1' }], totalItems: 87 });

    const page = await trustService.listTransactionsPaged(LAW_FIRM_ID, { limit: 1 });

    // A total taken from the rendered rows would say 1, and the pager would stop
    // offering the other 86 entries of the ledger.
    expect(page.transactions).toHaveLength(1);
    expect(page.totalItems).toBe(87);
  });

  it('defaults a missing envelope to an empty page', async () => {
    api.get('/transactions', {});

    const page = await trustService.listTransactionsPaged(LAW_FIRM_ID);

    expect(page.transactions).toEqual([]);
    expect(page.totalItems).toBe(0);
  });

  it('unwraps the array for the non-paged caller', async () => {
    api.get('/transactions', { transactions: [{ id: 't1' }, { id: 't2' }], totalItems: 2 });

    const list = await trustService.listTransactions(LAW_FIRM_ID);

    expect(list.map((t) => t.id)).toEqual(['t1', 't2']);
  });
});

describe('a matter ledger and a client ledger are different reads', () => {
  const LEDGER = { transactions: [], totalItems: 0 };

  it('reads a matter ledger from the matter route', async () => {
    api.get(`/matters/${MATTER_ID}/ledger`, LEDGER);

    await trustService.getMatterLedger(LAW_FIRM_ID, MATTER_ID);

    expect(api.calls('GET')[0].pathname).toMatch(new RegExp(`/matters/${MATTER_ID}/ledger$`));
  });

  it('reads a client ledger from the client route', async () => {
    api.get(`/clients/${CLIENT_ID}/ledger`, LEDGER);

    await trustService.getClientLedgerPaged(LAW_FIRM_ID, CLIENT_ID);

    // Same envelope, same paging, same method: only the path says whose ledger
    // this is. Reading one from the other's route shows a client every movement
    // on a matter they may not be party to, and the screen looks perfectly
    // normal.
    expect(api.calls('GET')[0].pathname).toMatch(new RegExp(`/clients/${CLIENT_ID}/ledger$`));
  });

  it('reads a matter balance and a client balance from their own routes', async () => {
    api.get(`/matters/${MATTER_ID}/balance`, {
      matterId: MATTER_ID, totalBalanceCents: 500000, accountBalances: [],
    });
    api.get(`/clients/${CLIENT_ID}/balance`, {
      clientId: CLIENT_ID, totalBalanceCents: 900000, accountBalances: [],
    });

    const matterBalance = await trustService.getMatterBalance(LAW_FIRM_ID, MATTER_ID);
    const clientBalance = await trustService.getClientBalance(LAW_FIRM_ID, CLIENT_ID);

    // The balance is what gates a disbursement. Reading the client's total where
    // the matter's was asked for authorises paying out money held for the
    // client's other work.
    expect(matterBalance.totalBalanceCents).toBe(500000);
    expect(clientBalance.totalBalanceCents).toBe(900000);
  });

  it('sends the row order the caller asked for', async () => {
    api.get(`/matters/${MATTER_ID}/ledger`, LEDGER);

    await trustService.getMatterLedger(LAW_FIRM_ID, MATTER_ID, { limit: 25, offset: 50, order: 'desc' });

    // The server orders before it windows, so `desc` is what makes the first page
    // the most recent activity. It cannot be reproduced by reversing a page here.
    const params = new URL(api.calls('GET')[0].url, 'http://x').searchParams;
    expect(params.get('order')).toBe('desc');
    expect(params.get('limit')).toBe('25');
    expect(params.get('offset')).toBe('50');
  });

  it('omits paging when none was given', async () => {
    api.get(`/matters/${MATTER_ID}/ledger`, LEDGER);

    await trustService.getMatterLedger(LAW_FIRM_ID, MATTER_ID);

    const params = new URL(api.calls('GET')[0].url, 'http://x').searchParams;
    expect(params.has('limit')).toBe(false);
    expect(params.has('order')).toBe(false);
  });
});

describe('voiding a transaction is not deleting it', () => {
  it('PATCHes the void route with the reason', async () => {
    api.patch(`/transactions/${TRANSACTION_ID}/void`, {
      transaction: { id: TRANSACTION_ID, status: 'void' },
    });

    await trustService.voidTransaction(LAW_FIRM_ID, TRANSACTION_ID, {
      voidReason: 'Deposited to the wrong client',
    });

    // A trust entry is never removed; it is reversed and kept, with a reason, so
    // the audit trail still shows what happened. A DELETE here would erase the
    // evidence a reconciliation depends on.
    const [call] = api.calls('PATCH');
    expect(call.pathname).toMatch(/\/void$/);
    expect((call.body as Record<string, unknown>).voidReason)
      .toBe('Deposited to the wrong client');
    expect(api.calls('DELETE')).toHaveLength(0);
  });

  it('surfaces the server refusal instead of reporting success', async () => {
    api.patch(`/transactions/${TRANSACTION_ID}/void`, {
      status: 409,
      body: { error: 'This transaction is inside a closed book period' },
    });

    // The period lock is the backend's, and it is the only thing stopping a
    // reconciled month from being rewritten. Swallowing the refusal would show
    // the row as voided until the next reload brought it back.
    await expect(trustService.voidTransaction(LAW_FIRM_ID, TRANSACTION_ID, { voidReason: 'oops' }))
      .rejects.toThrow(/closed book period/i);
  });
});

describe('account status and the book-close lock are separate PATCHes', () => {
  it('sends only the status to the status route', async () => {
    api.patch('/status', { account: { id: ACCOUNT_ID, status: 'inactive' } });

    await trustService.updateAccountStatus(LAW_FIRM_ID, ACCOUNT_ID, 'inactive');

    const [call] = api.calls('PATCH');
    expect(call.pathname).toMatch(/\/status$/);
    expect(call.body).toEqual({ status: 'inactive' });
  });

  it('sends the book-close date to the book-close route', async () => {
    api.patch('/book-close', { account: { id: ACCOUNT_ID } });

    await trustService.updateBookCloseDate(LAW_FIRM_ID, ACCOUNT_ID, '2026-03-31');

    // Two PATCHes on the same account with near-identical signatures. Sending one
    // to the other's path either locks a period nobody asked to lock or
    // deactivates a live trust account.
    const [call] = api.calls('PATCH');
    expect(call.pathname).toMatch(/\/book-close$/);
    expect(call.body).toEqual({ bookCloseDate: '2026-03-31' });
  });

  it('clears the lock by sending an EXPLICIT null', async () => {
    api.patch('/book-close', { account: { id: ACCOUNT_ID } });

    await trustService.updateBookCloseDate(LAW_FIRM_ID, ACCOUNT_ID, null);

    // `null` clears the period lock; an omitted field means "leave it alone".
    // A truthiness guard would turn every unlock request into a no-op that
    // reports success, and the month would stay frozen.
    expect(api.calls('PATCH')[0].body).toEqual({ bookCloseDate: null });
  });
});

describe('envelopes and their defaults', () => {
  it('returns an empty account list rather than undefined', async () => {
    api.get('/accounts', {});

    // The trust overview maps over this. `undefined` throws before the page
    // renders, which reads as trust being broken rather than unconfigured.
    expect(await trustService.listAccounts(LAW_FIRM_ID)).toEqual([]);
  });

  it('keeps the accounts the server sent', async () => {
    api.get('/accounts', { accounts: [{ id: ACCOUNT_ID, name: 'Main IOLTA' }] });

    // The positive half: a default that overwrote real values would show every
    // firm an empty trust page.
    const accounts = await trustService.listAccounts(LAW_FIRM_ID);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].name).toBe('Main IOLTA');
  });

  it('returns an empty balance report rather than undefined', async () => {
    api.get('/balances', {});

    expect(await trustService.getAllBalances(LAW_FIRM_ID)).toEqual([]);
  });

  it('carries the truncated flag on an interest remittance list', async () => {
    api.get('/interest-remittances', {
      remittances: [{ id: 'rem-1', status: 'pending' }],
      totalItems: 400,
      truncated: true,
      ceiling: 200,
    });

    const result = await trustService.listRemittances(LAW_FIRM_ID);

    // A capped list rendered as a complete one is an interest history that
    // silently does not add up against the bar foundation's statement. The flag
    // is the only thing telling the caller to say the view is partial.
    expect(result.truncated).toBe(true);
    expect(result.ceiling).toBe(200);
    expect(result.totalItems).toBe(400);
  });

  it('reports a complete remittance list as not truncated', async () => {
    api.get('/interest-remittances', { remittances: [{ id: 'rem-1', status: 'remitted' }] });

    const result = await trustService.listRemittances(LAW_FIRM_ID);

    // The negative half, plus the total falling back to the rendered count so a
    // server that predates the envelope still reports a sane number instead of 0.
    expect(result.truncated).toBe(false);
    expect(result.ceiling).toBeNull();
    expect(result.totalItems).toBe(1);
  });

  it('scopes a remittance list to one account when asked', async () => {
    api.get('/interest-remittances', { remittances: [] });

    await trustService.listRemittances(LAW_FIRM_ID, ACCOUNT_ID);

    const params = new URL(api.calls('GET')[0].url, 'http://x').searchParams;
    expect(params.get('trustAccountId')).toBe(ACCOUNT_ID);
  });

  it('returns null for an account that has never been reconciled', async () => {
    api.get('/reconciliations/latest', { reconciliation: null });

    // The "never reconciled" empty state depends on this being null rather than
    // a throw or an empty object, which would render as a reconciliation dated
    // nowhere.
    expect(await trustService.getLatestReconciliation(LAW_FIRM_ID, ACCOUNT_ID)).toBeNull();
  });
});

describe('failures surface the server reason', () => {
  it('throws the refusal when a deposit is rejected', async () => {
    api.post('/transactions', {
      status: 400,
      body: { error: 'Transaction date falls on or before the book-close date' },
    });

    // Trust writes fail for reasons the user can act on. A generic message, or a
    // swallowed failure, leaves them re-entering a deposit that will never be
    // accepted.
    await expect(trustService.createTransaction(LAW_FIRM_ID, transactionPayload()))
      .rejects.toThrow(/book-close date/i);
  });

  it('throws rather than returning a blank account on a 404', async () => {
    api.get(`/accounts/${ACCOUNT_ID}`, { status: 404, body: { error: 'Trust account not found' } });

    await expect(trustService.getAccount(LAW_FIRM_ID, ACCOUNT_ID)).rejects.toThrow(/not found/i);
  });

  it('throws when a read of the balances is forbidden', async () => {
    api.get('/balances', { status: 403, body: { error: 'Forbidden' } });

    await expect(trustService.getAllBalances(LAW_FIRM_ID)).rejects.toBeDefined();
  });
});

describe('every trust request identifies its caller', () => {
  it('sends the Authorization header on a money-moving POST', async () => {
    api.post('/transactions', { transaction: { id: TRANSACTION_ID } });

    await trustService.createTransaction(LAW_FIRM_ID, transactionPayload());

    // The header is what the backend scopes the firm membership check to. Without
    // it the request is anonymous and the trust router refuses it.
    expect(api.calls('POST')[0].headers.authorization).toMatch(/^Bearer /);
  });

  it('sends the timezone header, which the trust router requires', async () => {
    api.post('/transactions', { transaction: { id: TRANSACTION_ID } });

    await trustService.createTransaction(LAW_FIRM_ID, transactionPayload());

    expect(api.calls('POST')[0].headers['x-timezone']).toBeTruthy();
  });

  it('declares a JSON body on a write', async () => {
    api.post('/transactions', { transaction: { id: TRANSACTION_ID } });

    await trustService.createTransaction(LAW_FIRM_ID, transactionPayload());

    // Without it Express parses no body, and a transaction arrives with no
    // amount, no client and no type.
    expect(api.calls('POST')[0].headers['content-type']).toContain('application/json');
  });
});

/**
 * The remaining reads and writes, each pinned to its exact method, path, body
 * and envelope. `getExact`/`postExact` match the WHOLE pathname and query, so a
 * request that drifts to another firm, another resource, or picks up a stray
 * query parameter matches nothing and the transport throws.
 */
const TRUST = `/api/lawfirms/${LAW_FIRM_ID}/trust`;

function onlyCall(method: string) {
  const calls = api.calls(method);
  expect(calls).toHaveLength(1);
  return calls[0];
}

describe('trust accounts: create, read, update', () => {
  const ACCOUNT = {
    id: ACCOUNT_ID,
    name: 'IOLTA Operating',
    bankName: 'First Bank',
    accountNumberLast4: '1234',
  };

  it('POSTs a new account to the firm accounts route with exactly the payload', async () => {
    api.postExact(`${TRUST}/accounts`, { status: 201, body: { account: ACCOUNT } });

    const created = await trustService.createAccount(LAW_FIRM_ID, {
      name: 'IOLTA Operating',
      bankName: 'First Bank',
      accountNumberLast4: '1234',
      accountType: 'iolta',
    });

    // The firm id lives in the path only. A body that also carried it would let
    // a stale firm id in the payload disagree with the route the server scoped.
    expect(onlyCall('POST').body).toEqual({
      name: 'IOLTA Operating',
      bankName: 'First Bank',
      accountNumberLast4: '1234',
      accountType: 'iolta',
    });
    // Unwrapped from `{ account }`: returning the envelope would hand the caller
    // an object with no id, and the new account could not be opened.
    expect(created).toEqual(ACCOUNT);
  });

  it('GETs one account by id and returns it unwrapped', async () => {
    api.getExact(`${TRUST}/accounts/${ACCOUNT_ID}`, { account: ACCOUNT });

    const account = await trustService.getAccount(LAW_FIRM_ID, ACCOUNT_ID);

    expect(onlyCall('GET').pathname).toBe(`${TRUST}/accounts/${ACCOUNT_ID}`);
    expect(account).toEqual(ACCOUNT);
  });

  it('PUTs an account edit to the account route, not the status or book-close route', async () => {
    api.putExact(`${TRUST}/accounts/${ACCOUNT_ID}`, { account: { ...ACCOUNT, name: 'Renamed' } });

    const updated = await trustService.updateAccount(LAW_FIRM_ID, ACCOUNT_ID, { name: 'Renamed' });

    expect(onlyCall('PUT').body).toEqual({ name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
  });

  it('lists accounts from the firm accounts route', async () => {
    api.getExact(`${TRUST}/accounts`, { accounts: [ACCOUNT] });

    const accounts = await trustService.listAccounts(LAW_FIRM_ID);

    expect(accounts).toEqual([ACCOUNT]);
  });
});

describe('minimum balances', () => {
  it('lists the thresholds from the minimum-balances route', async () => {
    const row = { id: 'min-1', clientId: CLIENT_ID, trustAccountId: ACCOUNT_ID, minimumCents: 250000 };
    api.getExact(`${TRUST}/minimum-balances`, { minimumBalances: [row] });

    const rows = await trustService.listMinimumBalances(LAW_FIRM_ID);

    expect(rows).toEqual([row]);
    expect(rows[0].minimumCents).toBe(250000);
  });

  it('returns an empty list when the envelope has no minimumBalances key', async () => {
    api.getExact(`${TRUST}/minimum-balances`, {});

    await expect(trustService.listMinimumBalances(LAW_FIRM_ID)).resolves.toEqual([]);
  });

  it('PUTs the threshold to the collection route and returns the saved row', async () => {
    const saved = { id: 'min-1', clientId: CLIENT_ID, trustAccountId: ACCOUNT_ID, minimumCents: 100001 };
    api.putExact(`${TRUST}/minimum-balances`, { minimumBalance: saved });

    const result = await trustService.upsertMinimumBalance(LAW_FIRM_ID, {
      clientId: CLIENT_ID,
      trustAccountId: ACCOUNT_ID,
      minimumCents: 100001,
    });

    expect(onlyCall('PUT').body).toEqual({
      clientId: CLIENT_ID,
      trustAccountId: ACCOUNT_ID,
      minimumCents: 100001,
    });
    expect(result).toEqual(saved);
  });

  it('DELETEs one threshold by id', async () => {
    api.deleteExact(`${TRUST}/minimum-balances/min-1`, { status: 204 });

    await expect(trustService.deleteMinimumBalance(LAW_FIRM_ID, 'min-1')).resolves.toBeUndefined();

    expect(onlyCall('DELETE').pathname).toBe(`${TRUST}/minimum-balances/min-1`);
  });
});

describe('interest remittances', () => {
  const REMITTANCE = {
    id: 'rem-1',
    trustAccountId: ACCOUNT_ID,
    interestEarnedCents: 1234,
    amountRemittedCents: 1233,
    status: 'remitted',
  };

  it('sends no account filter for the firm-wide list', async () => {
    api.getExact(`${TRUST}/interest-remittances`, { remittances: [REMITTANCE], totalItems: 1 });

    const list = await trustService.listRemittances(LAW_FIRM_ID);

    expect(onlyCall('GET').search).toBe('');
    expect(list).toEqual({ remittances: [REMITTANCE], totalItems: 1, truncated: false, ceiling: null });
  });

  it('falls back to the rendered count when the server sends no totalItems', async () => {
    api.getExact(`${TRUST}/interest-remittances`, { remittances: [REMITTANCE, { ...REMITTANCE, id: 'rem-2' }] });

    const list = await trustService.listRemittances(LAW_FIRM_ID);

    // `?? remittances.length`, not `?? 0`: an older server with no envelope still
    // reports how many rows it sent.
    expect(list.totalItems).toBe(2);
  });

  it('returns an empty, untruncated list for an empty envelope', async () => {
    api.getExact(`${TRUST}/interest-remittances`, {});

    await expect(trustService.listRemittances(LAW_FIRM_ID)).resolves.toEqual({
      remittances: [], totalItems: 0, truncated: false, ceiling: null,
    });
  });

  it('POSTs a remittance with the cents fields exactly as given', async () => {
    api.postExact(`${TRUST}/interest-remittances`, { remittance: REMITTANCE });

    const created = await trustService.createRemittance(LAW_FIRM_ID, {
      trustAccountId: ACCOUNT_ID,
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      interestEarnedCents: 1234,
      amountRemittedCents: 1233,
      remittedTo: 'State Bar Foundation',
      status: 'remitted',
    });

    // A remittance is reconciled against the bar foundation's statement to the
    // cent. Both amounts must leave as the integers they arrived as.
    expect(onlyCall('POST').body).toEqual({
      trustAccountId: ACCOUNT_ID,
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      interestEarnedCents: 1234,
      amountRemittedCents: 1233,
      remittedTo: 'State Bar Foundation',
      status: 'remitted',
    });
    expect(created).toEqual(REMITTANCE);
  });

  it('PUTs an edit to the remittance by id', async () => {
    api.putExact(`${TRUST}/interest-remittances/rem-1`, { remittance: { ...REMITTANCE, notes: 'Late' } });

    const updated = await trustService.updateRemittance(LAW_FIRM_ID, 'rem-1', {
      trustAccountId: ACCOUNT_ID,
      notes: 'Late',
    });

    expect(onlyCall('PUT').body).toEqual({ trustAccountId: ACCOUNT_ID, notes: 'Late' });
    expect(updated.notes).toBe('Late');
  });

  it('DELETEs a remittance by id', async () => {
    api.deleteExact(`${TRUST}/interest-remittances/rem-1`, { status: 204 });

    await expect(trustService.deleteRemittance(LAW_FIRM_ID, 'rem-1')).resolves.toBeUndefined();
    expect(onlyCall('DELETE').pathname).toBe(`${TRUST}/interest-remittances/rem-1`);
  });
});

describe('firm trust settings and the audit report', () => {
  const SETTINGS = {
    reconcileCadence: 'monthly',
    retentionYears: 5,
    flatFeeToOperatingAllowed: false,
    electronicTrustDepositsAllowed: true,
    enforceMatterTrustBalance: false,
    lowBalanceThresholdCents: 50000,
  };

  it('GETs the settings and returns them unwrapped', async () => {
    api.getExact(`${TRUST}/settings`, { settings: SETTINGS });

    await expect(trustService.getTrustSettings(LAW_FIRM_ID)).resolves.toEqual(SETTINGS);
  });

  it('PUTs only the fields being changed', async () => {
    api.putExact(`${TRUST}/settings`, { settings: { ...SETTINGS, retentionYears: 7 } });

    const saved = await trustService.updateTrustSettings(LAW_FIRM_ID, { retentionYears: 7 });

    // A partial PUT. Sending the whole object from a stale form would overwrite
    // a setting another member changed in the meantime.
    expect(onlyCall('PUT').body).toEqual({ retentionYears: 7 });
    expect(saved.retentionYears).toBe(7);
  });

  it('returns the audit report body as is, with no envelope to unwrap', async () => {
    const report = { generatedAt: '2026-03-31T00:00:00.000Z', accounts: [{ id: ACCOUNT_ID, bankBalanceCents: 99 }] };
    api.getExact(`${TRUST}/audit-report`, report);

    await expect(trustService.getAuditReport(LAW_FIRM_ID)).resolves.toEqual(report);
  });
});

describe('single transactions, client ledgers and balances', () => {
  it('GETs one transaction by id and unwraps it', async () => {
    api.getExact(`${TRUST}/transactions/${TRANSACTION_ID}`, {
      transaction: { id: TRANSACTION_ID, amountCents: SEVEN_THOUSAND },
    });

    const txn = await trustService.getTransaction(LAW_FIRM_ID, TRANSACTION_ID);

    expect(txn).toEqual({ id: TRANSACTION_ID, amountCents: SEVEN_THOUSAND });
  });

  it('passes client ledger paging through and the wrapper returns only the rows', async () => {
    api.getExact(`${TRUST}/clients/${CLIENT_ID}/ledger?limit=25&offset=50&order=desc`, {
      transactions: [{ id: 't9' }],
      totalItems: 76,
    });

    const rows = await trustService.getClientLedger(LAW_FIRM_ID, CLIENT_ID, { limit: 25, offset: 50, order: 'desc' });

    expect(rows).toEqual([{ id: 't9' }]);
  });

  it('defaults a client ledger with no envelope to an empty page', async () => {
    api.getExact(`${TRUST}/clients/${CLIENT_ID}/ledger`, {});

    await expect(trustService.getClientLedgerPaged(LAW_FIRM_ID, CLIENT_ID))
      .resolves.toEqual({ transactions: [], totalItems: 0 });
  });

  it('defaults a matter ledger with no envelope to an empty page', async () => {
    api.getExact(`${TRUST}/matters/${MATTER_ID}/ledger`, {});

    await expect(trustService.getMatterLedger(LAW_FIRM_ID, MATTER_ID))
      .resolves.toEqual({ transactions: [], totalItems: 0 });
  });

  it('returns the client balance body unchanged, cents intact', async () => {
    const balance = {
      clientId: CLIENT_ID,
      totalBalanceCents: 731901,
      accountBalances: [{ trustAccountId: ACCOUNT_ID, balanceCents: 731901 }],
    };
    api.getExact(`${TRUST}/clients/${CLIENT_ID}/balance`, balance);

    await expect(trustService.getClientBalance(LAW_FIRM_ID, CLIENT_ID)).resolves.toEqual(balance);
  });

  it('returns the account summary body unchanged', async () => {
    const summary = { accountId: ACCOUNT_ID, bookBalanceCents: 100, clientLedgerTotalCents: 100 };
    api.getExact(`${TRUST}/accounts/${ACCOUNT_ID}/summary`, summary);

    await expect(trustService.getAccountSummary(LAW_FIRM_ID, ACCOUNT_ID)).resolves.toEqual(summary);
  });

  it('returns every client balance from the balances report', async () => {
    const balances = [{ clientId: CLIENT_ID, trustAccountId: ACCOUNT_ID, balanceCents: 5 }];
    api.getExact(`${TRUST}/balances`, { balances });

    await expect(trustService.getAllBalances(LAW_FIRM_ID)).resolves.toEqual(balances);
  });
});

describe('reconciliations', () => {
  const REC = { id: 'rec-1', trustAccountId: ACCOUNT_ID, bankStatementBalanceCents: 1250075 };

  it('returns the created reconciliation unwrapped', async () => {
    api.postExact(`${TRUST}/reconciliations`, { reconciliation: REC });

    const created = await trustService.createReconciliation(LAW_FIRM_ID, {
      trustAccountId: ACCOUNT_ID,
      reconciliationDate: '2026-03-31',
      bankStatementBalanceCents: 1250075,
    });

    expect(created).toEqual(REC);
  });

  it('scopes the history to one account and passes the page window', async () => {
    api.getExact(`${TRUST}/reconciliations?trustAccountId=${ACCOUNT_ID}&limit=10&offset=0`, {
      reconciliations: [REC],
      totalItems: 31,
    });

    const page = await trustService.listReconciliationsPaged(LAW_FIRM_ID, ACCOUNT_ID, { limit: 10, offset: 0 });

    expect(page).toEqual({ reconciliations: [REC], totalItems: 31 });
  });

  it('sends no query for the unscoped history and the wrapper returns only rows', async () => {
    api.getExact(`${TRUST}/reconciliations`, { reconciliations: [REC] });

    const rows = await trustService.listReconciliations(LAW_FIRM_ID);

    expect(onlyCall('GET').search).toBe('');
    expect(rows).toEqual([REC]);
  });

  it('defaults a history with no envelope to an empty page', async () => {
    api.getExact(`${TRUST}/reconciliations`, {});

    await expect(trustService.listReconciliationsPaged(LAW_FIRM_ID))
      .resolves.toEqual({ reconciliations: [], totalItems: 0 });
  });

  it('returns the latest reconciliation for an account', async () => {
    api.getExact(`${TRUST}/reconciliations/latest?trustAccountId=${ACCOUNT_ID}`, { reconciliation: REC });

    await expect(trustService.getLatestReconciliation(LAW_FIRM_ID, ACCOUNT_ID)).resolves.toEqual(REC);
  });

  it('GETs one reconciliation by id', async () => {
    api.getExact(`${TRUST}/reconciliations/rec-1`, { reconciliation: REC });

    await expect(trustService.getReconciliation(LAW_FIRM_ID, 'rec-1')).resolves.toEqual(REC);
  });

  it('GETs the reconciliation snapshot for one account and returns the body as is', async () => {
    const snapshot = { trustAccountId: ACCOUNT_ID, bookBalanceCents: 1250075, clientLedgerTotalCents: 1250075 };
    api.getExact(`${TRUST}/reconciliation-snapshot?trustAccountId=${ACCOUNT_ID}`, snapshot);

    await expect(trustService.getReconciliationSnapshot(LAW_FIRM_ID, ACCOUNT_ID)).resolves.toEqual(snapshot);
  });
});

/**
 * Every method checks `response.ok` itself. When the server sends no `error`
 * text, the message the user reads is the method's own fallback, so each row
 * below pins that its OWN guard ran: deleting a guard makes the method try to
 * unwrap an error body and resolve, and swapping two methods' messages turns
 * the matching rows red.
 */
describe('a refusal with no server reason throws the method\'s own message', () => {
  type Row = [string, 'get' | 'post' | 'put' | 'patch' | 'delete', string, () => Promise<unknown>, string];
  const rows: Row[] = [
    ['createAccount', 'post', '/accounts', () => trustService.createAccount(LAW_FIRM_ID, { name: 'a', bankName: 'b', accountNumberLast4: '1' }), 'Failed to create trust account'],
    ['listAccounts', 'get', '/accounts', () => trustService.listAccounts(LAW_FIRM_ID), 'Failed to fetch trust accounts'],
    ['updateAccount', 'put', `/accounts/${ACCOUNT_ID}`, () => trustService.updateAccount(LAW_FIRM_ID, ACCOUNT_ID, {}), 'Failed to update trust account'],
    ['updateAccountStatus', 'patch', `/accounts/${ACCOUNT_ID}/status`, () => trustService.updateAccountStatus(LAW_FIRM_ID, ACCOUNT_ID, 'active'), 'Failed to update account status'],
    ['updateBookCloseDate', 'patch', `/accounts/${ACCOUNT_ID}/book-close`, () => trustService.updateBookCloseDate(LAW_FIRM_ID, ACCOUNT_ID, null), 'Failed to update book-close date'],
    ['listMinimumBalances', 'get', '/minimum-balances', () => trustService.listMinimumBalances(LAW_FIRM_ID), 'Failed to fetch minimum balances'],
    ['upsertMinimumBalance', 'put', '/minimum-balances', () => trustService.upsertMinimumBalance(LAW_FIRM_ID, { clientId: CLIENT_ID, trustAccountId: ACCOUNT_ID, minimumCents: 1 }), 'Failed to save minimum balance'],
    ['deleteMinimumBalance', 'delete', '/minimum-balances/min-1', () => trustService.deleteMinimumBalance(LAW_FIRM_ID, 'min-1'), 'Failed to remove minimum balance'],
    ['listRemittances', 'get', '/interest-remittances', () => trustService.listRemittances(LAW_FIRM_ID), 'Failed to fetch interest remittances'],
    ['createRemittance', 'post', '/interest-remittances', () => trustService.createRemittance(LAW_FIRM_ID, { trustAccountId: ACCOUNT_ID }), 'Failed to create interest remittance'],
    ['updateRemittance', 'put', '/interest-remittances/rem-1', () => trustService.updateRemittance(LAW_FIRM_ID, 'rem-1', { trustAccountId: ACCOUNT_ID }), 'Failed to update interest remittance'],
    ['deleteRemittance', 'delete', '/interest-remittances/rem-1', () => trustService.deleteRemittance(LAW_FIRM_ID, 'rem-1'), 'Failed to remove interest remittance'],
    ['getTrustSettings', 'get', '/settings', () => trustService.getTrustSettings(LAW_FIRM_ID), 'Failed to fetch trust settings'],
    ['updateTrustSettings', 'put', '/settings', () => trustService.updateTrustSettings(LAW_FIRM_ID, {}), 'Failed to update trust settings'],
    ['getAuditReport', 'get', '/audit-report', () => trustService.getAuditReport(LAW_FIRM_ID), 'Failed to fetch the trust audit report'],
    ['getMatterLedger', 'get', `/matters/${MATTER_ID}/ledger`, () => trustService.getMatterLedger(LAW_FIRM_ID, MATTER_ID), 'Failed to fetch matter ledger'],
    ['getMatterBalance', 'get', `/matters/${MATTER_ID}/balance`, () => trustService.getMatterBalance(LAW_FIRM_ID, MATTER_ID), 'Failed to fetch matter balance'],
    ['listTransactionsPaged', 'get', '/transactions', () => trustService.listTransactionsPaged(LAW_FIRM_ID), 'Failed to fetch transactions'],
    ['getTransaction', 'get', `/transactions/${TRANSACTION_ID}`, () => trustService.getTransaction(LAW_FIRM_ID, TRANSACTION_ID), 'Failed to fetch transaction'],
    ['voidTransaction', 'patch', `/transactions/${TRANSACTION_ID}/void`, () => trustService.voidTransaction(LAW_FIRM_ID, TRANSACTION_ID, { voidReason: 'x' }), 'Failed to void transaction'],
    ['getClientLedgerPaged', 'get', `/clients/${CLIENT_ID}/ledger`, () => trustService.getClientLedgerPaged(LAW_FIRM_ID, CLIENT_ID), 'Failed to fetch client ledger'],
    ['getClientBalance', 'get', `/clients/${CLIENT_ID}/balance`, () => trustService.getClientBalance(LAW_FIRM_ID, CLIENT_ID), 'Failed to fetch client balance'],
    ['getAllBalances', 'get', '/balances', () => trustService.getAllBalances(LAW_FIRM_ID), 'Failed to fetch balances'],
    ['getAccountSummary', 'get', `/accounts/${ACCOUNT_ID}/summary`, () => trustService.getAccountSummary(LAW_FIRM_ID, ACCOUNT_ID), 'Failed to fetch account summary'],
    ['createReconciliation', 'post', '/reconciliations', () => trustService.createReconciliation(LAW_FIRM_ID, { trustAccountId: ACCOUNT_ID, reconciliationDate: '2026-03-31', bankStatementBalanceCents: 0 }), 'Failed to create reconciliation'],
    ['listReconciliationsPaged', 'get', '/reconciliations', () => trustService.listReconciliationsPaged(LAW_FIRM_ID), 'Failed to fetch reconciliations'],
    ['getLatestReconciliation', 'get', '/reconciliations/latest', () => trustService.getLatestReconciliation(LAW_FIRM_ID, ACCOUNT_ID), 'Failed to fetch latest reconciliation'],
    ['getReconciliation', 'get', '/reconciliations/rec-1', () => trustService.getReconciliation(LAW_FIRM_ID, 'rec-1'), 'Failed to fetch reconciliation'],
    ['getReconciliationSnapshot', 'get', '/reconciliation-snapshot', () => trustService.getReconciliationSnapshot(LAW_FIRM_ID, ACCOUNT_ID), 'Failed to fetch reconciliation snapshot'],
  ];

  it.each(rows)('%s', async (_name, method, path, run, message) => {
    // 422 rather than 500 or 503: those statuses carry their own default copy
    // and a retry policy, and this row is about the method's fallback text.
    api[method](`${TRUST}${path}`, { status: 422, body: {} });

    const error = await run().then(
      () => { throw new Error('expected the call to reject'); },
      (e: unknown) => e as { message: string; status?: number; name: string },
    );

    expect(error.name).toBe('ApiError');
    expect(error.message).toBe(message);
    expect(error.status).toBe(422);
    expect(api.calls(method.toUpperCase())).toHaveLength(1);
  });
});
