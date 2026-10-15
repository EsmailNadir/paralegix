/**
 * Picking a destination name that does not clobber what is already there.
 *
 * Storage has no notion of a name collision: saving to an occupied path replaces
 * its contents and reports success. Anywhere a user-visible file is written into
 * a folder, that silent replacement is data loss, so the destination is resolved
 * against what already exists first.
 *
 * The bucket is a parameter rather than a module import, matching listObjects:
 * it keeps this testable with a stub and lets callers pass whichever bucket they
 * already resolved.
 */

/**
 * Split a filename into stem and extension at the LAST dot. A leading dot (e.g.
 * ".env") is part of the stem, not an extension, matching Windows.
 */
export function splitFileName(filename: string): { stem: string; ext: string } {
  const dot = filename.lastIndexOf('.');
  if (dot > 0) return { stem: filename.slice(0, dot), ext: filename.slice(dot) };
  return { stem: filename, ext: '' };
}

/** How many suffixes to try before giving up on a readable name. */
const MAX_TRIES = 1000;

/**
 * Resolve a free object path inside `dir` (a prefix ending in '/').
 *
 * If `dir + filename` is unoccupied it is used as-is; otherwise the first
 * available "name (n).ext" is returned (Windows-style: "file.pdf" becomes
 * "file (1).pdf", then "file (2).pdf").
 *
 * Resolves to the free path and the (possibly suffixed) basename chosen.
 *
 * `claimed` makes a path taken as soon as THIS request has picked it, before any
 * bytes exist at it. Without it, two files of the same name in one request both
 * resolve to the same destination and the second write replaces the first, which
 * this resolver exists to prevent. Existence alone cannot see that: on the
 * resumable path no object exists yet at init time, and on the multipart path the
 * saves run concurrently, so both probes complete before either write lands.
 *
 * Pass ONE set per request and reuse it across every file in that request.
 */
export async function resolveUniquePath(
  bucket: { file(path: string): { exists(): Promise<[boolean]> } },
  dir: string,
  filename: string,
  claimed?: Set<string>,
): Promise<{ path: string; name: string }> {
  // The claim is taken SYNCHRONOUSLY, before the first await, and given back if
  // the probe finds the path occupied. That ordering is the whole point: a claim
  // added after the await would let two concurrent callers both pass the check
  // and both claim the same path, which is the bug this parameter fixes.
  const claim = (p: string) => {
    if (!claimed) return true;
    if (claimed.has(p)) return false;
    claimed.add(p);
    return true;
  };
  const release = (p: string) => { if (claimed) claimed.delete(p); };
  const exists = async (p: string) => (await bucket.file(p).exists())[0];

  if (claim(dir + filename)) {
    if (!(await exists(dir + filename))) return { path: dir + filename, name: filename };
    release(dir + filename);
  }

  const { stem, ext } = splitFileName(filename);
  for (let n = 1; n <= MAX_TRIES; n += 1) {
    const candidateName = `${stem} (${n})${ext}`;
    if (!claim(dir + candidateName)) continue;
    // eslint-disable-next-line no-await-in-loop -- sequential probe for the first free suffix
    if (!(await exists(dir + candidateName))) return { path: dir + candidateName, name: candidateName };
    release(dir + candidateName);
  }

  // Pathological fallback: thousands of same-named files. Keep the write moving
  // rather than failing it, since any free name is better than an overwrite.
  const fallback = `${stem} (${Date.now()})${ext}`;
  claim(dir + fallback);
  return { path: dir + fallback, name: fallback };
}

/**
 * Resolve a destination for a system-driven write that must be safe to retry:
 * reuse the exact object a PRIOR attempt already wrote for the same owner
 * (identified by one custom-metadata key/value), instead of always picking a
 * new name the way `resolveUniquePath` does for user-facing writes.
 *
 * This exists for a write that stores its bytes and THEN records that fact
 * elsewhere (a DB row, a session status) in a separate step. If that second
 * step fails, a retry that re-ran `resolveUniquePath` would find its own
 * previous object occupying the name, treat it like an unrelated collision, and
 * file a SECOND copy under "name (1)" - charging storage twice and leaving the
 * first copy an orphan nothing points at. Signing publication follows the same
 * in `signing.routes.ts` for the caller this was written for: the retry is the
 * finalize recovery pass re-running after a live completion request stored the
 * signed document but failed to commit the session's 'completed' state.
 *
 * The candidate sequence is IDENTICAL to `resolveUniquePath`'s (first the bare
 * name, then "name (1).ext", "name (2).ext", ...), so a fresh call with no
 * prior attempt lands on the exact same path `resolveUniquePath` would have
 * chosen. The only difference is what happens when a candidate is already
 * occupied: `resolveUniquePath` always moves on to the next one, but this reads
 * the occupying object's custom metadata first. A match on `ownerKey`/`ownerId`
 * means "this is my own earlier attempt" and it is reused (the caller
 * overwrites it); anything else is someone else's file, which must still not be
 * touched, so the search continues exactly as `resolveUniquePath`'s does.
 *
 * Returns the previously-stored size (`reusedSizeBytes`) when reusing, so a
 * caller charging storage by the byte can charge only the size DELTA instead of
 * the object's full size again.
 */
export async function resolveOwnedOrUniquePath(
  bucket: {
    file(path: string): {
      exists(): Promise<[boolean]>;
      getMetadata(): Promise<[{ size?: string | number; metadata?: Record<string, string> }]>;
    };
  },
  dir: string,
  filename: string,
  ownerKey: string,
  ownerId: string,
): Promise<{ path: string; name: string; reusedSizeBytes: number | null }> {
  const { stem, ext } = splitFileName(filename);

  for (let n = 0; n <= MAX_TRIES; n += 1) {
    const candidateName = n === 0 ? filename : `${stem} (${n})${ext}`;
    const candidatePath = dir + candidateName;
    const file = bucket.file(candidatePath);
    // eslint-disable-next-line no-await-in-loop -- sequential probe, same shape as resolveUniquePath
    const [exists] = await file.exists();
    if (!exists) return { path: candidatePath, name: candidateName, reusedSizeBytes: null };

    // eslint-disable-next-line no-await-in-loop
    const [metadata] = await file.getMetadata();
    if (metadata?.metadata?.[ownerKey] === ownerId) {
      const size = Number(metadata.size);
      return { path: candidatePath, name: candidateName, reusedSizeBytes: Number.isFinite(size) ? size : null };
    }
  }

  // Same pathological fallback as resolveUniquePath: no metadata check needed,
  // since a fresh timestamp-suffixed name cannot already exist.
  const fallback = `${stem} (${Date.now()})${ext}`;
  return { path: dir + fallback, name: fallback, reusedSizeBytes: null };
}
