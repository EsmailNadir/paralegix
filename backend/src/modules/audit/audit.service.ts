const auditRepo = require('./audit.repository');

/**
 * Append an audit event. BEST-EFFORT by design: auditing must never break the
 * request it is recording, so the repo write is wrapped in try/catch and a
 * failure is logged, not thrown. Callers (the global middleware) can fire-and-
 * forget. metadata defaults to an empty object.
 */
/**
 * Audit writes that have started but not yet settled.
 *
 * The global middleware fires `recordAudit` from `res.on('finish')` and does not
 * await it, so the insert outlives the request that caused it. In production that
 * is the point: auditing must add no request latency.
 *
 * In tests it is a hazard with no other handle on it. `drainEvents()` settles the
 * event bus, but this write never goes through the bus, so a spec can finish, the
 * next one can `truncate` all the schema, and the straggling insert deadlocks
 * against that ACCESS EXCLUSIVE lock (Postgres 40P01). Postgres kills one side,
 * and the surviving symptom is a bare `socket hang up` on whichever request was
 * in flight, which reads as a bug in that request.
 *
 * `drainAuditWrites()` below is the matching handle, exported for the test
 * harness the same way `drainEvents()` is.
 */
const inFlightAuditWrites = new Set<Promise<unknown>>();

/**
 * Await every audit write that has started but not settled.
 *
 * Test-support only. Loops rather than awaiting once, because settling one write
 * can start another.
 */
export async function drainAuditWrites(): Promise<void> {
  let guard = 0;
  while (inFlightAuditWrites.size && guard < 50) {
    guard += 1;
    await Promise.allSettled([...inFlightAuditWrites]);
  }
}

export async function recordAudit({
  lawFirmId, actorUid, actorEmail, action, resourceType, resourceId,
  method, path, statusCode, ip, userAgent, metadata,
}: any = {}) {
  const write = (async () => {
    await auditRepo.insert({
      lawFirmId: lawFirmId || null,
      actorUid: actorUid || null,
      actorEmail: actorEmail || null,
      action,
      resourceType: resourceType || null,
      resourceId: resourceId || null,
      method: method || null,
      path: path || null,
      statusCode: statusCode == null ? null : statusCode,
      ip: ip || null,
      userAgent: userAgent || null,
      metadata: metadata || {},
    });
  })();

  inFlightAuditWrites.add(write);
  try {
    await write;
  } catch (err) {
    console.error('audit.service recordAudit failed:', err);
  } finally {
    inFlightAuditWrites.delete(write);
  }
}

/**
 * Paginated audit events for a firm. Pass-through to the repository, which
 * scopes by law_firm_id and returns { items, totalItems }.
 */
export async function listAuditEvents({ lawFirmId, limit, offset, action, actorUid }: any = {}) {
  return auditRepo.listByFirm(lawFirmId, { limit, offset, action, actorUid });
}

/**
 * Cross-firm audit events for the platform admin console. Pass-through to the
 * repository's unscoped listAll (admin-gated at the route). Returns
 * { items, totalItems }.
 */
export async function listAllAuditEvents({ limit, offset, action, actorUid, lawFirmId, search }: any = {}) {
  return auditRepo.listAll({ limit, offset, action, actorUid, lawFirmId, search });
}
