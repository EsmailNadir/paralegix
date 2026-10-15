/**
 * Settlement helpers do their arithmetic in integer cents so exactly-settled invoices owe nothing.
 */
import {
  getInvoiceCreditBalance, getInvoiceRemainingBalance, getInvoiceStatusKey, isAwaitingPayment,
} from '@/components/billingComp/utils';
import type { Invoice } from '@/types';

const settled = (t: number, p: number, w: number) => ({
  id: 'i', status: 'sent', isPaid: false, totalAmount: t, amountPaid: p, totalWrittenOff: w,
  creditNotes: [{ id: 'c', amount: w }], dueDate: '2099-01-01',
}) as unknown as Invoice;

it('48640.26 settled by 22800.09 paid + 25840.17 written off owes nothing and is credited', () => {
  const invoice = settled(48640.26, 22800.09, 25840.17);
  expect(getInvoiceRemainingBalance(invoice)).toBe(0);
  expect(isAwaitingPayment(invoice)).toBe(false);
  expect(getInvoiceStatusKey(invoice)).toBe('credited');
});

it('12016.56 settled by 8696.29 + 3320.27 has no credit balance', () => {
  expect(getInvoiceCreditBalance(settled(12016.56, 8696.29, 3320.27))).toBe(0);
});
