import { createFirm, createPersonClient, ownerOf, testPool } from '../support/setupInProcess';
import { createTrustAccount, postTrustTxn } from '../support/trust';
import { gateMethod } from '../support/gate';

const settingsRepo = require('../../src/modules/settings/settings.repository');
const { trustTxnRepo } = require('../../src/modules/trust/trust.repository');

it.each(['deposit', 'void'] as const)('refuses a %s that would restore funds after trust accounting is disabled', async (operation) => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id);
  const account = await createTrustAccount(owner, firm.id);
  let withdrawalId: string | undefined;
  if (operation === 'void') {
    const first = await postTrustTxn(owner, firm.id, { trustAccountId: account, clientId: client.id, type: 'deposit', amountCents: 10001 });
    expect(first.status).toBe(201);
    const withdrawal = await postTrustTxn(owner, firm.id, { trustAccountId: account, clientId: client.id, type: 'withdrawal', amountCents: 10001 });
    expect(withdrawal.status).toBe(201);
    withdrawalId = withdrawal.body.transaction.id;
  }
  const toggle = gateMethod(settingsRepo, 'updateFirmSettings');
  const deposit = gateMethod(trustTxnRepo, operation === 'deposit' ? '_createWithBalanceTx' : '_voidWithBalanceTx');
  async function disable() {
    return owner.api.put(`/api/lawfirms/${firm.id}/settings/features/trustAccounting`).send({ enabled: false });
  }
  async function credit() {
    return operation === 'deposit'
      ? postTrustTxn(owner, firm.id, { trustAccountId: account, clientId: client.id, type: 'deposit', amountCents: 10001 })
      : owner.api.patch(`/api/lawfirms/${firm.id}/trust/transactions/${withdrawalId}/void`).send({ voidReason: 'Restore disbursement' });
  }
  const disabling = disable();
  let crediting: ReturnType<typeof credit> | undefined;
  try {
    await toggle.arrived(1);
    crediting = credit();
    await deposit.arrived(1);
    expect(toggle.waiting()).toBe(1);
    expect(deposit.waiting()).toBe(1);
    toggle.open();
    expect((await disabling).status).toBe(200);
    deposit.open();
    const result = await crediting;
    expect(result.status).toBe(403);
    const { rows } = await testPool.query(
      `select book_balance_cents, (select count(*) from trust_transactions where trust_account_id = $1) as entries
       from trust_accounts where id = $1`, [account],
    );
    expect(Number(rows[0].book_balance_cents)).toBe(0);
    expect(Number(rows[0].entries)).toBe(operation === 'deposit' ? 0 : 2);
  } finally {
    toggle.restore(); deposit.restore();
    await Promise.allSettled([disabling, ...(crediting ? [crediting] : [])]);
  }
});


it('refuses disable after waiting for an in-flight deposit to commit', async () => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id);
  const account = await createTrustAccount(owner, firm.id);
  let written!: () => void;
  const depositWritten = new Promise<void>(resolve => { written = resolve; });
  let release!: () => void;
  const commitAllowed = new Promise<void>(resolve => { release = resolve; });
  const original = trustTxnRepo._createWithBalanceTx;
  const spy = jest.spyOn(trustTxnRepo, '_createWithBalanceTx').mockImplementation(async (...args: any[]) => {
    const result = await original.apply(trustTxnRepo, args);
    written();
    await commitAllowed;
    return result;
  });
  async function credit() {
    return postTrustTxn(owner, firm.id, { trustAccountId: account, clientId: client.id, type: 'deposit', amountCents: 10001 });
  }
  async function disable() {
    return owner.api.put(`/api/lawfirms/${firm.id}/settings/features/trustAccounting`).send({ enabled: false });
  }
  const depositing = credit();
  let disabling: ReturnType<typeof disable> | undefined;
  try {
    await depositWritten;
    let settled = false;
    disabling = disable().then(result => { settled = true; return result; });
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (!waiting && !settled && Date.now() < deadline) {
      const { rows } = await testPool.query(`select 1 from pg_stat_activity where datname = current_database()
        and wait_event_type = 'Lock' and (query ilike '%trust_accounts%' or query ilike '%law_firms%')`);
      waiting = rows.length > 0;
      if (!waiting && !settled) await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(waiting || settled).toBe(true);
    release();
    expect((await depositing).status).toBe(201);
    expect((await disabling).status).toBe(400);
    const { rows } = await testPool.query(`select book_balance_cents from trust_accounts where id = $1`, [account]);
    expect(Number(rows[0].book_balance_cents)).toBe(10001);
    const { rows: firms } = await testPool.query(`select settings from law_firms where id = $1`, [firm.id]);
    expect(firms[0].settings?.features?.trustAccounting).not.toBe(false);
  } finally {
    release();
    spy.mockRestore();
    await Promise.allSettled([depositing, ...(disabling ? [disabling] : [])]);
  }
});


it('refuses a deposit into an account created while disable is pending', async () => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id);
  const toggle = gateMethod(settingsRepo, 'updateFirmSettings');
  async function disable() {
    return owner.api.put(`/api/lawfirms/${firm.id}/settings/features/trustAccounting`).send({ enabled: false });
  }
  const disabling = disable();
  try {
    await toggle.arrived(1);
    const account = await createTrustAccount(owner, firm.id);
    const deposit = await postTrustTxn(owner, firm.id, { trustAccountId: account, clientId: client.id, type: 'deposit', amountCents: 10001 });
    expect(deposit.status).toBe(201);
    toggle.open();
    expect((await disabling).status).toBe(400);
    const { rows } = await testPool.query('select book_balance_cents from trust_accounts where id = $1', [account]);
    expect(Number(rows[0].book_balance_cents)).toBe(10001);
    const { rows: firms } = await testPool.query('select settings from law_firms where id = $1', [firm.id]);
    expect(firms[0].settings?.features?.trustAccounting).not.toBe(false);
  } finally { toggle.restore(); await Promise.allSettled([disabling]); }
});
