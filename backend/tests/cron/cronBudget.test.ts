/**
 * The cron wall-clock budget, measured against the scheduler that calls it.
 *
 * Cloud Scheduler abandons a daily attempt at 180s. A pass budgeted at 240s
 * was still working when the scheduler gave up, so the attempt was recorded as
 * a failure and retried into the advisory lock, and the pass never got to say
 * how far it got. The budget is therefore 150s: inside the attempt deadline with
 * margin for the last unit of work that started just before it.
 *
 * Shortening is only safe for a pass that resumes. `forEachFirm` persists its
 * rotation cursor, and the trust-fee sweep works a queue whose unreached rows
 * stay `accrued`. `reconcile-billing` and `reconcile-trust-deposits` restart
 * from the same end every run, so a shorter budget would permanently drop more
 * of their tail; they keep the older budget until they can checkpoint.
 *
 * The clock is `Date.now`, advanced by the work itself, so no case waits.
 */
import { createFirm, request, testPool } from '../support/setupInProcess';

const BASE = Date.UTC(2026, 8, 14, 9, 0, 0);

let now = BASE;

beforeEach(() => {
  now = BASE;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('cronDeadline', () => {
  beforeEach(async () => {
    await testPool.query('delete from law_firms');
  });

  it('stops a firm rotation at 150s and records the last firm it finished', async () => {
    const { cronDeadline, forEachFirm } = require('../../src/shared/utils/reminderHelpers');
    for (let i = 0; i < 5; i += 1) await createFirm({ name: `Budget Firm ${i}` });
    const { rows } = await testPool.query('select id from law_firms order by id');
    const order = rows.map((r: any) => r.id);
    await testPool.query('delete from cron_pass_state where pass_name = $1', ['budgetStop']);

    const seen: string[] = [];
    const deadline = cronDeadline();
    // Each firm costs a minute: firms start at 0s, 60s, 120s; the fourth would
    // start at 180s, which is past the budget and past the scheduler.
    const result = await forEachFirm('budgetStop', async (firm: any) => {
      seen.push(firm.id);
      now += 60_000;
    }, { deadline });

    expect(seen).toEqual(order.slice(0, 3));
    expect(result).toEqual({ firmsProcessed: 3, firmsTotal: 5, truncated: true });

    const cursor = await testPool.query(
      'select last_firm_id from cron_pass_state where pass_name = $1',
      ['budgetStop'],
    );
    // The checkpoint is what makes stopping early safe: the next run starts at
    // the fourth firm instead of repeating the first three.
    expect(cursor.rows[0].last_firm_id).toBe(order[2]);
  });

  it('keeps REMINDER_CRON_BUDGET_MS as the override for both budgets', () => {
    const saved = process.env.REMINDER_CRON_BUDGET_MS;
    process.env.REMINDER_CRON_BUDGET_MS = '90000';
    try {
      jest.isolateModules(() => {
        const helpers = require('../../src/shared/utils/reminderHelpers');
        expect(helpers.cronDeadline() - BASE).toBe(90_000);
        expect(helpers.cronDeadline(helpers.NON_RESUMABLE_CRON_BUDGET_MS) - BASE).toBe(90_000);
      });
    } finally {
      if (saved === undefined) delete process.env.REMINDER_CRON_BUDGET_MS;
      else process.env.REMINDER_CRON_BUDGET_MS = saved;
    }
  });
});

describe('the budget each scheduled pass is handed', () => {
  function cron(path: string) {
    return request().post(path).set('x-cloudscheduler', 'true');
  }

  let savedSecret: string | undefined;
  beforeEach(() => {
    savedSecret = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
  });

  it('gives trust-fee-sweep a 150s deadline, inside its 180s scheduler attempt', async () => {
    const stripeService = require('../../src/modules/stripe/stripe.service');
    const sweep = jest.spyOn(stripeService, 'sweepAccruedTrustFees')
      .mockResolvedValue({ scanned: 0, processed: 0, truncated: false } as any);

    const res = await cron('/api/cron/trust-fee-sweep');

    expect(res.body.status).toBe('ok');
    expect(sweep).toHaveBeenCalledTimes(1);
    expect((sweep.mock.calls[0][0] as any).deadline - BASE).toBe(150_000);
  });

  it('leaves reconcile-billing on 240s, because it cannot resume where it stopped', async () => {
    const subscriptions = require('../../src/modules/subscriptions/subscriptions.service');
    const reconcile = jest.spyOn(subscriptions, 'reconcileBillingStatuses')
      .mockResolvedValue({ scanned: 0, processed: 0, truncated: false } as any);

    const res = await cron('/api/cron/reconcile-billing');

    expect(res.body.status).toBe('ok');
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect((reconcile.mock.calls[0][0] as any).deadline - BASE).toBe(240_000);
  });

  it('leaves reconcile-trust-deposits on 240s, for the same reason', async () => {
    const stripeService = require('../../src/modules/stripe/stripe.service');
    const reconcile = jest.spyOn(stripeService, 'reconcileStripeTrustDeposits')
      .mockResolvedValue({ scanned: 0, truncated: false } as any);

    const res = await cron('/api/cron/reconcile-trust-deposits');

    expect(res.body.status).toBe('ok');
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect((reconcile.mock.calls[0][0] as any).deadline - BASE).toBe(240_000);
  });
});
