/**
 * The document converter's limits on this instance, read from the environment.
 *
 * Kept apart from `signatures.service.ts` so they can be read without loading
 * the converter and the storage client behind it.
 */
import { positiveIntFromEnv } from '../../shared/utils/positiveIntFromEnv';

/**
 * Concurrent LibreOffice conversions allowed on this instance.
 *
 * Each call spawns a `soffice` process, and the container is provisioned at
 * 512Mi (pinned in cloudbuild.yaml) with Node's own heap already inside that.
 * One conversion at a time is what that budget actually supports; two is
 * already optimistic. The cap is PER INSTANCE, so total concurrency across the
 * service is this times the instance count. Deliberate, but it means raising
 * max-instances also raises peak converter memory demand.
 */
export const DOC_CONVERT_CONCURRENCY = positiveIntFromEnv('DOC_CONVERT_CONCURRENCY', 1);

/**
 * How long a conversion waits for a slot before it is refused.
 *
 * The queue deadline matters as much as the cap: without it a backlog of
 * conversions becomes a backlog of held-open sockets, and a saturated converter
 * turns into a saturated server. Callers get an explicit failure instead.
 */
export const DOC_CONVERT_QUEUE_TIMEOUT_MS = positiveIntFromEnv('DOC_CONVERT_QUEUE_TIMEOUT_MS', 45_000);
