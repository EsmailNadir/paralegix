/**
 * The firm-facing feature opt-out: PUT /api/lawfirms/:id/settings/features/:feature.
 *
 * This is the WRITER for `settings.features`, the half of the feature gate that
 * `featureCheck.isFeatureEnabled` has always honored but that nothing could set.
 * The firm-settings PUT deliberately drops `features` (WRITABLE_FIRM_KEYS), so
 * before this route the opt-out was reachable only by editing the jsonb by hand.
 *
 * What has to break for each case here to go red is named per test. The one that
 * matters most is the round trip: the cases below do not assert on the stored
 * jsonb, they assert that a REAL trust route changes its answer, because storing
 * the flag and having the gate ignore it is the exact failure this route exists
 * to prevent.
 */
import {
  testPool,
  createFirm,
  createPersonClient,
  createTrustDeposit,
  ownerOf,
  memberWith,
} from '../support/setupInProcess';

/**
 * Put the firm on Professional with unambiguously active billing.
 *
 * Trust accounting is a Professional feature, so every case here needs the plan
 * ceiling OPEN: a starter firm is refused by the plan whatever the opt-out says,
 * which would make an opt-out test pass for the wrong reason. Billing is set
 * explicitly rather than left on `createFirm`'s `comped` default so a refusal
 * can never be the billing gate firing instead of the feature one.
 */
async function professionalFirm() {
  const firm = await createFirm({ planId: 'professional' });
  await testPool.query(
    `update law_firms set plan_id = 'professional', plan = $2::jsonb where id = $1`,
    [firm.id, JSON.stringify({ planId: 'professional', billingStatus: 'active' })],
  );
  return firm;
}

/** The stored opt-out leaf, read straight from the jsonb. */
async function storedOptOut(lawFirmId: string, feature: string) {
  const { rows } = await testPool.query(
    `select settings -> 'features' -> $2 as value from law_firms where id = $1`,
    [lawFirmId, feature],
  );
  return rows[0]?.value;
}

const toggleUrl = (firmId: string, feature: string) =>
  `/api/lawfirms/${firmId}/settings/features/${feature}`;

