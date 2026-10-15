/**
 * RecordPaymentModal is presentational: the invoice detail view and the client
 * Billing tab own the payment state and the save. What it owns is pinned here.
 *
 * - The amount field is labelled, so a screen reader announces what the one
 *   required field is. Red if the label loses its `htmlFor`.
 * - It cannot be dismissed while the payment is being saved, the same rule
 *   EditPaymentModal follows. Red if Cancel or Escape still close it.
 * - Stacked over another dialog it sits above it. Red if `stacked` stops
 *   raising the overlay.
 */
import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import RecordPaymentModal from '@/components/billingComp/RecordPaymentModal';
import { renderWithProviders } from '../../support/renderWithProviders';
import { scanAccessibility } from '../../support/accessibility';

function props(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    onClose: jest.fn(),
    invoiceLabel: 'INV-7',
    totalAmount: 500,
    amountPaid: 100,
    remainingBalance: 400,
    amount: '150',
    onAmountChange: jest.fn(),
    allowOverpayment: false,
    onAllowOverpaymentChange: jest.fn(),
    note: '',
    onNoteChange: jest.fn(),
    submitting: false,
    onSubmit: jest.fn(),
    ...overrides,
  };
}

describe('RecordPaymentModal', () => {
  it('labels the amount field', async () => {
    const { container } = renderWithProviders(<RecordPaymentModal {...props()} />);

    expect(screen.getByLabelText(/Payment Amount/)).toHaveValue(150);
    expect((await scanAccessibility(container)).violations).toEqual([]);
  });

  it('records the payment from the primary button', async () => {
    const onSubmit = jest.fn();
    renderWithProviders(<RecordPaymentModal {...props({ onSubmit })} />);

    await userEvent.click(screen.getByRole('button', { name: 'Record Payment' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('cannot be cancelled or escaped while the payment is saving', async () => {
    const onClose = jest.fn();
    renderWithProviders(<RecordPaymentModal {...props({ onClose, submitting: true })} />);

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Cancel when nothing is saving', async () => {
    const onClose = jest.fn();
    renderWithProviders(<RecordPaymentModal {...props({ onClose })} />);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('states the remaining balance it was given, which nets credits as well as payments', () => {
    // 500 total, 100 paid, 100 credited: 300 remains, not the 400 that total - paid gives.
    renderWithProviders(<RecordPaymentModal {...props({ totalAmount: 500, amountPaid: 100, remainingBalance: 300 })} />);

    expect(screen.getByText(/^Invoice: INV-7/).textContent).toBe(
      'Invoice: INV-7 · Total: $500.00 · Paid: $100.00 · Remaining: $300.00',
    );
  });

  it('leaves Paid and Remaining out when there is nothing to report', () => {
    renderWithProviders(<RecordPaymentModal {...props({ amountPaid: 0, remainingBalance: 0 })} />);

    expect(screen.getByText(/^Invoice: INV-7/).textContent).toBe('Invoice: INV-7 · Total: $500.00');
  });

  it('raises above another dialog when stacked', () => {
    renderWithProviders(<RecordPaymentModal {...props({ stacked: true })} />);

    const dialog = screen.getByRole('dialog', { name: 'Record Payment' });
    expect(dialog.closest('.fixed')).toHaveClass('z-[60]');
  });
});
