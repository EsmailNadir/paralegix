/**
 * Shared Postgres helpers for the daily reminder cron services.
 *
 * They read the `law_firms` / `members` / `users` tables. Firm-level
 * reminder settings live under the `settings` jsonb (absent ⇒ service defaults).
 * User email/name resolve from `users`, falling back to Firebase Auth (retained)
 * for ids that only exist in auth (soft-FK members).
 */

const { infrastructureRootSql, infrastructureSql, withDrizzleTransaction } = require('../database/infrastructureQuery');
const { admin } = require('../database/firebase');

/**
 * One PAGE of firms (id + name + settings jsonb), in a STABLE order.
 *
 * The order is load-bearing: `forEachFirm` resumes a truncated pass after the
 * last firm it finished, which only works if consecutive runs see the same
 * sequence. Ordering by id gives that for free and also makes the page boundary
 * a keyset (`id > after`) rather than an offset, so a firm created or deleted
 * between pages cannot make the rotation skip or repeat one.
 *
 * This used to select every firm with its `settings` jsonb before visiting any
 * of them, on each of the six passes in a cron cycle, whether or not any firm
 * had work. That cost grew with the customer base rather than with the work, on
 * the same instance that signs documents.
 */
async function listFirmPage(after: string | null, limit: number) {
  const { rows } = after
    ? await infrastructureRootSql(
      `select id, name, settings from law_firms where id > $1 order by id limit $2`,
      [after, limit],
    )
    : await infrastructureRootSql(
      `select id, name, settings from law_firms order by id limit $1`,
      [limit],
    );
  return rows.map((r: any) => ({ id: r.id, name: r.name || null, settings: r.settings || {} }));
}

/** How many firms exist, for the coverage a pass reports. */
async function countFirms(): Promise<number> {
  const { rows } = await infrastructureRootSql(`select count(*)::int as n from law_firms`);
  return rows[0]?.n || 0;
}

/** Firms per query. Small enough to bound memory, large enough to be few queries. */
const FIRM_PAGE_SIZE = Number(process.env.CRON_FIRM_PAGE_SIZE) || 200;

/**
 * Wall-clock budget for one cron request, shared by every pass it runs.
 *
 * Sized against Cloud Scheduler, not Cloud Run. A daily job's attempt deadline
 * is 180s; a pass still working when the scheduler gives up is recorded as a
 * failed attempt, retried into the `CRON_PASS` lock, and never gets to report
 * how far it got. 150s stops inside that deadline with room for the unit of
 * work that started just before it, so each pass persists where it got to and
 * reports `truncated` while the scheduler is still listening.
 *
 * Only for a pass that resumes where it stopped (a `forEachFirm` cursor, a queue
 * whose unreached rows stay queued). See `NON_RESUMABLE_CRON_BUDGET_MS`.
 */
export const CRON_BUDGET_MS = Number(process.env.REMINDER_CRON_BUDGET_MS) || 150_000;

/**
 * Budget for a pass that restarts from the same end on every run, so stopping
 * earlier permanently drops more of its tail rather than deferring it:
 * `reconcileBillingStatuses` (oldest firms first) and
 * `reconcileStripeTrustDeposits` (newest payment intents first). These keep the
 * older 240s, which outlives a 180s scheduler attempt, until they persist a
 * checkpoint and can take `CRON_BUDGET_MS` like the rest. The same environment
 * override applies.
 */
export const NON_RESUMABLE_CRON_BUDGET_MS = Number(process.env.REMINDER_CRON_BUDGET_MS) || 240_000;

/** A deadline for one cron request. Pass the SAME value to every pass in it. */
export function cronDeadline(budgetMs: number = CRON_BUDGET_MS) {
  return Date.now() + budgetMs;
}

async function getPassCursor(passName: any) {
  try {
    const { rows } = await infrastructureRootSql(
      `select last_firm_id from cron_pass_state where pass_name = $1 limit 1`,
      [passName]
    );
    return rows[0]?.last_firm_id || null;
  } catch (err: any) {
    // A missing/unreadable cursor must not stop reminders going out; the pass
    // just restarts the rotation from the beginning.
    console.error(`[cron:${passName}] Failed to read resume cursor:`, err.message);
    return null;
  }
}

