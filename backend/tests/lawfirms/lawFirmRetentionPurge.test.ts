/**
 * B11.1 row 6: the housekeeping pass is the only path that turns a pending
 * firm deletion into a hard delete.  A retention window must therefore be a
 * real gate, and an otherwise-due firm with permanent trust history must stay
 * pending for later operator review rather than partially cascading away.
 */
import {
  createFirm,
  createPersonClient,
  drainEvents,
  ownerOf,
  setRetentionWindow,
  testPool,
} from '../support/setupInProcess';
import { firmRow } from '../support/rows';

const { admin } = require('../../src/shared/database/firebase');
const lawfirmsService = require('../../src/modules/lawfirms/lawfirms.service');

let originalStorage: any;
let deleteFiles: jest.Mock;

beforeEach(() => {
  // Hard-purge is allowed to reach the storage cleanup here.  The normal
  // harness bucket deliberately throws on every operation, which would test
  // only its safety rail instead of the database retention decision.
  originalStorage = admin.storage;
  deleteFiles = jest.fn().mockResolvedValue(undefined);
  admin.storage = () => ({
    bucket: () => ({
      deleteFiles,
      // LAWFIRM_DELETED listeners independently list their prefixes. The
      // empty listing models a firm with no remaining objects and lets this
      // spec assert the scheduler path without noisy best-effort failures.
      getFiles: jest.fn().mockResolvedValue([[], null]),
    }),
  });
});

afterEach(() => {
  admin.storage = originalStorage;
});

describe('B11.1: firm retention purge blocked by legal hold', () => {
  it('leaves a firm with a held matter pending across a retry, then purges it once the hold lifts', async () => {
    const held = await createFirm({ name: 'Retention legal-hold matter firm' });
    const owner = await ownerOf(held.id);

    const matterRes = await owner.api.post(`/api/lawfirms/${held.id}/matters`).send({ name: 'Held matter' });
    expect(matterRes.status).toBe(201);
    const matterId = matterRes.body.matterId as string;

    const hold = await owner.api.patch(`/api/lawfirms/${held.id}/matters/${matterId}/legal-hold`)
      .send({ legalHold: true, reason: 'Active litigation' });
    expect(hold.status).toBe(200);

    await setRetentionWindow(held.id, '-1 minute');

    const first = await lawfirmsService.purgeEligibleFirms();
    // The direct matter-delete route already refuses this matter (see
    // matters.test.ts, "BLOCKS deletion while the hold is on"). The firm-level
    // purge is a separate destruction path -- a straight `delete from
    // law_firms` cascade, not a call through that route -- so it needs its own
    // check to honor the same hold instead of silently destroying it.
    expect(first).toEqual({ purged: 0, blockedByLegalHold: 1, blockedByTrustLedger: 0, failed: 0 });
    expect(await firmRow(held.id)).toMatchObject({ id: held.id });
    const { rows: survivingMatter } = await testPool.query('select id from matters where id = $1', [matterId]);
    expect(survivingMatter).toEqual([{ id: matterId }]);

    const lift = await owner.api.patch(`/api/lawfirms/${held.id}/matters/${matterId}/legal-hold`)
      .send({ legalHold: false });
    expect(lift.status).toBe(200);

    const second = await lawfirmsService.purgeEligibleFirms();
    expect(second).toEqual({ purged: 1, blockedByLegalHold: 0, blockedByTrustLedger: 0, failed: 0 });
    expect(await firmRow(held.id)).toBeNull();
  });

  it('leaves a firm with a held client pending, independent of any matter', async () => {
    const held = await createFirm({ name: 'Retention legal-hold client firm' });
    const client = await createPersonClient(held.id, { name: 'Held client' });
    // No route places a hold on a CLIENT (matters have one; clients do not), so
    // this writes the `legal_holds` row directly, as an operator action would
    // have to, to characterize what the purge gate does with it.
    await testPool.query(`insert into legal_holds (law_firm_id, client_id, reason)
       select law_firm_id, id, 'fixture hold' from clients where id = $1`, [client.id]);

    await setRetentionWindow(held.id, '-1 minute');

    const result = await lawfirmsService.purgeEligibleFirms();
    expect(result).toEqual({ purged: 0, blockedByLegalHold: 1, blockedByTrustLedger: 0, failed: 0 });
    expect(await firmRow(held.id)).toMatchObject({ id: held.id });
    const { rows: survivingClient } = await testPool.query('select id from clients where id = $1', [client.id]);
    expect(survivingClient).toEqual([{ id: client.id }]);
  });
});

describe('B11.1: firm retention purge', () => {
  it('purges only a firm past its retention cutoff and leaves the due trust-ledger firm pending across a retry', async () => {
    const cleanDue = await createFirm({ name: 'Retention clean due firm' });
    const retainedFuture = await createFirm({ name: 'Retention future firm' });
    const trustProtected = await createFirm({ name: 'Retention trust protected firm' });
    const owner = await ownerOf(trustProtected.id);
    const client = await createPersonClient(trustProtected.id, { name: 'Protected trust client' });

    const account = await owner.api.post(`/api/lawfirms/${trustProtected.id}/trust/accounts`).send({
      name: 'Protected IOLTA', accountType: 'iolta', bankName: 'Test Bank', accountNumberLast4: '1234',
    });
    expect(account.status).toBe(201);
    const transaction = await owner.api.post(`/api/lawfirms/${trustProtected.id}/trust/transactions`).send({
      trustAccountId: account.body.account.id,
      type: 'deposit', amountCents: 50_000, clientId: client.id,
      clientName: 'Protected trust client', date: '2026-08-31',
    });
    expect(transaction.status).toBe(201);
    await drainEvents();

    await setRetentionWindow(cleanDue.id, '-1 minute');
    await setRetentionWindow(retainedFuture.id, '1 day');
    await setRetentionWindow(trustProtected.id, '-1 minute');

    const first = await lawfirmsService.purgeEligibleFirms();

    expect(first).toEqual({ purged: 1, blockedByLegalHold: 0, blockedByTrustLedger: 1, failed: 0 });
    expect(await firmRow(cleanDue.id)).toBeNull();
    expect(deleteFiles).toHaveBeenCalledWith({ prefix: `lawfirmids/${cleanDue.id}/`, force: true });

    // A future cutoff must remain a true retention boundary, not merely a
    // marker that the daily pass ignores once pending_deletion_at is set.
    expect(await firmRow(retainedFuture.id)).toMatchObject({ id: retainedFuture.id });

    // The protected firm is still a complete, pending workspace: the retry
    // must neither erase its row nor make a second cleanup attempt appear to
    // have succeeded after the first conflict.
    expect(await firmRow(trustProtected.id)).toMatchObject({ id: trustProtected.id });
    const { rows: ledger } = await testPool.query(
      `select id, amount_cents, status from trust_transactions
        where id = $1 and law_firm_id = $2`,
      [transaction.body.transaction.id, trustProtected.id],
    );
    expect(ledger).toEqual([{
      id: transaction.body.transaction.id,
      amount_cents: '50000',
      status: 'completed',
    }]);

    const retry = await lawfirmsService.purgeEligibleFirms();
    expect(retry).toEqual({ purged: 0, blockedByLegalHold: 0, blockedByTrustLedger: 1, failed: 0 });
    expect(await firmRow(trustProtected.id)).toMatchObject({ id: trustProtected.id });
    expect(deleteFiles).toHaveBeenCalledTimes(1);
  });
});
