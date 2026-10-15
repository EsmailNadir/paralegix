const crypto = require('crypto');
const { privilegedParameterizedQuery } = require('../../shared/database/queryContext');
const { trackBackgroundWrite } = require('../../shared/utils/backgroundWrites');

const signatureSql = (text: string, params: unknown[] = []) => privilegedParameterizedQuery(
  'signature audit access is scoped by an unguessable session token', text, params,
);

export const AUDIT_EVENTS = {
  SESSION_CREATED: 'session.created',
  SESSION_VIEWED: 'session.viewed',
  DOCUMENT_VIEWED: 'document.viewed',
  CONSENT_GIVEN: 'consent.given',
  SESSION_COMPLETED: 'session.completed',
  SESSION_EXPIRED: 'session.expired',
  SESSION_CANCELLED: 'session.cancelled',
  PARTICIPANT_DECLINED: 'participant.declined',
  PARTICIPANT_REMOVED: 'participant.removed',
  EMAIL_SENT: 'email.sent',
  REMINDER_SENT: 'reminder.sent',
  ACCESS_CODE_VERIFIED: 'accesscode.verified',
  ACCESS_CODE_FAILED: 'accesscode.failed',
};

/**
 * Append an immutable audit event to a signing session's subcollection.
 * Audit events are never updated or deleted.
 */
/**
 * Several callers deliberately drop this promise, so the write outlives the
 * request. `trackBackgroundWrite` gives the test harness a handle on it without
 * changing what any caller sees: the same promise is returned, so a caller that
 * awaits still awaits. Untracked, these inserts deadlocked against the harness's
 * `truncateAll` and produced failures that moved between spec files.
 */
export function writeAuditEvent(token: any, eventType: any, opts: any = {}) {
  return trackBackgroundWrite(writeAuditEventNow(token, eventType, opts));
}

async function writeAuditEventNow(token: any, eventType: any, { req, actorUid, metadata }: any = {}) {
  const requestMeta = req ? extractRequestMeta(req) : { ip: null, userAgent: null };
  // The token passed in IS the session token. Lift participantId out of metadata
  // (where the routes already stash it) into the dedicated column.
  const participantId = metadata && typeof metadata === 'object' ? (metadata.participantId || null) : null;

  // The session is resolved inside the INSERT, so the row carries the uuid and
  // the firm from the start. The token used to be stored on the row itself and
  // a trigger filled the other two in afterwards.
  const { rows } = await signatureSql(
    `insert into signature_audit_events
       (session_id, law_firm_id, participant_id, event_type, ip, user_agent, actor_uid, metadata)
     select s.id, s.law_firm_id, $2, $3, $4, $5, $6, $7
       from signature_sessions s where s.token = $1
     returning id`,
    [token, participantId, eventType, requestMeta.ip, requestMeta.userAgent, actorUid || null,
     metadata ? JSON.stringify(metadata) : null]
  );

  // A token naming no session inserts nothing, where the foreign key on the old
  // `session_token` column used to reject the statement. This trail is
  // tamper-evident and is rendered onto the signing certificate, so a lost
  // event has to stay as loud as it was.
  //
  // Both halves are needed. The throw is for a caller that awaits, which is how
  // it behaved before the cutover. The log is for the several callers that
  // deliberately drop this promise: `trackBackgroundWrite` attaches its own
  // settle handler, so their rejection is never reported anywhere else.
  if (!rows[0]) {
    const message = `[audit] no signing session for the token given; ${eventType} was not recorded`;
    console.error(message);
    throw new Error(message);
  }
  return rows[0].id;
}

/**
 * Batch-append audit events in a single multi-row INSERT.
 * events: [{ token, eventType, actorUid?, metadata? }]
 * (No per-request `req`. Used by loop/cron paths that emit many events at once.)
 */
export async function writeAuditEvents(events: any[] = []) {
  const list = Array.isArray(events) ? events.filter(Boolean) : [];
  if (list.length === 0) return;

  const COLS_PER_ROW = 7;
  const groups: any[] = [];
  const params: any[] = [];
  list.forEach((e, i) => {
    const base = i * COLS_PER_ROW;
    const metadata = e.metadata && typeof e.metadata === 'object' ? e.metadata : null;
    const participantId = metadata ? (metadata.participantId || null) : null;
    // Every column is cast. A parameter that appears only inside a VALUES list
    // has no column to take its type from, and Postgres rejects the statement
    // rather than guessing.
    groups.push(
      `($${base + 1}::text,$${base + 2}::text,$${base + 3}::text,$${base + 4}::text,`
      + `$${base + 5}::text,$${base + 6}::text,$${base + 7}::jsonb)`
    );
    params.push(
      e.token, participantId, e.eventType, e.ip || null, e.userAgent || null,
      e.actorUid || null, metadata ? JSON.stringify(metadata) : null
    );
  });

  // One multi-row insert, each row resolving its own session. `values` carries
  // the tokens; the join turns each into the uuid and firm the columns want.
  const { rowCount } = await signatureSql(
    `insert into signature_audit_events
       (session_id, law_firm_id, participant_id, event_type, ip, user_agent, actor_uid, metadata)
     select s.id, s.law_firm_id, v.participant_id, v.event_type, v.ip, v.user_agent,
            v.actor_uid, v.metadata
       from (values ${groups.join(',')})
              as v(token, participant_id, event_type, ip, user_agent, actor_uid, metadata)
       join signature_sessions s on s.token = v.token`,
    params
  );

  // The join drops a row whose token names no session. The one caller catches
  // and logs, so the throw is what reaches it; the count is what tells it how
  // much of the trail is missing.
  if (rowCount !== list.length) {
    throw new Error(
      `[audit] ${list.length - (rowCount || 0)} of ${list.length} event(s) named no signing session and were not recorded`,
    );
  }
}

/** Read a session's audit trail (oldest first), shaped like the old subcollection docs. */
export async function listAuditEvents(token: any) {
  const { rows } = await signatureSql(
    `select e.id, e.event_type, e.ip, e.user_agent, e.actor_uid, e.metadata, e.created_at
       from signature_audit_events e
       join signature_sessions s on s.id = e.session_id
      where s.token = $1
      order by e.created_at asc`,
    [token]
  );
  return rows.map((r: any) => ({
    eventId: r.id,
    eventType: r.event_type,
    timestamp: r.created_at ? r.created_at.toISOString() : null,
    ip: r.ip || null,
    userAgent: r.user_agent || null,
    actorUid: r.actor_uid || null,
    metadata: r.metadata || null,
  }));
}

/**
 * Compute SHA-256 hex digest of a buffer.
 */
export function hashDocument(buffer: any) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Extract IP address and user agent from an Express request.
 */
export function extractRequestMeta(req: any) {
  // Use the framework-resolved client IP. Express is configured with
  // `trust proxy`, so `req.ip` already reflects the correct client address from
  // the proxy chain. Reading the raw leftmost x-forwarded-for value instead is
  // spoofable (a client can prepend an arbitrary address), so the recorded and
  // certificate IP must come from req.ip.
  const ip = req.ip || req.socket?.remoteAddress || null;

  const userAgent = req.headers['user-agent'] || null;

  return { ip, userAgent };
}
