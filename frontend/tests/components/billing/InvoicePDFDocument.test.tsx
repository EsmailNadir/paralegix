import React from 'react';
import { render, screen } from '@testing-library/react';

// react-pdf renders to a PDF, not the DOM. Each primitive becomes a plain
// element so the document's text content can be read back.
jest.mock('@react-pdf/renderer', () => {
  const ReactLocal = require('react');
  const el = (tag: string) =>
    function Primitive({ children, render }: any) {
      return ReactLocal.createElement(tag, null, render ? render({ pageNumber: 1, totalPages: 1 }) : children);
    };
  return {
    Document: el('div'),
    Page: el('div'),
    Text: el('span'),
    View: el('div'),
    Image: el('div'),
    StyleSheet: { create: (s: any) => s },
  };
});

import InvoicePDFDocument from '@/components/billingComp/InvoicePDFDocument';

const base: any = {
  id: 'inv-1',
  invoiceNumber: 'INV-1001',
  totalAmount: 50000,
  amountPaid: 0,
  isPaid: false,
  status: 'sent',
  dueDate: '2099-01-31',
  nextPaymentDate: '2099-01-31',
  payments: [],
  timeEntries: [],
  flatFees: [],
  expenses: [],
};

const renderPdf = (invoice: any) => render(<InvoicePDFDocument invoice={invoice} lawFirmName="Firm" />);

describe('InvoicePDFDocument balance band', () => {
  it('states Voided for a voided invoice and never claims it is paid or due', () => {
    renderPdf({ ...base, status: 'voided', amountPaid: 0 });
    expect(screen.getByText('Voided')).toBeInTheDocument();
    expect(screen.queryByText('Paid in full')).not.toBeInTheDocument();
    expect(screen.queryByText('Balance due')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Due$/)).not.toBeInTheDocument();
    expect(screen.queryByText('Next payment')).not.toBeInTheDocument();
  });

  it('does not print a balance due row for a voided invoice that recorded payments', () => {
    renderPdf({ ...base, status: 'voided', amountPaid: 10000, payments: [{ date: '2026-01-02', amount: 10000 }] });
    expect(screen.getByText('Voided')).toBeInTheDocument();
    expect(screen.queryByText('Balance due')).not.toBeInTheDocument();
    expect(screen.queryByText('Credit due')).not.toBeInTheDocument();
  });

  it('still states Paid in full for a paid invoice', () => {
    renderPdf({ ...base, status: 'paid', isPaid: true, amountPaid: 50000 });
    expect(screen.getByText('Paid in full')).toBeInTheDocument();
    expect(screen.queryByText('Voided')).not.toBeInTheDocument();
  });

  it('still states Balance due for an outstanding invoice', () => {
    renderPdf(base);
    expect(screen.getByText('Balance due')).toBeInTheDocument();
    expect(screen.queryByText('Voided')).not.toBeInTheDocument();
    expect(screen.getByText('Due')).toBeInTheDocument();
  });

  it('factors totalWrittenOff into balance due and shows Credits / Adjustments', () => {
    renderPdf({
      ...base,
      totalAmount: 500,
      amountPaid: 150,
      totalWrittenOff: 100,
      payments: [{ date: '2026-01-02', amount: 150 }],
    });
    expect(screen.getAllByText('Balance due').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Credits / Adjustments')).toBeInTheDocument();
    // The totals row under the payments table: 500 - 150 paid - 100 credits.
    const balanceRows = screen.getAllByText('Balance due').map((label) => label.parentElement?.textContent);
    expect(balanceRows).toContain('Balance due$250.00');
  });

  it('states Paid in full when amountPaid + totalWrittenOff covers the total', () => {
    renderPdf({
      ...base,
      totalAmount: 500,
      amountPaid: 300,
      totalWrittenOff: 200,
      payments: [{ date: '2026-01-02', amount: 300 }],
    });
    expect(screen.getByText('Paid in full')).toBeInTheDocument();
    expect(screen.getByText('Credits / Adjustments')).toBeInTheDocument();
  });

  // Float dollars leave residue: 0.3 - 0.1 - 0.2 is -2.8e-17 and 1.1 - 1.0 - 0.1
  // is 8.3e-17. Settled in cents, both invoices are exactly paid in full.
  it.each([
    { totalAmount: 0.3, amountPaid: 0.1, totalWrittenOff: 0.2 },
    { totalAmount: 1.1, amountPaid: 1.0, totalWrittenOff: 0.1 },
  ])('states Paid in full, not a $0.00 credit or balance due, for $totalAmount settled by $amountPaid paid + $totalWrittenOff written off', (amounts) => {
    renderPdf({ ...base, ...amounts, payments: [{ date: '2026-01-02', amount: amounts.amountPaid }] });
    expect(screen.getByText('Paid in full')).toBeInTheDocument();
    expect(screen.queryByText('Credit due to client')).not.toBeInTheDocument();
    expect(screen.queryByText('Credit due')).not.toBeInTheDocument();
  });

  it('states the exact credit for an over-settled invoice', () => {
    renderPdf({ ...base, totalAmount: 100, amountPaid: 120.5, payments: [{ date: '2026-01-02', amount: 120.5 }] });
    expect(screen.getByText('Credit due to client')).toBeInTheDocument();
    expect(screen.getAllByText('$20.50').length).toBeGreaterThan(0);
  });
});
