/**
 * Which @mentions on a note or a reply are honoured.
 *
 * A mention notifies its target with a preview of the note and a deep link to
 * it, so it discloses the note. The ids a caller sends are therefore narrowed to
 * people who could open the note anyway, and only those are stored and notified:
 *
 *   1. members of this firm (one query for the whole set), the same rule
 *      messaging applies to its own mentions;
 *   2. of those, members who pass the parent's own READ gate, the one the notes
 *      list itself runs. That is the matter wall for matter notes, the task's
 *      audience for task notes and the client's matter wall for client notes,
 *      each with its owner and admin widening.
 *
 * Step 2 calls the parent's gate per candidate rather than re-deriving each
 * parent's rule as a set query: three hand-copied versions of three gates would
 * drift from the gates the routes actually enforce, which is the leak this
 * exists to close. Candidates are bounded by the 50-mention validation cap and
 * by step 1, and run a few at a time so one note cannot take the shared pool.
 */

import { and, inArray } from 'drizzle-orm';
import { members } from '../database/drizzle/schema';
import { tenantQuery } from '../database/queryContext';
import { ForbiddenError, NotFoundError } from '../errors/AppError';
import { runWithConcurrency } from '../utils/runWithConcurrency';

type ReadGate = (lawFirmId: string, parentId: any, userId: string) => Promise<void>;

/** At most this many read-gate checks in flight for one note. */
const GATE_CONCURRENCY = 3;

/**
 * The mentioned user ids that may read this parent's notes, deduplicated, in
 * the order given. A gate refusal (403 or 404) drops the id; any other error is
 * a real failure and rejects, so a database fault never silently strips or
 * keeps a mention.
 */
export async function readableMentions(
  lawFirmId: string,
  parentId: any,
  mentions: unknown,
  assertReadAccess: ReadGate,
): Promise<string[]> {
  const ids = Array.from(new Set(
    (Array.isArray(mentions) ? mentions : []).filter((id): id is string => typeof id === 'string' && id.length > 0),
  ));
  if (!ids.length) return [];

  const memberRows = await tenantQuery(members, lawFirmId, ({ executor, scope }) => executor
    .select({ userId: members.userId }).from(members)
    .where(and(scope, inArray(members.userId, ids))));
  const firmMembers = new Set(memberRows.map((r: any) => String(r.userId)));
  const candidates = ids.filter((id) => firmMembers.has(id));
  if (!candidates.length) return [];

  const settled = await runWithConcurrency(
    candidates.map((userId) => () => assertReadAccess(lawFirmId, parentId, userId)),
    GATE_CONCURRENCY,
  );
  return candidates.filter((_, i) => {
    const result: any = settled[i];
    if (result.status === 'fulfilled') return true;
    if (result.reason instanceof ForbiddenError || result.reason instanceof NotFoundError) return false;
    throw result.reason;
  });
}
