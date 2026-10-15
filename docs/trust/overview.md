# Trust Accounting

**Trust Accounting** is the client-funds ledger: retainers and settlement money you hold *for* a client rather than money you have earned. In most US jurisdictions this is an IOLTA account, and the bar rules around it are strict, so Paralegix keeps it as a separate, append-only ledger rather than as ordinary billing.

Open **Trust Accounting** from the left sidebar.

::: warning
Trust funds belong to the client until they are earned. Paralegix records and reconciles the ledger, but complying with your jurisdiction's trust-accounting rules remains your firm's responsibility.
:::

## The Tabs

| Tab | What it holds |
|---|---|
| **Overview** | Total trust held, how many accounts you have, how many clients hold a balance, and when you last reconciled |
| **Transactions** | Every entry in the ledger, filterable by account, client, and date |
| **Accounts** | Your trust bank accounts, and each client's balance within them |
| **Retainers** | Minimum balances and replenishment requests |
| **Interest** | IOLTA interest remittances to the bar foundation |
| **Reconciliation** | Reconciling the ledger against your bank statement |
| **Settings** | Trust preferences and online trust deposits |

## Trust Accounts

A **trust account** in Paralegix mirrors a real trust bank account at your bank. Add one under **Accounts** with its name, bank, and the last four digits of the account number.

Inside an account, every client with money on deposit has their own **client balance**. This is the split every trust rule cares about: the account totals what the bank holds, and the per-client balances say whose money it is. Paralegix keeps them in step, and a client balance can never be taken below zero, so one client's funds can never be spent on another's matter.

## Recording Transactions

From **Transactions**, use the transaction form to record:

- **Deposit**: money coming in, such as a retainer.
- **Withdrawal**: money going out, such as paying a court fee or transferring earned fees to your operating account.
- **Transfer**: moving funds between trust accounts, or between clients, recorded as a matched pair of entries.

Each entry records the client, the matter where relevant, the date, the amount, and a description.

## The Ledger Is Append-Only

A completed trust transaction is **never edited or deleted**. This is the core of the design, not a limitation: an audit trail you can rewrite is not an audit trail.

To correct a mistake, **void** the transaction. Voiding records a reversing entry rather than removing the original, so both the error and the correction stay visible, dated, and attributed. Every balance is recomputed from the ledger, so the numbers stay right while the history stays complete.

## Minimum Balances and Replenishment

Under **Retainers** you can set a **minimum balance** per client, per trust account. When a withdrawal takes that client below their minimum, Paralegix immediately:

- posts a message in the client's portal conversation asking them to top up the retainer,
- emails the client a replenishment request showing the shortfall, and
- notifies your firm that the request went out.

The alert fires on the crossing, not on every transaction afterwards, so a client already below their minimum is not asked over and over.

## Reconciliation

**Reconciliation** is the periodic check that your ledger matches the bank. Enter the closing balance from your bank statement for the period and Paralegix compares it against the ledger, shows any difference, and lists the entries in the period so you can find it.

A completed reconciliation is kept on file with the date, the balances, and who ran it, which is what a bar audit or a random compliance check asks for. **Reconciliation history** lists past reconciliations, and you can produce a report for any of them.

## Client Statements

You can generate a **client statement** for any client: their opening balance, every transaction in the period, and their closing balance. This is what you send a client who asks what happened to their retainer.

## Online Trust Deposits

Electronic trust deposits are firm-initiated, not something a client starts on their own. Use **Request Deposit** to pick a trust account, a client, a matter, and an amount; Paralegix generates a secure payment link you send to the client, and they pay it by ACH. The deposit lands in the trust account and is posted to the ledger automatically, and the client's trust balance in the portal updates with it.

This is a separate setup from your firm's regular online invoice payments. Each trust account connects its own payment account under **Trust > Settings > Electronic deposits**, independent of the payment account you use for client invoices.

::: info
Trust deposits are ACH only, deliberately. Card deposits would mix processing fees into client funds, which is exactly the commingling trust rules prohibit. Processing fees for a trust deposit are billed to the firm, never taken out of the client's money.
:::

## What Clients See

A client with a trust balance sees a **Trust Account** page in their portal showing their current balance and their transaction history. It is read-only: a client cannot initiate a deposit themselves, they can only pay a deposit link you send them. They only ever see their own funds.

## Related

- [Billing overview](/billing/overview)
- [Clients overview](/clients/overview)
- [Billing automation](/automation/billing-automation)
