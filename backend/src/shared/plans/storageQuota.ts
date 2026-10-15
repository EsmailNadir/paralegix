import { PLAN_TIERS, DEFAULT_PLAN_ID } from './planDefinitions';

// Last-resort quota for a firm whose stored quota is missing entirely. It tracks
// the default plan tier so a firm can never be told it has less room than the
// cheapest plan sells; every real firm gets its own plan's quota written to
// `law_firms.storage_quota_bytes` at creation and on every plan change.
export const DEFAULT_STORAGE_QUOTA_BYTES = PLAN_TIERS[DEFAULT_PLAN_ID].limits.storageQuotaBytes;
export const DEFAULT_STORAGE_WARN_AT_PERCENT = 85;
export const DEFAULT_STORAGE_HARD_LIMIT = true;

function toSafeInteger(value: unknown, fallback: number) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function clampPercent(value: unknown, fallback: number) {
  const parsed = toSafeInteger(value, fallback);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 1) return 1;
  if (parsed > 100) return 100;
  return parsed;
}

export function normalizeStorageSettings(input: {
  quotaBytes?: unknown;
  usedBytes?: unknown;
  warnAtPercent?: unknown;
  hardLimit?: unknown;
} = {}) {
  const quotaBytesRaw = toSafeInteger(input.quotaBytes, DEFAULT_STORAGE_QUOTA_BYTES);
  const usedBytesRaw = toSafeInteger(input.usedBytes, 0);

  const quotaBytes = quotaBytesRaw > 0 ? quotaBytesRaw : DEFAULT_STORAGE_QUOTA_BYTES;
  const usedBytes = usedBytesRaw >= 0 ? usedBytesRaw : 0;

  return {
    quotaBytes,
    usedBytes,
    warnAtPercent: clampPercent(input.warnAtPercent, DEFAULT_STORAGE_WARN_AT_PERCENT),
    hardLimit: typeof input.hardLimit === 'boolean'
      ? input.hardLimit
      : DEFAULT_STORAGE_HARD_LIMIT,
  };
}
