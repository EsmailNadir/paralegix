/**
 * The invoice row, which is where a firm reads what it is owed.
 *
 * Every branch here puts a number or a claim about money in front of a user, so
 * a wrong one is not a cosmetic bug. The card is pure: it takes an invoice and
 * renders, with no fetching, so these cases need no transport fake.
 *
 * `tests/components/billing/utils.test.ts` covers the arithmetic helpers this
 * card calls. This file covers what the card DOES with their answers, which is
 * the part a user sees.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

import InvoiceListCard from '@/components/billingComp/InvoiceListCard';
import type { Invoice } from '@/types';

/**
 * A month either side of today, so "overdue" never depends on when the suite runs.
 *
 * Built from LOCAL date parts, not `toISOString().slice(0, 10)`. That shortcut
 * formats the UTC day, and west of UTC it can return today's date for a
 * timestamp meant to be yesterday, which silently turns the overdue cases into
 * due-today cases that pass for the wrong reason.
 */
function localDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const PAST = localDay(-30);
const FUTURE = localDay(30);

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    invoiceName: 'Invoice 001',
    totalAmount: 1000,
    amountPaid: 0,
    totalWrittenOff: 0,
    dueDate: FUTURE,
    ...overrides,
  } as Invoice;
}

function renderCard(inv: Invoice, props: Record<string, unknown> = {}) {
  return render(<InvoiceListCard invoice={inv} onOpen={() => {}} {...props} />);
}

describe('the amounts on the card', () => {
  it('shows the invoice total', () => {
    renderCard(invoice({ totalAmount: 1234.5 }));

    expect(screen.getByText('$1,234.50')).toBeInTheDocument();
  });

  it('shows what is left after a partial payment', () => {
    renderCard(invoice({ totalAmount: 1000, amountPaid: 250 }));

    // The number a firm chases. Showing the total here instead would overstate
    // the debt by the amount already collected.
    expect(screen.getByText(/\$750\.00 left/)).toBeInTheDocument();
  });

  it('shows no remaining line once the balance is settled', () => {
    renderCard(invoice({ totalAmount: 1000, amountPaid: 1000, isPaid: true }));

    expect(screen.queryByText(/left/)).not.toBeInTheDocument();
  });
});

