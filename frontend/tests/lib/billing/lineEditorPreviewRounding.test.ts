/**
 * The line-editor preview prices hourly lines and tax with the same half-up integer rounding as the server.
 */
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { useInvoiceLineItemEditor } from '@/hooks/billingHooks/useInvoiceLineItemEditor';
import type { Invoice } from '@/types';
import { makeTestQueryClient } from '../../support/renderWithProviders';

function preview(taxRate: number | null, time: Array<{ hours: number; rate: number }>, fees: number[]) {
  const invoice = { id: 'i', totalAmount: 0, amountPaid: 0, totalWrittenOff: 0, taxRate, timeEntries: [], flatFees: [], expenses: [] } as unknown as Invoice;
  const qc = makeTestQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(QueryClientProvider, { client: qc }, children);
  const { result } = renderHook(() => useInvoiceLineItemEditor({ context: { type: 'client', lawFirmId: 'f', entityId: 'c' }, invoice, onSaved: jest.fn() }), { wrapper });
  act(() => {
    result.current.setTimeEntries(time.map((t, i) => ({ rowKey: `t${i}`, id: `t${i}`, hours: t.hours, rate: t.rate, amount: 0 })) as never);
    result.current.setFlatFees(fees.map((a, i) => ({ rowKey: `f${i}`, id: `f${i}`, amount: a })) as never);
  });
  return result.current.preview;
}

it('previews 0.35 h at $27.50 as 962.5 cents rounded up', () => {
  expect(Math.round(preview(null, [{ hours: 0.35, rate: 27.5 }], []).subtotal * 100)).toBe(963);
});
it.each([[7.25, 3000, 218], [9.975, 10000, 998]])('previews %p%% tax on %p cents as %p', (rate, subtotal, want) => {
  expect(Math.round(preview(rate, [], [subtotal / 100]).tax * 100)).toBe(want);
});

it('keeps an amount added after creation in the previewed total, outside the tax base', () => {
  const invoice = {
    id: 'i', totalAmount: 110.1, amountPaid: 0, totalWrittenOff: 0, taxRate: null, timeEntries: [], expenses: [],
    flatFees: [], amountAdjustmentNotes: [{ amount: 10.1, note: 'extra' }],
  } as unknown as Invoice;
  const qc = makeTestQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(QueryClientProvider, { client: qc }, children);
  const { result } = renderHook(() => useInvoiceLineItemEditor({ context: { type: 'client', lawFirmId: 'f', entityId: 'c' }, invoice, onSaved: jest.fn() }), { wrapper });
  act(() => { result.current.setFlatFees([{ rowKey: 'f0', id: 'f0', amount: 100 }] as never); });
  expect(Math.round(result.current.preview.total * 100)).toBe(11010);
  expect(Math.round(result.current.preview.delta * 100)).toBe(0);
});
