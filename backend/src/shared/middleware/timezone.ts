import type { NextFunction, Request, Response } from 'express';
import { createBoundedCache } from '../utils/boundedCache';

const { infrastructureRootSql, infrastructureSql, withDrizzleTransaction } = require('../database/infrastructureQuery');
const { trackBackgroundWrite } = require('../utils/backgroundWrites');

// Cache of the last timezone persisted per user, so a user clicking around the
// app issues one write when their zone actually changes rather than one per
// request. Bounded so a large firm cannot grow it without limit; eviction just
// costs a redundant write.
const MAX_TRACKED_USERS = 5000;

/**
 * How long a remembered zone is trusted. Expiry costs one redundant UPDATE that
 * the `is distinct from` clause turns into a no-op, so it is cheap; what it buys
 * is that a user who stops visiting is forgotten rather than held forever.
 */
const TIMEZONE_MEMORY_TTL_MS = 60 * 60 * 1000;

const lastPersisted = createBoundedCache<string>({
  name: 'timezoneLastPersisted',
  maxEntries: MAX_TRACKED_USERS,
  ttlMs: TIMEZONE_MEMORY_TTL_MS,
});

/**
 * Persist the caller's IANA timezone when it differs from what we last wrote.
 *
 * Scheduled work (the daily digest, reminder emails) has no request to read a
 * timezone from, so it depends on a stored one. Nothing else writes this column,
 * and asking users to set it by hand leaves it empty for everyone who never
 * visits that settings page. Capturing it from the request the browser already
 * stamps means an active user is correct within one page load.
 *
 * Fire-and-forget: a failure here must never affect the response.
 */
export function persistTimezone(userId: string, tz: string) {
  if (!userId || !tz) return;
  if (lastPersisted.get(userId) === tz) return;

  // At the ceiling the least recently used user is evicted. The whole map used
  // to be cleared instead, which sent every active user a redundant write at
  // once.
  lastPersisted.set(userId, tz);

  // Registered so the test harness can settle it before truncating. In
  // production this is the same fire-and-forget write it always was; see
  // shared/utils/backgroundWrites.ts for why an untracked one is a hazard.
  trackBackgroundWrite(infrastructureRootSql(
    `update users set timezone = $2, updated_at = now()
      where id = $1 and timezone is distinct from $2`,
    [userId, tz]
  )).catch((err: any) => {
    lastPersisted.delete(userId);
    console.error('[timezone] failed to persist user timezone:', err.message);
  });
}

/** Extract a required IANA timezone from query/body/header. */
function extractTimezone(req: Request) {
  // Priority: explicit param beats header
  return (
    (typeof req.query.tz === 'string' && req.query.tz.trim()) ||
    (req.body && typeof req.body.timeZone === 'string' && req.body.timeZone.trim()) ||
    req.header('X-Timezone') ||
    req.header('x-timezone') ||
    ''
  );
}

/** Require tz for certain routes; attach to req.tz */
export function requireTimezone(req: Request, res: Response, next: NextFunction) {
  const tz = extractTimezone(req);
  if (!tz) {
    return res.status(400).json({
      error:
        "Timezone is required. Provide it as ?tz=America/Los_Angeles (GET) or { timeZone: 'America/Los_Angeles' } (POST), or X-Timezone header.",
    });
  }
  const normalized = tz.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized });
  } catch {
    return res.status(400).json({
      error: `Invalid timezone: ${normalized}. Expected an IANA timezone like America/Los_Angeles.`,
    });
  }

  req.tz = normalized;
  // Both are set by the time this runs, but the fire-and-forget write is
  // skipped rather than sent with an undefined uid if verifyToken did not run.
  if (req.user?.uid && req.tz) persistTimezone(req.user.uid, req.tz);
  next();
}

/**
 * Resolve the caller's zone when they sent one, and carry on when they did
 * not. For a route that needs the caller's day only to fill in a default (a
 * payment's date when none is given): refusing the request for want of a zone
 * would break callers that never sent one, so `req.tz` is simply left unset
 * and the service falls back to the caller's saved zone.
 */
export function optionalTimezone(req: Request, _res: Response, next: NextFunction) {
  const tz = extractTimezone(req).trim();
  if (tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      req.tz = tz;
      if (req.user?.uid) persistTimezone(req.user.uid, tz);
    } catch {
      // An unusable zone is treated as none: the default falls back instead.
    }
  }
  next();
}