async function setPassCursor(passName: any, lawFirmId: string) {
  try {
    await infrastructureRootSql(
      `insert into cron_pass_state (pass_name, last_firm_id, updated_at)
       values ($1, $2, now())
       on conflict (pass_name) do update set last_firm_id = $2, updated_at = now()`,
      [passName, lawFirmId]
    );
  } catch (err: any) {
    console.error(`[cron:${passName}] Failed to persist resume cursor:`, err.message);
  }
}

/**
 * Run `handler(firm)` for every firm on the platform, resumably.
 *
 * Each pass used to loop `await listFirms()` in whatever order Postgres returned,
 * inside the single HTTP request the scheduler makes. Once the platform outgrew
 * the request timeout that loop was simply cut off partway: the firms it never
 * reached silently stopped receiving reminders and late fees, the same firms
 * every day, and the response never said so.
 *
 * Two things fix that. Firms are walked in a stable id order starting AFTER the
 * last one this pass finished, wrapping around — so a run that is cut short
 * serves the skipped firms first next time, and no firm can starve. And the walk
 * stops on a deadline it chooses rather than one the platform imposes, returning
 * `truncated` so a pass that is no longer finishing is visible in the cron
 * response instead of being inferred from missing email.
 *
 * A firm whose handler throws is logged and skipped, and the cursor still
 * advances past it: one firm that fails every time must not wedge the rotation
 * for everyone behind it.
 *
 * @param {string} passName            cursor key, e.g. 'invoiceReminders'
 * @param {(firm) => Promise<void>} handler
 * @param {{lawFirmId?: string, deadline?: number}} options
 *   `lawFirmId` runs exactly one firm (manual/test invocation) and touches no
 *   cursor. `deadline` is an epoch-ms budget shared across the request.
 */
export async function forEachFirm(passName: any, handler: any, { lawFirmId = null, deadline = null, pageSize = FIRM_PAGE_SIZE } = {}) {
  if (lawFirmId) {
    const firm = await getFirm(lawFirmId);
    if (firm) await handler(firm);
    return { firmsProcessed: firm ? 1 : 0, firmsTotal: firm ? 1 : 0, truncated: false };
  }

  const total = await countFirms();
  if (!total) return { firmsProcessed: 0, firmsTotal: 0, truncated: false };

  const cursor = await getPassCursor(passName);

  let processed = 0;
  let lastCompleted: string | null = null;
  let after: string | null = cursor;
  // The rotation runs to the end of the id order, then wraps to the start and
  // continues until every firm has been visited once. `wrapped` makes that a
  // single pass rather than a loop: without it, a cursor near the end would
  // walk the whole table again after wrapping.
  let wrapped = false;

  outer: while (processed < total) {
    // eslint-disable-next-line no-await-in-loop -- one page at a time is the point
    const page = await listFirmPage(after, pageSize);

    if (page.length === 0) {
      if (wrapped) break;             // wrapped and still nothing: table is exhausted
      wrapped = true;
      after = null;                   // start again from the lowest id
      continue;
    }

    for (const firm of page) {
      if (deadline && Date.now() >= deadline) break outer;
      try {
        // eslint-disable-next-line no-await-in-loop -- firms are processed in order
        await handler(firm);
      } catch (err: any) {
        console.error(`[cron:${passName}] Firm ${firm.id} failed; continuing:`, err.message);
      }
      lastCompleted = firm.id;
      processed++;
      if (processed >= total) break outer;
    }
    after = page[page.length - 1].id;
  }

  if (lastCompleted) await setPassCursor(passName, lastCompleted);

  const truncated = processed < total;
  if (truncated) {
    console.warn(
      `[cron:${passName}] Budget exhausted after ${processed}/${total} firms; ` +
        `next run resumes after firm ${lastCompleted}`
    );
  }
  return { firmsProcessed: processed, firmsTotal: total, truncated };
}

/** Matters for a firm (id + name), optionally filtered to a set of statuses. */
export async function listMatters(lawFirmId: string, { statuses }: { statuses?: string[] } = {}) {
  const params: unknown[] = [lawFirmId];
  let sql = `select id, name from matters where law_firm_id = $1`;
  if (Array.isArray(statuses) && statuses.length) {
    params.push(statuses);
    sql += ` and status = any($2)`;
  }
  const { rows } = await infrastructureRootSql(sql, params);
  return rows.map((r: any) => ({ id: r.id, name: r.name || null }));
}

