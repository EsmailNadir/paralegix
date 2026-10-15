# Billing Automation

Billing is where Paralegix does the most work for you. Rates resolve themselves, invoices number and re-status themselves, unbilled work surfaces on its own, and payments made online land against the right invoice without anyone typing them in.

## Work Surfaces Itself

The Billing hub keeps a running **Needs attention** queue built from the current state of your books: overdue invoices, and time and expenses that are billable but not yet on an invoice. Each row has the action it needs next, so you can record a payment or bill an entry straight from the list.

The totals above it, awaiting payment, unbilled work, overdue, and collected, are recalculated from your live data every time you open the page.

## Rates Resolve Themselves

You never pick an hourly rate when logging time unless you want to override it. Paralegix walks a fixed priority order and uses the first rate it finds:

1. A rate typed directly on the time entry
2. The person's rate on that specific matter
3. The client's rate for that person
4. The client's default rate
5. The charge code's rate for that person
6. The charge code's default rate
7. The person's firm-wide default rate
8. The firm's default rate

The same order is used for invoices, retainer overage, and reports, so a rate never changes meaning depending on where you look at it.

See [Time and Expenses](/billing/time-and-expenses).

## Time Rounding

Firms that bill in fixed increments can have every time entry rounded up automatically when it is saved.

Turn on **Round time entries up to a fixed increment** and choose the increment: 6 minutes (0.1 hour), 10, 12, 15, or 30 minutes. A 4-minute entry saved under a 6-minute increment is stored as 0.1 hours.

This is off by default so no firm has its existing hours quietly changed. Once it is on it applies at save time, so the number you see on the entry is the number that will be billed.

## Invoice Numbering

Invoice numbers are allocated for you from a per-firm counter, in your chosen prefix and series, at the moment the invoice is created. Two people creating invoices at the same time can never get the same number.

Invoices generated from a retainer plan get their own retainer-series number so they are easy to pick out.

## Invoice Status Is Derived, Not Typed

You never mark an invoice overdue. Status is worked out from the amounts and the due date every time the invoice is read:

| Status | When it applies |
|---|---|
| **Outstanding** | Issued, nothing paid yet, not past due |
| **Overdue** | Past its due date with a balance remaining |
| **Partially paid** | Some payment recorded, balance remaining |
| **Paid** | Balance fully settled |
| **Credited** | Settled by a credit note or write-off |

Because it is derived, recording a payment or issuing a credit note updates the status instantly, and the reminder and late-fee automation always act on the true state of the invoice.

## Automatic Late Fees

A one-time late fee can be added to invoices that go past due. This is a flat charge, a percentage of the remaining balance, or both stacked, and it is not interest.

Configure it in **Billing > Rates & setup > Settings**:

- **Flat amount** and **percentage of balance** both apply and add together.
- **Grace period** is the number of days past due before a fee is eligible.
- **Apply the late fee automatically** hands it to the daily job. With it off, you apply the fee to each invoice yourself.

A late fee is only ever charged once per invoice, whether it was applied automatically or by hand.

## Tax Defaults

If your jurisdiction taxes legal services, turn on tax and set a default rate. New invoices prefill with that rate and each invoice can still override it. This is off by default because most US states exempt legal services.

## Payments Record Themselves

When online payments are set up and a client pays through the portal or a hosted invoice link:

- the payment is recorded against the invoice automatically,
- the status is recalculated, so a fully settled invoice becomes paid,
- the client is emailed a receipt showing what they paid and what is left,
- the firm is notified in-app that money arrived, and
- refunds, reversals, and disputes flow back the same way, so an invoice never stays marked paid after the money is taken back.

Client payment receipt emails are on by default and can be switched off in billing settings.

## Payment Plans

Splitting an invoice into installments creates a schedule of expected payments. Each pending installment gets its own pre-due reminder to the client, and payments applied to the invoice are tracked against the schedule so you can see which installments are still outstanding.

## Trust Accounting

Trust ledgers are append-only. A completed transaction is never edited or deleted, and a correction is recorded as a reversing entry, so the audit trail is complete without anyone having to maintain it.

Set a minimum balance on a client's trust account and Paralegix watches it. Crossing below the minimum triggers a portal message and email asking the client to replenish, and notifies the firm. See [Reminders and Alerts](/automation/reminders-and-alerts).

## Things to Know

- **Automatic late fees need the schedule to be on.** With auto-apply off, everything else about the fee still works, you just apply it per invoice.
- **Nothing is sent to a client without you.** Invoice reminders and receipts are automatic, but issuing an invoice is always a deliberate action.
- **Rounding is forward-only.** Time entries are rounded up to the increment, never down.

## Related

- [Billing overview](/billing/overview)
- [Time and Expenses](/billing/time-and-expenses)
- [Generating Invoices](/billing/generating-invoices)
- [Invoices](/billing/invoices)
- [Payments and Plans](/billing/payments)
