import { randomUUID } from 'crypto';

const { infrastructureRootSql, infrastructureSql, withDrizzleTransaction } = require('../database/infrastructureQuery');
const { isUuid } = require('./isUuid');
const { AppError } = require('../errors/AppError');
const {
  normalizeStorageSettings,
  DEFAULT_STORAGE_QUOTA_BYTES,
} = require('../plans/storageQuota');
const { loadFirmPlan } = require('../plans/planEnforcement');
const { getEffectiveLimits } = require('../plans/planDefinitions');

const FALLBACK_STORAGE_SETTINGS = normalizeStorageSettings({
  quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
  usedBytes: 0,
});

export function formatBytes(bytes: any) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Storage usage / quota single source of truth.
 *
 * Every value lives in a typed `law_firms` column: `storage_used_bytes`,
 * `storage_quota_bytes`, `storage_hard_limit`, `storage_warn_at_percent`,
 * `storage_usage_updated_at`. They are indexable and constraint-checked, and
 * lawfirms.repository already exposes the first two as
 * `storageUsedBytes`/`storageQuotaBytes`.
 *
 * A column that was never seeded falls back to the normalized default rather
 * than to a second store.
 */
export async function getLawFirmStorageSettings(lawFirmId: string) {
  const { rows } = await infrastructureRootSql(
    `select storage_used_bytes, storage_quota_bytes, storage_hard_limit,
            storage_warn_at_percent, storage_usage_recounted_at, storage_file_count
       from law_firms where id = $1 limit 1`,
    [lawFirmId]
  );
  if (!rows[0]) return FALLBACK_STORAGE_SETTINGS;

  const row = rows[0];
  const defaults = normalizeStorageSettings({});

  const quotaBytes = row.storage_quota_bytes == null
    ? defaults.quotaBytes
    : Number(row.storage_quota_bytes);
  const usedBytes = row.storage_used_bytes == null ? 0 : Number(row.storage_used_bytes);
  const hardLimit = typeof row.storage_hard_limit === 'boolean'
    ? row.storage_hard_limit
    : defaults.hardLimit;

  return {
    quotaBytes: Number.isFinite(quotaBytes) && quotaBytes > 0 ? quotaBytes : defaults.quotaBytes,
    usedBytes: Number.isFinite(usedBytes) && usedBytes >= 0 ? usedBytes : 0,
    warnAtPercent: row.storage_warn_at_percent == null
      ? defaults.warnAtPercent
      : Number(row.storage_warn_at_percent),
    hardLimit,
    /** When the bucket was last fully recounted, or null if it never has been. */
    recountedAt: row.storage_usage_recounted_at || null,
    /** Object count as of that recount, or null before the first one. */
    fileCount: row.storage_file_count == null ? null : Number(row.storage_file_count),
  };
}

/**
 * Atomically adjust the firm's stored byte usage (clamped at 0). The whole
 * read-modify-write happens in a single SQL statement, so concurrent uploads/
 * deletes can't race.
 */
export async function adjustStorageUsageByDelta(lawFirmId: string, deltaBytes: any) {
  const delta = Math.trunc(Number(deltaBytes || 0));
  if (!Number.isFinite(delta) || delta === 0) return;

  await infrastructureRootSql(
    `update law_firms
        set storage_used_bytes = greatest(0, coalesce(storage_used_bytes, 0) + $2),
            storage_usage_updated_at = now()
      where id = $1`,
    [lawFirmId, delta]
  );
}

/**
 * How long an upload-init's reservation holds quota before it lapses on its own.
 *
 * Two hours. Long enough for a large upload on a slow line: the enterprise
 * per-file ceiling (10 GB) crosses an 11 Mbps uplink in about two hours, and an
 * ordinary office uplink does it in well under one. Short enough that an upload
 * nobody finishes or cancels (a crashed tab, a laptop closed mid-transfer)
 * stops blocking the firm the same afternoon.
 *
 * Nothing breaks when a slow upload outlives it. Finalize still charges what
 * landed; the only thing lost is the hold, so another upload may be admitted
 * against space this one is about to use and the firm can end slightly over its
 * quota. The next init is then refused.
 */
export const STORAGE_RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Delete a firm's lapsed reservations. They are already ignored by every sum;
 * this only keeps the table from holding rows that can never count again.
 */
