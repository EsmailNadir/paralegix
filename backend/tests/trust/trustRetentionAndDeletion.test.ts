/**
 * What actually happens today when someone tries to destroy a client or a
 * matter that trust money ever touched.
 *
 * There is no legal-hold, retention, or destruction concept ON the trust
 * tables themselves (`trust_accounts`, `trust_transactions`,
 * `trust_reconciliations`, `trust_minimum_balances` carry no `legal_hold`
 * column, and there is no DELETE route for a trust account at all -- only a
 * status flip to `inactive`, covered by trustAccountsOps.test.ts). What DOES
 * exist, and is exercised here, is real: `clients.service.removeClient` and
 * `matters.service.assertMatterIsDeletable` both explicitly refuse to delete
 * a record with trust ledger activity, because `trust_transactions` is
 * append-only and its `client_id`/`matter_id` reference the parent with no
 * cascade. Both guards run in this order: legal hold, then trust activity,
 * then billing records.
 *
 * A legal hold DOES exist, as a `legal_holds` row keyed to a matter, client or
 * file (migration 0221; before that it was four copied columns on each of those
 * three tables). A `before delete` trigger on `matters` and `clients` refuses
 * while an unreleased hold exists, and the services keep their own checks so the
 * caller gets a sentence rather than a constraint violation.
 *
 * Matters have a full route to place and lift one (`PATCH
 * .../matters/:id/legal-hold`). Clients do not: nothing in `clients.routes.ts`
 * or anywhere else places a client hold, and `updateClient` does not accept it
 * as a field. That gap is recorded as a functionality question rather than
 * "fixed" here; this file writes the row directly (as an operator action would
 * have to) to characterize what the read and delete sides do with it.
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
import { createTrustAccount, postTrustTxn } from '../support/trust';

let firm: Firm;
let owner: Actor;

const TRUST = () => `/api/lawfirms/${firm.id}/trust`;
const CLIENTS = () => `/api/lawfirms/${firm.id}/clients`;
const MATTERS = () => `/api/lawfirms/${firm.id}/matters`;

const createAccount = (name: string, last4: string) => createTrustAccount(owner, firm.id, { name, last4 });

async function depositFor(accountId: string, clientRec: ClientRecord, extra: Record<string, unknown> = {}) {
  const res = await postTrustTxn(owner, firm.id, {
    trustAccountId: accountId, clientId: clientRec.id, type: 'deposit', amountCents: 50_000, ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.transaction.id as string;
}

async function createMatter(clientRec: ClientRecord, name = 'Trust Matter') {
  const res = await owner.api.post(MATTERS()).send({
    name, clients: [{ clientId: clientRec.id, name: 'Trust Client' }],
  });
  expect(res.status).toBe(201);
  return res.body.matterId as string;
}

async function clientRow(id: string) {
  const { rows } = await testPool.query('select * from clients where id = $1', [id]);
  return rows[0] || null;
}

async function matterRow(id: string) {
  const { rows } = await testPool.query('select * from matters where id = $1', [id]);
  return rows[0] || null;
}

async function txnRow(id: string) {
  const { rows } = await testPool.query('select * from trust_transactions where id = $1', [id]);
  return rows[0];
}

/**
 * A hold is a `legal_holds` row since migration 0221, not a column on the client.
 * Releasing one keeps the row and stamps `released_at`, because which evidence
 * was held and for how long is itself the record a hold exists to produce.
 */
