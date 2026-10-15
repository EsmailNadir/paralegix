/**
 * Paging over a storage prefix.
 *
 * `bucket.getFiles()` returns one page at a time unless told otherwise, and the
 * page token is easy to drop. Where that happens the caller silently sees only
 * the first page, which reads as "this is everything" — the portal's client
 * document list did exactly that, capping the scan at 500 objects and running the
 * shared-with-client filter afterwards, so a busy matter could hide documents the
 * firm had deliberately shared.
 *
 * `autoPaginate: true` would also walk the whole prefix, but it hands back every
 * object at once with no ceiling and no way to observe progress. These helpers
 * page explicitly so a caller can stream pages, and so the one bound that remains
 * is loud rather than silent.
 *
 * The bucket is a parameter rather than a module import: it keeps this pure
 * enough to test with a stub, and lets callers pass whichever bucket they already
 * resolved.
 */

/** Objects fetched per round-trip. */
export const DEFAULT_PAGE_SIZE = 1000;

/**
 * Objects walked before a scan gives up. Deliberately far above any realistic
 * prefix: it exists so a runaway scan cannot pin the process, not to bound normal
 * use, and hitting it logs rather than quietly returning a short list.
 */
export const DEFAULT_CEILING = 25000;

/**
 * Ceiling for scans that have to reach the end to be correct at all.
 *
 * A recount that stops early reports a number smaller than the truth, and a
 * cascade delete that stops early leaves objects behind with nothing left
 * referencing them. Neither has a partial answer worth returning, so they walk
 * the prefix to exhaustion; memory stays bounded either way, because these
 * callers stream pages rather than collecting them.
 *
 * Pass it explicitly. An exhaustive scan should be a visible decision at the
 * call site, not the default.
 */
export const NO_CEILING = Infinity;

/**
 * The bits of a GCS `Bucket` and `File` this module touches. Declared
 * structurally rather than importing @google-cloud/storage's types, so callers
 * that pass a test double or a narrowed wrapper still type-check.
 */
export interface StorageFile {
  name: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ListableBucket {
  getFiles(query: {
    prefix?: string;
    autoPaginate?: boolean;
    maxResults?: number;
    pageToken?: string | null;
  }): Promise<[StorageFile[], { pageToken?: string | null } | null | undefined, unknown?]>;
}

/** Page size and the scan ceiling that makes `truncated` meaningful. */
export interface ListOptions {
  pageSize?: number;
  ceiling?: number;
}

/**
 * Call `onPage` with each page of objects under `prefix` until the listing is
 * exhausted, or the ceiling is reached.
 *
 * Returns `{ scanned, truncated }`. `truncated` is the signal a caller needs to
 * tell "there was nothing more" apart from "we stopped looking".
 */
export async function forEachObjectPage(
  bucket: ListableBucket,
  prefix: string,
  onPage: (files: StorageFile[]) => unknown | Promise<unknown>,
  options: ListOptions = {},
): Promise<{ scanned: number; truncated: boolean }> {
  const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
  const ceiling = options.ceiling || DEFAULT_CEILING;

  let pageToken: string | null = null;
  let scanned = 0;
  let truncated = false;

  do {
    // eslint-disable-next-line no-await-in-loop
    const [files, nextQuery] = await bucket.getFiles({
      prefix,
      autoPaginate: false,
      maxResults: pageSize,
      pageToken,
    });

    if (files && files.length > 0) {
      scanned += files.length;
      // eslint-disable-next-line no-await-in-loop
      await onPage(files);
    }

    pageToken = (nextQuery && nextQuery.pageToken) || null;

    if (scanned >= ceiling && pageToken) {
      truncated = true;
      console.warn(
        `[storage] Prefix scan stopped at ${scanned} objects under ${prefix}; results may be incomplete.`
      );
      break;
    }
  } while (pageToken);

  return { scanned, truncated };
}

/**
 * Every object under `prefix`, collected, alongside what the scan reported.
 *
 * For callers that genuinely need the whole set in memory to answer a question
 * about it (which of these is shared with this client, which are direct
 * children). Callers that only process objects should stream with
 * `forEachObjectPage` instead of materializing the list.
 *
 * The truncation flag is the point: a bare array cannot express "the scan
 * stopped early", so a partial listing would read as a complete one.
 */
export async function listObjectsWithMeta(
  bucket: ListableBucket,
  prefix: string,
  options: ListOptions = {},
): Promise<{ objects: StorageFile[]; scanned: number; truncated: boolean }> {
  const objects: StorageFile[] = [];
  const { scanned, truncated } = await forEachObjectPage(
    bucket,
    prefix,
    (files) => { objects.push(...files); },
    options
  );
  return { objects, scanned, truncated };
}
