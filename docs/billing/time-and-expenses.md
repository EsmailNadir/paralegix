# Time and Expenses

Everything you bill starts as logged work: **time entries** for hours worked, plus **flat fees** and **expenses** for fixed charges. This page covers how to record that work and set the rates it bills at. You will find it all under the **Time entries** and **Rates & setup** tabs of the [Billing](/billing/overview) hub.

## Logging Time

Click **Log time** anywhere in billing to record hours. A time entry captures:

- The **matter** (or client) the work is for
- The **date** and number of **hours**
- A **description** of what you did
- An optional **charge code**, which can fill in the rate for you
- The **team member** who did the work

Each entry has a rate, and the amount is calculated for you. New entries start as **unbilled** and stay that way until you add them to an invoice.

::: tip
If your firm turns on **time rounding** in billing settings, the hours on each entry are rounded up to a fixed increment (commonly 6 minutes, or 0.1 hour) when you save it. This is a common legal-billing practice. Rounding is off unless an admin enables it, so your hours are never changed without you choosing it. See [Charge Codes and Rates](#charge-codes-and-rates) below.
:::

You can start a time entry from several places:

- The **Log time** button in the billing hub.
- A matter's **Time Tracking** tab.
- The **timer** or **Log time** shortcut on any [task](/tasks/overview), which pre-fills the form with the task's matter.

::: tip
The **timer** starts a live clock for a piece of work. When you stop it, the elapsed time becomes a ready-to-edit time entry, so you never have to guess how long something took.
:::

## The Time Entries Tab

The **Time entries** tab lists all of your logged time and highlights work that still needs attention.

At the top, **Unbilled work** points out completed tasks that have no time logged yet, each with a **Timer** and **Log** shortcut so you can capture the time you spent.

Below that, the full list of entries can be filtered by matter, client, member, charge code, billing status, and date range. Each entry shows its hours, charge code, and amount, with a **Bill now** button to invoice it. Use **Add Time Entry** to record time by hand.

## Flat Fees and Expenses

Not all charges are hourly. You can also add:

- **Flat fees** for fixed-price work, such as a filing fee or a set charge for a document.
- **Expenses** for costs you pass on to the client, such as court fees or postage.

Add either one from a matter's or client's **Billing** tab, or from the billing hub's **New** menu, where you pick which matter or client it belongs to.

Like time entries, flat fees and expenses start as unbilled and can be added to an invoice when you are ready.

## Charge Codes and Rates

The **Rates & setup** tab is where you control how your work is priced.

It has two parts, toggled by the **Rates** and **Settings** buttons:

- **Rates** covers pricing:
  - **Member default rates** set a firm-wide hourly rate for each team member. This is used when no more specific rate applies.
  - **Charge code rates** are reusable labels for common kinds of work (for example, Legal Research or Drafting). Each code can carry a default rate, and you can set per-member overrides.
- **Settings** is where firm admins configure billing-wide defaults:
  - **Firm default billing rate**, the lowest-priority fallback rate.
  - **Time rounding**, to round each time entry up to a fixed increment (6, 10, 12, 15, or 30 minutes) when it is saved.
  - **Late fees**, a one-time charge added to overdue invoices (see [Payments and Plans](/billing/payments)).
  - **Tax**, a sales or gross-receipts rate that prefills new invoices (see [Invoices](/billing/invoices)).
  - **Default event charge codes**, **online payments (Stripe)**, **UTBMS codes**, and **client payment emails**.

Using charge codes keeps your entries consistent and fills in the rate for you.

::: info
Most settings on the **Settings** page can only be changed by a firm admin. Everyone with billing access can view them.
:::

## How Rates Are Chosen

You can set an hourly rate in several places, and the same team member can have a different rate on different matters or for different clients. Because more than one rate can apply to a single time entry, Paralegix follows a fixed **priority order** and uses the **most specific** rate it can find. It checks each source in turn and stops at the first one that has a rate set.

From highest priority to lowest:

| # | Rate source | What it is | Where you set it |
|---|---|---|---|
| 1 | **Time entry rate** | A rate typed directly on a single entry, overriding everything else | On the entry, in the Log time form |
| 2 | **Matter member rate** | This person's rate for this specific matter | The matter's **Billing** tab |
| 3 | **Client member rate** | This person's rate for this specific client | The client's **Billing** tab |
| 4 | **Client default rate** | One rate for this client, for everyone | The client's **Billing** tab |
| 5 | **Charge code member rate** | This person's rate for a chosen charge code | **Rates & setup**, on the charge code |
| 6 | **Charge code default rate** | The charge code's own rate, for everyone | **Rates & setup**, on the charge code |
| 7 | **Member default rate** | This person's firm-wide default rate | **Rates & setup**, Member default rates |
| 8 | **Firm default rate** | A single fallback rate for the whole firm | Billing settings |
| 9 | **No rate** | If nothing above is set, the rate is $0 | Not applicable |

So a rate you type on the entry itself always wins, a matter-specific rate beats a client rate, a client rate beats a charge code rate, and the firm default is only used when nothing more specific exists. When you pick a member and a charge code in the Log time form, Paralegix shows you the resolved rate and where it came from, so you can see which source is being applied before you save.

::: tip
To give one attorney a special rate on a single matter, set a **matter member rate** on that matter. It takes priority over their client and firm-wide rates without changing how they are billed anywhere else.
:::

::: info
The rate is captured on each time entry as it is logged, and the amount is the rate times the hours. Once time, fees, and expenses are logged, they are ready to invoice. See [Generating Invoices](/billing/generating-invoices) for the next step.
:::
