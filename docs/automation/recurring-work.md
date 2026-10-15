# Recurring Work

Some work comes back on a schedule and some work always follows the same shape. Paralegix has three tools for that: recurring tasks, deadline sets, and evergreen retainer plans.

## Recurring Tasks

Any task can repeat. Open the **Repeat** panel in the create or edit task form, switch it on, and pick a pattern.

| Pattern | What it does |
|---|---|
| **Daily** | Repeats every day, or every N days |
| **Weekly** | Repeats every N weeks, optionally on specific days of the week |
| **Monthly** | Repeats every N months on a chosen day of the month |
| **Custom** | Repeats every N days |

You can cap a series with an **end date**, a **maximum number of repeats**, or leave it running until you turn it off.

### How the Next Task Appears

The next occurrence is created after you **complete** the current one, not on a fixed clock. Once a recurring task is marked complete, the daily maintenance job creates a fresh copy with the next due date and resets its status to open. The original stays completed as your record of the work.

Each new occurrence carries over the title, description, matter, assignees, clients, priority, location, court, visibility, and reminder settings. Attachments and notes are not copied, because they belong to the occurrence that was actually worked.

The series stops on its own when the end date passes or the maximum repeat count is reached.

::: tip
A recurring task only advances when it is completed, so a series never silently piles up a backlog of missed occurrences. If nobody completes this month's task, next month's is not created.
:::

### Monthly Dates Are Handled Safely

A task set to repeat on the 31st does not skip February. Paralegix clamps each occurrence to the last valid day of the target month, then returns to the 31st in months that have one.

## Deadline Sets

A deadline set is a reusable recipe for court and matter deadlines. Define it once, then apply it to any matter by picking a single trigger date, and the entire chain of deadlines is created at once.

Each deadline in the set carries a title, a type such as filing deadline or hearing, the number of days before or after the trigger date, and whether the client should see it in the portal. A set can hold up to 50 deadlines. Turn on weekend roll-forward and any deadline landing on a Saturday or Sunday moves to the following Monday.

Applying a set shows you exactly what will be created before you commit, with each computed date spelled out.

Everything the set creates becomes an ordinary matter event, so the deadlines appear on the matter's Events tab, get reminder emails like any other event, sync to connected calendars, and follow the same client-portal visibility rules.

Full details are in [Deadline Sets](/settings/deadline-sets).

## Evergreen Retainer Plans

A recurring billing plan bills the same amount every period and tracks how much work that amount covers.

Set the plan up once with an amount, an optional number of included hours, an interval such as monthly, a start date, and how many days after the period ends the invoice is due. From then on Paralegix does the rest:

- **Periods generate themselves.** Every time you open the Recurring plans tab, any period whose start date has arrived is created and brought up to date. You never generate a month by hand.
- **Usage is calculated per period.** Time entries in the period are compared against the plan's included hours. The earliest work is applied to the included hours first, and only the remainder is counted as overage.
- **Overage is priced properly.** Hours beyond the included allowance are priced through the same rate hierarchy as a regular invoice, so matter, client, charge-code, and member rates all apply as normal.
- **Each period becomes a draft invoice** on your say-so. The period is marked ready to bill, and creating the draft pulls in the retainer amount plus any overage. Nothing is sent to the client automatically.
- **Monthly plans keep their anchor day.** A plan starting on the 31st bills on the last day of short months and returns to the 31st afterwards.

A plan stops generating periods when its end date passes, or runs until you end it manually.

See [Payments and Plans](/billing/payments).

## Task Dependencies

Not a schedule, but the same idea: a task can be marked **blocked by** other tasks. It stays visibly blocked until every task it depends on is complete, so work that cannot start yet does not look like work that has been ignored.

## Things to Know

- **Repeat settings live on the task**, not on the matter, so two tasks in the same matter can have different schedules.
- **Applying a deadline set is additive.** Applying the same set to the same matter twice creates two copies. Apply it once, then edit individual dates afterwards.
- **Editing a deadline set later does not change deadlines you already created.** They are ordinary events by then.
- **Retainer plans never send anything on their own.** Period generation and usage tracking are automatic, but creating and sending the invoice is always a deliberate action.

## Related

- [Tasks overview](/tasks/overview)
- [Deadline Sets](/settings/deadline-sets)
- [Payments and Plans](/billing/payments)
- [Billing Automation](/automation/billing-automation)
