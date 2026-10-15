import { z } from 'zod';

/**
 * How many matters one batched file listing may name.
 *
 * Sized from the caller, not from the table. The client detail page's Files tab
 * asks for every matter the client is billed through, and `listAllClientMatters`
 * pages that list at 500, so the realistic worst case is a corporate client with
 * a few hundred matters.
 *
 * Five hundred in one request is ruled out twice over. At 37 bytes per
 * comma-joined uuid that is about 18.5 KB of request line, past the 16 KB Node
 * allows for the request line and every header together (the Authorization
 * bearer token, about 1 KB, draws on the same budget), so the HTTP parser would
 * refuse it before any code here ran. And the response is the bigger limit: each
 * matter answers with a page of up to `FILES_SUBTREE_PAGE_SIZE` entries, so the
 * id count multiplies the worst-case body.
 *
 * A hundred bounds both. The request line is about 4.8 KB including the token,
 * under a third of the budget, and the worst-case body is a hundred pages rather
 * than five hundred, which is exactly the set of rows the unbatched Files tab
 * already pulled over a hundred separate requests. It is also the cap the matter
 * CLIENTS batch uses, so the two batched reads a page fires together chunk
 * identically instead of each imposing its own arithmetic on the caller. A
 * client with more matters than this chunks the read; it is never silently
 * truncated, because a dropped id reads downstream as "this matter has no
 * documents" rather than as an error.
 */
export const MAX_BATCH_MATTER_IDS = 100;

/**
 * GET /files/list-matters?matterIds=a,b,c
 *
 * Comma-separated rather than repeated, so the URL stays short, and split here
 * rather than in the route so the cap is enforced by the validation middleware
 * before the handler (and therefore before any query) runs.
 */
export const listFilesForMattersSchema = z.object({
  query: z.object({
    matterIds: z.string()
      .transform((value) => value.split(',').map((id) => id.trim()).filter(Boolean))
      .pipe(
        z.array(z.string().uuid('matterIds must be matter ids'))
          .min(1, 'matterIds is required')
          .max(
            MAX_BATCH_MATTER_IDS,
            `Too many matterIds: maximum is ${MAX_BATCH_MATTER_IDS} per request. Page the request into smaller batches.`,
          ),
      ),
  }),
});

export const listClientTaskFilesSchema = z.object({
  query: z.object({
    clientId: z.string().uuid('clientId must be a client id'),
  }),
});

/**
 * How many files one batched client-visibility change may name.
 *
 * Sized from the caller, not from the table. The two callers are the file
 * browser's select-all over one folder listing and the client-share picker's
 * accumulated ticks, and the widest set any read in this module can hand either
 * of them in one response is `SUBTREE_MAX_PAGE_SIZE`: `/list` and `/list-matters`
 * clamp their page there, and `/search` stops at 200. So a thousand is the
 * largest selection a user can build without going back for a second page, and
 * anything below it would refuse a legitimate select-all.
 *
 * The request is a JSON body rather than a URL, so the request-line budget that
 * decided `MAX_BATCH_MATTER_IDS` does not apply: a thousand uuids is about 40 KB
 * against a 2 MB `express.json` limit. What bounds it instead is the write. The
 * whole batch is one transaction holding one of the instance's shared
 * connections, and the
 * insert it runs is one row per file per named client, so the id count
 * multiplies against the recipient list.
 *
 * `MAX_BULK_TASK_IDS` (5,000) is deliberately not borrowed. That number is sized
 * from the task list's own id-only select-all ceiling, and there is no equivalent
 * ceiling here, so taking the number would mean taking a justification that does
 * not hold.
 *
 * A caller with more than this chunks the request. It is never silently
 * truncated: a dropped id reads downstream as "this file was shared" when it was
 * not, which is the one failure a sharing control must never have.
 */
export const MAX_BULK_VISIBILITY_FILE_IDS = 1000;

/**
 * PATCH /files/bulk-client-visibility
 *
 * `fileIds` is validated as uuids, so a malformed id is a 400 for the request
 * rather than a per-file outcome. A file id always comes from this same API, so
 * a value that could not name a row in ANY firm is a caller bug and not a
 * permission answer; the per-file `errors` map is for ids that are well-formed
 * and simply out of reach.
 *
 * The cap lives here rather than in the handler so `validate` enforces it before
 * the handler, and therefore before any write.
 */
export const setClientVisibilityBulkSchema = z.object({
  body: z.object({
    fileIds: z.array(z.string().uuid('fileIds must be file ids'))
      .min(1, 'fileIds is required')
      .max(
        MAX_BULK_VISIBILITY_FILE_IDS,
        `Too many fileIds: maximum is ${MAX_BULK_VISIBILITY_FILE_IDS} per request. Page the request into smaller batches.`,
      ),
    clientVisible: z.boolean(),
    visibleClientIds: z.array(z.string().uuid()).nullish(),
    notifyClient: z.boolean().optional(),
    matterId: z.string().uuid().nullish(),
    taskId: z.string().uuid().nullish(),
    clientId: z.string().uuid().nullish(),
  }),
});