/** A single firm, or null. */
export async function getFirm(lawFirmId: string) {
  const { rows } = await infrastructureRootSql(`select id, name, settings from law_firms where id = $1 limit 1`, [lawFirmId]);
  if (!rows[0]) return null;
  return { id: rows[0].id, name: rows[0].name || null, settings: rows[0].settings || {} };
}

/**
 * Resolve { email, name, timezone } for a user id. Checks `users` (joined to
 * `users.timezone` for the saved IANA zone), then Firebase Auth (members may
 * only exist in auth). `timezone` is null when unknown - callers should fall back
 * to UTC. Pass a Map cache keyed by `${firm}:${uid}`.
 */
export async function resolveUserInfo(uid: string, lawFirmId: string, cache: any) {
  if (!uid) return null;
  const cacheKey = `${lawFirmId}:${uid}`;
  if (cache && cache.has(cacheKey)) return cache.get(cacheKey);

  let resolved = null;
  try {
    const { rows } = await infrastructureRootSql(
      `select u.name, u.email, u.timezone
         from users u
        where u.id = $1
        limit 1`,
      [uid]
    );
    if (rows[0]?.email) {
      resolved = { email: rows[0].email, name: rows[0].name || null, timezone: rows[0].timezone || null };
    }
  } catch { /* ignore */ }

  if (!resolved) {
    try {
      const u = await admin.auth().getUser(uid);
      if (u?.email) resolved = { email: u.email, name: u.displayName || null, timezone: null };
    } catch { /* ignore: user may not exist in auth */ }
  }

  if (cache) cache.set(cacheKey, resolved);
  return resolved;
}

/**
 * Whether `uid` currently holds a `members` row in this firm. Pass a Map
 * cache keyed by `${firm}:${uid}` the same way `resolveUserInfo` does.
 *
 * Exists specifically so a caller can gate a fallback-to-a-specific-user
 * resolution (e.g. "fall back to whoever created this") on current
 * membership, WITHOUT nulling the underlying created-by/audit column: that
 * column is read elsewhere purely for display ("created by Jane Doe") and
 * must keep working after Jane leaves the firm. Only whether Jane is still
 * mailed reminders should change, not the historical record.
 */
export async function isFirmMember(lawFirmId: string, uid: string, cache?: Map<string, boolean>) {
  if (!uid) return false;
  const cacheKey = `${lawFirmId}:${uid}`;
  if (cache && cache.has(cacheKey)) return cache.get(cacheKey);

  let member = false;
  try {
    const { rows } = await infrastructureRootSql(
      `select 1 from members where law_firm_id = $1 and user_id = $2 limit 1`,
      [lawFirmId, uid]
    );
    member = !!rows[0];
  } catch (err: any) {
    console.error(`[reminders] Failed to check membership for ${uid} in firm ${lawFirmId}:`, err.message);
  }

  if (cache) cache.set(cacheKey, member);
  return member;
}

/**
 * Fallback recipients for firm-level notices: the firm's owners
 * (`members.is_owner`), each resolved to `{ email, name, timezone }` via
 * `resolveUserInfo`.
 *
 * Owners are used rather than a permission lookup because this answers "who
 * speaks for the firm when no specific user is the right target" - ownership is
 * the stable answer, whereas any given permission grant may be held by nobody
 * or by dozens of members. Callers that need a permission-gated audience should
 * resolve it through `requirePermission`'s permission sets instead.
 *
 * Returns an empty array if the lookup fails; a broken fallback lookup must not
 * abort the notice the caller was already sending.
 */
export async function firmAdminRecipients(lawFirmId: string, cache?: Map<string, any>) {
  try {
    const { rows } = await infrastructureRootSql(
      `select user_id from members where law_firm_id = $1 and is_owner = true`,
      [lawFirmId]
    );
    const out = [];
    for (const r of rows) {
      const info = await resolveUserInfo(r.user_id, lawFirmId, cache);
      if (info) out.push(info);
    }
    return out;
  } catch (err: any) {
    console.error(`[reminders] Failed to resolve admin recipients for firm ${lawFirmId}:`, err.message);
    return [];
  }
}
