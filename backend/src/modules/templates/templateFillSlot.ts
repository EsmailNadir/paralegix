/**
 * How many template renders hold a whole document in memory at once, per instance.
 *
 * Filling a DOCX or overlay template, and rendering a DOCX preview, is a genuine
 * transform: the stored document (up to `TEMPLATE_MAX_BYTES`, 25 MB) and its
 * placement images (up to 25 MB together) are read into this process, and
 * docxtemplater or pdf-lib then makes further copies while it works. The per-read
 * caps bound ONE render. Nothing bounded how many ran at once, so a burst of
 * fills was a burst of whole documents inside one 512 MiB container.
 *
 * This is deliberately its own limiter, NOT the transfer slot in
 * `shared/utils/transferSlot.ts`. That slot is shared with the signing drain and
 * the folder-export drain, which can hold it for minutes; a person pressing Fill
 * must not queue behind a background job. Those paths stream rather than buffer,
 * so they do not compete for the same memory this protects.
 *
 * The queue deadline turns a backlog into a fast 503 the client can retry,
 * rather than a pile of open sockets each holding a request body.
 */
import { AppError } from '../../shared/errors/AppError';
import { createBusyGate } from '../../shared/utils/busyGate';
import { positiveIntFromEnv } from '../../shared/utils/positiveIntFromEnv';

// Every number below is a deploy knob (`cloudbuild.yaml` passes them through),
// and every default is the value the memory budget above was sized for, which
// is why each is read as a positive integer or not at all.

/** Concurrent in-memory template renders on one instance. */
export const TEMPLATE_FILL_CONCURRENCY = positiveIntFromEnv('TEMPLATE_FILL_CONCURRENCY', 2);

/** How long a render waits for a slot before the request is refused. */
export const TEMPLATE_FILL_QUEUE_TIMEOUT_MS = positiveIntFromEnv('TEMPLATE_FILL_QUEUE_TIMEOUT_MS', 30_000);

/**
 * A gate admitting `limit` renders at once.
 *
 * Only a timeout waiting for THIS gate becomes `TEMPLATE_FILL_BUSY`, with a
 * `Retry-After`. An error the render itself throws passes through untouched,
 * including the document converter's own `CONVERSION_BUSY`.
 */
export function createTemplateFillSlot(limit: number, queueTimeoutMs: number) {
  return createBusyGate(limit, {
    queueTimeoutMs,
    message: 'Too many documents are being prepared right now. Please try again in a moment.',
    code: 'TEMPLATE_FILL_BUSY',
  });
}

/** This instance's gate, shared by every fill and DOCX preview render. */
export const withTemplateFillSlot = createTemplateFillSlot(
  TEMPLATE_FILL_CONCURRENCY,
  TEMPLATE_FILL_QUEUE_TIMEOUT_MS,
);

/**
 * Concurrent PDF exports one API instance asks Chromium for.
 *
 * Not a memory bound on this process, which never holds the images or the PDF:
 * a bound on the document worker. It runs one job per instance, and this slot
 * plus the LibreOffice conversion slot in `signatures.service.ts` must not ask
 * for more jobs than the worker has instances. Above that, Cloud Run holds the
 * extra request briefly and then refuses it, which the caller sees as a failed
 * export rather than a short wait. `tests/config/deployBudget.test.ts` checks
 * the sum against `cloudbuild.yaml`.
 */
export const TEMPLATE_EXPORT_CONCURRENCY = positiveIntFromEnv('TEMPLATE_EXPORT_CONCURRENCY', 1);

/** How long an export waits for the render slot before the request is refused. */
export const TEMPLATE_EXPORT_QUEUE_TIMEOUT_MS = positiveIntFromEnv('TEMPLATE_EXPORT_QUEUE_TIMEOUT_MS', 45_000);

/** This instance's gate for PDF export renders. */
export const withTemplateExportSlot = createTemplateFillSlot(
  TEMPLATE_EXPORT_CONCURRENCY,
  TEMPLATE_EXPORT_QUEUE_TIMEOUT_MS,
);

/** Template renders one person may have queued or running at once, on this instance. */
export const TEMPLATE_RENDERS_PER_PERSON = positiveIntFromEnv('TEMPLATE_RENDERS_PER_PERSON', 2);

/**
 * A per-person cap on renders in flight, counted across fill, preview and PDF
 * export alike.
 *
 * The slots above are FIFO queues shared by the whole firm, and the whole app.
 * Without this, one script or one person with several tabs could take every
 * place in them, and everyone else's render would wait out its deadline and
 * fail. A render past the cap is refused at once with 429 rather than queued,
 * so one person holds at most two places in any queue. The buttons are
 * disabled while a render runs, so normal use never reaches it.
 *
 * Counted in memory, so per API instance: exact while staging runs one, and
 * still a per-instance bound if that grows.
 */
export function createPerPersonRenderCap(limit: number) {
  const inFlight = new Map<string, number>();
  return async function withPersonCap<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const key = String(userId || '');
    const current = inFlight.get(key) || 0;
    if (current >= limit) {
      throw new AppError(
        'You already have documents being prepared. Please wait for them to finish.',
        429,
        'TEMPLATE_RENDER_IN_PROGRESS',
      );
    }
    inFlight.set(key, current + 1);
    try {
      return await work();
    } finally {
      const remaining = (inFlight.get(key) || 1) - 1;
      if (remaining > 0) inFlight.set(key, remaining);
      else inFlight.delete(key);
    }
  };
}

/** This instance's cap, shared by every fill, DOCX preview and PDF export. */
export const withPersonRenderCap = createPerPersonRenderCap(TEMPLATE_RENDERS_PER_PERSON);
