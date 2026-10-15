/**
 * Conversion from a scratch upload: the source object exists only to be
 * converted, so it is deleted however the request ends, with one exception.
 *
 * A refusal because the converter is busy (`503 CONVERSION_BUSY`, from the
 * limiter in `signatures.service.ts`) never touched the source, and the
 * response invites a retry of the SAME request, which the frontend makes
 * (`retryWhileBusy`). That retry needs the upload still in place. Every other
 * outcome deletes it: a success has consumed it, and a converter that ran and
 * failed will fail the same way again. A kept source that is never retried is
 * collected by the daily scratch sweep.
 */

/** True for the converter queue's own busy refusal, which the client may retry. */
export function isConversionBusy(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'CONVERSION_BUSY';
}

/**
 * Run `work`, then delete the scratch source unless `work` was refused as
 * `CONVERSION_BUSY`. A failing delete is swallowed: it is best effort, and the
 * sweep collects what it misses. Whatever `work` returned or threw is passed
 * through unchanged.
 */
export async function consumeScratchSource<T>(
  deleteSource: () => Promise<unknown>,
  work: () => Promise<T>,
): Promise<T> {
  let keepForRetry = false;
  try {
    return await work();
  } catch (error) {
    keepForRetry = isConversionBusy(error);
    throw error;
  } finally {
    if (!keepForRetry) await deleteSource().catch(() => {});
  }
}
