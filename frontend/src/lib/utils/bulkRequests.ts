/**
 * How a bulk action sends one request per selected row.
 *
 * THE PROBLEM. A bulk handler used to hand every selected row to `Promise.all`,
 * which starts all of them at once. One API instance holds a twelve-connection
 * Postgres pool and serves roughly fifty users, so a select-all-then-delete over
 * the firm time-entry list (the select-all ceiling is 1,000 rows) opened a
 * thousand simultaneous requests and took the pool away from everyone else for
 * as long as it ran.
 *
 * WHERE THIS STILL APPLIES. A gate is second best: a route that takes the whole
 * selection in one request is better still, because four at a time is a thousand
 * round trips rather than a thousand at once. Time-entry deletion moved to
 * `POST /billing/time-entries/bulk-delete` for that reason, and client file
 * sharing to `PATCH /files/bulk-client-visibility`.
 *
 * What is left for this gate is a selection that genuinely cannot go in one
 * request. `ClientShareFilePicker` is the example: a selection survives a tab
 * switch, so it can name a matter's documents and a client's own area at once,
 * and each request carries ONE scope because the scope is what the server
 * authorizes the batch against. So it runs over the scope GROUPS, which is
 * normally one, rather than over the files.
 *
 * `Promise.all` also loses the outcome. It rejects on the FIRST failure while
 * every other request keeps running unobserved, so the handler's catch block
 * fires with hundreds of deletes still in flight and no way to say which rows
 * were removed. The list on screen then disagrees with the server.
 *
 * WHAT THIS DOES INSTEAD. At most `MAX_ACTIVE_BULK_REQUESTS` requests are in
 * flight; every item is attempted whatever its neighbours do; and the caller
 * gets back both halves of the outcome so it can report a partial run honestly
 * and offer the failures for retry.
 *
 * The gate is PER CALL, not app-wide. That is the opposite of
 * `lib/files/uploadConcurrency.ts`, deliberately: uploads share one uplink, so
 * counting them separately would defeat the limit, while two bulk actions are
 * two user intents and serialising one behind the other would look like a hang.
 */

/**
 * Four.
 *
 * Each of these requests is a WRITE, so it holds one of the instance's twelve
 * Postgres connections for its whole duration. Four is a third of the pool: two
 * users running a bulk action at the same moment take eight and still leave four
 * for everyone else's ordinary page reads. Six would let those same two runs
 * take the entire pool between them, which is the failure this gate exists to
 * prevent, only slower. Below four the round trips stop overlapping usefully and
 * a long run turns into a queue.
 */
export const MAX_ACTIVE_BULK_REQUESTS = 4;

export interface BulkFailure<T> {
  item: T;
  error: unknown;
}

export interface BulkRunResult<T> {
  /** Items whose request resolved, in the order they were given. */
  succeeded: T[];
  /** Items whose request rejected, in the order they were given, with the reason. */
  failed: Array<BulkFailure<T>>;
}

export interface BulkRunOptions {
  /**
   * Called once per SETTLED item, success or failure, with the number settled
   * so far and the total. A failure counts, so a progress readout cannot stall
   * on a row the server refused.
   */
  onProgress?: (done: number, total: number) => void;
  /** Override the in-flight bound. Callers should not need this; tests do. */
  limit?: number;
}

/**
 * Run `task` over `items` with a bounded number of requests in flight.
 *
 * Never rejects: a task that throws, synchronously or asynchronously, lands in
 * `failed` alongside the item that produced it. Callers decide what a partial
 * run means for their surface, because only they know whether the rows that did
 * succeed are safe to treat as done.
 */
