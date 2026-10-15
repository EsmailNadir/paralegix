/**
 * GET /api/lawfirms/:lawFirmId/trust/audit-report across several accounts: the
 * figures it returns and how many pool connections it holds at once.
 *
 * The report reads four figures per trust account. Every request on an instance
 * shares one small pool (12 connections against a Supabase session pooler that
 * allows 15), so reading every account's four at the same moment would let one
 * firm with a handful of accounts take most of the pool. Accounts are read one
 * after another, and within an account the four reads run as two sequential
 * pairs, so the peak stays at two however many accounts the firm has.
 *
 * The peak is read from the app's own pool `acquire`/`release` events, so it
 * counts every checkout the request makes, including the auth and permission
 * middleware.
 *
 * All amounts are CENTS.
 */
import {
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { createTrustAccount, postTrustTxn } from '../support/trust';

// Loaded after the harness, which points DATABASE_URL at this worker's test
// database: `db.ts` reads the URL when it is first imported.
const { pool } = require('../../src/shared/database/db');

/**
 * One account's widest step: a pair of reads in flight together. The middleware
 * and the per-account loop are sequential, so nothing else adds to this.
 */
const MAX_CONNECTIONS_PER_AUDIT_REPORT = 2;

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const F = () => `/api/lawfirms/${firm.id}/trust`;

const createAccount = (name: string, last4: string) => createTrustAccount(owner, firm.id, { name, last4 });

async function post(account: string, type: string, amountCents: number, clientRec: ClientRecord) {
  const res = await postTrustTxn(owner, firm.id, { trustAccountId: account, clientId: clientRec.id, type, amountCents });
  expect(res.status).toBe(201);
}

async function peakConnectionsDuring(work: () => Promise<any>) {
  let active = 0;
  let peak = 0;
  const onAcquire = () => { active += 1; peak = Math.max(peak, active); };
  const onRelease = () => { active -= 1; };
  pool.on('acquire', onAcquire);
  pool.on('release', onRelease);
  try {
    const result = await work();
    return { result, peak };
  } finally {
    pool.off('acquire', onAcquire);
    pool.off('release', onRelease);
  }
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Trust Client' });
});

describe('the audit report over several accounts', () => {
  it('returns every account with its own figures', async () => {
    const first = await createAccount('A Operating Trust', '1111');
    const second = await createAccount('B Pooled IOLTA', '2222');
    const third = await createAccount('C Escrow', '3333');
    const other = await createPersonClient(firm.id, { name: 'Second Client' });
    await post(first, 'deposit', 100_000, client);
    await post(second, 'deposit', 40_000, client);
    await post(second, 'deposit', 25_000, other);
    await post(third, 'deposit', 90_000, client);
    await post(third, 'withdrawal', 15_000, client);

    const res = await owner.api.get(`${F()}/audit-report`);

    expect(res.status).toBe(200);
    // `findAll` has no ORDER BY, and every deposit rewrites the account row, so
    // the row order is whatever the table scan returns. Match rows by id.
    expect(res.body.accounts.map((x: any) => x.trustAccountId).sort())
      .toEqual([first, second, third].sort());
    const row = (id: string) => res.body.accounts.find((x: any) => x.trustAccountId === id);
    const [a, b, c] = [row(first), row(second), row(third)];
    // Each row carries its own account's figures. Reading the accounts in a
    // different way must not let one account's figures land on another's row.
    expect([a.bookBalanceCents, a.ledgerBalanceCents, a.clientLedgerTotalCents])
      .toEqual([100_000, 100_000, 100_000]);
    expect([b.bookBalanceCents, b.ledgerBalanceCents, b.clientLedgerTotalCents])
      .toEqual([65_000, 65_000, 65_000]);
    expect([c.bookBalanceCents, c.ledgerBalanceCents, c.clientLedgerTotalCents])
      .toEqual([75_000, 75_000, 75_000]);
    expect(b.clientBalances.map((x: any) => [x.clientId, x.balanceCents])
      .sort((x: any, y: any) => x[1] - y[1])).toEqual([[other.id, 25_000], [client.id, 40_000]]);
    expect(c.outstandingCount).toBe(2);
    expect(c.outstandingNetCents).toBe(75_000);
    expect([a.balanced, b.balanced, c.balanced]).toEqual([true, true, true]);
    expect(res.body.totals).toEqual({
      bookBalanceCents: 240_000, clientLedgerTotalCents: 240_000, balanced: true,
    });
  });
});

describe('audit report connection use', () => {
  it('holds no more than one pair of reads at once, whatever the account count', async () => {
    const accounts = [
      await createAccount('A Operating Trust', '1111'),
      await createAccount('B Pooled IOLTA', '2222'),
      await createAccount('C Escrow', '3333'),
    ];
    for (const account of accounts) {
      // eslint-disable-next-line no-await-in-loop
      await post(account, 'deposit', 10_000, client);
    }

    const { result, peak } = await peakConnectionsDuring(() => owner.api
      .get(`${F()}/audit-report`));

    expect(result.status).toBe(200);
    expect(result.body.accounts).toHaveLength(3);
    // Proves the listener saw the request check connections out at all, so a
    // peak within the cap below is a real measurement rather than a detached
    // pool that never fired an event.
    expect(peak).toBeGreaterThanOrEqual(1);
    // Four reads in flight per account would be four; three accounts read at
    // once would be twelve, against a pool of twelve.
    expect(peak).toBeLessThanOrEqual(MAX_CONNECTIONS_PER_AUDIT_REPORT);
  });
});
