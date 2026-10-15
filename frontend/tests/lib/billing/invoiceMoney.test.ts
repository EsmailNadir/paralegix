/**
 * Invoice money helpers and the line-item editor preview, against integer-cent
 * oracles. Every expected value is a whole number of cents computed from the
 * inputs in integer arithmetic, then compared as dollars.
 */
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import {
  getInvoiceCreditBalance,
  getInvoiceRemainingBalance,
  getInvoiceTotal,
  installmentAmountFromPaymentCount,
  summarizeInvoiceMoney,
} from '@/components/billingComp/utils';
import { useInvoiceLineItemEditor } from '@/hooks/billingHooks/useInvoiceLineItemEditor';
import type { BillingContext, Invoice } from '@/types';
import { makeTestQueryClient } from '../../support/renderWithProviders';

const inv = (fields: Record<string, unknown>) => fields as unknown as Invoice;

function lcg(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

describe('getInvoiceTotal', () => {
  it('uses the canonical total including zero, without flat fee fallback', () => {
    expect(getInvoiceTotal(inv({ totalAmount: 12.34, flatFeesAmount: 99 }))).toBe(12.34);
    expect(getInvoiceTotal(inv({ totalAmount: 0, flatFeesAmount: 0.01 }))).toBe(0);
    expect(getInvoiceTotal(inv({ totalAmount: 0, flatFeesAmount: 0 }))).toBe(0);
    expect(getInvoiceTotal(inv({ totalAmount: '7.77' }))).toBe(7.77);
  });
});

describe('getInvoiceRemainingBalance and getInvoiceCreditBalance with one kind of settlement', () => {
  it('is exact when only payments settle the invoice', () => {
    const rand = lcg(31337);
    for (let i = 0; i < 5000; i += 1) {
      const total = 1 + Math.floor(rand() * 5_000_000);
      const paid = Math.floor(rand() * (total + 1));
      const invoice = inv({ totalAmount: total / 100, amountPaid: paid / 100, totalWrittenOff: 0 });
      expect(Math.round(getInvoiceRemainingBalance(invoice) * 100)).toBe(total - paid);
      expect(getInvoiceCreditBalance(invoice)).toBe(0);
    }
  });

  it('reports the credit when an invoice is settled past its total', () => {
    const invoice = inv({ totalAmount: 100.1, amountPaid: 100.2, totalWrittenOff: 0 });
    expect(getInvoiceRemainingBalance(invoice)).toBe(0);
    expect(Math.round(getInvoiceCreditBalance(invoice) * 100)).toBe(10);
  });

  it('treats a voided invoice as owing nothing', () => {
    expect(getInvoiceRemainingBalance(inv({ status: 'voided', totalAmount: 50, amountPaid: 0 }))).toBe(0);
  });
});

describe('summarizeInvoiceMoney sums in integer cents', () => {
  it('matches the cent oracle over 300 seeded books of 1 to 40 invoices', () => {
    const rand = lcg(2026);
    for (let round = 0; round < 300; round += 1) {
      const invoices: Invoice[] = [];
      let billed = 0;
      let paidSum = 0;
      let outstanding = 0;
      for (let k = 0; k < 1 + Math.floor(rand() * 40); k += 1) {
        const total = 1 + Math.floor(rand() * 2_000_000);
        const paid = Math.floor(rand() * (total + 1));
        const voided = rand() < 0.1;
        invoices.push(inv({
          id: `i${k}`, totalAmount: total / 100, amountPaid: paid / 100, totalWrittenOff: 0, status: voided ? 'voided' : 'sent',
        }));
        if (voided) continue;
        billed += total;
        paidSum += paid;
        outstanding += total - paid;
      }
      const s = summarizeInvoiceMoney(invoices);
      expect({ round, billed: Math.round(s.totalBilled * 100) }).toEqual({ round, billed });
      expect({ round, paid: Math.round(s.totalPaid * 100) }).toEqual({ round, paid: paidSum });
      expect({ round, out: Math.round(s.outstanding * 100) }).toEqual({ round, out: outstanding });
      // The headline numbers are themselves whole-cent dollars, no float dust.
      expect(s.totalBilled).toBe(billed / 100);
      expect(s.outstanding).toBe(outstanding / 100);
    }
  });
});

describe('installmentAmountFromPaymentCount', () => {
  it.each([
    [100, 3, 33.34],
    [0.01, 3, 0.01],
    [0.05, 2, 0.03],
    [1000, 7, 142.86],
    [10_000.01, 4, 2500.01],
    [4503599.62, 7, 643371.38],
  ])('splits %p over %p payments at %p each, rounding each slice UP in cents', (balance, count, each) => {
    expect(installmentAmountFromPaymentCount(balance, count)).toBe(each);
    // The plan always covers the balance and overshoots by less than one cent per payment.
    const cents = Math.round(balance * 100);
    const slice = Math.round(each * 100);
    expect(slice * count).toBeGreaterThanOrEqual(cents);
    expect(slice * count - cents).toBeLessThan(count);
  });

  it('returns NaN for a non-positive balance, a sub-cent balance or zero payments', () => {
    expect(installmentAmountFromPaymentCount(0, 3)).toBeNaN();
    expect(installmentAmountFromPaymentCount(-5, 3)).toBeNaN();
    expect(installmentAmountFromPaymentCount(0.004, 3)).toBeNaN();
    expect(installmentAmountFromPaymentCount(100, 0)).toBeNaN();
  });
});

describe('the line-item editor preview', () => {
  const CONTEXT: BillingContext = { type: 'client', lawFirmId: 'firm-a', entityId: 'client-1' };

  function previewFor(opts: {
    taxRate?: number | null;
    time?: Array<{ hours: number; rate: number }>;
    fees?: number[];
    expenses?: number[];
    amountPaid?: number;
    totalAmount?: number;
  }) {
    const invoice = inv({
      id: 'inv-1', totalAmount: opts.totalAmount ?? 0, amountPaid: opts.amountPaid ?? 0, totalWrittenOff: 0,
      taxRate: opts.taxRate ?? null, timeEntries: [], flatFees: [], expenses: [],
    });
    const qc = makeTestQueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(
      () => useInvoiceLineItemEditor({ context: CONTEXT, invoice, onSaved: jest.fn() }),
      { wrapper },
    );
    act(() => {
      result.current.setTimeEntries((opts.time ?? []).map((t, i) => ({
        rowKey: `t${i}`, id: `t${i}`, description: 'T', hours: t.hours, rate: t.rate, amount: 0,
      })) as never);
      result.current.setFlatFees((opts.fees ?? []).map((a, i) => ({ rowKey: `f${i}`, id: `f${i}`, description: 'F', amount: a })) as never);
      result.current.setExpenses((opts.expenses ?? []).map((a, i) => ({ rowKey: `e${i}`, id: `e${i}`, description: 'E', amount: a })) as never);
    });
    return result.current.preview;
  }

  /** round half up of cents * thousandths / 100000, in exact integer arithmetic (products stay under 2^53). */
  const taxCents = (subtotal: number, rate: number) =>
    Math.floor((subtotal * Math.round(rate * 1000) * 2 + 100_000) / 200_000);

  it.each([
    [7.25, 123_456], [8.875, 123_456], [0.5, 123_457], [7.25, 99_999], [6.625, 33_333], [13, 7],
  ])('previews %p%% tax on %p cents as the exact rounded cents, total = subtotal + tax', (rate, subtotal) => {
    const p = previewFor({ taxRate: rate, fees: [subtotal / 100] });
    const want = taxCents(subtotal, rate);
    expect(p.subtotal).toBe(subtotal / 100);
    expect(Math.round(p.tax * 100)).toBe(want);
    expect(p.total).toBe((subtotal + want) / 100);
  });

  it('adds an hourly line, a fee and an expense in cents and applies the rate to the sum', () => {
    const p = previewFor({
      taxRate: 8.875,
      time: [{ hours: 2, rate: 125.5 }, { hours: 0.25, rate: 80 }],
      fees: [19.99],
      expenses: [3.33, 0.01],
    });
    const subtotal = 25_100 + 2_000 + 1_999 + 333 + 1;
    expect(p.subtotal).toBe(subtotal / 100);
    expect(Math.round(p.tax * 100)).toBe(taxCents(subtotal, 8.875));
  });

  it('shows how far an edit would settle past the new total, in whole cents', () => {
    const p = previewFor({ amountPaid: 100.07, fees: [33.33, 33.33, 33.33] });
    expect(p.subtotal).toBe(99.99);
    expect(p.creditIfSaved).toBe(0.08);
  });
});
