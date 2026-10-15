/**
 * Offline contract for the invoice line-item editor hook.
 *
 * B04.2 requirement:
 * "P0: useBillingWorkbench, useFirmInvoices, useFirmTimeEntries, useInvoiceLineItemEditor, usePaymentDates"
 * "Mutation refreshes every affected total; permission/billing failure restores editor state;
 *  an old summary cannot overwrite a successful edit."
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';

import { useInvoiceLineItemEditor } from '@/hooks/billingHooks/useInvoiceLineItemEditor';
import type { BillingContext, Invoice } from '@/types';
import { makeTestQueryClient } from '../support/renderWithProviders';
import { setupApiMock } from '../support/apiMock';

const api = setupApiMock();
let queryClient: QueryClient;

const CONTEXT: BillingContext = {
  type: 'matter',
  lawFirmId: 'firm-a',
  entityId: 'matter-1',
};

const BASE_INVOICE: Invoice = {
  id: 'inv-1',
  lawFirmId: 'firm-a',
  matterId: 'matter-1',
  invoiceNumber: 'INV-001',
  status: 'sent',
  issueDate: '2026-09-01',
  dueDate: '2026-09-15',
  totalAmount: 300,
  amountPaid: 100,
  totalWrittenOff: 0,
  taxRate: 10, // 10% tax
  timeEntries: [
    {
      id: 'te-1',
      description: 'Drafting contract',
      hours: 2,
      rate: 100,
      amount: 200,
    },
  ],
  flatFees: [
    {
      id: 'ff-1',
      description: 'Filing fee',
      amount: 50,
    },
  ],
  expenses: [
    {
      id: 'ex-1',
      description: 'Courier service',
      amount: 25,
    },
  ],
} as unknown as Invoice;

function createWrapper(qc: QueryClient) {
  return function TestWrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  queryClient = makeTestQueryClient();
});

describe('useInvoiceLineItemEditor contract', () => {
  it('does not send requests before submission and initializes closed', async () => {
    const onSaved = jest.fn();
    const { result } = renderHook(
      () => useInvoiceLineItemEditor({ context: CONTEXT, invoice: BASE_INVOICE, onSaved }),
      { wrapper: createWrapper(queryClient) },
    );

    expect(result.current.open).toBe(false);
    expect(result.current.submitting).toBe(false);
    expect(result.current.error).toBeNull();
    expect(api.calls()).toHaveLength(0);

    // Submitting with null invoice safely returns false
    const { result: nullResult } = renderHook(
      () => useInvoiceLineItemEditor({ context: CONTEXT, invoice: null, onSaved }),
      { wrapper: createWrapper(queryClient) },
    );
    let submitResult: boolean = true;
    await act(async () => {
      submitResult = await nullResult.current.submit();
    });
    expect(submitResult).toBe(false);
    expect(api.calls()).toHaveLength(0);
  });

  it('open lifecycle seeds positional keys and converts decimal hours to hours/minutes inputs', async () => {
    const onSaved = jest.fn();
    const { result } = renderHook(
      () => useInvoiceLineItemEditor({ context: CONTEXT, invoice: BASE_INVOICE, onSaved }),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setOpen(true);
    });

    expect(result.current.open).toBe(true);
    expect(result.current.timeEntries).toHaveLength(1);
    expect(result.current.timeEntries[0].rowKey).toBe('time-te-1-0');
    expect(result.current.timeEntries[0].hoursInput).toBe('2');
    expect(result.current.timeEntries[0].minutesInput).toBe('');
    expect(result.current.flatFees[0].rowKey).toBe('fee-ff-1-0');
    expect(result.current.expenses[0].rowKey).toBe('expense-ex-1-0');
  });

  it('mutation refreshes every affected total in preview with integer-cent precision', async () => {
    const onSaved = jest.fn();
    const { result } = renderHook(
      () => useInvoiceLineItemEditor({ context: CONTEXT, invoice: BASE_INVOICE, onSaved }),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setOpen(true);
    });

    // Initial totals:
    // time: 2h * $100 = $200
    // flat fee: $50
    // expense: $25
    // subtotal = $275.00
    // tax (10%) = $27.50
    // total = $302.50
    // settled = $100.00 (amountPaid)
    // delta = $302.50 - $300.00 = $2.50
    expect(result.current.preview.subtotal).toBe(275);
    expect(result.current.preview.tax).toBe(27.5);
    expect(result.current.preview.total).toBe(302.5);
    expect(result.current.preview.hours).toBe(2);
    expect(result.current.preview.settled).toBe(100);
    expect(result.current.preview.creditIfSaved).toBe(0);
    expect(result.current.preview.delta).toBe(2.5);

    // Edit time entry: change to 3 hours 30 minutes (3.5h) at $200/hr
    act(() => {
      result.current.setTimeEntries([
        {
          ...result.current.timeEntries[0],
          hoursInput: '3',
          minutesInput: '30',
          rate: 200,
        },
      ]);
    });

    // New time total: 3.5h * $200 = $700
    // subtotal: $700 + $50 + $25 = $775
    // tax: 10% of $775 = $77.50
    // total: $852.50
    // hours: 3.5
    // delta: $852.50 - $300.00 = $552.50
    expect(result.current.preview.hours).toBe(3.5);
    expect(result.current.preview.subtotal).toBe(775);
    expect(result.current.preview.tax).toBe(77.5);
    expect(result.current.preview.total).toBe(852.5);
    expect(result.current.preview.delta).toBe(552.5);
  });

  it('detects overpayment credit when preview total falls below settled amount', async () => {
    const onSaved = jest.fn();
    const { result } = renderHook(
      () => useInvoiceLineItemEditor({ context: CONTEXT, invoice: BASE_INVOICE, onSaved }),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setOpen(true);
    });

    // Reduce line items below settled amount ($100):
    // 0 time entries, 0 flat fees, only $50 expense + $5 tax = $55 total
    act(() => {
      result.current.setTimeEntries([]);
      result.current.setFlatFees([]);
      result.current.setExpenses([
        {
          ...result.current.expenses[0],
          amount: 50,
        },
      ]);
    });

    // Total = $55, settled = $100 -> creditIfSaved = $45
    expect(result.current.preview.total).toBe(55);
    expect(result.current.preview.creditIfSaved).toBe(45);
  });

  it('successful submit: dispatches PATCH, strips transient fields, invokes onSaved, and invalidates billing queries', async () => {
    const onSaved = jest.fn();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const updatedInvoice: Invoice = {
      ...BASE_INVOICE,
      totalAmount: 350,
    };

    api.patch(
      '/api/lawfirms/firm-a/billing/invoices/matter/matter-1/inv-1/line-items',
      { invoice: updatedInvoice },
    );

    const { result } = renderHook(
      () => useInvoiceLineItemEditor({ context: CONTEXT, invoice: BASE_INVOICE, onSaved }),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setOpen(true);
    });

    let success: boolean = false;
    await act(async () => {
      success = await result.current.submit();
    });

    expect(success).toBe(true);
    expect(onSaved).toHaveBeenCalledWith(updatedInvoice);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['billing'] });
    expect(result.current.open).toBe(false);

    // Verify dispatched payload stripped transient fields
    const [call] = api.calls('PATCH');
    expect(call.method).toBe('PATCH');
    const body = call.body as any;
    expect(body.timeEntries[0]).toEqual({
      id: 'te-1',
      description: 'Drafting contract',
      hours: 2,
      rate: 100,
      amount: 200,
    });
    expect(body.timeEntries[0].rowKey).toBeUndefined();
    expect(body.timeEntries[0].hoursInput).toBeUndefined();
    expect(body.timeEntries[0].minutesInput).toBeUndefined();
  });

  it('billing/permission failure restores editor state and does not lose draft changes', async () => {
    const onSaved = jest.fn();

    api.patch(
      '/api/lawfirms/firm-a/billing/invoices/matter/matter-1/inv-1/line-items',
      { status: 403, body: { code: 'PERMISSION_DENIED', message: 'User cannot edit finalized invoices' } },
    );

    const { result } = renderHook(
      () => useInvoiceLineItemEditor({ context: CONTEXT, invoice: BASE_INVOICE, onSaved }),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setOpen(true);
    });

    // Make an edit that user spent time writing
    act(() => {
      result.current.setTimeEntries([
        {
          ...result.current.timeEntries[0],
          description: 'Deep legal analysis of indemnification clause',
          hoursInput: '5',
          rate: 350,
        },
      ]);
    });

    let success: boolean = true;
    await act(async () => {
      success = await result.current.submit();
    });

    expect(success).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();

    // Crucial contract invariants:
    // 1. Editor must stay open so user is not kicked out
    expect(result.current.open).toBe(true);
    // 2. Error message is exposed
    expect(result.current.error).toHaveProperty('message', 'User cannot edit finalized invoices');
    // 3. User's edits are NOT destroyed
    expect(result.current.timeEntries[0].description).toBe('Deep legal analysis of indemnification clause');
    expect(result.current.timeEntries[0].hoursInput).toBe('5');
    expect(result.current.timeEntries[0].rate).toBe(350);
  });

  it('server overpay refusal sets overpayCredit and succeeds when confirmed with acknowledgement', async () => {
    const onSaved = jest.fn();

    // Step 1: Server refuses with INVOICE_TOTAL_BELOW_SETTLED
    api.patch(
      '/api/lawfirms/firm-a/billing/invoices/matter/matter-1/inv-1/line-items',
      {
        status: 400,
        body: {
          code: 'INVOICE_TOTAL_BELOW_SETTLED',
          message: 'Total amount is less than payments received',
          details: { creditAmount: 45 },
        },
      },
    );

    const { result } = renderHook(
      () => useInvoiceLineItemEditor({ context: CONTEXT, invoice: BASE_INVOICE, onSaved }),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setOpen(true);
    });

    let firstSubmit: boolean = true;
    await act(async () => {
      firstSubmit = await result.current.submit(false);
    });

    expect(firstSubmit).toBe(false);
    expect(result.current.open).toBe(true);
    expect(result.current.overpayCredit).toBe(45);

    // Step 2: User confirms overpayment acknowledgement -> re-submits with acknowledgeOverpayment: true
    const updatedInvoice: Invoice = { ...BASE_INVOICE, totalAmount: 55 };
    api.patch(
      '/api/lawfirms/firm-a/billing/invoices/matter/matter-1/inv-1/line-items',
      { invoice: updatedInvoice },
    );

    let secondSubmit: boolean = false;
    await act(async () => {
      secondSubmit = await result.current.submit(true);
    });

    expect(secondSubmit).toBe(true);
    expect(result.current.open).toBe(false);
    expect(result.current.overpayCredit).toBeNull();
    expect(onSaved).toHaveBeenCalledWith(updatedInvoice);

    const calls = api.calls('PATCH');
    expect(calls).toHaveLength(2);
    expect((calls[1].body as any).acknowledgeOverpayment).toBe(true);
  });

  it('an old summary or parent re-render cannot overwrite a draft edit while open', async () => {
    const onSaved = jest.fn();
    const { result, rerender } = renderHook(
      ({ inv }) => useInvoiceLineItemEditor({ context: CONTEXT, invoice: inv, onSaved }),
      {
        initialProps: { inv: BASE_INVOICE },
        wrapper: createWrapper(queryClient),
      },
    );

    act(() => {
      result.current.setOpen(true);
    });

    // Make a draft change
    act(() => {
      result.current.setTimeEntries([
        {
          ...result.current.timeEntries[0],
          description: 'Unsaved draft description',
        },
      ]);
    });

    expect(result.current.timeEntries[0].description).toBe('Unsaved draft description');

    // Parent re-renders with a slightly different or stale invoice summary
    const staleInvoice: Invoice = {
      ...BASE_INVOICE,
      totalAmount: 999,
      timeEntries: [
        {
          id: 'te-1',
          description: 'Old parent summary description',
          hours: 1,
          rate: 100,
          amount: 100,
        },
      ],
    } as unknown as Invoice;

    rerender({ inv: staleInvoice });

    // Draft edit must NOT be wiped by parent re-render
    expect(result.current.open).toBe(true);
    expect(result.current.timeEntries[0].description).toBe('Unsaved draft description');

    // Explicit reset discards draft and syncs with invoice
    act(() => {
      result.current.reset();
    });
    expect(result.current.timeEntries[0].description).toBe('Old parent summary description');
  });
});
