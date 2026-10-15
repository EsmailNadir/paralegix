/**
 * A payment cannot be named against an instalment that is already paid.
 */
import { usePlanKit } from './planKit';

const k = usePlanKit(1000);

beforeEach(async () => {
  expect((await k.setPlan()).status).toBe(200);
});

it('refuses a second payment against a paid instalment and leaves the first payment backing it', async () => {
  expect((await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' })).status).toBe(200);
  const second = await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-02' });

  expect(second.status).toBe(400);
  expect(JSON.stringify(second.body)).toMatch(/already paid/i);
  expect(await k.payments()).toHaveLength(1);
  const rows = await k.rows();
  expect(rows[0].status).toBe('paid');
  expect(rows[0].matched_payment_index).toBe(0);
  await k.expectScheduleMatchesBalance(undefined, 'refused payment on a paid row');
});

it('still takes the same payment when it names an open instalment instead', async () => {
  await k.pay({ paymentAmount: 250, installmentIndex: 0, paidDate: '2026-04-01' });
  const res = await k.pay({ paymentAmount: 250, installmentIndex: 1, paidDate: '2026-04-02' });

  expect(res.status).toBe(200);
  expect((await k.rows()).map((r) => r.status)).toEqual(['paid', 'paid', 'pending', 'pending']);
  await k.expectScheduleMatchesBalance(undefined, 'payment on the next open row');
});
