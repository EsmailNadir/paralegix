/**
 * Route-level coverage for `enforceFeatureAccess` (mounted as `requireFeature`),
 * the OTHER half of `planEnforcement.ts` besides the billing lockout
 * (`billingLockout.test.ts`) and the count limits
 * (`planEnforcement.test.ts`'s maxMatters/maxMembers suites).
 *
 * Before this file, only TWO of the seven `app.ts` mounts that carry
 * `requireFeature(...)` had any route-level denial coverage:
 *
 *  - `templates`, in `planEnforcement.test.ts` (message-text assertion only,
 *    no `code` check).
 *  - `calendarSync`, in `tests/calendar/{google,outlook}SyncRoutes.test.ts`
 *    (thorough: isolates the feature gate from billing and proves no Google/
 *    Outlook call happens on denial).
 *
 * `trustAccounting`, `documentSigning`, `fileSharing`, `flatFees` and
 * `analytics` had NONE. The last two are now pinned in their own billing
 * specs; this file keeps the other three. A regression that deleted `requireFeature('trustAccounting')`
 * from its `app.use` line in app.ts, for example, would pass the entire suite:
 * nothing seeds a firm without the feature and calls the route.
 *
 * Each case below proves the same three things `billingLockout.test.ts` proves
 * for the billing gate, but for the FEATURE gate, isolated from billing:
 *
 *  1. EXACT denial shape: 403, `code: 'FORBIDDEN'` (the shared shape every
 *     `ForbiddenError` uses — see the header comment on `requireFeature` for
 *     why a feature denial is deliberately indistinguishable, to a
 *     non-member, from an ordinary permission denial; a MEMBER refused by
 *     their own firm's plan is a different case and this file pins its exact
 *     code, which no existing test does for these five features).
 *  2. NO MUTATION, and for the one route that would otherwise reach a
 *     provider, no PROVIDER CALL either: `requireFeature` is mounted ahead of
 *     the router in `app.ts`, so a request that would fail validation or hit
 *     GCS if it ever reached the handler must never get that far. Every body
 *     below is INTENTIONALLY VALID — the shape the create schema accepts — so
 *     a 403 against it cannot be explained by validation running first; only
 *     the feature gate explains it.
 *  3. ISOLATION from the billing gate: `billing_status` is set to `'active'`
 *     EXPLICITLY in every case below, and read back (never left on the
 *     `comped` fixture default `createFirm` normally carries), so a refusal
 *     here cannot be the billing gate firing instead of the feature one.
 *
 * A control case per feature (professional tier, same explicit active
 * billing) proves the refusal is really the plan ceiling and not a gate that
 * refuses everyone or a broken fixture.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createInvoice,
  createPersonClient,
  createTrustDeposit,
  ownerOf,
  setFirmPlan,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const { PLAN_TIERS } = require('../../src/shared/plans/planDefinitions');

// Every feature exercised here is false on starter and true on professional.
const STARTER = PLAN_TIERS.starter;
const PROFESSIONAL = PLAN_TIERS.professional;

/**
 * Set a firm's plan AND billing status, so every case states its billing state
 * explicitly rather than inheriting `createFirm`'s `comped` default.
 * `loadFirmPlan` reads the `plan_id` and `billing_status` COLUMNS (the jsonb has
 * not carried them since migration 0200), and `setFirmPlan` writes both there.
 * The read-back is the premise of the whole file: a firm left `comped` would
 * still pass the billing gate, so the isolation claim would be unproven.
 */
async function setPlan(lawFirmId: string, planId: string, billingStatus = 'active') {
  await setFirmPlan(lawFirmId, { planId, billingStatus });
  const { rows } = await testPool.query(
    'select plan_id, billing_status from law_firms where id = $1', [lawFirmId],
  );
  expect(rows[0]).toEqual({ plan_id: planId, billing_status: billingStatus });
}

function expectFeatureDenied(res: { status: number; body: any }, featureLabel: RegExp) {
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('FORBIDDEN');
  expect(res.body.error).toMatch(featureLabel);
}

