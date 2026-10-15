/**
 * The `/api/cron/*` endpoints, which nobody watches.
 *
 * These are declared with `app.post('/api/cron/...')` DIRECTLY in `src/app.ts`
 * rather than mounted through a module router, which is why five passes of
 * router-mount gap scanning never saw them and why they arrived here with zero
 * coverage. They also run unattended, firm-wide, across every firm at once:
 * three of them move money (reconcile-billing, reconcile-trust-deposits,
 * trust-fee-sweep) and two of them mail clients and members (reminders,
 * digest). A per-request bug hurts one caller; a bug here hurts the whole
 * platform at 3am.
 *
 * NOT COVERED HERE, DELIBERATELY: `/api/cron/calendar-watch`. It is the one
 * cron route whose whole body lives in `src/modules/calendar/`, which another
 * agent owns concurrently. It needs its own spec.
 *
 * Three properties this file exists to pin, in priority order:
 *
 *   1. THE AUTHORIZATION, which is not a user token. `authorizeCronRequest` has
 *      three branches and every one of them is a platform-wide door. Branch 2
 *      used to accept an `x-cloudscheduler: true` header with NO secret
 *      whenever `CRON_SECRET` was unset and NODE_ENV was not production, which
 *      meant any caller who could reach such a deployment could fire every job
 *      on this list. It has since been narrowed to a loopback-only developer
 *      escape hatch under an explicit `test`/`development` allowlist, so a
 *      deployed environment always needs the secret. Both the door that is open
 *      and the doors that were closed are pinned below, so widening it again
 *      has to be a deliberate edit.
 *   2. THE LOCK. `runCronPass` wraps each pass in a `tryLock('CRON_PASS', ...)`,
 *      because Cloud Scheduler is at-least-once and every pass may legitimately
 *      run for its whole budget. An overlapping pass must answer 200 `skipped`
 *      (a non-2xx would make the scheduler retry the very thing already
 *      running) and must do NOTHING.
 *   3. IDEMPOTENCY. The scheduler retries on any non-2xx, so a second pass must
 *      not double-send an email, double-charge a fee, or double-post a trust
 *      entry. Every handler case below therefore runs the pass TWICE and
 *      asserts the second one changed nothing.
 *
 * Every case seeds TWO firms and asserts what happened to the firm that should
 * have been left alone, because these passes walk every firm on the platform
 * and a scoping mistake here is a cross-tenant one.
 *
 * Status codes are never the assertion. A cron handler that answers 200 and
 * does nothing is the failure mode, so the assertions are on rows and on
 * `recipientsOf(...)`.
 *
 * STRIPE is replaced wholesale by the `jest.mock` factory below, so no live
 * call is possible from this file and `STRIPE_SECRET_KEY` from `.env` is never
 * read. The money assertions are on the rows the handlers write, in cents.
 */

jest.mock('../../src/modules/stripe/stripe.config', () => {
  const refuse = (name: string) => jest.fn(() => {
    throw new Error(`stripe.${name} was called and this case did not configure it`);
  });
  return {
    subscriptions: { retrieve: refuse('subscriptions.retrieve'), update: refuse('subscriptions.update') },
    invoices: {
      create: refuse('invoices.create'),
      retrieve: refuse('invoices.retrieve'),
      finalizeInvoice: refuse('invoices.finalizeInvoice'),
      pay: refuse('invoices.pay'),
      voidInvoice: refuse('invoices.voidInvoice'),
    },
    invoiceItems: { create: refuse('invoiceItems.create') },
    customers: { create: refuse('customers.create') },
    paymentIntents: { list: refuse('paymentIntents.list'), retrieve: refuse('paymentIntents.retrieve') },
    accounts: { retrieve: refuse('accounts.retrieve'), update: refuse('accounts.update') },
    accountLinks: { create: refuse('accountLinks.create') },
    checkout: {
      sessions: {
        create: refuse('checkout.sessions.create'),
        retrieve: refuse('checkout.sessions.retrieve'),
        expire: refuse('checkout.sessions.expire'),
      },
    },
    transfers: { retrieve: refuse('transfers.retrieve'), createReversal: refuse('transfers.createReversal') },
  };
});

import { randomUUID } from 'crypto';
import {
  createFirm,
  createPersonClient,
  drainEvents,
  emailsMatching,
  memberWith,
  ownerOf,
  recipientsOf,
  request,
  testPool,
  type Actor,
} from '../support/setupInProcess';
import { atInstant } from '../support/clock';

/** Every cron route this file owns. `/api/cron/calendar-watch` is another agent's. */
const CRON_ROUTES = [
  '/api/cron/reminders',
  '/api/cron/digest',
  '/api/cron/housekeeping',
  '/api/cron/reconcile-billing',
  '/api/cron/reconcile-trust-deposits',
  '/api/cron/trust-fee-sweep',
  '/api/cron/signing-jobs',
];

/**
 * A price id this file owns, set before the app is loaded so `PRICE_MAP` (read
 * once at module load) resolves it. Using `.env`'s real ids would make the
 * billing reconciliation cases depend on an untracked file.
 */
const PRO_MONTHLY_PRICE = 'price_test_cron_professional_monthly';

const stripeFake = () => require('../../src/modules/stripe/stripe.config');

let savedCronSecret: string | undefined;
let savedRemindersDisabled: string | undefined;

beforeAll(() => {
  savedCronSecret = process.env.CRON_SECRET;
  savedRemindersDisabled = process.env.DISABLE_ALL_REMINDER_EMAILS;
  // Read once at module load by `shared/plans/stripePrices`, which the app pulls
  // in on its first request.
  process.env.STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID = PRO_MONTHLY_PRICE;
});