export async function purgeExpiredStorageReservations(lawFirmId: string, executor?: any) {
  const text = `delete from storage_reservations
                 where law_firm_id = $1 and expires_at <= now()`;
  const { rows } = executor
    ? await infrastructureSql(executor, `${text} returning id`, [lawFirmId])
    : await infrastructureRootSql(`${text} returning id`, [lawFirmId]);
  return rows.length;
}

/**
 * Set the firm's stored byte usage to an absolute value (after a recount), and
 * purge its lapsed reservations. Live ones stay: they belong to uploads still in
 * flight, whose bytes are not in the recounted figure yet.
 */
export async function setStorageUsageBytes(lawFirmId: string, usedBytes: any, fileCount = null) {
  const value = Math.max(0, Math.trunc(Number(usedBytes || 0)));
  const count = Number.isFinite(Number(fileCount)) && Number(fileCount) >= 0
    ? Math.trunc(Number(fileCount))
    : null;
  // Only the full recount calls this, so it is where the reconciliation marker is
  // stamped. `storage_usage_updated_at` cannot serve that purpose: every upload
  // and delete bumps it, so a busy firm would look freshly reconciled forever.
  await infrastructureRootSql(
    `update law_firms
        set storage_used_bytes = $2::bigint,
            -- The retired counter. Nothing adds to it any more, but a balance
            -- written before reservations moved to their own table can still be
            -- standing, and the migration that drops the column folds it out of
            -- storage_used_bytes first. After a recount the figure above is the
            -- truth, so the balance has to go or that fold would undercount.
            storage_reserved_bytes = 0,
            storage_usage_recounted_at = now(),
            storage_file_count = coalesce($3::bigint, storage_file_count),
            storage_usage_updated_at = now()
      where id = $1`,
    [lawFirmId, value, count]
  );
  await purgeExpiredStorageReservations(lawFirmId);
}

type StorageReservation =
  | { reserved: true; reservationIds: string[]; usedBytes: number; heldBytes: number; incoming: number }
  | { reserved: false; reservationIds: []; usedBytes: number; heldBytes: number; incoming: number; quotaBytes: number };

/**
 * RESERVE quota for the files an upload is about to send, one reservation per
 * file, before any byte is written.
 *
 * `storage_used_bytes` counts saved files only, so an upload in flight never
 * enters it. It holds its declared bytes as `storage_reservations` rows
 * instead, each lapsing at `STORAGE_RESERVATION_TTL_MS`, and admission counts
 * `used + sum(live reservations) + incoming` against the quota.
 *
 * All of it happens in ONE transaction under a lock on the firm row, which is
 * what keeps two concurrent uploads from both passing the check and both
 * overshooting: the second waits for the first to insert its rows and then
 * counts them. Lapsed rows are deleted on the way in, so they neither count nor
 * accumulate.
 *
 * Returns `{ reserved: true, reservationIds }` (in the order of `sizes`), or
 * `{ reserved: false, ... }` only when a hard limit would be exceeded, in which
 * case nothing was inserted and the caller throws 413. A missing firm throws
 * 404. With the hard limit off or no quota set, admission always passes.
 */
