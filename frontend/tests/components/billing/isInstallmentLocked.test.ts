/**
 * Which payment-plan rows the bulk schedule editor must leave alone. Plan rows
 * no longer carry Stripe links of their own (the invoice's one payment link
 * names the row it charges), so a row is locked only once it is paid.
 *
 * RED IF: an unpaid row is locked because of stale Stripe fields, or a paid
 * row becomes editable.
 */
import { isInstallmentLocked } from '@/components/billingComp/invoiceDetailHelpers';

it('locks a paid row', () => {
  expect(isInstallmentLocked({ status: 'paid' })).toBe(true);
});

it('leaves an unpaid row editable even with leftover Stripe fields', () => {
  const leftover = { status: 'pending', stripeInvoiceId: 'in_1', stripePaymentStatus: 'pending' };
  expect(isInstallmentLocked(leftover)).toBe(false);
  expect(isInstallmentLocked({ status: 'overdue' })).toBe(false);
});
