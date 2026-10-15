# Deadline Sets

A **deadline set** is a reusable recipe for court and matter deadlines. You define it once, then apply it to any matter by picking a single trigger date, and Paralegix creates the whole chain of deadlines at once. For example, a "Civil Complaint Filed" set might create an Answer deadline 30 days out, a discovery cutoff at 90 days, and a mediation date at 120 days, all calculated from the day the complaint was filed.

Every deadline a set creates becomes a normal matter event, so it shows up on the matter's Events tab, syncs to your calendar, and follows the same client-portal visibility rules as an event you add by hand.

You manage deadline sets under **Settings > Matter Config > Deadline Sets**.

## Who Can Use Them

- **Creating, editing, and deleting** deadline sets requires the firm settings management permission. If you do not have it, you can still see the sets but not change them.
- **Applying** a set to a matter requires permission to update that matter, and you must be a member of the matter.

See [Roles and Permissions](/settings/roles) for how permissions work.

## Creating a Deadline Set

1. Go to **Settings > Matter Config** and open the **Deadline Sets** tab.
2. Click **New deadline set**.
3. Give it a **name** (for example, "Civil Complaint Filed") and an optional **description** noting when to use it.
4. Choose whether to **move weekend deadlines to Monday**. When this is on, any deadline that lands on a Saturday or Sunday rolls forward to the following Monday.
5. Add one or more **deadlines**. For each one, set:
   - **Title**, for example "Answer due".
   - **Type**, such as filing deadline, hearing, or discovery cutoff.
   - **Number of days** and whether that falls **before** or **after** the trigger date.
   - **Visible to client portal**, if the client should see this deadline.
6. Use **Add deadline** to add more rows. Click **Create deadline set** to save.

A set can hold up to 50 deadlines. Days are counted as plain calendar days from the trigger date, with the optional weekend roll-forward as the only adjustment.

## Applying a Set to a Matter

1. Open the matter and go to its **Events** tab.
2. Click **Apply Deadline Set**.
3. Choose the **deadline set** you want.
4. Pick a **trigger date**. Every deadline in the set is calculated from this date.
5. Review the preview, which lists each deadline and the exact date it will land on.
6. Click **Create events** to add them all to the matter.

The new deadlines appear immediately on the Events tab alongside any events you added manually, and they sync to your calendar like any other matter event.

::: tip
Set up a deadline set for each common matter type or court schedule your firm handles. Applying one is much faster and more consistent than adding each deadline by hand.
:::

## Things to Know

- **Weekend roll-forward only.** Turning on "move weekend deadlines to Monday" handles Saturdays and Sundays, but Paralegix does not skip court holidays. Review computed dates that fall near a holiday.
- **Applied deadlines are independent.** Once a set is applied, the deadlines it created are ordinary matter events. Editing the set later does not change deadlines you already created, and deleting the set does not remove them.
- **Applying is additive.** Applying the same set to the same matter twice creates a second copy of the deadlines. Apply a set once per matter, and edit the individual events afterward if a date needs adjusting.

## Related

- [Matters overview](/matters/overview)
- [Firm Settings overview](/settings/overview)
- [Roles and Permissions](/settings/roles)