export async function reserveStorageUsage(
  { lawFirmId, createdBy, sizes }: { lawFirmId: string; createdBy: string; sizes: unknown[] },
): Promise<StorageReservation> {
  const each = (sizes || []).map((size) => Math.max(0, Math.trunc(Number(size) || 0)));
  const incoming = each.reduce((sum, n) => sum + n, 0);

  return withDrizzleTransaction(async (tx: any) => {
    const { rows: firmRows } = await infrastructureSql(tx,
      `select storage_used_bytes, storage_quota_bytes, storage_hard_limit
         from law_firms where id = $1 for update`,
      [lawFirmId]);
    const firm = firmRows[0];
    if (!firm) {
      const err = new Error('Law firm not found') as Error & { status: number; code: string };
      err.status = 404;
      err.code = 'LAW_FIRM_NOT_FOUND';
      throw err;
    }

    await purgeExpiredStorageReservations(lawFirmId, tx);
    const { rows: heldRows } = await infrastructureSql(tx,
      `select coalesce(sum(bytes), 0)::bigint as held
         from storage_reservations
        where law_firm_id = $1 and expires_at > now()`,
      [lawFirmId]);

    const usedBytes = Math.max(0, Number(firm.storage_used_bytes || 0));
    const heldBytes = Number(heldRows[0]?.held || 0);
    const quota = firm.storage_quota_bytes == null ? null : Number(firm.storage_quota_bytes);

    if (firm.storage_hard_limit === true && quota != null && incoming > 0
      && usedBytes + heldBytes + incoming > quota) {
      return { reserved: false, reservationIds: [], usedBytes, heldBytes, incoming, quotaBytes: quota };
    }

    if (each.length === 0) return { reserved: true, reservationIds: [], usedBytes, heldBytes, incoming };

    // One row per file, so each upload releases only its own. The ids are
    // minted here rather than read back from RETURNING, whose row order
    // Postgres does not promise, so id i is always file i's.
    const reservationIds = each.map(() => randomUUID());
    await infrastructureSql(tx,
      `insert into storage_reservations (id, law_firm_id, created_by, bytes, expires_at)
       select r.id, $1, $2, r.bytes, now() + ($5::bigint * interval '1 millisecond')
         from unnest($3::uuid[], $4::bigint[]) as r(id, bytes)`,
      [lawFirmId, String(createdBy), reservationIds, each, STORAGE_RESERVATION_TTL_MS]);
    return { reserved: true, reservationIds, usedBytes, heldBytes, incoming };
  });
}

/**
 * End reservations early: the upload they held space for finished or was
 * cancelled.
 *
 * Scoped to the firm AND the uploader, so one member cannot free quota another
 * member is holding for an upload still in flight. A reservation that is
 * already gone (released, lapsed and purged, or never this caller's) is simply
 * not matched, which makes a repeated finalize or cancel harmless. Resolves to
 * the ids actually deleted.
 */
export async function releaseStorageReservations(
  { lawFirmId, createdBy, reservationIds }: { lawFirmId: string; createdBy: string; reservationIds: unknown[] },
): Promise<string[]> {
  const ids = [...new Set((reservationIds || []).filter(isUuid).map(String))];
  if (ids.length === 0 || !isUuid(lawFirmId) || !createdBy) return [];
  const { rows } = await infrastructureRootSql(
    `delete from storage_reservations
      where law_firm_id = $1 and created_by = $2 and id = any($3::uuid[])
      returning id`,
    [lawFirmId, String(createdBy), ids],
  );
  return rows.map((row: any) => String(row.id));
}

/**
 * Update a firm's storage CONFIG (quota / hard-limit / warn-percent) authoritatively.
 *
 * Writes the typed columns in one statement. Only the keys provided are
 * changed; omitted keys are left as-is. `usedBytes` is never touched here.
 *
 * @param {string} lawFirmId
 * @param {object} config
 * @param {number} [config.quotaBytes]
 * @param {boolean} [config.hardLimit]
 * @param {number} [config.warnAtPercent]
 */
export async function updateStorageConfig(lawFirmId: string, config: {
  quotaBytes?: unknown;
  hardLimit?: unknown;
  warnAtPercent?: unknown;
} = {}) {
  const sets: string[] = [];
  const params: unknown[] = [lawFirmId];

  if (config.quotaBytes !== undefined && config.quotaBytes !== null) {
    const quota = Math.max(1, Math.trunc(Number(config.quotaBytes)));
    params.push(quota);
    sets.push(`storage_quota_bytes = $${params.length}::bigint`);
  }
  if (typeof config.hardLimit === 'boolean') {
    params.push(config.hardLimit);
    sets.push(`storage_hard_limit = $${params.length}::boolean`);
  }
  if (config.warnAtPercent !== undefined && config.warnAtPercent !== null) {
    const pct = Math.min(100, Math.max(1, Math.trunc(Number(config.warnAtPercent))));
    params.push(pct);
    sets.push(`storage_warn_at_percent = $${params.length}::int`);
  }

  if (sets.length === 0) return;

  const setClause = [...sets, 'storage_usage_updated_at = now()'].join(',\n        ');

  await infrastructureRootSql(`update law_firms set ${setClause} where id = $1`, params);
}

/**
 * Build the 413 a firm sees when an upload would exceed its storage quota.
 * Returns an AppError so the central errorHandler renders the quota message
 * and `STORAGE_LIMIT_EXCEEDED` code as-is from every caller (file uploads,
 * message attachments, client-portal uploads).
 */