describe('PUT /settings/features/:feature', () => {
  describe('switching trust accounting off', () => {
    it('closes the trust routes that were open a moment earlier', async () => {
      const firm = await professionalFirm();
      const owner = await ownerOf(firm.id);

      // Prove the route is genuinely open first. Without this the 403 below
      // could just as easily mean the fixture never had the feature at all.
      const before = await owner.api.get(`/api/lawfirms/${firm.id}/trust/accounts`);
      expect(before.status).toBe(200);

      const res = await owner.api.put(toggleUrl(firm.id, 'trustAccounting'))
        .send({ enabled: false });
      expect(res.status).toBe(200);

      const after = await owner.api.get(`/api/lawfirms/${firm.id}/trust/accounts`);
      expect(after.status).toBe(403);
      expect(after.body.code).toBe('FORBIDDEN');
      expect(after.body.error).toMatch(/trust accounting/i);
    });

    it('stores false rather than removing the key, which is what the gate reads', async () => {
      const firm = await professionalFirm();
      const owner = await ownerOf(firm.id);

      await owner.api.put(toggleUrl(firm.id, 'trustAccounting')).send({ enabled: false });

      // `isFeatureEnabled` subtracts on an explicit `=== false` and ignores
      // everything else, so a null/absent leaf here would leave trust enabled.
      expect(await storedOptOut(firm.id, 'trustAccounting')).toBe(false);
    });

    it('also closes the Stripe trust routes, which mount outside the trust router', async () => {
      const firm = await professionalFirm();
      const owner = await ownerOf(firm.id);
      const client = await createPersonClient(firm.id);
      const { accountId, transactionId } = await createTrustDeposit(firm.id, client.id);
      // The account has to exist for the route to name one, but it must hold
      // nothing, or the held-funds guard refuses the toggle and this case would
      // pass for the wrong reason.
      await testPool.query(
        `update trust_transactions set status = 'void' where id = $1`,
        [transactionId],
      );

      const disable = await owner.api.put(toggleUrl(firm.id, 'trustAccounting'))
        .send({ enabled: false });
      expect(disable.status).toBe(200);

      // These live under /api/stripe, so the app.ts mount gate never sees them.
      // They carry their own requireFeature; without it a firm that switched
      // trust off could still onboard an IOLTA bank account.
      const status = await owner.api.get(
        `/api/stripe/trust-connect/${firm.id}/${accountId}/status`,
      );
      expect(status.status).toBe(403);
      expect(status.body.code).toBe('FORBIDDEN');
    });
  });

  describe('switching trust accounting back on', () => {
    it('reopens the trust routes', async () => {
      const firm = await professionalFirm();
      const owner = await ownerOf(firm.id);

      await owner.api.put(toggleUrl(firm.id, 'trustAccounting')).send({ enabled: false });
      expect((await owner.api.get(`/api/lawfirms/${firm.id}/trust/accounts`)).status).toBe(403);

      const res = await owner.api.put(toggleUrl(firm.id, 'trustAccounting'))
        .send({ enabled: true });
      expect(res.status).toBe(200);

      expect((await owner.api.get(`/api/lawfirms/${firm.id}/trust/accounts`)).status).toBe(200);
    });

    it('removes the opt-out leaf instead of storing true', async () => {
      const firm = await professionalFirm();
      const owner = await ownerOf(firm.id);

      await owner.api.put(toggleUrl(firm.id, 'trustAccounting')).send({ enabled: false });
      await owner.api.put(toggleUrl(firm.id, 'trustAccounting')).send({ enabled: true });

      // A stored `true` would read as the firm granting itself a feature, which
      // it cannot do: the plan is the ceiling. Absence is the honest value.
      expect(await storedOptOut(firm.id, 'trustAccounting')).toBeNull();
    });
  });

  describe('refusing to switch off while client funds are held', () => {
    it('refuses, names the amount, and leaves the trust routes open', async () => {
      const firm = await professionalFirm();
      const owner = await ownerOf(firm.id);
      const client = await createPersonClient(firm.id);
      await createTrustDeposit(firm.id, client.id, { amountCents: 412_600 });

      const res = await owner.api.put(toggleUrl(firm.id, 'trustAccounting'))
        .send({ enabled: false });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/\$4,126\.00/);
      expect(res.body.error).toMatch(/client funds/i);

      // The refusal must not be cosmetic: nothing is stored, and the ledger the
      // firm is required to keep is still reachable.
      expect(await storedOptOut(firm.id, 'trustAccounting')).toBeNull();
      expect((await owner.api.get(`/api/lawfirms/${firm.id}/trust/accounts`)).status).toBe(200);
    });

    it('allows it once the balance is disbursed back to zero', async () => {
      const firm = await professionalFirm();
      const owner = await ownerOf(firm.id);
      const client = await createPersonClient(firm.id);
      const { accountId, amountCents } = await createTrustDeposit(firm.id, client.id);

      // A matching withdrawal, the same way a real disbursement zeroes a ledger.
      await testPool.query(
        `insert into trust_transactions
           (id, law_firm_id, trust_account_id, type, amount_cents, client_id,
            txn_date, description, status, client_balance_after_cents,
            account_balance_after_cents)
         values (gen_random_uuid(), $1, $2, 'withdrawal', $3, $4, current_date,
                 'Disbursed', 'completed', 0, 0)`,
        [firm.id, accountId, amountCents, client.id],
      );

      const res = await owner.api.put(toggleUrl(firm.id, 'trustAccounting'))
        .send({ enabled: false });

      expect(res.status).toBe(200);
      expect(await storedOptOut(firm.id, 'trustAccounting')).toBe(false);
    });

    it('ignores a voided deposit, which never held anything', async () => {
      const firm = await professionalFirm();
      const owner = await ownerOf(firm.id);
      const client = await createPersonClient(firm.id);
      const { transactionId } = await createTrustDeposit(firm.id, client.id);
      await testPool.query(
        `update trust_transactions set status = 'void' where id = $1`,
        [transactionId],
      );

      const res = await owner.api.put(toggleUrl(firm.id, 'trustAccounting'))
        .send({ enabled: false });

      expect(res.status).toBe(200);
    });

    it('still refuses when one client is positive and another is negative, which sums to zero firm-wide', async () => {
      const firm = await professionalFirm();
      const owner = await ownerOf(firm.id);
      const holder = await createPersonClient(firm.id, { name: 'Holder' });
      const overdrawn = await createPersonClient(firm.id, { name: 'Overdrawn' });
      const { accountId, amountCents } = await createTrustDeposit(firm.id, holder.id);

      // An equal and opposite ledger for a DIFFERENT client. A firm-wide `sum`
      // reads zero here, but one client's money is still on deposit. This is the
      // case a naive total would get wrong.
      await testPool.query(
        `insert into trust_transactions
           (id, law_firm_id, trust_account_id, type, amount_cents, client_id,
            txn_date, description, status, client_balance_after_cents,
            account_balance_after_cents)
         values (gen_random_uuid(), $1, $2, 'withdrawal', $3, $4, current_date,
                 'Correction', 'completed', 0, 0)`,
        [firm.id, accountId, amountCents, overdrawn.id],
      );

      const res = await owner.api.put(toggleUrl(firm.id, 'trustAccounting'))
        .send({ enabled: false });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/client funds/i);
    });
  });

  describe('what the route will not accept', () => {
    it('rejects a feature that is not on the firm-toggleable list', async () => {
      const firm = await professionalFirm();
      const owner = await ownerOf(firm.id);

      // `messaging` is a real feature key, so this proves the ALLOWLIST is doing
      // the work rather than a typo check: a firm must not be able to switch off
      // whatever it likes through this route.
      const res = await owner.api.put(toggleUrl(firm.id, 'messaging'))
        .send({ enabled: false });

      expect(res.status).toBe(400);
      expect(await storedOptOut(firm.id, 'messaging')).toBeNull();
    });

    it('refuses a member without settings.manageFirm and changes nothing', async () => {
      const firm = await professionalFirm();
      const member = await memberWith(firm.id, ['trust.view', 'settings.viewFirm']);

      const res = await member.api.put(toggleUrl(firm.id, 'trustAccounting'))
        .send({ enabled: false });

      expect(res.status).toBe(403);
      expect(await storedOptOut(firm.id, 'trustAccounting')).toBeNull();
    });

    it('rejects a body without `enabled` rather than defaulting it', async () => {
      const firm = await professionalFirm();
      const owner = await ownerOf(firm.id);

      const res = await owner.api.put(toggleUrl(firm.id, 'trustAccounting')).send({});

      expect(res.status).toBe(400);
      expect(await storedOptOut(firm.id, 'trustAccounting')).toBeNull();
    });
  });

  describe('the opt-out is per firm', () => {
    it('leaves a second firm on the same plan untouched', async () => {
      const disabling = await professionalFirm();
      const untouched = await professionalFirm();
      const disablingOwner = await ownerOf(disabling.id);
      const untouchedOwner = await ownerOf(untouched.id);

      await disablingOwner.api.put(toggleUrl(disabling.id, 'trustAccounting'))
        .send({ enabled: false });

      expect((await untouchedOwner.api.get(`/api/lawfirms/${untouched.id}/trust/accounts`)).status)
        .toBe(200);
    });
  });
});
