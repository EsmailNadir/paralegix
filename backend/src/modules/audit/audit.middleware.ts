const auditService = require('./audit.service');

// Only state-changing requests are worth auditing. Reads are skipped.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// A uuid as it appears in a URL path segment.
const UUID_RE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

// Capture the firm id from a `/lawfirms/<uuid>` segment anywhere in the URL.
const LAWFIRM_ID_RE = new RegExp(`/lawfirms/(${UUID_RE})`);

// Collapse any uuid path segment to ':id' so the derived action stays readable
// and groups together (e.g. POST /api/lawfirms/:id/matters/:id/notes).
const UUID_SEGMENT_RE = new RegExp(UUID_RE, 'g');

/**
 * Strip the query string from a URL, leaving just the path.
 */
function stripQuery(url: any) {
  if (!url) return '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Skip health checks, cron jobs, and webhook deliveries. These are either noise
 * (health) or machine-to-machine traffic that carries no firm actor.
 */
function isExcludedPath(path: any) {
  if (!path) return false;
  if (path === '/api/health') return true;
  if (path.startsWith('/api/webhooks')) return true;
  if (path.startsWith('/api/cron')) return true;
  return false;
}

/**
 * Global middleware that records an audit event for every successful mutating
 * request, AFTER the route handler runs (so req.user is populated by the route-
 * level verifyToken). Mounted once via app.use after express.json() and before
 * the route registrations. Recording is best-effort and never affects the
 * response.
 */
export function auditMutations(req: any, res: any, next: any) {
  // Hand control to the route immediately. The audit write is deferred to the
  // response 'finish' event so it observes the final status code and a populated
  // req.user without delaying the response itself.
  res.on('finish', () => {
    try {
      if (!MUTATING_METHODS.has(req.method)) return;

      const path = stripQuery(req.originalUrl || req.url || '');
      if (isExcludedPath(path)) return;

      const lawFirmMatch = LAWFIRM_ID_RE.exec(req.originalUrl || '');
      const lawFirmId = lawFirmMatch ? lawFirmMatch[1] : null;

      const actorUid = req.user && req.user.uid ? req.user.uid : null;
      const actorEmail = req.user && req.user.email ? req.user.email : null;

      // Without a firm scope OR an actor, the event is noise (anonymous,
      // unscoped traffic). Skip it.
      if (!lawFirmId && !actorUid) return;

      const cleanedPath = path.replace(UUID_SEGMENT_RE, ':id');
      const action = `${req.method} ${cleanedPath}`;

      // Deliberately NOT storing the request body: it can contain PII or
      // secrets. metadata holds only small, safe derived hints.
      auditService.recordAudit({
        lawFirmId,
        actorUid,
        actorEmail,
        action,
        method: req.method,
        path,
        statusCode: res.statusCode,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        metadata: {},
      });
    } catch (err) {
      // Belt and suspenders: recordAudit is already non-throwing, but the
      // finish handler must never surface an error onto the response lifecycle.
      console.error('audit.middleware finish handler failed:', err);
    }
  });

  next();
}
