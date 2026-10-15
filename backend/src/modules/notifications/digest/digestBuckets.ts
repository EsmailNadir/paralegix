/**
 * Pure bucketing, capping and link-building for the daily digest.
 *
 * Kept separate from `digest.service.js` because that module reaches the database,
 * Firebase and the email transport at require time. These functions decide what a
 * digest looks like — the part with all the off-by-one risk — and holding them
 * apart keeps them runnable with no connection of any kind.
 */

const { addDays } = require('../../../shared/utils/localTime');

/** How far ahead the digest looks, in days past the recipient's local today. */
export const DIGEST_WINDOW_DAYS = 7;

// Per-bucket line-item budget. The email is meant to be scannable in one or two
// screens; past roughly 25 lines a digest stops being read and starts being
// filtered. Overflow becomes a "+N more" link into a filtered list.
export const DIGEST_CAPS = { overdue: 8, today: 12, tomorrow: 6, week: 8 };

const DAY_BUCKETS = ['overdue', 'today', 'tomorrow', 'week'];

/** An item's day as a comparable 'YYYY-MM-DD' key, or null if it has none. */
function dayKey(item: any) {
  if (!item || !item.day) return null;
  const key = String(item.day).slice(0, 10);
  return key.length === 10 ? key : null;
}

/**
 * Split items into day buckets against the recipient's local `today`.
 *
 * `critical` is a PARALLEL collection, not a fifth bucket: a statute date or a
 * court date appears both there and in its own day bucket, so the email can lead
 * with it without it vanishing from the day it actually falls on.
 *
 * Days are compared as strings — ISO dates sort correctly lexically, which avoids
 * constructing a Date (and a timezone) purely to answer "is this before today?".
 *
 * @param {Array<object>} items  repository rows carrying `day` as 'YYYY-MM-DD'
 * @param {string} today         recipient's local day, 'YYYY-MM-DD'
 */
export function bucketItems(items: any, today: any) {
  const buckets: any = { overdue: [], today: [], tomorrow: [], week: [], critical: [] };
  const todayKey = today ? String(today).slice(0, 10) : null;
  if (!Array.isArray(items) || !todayKey) return buckets;

  const tomorrowKey = addDays(todayKey, 1);

  for (const item of items) {
    const day = dayKey(item);
    // An item with no due day has no place in a deadline digest.
    if (!day) continue;

    if (item.critical === true) buckets.critical.push(item);

    if (day < todayKey) buckets.overdue.push(item);
    else if (day === todayKey) buckets.today.push(item);
    else if (day === tomorrowKey) buckets.tomorrow.push(item);
    else buckets.week.push(item);
  }

  // Ascending by day, so overdue reads oldest-first and the lookahead buckets read
  // soonest-first. The sort is stable, which preserves the within-day ordering the
  // repositories already applied (task priority, event time).
  for (const name of [...DAY_BUCKETS, 'critical']) {
    (buckets as Record<string, any[]>)[name].sort((a: any, b: any) => String(dayKey(a)).localeCompare(String(dayKey(b))));
  }

  return buckets;
}

/**
 * Truncate each day bucket to its budget, reporting the overflow so the email can
 * offer a "+N more" link rather than silently dropping rows.
 *
 * Critical items are never truncated: a missed statute date is the highest-
 * consequence deadline in the product, and no line budget justifies hiding one.
 *
 * `totalItems` counts the day buckets BEFORE truncation and excludes `critical`,
 * whose members are already counted in the day bucket they also belong to.
 */
export function applyCaps(buckets: any) {
  const critical = Array.isArray(buckets?.critical) ? buckets.critical : [];
  const out: any = {
    critical: { shown: critical.slice(), more: 0, total: critical.length },
  };

  let totalItems = 0;
  for (const name of DAY_BUCKETS) {
    const list = Array.isArray(buckets?.[name]) ? buckets[name] : [];
    const cap = (DIGEST_CAPS as Record<string, number>)[name];
    totalItems += list.length;
    const hidden = list.slice(cap);
    out[name] = {
      shown: list.slice(0, cap),
      more: hidden.length,
      total: list.length,
      // Which kinds got truncated, so a "+N more" link can point somewhere that
      // can actually display them. A bucket whose overflow is all tasks can go to
      // the task list; one hiding events or invoices cannot.
      overflowKinds: Array.from(new Set(hidden.map((item) => item && item.kind).filter(Boolean))),
    };
  }

  out.totalItems = totalItems;
  return out;
}

/** App origin for links in outbound mail, without a trailing slash. */
function frontendBase() {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/**
 * Absolute deep link to the thing a digest line is about.
 *
 * Invoices degrade through their available context: a matter invoice opens under
 * its matter, a client-context invoice under its client, and one with neither
 * falls back to the billing list rather than to a URL that would 404.
 */
export function itemUrl(lawFirmId: string, item: any) {
  const base = `${frontendBase()}/lawfirm/${lawFirmId}`;
  switch (item?.kind) {
    case 'task':
      return `${base}/tasks/${item.id}`;
    case 'event':
      return item.matterId ? `${base}/matters/${item.matterId}?tab=events` : `${base}/calendar`;
    case 'statute':
      return item.matterId ? `${base}/matters/${item.matterId}` : `${base}/matters`;
    case 'invoice':
      if (item.matterId) return `${base}/matters/${item.matterId}/invoices/${item.id}`;
      if (item.clientContextId) return `${base}/clients/${item.clientContextId}/invoices/${item.id}`;
      return `${base}/billing`;
    default:
      return `${base}/matters`;
  }
}

/**
 * Where a truncated bucket's "+N more" goes.
 *
 * The task list can filter by due-date band, so a bucket whose hidden items are
 * all tasks lands the recipient on exactly the rows the email left out. Nothing
 * else can: the list cannot render an event, an invoice, or a statute date, and
 * it sits behind `tasks.view`, so sending someone there to find a truncated
 * invoice shows them the wrong thing or a permission wall. Mixed or non-task
 * overflow goes to the dashboard, which spans every entity type.
 *
 * `overflowKinds` comes from `applyCaps` and describes the hidden remainder, not
 * the shown rows - a bucket showing tasks but hiding invoices must not claim the
 * task list covers it.
 *
 * The recipient's id is carried through as `assignedTo`, because the list applies
 * no assignee predicate of its own: an owner opening it unfiltered sees every
 * task in the firm, so a bucket counted as "assigned to me" would land on a page
 * listing everyone's work. The filter narrows the page to the same person the
 * digest was built for. It is an approximation, not the digest's exact predicate:
 * the digest also shows UNASSIGNED tasks on matters the recipient is a member of,
 * and no assignee filter can express that arm, so those rows are missing from the
 * filtered page. Narrower-and-wrong-by-omission beats firm-wide-and-wrong-by-flood.
 */
export function bucketUrl(lawFirmId: string, bucket: any, overflowKinds: any, userId: string) {
  const base = `${frontendBase()}/lawfirm/${lawFirmId}`;
  const kinds = Array.isArray(overflowKinds) ? overflowKinds : [];
  const taskOnly = kinds.length > 0 && kinds.every((kind) => kind === 'task');
  if (!taskOnly) return base;

  const assignee = userId ? `&assignedTo=${encodeURIComponent(userId)}` : '';
  return `${base}/tasks?due=${encodeURIComponent(bucket)}${assignee}`;
}
