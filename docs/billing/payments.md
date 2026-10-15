# Payments and Plans

After an invoice is sent, this is how you get paid and keep track of what is owed: recording payments, letting clients pay online, splitting a balance into a payment plan, and setting up retainers that bill automatically.

## Recording a Payment

When a payment comes in, open the invoice and click **Record Payment**.

The **amount** field starts pre-filled with the full remaining balance; edit it down if you are recording a partial payment. You can also add an optional **invoice number**, an optional **note** (a check number, "Wire transfer", and so on), and the next expected payment date. Save it, and the invoice's status and remaining balance update immediately.

- A payment that covers the full balance flips the invoice to **Paid**.
- A partial payment moves it to **Partially Paid** and keeps the remaining balance visible.

## Online Payments

If you connect **Stripe** under payment settings, you can request **online payments** so clients pay an invoice directly from a secure link, by card or bank transfer. Look for **Online Payments** on the invoice page and use **Open Payment Settings** to connect. Once set up, online payments are recorded against the invoice automatically when the client pays.

### Processing fees

Every online payment has a processing fee. Your firm pays it unless you pass it on to your client. You set a default for each method under **Settings > Payments**, in **Online payment fees**, and you can change it for a single invoice when you request payment.

- **Bank transfer:** 0.8% (up to $5) plus a 0.9% Paralegix fee. Turn on **Clients pay the bank transfer fee** and your client pays it on top, so your firm receives the full invoice amount.
- **Card:** when your firm pays, the fee is Stripe's 2.9% + 30 cents plus a 0.9% Paralegix fee.

### Credit card fees

Turn on **Clients pay a fee on credit cards** to have your client cover the card fee. The rules for card fees are set by law and by the card networks, so it works like this:

- **Credit cards only.** The law doesn't allow a fee on debit or prepaid cards.
- **Never more than 3%.** The fee covers your Stripe cost and is never more than 3% of the payment (2% for firms in Colorado). On invoices under about $2,300 the 3% limit can leave you up to 30 cents short.
- **Clients see it first.** Clients see the exact fee after entering their card and before they pay, and can switch to bank transfer.
- **Some states don't allow it.** Card fees aren't available for firms in California, Connecticut, Maine or Massachusetts.
- **No Paralegix fee.** Paralegix takes no fee on credit card payments where your client pays the card fee.
- **Refunds include the fee.** If you refund a payment, refund the card fee too: all of it for a full refund, or the same share for a partial one. The payment on the invoice shows the exact amount.

You also choose what happens with two kinds of card:

- **Debit and prepaid cards:** accept them and your firm pays their processing fee, or don't accept them so clients pay by credit card or bank transfer.
- **Cards issued outside the US:** accept them and your firm pays Stripe's extra 1.5%, or only accept cards issued in the US.

Before you can turn card fees on, you confirm two things:

1. **The date your firm told Stripe** that it adds a credit card fee. Card networks require 30 days' notice, so the setting turns on 30 days after that date. To give the notice, [contact Stripe support](https://support.stripe.com/contact) and tell them your firm will add a fee to credit card payments.
2. **Your engagement letters tell clients about the credit card fee.**

Your firm also needs Stripe connected under **Settings > Payments**. Card fee rules depend on your firm's state, so if it isn't set yet, the card fee section asks for it. If Stripe gave your firm a rate lower than the standard 2.9% + 30 cents, enter it under **Your Stripe card rate**, because the card fee can't be more than what Stripe charges you.

### What your client sees

Your client opens the link and chooses card or bank transfer. When the card fee is on, the card option says that US credit cards add a fee and debit cards have no fee. After entering a card, your client sees one of these before anything is charged:

- **A credit card:** the exact card fee and the total, with the option to pay by bank transfer instead.
- **A debit or prepaid card:** no card fee, and the invoice amount.
- **A card you don't accept:** a short explanation and the option to use a different card or pay by bank transfer.

The card fee is listed separately on your client's receipt.

## Payment Plans

For a large invoice, you can split the balance into scheduled installments. On the invoice, click **Setup Payment Plan**.

You can set an optional **down payment**, then choose how to divide the rest:

- **Fixed amount** lets you set the size of each installment.
- **Split into N** divides the balance into an even number of payments for you.

Pick the **frequency** (for example, monthly) and create the plan. Paralegix tracks each installment's due date and marks them off as payments come in.

## Recurring Plans (Retainers)

For ongoing work, a **recurring plan** bills a matter or client automatically on a set schedule, without you creating each invoice by hand. Open the **Recurring plans** tab in the billing hub and click **Add Evergreen Retainer Plan**.

Set who to bill, the **amount** and any **included hours**, how often it repeats (for example, every 1 month), a start date, and when the plan ends (manually or on a specific date). From then on, Paralegix marks each period **ready to bill** as it comes due. Open the plan and click **Create Invoice** on a ready period to generate its invoice; nothing is sent to a client without that click.

## Late Fees

You can charge a **one-time late fee** on an invoice that has gone overdue. A late fee is a flat charge, a percentage of the balance, or both together, not interest, and an invoice is only ever charged one late fee.

First, an admin turns late fees on under **Settings** in [Rates & setup](/billing/time-and-expenses#charge-codes-and-rates), where you set the flat amount, the percentage, and a **grace period** (the number of days past the due date before a fee applies). You can also choose to **apply late fees automatically**, so any overdue invoice past its grace period is charged the fee for you.

If automatic late fees are off, you apply the fee by hand: open a past-due invoice and use **Apply Late Fee** from its actions. Either way, the fee is added to the invoice total and the balance owed.

## Upcoming Payments

The **Upcoming payments** tab in the billing hub groups every unpaid invoice by when it is due, from overdue through scheduled later. It is the quickest way to see what is coming in and to chase what is late.

::: info
Every payment you record, online or by hand, updates the invoice, the matter, the client's balance, and your firm totals at once. See [Reports](/billing/reports) for the roll-up.
:::
