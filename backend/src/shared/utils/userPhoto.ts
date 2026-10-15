// Resolves stored image object paths — user profile pictures and firm logos —
// to short-lived GCS signed URLs. Signing is a network round-trip, so a
// per-object in-memory cache (TTL well under the URL's own expiry) keeps
// message/roster lists from signing the same avatar once per row. Keyed by
// objectPath; value is { url, expiresAt }.
const { admin } = require('../database/firebase');
const { infrastructureRootSql, infrastructureSql, withDrizzleTransaction } = require('../database/infrastructureQuery');
const { runWithConcurrency } = require('./runWithConcurrency');
import { createBoundedCache } from './boundedCache';

export const BUCKET_NAME = process.env.GCS_BUCKET || 'lawfirms';
const URL_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days (GCS v4 signing max)
const CACHE_TTL_MS = 1000 * 60 * 30;        // re-sign every 30 min

/**
 * Photos signed at once. The multiplier is roster size: a cache miss costs a
 * GCS `exists()` round-trip per photo, and on a cold instance every member of a
 * firm roster or messaging participant list misses at the same moment, so the
 * fixed resource being protected is outbound GCS network (and the socket pool
 * shared with uploads and downloads).
 */
const USER_PHOTO_SIGN_CONCURRENCY = Number(process.env.USER_PHOTO_SIGN_CONCURRENCY) || 8;

/**
 * Avatar/logo objects deleted at once. A photo folder holds one object per
 * extension left by earlier uploads, so this is small by construction; the cap
 * is here so a folder that somehow grew cannot put an unbounded number of GCS
 * deletes in flight.
 */
const PHOTO_DELETE_CONCURRENCY = Number(process.env.PHOTO_DELETE_CONCURRENCY) || 8;

/**
 * Signed URLs held at once.
 *
 * The key is an object path plus a content version, so it grows with users,
 * firms and every re-upload. The TTL alone does not bound it: an entry leaves
 * the map only when that same key is signed again, and a version bumped by a
 * re-upload is a key that is never asked for a second time. At the ceiling the
 * least recently used entry is evicted, which costs one GCS signing round-trip.
 */
const PHOTO_CACHE_MAX_ENTRIES = Number(process.env.USER_PHOTO_CACHE_MAX_ENTRIES) || 5000;

const cache = createBoundedCache<string>({
  name: 'userPhoto',
  maxEntries: PHOTO_CACHE_MAX_ENTRIES,
  ttlMs: CACHE_TTL_MS,
});

/**
 * Cache key for a photo.
 *
 * `version` is what makes a re-upload visible on instances that did not serve
 * it. Avatars and logos reuse a fixed object path, so keying on the path alone
 * means freshness depends entirely on `invalidatePhotoPrefix`, which only clears
 * the one instance that handled the upload. Every other instance keeps returning
 * the byte-identical previously-signed URL for up to `CACHE_TTL_MS`, and because
 * the URL string is unchanged the browser serves its own cached image on top of
 * that. The user changes their photo and it does not stick. This is invisible at
 * one instance and guaranteed at several.
 *
 * Folding a content version (the row's `updated_at`) into the key fixes it with
 * no cross-instance messaging: a re-upload bumps the row, so every instance
 * computes a different key, misses, and re-signs. A fresh v4 signature carries a
 * new `X-Goog-Date`, so the URL string differs too and the browser refetches —
 * which is why nothing needs to be appended to the URL, and the signature stays
 * intact.
 *
 * Callers without a version keep the old path-only behaviour. That is a
 * deliberate fallback, not an oversight: it is the pre-existing staleness bound,
 * and the version is only free at call sites that already read the row.
 */
function photoCacheKey(objectPath: string | null | undefined, version?: unknown) {
  return version ? `${objectPath}#${version instanceof Date ? version.getTime() : version}` : objectPath;
}

/**
 * Sign one object path to a read URL, or return null if it isn't set / missing.
 *
 * @param {string} objectPath
 * @param {string|number|Date} [version] content version, normally the owning
 *   row's `updated_at`. Strongly preferred — see `photoCacheKey`.
 */
export async function signUserPhotoUrl(objectPath: string | null | undefined, version?: unknown) {
  if (!objectPath) return null;
  const key = photoCacheKey(objectPath, version) as string;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const file = admin.storage().bucket(BUCKET_NAME).file(objectPath);
    const [exists] = await file.exists();
    if (!exists) { cache.delete(key); return null; }
    const [url] = await file.getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + URL_TTL_MS });
    cache.set(key, url);
    return url;
  } catch {
    return null;
  }
}

/** Bulk: map of userId -> signed photoUrl for the given user ids (nulls omitted). */
export async function resolvePhotoUrls(userIds: string[]) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return {};
  // `updated_at` comes along as the content version: this query already touches
  // the row, so versioned cache keys cost nothing here.
  const { rows } = await infrastructureRootSql(
    'select id, photo_object_path, updated_at from users where id = any($1) and photo_object_path is not null',
    [ids]
  );
  const out = {};
  // Bounded at the helper rather than at each caller: firm rosters and
  // messaging participant lists all reach GCS through here, so one cap covers
  // every one of them. `signUserPhotoUrl` already swallows its own failures
  // (returning null), so nothing here can reject and the settled array needs no
  // inspection beyond the value.
  const settled = await runWithConcurrency(
    rows.map((r: any) => () => signUserPhotoUrl(r.photo_object_path, r.updated_at)),
    USER_PHOTO_SIGN_CONCURRENCY,
  );
  settled.forEach((result: any, i: number) => {
    if (result.status === 'fulfilled' && result.value) (out as Record<string, unknown>)[rows[i].id] = result.value;
  });
  return out;
}

/**
 * Drop the cached signed URLs for every path under a prefix (an avatar or logo
 * folder). Call after writing to a path so the next sign reflects the new object.
 *
 * A local fast path, no longer the thing correctness rests on: it only clears the
 * instance that handled the upload, which is why versioned cache keys exist (see
 * `photoCacheKey`). Kept because it makes the change instant on the instance the
 * user is talking to, and because it still covers callers that pass no version.
 *
 * Matches on the path portion of the key, so versioned entries clear too.
 */
export function invalidatePhotoPrefix(prefix: string) {
  if (!prefix) return;
  cache.deletePrefix(prefix);
}

/** The GCS folder holding one user's avatar objects. */
export function userPhotoPrefix(userId: string) { return `users/${userId}/avatar/`; }

/**
 * Delete a user's stored avatar objects and forget their cached signed URLs.
 * `except` keeps one path (the object just written) so a re-upload can clear
 * avatars left behind at other file extensions without removing the new one.
 * Best-effort: storage cleanup must never fail the calling operation.
 */
export async function deleteUserPhotoObjects(userId: string, { except }: { except?: string | null } = {}) {
  if (!userId) return;
  const prefix = userPhotoPrefix(userId);
  try {
    const bucket = admin.storage().bucket(BUCKET_NAME);
    if (!except) {
      await bucket.deleteFiles({ prefix, force: true });
    } else {
      const [files] = await bucket.getFiles({ prefix });
      await runWithConcurrency(
        files.filter((f: any) => f.name !== except).map((f: any) => () => f.delete().catch(() => {})),
        PHOTO_DELETE_CONCURRENCY,
      );
    }
  } catch { /* best effort */ }
  // Includes `except`: that path was just overwritten, so its cached URL points
  // at the previous image.
  invalidatePhotoPrefix(prefix);
}