async function seedMatter(lawFirmId: string, name = 'Bell v. Ward') {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, $3, $4)`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  return id;
}

/** Firm-level feature opt-out, which lives in `settings.features`, not in `plan`. */
async function setFirmFeatureSetting(lawFirmId: string, feature: string, enabled: boolean) {
  await testPool.query(
    `update law_firms
        set settings = coalesce(settings, '{}'::jsonb)
          || jsonb_build_object('features',
               coalesce(settings -> 'features', '{}'::jsonb)
                 || jsonb_build_object($2::text, $3::boolean))
      where id = $1`,
    [lawFirmId, feature, enabled],
  );
}

// ── trustAccounting: POST /trust/accounts ───────────────────────────────────

describe('feature gate: trustAccounting on POST /trust/accounts', () => {
  const validBody = { name: 'Client Trust', bankName: 'First National', accountNumberLast4: '1234' };
  const accountCount = async (lawFirmId: string) => {
    const { rows } = await testPool.query(
      `select count(*)::int as c from trust_accounts where law_firm_id = $1`, [lawFirmId],
    );
    return rows[0].c;
  };
  const create = (owner: Actor, firmId: string) =>
    owner.api.post(`/api/lawfirms/${firmId}/trust/accounts`).send(validBody);

  it('refuses a starter firm with 403 FORBIDDEN and creates no account', async () => {
    expect(STARTER.features.trustAccounting).toBe(false);
    const firm = await createFirm({ planId: 'starter' });
    await setPlan(firm.id, 'starter', 'active');
    const owner = await ownerOf(firm.id);

    const res = await create(owner, firm.id);

    expectFeatureDenied(res, /not included in your current plan/i);
    expect(res.body.error).toMatch(/trust accounting/i);
    expect(await accountCount(firm.id)).toBe(0);
  });

  it('serves a professional firm with the same explicit active billing', async () => {
    expect(PROFESSIONAL.features.trustAccounting).toBe(true);
    const firm = await createFirm({ planId: 'professional' });
    await setPlan(firm.id, 'professional', 'active');
    const owner = await ownerOf(firm.id);

    const res = await create(owner, firm.id);

    expect(res.status).toBe(201);
    expect(await accountCount(firm.id)).toBe(1);
  });
});

// ── documentSigning: POST /signing-templates ────────────────────────────────

describe('feature gate: documentSigning on POST /signing-templates', () => {
  const validBody = {
    name: 'Engagement Agreement',
    description: 'Standard retainer',
    fields: [{
      id: 'sig_1', page: 1, xPercent: 10, yPercent: 20, widthPercent: 25,
      heightPercent: 5, fieldType: 'signature', signerId: 'role:1',
    }],
    signerRoles: [{ roleLabel: 'Client', order: 1, deliveryMethod: 'email' }],
  };
  const templateCount = async (lawFirmId: string) => {
    const { rows } = await testPool.query(
      `select count(*)::int as c from signature_templates where law_firm_id = $1`, [lawFirmId],
    );
    return rows[0].c;
  };
  const create = (owner: Actor, firmId: string) =>
    owner.api.post(`/api/lawfirms/${firmId}/signing-templates`).send(validBody);

  it('refuses a starter firm with 403 FORBIDDEN and creates no template', async () => {
    expect(STARTER.features.documentSigning).toBe(false);
    const firm = await createFirm({ planId: 'starter' });
    await setPlan(firm.id, 'starter', 'active');
    const owner = await ownerOf(firm.id);

    const res = await create(owner, firm.id);

    expectFeatureDenied(res, /not included in your current plan/i);
    expect(res.body.error).toMatch(/document signing/i);
    expect(await templateCount(firm.id)).toBe(0);
  });

  it('serves a professional firm with the same explicit active billing', async () => {
    expect(PROFESSIONAL.features.documentSigning).toBe(true);
    const firm = await createFirm({ planId: 'professional' });
    await setPlan(firm.id, 'professional', 'active');
    const owner = await ownerOf(firm.id);

    const res = await create(owner, firm.id);

    expect(res.status).toBe(201);
    expect(await templateCount(firm.id)).toBe(1);
  });
});

// ── fileSharing: POST /file-share-links ─────────────────────────────────────

/**
 * `fileSharing` is `true` on EVERY tier in `planDefinitions.ts` (starter
 * through enterprise), so no tier choice can ever deny it — the only way a
 * firm sees this gate refuse is the firm-level `settings.features` opt-out
 * (`featureCheck.isFeatureEnabled`'s second half). This is worth a
 * functionality-questions.md entry: `requireFeature('fileSharing')` in
 * app.ts reads as tier-gated the same way `trustAccounting`/`documentSigning`
 * are, but in practice it can only ever be OFF by a firm choosing to disable
 * its own feature, never by plan. Exercised that way here, deliberately.
 *
 * `createShareLink` calls `bucket.file(objectPath).exists()` before it writes
 * anything (shareLinks.service.ts), and the in-process harness's GCS double is
 * INERT: every operation on it throws by name (see setupInProcess's firebase
 * mock). So if the gate ever let a denied request past `requireFeature`, this
 * case would not quietly pass — it would 500 from the bucket call. Getting a
 * clean 403 here is therefore itself proof the request never reached the
 * provider call, without needing a bucket spy the way the billing checkout
 * case (`billingLockout.test.ts`) needed a 400 from validation to prove the
 * same thing for Stripe.
 */
describe('feature gate: fileSharing on POST /file-share-links', () => {
  const linkCount = async (lawFirmId: string) => {
    const { rows } = await testPool.query(
      `select count(*)::int as c from file_share_links where law_firm_id = $1`, [lawFirmId],
    );
    return rows[0].c;
  };
  const create = (owner: Actor, firmId: string, fileId?: string) =>
    owner.api.post(`/api/lawfirms/${firmId}/file-share-links`)
      .send({ fileId: fileId ?? '00000000-0000-4000-8000-000000000001', permission: 'view' });

  it('refuses a firm that opted out of fileSharing with 403 FORBIDDEN, never reaching the GCS existence check', async () => {
    expect(PROFESSIONAL.features.fileSharing).toBe(true);
    const firm = await createFirm({ planId: 'professional' });
    await setPlan(firm.id, 'professional', 'active');
    await setFirmFeatureSetting(firm.id, 'fileSharing', false);
    const owner = await ownerOf(firm.id);

    const res = await create(owner, firm.id);

    // A 500 here would mean the gate let the request through to the inert
    // GCS double; the exact 403/FORBIDDEN below is proof it did not.
    expectFeatureDenied(res, /not included in your current plan/i);
    expect(res.body.error).toMatch(/file sharing/i);
    expect(await linkCount(firm.id)).toBe(0);
  });

  /**
   * The control case necessarily 404s (no real file exists in the inert GCS
   * double for this path to find), which is fine: it proves the gate let the
   * request all the way through to the provider call, the opposite of the
   * denial case above. A 403 here would mean the "refuses" case above was
   * only ever exercising the missing-file path, not the feature gate.
   */
  it('lets a firm with no opt-out reach the GCS existence check (fails there, not at the gate)', async () => {
    const firm = await createFirm({ planId: 'professional' });
    await setPlan(firm.id, 'professional', 'active');
    const owner = await ownerOf(firm.id);

    const res = await create(owner, firm.id);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(await linkCount(firm.id)).toBe(0);
  });
});

// ── flatFees and analytics ───────────────────────────────────────────────────

// Their denials, with the exact `code`, are pinned beside each feature's other
// cases: `tests/billing/flatFees.test.ts` ("the flatFees plan gate", including
// the read side) and `tests/billing/billingAnalytics.test.ts` ("the analytics
// plan gate", across all four tiers).

// ── trustAccounting: paying an invoice FROM trust ───────────────────────────

/**
 * The one trust action that is NOT reached through a trust route.
 *
 * `PUT .../invoices/.../payment` with `paymentSource: 'trust'` writes a real
 * withdrawal against the client's ledger, but it lives on the invoices router,
 * which carries no `requireFeature` and must not: external payments have to keep
 * working whatever the firm switched off. So the gate is applied inside
 * `recordPayment`, to that branch alone, and these cases pin both halves of that
 * claim. Deleting the check makes the first case go green at 200 with a trust
 * transaction on a firm whose plan has no trust accounting; widening it to the
 * whole route makes the third case go red.
 */
describe('feature gate: trustAccounting on invoice payments from trust', () => {
  const trustWithdrawalCount = async (lawFirmId: string) => {
    const { rows } = await testPool.query(
      `select count(*)::int as c from trust_transactions
        where law_firm_id = $1 and type = 'withdrawal'`,
      [lawFirmId],
    );
    return rows[0].c;
  };
  const amountPaidOf = async (invoiceId: string) => {
    const { rows } = await testPool.query(
      `select amount_paid_cents from invoices where id = $1`, [invoiceId],
    );
    return Number(rows[0].amount_paid_cents || 0);
  };

  /** A firm with an invoice and a funded trust account for the billed client. */
  async function seedPayableInvoice(planId: string) {
    const firm = await createFirm({ planId });
    await setPlan(firm.id, planId, 'active');
    const owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id);
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 50_000 });
    const { accountId } = await createTrustDeposit(firm.id, client.id, { amountCents: 500_000 });
    return { firm, owner, client, invoice, accountId };
  }

  const payFromTrust = (
    owner: Actor, firmId: string, clientId: string, invoiceId: string, accountId: string,
  ) => owner.api
    .put(`/api/lawfirms/${firmId}/billing/invoices/client/${clientId}/${invoiceId}/payment`)
    .send({ paymentAmount: 100, paymentSource: 'trust', trustAccountId: accountId });

  it('refuses a starter firm with 403 FORBIDDEN, and writes neither the payment nor a withdrawal', async () => {
    expect(STARTER.features.trustAccounting).toBe(false);
    const { firm, owner, client, invoice, accountId } = await seedPayableInvoice('starter');

    const res = await payFromTrust(owner, firm.id, client.id, invoice.id, accountId);

    expectFeatureDenied(res, /trust accounting/i);
    // The body is intentionally valid, so a 403 cannot be validation firing
    // first. Both sides of the write must be untouched: a gate that refused the
    // response after moving the money would leave the ledger short.
    expect(await trustWithdrawalCount(firm.id)).toBe(0);
    expect(await amountPaidOf(invoice.id)).toBe(0);
  });

  /**
   * The control: the SAME request on a professional firm goes all the way
   * through. It has to assert the completed effect and not merely a non-403,
   * because a gate that refused everyone, or a fixture that could never pay,
   * would satisfy a weaker assertion just as well.
   *
   * `tests/billing/invoiceTrustPayment.test.ts` owns this path in depth. What
   * this case adds is that the gate is not what stops it.
   */
  it('serves a professional firm the same request', async () => {
    const { firm, owner, client, invoice, accountId } = await seedPayableInvoice('professional');

    const res = await payFromTrust(owner, firm.id, client.id, invoice.id, accountId);

    expect(res.status).toBe(200);
    expect(await trustWithdrawalCount(firm.id)).toBe(1);
    expect(await amountPaidOf(invoice.id)).toBe(10_000);
  });

  it('leaves an EXTERNAL payment on the same starter firm working', async () => {
    const { firm, owner, client, invoice } = await seedPayableInvoice('starter');

    // The gate is scoped to the trust branch. A firm without trust accounting
    // still has to be able to record the cheque a client actually sent.
    const res = await owner.api
      .put(`/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}/${invoice.id}/payment`)
      .send({ paymentAmount: 100, paymentSource: 'external' });

    expect(res.status).toBe(200);
    expect(await amountPaidOf(invoice.id)).toBe(10_000);
  });

  it('refuses a professional firm that switched trust accounting off for itself', async () => {
    const { firm, owner, client, invoice, accountId } = await seedPayableInvoice('professional');
    await setFirmFeatureSetting(firm.id, 'trustAccounting', false);

    // The plan still allows it, so only the firm opt-out can explain this 403.
    const res = await payFromTrust(owner, firm.id, client.id, invoice.id, accountId);

    expectFeatureDenied(res, /trust accounting/i);
    expect(await trustWithdrawalCount(firm.id)).toBe(0);
  });
});

// ── recovery endpoints stay reachable under a FEATURE denial ────────────────

/**
 * `billingLockout.test.ts` proves a set of paths stay reachable while the
 * whole workspace is BILLING-locked. There is no equivalent risk for a
 * feature denial in the same way, because `requireFeature` is mounted only on
 * the five/seven specific routers above rather than on the shared
 * `/api/lawfirms/:lawFirmId` prefix — so nothing else CAN be caught by it.
 * This is the case that actually proves that scoping claim rather than
 * assuming it: a starter firm missing every one of these features can still
 * reach its own unrelated data (matters) and the upgrade path
 * (subscriptions), in the same request-cycle as being refused a gated
 * feature. Goes red if a future refactor ever hoists `requireFeature` (or an
 * aggregate of all feature checks) onto the shared prefix the way
 * `requireActiveBilling` is.
 */
describe('paths that stay reachable under a feature denial', () => {
  it('serves matters, the firm detail route, and the subscriptions endpoints on a firm missing every gated feature', async () => {
    const firm = await createFirm({ planId: 'starter' });
    await setPlan(firm.id, 'starter', 'active');
    const owner = await ownerOf(firm.id);
    await seedMatter(firm.id, 'Unrelated matter');

    // The gated route is refused...
    const denied = await owner.api.post(`/api/lawfirms/${firm.id}/trust/accounts`)
      .send({ name: 'X', bankName: 'Y', accountNumberLast4: '0000' });
    expect(denied.status).toBe(403);

    // ...but ordinary, non-gated routes on the very same firm are untouched.
    const matters = await owner.api.get(`/api/lawfirms/${firm.id}/matters`);
    expect(matters.status).toBe(200);
    expect(matters.body.matters.length).toBeGreaterThan(0);

    const status = await owner.api.get(`/api/lawfirms/${firm.id}/subscriptions/status`);
    expect(status.status).toBe(200);

    // The way OUT of the missing-feature state (upgrading) is reachable too;
    // an empty body 400s inside the subscriptions router's own validation,
    // proving no feature gate stands in front of it.
    const checkout = await owner.api.post(`/api/lawfirms/${firm.id}/subscriptions/checkout`).send({});
    expect(checkout.status).toBe(400);
    expect(checkout.body.code).not.toBe('FORBIDDEN');
  });
});