describe('how the balance reached zero', () => {
  it('says "Fully paid" when the firm actually collected it', () => {
    renderCard(invoice({ totalAmount: 1000, amountPaid: 1000, isPaid: true }));

    expect(screen.getByText('Fully paid')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
  });

  it('does NOT say "Fully paid" when a write-off closed it', () => {
    renderCard(invoice({ totalAmount: 1000, amountPaid: 0, totalWrittenOff: 1000 }));

    // The rule the component's own comment calls out. Both invoices carry a zero
    // balance, and only one brought money in. "Fully paid" on a written-off
    // invoice tells a firm it collected revenue it never received, and that
    // number then flows into every total the firm reads off this screen.
    expect(screen.queryByText('Fully paid')).not.toBeInTheDocument();
    expect(screen.getByText(/Written off/)).toBeInTheDocument();
  });

  it('names the written-off amount', () => {
    renderCard(invoice({ totalAmount: 1000, amountPaid: 0, totalWrittenOff: 1000 }));

    expect(screen.getByText(/Written off \$1,000\.00/)).toBeInTheDocument();
  });

  it('badges a written-off invoice as "Written Off", not "Paid"', () => {
    renderCard(invoice({ totalAmount: 1000, totalWrittenOff: 1000 }));

    expect(screen.getByText('Written Off')).toBeInTheDocument();
  });

  it('treats a part-paid, part-written-off invoice as written off', () => {
    renderCard(invoice({ totalAmount: 1000, amountPaid: 400, totalWrittenOff: 600 }));

    // The mixed case, and the one a simple `amountPaid >= total` check gets
    // wrong. The firm collected 400 of 1000, so this is not a paid invoice.
    expect(screen.queryByText('Fully paid')).not.toBeInTheDocument();
    expect(screen.getByText(/Written off/)).toBeInTheDocument();
  });

  it('renders nothing about payment for a zero-value invoice', () => {
    renderCard(invoice({ totalAmount: 0, amountPaid: 0, totalWrittenOff: 0 }));

    // Neither paid nor owed. "Fully paid" on an empty invoice is a claim about
    // money that was never billed.
    expect(screen.queryByText('Fully paid')).not.toBeInTheDocument();
    expect(screen.queryByText(/left/)).not.toBeInTheDocument();
  });
});

describe('the due date line', () => {
  it('reads "Due" for a future date', () => {
    renderCard(invoice({ totalAmount: 1000, dueDate: FUTURE }));

    expect(screen.getByText(/Due /)).toBeInTheDocument();
    expect(screen.queryByText(/Overdue /)).not.toBeInTheDocument();
  });

  it('reads "Overdue" once the date has passed', () => {
    renderCard(invoice({ totalAmount: 1000, dueDate: PAST }));

    // Matched with the date attached, because the status badge says "Overdue"
    // too. A bare /Overdue/ finds both and would still pass if the due LINE
    // silently kept saying "Due".
    expect(screen.getByText(/Overdue [A-Z][a-z]{2} \d/)).toBeInTheDocument();
  });

  it('shows no due line on a paid invoice', () => {
    renderCard(invoice({ totalAmount: 1000, amountPaid: 1000, isPaid: true, dueDate: PAST }));

    // A settled invoice is not overdue. Showing a red "Overdue" against money
    // already collected sends a firm chasing a client who has paid. Checked
    // against the badge AND the due line, since both would carry the word.
    expect(screen.queryByText(/Overdue/)).not.toBeInTheDocument();
  });

  it('shows no due line on a written-off invoice', () => {
    renderCard(invoice({ totalAmount: 1000, totalWrittenOff: 1000, dueDate: PAST }));

    // Same reason. Nothing is collectable, so nothing is late.
    expect(screen.queryByText(/Overdue [A-Z]/)).not.toBeInTheDocument();
  });
});

describe('the status badge', () => {
  it('reads "Unpaid" before any money arrives', () => {
    renderCard(invoice({ totalAmount: 1000, amountPaid: 0, dueDate: FUTURE }));

    expect(screen.getByText('Unpaid')).toBeInTheDocument();
  });

  it('reads "Partially Paid" once some money has arrived', () => {
    renderCard(invoice({ totalAmount: 1000, amountPaid: 250, dueDate: FUTURE }));

    expect(screen.getByText('Partially Paid')).toBeInTheDocument();
  });

  it('marks a part-paid invoice past its date as overdue', () => {
    renderCard(invoice({ totalAmount: 1000, amountPaid: 250, dueDate: PAST }));

    // A partial payment does not stop the rest being late. Dropping the overdue
    // half here hides an aging balance behind a calm blue badge.
    expect(screen.getByText('Partially Paid (Overdue)')).toBeInTheDocument();
  });

  it('marks an unpaid invoice past its date as overdue', () => {
    renderCard(invoice({ totalAmount: 1000, amountPaid: 0, dueDate: PAST }));

    expect(screen.getByText('Overdue')).toBeInTheDocument();
  });
});

describe('the secondary badges', () => {
  it('badges an invoice on a payment plan', () => {
    renderCard(invoice({ paymentPlan: { enabled: true } } as Partial<Invoice>));

    expect(screen.getByText('Payment plan')).toBeInTheDocument();
  });

  it('does not badge an invoice whose payment plan is off', () => {
    renderCard(invoice({ paymentPlan: { enabled: false } } as Partial<Invoice>));

    // The negative half. A badge that always rendered would satisfy the case
    // above and tell every client they are on an instalment schedule.
    expect(screen.queryByText('Payment plan')).not.toBeInTheDocument();
  });

  it('badges an invoice that is part of a split set', () => {
    renderCard(invoice({ splitGroupId: 'split-1' } as Partial<Invoice>));

    // Split invoices bill several clients for one matter. Without the badge a
    // firm reads one share as the whole bill.
    expect(screen.getByText('Split Set')).toBeInTheDocument();
  });

  it('does not badge an ordinary invoice as a split set', () => {
    renderCard(invoice());

    expect(screen.queryByText('Split Set')).not.toBeInTheDocument();
  });
});

describe('a voided invoice', () => {
  it('is badged Voided, with no balance, due line, or "Fully paid"', () => {
    renderCard(invoice({ status: 'voided', dueDate: PAST, totalAmount: 1000 }));

    // Badge and amount line both name the state, as "Written Off" does.
    expect(screen.getAllByText('Voided')).toHaveLength(2);
    expect(screen.queryByText(/left/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Overdue/)).not.toBeInTheDocument();
    expect(screen.queryByText('Fully paid')).not.toBeInTheDocument();
  });
});

describe('the refund-due indicator', () => {
  it('shows a Refund due badge beside the status when a refund is owed', () => {
    renderCard(invoice({ status: 'voided', refundDue: { amount: 50, reason: 'voided' } } as Partial<Invoice>));

    expect(screen.getByText('Refund due')).toBeInTheDocument();
  });

  it('shows no badge when no refund is owed', () => {
    renderCard(invoice({ refundDue: null } as Partial<Invoice>));

    expect(screen.queryByText('Refund due')).not.toBeInTheDocument();
  });
});
