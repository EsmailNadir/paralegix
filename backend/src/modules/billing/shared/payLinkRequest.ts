// What an invoice's secure payment link asks the client to pay. One link per
// invoice asks for either the full balance or one payment-plan installment,
// named by the row's stable `installment_id` (`invoices.pay_link_installment_id`).
// The request email, the fee quote, the pay page, the portal and the checkout
// all read the amount from here, so they can never quote one figure and charge
// another.
import { toCents } from './money';

export interface PayLinkRequest {
  /** What the invoice still owes: total less paid less written off, never negative. */
  balanceCents: number;
  /** The targeted installment's stable id, or null for the full balance. */
  installmentId: string | null;
  /** The targeted row's 1-based position in the schedule, or null. */
  installmentNumber: number | null;
  /** What the link charges: the balance, or the row's amount capped at it. */
  requestedCents: number;
  /** False once there is nothing to charge, or the targeted row is paid or gone. */
  isPayable: boolean;
}

function invoiceBalanceCents(invoice: any): number {
  return Math.max(0, toCents(invoice?.totalAmount || 0)
    - toCents(invoice?.amountPaid || 0) - toCents(invoice?.totalWrittenOff || 0));
}

/**
 * The position of the open plan row with this stable id, or -1. A row that is
 * paid, or a plan that is switched off, has nothing left for a link to collect.
 */
function openInstallmentIndex(invoice: any, installmentId: string): number {
  const plan = invoice?.paymentPlan;
  if (!plan?.enabled || !Array.isArray(plan.expectedPayments)) return -1;
  return plan.expectedPayments.findIndex((row: any) => row?.id === installmentId && row.status !== 'paid');
}

/** The amount, and the installment if any, that the invoice's payment link asks for. */
export function payLinkRequest(invoice: any): PayLinkRequest {
  const balanceCents = invoiceBalanceCents(invoice);
  const installmentId = typeof invoice?.payLinkInstallmentId === 'string' && invoice.payLinkInstallmentId
    ? invoice.payLinkInstallmentId
    : null;
  if (!installmentId) {
    return { balanceCents, installmentId: null, installmentNumber: null, requestedCents: balanceCents, isPayable: balanceCents > 0 };
  }
  const index = openInstallmentIndex(invoice, installmentId);
  if (index < 0) {
    return { balanceCents, installmentId, installmentNumber: null, requestedCents: 0, isPayable: false };
  }
  const rowCents = toCents(invoice.paymentPlan.expectedPayments[index].amount || 0);
  const requestedCents = Math.max(0, Math.min(rowCents, balanceCents));
  return { balanceCents, installmentId, installmentNumber: index + 1, requestedCents, isPayable: requestedCents > 0 };
}
