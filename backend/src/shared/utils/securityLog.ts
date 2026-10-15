const { logger } = require('./logger');

/**
 * Emit a structured security event to the application log.
 *
 * Every event carries a stable `event` field (e.g. "auth.failed",
 * "authz.denied", "data.export"). That field is the hook Cloud Logging filters
 * and log-based metric alerts key on: a metric counts lines where
 * `jsonPayload.event="<name>"`, and an alert policy fires when that count
 * crosses a threshold. The taxonomy here is the contract with the alerting
 * config in `infra/monitoring/` — keep the two in sync.
 *
 * Level → Cloud Logging severity (mapped by the pino logger config):
 *   warn  → WARNING — suspicious but expected (failed auth, denied access)
 *   info  → INFO    — notable but normal (data export/erasure, admin action)
 *
 * Cardinality note: identifying fields like `ip` and `actorUid` go in the log
 * ENTRY, never as metric labels. A spike of failed auth can produce thousands
 * of distinct IPs; promoting those to metric labels would explode time-series
 * cardinality (and cost). When an alert fires, pivot to Logs Explorer to see
 * which actor/IP — the metric just counts.
 *
 * Best-effort and non-throwing by design: observability must never break the
 * request it is observing.
 *
 * @param {object} req - the Express request (for req.log, req.id, req.user, req.ip)
 * @param {string} event - the stable event name from the taxonomy
 * @param {object} [opts]
 * @param {'warn'|'info'} [opts.level='info'] - log level / severity
 * @param {...*} [opts.fields] - extra structured fields merged onto the entry
 */
export function logSecurityEvent(req: any, event: any, { level = 'info', ...fields } = {}) {
  try {
    // Prefer the per-request child logger (carries the request id) when present;
    // fall back to the shared logger for call sites without a request scope.
    const log = (req && req.log) || logger;
    const emit = typeof log[level] === 'function' ? log[level].bind(log) : log.info.bind(log);
    emit(
      {
        event,
        requestId: req && req.id ? req.id : null,
        actorUid: req && req.user && req.user.uid ? req.user.uid : null,
        ip: req && req.ip ? req.ip : null,
        ...fields,
      },
      event,
    );
  } catch (_err) {
    // Swallow: a logging failure must never surface onto the request lifecycle.
  }
}