async function setClientLegalHold(clientId: string, on: boolean) {
  if (on) {
    await testPool.query(
      `insert into legal_holds (law_firm_id, client_id, reason)
       select law_firm_id, id, 'litigation hold' from clients where id = $1`,
      [clientId],
    );
    return;
  }
  await testPool.query(
    'update legal_holds set released_at = now() where client_id = $1 and released_at is null',
    [clientId],
  );
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

describe('a client with trust ledger activity cannot be deleted', () => {
  it('refuses with 409 CONFLICT and leaves the client, account, and ledger row untouched', async () => {
    const client = await createPersonClient(firm.id, { name: 'Trust Client' });
    const accountId = await createAccount('Primary IOLTA', '1111');
    const depositId = await depositFor(accountId, client);

    const res = await owner.api.delete(`${CLIENTS()}/${client.id}`);

    expect(res.status).toBe(409);
    expect(await clientRow(client.id)).not.toBeNull();
    expect(await txnRow(depositId)).not.toBeUndefined();
    const { rows } = await testPool.query(
      'select book_balance_cents from trust_accounts where id = $1', [accountId],
    );
    // The refusal has to be a no-op on the money too, not just on the client row.
    expect(Number(rows[0].book_balance_cents)).toBe(50_000);
  });

  it('still refuses when the only trust activity is a VOIDED entry', async () => {
    // Voiding does not erase the historical row (trustVoidAndReconciliation.test.ts
    // covers that directly). This proves the deletion guard reads it the same
    // way: a client cannot be freed for deletion by voiding away their only
    // trust activity, because the append-only history still exists.
    const client = await createPersonClient(firm.id, { name: 'Trust Client' });
    const accountId = await createAccount('Primary IOLTA', '1111');
    const depositId = await depositFor(accountId, client);
    const voidRes = await owner.api.patch(`${TRUST()}/transactions/${depositId}/void`).send({ voidReason: 'test' });
    expect(voidRes.status).toBe(200);

    const res = await owner.api.delete(`${CLIENTS()}/${client.id}`);

    expect(res.status).toBe(409);
    expect(await clientRow(client.id)).not.toBeNull();
  });

  it('deletes cleanly when the client has no trust activity at all (control)', async () => {
    const client = await createPersonClient(firm.id, { name: 'Clean Client' });

    const res = await owner.api.delete(`${CLIENTS()}/${client.id}`);

    expect(res.status).toBe(200);
    expect(await clientRow(client.id)).toBeNull();
  });
});

/**
 * `trust_minimum_balances` holds the firm's evergreen-retainer replenishment
 * threshold for a client. Its foreign key to `clients` was `cascade` until
 * migration 0225, so deleting the client silently took the threshold with it and
 * nothing checked for one. The key is now `restrict`, which without a matching
 * pre-check would surface as a raw 500 from inside `deleteClientCascade`.
 *
 * RED IF: the pre-check is removed (500 instead of 409), the key is loosened
 * back to `cascade` (200, and the threshold gone), or the message is folded back
 * into the ledger one, which would tell a firm its records are permanent when in
 * fact they can remove the threshold and try again.
 */
/**
 * A `billing_plans` row is the client's recurring or flat-fee arrangement.
 * `countBillingRecords` looked at invoices, time entries, flat fees and expenses
 * but never at billing plans, while the foreign key was `cascade`, so deleting
 * the client destroyed the arrangement with no warning. Migration 0225 made the
 * key `restrict` and the pre-check now counts them.
 *
 * RED IF: the billing_plans term is dropped from `countBillingRecords` (a 500
 * from the constraint), or the key is loosened back to `cascade` (a 200, and the
 * plan gone).
 */
describe('a client with a billing plan cannot be deleted', () => {
  it('refuses with 409 CONFLICT and keeps the plan', async () => {
    const client = await createPersonClient(firm.id, { name: 'Plan Client' });
    const planId = randomUUID();
    await testPool.query(
      `insert into billing_plans (id, law_firm_id, client_id, name, plan_type, amount_cents)
       values ($1, $2, $3, 'Monthly retainer', 'retainer', 250000)`,
      [planId, firm.id, client.id],
    );

    const res = await owner.api.delete(`${CLIENTS()}/${client.id}`);

    expect(res.status).toBe(409);
    expect(await clientRow(client.id)).not.toBeNull();
    const { rows } = await testPool.query('select 1 from billing_plans where id = $1', [planId]);
    expect(rows).toHaveLength(1);
  });
});

describe('a client with a trust minimum balance cannot be deleted', () => {
  async function setMinimumBalance(accountId: string, clientId: string) {
    await testPool.query(
      `insert into trust_minimum_balances (law_firm_id, trust_account_id, client_id, minimum_cents)
       values ($1, $2, $3, 100000)`,
      [firm.id, accountId, clientId],
    );
  }

  it('refuses with 409 CONFLICT and keeps both the client and the threshold', async () => {
    const client = await createPersonClient(firm.id, { name: 'Retainer Client' });
    const accountId = await createAccount('Primary IOLTA', '2222');
    await setMinimumBalance(accountId, client.id);

    const res = await owner.api.delete(`${CLIENTS()}/${client.id}`);

    expect(res.status).toBe(409);
    // The message has to name the threshold, because unlike a ledger entry the
    // firm CAN remove it and retry.
    expect(res.body.error).toMatch(/minimum balance/i);
    expect(await clientRow(client.id)).not.toBeNull();
    const { rows } = await testPool.query(
      'select 1 from trust_minimum_balances where client_id = $1', [client.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('deletes once the threshold is removed (control proving the threshold was the blocker)', async () => {
    const client = await createPersonClient(firm.id, { name: 'Retainer Client' });
    const accountId = await createAccount('Primary IOLTA', '3333');
    await setMinimumBalance(accountId, client.id);
    expect((await owner.api.delete(`${CLIENTS()}/${client.id}`)).status).toBe(409);

    await testPool.query('delete from trust_minimum_balances where client_id = $1', [client.id]);
    const res = await owner.api.delete(`${CLIENTS()}/${client.id}`);

    expect(res.status).toBe(200);
    expect(await clientRow(client.id)).toBeNull();
  });
});

describe('a matter with trust ledger activity cannot be deleted', () => {
  it('refuses with 409 CONFLICT and leaves the matter and the transaction link intact', async () => {
    const client = await createPersonClient(firm.id, { name: 'Trust Client' });
    const matterId = await createMatter(client);
    const accountId = await createAccount('Primary IOLTA', '1111');
    const depositId = await depositFor(accountId, client, { matterId, matterName: 'Trust Matter' });

    const res = await owner.api.delete(`${MATTERS()}/${matterId}`);

    expect(res.status).toBe(409);
    expect(await matterRow(matterId)).not.toBeNull();
    // Not just "the matter survives" -- the LINK from the permanent ledger
    // entry back to it survives too. A guard that deleted the matter and let
    // the FK `on delete set null` sever the link would still show a matter
    // row gone, which the assertion above alone would miss if it read the
    // wrong table; reading matter_id off the transaction directly closes that.
    expect((await txnRow(depositId)).matter_id).toBe(matterId);
  });

  it('deletes cleanly when the matter has no trust activity at all (control)', async () => {
    const client = await createPersonClient(firm.id, { name: 'Clean Client' });
    const matterId = await createMatter(client, 'Clean Matter');

    const res = await owner.api.delete(`${MATTERS()}/${matterId}`);

    expect(res.status).toBe(200);
    expect(await matterRow(matterId)).toBeNull();
  });
});

describe('a matter under litigation hold cannot be deleted, trust activity or not', () => {
  it('refuses with 403 FORBIDDEN even with no trust activity, and lifting the hold allows the delete', async () => {
    const client = await createPersonClient(firm.id, { name: 'Clean Client' });
    const matterId = await createMatter(client, 'Held Matter');

    const hold = await owner.api.patch(`${MATTERS()}/${matterId}/legal-hold`).send({
      legalHold: true, reason: 'Active litigation',
    });
    expect(hold.status).toBe(200);

    const blocked = await owner.api.delete(`${MATTERS()}/${matterId}`);
    expect(blocked.status).toBe(403);
    expect(await matterRow(matterId)).not.toBeNull();

    const lift = await owner.api.patch(`${MATTERS()}/${matterId}/legal-hold`).send({ legalHold: false });
    expect(lift.status).toBe(200);

    const nowDeletable = await owner.api.delete(`${MATTERS()}/${matterId}`);
    expect(nowDeletable.status).toBe(200);
  });
});

describe('a client under legal hold cannot be deleted, checked before the trust-activity guard', () => {
  it('refuses with 403 FORBIDDEN even with no trust activity at all', async () => {
    // No API route ever sets clients.legal_hold (see the file header) -- this
    // sets it the only way currently possible, to characterize the READ side,
    // which removeClient does consult.
    const client = await createPersonClient(firm.id, { name: 'Held Client' });
    await setClientLegalHold(client.id, true);

    const res = await owner.api.delete(`${CLIENTS()}/${client.id}`);

    // FORBIDDEN (legal hold), not CONFLICT (trust activity) -- there is no
    // trust activity here at all, so a 409 here would mean the wrong guard
    // fired, or the legal-hold check was skipped entirely.
    expect(res.status).toBe(403);
    expect(await clientRow(client.id)).not.toBeNull();
  });

  it('lifting the hold restores normal deletion (control proving the hold, not something else, was blocking it)', async () => {
    const client = await createPersonClient(firm.id, { name: 'Held Client' });
    await setClientLegalHold(client.id, true);
    const blocked = await owner.api.delete(`${CLIENTS()}/${client.id}`);
    expect(blocked.status).toBe(403);

    await setClientLegalHold(client.id, false);
    const res = await owner.api.delete(`${CLIENTS()}/${client.id}`);

    expect(res.status).toBe(200);
    expect(await clientRow(client.id)).toBeNull();
  });
});

describe('cross-firm isolation on the deletion guards', () => {
  it('does not let a different firm delete or even see this client through the same route shape', async () => {
    const client = await createPersonClient(firm.id, { name: 'Trust Client' });
    const accountId = await createAccount('Primary IOLTA', '1111');
    await depositFor(accountId, client);

    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api.delete(`/api/lawfirms/${otherFirm.id}/clients/${client.id}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await clientRow(client.id)).not.toBeNull();
  });
});
