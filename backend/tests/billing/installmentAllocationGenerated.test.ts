/**
 * Deterministic generated arithmetic test suite for payment installment allocation
 * and schedule rebalancing.
 *
 * B06.5 requirement:
 * "Add deterministic generated cases for split allocation, rounded time, late fees,
 *  balance reconciliation, and payment installment allocation. Save the seed when
 *  a case fails. Include zero, one cent, large allowed totals, many recipients,
 *  and permutations where ordering should not change the aggregate result."
 */

import '../support/setupInProcess';

import {
  _rebuildSchedule,
  _rebalancePendingInstallments,
} from '../../src/modules/billing/invoices/invoices.service';

const { toCents, fromCents, MAX_PLAN_INSTALLMENTS } = require('../../src/modules/billing/shared/money');

const SEED = 20260902;

/**
 * Deterministic seeded PRNG (mulberry32), so a failing generated case is
 * reproducible from the seed printed alongside it rather than lost to Math.random().
 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('B06.5: payment installment allocation generated arithmetic invariants', () => {
  describe('rebuildSchedule arithmetic invariants', () => {
    it('returns null for zero or negative remaining balance', () => {
      const plan = { installmentAmount: 100, frequencyDays: 30, planStartDate: '2026-04-01' };
      expect(_rebuildSchedule(plan, 0)).toBeNull();
      expect(_rebuildSchedule(plan, -50)).toBeNull();
    });

    it('single-cent edge case: remaining $0.01 with $100 installment produces one $0.01 installment', () => {
      const plan = { installmentAmount: 100, frequencyDays: 30, planStartDate: '2026-04-01' };
      const schedule = _rebuildSchedule(plan, 0.01);
      expect(schedule).toHaveLength(1);
      expect(schedule![0].amount).toBe(0.01);
      expect(schedule![0].status).toBe('pending');
      expect(schedule![0].dueDate).toBe('2026-04-01');
    });

    it('exact divisor: $1,000 remaining with $250 installments produces 4 equal installments of $250', () => {
      const plan = { installmentAmount: 250, frequencyDays: 30, planStartDate: '2026-04-01' };
      const schedule = _rebuildSchedule(plan, 1000);
      expect(schedule).toHaveLength(4);
      expect(schedule!.map((s: any) => s.amount)).toEqual([250, 250, 250, 250]);
      expect(schedule!.reduce((sum: number, s: any) => sum + toCents(s.amount), 0)).toBe(100_000);
    });

    it('uneven remainder: $1,000 remaining with $300 installments puts remaining $100 on final installment', () => {
      const plan = { installmentAmount: 300, frequencyDays: 30, planStartDate: '2026-04-01' };
      const schedule = _rebuildSchedule(plan, 1000);
      expect(schedule).toHaveLength(4);
      expect(schedule!.map((s: any) => s.amount)).toEqual([300, 300, 300, 100]);
      expect(schedule!.reduce((sum: number, s: any) => sum + toCents(s.amount), 0)).toBe(100_000);
    });

    it('deterministic generated test (100 random cases): installment amounts sum EXACTLY to remaining balance', () => {
      const rand = mulberry32(SEED);

      for (let iteration = 0; iteration < 100; iteration += 1) {
        // Random balance from 1 cent up to $50,000.00 (5,000,000 cents)
        const remainingCents = 1 + Math.floor(rand() * 5_000_000);
        // Random installment amount from 1 cent up to balance
        const installmentCents = 1 + Math.floor(rand() * remainingCents);
        const frequencies = [7, 14, 30];
        const frequencyDays = frequencies[Math.floor(rand() * frequencies.length)];

        const remaining = fromCents(remainingCents);
        const installmentAmount = fromCents(installmentCents);

        const plan = {
          installmentAmount,
          frequencyDays,
          planStartDate: '2026-04-01',
        };

        const schedule = _rebuildSchedule(plan, remaining);
        expect(schedule).not.toBeNull();

        // Invariant 1: Sum of generated installments in cents equals remainingCents EXACTLY
        const totalScheduledCents = schedule!.reduce((sum: number, s: any) => sum + toCents(s.amount), 0);
        expect(totalScheduledCents).toBe(remainingCents);

        // Invariant 2: Every installment amount is strictly positive
        for (const item of schedule!) {
          expect(toCents(item.amount)).toBeGreaterThan(0);
        }

        // Invariant 3: All installments except possibly the last equal the configured installment amount
        for (let i = 0; i < schedule!.length - 1; i += 1) {
          expect(toCents(schedule![i].amount)).toBe(installmentCents);
        }

        // Invariant 4: The last installment is <= configured installment amount
        const lastCents = toCents(schedule![schedule!.length - 1].amount);
        expect(lastCents).toBeLessThanOrEqual(installmentCents);

        // Invariant 5: Expected count matches ceiling division
        const expectedCount = Math.ceil(remainingCents / installmentCents);
        expect(schedule!).toHaveLength(expectedCount);
      }
    });
  });

  describe('rebalancePendingInstallments invariants with settled history', () => {
    it('returns settled rows only (no pending tail) when new remaining balance is zero', () => {
      const existing = [
        { dueDate: '2026-04-01', amount: 200, status: 'paid', matchedPaymentIndex: 0 },
        { dueDate: '2026-05-01', amount: 200, status: 'paid', matchedPaymentIndex: 1 },
        { dueDate: '2026-06-01', amount: 200, status: 'pending', matchedPaymentIndex: null },
      ];
      const plan = { installmentAmount: 200, frequencyDays: 30, planStartDate: '2026-04-01' };

      const rebalanced = _rebalancePendingInstallments(plan, existing, 0);
      expect(rebalanced).toHaveLength(2);
      expect(rebalanced!.every((r: any) => r.status === 'paid')).toBe(true);
      expect(rebalanced![0].matchedPaymentIndex).toBe(0);
      expect(rebalanced![1].matchedPaymentIndex).toBe(1);
    });

    it('returns null when remaining is zero and there were no settled rows', () => {
      const existing = [
        { dueDate: '2026-04-01', amount: 200, status: 'pending', matchedPaymentIndex: null },
      ];
      const plan = { installmentAmount: 200, frequencyDays: 30, planStartDate: '2026-04-01' };
      expect(_rebalancePendingInstallments(plan, existing, 0)).toBeNull();
    });

    it('deterministic generated test (50 random cases): preserves paid rows verbatim and pending tail sums to new remaining balance', () => {
      const rand = mulberry32(SEED + 1);

      for (let iteration = 0; iteration < 50; iteration += 1) {
        // Seed 1 to 5 settled payments
        const settledCount = 1 + Math.floor(rand() * 5);
        const settledInstallments: any[] = [];
        for (let i = 0; i < settledCount; i += 1) {
          const paidCents = 1000 + Math.floor(rand() * 50_000);
          settledInstallments.push({
            dueDate: `2026-0${i + 1}-01`,
            amount: fromCents(paidCents),
            status: 'paid',
            matchedPaymentIndex: i,
          });
        }

        // Add 2 pending installments to existing schedule
        const existingSchedule = [
          ...settledInstallments,
          { dueDate: '2026-07-01', amount: 500, status: 'pending', matchedPaymentIndex: null },
          { dueDate: '2026-08-01', amount: 500, status: 'pending', matchedPaymentIndex: null },
        ];

        // New remaining balance from 1 cent to $20,000
        const newRemainingCents = 1 + Math.floor(rand() * 2_000_000);
        const installmentCents = 500 + Math.floor(rand() * 100_000);
        const plan = {
          installmentAmount: fromCents(installmentCents),
          frequencyDays: 30,
          planStartDate: '2026-04-01',
        };

        const rebalanced = _rebalancePendingInstallments(plan, existingSchedule, newRemainingCents);
        expect(rebalanced).not.toBeNull();

        // Invariant 1: Settled installments are preserved verbatim in initial positions
        for (let i = 0; i < settledCount; i += 1) {
          expect(rebalanced![i]).toMatchObject(settledInstallments[i]);
        }

        // Invariant 2: The pending tail sums to newRemainingCents EXACTLY
        const pendingTail = rebalanced!.slice(settledCount);
        expect(pendingTail.length).toBeGreaterThan(0);
        const pendingSumCents = pendingTail.reduce((sum: number, r: any) => sum + toCents(r.amount), 0);
        expect(pendingSumCents).toBe(newRemainingCents);

        // Invariant 3: All pending tail items have status: 'pending' and null matchedPaymentIndex
        for (const item of pendingTail) {
          expect(item.status).toBe('pending');
          expect(item.matchedPaymentIndex).toBeNull();
          expect(toCents(item.amount)).toBeGreaterThan(0);
        }
      }
    });

    it('caps large installment expansions at the plan limit with the remainder packed into the last row', () => {
      // Balance $1,000.00 (100,000 cents) with a tiny $1.00 installment would be 1,000 installments.
      const plan = { installmentAmount: 1, frequencyDays: 30, planStartDate: '2026-04-01' };
      const rebalanced = _rebalancePendingInstallments(plan, [], 100_000);

      expect(rebalanced).toHaveLength(MAX_PLAN_INSTALLMENTS);

      // Every row before the last is the regular $1.00 installment.
      for (let i = 0; i < MAX_PLAN_INSTALLMENTS - 1; i += 1) {
        expect(toCents(rebalanced![i].amount)).toBe(100);
      }

      // The last row holds the whole remainder: 100,000 - 119 * 100 = 88,100 cents.
      expect(toCents(rebalanced![MAX_PLAN_INSTALLMENTS - 1].amount)).toBe(88_100);

      const totalCents = rebalanced!.reduce((sum: number, r: any) => sum + toCents(r.amount), 0);
      expect(totalCents).toBe(100_000);
    });

    it('counts paid installments toward the plan limit', () => {
      const settledRows = Array.from({ length: 20 }, (_, i) => ({
        dueDate: `2025-${String((i % 12) + 1).padStart(2, '0')}-01`,
        amount: 1,
        status: 'paid',
        matchedPaymentIndex: i,
      }));
      const plan = { installmentAmount: 1, frequencyDays: 30, planStartDate: '2026-04-01' };
      const rebalanced = _rebalancePendingInstallments(plan, settledRows, 100_000);

      // 20 paid rows plus at most 100 pending rows: the plan never exceeds the limit.
      expect(rebalanced).toHaveLength(MAX_PLAN_INSTALLMENTS);
      const pending = rebalanced!.filter((r: any) => r.status === 'pending');
      expect(pending).toHaveLength(MAX_PLAN_INSTALLMENTS - 20);
      expect(pending.reduce((sum: number, r: any) => sum + toCents(r.amount), 0)).toBe(100_000);
    });

    it('still leaves one pending row to carry the balance when paid rows already fill the limit', () => {
      const settledRows = Array.from({ length: MAX_PLAN_INSTALLMENTS }, (_, i) => ({
        dueDate: `2024-${String((i % 12) + 1).padStart(2, '0')}-01`,
        amount: 1,
        status: 'paid',
        matchedPaymentIndex: i,
      }));
      const plan = { installmentAmount: 1, frequencyDays: 30, planStartDate: '2026-04-01' };
      const rebalanced = _rebalancePendingInstallments(plan, settledRows, 5_000);

      const pending = rebalanced!.filter((r: any) => r.status === 'pending');
      expect(pending).toHaveLength(1);
      expect(toCents(pending[0].amount)).toBe(5_000);
    });
  });
});
