# Invoices

An invoice is the bill you send a client for your work. Invoices pull together your time entries, flat fees, and expenses into one document you can send and get paid on. You will find them on the **Invoices** tab of the [Billing](/billing/overview) section.

## Invoices Belong to a Matter or a Client

Every invoice is tied to one of two things: a **matter** (work on a specific matter) or a **client** (work billed directly, not tied to a matter). This is what it means for a matter or a client to have "its own" invoices.

### Matter invoices

Most invoices are raised on a matter. Open the matter, go to its **Billing** tab, and use **Generate Invoice** to bill the work logged on that matter. You can also set each team member's hourly rate and add flat fees here. The matter keeps its own list of invoices, so you can always see what has been billed and paid against it.

### Client invoices

A client can also be billed directly, for work that is not tied to a specific matter. A client's **Billing** tab shows the full picture: their direct invoices plus every invoice from their matters, with a Total Billed, Total Paid, and Outstanding snapshot.

### Where the work comes from

An invoice is built from **unbilled work**: time entries, flat fees, and expenses. That work can be logged from the [Billing hub](/billing/overview), a matter's **Time Tracking** tab, or directly from a [task](/tasks/overview). Tasks do not have their own invoices. Their time rolls up into the matter or client they belong to, ready to be invoiced.

## The Invoices List

The Invoices tab lists every invoice your firm has created, across all statuses.

Each row shows the invoice number, its status, the invoice date, the matter, the total, and how much is still owed. You can **search** invoices or filter by matter, client, status, or date range.

### Invoice Statuses

| Status | Meaning |
|---|---|
| **Unpaid** | Sent, nothing paid yet |
| **Partially Paid** | Some payment received, a balance remains |
| **Paid** | Paid in full |
| **Overdue** | Past its due date with a balance still owed |
| **Written Off** | Settled with a credit note instead of a payment |

## Creating an Invoice

You build an invoice from unbilled work, for one matter, split across clients, or many matters at once. The full walkthrough is on [Generating Invoices](/billing/generating-invoices).

## The Invoice Page

Open any invoice to see the full picture.

The top of the page shows the invoice number, status, dates, and client. The tiles below break down the **invoice total**, the amount **paid**, any **credits or write-offs**, and the **remaining balance**, with a bar showing how much has been applied.

The **Line Items** tab lists every charge, with its description, rate, hours, and amount. The **Payments** tab lists each payment recorded against the invoice. The **Summary** on the right adds it all up: subtotal, minus what has been paid, equals the remaining balance.

### Tax on Invoices

If your firm applies **tax**, an invoice shows a subtotal, the tax line (with its rate), and the total, both on the invoice page and on the PDF you send. The rate prefills from your billing settings and can be changed on each invoice. Most US states exempt legal services, so tax is off unless an admin turns it on. You set the default rate and label under the **Settings** page in [Rates & setup](/billing/time-and-expenses#charge-codes-and-rates).

## Sending and Getting Paid

From the invoice page you can **Send to Client** to email the invoice, **Record Payment** when money comes in, or **Setup Payment Plan** to split the balance into installments. Credits and write-offs are also applied here and show in the **Credits / Write-offs** tile. When late fees are turned on and an invoice is past due, an **Apply Late Fee** action appears so you can add the fee (see [Payments and Plans](/billing/payments#late-fees)).

For the full detail on recording payments, online payments, payment plans, and recurring retainers, see [Payments and Plans](/billing/payments).

::: info
When a payment covers the full balance, the invoice automatically flips to **Paid**. A partial payment moves it to **Partially Paid** and keeps the remaining balance visible until it is settled.
:::