afterAll(() => {
  if (savedCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedCronSecret;
  if (savedRemindersDisabled === undefined) delete process.env.DISABLE_ALL_REMINDER_EMAILS;
  else process.env.DISABLE_ALL_REMINDER_EMAILS = savedRemindersDisabled;
});

beforeEach(() => {
  // `authorizeCronRequest` reads this per request. `.env` leaves it unset, but a
  // case that sets it must not leak into the next one, and the default posture
  // every handler case relies on (branch 2, the cloudscheduler header) only
  // exists while it is absent.
  delete process.env.CRON_SECRET;
  // `.env` ships DISABLE_ALL_REMINDER_EMAILS=true, which makes the reminders and
  // digest passes return `{disabled:true}` before they read a single row. Off by
  // default here so the email handlers are actually exercised; the one case that
  // pins the kill switch sets it itself.
  delete process.env.DISABLE_ALL_REMINDER_EMAILS;

  const s = stripeFake();
  [
    s.subscriptions.retrieve, s.subscriptions.update,
    s.invoices.create, s.invoices.retrieve, s.invoices.finalizeInvoice, s.invoices.pay,
    s.invoiceItems.create, s.paymentIntents.list,
  ].forEach((fn: any) => fn.mockReset().mockImplementation(() => {
    throw new Error('stripe surface called without configuration in this case');
  }));
});

/** Fire a cron pass the way Cloud Scheduler does when no secret is configured. */
function cron(path: string) {
  return request().post(path).set('x-cloudscheduler', 'true');
}

/* ------------------------------------------------------------------ */
/*  authorizeCronRequest                                              */
/* ------------------------------------------------------------------ */

describe('the signing-jobs drain', () => {
  const SECRET = 'cron-secret-value-abcdef';
  beforeEach(() => { process.env.CRON_SECRET = SECRET; });

  it('reports what it drained', async () => {
    const res = await request().post('/api/cron/signing-jobs').set('x-cron-secret', SECRET);

    expect(res.status).toBe(200);
    // The shape matters: an operator reads `remaining` to see whether the queue
    // is keeping up, and `truncated` to see whether the budget is too small.
    expect(res.body.signingJobs).toEqual({
      succeeded: 0, failed: 0, retried: 0, lost: 0, remaining: 0, truncated: false,
    });
  });

  it('registers a handler for every job kind it could claim', async () => {
    // A job whose kind nothing handles fails PERMANENTLY on its first claim, so
    // a missing registration is not a delay: it is every finalize in the queue
    // settling as failed the moment the drain reaches it. The route requires
    // both modules for their side effect, and nothing else in the process would
    // have loaded them.
    const { jobHandlerFor } = require('../../src/modules/signatures/signingJobs');

    await request().post('/api/cron/signing-jobs').set('x-cron-secret', SECRET);

    expect(typeof jobHandlerFor('prepare')).toBe('function');
    expect(typeof jobHandlerFor('finalize')).toBe('function');
  });

  it('gives the signing drain and the export drain ONE deadline between them', async () => {
    // The scheduler abandons an attempt at 30 minutes. Two budgets started one
    // after the other stack to 50, and the scheduler's retry then overlaps a
    // drain that is still inside a job.
    const signingJobs = require('../../src/modules/signatures/signingJobs');
    const exportJobs = require('../../src/modules/files/zipExportJobs');
    const signing = jest.spyOn(signingJobs, 'drainSigningJobs');
    const exporting = jest.spyOn(exportJobs, 'drainExportJobs');
    try {
      const res = await request().post('/api/cron/signing-jobs').set('x-cron-secret', SECRET);
      expect(res.status).toBe(200);

      expect(signing).toHaveBeenCalledTimes(1);
      expect(exporting).toHaveBeenCalledTimes(1);
      const signingDeadline = (signing.mock.calls[0][0] as any).deadline;
      expect(typeof signingDeadline).toBe('number');
      expect((exporting.mock.calls[0][0] as any).deadline).toBe(signingDeadline);
    } finally {
      signing.mockRestore();
      exporting.mockRestore();
    }
  });

  it('does not go through the CRON_PASS lock, unlike every other cron pass', async () => {
    // It holds an open request for up to 25 minutes, far past the pass lock's
    // lease. Mutual exclusion here is per JOB, through the job's own lease
    // token, so two instances may drain at once. A held CRON_PASS lease for
    // this route's name must therefore not make it skip.
    const held = await testPool.query(
      `insert into lock_leases (domain, lock_key, owner_token, locked_until)
       values ('CRON_PASS', 'signing-jobs', gen_random_uuid(), now() + interval '5 minutes')`,
    );
    expect(held.rowCount).toBe(1);

    const res = await request().post('/api/cron/signing-jobs').set('x-cron-secret', SECRET);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('authorizeCronRequest', () => {
  const SECRET = 'cron-secret-value-abcdef';

  describe('branch 1: CRON_SECRET is configured', () => {
    beforeEach(() => { process.env.CRON_SECRET = SECRET; });

    it('accepts the secret as a Bearer token', async () => {
      const res = await request().post('/api/cron/digest').set('Authorization', `Bearer ${SECRET}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('accepts the secret in the x-cron-secret header', async () => {
      const res = await request().post('/api/cron/digest').set('x-cron-secret', SECRET);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    /**
     * Every header set that must NOT authorize while a secret is configured.
     *
     * A secret LONGER than the real one is here for the wrapper, not the
     * comparison: crypto.timingSafeEqual THROWS on unequal buffer lengths, so
     * without the length guard in timingSafeMatch that case is a 500 with a
     * leaked stack, not a clean 403. The x-cloudscheduler case is branch 2 made
     * unreachable while branch 1 applies: a configured secret is the whole
     * authorization, and a header anyone can set is not a fallback for it.
     */
    it.each([
      { name: 'a wrong secret of the SAME length', headers: { 'x-cron-secret': 'z'.repeat(SECRET.length) } },
      { name: 'a secret that is a PREFIX of the real one', headers: { 'x-cron-secret': SECRET.slice(0, -1) } },
      { name: 'a secret LONGER than the real one', headers: { 'x-cron-secret': `${SECRET}extra` } },
      { name: 'a request carrying no secret at all', headers: {} },
      { name: 'the x-cloudscheduler header once a secret IS configured', headers: { 'x-cloudscheduler': 'true' } },
      { name: 'a non-Bearer Authorization header carrying the secret', headers: { Authorization: SECRET } },
    ])('refuses $name', async ({ headers }) => {
      const res = await request().post('/api/cron/digest').set(headers);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Forbidden');
    });

    it('gates EVERY cron route this file owns, not just the one probed above', async () => {
      for (const path of CRON_ROUTES) {
        const res = await request().post(path).set('x-cron-secret', 'not-the-secret');
        expect([path, res.status]).toEqual([path, 403]);
      }
    });

    it('a refused trust-fee-sweep does no work at all; the correct secret then runs the same charge', async () => {
      // Every case above stops at the status code. This one proves the 403 is
      // not just a label: `authorizeCronRequest` runs ahead of the handler, so a
      // wrong secret must never touch a row or place a Stripe call, on the one
      // route in this file that moves money on a real card.
      const firm = await createFirm({ name: 'Fee Sweep Secret Boundary' });
      await setFirmPlan(firm.id, { planId: 'professional', stripeCustomerId: 'cus_secret_boundary' });
      const fee = await seedAccruedFee(firm.id, 5_150);
      configurePayingStripe();

      const refused = await request().post('/api/cron/trust-fee-sweep')
        .set('x-cron-secret', 'not-the-secret');
      expect(refused.status).toBe(403);
      expect(refused.body).toEqual({ error: 'Forbidden' });

      expect(await feeRow(fee)).toMatchObject({ status: 'accrued', stripe_invoice_id: null });
      expect(stripeFake().invoices.create).not.toHaveBeenCalled();
      expect(stripeFake().invoiceItems.create).not.toHaveBeenCalled();
      expect(stripeFake().invoices.pay).not.toHaveBeenCalled();

      // Positive control: the real secret reaches the same handler and actually
      // charges the same fee, so the 403 above proved a refusal and not a
      // fixture that was never going to charge anything anyway.
      const allowed = await request().post('/api/cron/trust-fee-sweep')
        .set('x-cron-secret', SECRET);
      expect(allowed.status).toBe(200);
      expect(allowed.body.trustFeeSweep.billed).toBe(1);
      expect((await feeRow(fee)).status).toBe('billed');
      expect(stripeFake().invoices.pay).toHaveBeenCalledTimes(1);
    });
  });

  describe('branch 2: no CRON_SECRET, local developer loopback escape hatch', () => {
    /**
     * WHAT THIS BRANCH USED TO BE. With `CRON_SECRET` unset, a bare
     * `x-cloudscheduler: true` header authorized every cron job on anything
     * whose `NODE_ENV` was merely not the string `'production'`, with no secret
     * of any kind. The header IS the authorization and any caller can send it,
     * so on such a deployment anyone who could reach the URL could fire the
     * trust fee sweep and mail every client. The container defaults
     * `NODE_ENV=production`, so the door only opened where that default was
     * overridden or the app ran outside the image, which is exactly the kind of
     * safety that depends on nobody making a deployment mistake.
     *
     * WHAT IT IS NOW. A deployed environment always needs `CRON_SECRET`. What
     * survives here is a developer poking their own process, and it needs BOTH
     * an explicitly named local `NODE_ENV` (`test` or `development`, never
     * "not production") AND a connection from this machine's own loopback
     * interface, read off the TCP socket rather than a header. Either condition
     * alone already closes every deployment, so the two are redundant on
     * purpose.
     *
     * The cases below are the same probes as before with the expectations
     * moved, plus the refusals the old shape did not have.
     */
    it('accepts x-cloudscheduler: true from loopback with NO secret, under NODE_ENV=test', async () => {
      expect(process.env.CRON_SECRET).toBeUndefined();
      expect(process.env.NODE_ENV).toBe('test');
      const res = await request().post('/api/cron/digest').set('x-cloudscheduler', 'true');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('requires the header value to be exactly the string "true"', async () => {
      // Not 'true ' with a trailing space: Node trims header values before the
      // handler ever sees them, so that case would pass for the wrong reason.
      for (const value of ['TRUE', '1', 'yes', 'True']) {
        const res = await request().post('/api/cron/digest').set('x-cloudscheduler', value);
        expect([value, res.status]).toEqual([value, 503]);
      }
    });

    it('opens every cron route this file owns, not just the one probed above', async () => {
      for (const path of CRON_ROUTES) {
        configureQuietStripe();
        const res = await request().post(path).set('x-cloudscheduler', 'true');
        expect([path, res.status]).toEqual([path, 200]);
      }
    });

    it('is NOT available in production', async () => {
      process.env.NODE_ENV = 'production';
      try {
        const res = await request().post('/api/cron/digest').set('x-cloudscheduler', 'true');
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('Cron authorization is not configured');
      } finally {
        process.env.NODE_ENV = 'test';
      }
    });

    /**
     * THE STAGING CASE, and the reason this branch was narrowed. A deployment
     * named anything other than `production` used to sail straight through.
     * `NODE_ENV` is now an allowlist of two local values, so every other name,
     * including a typo of `production` itself, lands on the closed side.
     */
    it.each(['staging', 'preview', 'qa', 'dev', 'Production', 'PRODUCTION'])(
      'refuses x-cloudscheduler on NODE_ENV=%s, which is not production but not local either',
      async (env) => {
        const saved = process.env.NODE_ENV;
        process.env.NODE_ENV = env;
        try {
          const res = await request().post('/api/cron/digest').set('x-cloudscheduler', 'true');
          expect(res.status).toBe(503);
          expect(res.body.error).toBe('Cron authorization is not configured');
        } finally {
          process.env.NODE_ENV = saved;
        }
      },
    );

    it('refuses x-cloudscheduler when NODE_ENV is unset entirely', async () => {
      // `node dist/server.js` outside the container. The old test was `!==
      // 'production'`, and `undefined !== 'production'`, so a missing NODE_ENV
      // was the most permissive value it could have.
      const saved = process.env.NODE_ENV;
      delete process.env.NODE_ENV;
      try {
        const res = await request().post('/api/cron/digest').set('x-cloudscheduler', 'true');
        expect(res.status).toBe(503);
      } finally {
        process.env.NODE_ENV = saved;
      }
    });

    /**
     * The escape hatch means "a developer at this keyboard", not "a packet that
     * happened to arrive on lo". A forwarding header says the request was
     * relayed by something else (a reverse proxy in front of the dev server, or
     * an SSRF hop out of this very app), so its real origin is not this machine.
     *
     * The forwarded-for-localhost case proves the gate reads
     * `req.socket.remoteAddress` and not `req.ip`. `app.set('trust proxy', ...)`
     * makes `req.ip` come from that header, so a gate written against `req.ip`
     * would be satisfied by the attacker's own string. The socket address is the
     * peer the kernel accepted and no header can move it.
     */
    it.each([
      { name: 'a request that reached the loopback socket through a proxy', header: ['x-forwarded-for', '203.0.113.9'] },
      { name: 'a proxied request even when the forwarded address CLAIMS to be localhost', header: ['x-forwarded-for', '127.0.0.1'] },
      { name: 'a proxied request carrying the RFC 7239 Forwarded header', header: ['forwarded', 'for=203.0.113.9;proto=https'] },
    ])('refuses $name', async ({ header: [name, value] }) => {
      const res = await request().post('/api/cron/digest')
        .set('x-cloudscheduler', 'true')
        .set(name, value);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('Cron authorization is not configured');
    });

    it('closes EVERY cron route this file owns on a staging-shaped deployment', async () => {
      // The money movers and the client mailers, one by one. A narrowing that
      // only reached the route this describe block probes above would be worth
      // very little.
      const saved = process.env.NODE_ENV;
      process.env.NODE_ENV = 'staging';
      try {
        for (const path of CRON_ROUTES) {
          const res = await request().post(path).set('x-cloudscheduler', 'true');
          expect([path, res.status]).toEqual([path, 503]);
        }
      } finally {
        process.env.NODE_ENV = saved;
      }
    });

    it('still lets a staging-shaped deployment run its jobs once CRON_SECRET is set', async () => {
      // The narrowing must cost a correctly configured deployment nothing: the
      // fix is "configure the secret", so the configured path has to work in the
      // very environment the branch above now refuses.
      const saved = process.env.NODE_ENV;
      process.env.NODE_ENV = 'staging';
      process.env.CRON_SECRET = SECRET;
      try {
        const res = await request().post('/api/cron/digest').set('x-cron-secret', SECRET);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
      } finally {
        process.env.NODE_ENV = saved;
      }
    });
  });

  describe('branch 3: neither', () => {
    it('answers 503, not 403, when nothing authorizes the request', async () => {
      // The distinction is operational: 403 means "you are not allowed", 503
      // means "this deployment has no cron authorization configured at all",
      // which is a deploy defect the operator has to fix.
      const res = await request().post('/api/cron/digest');
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('Cron authorization is not configured');
    });

    it('refuses every cron route this file owns', async () => {
      for (const path of CRON_ROUTES) {
        const res = await request().post(path);
        expect([path, res.status]).toEqual([path, 503]);
      }
    });
  });
});

/* ------------------------------------------------------------------ */
/*  runCronPass and the CRON_PASS advisory lock                        */
/* ------------------------------------------------------------------ */

describe('runCronPass', () => {
  /**
   * Hold the `CRON_PASS` lease for one pass name with a row the app did not
   * write, standing in for a previous pass still running on another instance.
   * The lease table is shared by every instance, so the app's `tryLock` sees
   * this row exactly as it would see another Cloud Run instance's.
   */
  async function holdingCronLock<T>(passName: string, fn: () => Promise<T>): Promise<T> {
    const held = await testPool.query(
      `insert into lock_leases (domain, lock_key, owner_token, locked_until)
       values ('CRON_PASS', $1, gen_random_uuid(), now() + interval '5 minutes')`,
      [passName],
    );
    expect(held.rowCount).toBe(1);
    try {
      return await fn();
    } finally {
      await testPool.query(
        `delete from lock_leases where domain = 'CRON_PASS' and lock_key = $1`,
        [passName],
      );
    }
  }

  it('answers 200 skipped, not an error, while another pass holds the lock', async () => {
    const res = await holdingCronLock('housekeeping', () => cron('/api/cron/housekeeping'));
    // 200 is load-bearing: Cloud Scheduler retries any non-2xx, and retrying
    // "someone else is already doing this" is precisely wrong.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'skipped', reason: 'already running', pass: 'housekeeping' });
  });

  it('the skipped pass does NO work', async () => {
    const firm = await createFirm();
    const inviteId = await seedExpiredInvitation(firm.id);

    const res = await holdingCronLock('housekeeping', () => cron('/api/cron/housekeeping'));
    expect(res.body.status).toBe('skipped');

    // The status alone would pass against a handler that ran anyway and merely
    // reported "skipped". The row is the assertion.
    expect(await invitationStatus(inviteId)).toBe('pending');
  });

  it('releases the lock at the end of the pass, so the next run acquires it', async () => {
    const first = await cron('/api/cron/housekeeping');
    expect(first.body.status).toBe('ok');
    const second = await cron('/api/cron/housekeeping');
    expect(second.body.status).toBe('ok');
  });

  it('locks per pass NAME: holding one pass does not block a different one', async () => {
    const res = await holdingCronLock('housekeeping', () => cron('/api/cron/digest'));
    // A single lock shared by every pass would serialize unrelated jobs and,
    // worse, let one wedged pass silently suppress all the others.
    expect(res.body.status).toBe('ok');
  });

  it('every pass this file owns answers the same envelope shape', async () => {
    for (const path of CRON_ROUTES) {
      configureQuietStripe();
      const res = await cron(path);
      expect([path, res.status, res.body.status]).toEqual([path, 200, 'ok']);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  /api/cron/reminders                                                */
/* ------------------------------------------------------------------ */

describe('POST /api/cron/reminders', () => {
  it('emails the firm that has a task due today and leaves the other firm alone', async () => {
    const firmA = await createFirm({ name: 'Reminder Firm A' });
    const ownerA = await ownerOf(firmA.id);
    await seedTaskDueToday(firmA.id, 'Alpha task due today');

    // Same world, reminders switched off at the firm level. Proves the pass is
    // reading each firm's own settings rather than blasting the platform.
    const firmB = await createFirm({ name: 'Reminder Firm B' });
    const ownerB = await ownerOf(firmB.id);
    await setFirmSettings(firmB.id, { taskReminders: { enabled: false } });
    await seedTaskDueToday(firmB.id, 'Bravo task due today');

    const res = await cron('/api/cron/reminders');
    expect(res.status).toBe(200);
    await drainEvents();

    expect(recipientsOf('Due today: Alpha task due today')).toEqual([emailOf(ownerA)]);
    expect(recipientsOf('Due today: Bravo task due today')).toEqual([]);
    expect(recipientsOf(/Due today/)).not.toContain(emailOf(ownerB));
  });

  it('a second pass does not send the same reminder again', async () => {
    const firm = await createFirm({ name: 'Idempotent Reminders' });
    const owner = await ownerOf(firm.id);
    await seedTaskDueToday(firm.id, 'Only once please');

    await cron('/api/cron/reminders');
    await drainEvents();
    expect(recipientsOf('Due today: Only once please')).toEqual([emailOf(owner)]);

    // The scheduler retries on any non-2xx, so this is the ordinary case, not an
    // exotic one. `claimReminderSend` moves the 24h window into the WHERE
    // clause; losing that claim is what has to keep this list at one.
    await cron('/api/cron/reminders');
    await drainEvents();
    expect(recipientsOf('Due today: Only once please')).toEqual([emailOf(owner)]);
  });

  it('sends nothing at all while DISABLE_ALL_REMINDER_EMAILS is set', async () => {
    const firm = await createFirm();
    await ownerOf(firm.id);
    await seedTaskDueToday(firm.id, 'Suppressed task');

    process.env.DISABLE_ALL_REMINDER_EMAILS = 'true';
    const res = await cron('/api/cron/reminders');
    await drainEvents();

    expect(res.status).toBe(200);
    expect(res.body.taskReminders.disabled).toBe(true);
    expect(recipientsOf('Due today: Suppressed task')).toEqual([]);
    // Nothing was claimed either, so flipping the switch back sends the reminder
    // rather than having silently burned it.
    const { rows } = await testPool.query(
      `select r.last_sent_at as last_reminder_sent_at
         from tasks t left join reminders r on r.task_id = t.id
        where t.law_firm_id = $1`,
      [firm.id],
    );
    expect(rows[0].last_reminder_sent_at).toBeNull();
  });

  it('purges notifications past retention on the read/unread split, and keeps the rest', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    // Nothing else in the app ever deletes a notification, so without this pass
    // the table only grows. Read items age out at 90 days, anything unread is
    // kept for a year.
    const readOld = await seedNotification(firm.id, owner.uid, { ageDays: 120, read: true });
    const readFresh = await seedNotification(firm.id, owner.uid, { ageDays: 1, read: true });
    const unreadMiddle = await seedNotification(firm.id, owner.uid, { ageDays: 120, read: false });
    const unreadAncient = await seedNotification(firm.id, owner.uid, { ageDays: 400, read: false });

    const res = await cron('/api/cron/reminders');
    expect(res.status).toBe(200);

    expect(await notificationExists(readOld)).toBe(false);
    expect(await notificationExists(unreadAncient)).toBe(false);
    expect(await notificationExists(readFresh)).toBe(true);
    // The one that separates "past the read window" from "past the hard cap".
    expect(await notificationExists(unreadMiddle)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  /api/cron/digest                                                   */
/* ------------------------------------------------------------------ */

describe('POST /api/cron/digest', () => {
  it('sends to the recipient whose local hour has arrived and to nobody in the opted-out firm', async () => {
    const hour = new Date().getUTCHours();

    const firmA = await createFirm({ name: 'Digest Firm A' });
    const ownerA = await ownerOf(firmA.id);
    await setDigestPrefs(ownerA.uid, hour);
    await seedTaskDueToday(firmA.id, 'Digest item A');

    const firmB = await createFirm({ name: 'Digest Firm B' });
    const ownerB = await ownerOf(firmB.id);
    await setDigestPrefs(ownerB.uid, hour);
    await seedTaskDueToday(firmB.id, 'Digest item B');
    await setFirmSettings(firmB.id, { dailyDigest: { enabled: false } });

    const res = await cron('/api/cron/digest');
    expect(res.status).toBe(200);
    await drainEvents();

    const told = recipientsOf(/^Your day:/);
    expect(told).toEqual([emailOf(ownerA)]);
    expect(told).not.toContain(emailOf(ownerB));

    // The claim row is the idempotency mechanism, so it has to exist for A and
    // not for B; asserting only the email would pass against a pass that sent
    // nothing and claimed everything.
    expect(await digestSendCount(firmA.id)).toBe(1);
    expect(await digestSendCount(firmB.id)).toBe(0);
  });

  it('a second pass in the same local day sends nothing more', async () => {
    const hour = new Date().getUTCHours();
    const firm = await createFirm({ name: 'Digest Once' });
    const owner = await ownerOf(firm.id);
    await setDigestPrefs(owner.uid, hour);
    await seedTaskDueToday(firm.id, 'Digest item once');

    await cron('/api/cron/digest');
    await drainEvents();
    expect(recipientsOf(/^Your day:/)).toEqual([emailOf(owner)]);

    // The digest cron fires HOURLY, so a repeat pass is not a retry edge case,
    // it is what happens 23 more times today.
    await cron('/api/cron/digest');
    await drainEvents();
    expect(recipientsOf(/^Your day:/)).toEqual([emailOf(owner)]);
    expect(await digestSendCount(firm.id)).toBe(1);
  });

  it('does not send to a recipient whose configured hour is not now', async () => {
    const hour = (new Date().getUTCHours() + 6) % 24;
    const firm = await createFirm({ name: 'Digest Later' });
    const owner = await ownerOf(firm.id);
    await setDigestPrefs(owner.uid, hour);
    await seedTaskDueToday(firm.id, 'Not yet');

    await cron('/api/cron/digest');
    await drainEvents();

    expect(recipientsOf(/^Your day:/)).toEqual([]);
    expect(await digestSendCount(firm.id)).toBe(0);
  });

  // J09: the digest fires hourly off `localHourFor`/`localDateFor`
  // (`shared/utils/localTime.ts`), which are Intl-based and therefore already
  // DST-correct in isolation (see `tests/shared/localTime.test.ts`). What is
  // untested is the CRON'S OWN behaviour across a real transition, where the
  // hourly polling cadence interacts with a local day that is not 24 hours long.
  //
  // The transition dates are found dynamically from the REAL clock (via
  // `nextDstTransitions`, below) rather than hardcoded. A hardcoded 2026 date
  // is a ticking time bomb here specifically: `digestRepo.purgeOldDigestSends`
  // deletes `digest_sends` rows older than 30 days off Postgres's OWN
  // `current_date` (real wall-clock time, never the frozen JS clock), and every
  // `/api/cron/digest` pass calls it. A `sentOn` date that is more than 30 real
  // days in the past gets its just-inserted claim row purged again within the
  // SAME request that created it, which would silently defeat the very
  // same-day dedupe this suite exists to pin. Anchoring to the next real
  // transition keeps these tests inside the safe (non-purged) window forever.
  describe('across a daylight-saving transition (America/New_York)', () => {
    const TZ = 'America/New_York';
    let fallBack: { at: Date; localDate: string; hour: number };
    let springForward: { at: Date; localDate: string; skippedHour: number; nextAt: Date };

    beforeAll(() => {
      const { fall, spring } = nextDstTransitions(TZ, new Date());

      // `fall` is the instant right at the repeat: local hour there is the same
      // one that also occurred (in the other UTC offset) one real hour earlier.
      fallBack = { at: fall, localDate: localDateAt(TZ, fall), hour: localHourAt(TZ, fall) };

      // `spring` is the instant right after the jump. The hour strictly between
      // the last pre-jump hour and the first post-jump hour is the one that
      // never happens that day.
      const beforeJump = localHourAt(TZ, new Date(spring.getTime() - 3_600_000));
      const skippedHour = (beforeJump + 1) % 24;
      // The next time that local hour occurs at all, which - one calendar day
      // later, back on a normal 24-hour cadence - is the recovery case.
      const nextAt = nextLocalHour(TZ, skippedHour, spring);
      springForward = { at: spring, localDate: localDateAt(TZ, spring), skippedHour, nextAt };
    });

    // Local hour `fallBack.hour` occurs twice on `fallBack.localDate`: once an
    // hour before `fallBack.at` (still in the pre-transition offset) and again
    // AT `fallBack.at` (the first instant of the post-transition offset).
    it('does not double-send when the configured hour repeats on the fall-back day', async () => {
      const firm = await createFirm({ name: 'Digest Fall Back' });
      const owner = await ownerOf(firm.id);
      await setDigestPrefsTz(owner.uid, fallBack.hour, TZ);
      await seedTaskDueOn(firm.id, 'Fall back item', fallBack.localDate);

      const firstOccurrence = new Date(fallBack.at.getTime() - 3_600_000);
      await atInstant(firstOccurrence.toISOString(), () => cron('/api/cron/digest'));
      await drainEvents();
      expect(recipientsOf(/^Your day:/)).toEqual([emailOf(owner)]);

      // The scheduler fires again an hour of WALL-CLOCK time later, which is
      // still the same local hour because the zone just repeated itself.
      await atInstant(fallBack.at.toISOString(), () => cron('/api/cron/digest'));
      await drainEvents();

      expect(recipientsOf(/^Your day:/)).toEqual([emailOf(owner)]);
      expect(await digestSendCount(firm.id)).toBe(1);
    });

    // `springForward.skippedHour` never occurs, in ANY offset, on
    // `springForward.localDate`: the clock jumps straight over it. A recipient
    // configured for exactly that hour has no cron fire that matches it.
    //
    // CHARACTERIZATION, not a bug fix: this pins what the code actually does
    // (silently skip that recipient for the whole day) rather than asserting
    // what it "should" do, which is a product decision nobody has made.
    it('CHARACTERIZATION: a digest configured for the hour daylight saving skips is not sent that day', async () => {
      const firm = await createFirm({ name: 'Digest Spring Forward' });
      const owner = await ownerOf(firm.id);
      await setDigestPrefsTz(owner.uid, springForward.skippedHour, TZ);
      await seedTaskDueOn(firm.id, 'Spring forward item', springForward.localDate);

      // Walk every hourly fire from four hours before the jump to four hours
      // after it - the skipped hour is never among the local hours observed.
      for (let offset = -4; offset <= 4; offset += 1) {
        const instant = new Date(springForward.at.getTime() + offset * 3_600_000);
        expect(localHourAt(TZ, instant)).not.toBe(springForward.skippedHour);
        // eslint-disable-next-line no-await-in-loop
        await atInstant(instant.toISOString(), () => cron('/api/cron/digest'));
      }
      await drainEvents();

      expect(recipientsOf(/^Your day:/)).toEqual([]);
      expect(await digestSendCount(firm.id)).toBe(0);

      // It is not lost forever: the next real occurrence of that local hour
      // (the following day, back on a normal 24-hour cadence) sends normally.
      await atInstant(springForward.nextAt.toISOString(), () => cron('/api/cron/digest'));
      await drainEvents();
      expect(recipientsOf(/^Your day:/)).toEqual([emailOf(owner)]);
    });
  });

  it('includes the firm receivables an owner is allowed to see', async () => {
    // REGRESSION. `canSeeInvoices` built its permission overlap as
    // `roles.permissions && ${ARRAY}::text[]`, and Drizzle expands a bare JS
    // array into a placeholder LIST, so the SQL reached Postgres as
    // `&& ($3, $4)::text[]` - a row cast, not an array cast. Every call threw,
    // the catch answered false, and NO recipient (owner included) ever saw an
    // invoice line. A digest with only invoices due was therefore judged empty
    // and never sent at all, which is why nothing surfaced the error.
    const hour = new Date().getUTCHours();
    const firm = await createFirm({ name: 'Receivables Firm' });
    const owner = await ownerOf(firm.id);
    await setDigestPrefs(owner.uid, hour);
    const client = await createPersonClient(firm.id, { name: 'Paying Client' });
    await seedInvoiceDueToday(firm.id, client.id, 'INV-DIGEST-1', 150_000);

    await cron('/api/cron/digest');
    await drainEvents();

    expect(recipientsOf(/^Your day:/)).toEqual([emailOf(owner)]);
    expect(emailsMatching(/^Your day:/)[0].html).toContain('INV-DIGEST-1');
  });

  it('withholds firm receivables from a member without a billing read permission', async () => {
    const hour = new Date().getUTCHours();
    const firm = await createFirm({ name: 'Receivables Scoping' });
    const owner = await ownerOf(firm.id);
    await setDigestPrefs(owner.uid, hour);
    const narrow = await memberWith(firm.id, ['tasks.view']);
    await setDigestPrefs(narrow.uid, hour);
    const client = await createPersonClient(firm.id);
    await seedInvoiceDueToday(firm.id, client.id, 'INV-HIDDEN-1', 90_000);

    await cron('/api/cron/digest');
    await drainEvents();

    // The owner is told; the member who cannot open an invoice in the app is not
    // told about one by email either. Fixing the overlap query above must not
    // turn the digest into a way around the billing permission.
    expect(recipientsOf(/^Your day:/)).toEqual([emailOf(owner)]);
    expect(emailsMatching(/^Your day:/)[0].html).toContain('INV-HIDDEN-1');
  });

  it('purges digest_sends past retention and keeps this firm-day claim', async () => {
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    await testPool.query(
      `insert into digest_sends (law_firm_id, user_id, sent_on, item_count)
       values ($1, $2, current_date - 400, 3), ($1, $2, current_date - 1, 4)`,
      [firm.id, owner.uid],
    );

    const res = await cron('/api/cron/digest');
    expect(res.status).toBe(200);
    expect(res.body.digestSendsPurged).toBe(1);

    const { rows } = await testPool.query(
      'select sent_on from digest_sends where law_firm_id = $1', [firm.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('keeps a digest_sends row exactly 30 days old and purges the one a day older', async () => {
    // The retention boundary itself, one row either side of it and one on it.
    // `digest_sends` is keyed on (firm, user, day), so each row needs its own user.
    const { purgeOldDigestSends } = require('../../src/modules/notifications/digest/digest.repository');
    const firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const onCutoff = await memberWith(firm.id, []);
    const inside = await memberWith(firm.id, []);
    await testPool.query(
      `insert into digest_sends (law_firm_id, user_id, sent_on, item_count)
       values ($1, $2, current_date - 31, 3), ($1, $3, current_date - 30, 2), ($1, $4, current_date - 29, 5)`,
      [firm.id, owner.uid, onCutoff.uid, inside.uid],
    );

    expect(await purgeOldDigestSends(30)).toBe(1);

    const { rows } = await testPool.query(
      'select user_id from digest_sends where law_firm_id = $1 order by sent_on', [firm.id],
    );
    expect(rows.map((r: any) => r.user_id)).toEqual([onCutoff.uid, inside.uid]);
  });
});

/* ------------------------------------------------------------------ */
/*  /api/cron/housekeeping                                             */
/* ------------------------------------------------------------------ */

describe('POST /api/cron/housekeeping', () => {
  it('expires the stale invitation and leaves a live one pending', async () => {
    const firmA = await createFirm();
    const stale = await seedExpiredInvitation(firmA.id);

    const firmB = await createFirm();
    const live = await seedInvitation(firmB.id, { expiresInDays: 7 });

    const res = await cron('/api/cron/housekeeping');
    expect(res.status).toBe(200);

    expect(await invitationStatus(stale)).toBe('expired');
    expect(await invitationStatus(live)).toBe('pending');
  });

  it('a second pass leaves the already-expired invitation exactly as it was', async () => {
    const firm = await createFirm();
    const stale = await seedExpiredInvitation(firm.id);

    await cron('/api/cron/housekeeping');
    const { rows: first } = await testPool.query(
      'select status, updated_at from invitations where id = $1', [stale],
    );

    await cron('/api/cron/housekeeping');
    const { rows: second } = await testPool.query(
      'select status, updated_at from invitations where id = $1', [stale],
    );

    expect(second[0].status).toBe('expired');
    // The sweep's WHERE clause selects `status = 'pending'`, so a second pass
    // must not touch the row at all. A re-touched updated_at would mean the
    // sweep is re-writing rows it already handled, which is how a "sweep
    // everything every night" regression starts.
    expect(second[0].updated_at).toEqual(first[0].updated_at);
  });

  it('reports every sweep it promises to run, by name and in order', async () => {
    const firm = await createFirm();
    const stale = await seedExpiredInvitation(firm.id);

    const res = await cron('/api/cron/housekeeping');

    // The name list IS the contract: these sweeps used to be setInterval timers
    // that never fired, and the only evidence any of them still runs is that it
    // appears here. A sweep silently dropped from the handler goes red on this.
    expect(Object.keys(res.body.housekeeping)).toEqual([
      'templatesGc',
      'invitationsExpiry',
      'signingExpiredUploads',
      'signingExpiredSessions',
      'signingSettledWorkspaces',
      'signingFinalizeRecovery',
      'outboxRetention',
      'firmPurge',
      'unverifiedAccounts',
      'accountErasures',
      'filesSweep',
    ]);
    expect(await invitationStatus(stale)).toBe('expired');
  });

  it('reports a sweep that throws instead of failing the whole pass', async () => {
    const firm = await createFirm();
    const stale = await seedExpiredInvitation(firm.id);
    // Any throwing sweep would do; this is simply the one reachable from a
    // fixture. An account older than the grace period makes the unverified sweep
    // reach Firebase, which the harness leaves without `getUsers`.
    await seedAgedUser(30);

    const res = await cron('/api/cron/housekeeping');

    // Without the per-sweep try/catch in the handler, this is a 500, the
    // scheduler retries the whole pass, and every sweep runs again.
    expect(res.status).toBe(200);
    expect(String(res.body.housekeeping.unverifiedAccounts)).toMatch(/^failed:/);
    // And the pass's other work still stands, and is reported as such.
    expect(res.body.housekeeping.invitationsExpiry).toBe('ok');
    expect(await invitationStatus(stale)).toBe('expired');
  });
});

/* ------------------------------------------------------------------ */
/*  /api/cron/reconcile-billing                                        */
/* ------------------------------------------------------------------ */

describe('POST /api/cron/reconcile-billing', () => {
  it('converges the firm Stripe disagrees with and leaves the in-sync firm untouched', async () => {
    const diverged = await createFirm({ name: 'Diverged Firm' });
    await setFirmPlan(diverged.id, {
      planId: 'professional',
      billingStatus: 'active',
      stripeSubscriptionId: 'sub_diverged',
    });

    const inSync = await createFirm({ name: 'In Sync Firm' });
    await setFirmPlan(inSync.id, {
      planId: 'professional',
      billingStatus: 'active',
      stripeSubscriptionId: 'sub_in_sync',
    });

    stripeFake().subscriptions.retrieve.mockImplementation(async (id: string) => {
      if (id === 'sub_diverged') return stripeSubscription('sub_diverged', diverged.id, 'past_due');
      if (id === 'sub_in_sync') return stripeSubscription('sub_in_sync', inSync.id, 'active');
      throw new Error(`unexpected subscription id ${id}`);
    });

    const res = await cron('/api/cron/reconcile-billing');
    await drainEvents();

    expect(res.status).toBe(200);
    expect(res.body.billingReconciliation.reconciled).toBe(1);
    expect(res.body.billingReconciliation.inSync).toBe(1);

    // A missed webhook leaving a delinquent firm with indefinite free access is
    // the failure this sweep exists to catch, so the stored status is the
    // assertion, not the summary counter.
    expect(await firmBillingStatus(diverged.id)).toBe('past_due');
    expect(await firmBillingStatus(inSync.id)).toBe('active');
  });

  it('a second pass finds the firm in sync and writes nothing more', async () => {
    const firm = await createFirm();
    await setFirmPlan(firm.id, {
      planId: 'professional',
      billingStatus: 'active',
      stripeSubscriptionId: 'sub_repeat',
    });
    stripeFake().subscriptions.retrieve.mockImplementation(
      async () => stripeSubscription('sub_repeat', firm.id, 'past_due'),
    );

    const first = await cron('/api/cron/reconcile-billing');
    await drainEvents();
    expect(first.body.billingReconciliation.reconciled).toBe(1);

    const second = await cron('/api/cron/reconcile-billing');
    await drainEvents();
    expect(second.body.billingReconciliation.reconciled).toBe(0);
    expect(second.body.billingReconciliation.inSync).toBe(1);
    expect(await firmBillingStatus(firm.id)).toBe('past_due');
  });

  it('locks out a firm whose subscription Stripe no longer has, and drops it from the next sweep', async () => {
    const firm = await createFirm();
    await setFirmPlan(firm.id, {
      planId: 'professional',
      billingStatus: 'active',
      stripeSubscriptionId: 'sub_gone',
    });
    const missing: any = new Error('No such subscription');
    missing.statusCode = 404;
    missing.code = 'resource_missing';
    stripeFake().subscriptions.retrieve.mockImplementation(async () => { throw missing; });

    await cron('/api/cron/reconcile-billing');
    await drainEvents();
    expect(await firmBillingStatus(firm.id)).toBe('canceled');

    // handleSubscriptionDeleted nulls the subscription id, so the firm falls out
    // of `listWithStripeSubscription` entirely. If it did not, this second pass
    // would call Stripe again forever for a subscription that does not exist.
    const second = await cron('/api/cron/reconcile-billing');
    expect(second.body.billingReconciliation.scanned).toBe(0);
  });

  it('never calls Stripe for a comped firm', async () => {
    const firm = await createFirm();
    await setFirmPlan(firm.id, {
      planId: 'professional',
      billingStatus: 'active',
      comped: true,
      stripeSubscriptionId: 'sub_comped',
    });
    // Left in its throwing default: a comped firm has no billable subscription,
    // so reaching Stripe for it would fail this case rather than merely counting.

    const res = await cron('/api/cron/reconcile-billing');
    expect(res.body.billingReconciliation.skipped).toBe(1);
    expect(stripeFake().subscriptions.retrieve).not.toHaveBeenCalled();
    expect(await firmBillingStatus(firm.id)).toBe('active');
  });
});

/* ------------------------------------------------------------------ */
/*  /api/cron/reconcile-trust-deposits                                 */
/* ------------------------------------------------------------------ */

describe('POST /api/cron/reconcile-trust-deposits', () => {
  it('posts the settled deposit that has no ledger row, in cents, and touches no other firm', async () => {
    const firmA = await createFirm({ name: 'Trust Recon A' });
    await ownerOf(firmA.id);
    const clientA = await createPersonClient(firmA.id, { name: 'Recon Client' });
    const accountA = await seedTrustAccount(firmA.id);

    const firmB = await createFirm({ name: 'Trust Recon B' });
    await ownerOf(firmB.id);
    const accountB = await seedTrustAccount(firmB.id);

    stripeFake().paymentIntents.list.mockImplementation(() => asyncPages([
      trustPaymentIntent('pi_recon_1', firmA.id, accountA, clientA.id, 250_000),
      // Not a trust deposit: an operating-side payment intent for the same firm.
      { id: 'pi_operating', status: 'succeeded', amount_received: 90_000, metadata: {} },
    ]));

    const res = await cron('/api/cron/reconcile-trust-deposits');
    await drainEvents();

    expect(res.status).toBe(200);
    expect(res.body.trustDepositReconciliation.posted).toBe(1);

    const posted = await trustTransactions(firmA.id);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: 'deposit',
      amount_cents: '250000',
      status: 'completed',
      stripe_payment_intent_id: 'pi_recon_1',
    });
    expect(await trustAccountBalance(accountA)).toBe(250_000);

    // The other firm's IOLTA is not a place a mistake here may land.
    expect(await trustTransactions(firmB.id)).toHaveLength(0);
    expect(await trustAccountBalance(accountB)).toBe(0);
  });

  it('a second pass does not double-post the same deposit', async () => {
    const firm = await createFirm();
    await ownerOf(firm.id);
    const client = await createPersonClient(firm.id);
    const account = await seedTrustAccount(firm.id);
    const pi = trustPaymentIntent('pi_recon_twice', firm.id, account, client.id, 412_600);
    stripeFake().paymentIntents.list.mockImplementation(() => asyncPages([pi]));

    await cron('/api/cron/reconcile-trust-deposits');
    await drainEvents();
    expect(await trustTransactions(firm.id)).toHaveLength(1);

    // `trust_transactions` is append-only by trigger: a double-post cannot be
    // deleted, only reversed. That is what makes this the most expensive
    // idempotency failure on the list.
    const second = await cron('/api/cron/reconcile-trust-deposits');
    await drainEvents();
    expect(second.body.trustDepositReconciliation.posted).toBe(0);
    expect(await trustTransactions(firm.id)).toHaveLength(1);
    expect(await trustAccountBalance(account)).toBe(412_600);
  });

  it('accrues the ACH fee unbilled when the firm has no Stripe customer', async () => {
    const firm = await createFirm();
    await ownerOf(firm.id);
    const client = await createPersonClient(firm.id);
    const account = await seedTrustAccount(firm.id);
    stripeFake().paymentIntents.list.mockImplementation(() => asyncPages([
      trustPaymentIntent('pi_fee_accrual', firm.id, account, client.id, 100_000),
    ]));

    await cron('/api/cron/reconcile-trust-deposits');
    await drainEvents();

    const fees = await trustFees(firm.id);
    expect(fees).toHaveLength(1);
    expect(fees[0].status).toBe('accrued');
    // The platform fronts this fee until the sweep bills it. A deposit that
    // posted with NO fee row is money the platform silently eats.
    expect(Number(fees[0].fee_cents)).toBeGreaterThan(0);
  });

  it('leaves a firm with no settled trust deposits completely alone', async () => {
    const firm = await createFirm();
    await ownerOf(firm.id);
    const account = await seedTrustAccount(firm.id);
    stripeFake().paymentIntents.list.mockImplementation(() => asyncPages([]));

    const res = await cron('/api/cron/reconcile-trust-deposits');
    await drainEvents();

    expect(res.body.trustDepositReconciliation.posted).toBe(0);
    expect(await trustTransactions(firm.id)).toHaveLength(0);
    expect(await trustAccountBalance(account)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  /api/cron/trust-fee-sweep                                          */
/* ------------------------------------------------------------------ */

describe('POST /api/cron/trust-fee-sweep', () => {
  it('charges the accrued fee for the firm with a customer and leaves the other firm accrued', async () => {
    const firmA = await createFirm({ name: 'Fee Sweep A' });
    await setFirmPlan(firmA.id, { planId: 'professional', stripeCustomerId: 'cus_sweep_a' });
    const feeA = await seedAccruedFee(firmA.id, 3_880);

    const firmB = await createFirm({ name: 'Fee Sweep B' });
    const feeB = await seedAccruedFee(firmB.id, 1_200);

    configurePayingStripe();

    const res = await cron('/api/cron/trust-fee-sweep');
    expect(res.status).toBe(200);
    expect(res.body.trustFeeSweep.billed).toBe(1);
    expect(res.body.trustFeeSweep.skippedNoCustomer).toBe(1);

    const rowA = await feeRow(feeA);
    expect(rowA.status).toBe('billed');
    expect(rowA.stripe_invoice_id).toBe('in_finalized');
    // The amount charged is the fee's own cents, not a recomputed value.
    expect(stripeFake().invoiceItems.create.mock.calls[0][0]).toMatchObject({
      customer: 'cus_sweep_a', amount: 3_880, currency: 'usd',
    });

    // A firm with no card on file must be left exactly as it was, ready for a
    // later run, not marked billed and forgotten.
    const rowB = await feeRow(feeB);
    expect(rowB.status).toBe('accrued');
    expect(rowB.stripe_invoice_id).toBeNull();
  });

  it('a second pass does not charge the fee again', async () => {
    const firm = await createFirm();
    await setFirmPlan(firm.id, { planId: 'professional', stripeCustomerId: 'cus_repeat' });
    const fee = await seedAccruedFee(firm.id, 2_500);
    configurePayingStripe();

    await cron('/api/cron/trust-fee-sweep');
    expect(stripeFake().invoices.pay).toHaveBeenCalledTimes(1);

    // The sweep only reads `status = 'accrued'`, so the billed row must not come
    // back. A second charge here is a real double-charge on a real card.
    const second = await cron('/api/cron/trust-fee-sweep');
    expect(second.body.trustFeeSweep.scanned).toBe(0);
    expect(stripeFake().invoices.pay).toHaveBeenCalledTimes(1);
    expect(stripeFake().invoices.create).toHaveBeenCalledTimes(1);
    expect((await feeRow(fee)).status).toBe('billed');
  });

  it('leaves the fee accrued when the card charge fails, so the next run retries it', async () => {
    const firm = await createFirm();
    await setFirmPlan(firm.id, { planId: 'professional', stripeCustomerId: 'cus_declined' });
    const fee = await seedAccruedFee(firm.id, 4_100);

    const s = stripeFake();
    s.invoices.create.mockResolvedValue({ id: 'in_draft' });
    s.invoiceItems.create.mockResolvedValue({ id: 'ii_1' });
    s.invoices.finalizeInvoice.mockResolvedValue({ id: 'in_declined', status: 'open' });
    s.invoices.pay.mockRejectedValue(new Error('Your card was declined.'));
    s.invoices.retrieve.mockResolvedValue({ id: 'in_declined', status: 'open' });

    const res = await cron('/api/cron/trust-fee-sweep');
    expect(res.body.trustFeeSweep.billed).toBe(0);
    expect(res.body.trustFeeSweep.failures).toHaveLength(1);

    const row = await feeRow(fee);
    expect(row.status).toBe('accrued');
    // The finalized invoice id is persisted before the pay attempt precisely so
    // the retry reuses it instead of creating a second charge.
    expect(row.stripe_invoice_id).toBe('in_declined');
  });

  it('does not double-charge when a retry finds the invoice already paid', async () => {
    const firm = await createFirm();
    await setFirmPlan(firm.id, { planId: 'professional', stripeCustomerId: 'cus_already_paid' });
    const fee = await seedAccruedFee(firm.id, 900, { stripeInvoiceId: 'in_already_paid' });

    const s = stripeFake();
    s.invoices.retrieve.mockResolvedValue({ id: 'in_already_paid', status: 'paid' });

    const res = await cron('/api/cron/trust-fee-sweep');
    expect(res.body.trustFeeSweep.billed).toBe(1);
    expect((await feeRow(fee)).status).toBe('billed');
    // Reusing the persisted invoice is the whole point: a fresh create here is a
    // second charge for the same deposit fee.
    expect(s.invoices.create).not.toHaveBeenCalled();
    expect(s.invoices.pay).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  fixtures and helpers                                               */
/* ------------------------------------------------------------------ */

function emailOf(actor: Actor): string {
  return `${actor.uid}@example.test`;
}

/** Every Stripe surface a cron pass may touch, answering harmlessly. */
function configureQuietStripe(): void {
  const s = stripeFake();
  s.subscriptions.retrieve.mockImplementation(async () => null);
  s.paymentIntents.list.mockImplementation(() => asyncPages([]));
}

/** The create → item → finalize → pay ladder `chargeAccruedTrustFee` walks. */
function configurePayingStripe(): void {
  const s = stripeFake();
  s.invoices.create.mockResolvedValue({ id: 'in_draft' });
  s.invoiceItems.create.mockResolvedValue({ id: 'ii_1' });
  s.invoices.finalizeInvoice.mockResolvedValue({ id: 'in_finalized', status: 'open' });
  s.invoices.pay.mockResolvedValue({ id: 'in_finalized', status: 'paid' });
  s.invoices.retrieve.mockResolvedValue({ id: 'in_finalized', status: 'paid' });
}

/** `stripe.paymentIntents.list` auto-paginates, so the fake must be async-iterable. */
function asyncPages(items: any[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => (i < items.length
          ? { value: items[i++], done: false }
          : { value: undefined, done: true }),
      };
    },
  };
}

function trustPaymentIntent(
  id: string, lawFirmId: string, trustAccountId: string, clientId: string, amountCents: number,
) {
  return {
    id,
    status: 'succeeded',
    amount: amountCents,
    amount_received: amountCents,
    created: Math.floor(Date.now() / 1000),
    metadata: { depositType: 'trust', lawFirmId, trustAccountId, clientId },
  };
}

function stripeSubscription(id: string, lawFirmId: string, status: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    status,
    metadata: { lawFirmId },
    cancel_at_period_end: false,
    trial_end: null,
    items: {
      data: [{
        id: `si_${id}`,
        price: { id: PRO_MONTHLY_PRICE },
        current_period_start: now - 86_400,
        current_period_end: now + 86_400,
      }],
    },
  };
}

async function setFirmSettings(lawFirmId: string, settings: Record<string, unknown>): Promise<void> {
  await testPool.query(
    `update law_firms set settings = coalesce(settings, '{}'::jsonb) || $2::jsonb where id = $1`,
    [lawFirmId, JSON.stringify(settings)],
  );
}

/** Merge into `law_firms.plan`, and mirror the columns the repository reads back. */
async function setFirmPlan(lawFirmId: string, plan: Record<string, unknown>): Promise<void> {
  await testPool.query(
    `update law_firms
        set plan = coalesce(plan, '{}'::jsonb) || $2::jsonb,
            plan_id = coalesce($3, plan_id),
            billing_status = coalesce($4, billing_status)
      where id = $1`,
    [
      lawFirmId,
      JSON.stringify(plan),
      (plan.planId as string) ?? null,
      (plan.billingStatus as string) ?? null,
    ],
  );
}

// Reads the COLUMN, not `plan->>'billingStatus'`. Migration 0200 made
// law_firms.billing_status authoritative and deleted the trigger that mirrored
// it into the jsonb, so the jsonb is now a stale copy of whatever was last
// seeded and the app never updates it.
async function firmBillingStatus(lawFirmId: string): Promise<string | null> {
  const { rows } = await testPool.query(
    `select billing_status as status from law_firms where id = $1`, [lawFirmId],
  );
  return rows[0]?.status ?? null;
}

/** An open, unassigned task due today: reaches the firm's owners as recipients. */
async function seedTaskDueToday(lawFirmId: string, title: string): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into tasks (id, law_firm_id, title, status, due_date)
     values ($1, $2, $3, 'open', (now() at time zone 'utc')::date)`,
    [id, lawFirmId, title],
  );
  return id;
}

async function setDigestPrefs(userId: string, hour: number): Promise<void> {
  await testPool.query(
    `update users set timezone = 'UTC', preferences = $2::jsonb, updated_at = now() where id = $1`,
    [userId, JSON.stringify({ notifications: { digest: { enabled: true, hour, days: 'daily' } } })],
  );
}

/** The local hour (0-23) an IANA zone reads at a given instant. Same formula as
 * `shared/utils/localTime.ts#localHourFor`, duplicated here so this file can
 * probe the REAL clock (to locate a DST transition) without importing a
 * frozen-clock-sensitive module at describe-time. */
function localHourAt(tz: string, at: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(at)) % 24;
}

/** The local calendar day ('YYYY-MM-DD') an IANA zone reads at a given instant. */
function localDateAt(tz: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/**
 * Scan forward from `after` (real time) to find the next fall-back transition
 * (a local hour repeats: two consecutive real hours read the same local hour)
 * and the next spring-forward transition (a local hour is skipped: two
 * consecutive real hours jump the local hour by 2) for `tz`. Computed from the
 * live IANA tz database via Intl rather than hardcoded calendar rules, so it
 * keeps working even if a jurisdiction's DST rule changes.
 */
function nextDstTransitions(tz: string, after: Date): { fall: Date; spring: Date } {
  const HOUR_MS = 3_600_000;
  let cur = new Date(after);
  let prevHour = localHourAt(tz, cur);
  let fall: Date | null = null;
  let spring: Date | null = null;
  for (let i = 0; i < 24 * 400 && (!fall || !spring); i += 1) {
    cur = new Date(cur.getTime() + HOUR_MS);
    const hour = localHourAt(tz, cur);
    const delta = (hour - prevHour + 24) % 24;
    if (delta === 0 && !fall) fall = new Date(cur);
    if (delta === 2 && !spring) spring = new Date(cur);
    prevHour = hour;
  }
  if (!fall || !spring) throw new Error(`nextDstTransitions: no transition found for ${tz} within 400 days of ${after.toISOString()}`);
  return { fall, spring };
}

/** The next instant at or after `from` where `tz` reads local hour `hour`. */
function nextLocalHour(tz: string, hour: number, from: Date): Date {
  const HOUR_MS = 3_600_000;
  let cur = new Date(from.getTime() + HOUR_MS);
  for (let i = 0; i < 48; i += 1) {
    if (localHourAt(tz, cur) === hour) return cur;
    cur = new Date(cur.getTime() + HOUR_MS);
  }
  throw new Error(`nextLocalHour: local hour ${hour} not found for ${tz} within 48 hours of ${from.toISOString()}`);
}

/** Same as `setDigestPrefs`, but with an explicit IANA zone for DST cases. */
async function setDigestPrefsTz(userId: string, hour: number, timezone: string): Promise<void> {
  await testPool.query(
    `update users set timezone = $3, preferences = $2::jsonb, updated_at = now() where id = $1`,
    [userId, JSON.stringify({ notifications: { digest: { enabled: true, hour, days: 'daily' } } }), timezone],
  );
}

/** Same as `seedTaskDueToday`, but with an explicit due date for frozen-clock cases. */
async function seedTaskDueOn(lawFirmId: string, title: string, dueDateYmd: string): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into tasks (id, law_firm_id, title, status, due_date)
     values ($1, $2, $3, 'open', $4::date)`,
    [id, lawFirmId, title, dueDateYmd],
  );
  return id;
}

/** An unpaid invoice falling inside the digest window. */
async function seedInvoiceDueToday(
  lawFirmId: string, clientId: string, invoiceNumber: string, totalCents: number,
): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into invoices (id, law_firm_id, client_id, client_context_id, context_type,
                           invoice_number, status, is_paid, total_cents, invoice_date, due_date)
     values ($1, $2, $3, $3, 'client', $4, 'outstanding', false, $5,
             (now() at time zone 'utc')::date, (now() at time zone 'utc')::date)`,
    [id, lawFirmId, clientId, invoiceNumber, totalCents],
  );
  return id;
}

async function digestSendCount(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(
    'select count(*)::int as n from digest_sends where law_firm_id = $1', [lawFirmId],
  );
  return rows[0].n;
}

async function seedInvitation(
  lawFirmId: string, opts: { expiresInDays: number },
): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into invitations (id, law_firm_id, email, invite_type, token, status, expires_at)
     values ($1, $2, $3, 'member', $4, 'pending', now() + make_interval(days => $5::int))`,
    [id, lawFirmId, `invitee-${id.slice(0, 8)}@example.test`, `tok-${id}`, opts.expiresInDays],
  );
  return id;
}

const seedExpiredInvitation = (lawFirmId: string) => seedInvitation(lawFirmId, { expiresInDays: -1 });

async function invitationStatus(id: string): Promise<string | null> {
  const { rows } = await testPool.query('select status from invitations where id = $1', [id]);
  return rows[0]?.status ?? null;
}

async function seedNotification(
  lawFirmId: string, userId: string, opts: { ageDays: number; read: boolean },
): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into notifications (id, law_firm_id, user_id, type, title, body, read, created_at)
     values ($1, $2, $3, 'system', 'Fixture', 'Fixture', $4,
             now() - make_interval(days => $5::int))`,
    [id, lawFirmId, userId, opts.read, opts.ageDays],
  );
  return id;
}

/** A `users` row old enough to be a candidate for the unverified-account sweep. */
async function seedAgedUser(ageDays: number): Promise<string> {
  const uid = `aged-${randomUUID().slice(0, 8)}`;
  await testPool.query(
    `insert into users (id, email, name, user_type, created_at)
     values ($1, $2, 'Aged Account', 'pending', now() - make_interval(days => $3::int))`,
    [uid, `${uid}@example.test`, ageDays],
  );
  return uid;
}

async function notificationExists(id: string): Promise<boolean> {
  const { rows } = await testPool.query('select 1 from notifications where id = $1', [id]);
  return rows.length > 0;
}

async function seedTrustAccount(lawFirmId: string): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into trust_accounts
       (id, law_firm_id, name, account_type, status, book_balance_cents,
        stripe_connected_account_id, stripe_charges_enabled, stripe_onboarding_complete)
     values ($1, $2, 'Cron IOLTA', 'iolta', 'active', 0, $3, true, true)`,
    [id, lawFirmId, `acct_${id.slice(0, 12)}`],
  );
  return id;
}

async function trustTransactions(lawFirmId: string): Promise<any[]> {
  const { rows } = await testPool.query(
    `select type, amount_cents, status, stripe_payment_intent_id
       from trust_transactions where law_firm_id = $1 order by created_at`,
    [lawFirmId],
  );
  return rows;
}

async function trustAccountBalance(accountId: string): Promise<number> {
  const { rows } = await testPool.query(
    'select book_balance_cents from trust_accounts where id = $1', [accountId],
  );
  return Number(rows[0].book_balance_cents);
}

async function trustFees(lawFirmId: string): Promise<any[]> {
  const { rows } = await testPool.query(
    'select id, status, fee_cents, stripe_invoice_id from trust_deposit_fees where law_firm_id = $1',
    [lawFirmId],
  );
  return rows;
}

/**
 * An accrued ACH fee with no trust transaction behind it. The sweep reads
 * `trust_deposit_fees` alone, and `trust_transaction_id` carries no foreign key,
 * so this is the whole world the sweep needs.
 */
async function seedAccruedFee(
  lawFirmId: string, feeCents: number, opts: { stripeInvoiceId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into trust_deposit_fees
       (id, law_firm_id, trust_transaction_id, fee_cents, status, stripe_invoice_id)
     values ($1, $2, $3, $4, 'accrued', $5)`,
    [id, lawFirmId, randomUUID(), feeCents, opts.stripeInvoiceId ?? null],
  );
  return id;
}

async function feeRow(id: string): Promise<any> {
  const { rows } = await testPool.query(
    'select status, fee_cents, stripe_invoice_id from trust_deposit_fees where id = $1', [id],
  );
  return rows[0];
}