export function storageLimitError({ currentUsage, incomingSize, quotaBytes }: any) {
  const available = Math.max(0, quotaBytes - currentUsage);
  return new AppError(
    `Storage limit exceeded. Current usage: ${formatBytes(currentUsage)}, ` +
    `incoming: ${formatBytes(incomingSize)}, ` +
    `limit: ${formatBytes(quotaBytes)}. ` +
    `Available space: ${formatBytes(available)}.`,
    413,
    'STORAGE_LIMIT_EXCEEDED'
  );
}

/**
 * Enforce the firm plan's per-file size cap.
 *
 * Separate from the quota: the quota is about the firm's total, this is about
 * one file being larger than the plan allows. Throws 413 naming the offending
 * file, or returns silently when the plan sets no cap.
 */
async function enforceMaxFileSize(lawFirmId: string, files: any) {
  const maxFileSizeBytes = getEffectiveLimits((await loadFirmPlan(lawFirmId)) || {}).maxFileSizeBytes;
  if (!Number.isFinite(maxFileSizeBytes) || maxFileSizeBytes <= 0) return;

  const tooBig = (files || []).find((f: any) => Number(f.size || 0) > maxFileSizeBytes);
  if (tooBig) {
    const err = new AppError(
      `"${tooBig.originalname || 'file'}" (${formatBytes(Number(tooBig.size))}) exceeds the `
      + `${formatBytes(maxFileSizeBytes)} per-file limit for this plan.`,
      413,
      'FILE_TOO_LARGE'
    );
    err.details = { maxFileSizeBytes };
    throw err;
  }
}

/**
 * Run a per-file save with the plan's size cap and an ATOMIC quota reservation.
 *
 * This is the contract every write path that holds the bytes itself should use.
 * The alternative, a quota read followed by a per-save
 * `adjustStorageUsageByDelta`, is a read and a write with the storage save in
 * between, so two concurrent uploads can both pass the read and both overshoot
 * the quota. Here:
 *
 *   1. Reject a file larger than the plan's per-file cap.
 *   2. Reserve the full incoming size (413 before anything is written when a
 *      hard limit would be exceeded).
 *   3. Run every save.
 *   4. Charge the bytes that were actually saved, then delete the reservation.
 *
 * The charge comes before the release so there is no moment where the saved
 * bytes are counted neither as usage nor as held. The release sits in a
 * `finally`, so an unexpected throw between reserve and settle cannot leave the
 * reservation standing; if the process dies instead, the reservation lapses on
 * its own at `STORAGE_RESERVATION_TTL_MS`.
 *
 * @param {string} lawFirmId
 * @param {Array} files - upload descriptors, each with `.size` (and `.originalname`)
 * @param {(file:any, index:number) => Promise<object>} saveFn - performs one save
 * @param {string} createdBy - the caller, who holds the reservation
 * @returns {Promise<{ results: object[], failures: any[], savedBytes: number }>}
 */
export async function saveUploadsWithQuota(lawFirmId: string, files: any, saveFn: any, createdBy: string) {
  await enforceMaxFileSize(lawFirmId, files);

  const incomingSize = files.reduce((sum: any, f: any) => sum + Number(f.size || 0), 0);

  const reservation = await reserveStorageUsage({ lawFirmId, createdBy, sizes: [incomingSize] });
  if (!reservation.reserved) {
    throw storageLimitError({
      currentUsage: reservation.usedBytes + reservation.heldBytes,
      incomingSize,
      quotaBytes: reservation.quotaBytes,
    });
  }

  try {
    const settled = await Promise.allSettled(files.map((f: any, i: any) => saveFn(f, i)));

    const results: any[] = [];
    const failures: any[] = [];
    let savedBytes = 0;
    settled.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
        savedBytes += Number(files[i].size || 0);
      } else {
        failures.push(outcome.reason);
      }
    });

    if (savedBytes > 0) await adjustStorageUsageByDelta(lawFirmId, savedBytes);
    return { results, failures, savedBytes };
  } finally {
    await releaseStorageReservations({
      lawFirmId, createdBy, reservationIds: reservation.reservationIds,
    }).catch((e) => console.error('saveUploadsWithQuota: reservation release failed', e));
  }
}