export async function runBulkRequests<T>(
  items: readonly T[],
  task: (item: T) => Promise<unknown>,
  options: BulkRunOptions = {},
): Promise<BulkRunResult<T>> {
  const total = items.length;
  if (total === 0) return { succeeded: [], failed: [] };

  const limit = Math.max(1, options.limit ?? MAX_ACTIVE_BULK_REQUESTS);
  // Outcomes are written back at the item's own index so `succeeded` and
  // `failed` come out in selection order however the requests interleave. A
  // list that reorders itself between runs is not a list the user can retry from.
  const outcomes: Array<{ ok: boolean; error?: unknown }> = new Array(total);

  let next = 0;
  let settled = 0;

  const worker = async (): Promise<void> => {
    while (next < total) {
      const index = next;
      next += 1;
      try {
        // `await` inside the try, not a returned promise, so a task that throws
        // before its first await is caught here rather than escaping the loop.
        await task(items[index]);
        outcomes[index] = { ok: true };
      } catch (error) {
        outcomes[index] = { ok: false, error };
      }
      settled += 1;
      options.onProgress?.(settled, total);
    }
  };

  // Exactly `limit` workers, each pulling the next item when its own finishes.
  // Nothing here can reject, so the gate cannot be left holding slots.
  await Promise.all(Array.from({ length: Math.min(limit, total) }, () => worker()));

  const succeeded: T[] = [];
  const failed: Array<BulkFailure<T>> = [];
  for (let index = 0; index < total; index += 1) {
    const outcome = outcomes[index];
    if (outcome.ok) succeeded.push(items[index]);
    else failed.push({ item: items[index], error: outcome.error });
  }
  return { succeeded, failed };
}

/**
 * What a surface shows WHILE a bulk run is going.
 *
 * A thousand rows three at a time is a long wait, and a spinner alone says
 * nothing about how far in it is, so every bulk surface counts up in the same
 * wording. `verb` is the present participle ("Deleting", "Sharing").
 */
export function bulkProgressMessage(verb: string, done: number, total: number): string {
  return `${verb}… ${done} of ${total} done.`;
}

/**
 * The sentence a surface shows when a bulk run did not fully succeed.
 *
 * One wording for every bulk action, because the honest report is the part that
 * was silently missing everywhere: the old handlers surfaced a bare "Failed to
 * delete entries" whether one row failed or all of them did, with no hint that
 * the rest had gone through.
 *
 * `noun` is the plural noun for the row ("time entries", "files"); `verb` is the
 * past participle of what succeeded ("deleted", "shared"). `aftermath` says what
 * became of the ones that failed, and is worded to read the same for one as for
 * many, since a bulk run of one is an ordinary thing to do.
 */
export function bulkFailureMessage(
  result: BulkRunResult<unknown>,
  verb: string,
  noun: string,
  aftermath = "stayed selected",
): string {
  const failedCount = result.failed.length;
  const total = failedCount + result.succeeded.length;
  if (failedCount === 0) return "";
  if (result.succeeded.length === 0) {
    return `None of the ${total} ${noun} could be ${verb}.`;
  }
  return `${result.succeeded.length} of ${total} ${noun} ${verb}. ${failedCount} could not be ${verb} and ${aftermath}.`;
}

/**
 * The sentence for a bulk route that answered 200 but refused some rows.
 *
 * The matter and task bulk routes take the whole selection in one request and
 * answer `{ requested, updated | deleted, failed, errors }`, where `errors`
 * maps each refused id to its reason (legal hold, no write access, billing
 * history). `bulkFailureMessage` above describes a client-side run instead, one
 * request per row, so it cannot read this shape.
 *
 * Returns "" when nothing was refused. Distinct reasons are listed once, since
 * a hundred rows under one hold would otherwise repeat the same sentence.
 */
export function serverBulkFailureMessage(
  result: {
    requested: number;
    updated?: number;
    deleted?: number;
    failed?: string[];
    errors?: Record<string, string>;
  },
  verb: string,
  noun: string,
): string {
  const failedCount = result.failed?.length ?? 0;
  if (failedCount === 0) return "";
  const done = result.updated ?? result.deleted ?? 0;
  const reasons = [...new Set(Object.values(result.errors ?? {}).filter(Boolean))];
  const head = `${done} of ${result.requested} ${noun} ${verb}. ${failedCount} could not be ${verb}`;
  return reasons.length ? `${head}: ${reasons.join(" ")}` : `${head}.`;
}
