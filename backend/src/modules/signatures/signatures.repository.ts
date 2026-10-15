/**
 * Native relational repository for the signatures module (Drizzle query layer).
 *
 * The session primary key is the text `token` (the 24-byte hex the routes pass
 * everywhere as sessionId/token). getSessionByToken / getSessionByParticipantToken
 * return the SAME camelCase object graph the routes consumed when sessions were a
 * single jsonb blob: a session object with nested `participants[]`, `fields[]`,
 * `otp`/`accessCodeLock` objects, and the `lastSessionViewedAt` /
 * `lastDocumentViewedAt` actor-key maps.
 */

const {
  privilegedParameterizedQuery,
  rootQueryExecutor,
  withDrizzleTransaction,
} = require('../../shared/database/queryContext');
const { buildPageClause, resolveWindowTotal } = require('../../shared/database/pagination');
const { toIlikeTerm } = require('../../shared/database/searchTerm');
const { isUuid } = require('../../shared/utils/isUuid');
// Shared timestamp coercion (consolidated module-wide helper).
const { toIso, toDbTs } = require('./timeUtils');

const signatureSql = (
  executor: any,
  statement: string | { text: string; values: unknown[] },
  params: unknown[] = [],
) => privilegedParameterizedQuery(
  'signature access is scoped by an unguessable session token or an authorized firm route',
  typeof statement === 'string' ? statement : statement.text,
  typeof statement === 'string' ? params : statement.values,
  executor,
);

// ── row -> object-graph reconstruction ─────────────────────────────────────
function buildOtp({ codeHash, expiresAt, attempts, lockedUntil, lifetimeAttempts }: any) {
  if (!codeHash && !expiresAt && !lockedUntil && !attempts && !lifetimeAttempts) return null;
  return {
    codeHash: codeHash || null,
    expiresAt: toIso(expiresAt),
    attempts: attempts || 0,
    // Non-resettable cumulative counter the hard cap reads. Unlike `attempts`
    // (the 60s soft-lock window, reset on every send-otp), this only clears when
    // the firm reissues the link (otp set to null).
    lifetimeAttempts: lifetimeAttempts || 0,
    lockedUntil: toIso(lockedUntil),
  };
}

function buildAccessCodeLock({ attempts, lockedUntil, lifetimeAttempts }: any) {
  if (!attempts && !lockedUntil && !lifetimeAttempts) return null;
  return {
    attempts: attempts || 0,
    // Non-resettable cumulative counter the hard cap reads (see buildOtp).
    lifetimeAttempts: lifetimeAttempts || 0,
    lockedUntil: toIso(lockedUntil),
  };
}

function mapParticipantRow(row: any, publicTokenByParticipant: any = {}) {
  return {
    participantId: row.id,
    roleLabel: row.role_label || null,
    order: row.signing_order,
    deliveryMethod: row.delivery_method || null,
    name: row.name || null,
    email: row.email || null,
    memberUserId: row.member_user_id || null,
    clientUserId: row.client_user_id || null,
    status: row.status,
    requiresVerification: !!row.requires_verification,
    emailVerified: !!row.email_verified,
    otp: buildOtp({
      codeHash: row.otp_code_hash,
      expiresAt: row.otp_expires_at,
      attempts: row.otp_attempts,
      lifetimeAttempts: row.otp_lifetime_attempts,
      lockedUntil: row.otp_locked_until,
    }),
    accessCodeHash: row.access_code_hash || null,
    accessCodeVerified: !!row.access_code_verified,
    accessCodeLock: buildAccessCodeLock({
      attempts: row.access_code_attempts,
      lifetimeAttempts: row.access_code_lifetime_attempts,
      lockedUntil: row.access_code_locked_until,
    }),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    consent: row.consent || null,
    signerUid: row.signer_uid || null,
    signerName: row.signer_name || null,
    signerIp: row.signer_ip || null,
    facilitatedBy: row.facilitated_by || null,
    fieldValues: row.field_values || null,
    workingObjectPath: row.working_object_path || null,
    lastReminderSentAt: toIso(row.last_reminder_sent_at),
    reminderCount: row.reminder_count || 0,
    publicToken: publicTokenByParticipant[row.id] || null,
  };
}

function mapFieldRow(row: any) {
  const extra = (row.config && typeof row.config === 'object') ? row.config : {};
  return {
    ...extra,
    id: row.id,
    signerId: row.signer_id || undefined,
    page: row.page === null || row.page === undefined ? undefined : row.page,
    xPercent: row.x_percent === null ? undefined : Number(row.x_percent),
    yPercent: row.y_percent === null ? undefined : Number(row.y_percent),
    widthPercent: row.width_percent === null ? undefined : Number(row.width_percent),
    heightPercent: row.height_percent === null ? undefined : Number(row.height_percent),
    fieldType: row.field_type || undefined,
    label: row.label === null ? undefined : row.label,
    required: row.required === null ? undefined : !!row.required,
    style: row.style || undefined,
  };
}

function mapSessionRow(row: any) {
  return {
    token: row.token,
    id: row.token,
    // The row's uuid, which `id` above deliberately is not: `id` has meant the
    // token everywhere in this module since before the tables were normalized.
    // The children and the job rows key on the uuid, so it is carried too.
    sessionUuid: row.id,
    routingMode: row.routing_mode || 'sequential',
    status: row.status || 'pending',
    fileName: row.file_name || null,
    lawFirmId: row.law_firm_id || null,
    createdBy: row.created_by || null,
    // The admitted source this session was built from, when it has one. The
    // finalize path reads it to reach the PREPARED object and its saved hash
    // state, which is the difference between sealing without reading the
    // document and streaming it again.
    sourceId: row.source_id || null,
    objectPath: row.object_path || null,
    workingObjectPath: row.working_object_path || null,
    finalObjectPath: row.final_object_path || null,
    signedObjectPath: row.signed_object_path || null,
    destinationFolderId: row.destination_folder_id || null,
    destinationLabel: row.destination_label || null,
    currentSignerOrder: row.current_signer_order === null ? null : row.current_signer_order,
    documentHash: row.document_hash || null,
    signedDocumentHash: row.signed_document_hash || null,
    deliveryDocumentHash: row.delivery_document_hash || null,
    notifyEmail: row.notify_email || null,
    notifyName: row.notify_name || null,
    emailSignersOnComplete: !!row.email_signers_on_complete,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    completedAt: toIso(row.completed_at),
    startedAt: toIso(row.started_at),
  };
}

/**
 * The session's uuid, from the token a route was given.
 *
 * The token is the session's PUBLIC identifier: it is what a URL carries and
 * what every route hands the repository. The children key on the uuid, so the
 * two are bridged here, once per call, rather than by storing the token on
 * every child row. That copy is what migration 0235 set out to remove.
 */
/**
 * The same bridge as `resolveSessionId`, inlined into a statement that has a
 * token in hand and one place to use it. It saves the extra round trip, and it
 * keeps the lookup inside the statement's own snapshot.
 *
 * Pass the placeholder carrying the token, e.g. `SESSION_BY_TOKEN('$2')`.
 */
const SESSION_BY_TOKEN = (tokenParam: string) =>
  `(select id from signature_sessions where token = ${tokenParam})`;

async function resolveSessionId(executor: any, token: any) {
  if (!token) return null;
  const { rows } = await signatureSql(executor,
    `select id from signature_sessions where token = $1`, [token]);
  return rows[0]?.id || null;
}

// ── assemble the full session graph from its child tables ──────────────────
async function loadSessionGraph(executor: any, sessionRow: any) {
  const sessionId = sessionRow.id;

  const participantsSql = {
    text: `${PARTICIPANTS_WITH_CHALLENGES} where p.session_id = $1 ${PARTICIPANT_ORDER}`,
    values: [sessionId],
  };
  // Only ACTIVE (un-consumed) tokens populate the publicToken map. A consumed
  // single-use link must not resurface as a usable token on the firm view or on
  // the participant-by-publicToken resolve path.
  const tokensSql = {
    text: `select token, participant_id from signature_participant_tokens where session_id = $1 and consumed_at is null`,
    values: [sessionId],
  };
  const fieldsSql = {
    text: `select * from signature_fields where session_id = $1 order by sort_order asc nulls last`,
    values: [sessionId],
  };
  const viewsSql = {
    text: `select metadata->>'actorKey' as actor_key,
                  max(case when event_type = 'session.viewed' then created_at end) as last_session_viewed_at,
                  max(case when event_type = 'document.viewed' then created_at end) as last_document_viewed_at
             from signature_audit_events
            where session_id = $1
              and event_type in ('session.viewed', 'document.viewed')
              and metadata->>'actorKey' is not null
            group by metadata->>'actorKey'`,
    values: [sessionId],
  };

  // S2: outside a transaction the executor is the rootQueryExecutor. The 4 child queries
  // can run on separate pooled connections in parallel (4 round-trips -> 1).
  // Inside a transaction the executor is a single client and pg forbids
  // concurrent queries on one client, so run them sequentially there.
  let participantsRes; let tokensRes; let fieldsRes; let viewsRes;
  if (executor === rootQueryExecutor) {
    [participantsRes, tokensRes, fieldsRes, viewsRes] = await Promise.all([
      signatureSql(executor, participantsSql),
      signatureSql(executor, tokensSql),
      signatureSql(executor, fieldsSql),
      signatureSql(executor, viewsSql),
    ]);
  } else {
    participantsRes = await signatureSql(executor, participantsSql);
    tokensRes = await signatureSql(executor, tokensSql);
    fieldsRes = await signatureSql(executor, fieldsSql);
    viewsRes = await signatureSql(executor, viewsSql);
  }

  const publicTokenByParticipant: Record<string, any> = {};
  for (const t of tokensRes.rows) {
    if (t.participant_id) publicTokenByParticipant[t.participant_id] = t.token;
  }

  const session: any = mapSessionRow(sessionRow);
  session.participants = participantsRes.rows.map((r: any) => mapParticipantRow(r, publicTokenByParticipant));
  session.fields = fieldsRes.rows.length ? fieldsRes.rows.map(mapFieldRow) : null;

  const lastSessionViewedAt: Record<string, any> = {};
  const lastDocumentViewedAt: Record<string, any> = {};
  for (const v of viewsRes.rows) {
    if (v.last_session_viewed_at) lastSessionViewedAt[v.actor_key] = toIso(v.last_session_viewed_at);
    if (v.last_document_viewed_at) lastDocumentViewedAt[v.actor_key] = toIso(v.last_document_viewed_at);
  }
  session.lastSessionViewedAt = lastSessionViewedAt;
  session.lastDocumentViewedAt = lastDocumentViewedAt;

  return session;
}

/**
 * X2: Slim graph for list/verify paths that need session + participants (with
 * public tokens) but NOT fields or view stamps. Loads 2 child tables instead of
 * 4. `fields` is null and the view maps are empty (those callers never read them).
 */
async function loadSessionGraphSlim(sessionRow: any) {
  const sessionId = sessionRow.id;
  const [participantsRes, tokensRes] = await Promise.all([
    signatureSql(rootQueryExecutor,
      `${PARTICIPANTS_WITH_CHALLENGES} where p.session_id = $1 ${PARTICIPANT_ORDER}`,
      [sessionId]
    ),
    signatureSql(rootQueryExecutor,
      `select token, participant_id from signature_participant_tokens where session_id = $1 and consumed_at is null`,
      [sessionId]
    ),
  ]);

  const publicTokenByParticipant: Record<string, any> = {};
  for (const t of tokensRes.rows) {
    if (t.participant_id) publicTokenByParticipant[t.participant_id] = t.token;
  }

  const session: any = mapSessionRow(sessionRow);
  session.participants = participantsRes.rows.map((r: any) => mapParticipantRow(r, publicTokenByParticipant));
  session.fields = null;
  session.lastSessionViewedAt = {};
  session.lastDocumentViewedAt = {};
  return session;
}

/**
 * S5/S6: Build slim session graphs (session + participants with public tokens,
 * no fields/views) for a SET of session rows using ONE batched participants
 * query and ONE batched tokens query (`= any($1)` over the session tokens),
 * instead of 2 child queries per session. Mirrors findPendingDocumentsForClient's
 * set-based approach for the firm/finder list paths.
 */
async function loadSessionGraphsSlimForRows(sessionRows: any) {
  if (!Array.isArray(sessionRows) || sessionRows.length === 0) return [];
  const sessionIds = sessionRows.map((r) => r.id);

  const [participantsRes, tokensRes] = await Promise.all([
    signatureSql(rootQueryExecutor,
      `${PARTICIPANTS_WITH_CHALLENGES}
         where p.session_id = any($1::uuid[])
         ${PARTICIPANT_ORDER}`,
      [sessionIds]
    ),
    signatureSql(rootQueryExecutor,
      `select token, participant_id, session_id
         from signature_participant_tokens where session_id = any($1::uuid[]) and consumed_at is null`,
      [sessionIds]
    ),
  ]);

  // publicToken keyed by (session_id, participant_id). Participant ids are
  // unique across sessions, but key defensively by session to avoid collisions.
  const publicTokenByParticipant: Record<string, any> = {};
  for (const t of tokensRes.rows) {
    if (t.participant_id) publicTokenByParticipant[t.participant_id] = t.token;
  }

  const participantsBySession = new Map();
  for (const row of participantsRes.rows) {
    const list = participantsBySession.get(row.session_id) || [];
    list.push(mapParticipantRow(row, publicTokenByParticipant));
    participantsBySession.set(row.session_id, list);
  }

  return sessionRows.map((sessionRow) => {
    const session: any = mapSessionRow(sessionRow);
    session.participants = participantsBySession.get(sessionRow.id) || [];
    session.fields = null;
    session.lastSessionViewedAt = {};
    session.lastDocumentViewedAt = {};
    return session;
  });
}

// ── reads ──────────────────────────────────────────────────────────────────
export async function getSessionByToken(token: any, executor = rootQueryExecutor) {
  const { rows } = await signatureSql(executor, `select * from signature_sessions where token = $1`, [token]);
  if (!rows[0]) return null;
  return loadSessionGraph(executor, rows[0]);
}

export async function getSessionByParticipantToken(publicToken: any, executor = rootQueryExecutor) {
  // X3: resolve the session row in ONE query via the token JOIN, then load the
  // graph once (was: token lookup query + a second session lookup query).
  // Only ACTIVE (un-consumed) tokens resolve. A spent single-use link must not
  // re-authorize signing.
  const { rows } = await signatureSql(executor,
    `select s.* from signature_participant_tokens pt
       join signature_sessions s on s.id = pt.session_id
      where pt.token = $1 and pt.consumed_at is null
      limit 1`,
    [publicToken]
  );
  if (!rows[0]) return null;
  return loadSessionGraph(executor, rows[0]);
}

/** Resolve a spent participant token for read-only access to its completed artifact. */
export async function getCompletedSessionByParticipantToken(publicToken: any, executor = rootQueryExecutor) {
  const { rows } = await signatureSql(executor,
    `select s.*, pt.participant_id as token_participant_id
       from signature_participant_tokens pt
       join signature_sessions s on s.id = pt.session_id
       join signature_participants p on p.id = pt.participant_id and p.session_id = s.id
      where pt.token = $1 and pt.consumed_at is not null
        and p.status = 'completed' and s.status = 'completed'
      limit 1`,
    [publicToken]
  );
  if (!rows[0]) return null;
  const graph = await loadSessionGraph(executor, rows[0]);
  return {
    sessionData: graph,
    participant: (graph.participants || []).find(
      (entry: any) => entry.participantId === rows[0].token_participant_id,
    ) || null,
  };
}

// ── field-row mapping (object graph -> columns) ────────────────────────────
const KNOWN_FIELD_KEYS = new Set([
  'id', 'signerId', 'page', 'xPercent', 'yPercent', 'widthPercent',
  'heightPercent', 'fieldType', 'label', 'required', 'style',
]);

function fieldToColumns(field: any, index: any) {
  const config: Record<string, any> = {};
  for (const key of Object.keys(field || {})) {
    if (!KNOWN_FIELD_KEYS.has(key)) config[key] = field[key];
  }
  return {
    id: field.id,
    signerId: field.signerId ?? null,
    page: field.page ?? null,
    xPercent: field.xPercent ?? null,
    yPercent: field.yPercent ?? null,
    widthPercent: field.widthPercent ?? null,
    heightPercent: field.heightPercent ?? null,
    fieldType: field.fieldType ?? null,
    label: field.label ?? null,
    required: field.required ?? null,
    style: field.style ?? null,
    sortOrder: index,
    config: Object.keys(config).length ? config : null,
  };
}

async function insertFields(executor: any, sessionId: any, lawFirmId: any, fields: any) {
  if (!Array.isArray(fields) || fields.length === 0) return;

  // Single multi-row INSERT. One round-trip regardless of field count.
  const COLS_PER_ROW = 15;
  const valueGroups = [];
  const params: unknown[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const c = fieldToColumns(fields[i], i);
    const base = i * COLS_PER_ROW;
    valueGroups.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},` +
      `$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},` +
      `$${base + 14},$${base + 15})`
    );
    params.push(
      c.id, sessionId, lawFirmId, c.signerId, c.page, c.xPercent, c.yPercent, c.widthPercent,
      c.heightPercent, c.fieldType, c.label, c.required, c.style, c.sortOrder,
      c.config ? JSON.stringify(c.config) : null
    );
  }

  await signatureSql(executor,
    `insert into signature_fields
      (id, session_id, law_firm_id, signer_id, page, x_percent, y_percent, width_percent,
       height_percent, field_type, label, required, style, sort_order, config)
     values ${valueGroups.join(',')}`,
    params
  );
}

// ── verification gates: signature_challenges ───────────────────────────────
/**
 * A participant's two verification gates (the emailed one-time code and the
 * firm-set access code) live in `signature_challenges`, one row per gate, rather
 * than as ten columns on the participant. Migration 0243 moved them.
 *
 * The object graph is unchanged: every read joins the two rows back under the
 * names `mapParticipantRow` already expects, and every write upserts them. So
 * the routes, the services and their tests see exactly what they saw before.
 *
 * `access_code_verified` becomes the access-code row's `verified_at`. The OTP
 * gate has no equivalent here: passing it verifies the PERSON's email, which is
 * a fact about the participant that outlives any one code, so it stays as
 * `signature_participants.email_verified`.
 */
const CHALLENGE_COLUMNS = `
       otp_challenge.secret_hash                as otp_code_hash,
       otp_challenge.expires_at                 as otp_expires_at,
       otp_challenge.attempts                   as otp_attempts,
       otp_challenge.lifetime_attempts          as otp_lifetime_attempts,
       otp_challenge.locked_until               as otp_locked_until,
       access_challenge.secret_hash             as access_code_hash,
       (access_challenge.verified_at is not null) as access_code_verified,
       access_challenge.attempts                as access_code_attempts,
       access_challenge.lifetime_attempts       as access_code_lifetime_attempts,
       access_challenge.locked_until            as access_code_locked_until`;

const CHALLENGE_JOINS = `
  left join signature_challenges otp_challenge
         on otp_challenge.participant_id = p.id and otp_challenge.kind = 'otp'
  left join signature_challenges access_challenge
         on access_challenge.participant_id = p.id and access_challenge.kind = 'access_code'`;

/**
 * Reminder state is a `reminders` row under the participant arm (migration
 * 0245), shared with invoices, tasks and events, rather than two columns here.
 * Read back under the old names for the same reason the gates are: the object
 * graph does not change.
 */
const REMINDER_COLUMNS = `
       participant_reminder.last_sent_at        as last_reminder_sent_at,
       coalesce(participant_reminder.sent_count, 0) as reminder_count`;

const REMINDER_JOIN = `
  left join reminders participant_reminder
         on participant_reminder.signature_participant_id = p.id`;

/** Every column of the participant row plus its gates and reminder, in one row. */
const PARTICIPANTS_WITH_CHALLENGES = `select p.*,${CHALLENGE_COLUMNS},${REMINDER_COLUMNS}
    from signature_participants p${CHALLENGE_JOINS}${REMINDER_JOIN}`;

const PARTICIPANT_ORDER = 'order by p.signing_order asc nulls last, p.created_at asc';

/**
 * Write one gate, column by column. Only the columns the caller names are
 * touched, so a patch that says nothing about the code cannot erase it: the
 * verify route sends `accessCodeVerified` and a counter reset together, and the
 * send-otp route sends a new code without the lifetime counter.
 *
 * `null` for the whole gate deletes the row, which is what clearing it means and
 * what keeps `buildOtp` returning null for a participant who has none.
 */
async function writeChallenge(
  executor: any,
  sessionId: any,
  participantId: string,
  kind: 'otp' | 'access_code',
  state: any,
) {
  if (state === undefined) return;
  if (state === null) {
    await signatureSql(executor,
      `delete from signature_challenges c
        using signature_participants p
        where c.participant_id = p.id and c.kind = $3
          and p.id = $1 and p.session_id = $2`,
      [participantId, sessionId, kind],
    );
    return;
  }

  const columns: Array<[string, unknown]> = [];
  if ('secretHash' in state) columns.push(['secret_hash', state.secretHash ?? null]);
  if ('expiresAt' in state) columns.push(['expires_at', toDbTs(state.expiresAt)]);
  if ('attempts' in state) columns.push(['attempts', state.attempts ?? 0]);
  // Written only when supplied: the non-resettable counter the hard cap reads
  // must survive a patch that does not mention it.
  if (state.lifetimeAttempts !== undefined) columns.push(['lifetime_attempts', state.lifetimeAttempts]);
  if ('lockedUntil' in state) columns.push(['locked_until', toDbTs(state.lockedUntil)]);
  if ('verifiedAt' in state) columns.push(['verified_at', toDbTs(state.verifiedAt)]);
  if (!columns.length) return;

  // $1 participant, $2 session, $3 kind, then one parameter per column.
  const params: unknown[] = [participantId, sessionId, kind, ...columns.map(([, value]) => value)];
  const names = columns.map(([name]) => name);
  const placeholders = names.map((_, index) => `$${index + 4}`);
  const updates = names.map((name, index) => `${name} = $${index + 4}`);

  // The session token is in the WHERE beside the participant id, so an update
  // aimed at the wrong session writes nothing rather than reaching into another
  // session's row. `updateParticipant` has always been scoped that way.
  await signatureSql(executor,
    `insert into signature_challenges
       (law_firm_id, session_id, participant_id, kind${names.length ? `, ${names.join(', ')}` : ''})
     select p.law_firm_id, p.session_id, p.id, $3${placeholders.length ? `, ${placeholders.join(', ')}` : ''}
       from signature_participants p
      where p.id = $1 and p.session_id = $2
     on conflict (participant_id, kind) do update set ${updates.join(', ')}`,
    params,
  );
}

/** The two gates as whole-object `writeChallenge` states. */
function challengeStatesFor(p: any) {
  return {
    otp: p.otp
      ? {
        secretHash: p.otp.codeHash ?? null,
        expiresAt: p.otp.expiresAt,
        attempts: p.otp.attempts ?? 0,
        lifetimeAttempts: p.otp.lifetimeAttempts ?? 0,
        lockedUntil: p.otp.lockedUntil,
      }
      : null,
    access_code: (p.accessCodeHash || p.accessCodeVerified || p.accessCodeLock)
      ? {
        secretHash: p.accessCodeHash ?? null,
        attempts: p.accessCodeLock?.attempts ?? 0,
        lifetimeAttempts: p.accessCodeLock?.lifetimeAttempts ?? 0,
        lockedUntil: p.accessCodeLock?.lockedUntil ?? null,
        verifiedAt: p.accessCodeVerified ? new Date().toISOString() : null,
      }
      : null,
  };
}

/**
 * Write a participant's reminder state. Absent state leaves the row alone; the
 * row itself is only created when there is something to record.
 */
async function writeParticipantReminder(executor: any, sessionId: any, participantId: string, p: any) {
  const hasLastSent = p.lastReminderSentAt !== undefined;
  const hasCount = p.reminderCount !== undefined;
  if (!hasLastSent && !hasCount) return;
  if (!p.lastReminderSentAt && !p.reminderCount) {
    await signatureSql(executor,
      `delete from reminders r
        using signature_participants p
        where r.signature_participant_id = p.id
          and p.id = $1 and p.session_id = $2`,
      [participantId, sessionId],
    );
    return;
  }
  await signatureSql(executor,
    `insert into reminders (law_firm_id, signature_participant_id, last_sent_at, sent_count)
     select p.law_firm_id, p.id, $3, $4
       from signature_participants p
      where p.id = $1 and p.session_id = $2
     on conflict (law_firm_id, signature_participant_id) where signature_participant_id is not null
     do update set last_sent_at = excluded.last_sent_at, sent_count = excluded.sent_count`,
    [participantId, sessionId, toDbTs(p.lastReminderSentAt), p.reminderCount ?? 0],
  );
}

async function writeParticipantChallenges(executor: any, sessionId: any, p: any) {
  const states: any = challengeStatesFor(p);
  await writeChallenge(executor, sessionId, p.participantId, 'otp', states.otp);
  await writeChallenge(executor, sessionId, p.participantId, 'access_code', states.access_code);
  await writeParticipantReminder(executor, sessionId, p.participantId, p);
}

// ── participant column mapping (object graph -> columns) ───────────────────
async function insertParticipant(executor: any, sessionId: any, lawFirmId: any, p: any) {
  await signatureSql(executor,
    `insert into signature_participants
      (id, session_id, law_firm_id, role_label, signing_order, delivery_method, name, email,
       member_user_id, client_user_id, status, requires_verification, email_verified,
       started_at, completed_at, consent, signer_uid, signer_name, signer_ip,
       facilitated_by, field_values, working_object_path)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      p.participantId, sessionId, lawFirmId, p.roleLabel ?? null, p.order ?? null, p.deliveryMethod ?? null,
      p.name ?? null, p.email ?? null, p.memberUserId ?? null, p.clientUserId ?? null,
      p.status ?? 'waiting', !!p.requiresVerification, !!p.emailVerified,
      toDbTs(p.startedAt), toDbTs(p.completedAt), p.consent ? JSON.stringify(p.consent) : null,
      p.signerUid ?? null, p.signerName ?? null, p.signerIp ?? null, p.facilitatedBy ?? null,
      p.fieldValues ? JSON.stringify(p.fieldValues) : null, p.workingObjectPath ?? null,
    ]
  );
  await writeParticipantChallenges(executor, sessionId, p);
}

// ── create (one transaction) ───────────────────────────────────────────────
/**
 * @param sessionRecord  the camelCase session record (no participants/fields)
 * @param participantsWithTokens  participants[] each carrying a `publicToken`
 * @param fields  normalized field array (or null)
 */
export async function createSession({ token, sessionRecord, participantsWithTokens, fields }: any) {
  // A session names the source it was built from. The column is NOT NULL, so
  // the database refuses one without it anyway; this says which caller forgot
  // rather than reporting a constraint on a column the caller never mentions.
  if (!sessionRecord?.sourceId) {
    throw new Error('A signing session must name the admitted source it was built from.');
  }
  await withDrizzleTransaction(async (client: any) => {
    const s = sessionRecord;
    // The children key on the session's uuid, which only the insert can give,
    // so it is captured here rather than left to a backfill trigger to look up
    // once per child row.
    const { rows: sessionRows } = await signatureSql(client,
      `insert into signature_sessions
        (token, law_firm_id, created_by, routing_mode, source_id, object_path,
         working_object_path, final_object_path, signed_object_path, file_name,
         destination_folder_id, destination_label, status, current_signer_order,
         document_hash, signed_document_hash, notify_email, notify_name,
         email_signers_on_complete, started_at, completed_at, expires_at,
         created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21,$22,$23)
       returning id`,
      [
        token, s.lawFirmId ?? null, s.createdBy ?? null,
        s.routingMode ?? 'sequential', s.sourceId, s.objectPath ?? null, s.workingObjectPath ?? null,
        s.finalObjectPath ?? null, s.signedObjectPath ?? null, s.fileName ?? null,
        s.destinationFolderId ?? null, s.destinationLabel ?? null,
        s.status ?? 'pending', s.currentSignerOrder ?? null, s.documentHash ?? null,
        s.signedDocumentHash ?? null, s.notifyEmail ?? null, s.notifyName ?? null,
        !!s.emailSignersOnComplete,
        toDbTs(s.startedAt), toDbTs(s.completedAt),
        toDbTs(s.expiresAt), toDbTs(s.createdAt) || new Date(),
      ]
    );

    const sessionId = sessionRows[0].id;

    for (const p of participantsWithTokens || []) {
      // eslint-disable-next-line no-await-in-loop
      await insertParticipant(client, sessionId, s.lawFirmId ?? null, p);
      // eslint-disable-next-line no-await-in-loop
      await signatureSql(client,
        `insert into signature_participant_tokens
          (token, session_id, participant_id, law_firm_id, delivery_method)
         values ($1,$2,$3,$4,$5)`,
        [p.publicToken, sessionId, p.participantId, s.lawFirmId ?? null, p.deliveryMethod ?? null]
      );
    }

    await insertFields(client, sessionId, s.lawFirmId ?? null, fields);
  });
}

// ── session patch mapping (camelCase patch -> SQL columns) ─────────────────
// Supports the dotted paths the routes use (lastSessionViewedAt.{key},
// lastDocumentViewedAt.{key}).
const SESSION_COLUMN_MAP: any = {
  status: 'status',
  sourceId: 'source_id',
  routingMode: 'routing_mode',
  objectPath: 'object_path',
  workingObjectPath: 'working_object_path',
  finalObjectPath: 'final_object_path',
  signedObjectPath: 'signed_object_path',
  fileName: 'file_name',
  destinationFolderId: 'destination_folder_id',
  destinationLabel: 'destination_label',
  currentSignerOrder: 'current_signer_order',
  documentHash: 'document_hash',
  signedDocumentHash: 'signed_document_hash',
  deliveryDocumentHash: 'delivery_document_hash',
  notifyEmail: 'notify_email',
  notifyName: 'notify_name',
  emailSignersOnComplete: 'email_signers_on_complete',
  startedAt: 'started_at',
  completedAt: 'completed_at',
  expiresAt: 'expires_at',
};

const TS_COLUMNS = new Set(['started_at', 'completed_at', 'expires_at']);

function buildSessionAssignments(patch: any) {
  const sets = [];
  const params: unknown[] = [];
  const viewStamps = []; // { actorKey, which, iso }

  for (const [key, value] of Object.entries(patch) as Array<[string, any]>) {
    if (key === 'participants') continue; // handled by replaceParticipants

    if (key.includes('.')) {
      const [head, ...rest] = key.split('.');
      const sub = rest.join('.');
      if (head === 'lastSessionViewedAt') { viewStamps.push({ actorKey: sub, which: 'session', iso: value }); continue; }
      if (head === 'lastDocumentViewedAt') { viewStamps.push({ actorKey: sub, which: 'document', iso: value }); continue; }
      continue; // unknown dotted path: ignore
    }

    const col = SESSION_COLUMN_MAP[key];
    if (!col) continue;
    if (value === undefined) {
      // undefined means "clear the column" (set it to SQL null).
      sets.push(`${col} = null`);
    } else if (TS_COLUMNS.has(col)) {
      params.push(toDbTs(value)); sets.push(`${col} = $${params.length}`);
    } else {
      params.push(value); sets.push(`${col} = $${params.length}`);
    }
  }

  return { sets, params, viewStamps };
}

async function applyViewStamps(executor: any, token: any, viewStamps: any) {
  for (const stamp of viewStamps) {
    const eventType = stamp.which === 'session' ? 'session.viewed' : 'document.viewed';
    // eslint-disable-next-line no-await-in-loop
    await signatureSql(executor,
      `insert into signature_audit_events (session_id, law_firm_id, event_type, created_at, metadata)
       select $1, s.id, s.law_firm_id, $2, $3, jsonb_build_object('actorKey', $4::text)
         from signature_sessions s where s.token = $1`,
      [token, eventType, toDbTs(stamp.iso), stamp.actorKey]
    );
  }
}

export async function updateSession(token: any, patch: any, executor = rootQueryExecutor) {
  if (!patch || Object.keys(patch).length === 0) return;
  const { sets, params, viewStamps } = buildSessionAssignments(patch);

  if (Object.prototype.hasOwnProperty.call(patch, 'participants')) {
    await replaceParticipants(token, patch.participants, executor);
  }

  if (sets.length) {
    sets.push('updated_at = now()');
    params.push(token);
    await signatureSql(executor,
      `update signature_sessions set ${sets.join(', ')} where token = $${params.length}`,
      params
    );
  }

  if (viewStamps.length) await applyViewStamps(executor, token, viewStamps);
}

// ── participant updates ────────────────────────────────────────────────────
const PARTICIPANT_COLUMN_MAP: any = {
  roleLabel: 'role_label',
  order: 'signing_order',
  deliveryMethod: 'delivery_method',
  name: 'name',
  email: 'email',
  memberUserId: 'member_user_id',
  clientUserId: 'client_user_id',
  status: 'status',
  requiresVerification: 'requires_verification',
  emailVerified: 'email_verified',
  signerUid: 'signer_uid',
  signerName: 'signer_name',
  signerIp: 'signer_ip',
  facilitatedBy: 'facilitated_by',
  workingObjectPath: 'working_object_path',
};
const PARTICIPANT_TS: any = {
  startedAt: 'started_at',
  completedAt: 'completed_at',
};
const PARTICIPANT_JSON: any = {
  consent: 'consent',
  fieldValues: 'field_values',
};

/**
 * Split a participant patch into the participant row's own assignments and the
 * two gate rows. The four gate keys (`otp`, `accessCodeHash`,
 * `accessCodeVerified`, `accessCodeLock`) can each arrive on their own, so the
 * access-code state is only assembled when at least one of its three keys is
 * present; a patch that does not mention the gate must leave it alone.
 */
function buildParticipantAssignments(patch: any) {
  const sets = [];
  const params: unknown[] = [];
  const gates: any = { otp: undefined, access_code: undefined };
  const accessKeys = ['accessCodeHash', 'accessCodeVerified', 'accessCodeLock'];
  const touchesAccessGate = accessKeys.some((k) => k in patch);

  if (touchesAccessGate) {
    const state: any = {};
    if ('accessCodeHash' in patch) state.secretHash = patch.accessCodeHash ?? null;
    if ('accessCodeVerified' in patch) {
      state.verifiedAt = patch.accessCodeVerified ? new Date().toISOString() : null;
    }
    if ('accessCodeLock' in patch) {
      if (patch.accessCodeLock === null) {
        // Both counters, the non-resettable one included. A caller who produced
        // the right code has passed the control the counters exist to enforce,
        // and this is the only way the hard cap unlocks.
        state.attempts = 0;
        state.lifetimeAttempts = 0;
        state.lockedUntil = null;
      } else {
        state.attempts = patch.accessCodeLock.attempts ?? 0;
        state.lifetimeAttempts = patch.accessCodeLock.lifetimeAttempts;
        state.lockedUntil = patch.accessCodeLock.lockedUntil ?? null;
      }
    }
    gates.access_code = state;
  }

  for (const [key, value] of Object.entries(patch) as Array<[string, any]>) {
    if (key === 'participantId' || key === 'publicToken') continue;
    if (accessKeys.includes(key)) continue;
    // Reminder state is its own row; `updateParticipant` writes it separately.
    if (key === 'lastReminderSentAt' || key === 'reminderCount') continue;
    if (key === 'otp') {
      // Reissue clears the lifetime counter too. The only way the hard cap unlocks.
      gates.otp = value === null ? null : {
        secretHash: value.codeHash ?? null,
        expiresAt: value.expiresAt,
        attempts: value.attempts ?? 0,
        // Only persisted when the caller supplies it, so a send-otp patch (which
        // omits it) cannot clobber the non-resettable counter to 0.
        lifetimeAttempts: value.lifetimeAttempts,
        lockedUntil: value.lockedUntil,
      };
      continue;
    }
    if (PARTICIPANT_TS[key]) {
      params.push(toDbTs(value)); sets.push(`${PARTICIPANT_TS[key]} = $${params.length}`);
      continue;
    }
    if (PARTICIPANT_JSON[key]) {
      params.push(value === null || value === undefined ? null : JSON.stringify(value));
      sets.push(`${PARTICIPANT_JSON[key]} = $${params.length}`);
      continue;
    }
    const col = PARTICIPANT_COLUMN_MAP[key];
    if (!col) continue;
    params.push(value === undefined ? null : value);
    sets.push(`${col} = $${params.length}`);
  }
  return { sets, params, gates };
}

export async function updateParticipant(token: any, participantId: string, patch: any, executor = rootQueryExecutor) {
  // Resolved once. The routes hold the session's public token, the children key
  // on its uuid, and the four statements below all want the same scope check.
  const sessionId = await resolveSessionId(executor, token);
  const { sets, params, gates } = buildParticipantAssignments(patch || {});
  if (sets.length) {
    params.push(participantId, sessionId);
    await signatureSql(executor,
      `update signature_participants set ${sets.join(', ')}
         where id = $${params.length - 1} and session_id = $${params.length}`,
      params
    );
  }
  await writeChallenge(executor, sessionId, participantId, 'otp', gates.otp);
  await writeChallenge(executor, sessionId, participantId, 'access_code', gates.access_code);
  await writeParticipantReminder(executor, sessionId, participantId, patch || {});
}

/**
 * Atomically record a failed verification-gate attempt and return the
 * post-increment counters plus the freshly-computed lock.
 *
 * The increment runs as a single `col = col + 1` UPDATE so concurrent failed
 * attempts can't read the same counter and both write the same `+1` value (the
 * read-modify-write race), which would let the hard cap be overshot. Postgres
 * evaluates all SET right-hand sides against the pre-update row, so the lock
 * CASE sees the new counter value via `col + 1`; RETURNING yields the new value.
 * Only the three counter columns are touched. The code hash / expiry are left
 * intact.
 *
 * @param {'accessCode'|'otp'} gate
 * @param {{ token: string, participantId: string }} target
 * @param {{ softLimit:number, softLockMs:number, hardCap:number, hardLockMs:number }} policy
 * @returns {Promise<{attempts:number, lifetimeAttempts:number, lockedUntil:string|null, softLocked:boolean, hardCapped:boolean}|null>}
 */
export async function recordGateFailure(gate: any, { token, participantId }: any, policy: any, executor = rootQueryExecutor) {
  const sessionId = await resolveSessionId(executor, token);
  const kind = gate === 'otp' ? 'otp' : 'access_code';
  const { softLimit, softLockMs, hardCap, hardLockMs } = policy;

  const idParams = [participantId, sessionId, kind];
  const n = idParams.length; // $n+1 softLimit, $n+2 hardCap, $n+3 hardLockMs, $n+4 softLockMs

  // Still one statement, and still against one row: the session match moved
  // from this table's own column to the participant it belongs to.
  const { rows } = await signatureSql(executor,
    `update signature_challenges c
        set attempts = c.attempts + 1,
            lifetime_attempts = c.lifetime_attempts + 1,
            locked_until = case
              when c.lifetime_attempts + 1 >= $${n + 2} then now() + $${n + 3}::bigint * interval '1 millisecond'
              when (c.attempts + 1) % $${n + 1} = 0 then now() + $${n + 4}::bigint * interval '1 millisecond'
              else null
            end
       from signature_participants p
      where c.participant_id = p.id
        and p.id = $1 and p.session_id = $2 and c.kind = $3
      returning c.attempts as attempts, c.lifetime_attempts as lifetime_attempts, c.locked_until as locked_until`,
    [...idParams, softLimit, hardCap, hardLockMs, softLockMs],
  );
  if (!rows.length) return null;
  const r = rows[0];
  const attempts: any = Number(r.attempts);
  const lifetimeAttempts: any = Number(r.lifetime_attempts);
  return {
    attempts,
    lifetimeAttempts,
    lockedUntil: r.locked_until ? (r.locked_until instanceof Date ? r.locked_until.toISOString() : r.locked_until) : null,
    softLocked: attempts % softLimit === 0,
    hardCapped: lifetimeAttempts >= hardCap,
  };
}

/**
 * S4: Single-use signing links: mark a participant's public token row CONSUMED
 * (stamp `consumed_at`) once that signer's turn is over, instead of deleting it.
 * The active-token resolve path filters `consumed_at is null`, so the link can no
 * longer authorize signing, but the retained row lets a reloaded completed link
 * be recognized (getConsumedTokenCompletion) and shown a friendly "already
 * signed" state. The NEXT signer's token row is a different participant_id and is
 * untouched. Returns the number of token rows stamped.
 */
export async function invalidateParticipantToken(token: any, participantId: string, executor = rootQueryExecutor) {
  const { rowCount } = await signatureSql(executor,
    `update signature_participant_tokens
        set consumed_at = now()
      where session_id = ${SESSION_BY_TOKEN('$1')} and participant_id = $2
        and consumed_at is null`,
    [token, participantId]
  );
  return rowCount;
}

/**
 * Item 1: For a token that has been CONSUMED (single-use spent), return whether
 * it belonged to a participant who already completed this session, plus the
 * minimal fields the frontend needs to render the "Your Signature Is Complete"
 * screen. Returns null when the token is unknown / not yet consumed, or its
 * participant is not completed. So we never reveal "completed" for a token that
 * did not genuinely belong to a completed signer.
 */
export async function getConsumedTokenCompletion(publicToken: any) {
  const { rows } = await signatureSql(rootQueryExecutor,
    `select p.status     as participant_status,
            s.status     as session_status,
            p.role_label as role_label,
            s.file_name  as file_name
       from signature_participant_tokens t
       join signature_sessions s     on s.id = t.session_id
       join signature_participants p on p.id = t.participant_id and p.session_id = s.id
      where t.token = $1 and t.consumed_at is not null
      limit 1`,
    [publicToken]
  );
  const row = rows[0];
  if (!row || row.participant_status !== 'completed') return null;
  return {
    participantStatus: row.participant_status,
    sessionStatus: row.session_status || null,
    roleLabel: row.role_label || null,
    fileName: row.file_name || null,
  };
}

/**
 * The completion a participant token belongs to, with enough of the record to
 * tell a RETRY of that completion from a second, different submission.
 *
 * `getConsumedTokenCompletion` above answers the friendly "already signed"
 * screen and deliberately reveals nothing beyond it. A retried completion needs
 * more: the consent blob carries the idempotency key the original submission was
 * accepted under, and the two statuses plus the outstanding-signer count say
 * which of the completion outcomes to report again. The token's own
 * `consumed_at` is not filtered on, because a single-use link is spent the
 * moment its turn completes and the retry necessarily arrives after that.
 */
export async function getCompletionReceiptByToken(publicToken: any) {
  const { rows } = await signatureSql(rootQueryExecutor,
    `select p.status  as participant_status,
            p.consent as consent,
            s.status  as session_status,
            (select count(*) from signature_participants op
              where op.session_id = s.id and op.status <> 'completed') as outstanding,
            (select np.name from signature_participants np
              where np.session_id = s.id and np.status = 'active'
              order by np.signing_order limit 1) as next_signer_name
       from signature_participant_tokens t
       join signature_sessions s     on s.id = t.session_id
       join signature_participants p on p.id = t.participant_id and p.session_id = s.id
      where t.token = $1
      limit 1`,
    [publicToken]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    participantStatus: row.participant_status,
    consent: row.consent || null,
    sessionStatus: row.session_status || null,
    outstandingParticipants: Number(row.outstanding || 0),
    nextSignerName: row.next_signer_name || null,
  };
}

/**
 * Rewrite the entire participant set for a session (matches the old whole-array
 * `participants:` writes). Updates existing participant rows by id, preserving
 * their public tokens (the tokens table is untouched).
 */
export async function replaceParticipants(token: any, participants: any, executor = rootQueryExecutor) {
  const sessionId = await resolveSessionId(executor, token);
  for (const p of participants || []) {
    // eslint-disable-next-line no-await-in-loop
    await signatureSql(executor,
      `update signature_participants set
        role_label = $1, signing_order = $2, delivery_method = $3, name = $4, email = $5,
        member_user_id = $6, client_user_id = $7, status = $8, requires_verification = $9,
        email_verified = $10, started_at = $11,
        completed_at = $12, consent = $13, signer_uid = $14, signer_name = $15, signer_ip = $16,
        facilitated_by = $17, field_values = $18, working_object_path = $19
       where id = $20 and session_id = $21`,
      [
        p.roleLabel ?? null, p.order ?? null, p.deliveryMethod ?? null, p.name ?? null, p.email ?? null,
        p.memberUserId ?? null, p.clientUserId ?? null, p.status ?? 'waiting', !!p.requiresVerification,
        !!p.emailVerified, toDbTs(p.startedAt),
        toDbTs(p.completedAt), p.consent ? JSON.stringify(p.consent) : null, p.signerUid ?? null,
        p.signerName ?? null, p.signerIp ?? null, p.facilitatedBy ?? null,
        p.fieldValues ? JSON.stringify(p.fieldValues) : null, p.workingObjectPath ?? null,
        p.participantId, sessionId,
      ]
    );
    // eslint-disable-next-line no-await-in-loop
    await writeParticipantChallenges(executor, sessionId, p);
  }
}

/**
 * S11: Check if an actor's view event occurred within windowMs.
 * Returns true when this call allows writing the audit event (no view in the window).
 */
export async function stampViewIfStale(token: any, actorKey: any, which: any, windowMs: any, executor = rootQueryExecutor) {
  const eventType = which === 'document' ? 'document.viewed' : 'session.viewed';
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const { rows } = await signatureSql(executor,
    `select 1 from signature_audit_events
      where session_id = ${SESSION_BY_TOKEN('$1')}
        and event_type = $2
        and metadata->>'actorKey' = $3
        and created_at >= $4
      limit 1`,
    [token, eventType, actorKey, cutoff]
  );
  return rows.length === 0;
}

// ── finders ────────────────────────────────────────────────────────────────
/**
 * Find the completed session a PDF came from, by hash.
 *
 * Matches EITHER sealed copy. The filed copy carries the appended Signature
 * Certificate page and the delivered copy does not, so they hash differently, and
 * the one a signer is holding is almost always the delivered one — matching only
 * the filed copy meant telling them their own signed document was unrecognised.
 *
 * Returns the session plus which copy matched, so the answer can name the
 * artifact instead of claiming both hashes are the same thing.
 */
export async function findSessionBySignedHash(hash: any) {
  const { rows } = await signatureSql(rootQueryExecutor,
    `select * from signature_sessions
       where status = 'completed'
         and (signed_document_hash = $1 or delivery_document_hash = $1)
       limit 1`,
    [hash]
  );
  if (!rows[0]) return null;
  // X2: /verify only needs session + participants, not fields/views.
  const session = await loadSessionGraphSlim(rows[0]);
  session.matchedCopy = rows[0].signed_document_hash === hash ? 'filed' : 'delivered';
  return session;
}

/**
 * The open signing sessions ONE user is personally involved in: sessions whose
 * active participant slot is theirs, and (when `includeCreatedBy`) sessions they
 * sent themselves.
 *
 * The involvement test lives in SQL rather than in the callers. Both callers used
 * to read the firm's 100 most recent open sessions and filter that page down to
 * the acting user in JS, so a firm with more than 100 open sessions dropped every
 * older one before the user's own test ever ran: a member whose document to sign
 * was the 101st-newest had no surface that showed it, and nothing on screen said
 * the list was short. Filtering first means any bound applies to the user's own
 * sessions, which is a number they can actually see the end of.
 */
export async function listPendingOrInProgressForUser(lawFirmId: string, userId: string, { includeCreatedBy = false }: any = {}) {
  if (!lawFirmId || !userId) return [];
  // Both branches are index-driven (signature_participants_member_idx,
  // signature_sessions_creator_open_idx), so the OR resolves as a bitmap union
  // rather than a scan of the firm's sessions.
  const involvement = [
    `exists (select 1 from signature_participants p
              where p.session_id = s.id
                and p.member_user_id = $2
                and p.status = 'active')`,
  ];
  if (includeCreatedBy) involvement.push(`s.created_by = $2`);

  const { rows } = await signatureSql(rootQueryExecutor,
    `select s.* from signature_sessions s
      where s.law_firm_id = $1
        and s.status in ('pending','in_progress')
        and (${involvement.join(' or ')})
      order by s.created_at desc`,
    [lawFirmId, userId]
  );
  // S6: this list only renders session + participants. Load slim graphs in two
  // batched child queries instead of a 4-table loadSessionGraph per row.
  return loadSessionGraphsSlimForRows(rows);
}

/**
 * S3: Pre-filter reminder candidates in SQL. Returns only the session
 * graphs whose ACTIVE participant is 1/3/5 days into signing AND has not been
 * reminded in the last 24h. The reminder cron previously loaded every
 * pending/in-progress graph (~400 queries even when 0 were due); now it loads a
 * graph only for the handful that actually qualify.
 *
 * The day delta is computed against coalesce(participant.started_at,
 * session.started_at, session.created_at), matching daysSince() in the service.
 */
export async function listReminderCandidates() {
  const { rows } = await signatureSql(rootQueryExecutor,
    `select distinct s.*
       from signature_sessions s
       join signature_participants p
         on p.session_id = s.id and p.status = 'active'
      where s.status in ('pending','in_progress')
        -- Widen the day window by ±1 around 1/3/5 so a timezone boundary between
        -- this SQL date math and the service's firm-calendar daysSince() can't
        -- under-select. The service re-asserts the exact {1,3,5} membership in
        -- JS, so widening only adds a few extra (cheaply-skipped) candidates.
        and (now()::date - coalesce(p.started_at, s.started_at, s.created_at)::date) between 0 and 6
        and not exists (
          select 1 from reminders r
           where r.signature_participant_id = p.id
             and r.last_sent_at is not null
             and r.last_sent_at >= now() - interval '24 hours'
        )
      order by s.created_at desc
      limit 100`
  );
  // S6: the reminder service only needs the active participant + counts.
  // load slim graphs (session + participants) in two batched child queries.
  return loadSessionGraphsSlimForRows(rows);
}

/**
 * Claim the right to send THIS participant's reminder, before the email goes
 * out. `listReminderCandidates` is a read; two overlapping cron sweeps can
 * both read the same participant before either has stamped
 * `last_reminder_sent_at`, and without a guard both go on to send the same
 * "please sign" nudge. Moving the 24h window into the `where` clause of a
 * single `UPDATE` makes Postgres arbitrate: exactly one caller's claim
 * matches a row, the same shape as `tasks.repository#claimReminderSend` and
 * `matterEvents.repository#claimReminderSend`.
 *
 * A caller whose send fails (provider rejects, or every attempt throws)
 * should call `releaseReminderClaim` with the `lastReminderSentAt` it read
 * before claiming, so the next eligible sweep retries instead of the
 * participant losing this reminder for a full day.
 *
 * The two options exist because the MANUAL resend route claims through here
 * too, and it wants a different arbitration from the cron sweep: a 60-second
 * window rather than a day, and `waiting` signers as well as `active` ones,
 * since a firm member may deliberately nudge someone whose turn has not come.
 * Both stay caller-supplied rather than being widened by default: the sweep
 * must keep its day-long window and must not chase a signer who cannot act.
 *
 * @returns {Promise<boolean>} true if this call won the right to send.
 */
export async function claimReminderSend(
  token: any,
  participantId: string,
  { withinSeconds = 24 * 60 * 60, statuses = ['active'] }: {
    withinSeconds?: number; statuses?: string[];
  } = {},
) {
  const seconds = Math.max(0, Math.trunc(Number(withinSeconds)));
  // One statement on the shared reminders row. A participant with no row yet is
  // claimed by the INSERT; one with a row is claimed by the DO UPDATE, whose
  // WHERE decides the window. Either way exactly one concurrent caller gets a
  // returned row, which is what makes this a claim rather than a check.
  const { rows } = await signatureSql(rootQueryExecutor,
    `insert into reminders (law_firm_id, signature_participant_id, last_sent_at, sent_count)
     select p.law_firm_id, p.id, now(), 1
       from signature_participants p
      where p.id = $1 and p.session_id = ${SESSION_BY_TOKEN('$2')}
        and p.status = any($4::text[])
     on conflict (law_firm_id, signature_participant_id) where signature_participant_id is not null
     do update set last_sent_at = now(), sent_count = reminders.sent_count + 1
      where reminders.last_sent_at is null
         or reminders.last_sent_at < now() - make_interval(secs => $3::int)
     returning id`,
    [participantId, token, seconds, statuses]
  );
  return rows.length > 0;
}

/**
 * Undo a reminder claim whose send failed, so the next eligible sweep
 * retries instead of treating the participant as reminded for the next 24h.
 */
export async function releaseReminderClaim(token: any, participantId: string, previous: any = null) {
  await signatureSql(rootQueryExecutor,
    `update reminders r
        set last_sent_at = $1, sent_count = greatest(r.sent_count - 1, 0)
       from signature_participants p
      where r.signature_participant_id = p.id
        and p.id = $2 and p.session_id = ${SESSION_BY_TOKEN('$3')}`,
    [previous ? toDbTs(previous) : null, participantId, token]
  );
}

/**
 * Lightweight status lookup by a participant's public token. ONE query, no
 * full session-graph load. Powers the waiting-signer status poll.
 *
 * A SPENT token answers nothing, the same rule the resolve path applies: the
 * poll runs on every page load, so a consumed link that kept reporting would
 * keep telling whoever holds an old URL how a session is progressing.
 *
 * The one exception is a token whose own participant COMPLETED. That signer
 * polls their own outcome while the executed document is still being produced,
 * and their turn consumed the token that would carry the poll. It discloses
 * nothing new: `GET /:token` already answers a consumed, completed token with
 * `alreadySigned` and the file name, so the friendly "already signed" screen
 * can render. A token spent WITHOUT completing (a decline, or a session
 * cancelled underneath the signer) still answers nothing.
 */
export async function getParticipantStatusByToken(publicToken: any) {
  const { rows } = await signatureSql(rootQueryExecutor,
    `select p.status as participant_status,
            s.status as session_status,
            (select count(*) from signature_participants where session_id = s.id) as total,
            (select count(*) from signature_participants where session_id = s.id and status = 'completed') as completed
       from signature_participant_tokens t
       join signature_sessions s     on s.id = t.session_id
       join signature_participants p on p.id = t.participant_id and p.session_id = s.id
      where t.token = $1
        and (t.consumed_at is null or p.status = 'completed')
      limit 1`,
    [publicToken]
  );
  return rows[0] || null;
}

/**
 * Documents pending the current client's signature. Returns exactly the columns
 * the `pending-for-client` response needs (session + the matching active
 * participant + completed/total counts) in ONE query. No full-graph load,
 * no per-session N+1.
 *
 * Waiting documents are addressed across every firm the client signs for, so
 * `lawFirmId` filters them in SQL. It used to read a flat newest-100 and leave
 * the caller to filter, which meant a client who signs for several firms could
 * have a document genuinely waiting on them fall outside the window and never
 * appear: the firm's portal page showed nothing waiting while the firm's side
 * showed the request as sent. Both the firm filter and the window now happen
 * where the whole set is visible.
 *
 * Paging is opt-in, matching the other paged reads: no `limit` returns every
 * waiting document.
 *
 * `singleLawFirmId` is the firm every waiting document belongs to, or null when
 * they span firms. The portal dashboard links to one firm's signing list only
 * when that list would hold all of them, and the page it holds cannot answer
 * that — so it is resolved over the whole matching set alongside the count.
 */
export async function findPendingDocumentsForClient(uid: string, { lawFirmId, limit, offset, page }: any = {}) {
  const params: unknown[] = [uid];
  let where = `s.status in ('pending','in_progress')`;

  if (lawFirmId) {
    params.push(lawFirmId);
    where += ` and s.law_firm_id = $${params.length}`;
  }

  const from = `from signature_sessions s
       join signature_participants p
         on p.session_id = s.id and p.client_user_id = $1 and p.status = 'active'`;

  const filterParams = params.slice();
  const { pageClause, pageOffset } = buildPageClause({
    limit, offset, page, params, fallbackLimit: 25, max: 100, optional: true,
  });

  const { rows } = await signatureSql(rootQueryExecutor,
    `select s.token            as session_token,
            s.law_firm_id       as law_firm_id,
            s.file_name         as file_name,
            s.routing_mode      as routing_mode,
            s.created_at        as created_at,
            p.id                as participant_id,
            p.role_label        as participant_role,
            p.name              as participant_name,
            -- The most recently issued unconsumed link for this participant.
            -- Read as a subselect rather than a join: resending a request adds a
            -- token without consuming the old one, so a join here multiplies the
            -- session into one row per live token, and the page would then hold
            -- more rows than the count beside it says exist.
            (select pt.token
               from signature_participant_tokens pt
              where pt.participant_id = p.id
                and pt.session_id = s.id
                and pt.consumed_at is null
              order by pt.created_at desc
              limit 1)          as public_token,
            (select count(*) from signature_participants ap where ap.session_id = s.id) as total,
            (select count(*) from signature_participants ap where ap.session_id = s.id and ap.status = 'completed') as completed,
            count(*) over()     as total_count
       ${from}
      where ${where}
      order by s.created_at desc, s.token asc
      ${pageClause}`,
    params
  );

  const totalItems = await resolveWindowTotal({
    rows,
    pageOffset,
    countSql: `select count(*) as total ${from} where ${where}`,
    filterParams,
  });

  // Cast to text so the aggregate does not depend on a min/max being defined for
  // the column's own type; the value is only ever read back as an id string.
  const { rows: firmRows } = await signatureSql(rootQueryExecutor,
    `select count(distinct s.law_firm_id) as firm_count,
            min(s.law_firm_id::text)      as first_law_firm_id
       ${from}
      where ${where}`,
    filterParams
  );
  const singleLawFirmId = Number(firmRows[0]?.firm_count) === 1
    ? firmRows[0].first_law_firm_id
    : null;

  return { rows, totalItems, singleLawFirmId };
}

/**
 * Which of a firm's sessions belong in its signing history, as a WHERE clause
 * over `signature_sessions s` binding the firm id as `$1`.
 *
 * Two classes of session are hidden because they are noise rather than records:
 * a cancelled session nobody ever signed, and a pending session that was
 * superseded (its file already has a completed session, and it has no signatures
 * of its own). Both rules live in SQL rather than in the route because a
 * page-local filter would drop rows out of a page after the count was taken, so
 * "showing 1-15 of 40" would not match what is rendered.
 *
 * "Never signed" is `no participant has completed`. Every session carries
 * participant rows, so the test is the same for a single signer and for many.
 *
 * Shared by the paged read and the status counts so the two always describe the
 * same set — a count that included sessions the list hides would label a filter
 * with a number the list could never reach.
 */
const FIRM_HISTORY_WHERE = `s.law_firm_id = $1
    and not (
      s.status = 'cancelled'
      and not exists (select 1 from signature_participants p
                       where p.session_id = s.id and p.status = 'completed')
    )
    and not (
      s.status = 'pending'
      and s.object_path is not null
      and not exists (select 1 from signature_participants p
                       where p.session_id = s.id and p.status = 'completed')
      and exists (select 1 from signature_sessions c
                   where c.law_firm_id = s.law_firm_id
                     and c.status = 'completed'
                     and c.object_path = s.object_path)
    )`;

/**
 * Where each of these sessions filed, or will file, its executed copy.
 *
 * Answers a whole PAGE of sessions in one query, because the list route needs
 * this per row and a lookup per row is a page of round trips.
 *
 * The FILED document decides, and the chosen folder is only the fallback for a
 * session that has not filed yet. The two differ whenever the chosen folder was
 * deleted while signing was open: the executed copy then goes to General Files,
 * and a location built from the request would point the browser at a folder that
 * is not there.
 */
export async function filingLocationsFor(lawFirmId: string, tokens: string[]) {
  const wanted = (tokens || []).filter(Boolean);
  if (!isUuid(lawFirmId) || wanted.length === 0) return new Map<string, any>();

  const { rows } = await signatureSql(rootQueryExecutor,
    `select s.token,
            folder.id        as folder_id,
            folder.scope     as scope,
            folder.matter_id as matter_id,
            folder.task_id   as task_id,
            folder.client_id as client_id
       from signature_sessions s
       left join files filed
         on filed.law_firm_id = s.law_firm_id
        and filed.signed_via_session = s.token
       left join files folder
         on folder.law_firm_id = s.law_firm_id
        and folder.id = coalesce(filed.parent_id, s.destination_folder_id)
      where s.law_firm_id = $1 and s.token = any($2::text[])`,
    [lawFirmId, wanted],
  );

  const byToken = new Map<string, any>();
  for (const row of rows) {
    if (!row.folder_id) continue;
    byToken.set(row.token, {
      scope: row.scope,
      matterId: row.matter_id || null,
      taskId: row.task_id || null,
      clientId: row.client_id || null,
      folderId: row.folder_id,
    });
  }
  return byToken;
}

/**
 * The firm signing history, windowed, filtered and counted by Postgres.
 *
 * Ordering is most-recent-activity first (the signed date, falling back to the
 * created date for anything unsigned), which is the order the history page
 * presents and a sensible "what happened lately" order for the compact widget.
 */
export async function listForFirmPaged(lawFirmId: string, { limit, offset, page, status, search }: any = {}) {
  const params: unknown[] = [lawFirmId];
  let where = FIRM_HISTORY_WHERE;

  // 'not_completed' is the synthetic "anything still outstanding" option the
  // history filter offers; every other value is a real session status.
  if (status === 'not_completed') {
    where += ` and s.status <> 'completed'`;
  } else if (status) {
    params.push(status);
    where += ` and s.status = $${params.length}`;
  }

  if (search && String(search).trim()) {
    params.push(`%${String(search).trim()}%`);
    const term = `$${params.length}`;
    where += ` and (s.file_name ilike ${term}
      or exists (select 1 from signature_participants p
                  where p.session_id = s.id
                    and (p.name ilike ${term} or p.signer_name ilike ${term}
                         or p.email::text ilike ${term})))`;
  }

  const filterParams = params.slice();
  const { pageClause, pageOffset } = buildPageClause({
    limit, offset, page, params, fallbackLimit: 25, max: 200,
  });

  const { rows } = await signatureSql(rootQueryExecutor,
    `select s.*, count(*) over() as total_count
       from signature_sessions s
      where ${where}
      order by coalesce(s.completed_at, s.created_at) desc nulls last, s.token asc
      ${pageClause}`,
    params
  );

  const totalItems = await resolveWindowTotal({
    rows,
    pageOffset,
    countSql: `select count(*) as total from signature_sessions s where ${where}`,
    filterParams,
  });

  // S5: the firm session list renders session + participants only (no
  // fields/views). ONE batched participants + ONE batched tokens query for the
  // whole page instead of 2 child queries per session (was 1+2N).
  const sessions = await loadSessionGraphsSlimForRows(rows);
  return { sessions, totalItems };
}

/**
 * How many sessions the firm's history holds in each status, as
 * `{ pending: 2, completed: 40, ... }` with absent statuses omitted.
 *
 * Counted over the whole history rather than the page on screen, and
 * deliberately not narrowed by the caller's search or status filter: this feeds
 * the status filters themselves, which have to keep saying how much each one
 * would match while one of them is active.
 */
export async function countByStatusForFirm(lawFirmId: string) {
  const { rows } = await signatureSql(rootQueryExecutor,
    `select s.status, count(*)::int as count
       from signature_sessions s
      where ${FIRM_HISTORY_WHERE}
      group by s.status`,
    [lawFirmId]
  );

  return rows.reduce((counts: any, row: any) => {
    counts[row.status] = row.count;
    return counts;
  }, {});
}

/**
 * Portal-enabled signing recipients: every `clients` row with a portal login
 * (`user_id`), person or company-linked alike, in one uniform shape (the
 * dedicated recipient-selection endpoint) - there is no more separate
 * "roster contact" identity arm to blend in, since a company's people are
 * real standalone Person `clients` rows now, linked via
 * `client_company_links` rather than held on a per-company roster row.
 *
 * Deliberately NOT built on `clients.repository.ts`'s `lookupClients` /
 * `listClientsPaged` `portalOnly` filter: that filter has no reason to know
 * about company linkage, while this endpoint's whole point is annotating a
 * linked person with which company they're signing on behalf of. Kept as its
 * own purpose-built lookup so the two stay independent: this endpoint only
 * ever needs to answer "who can I address a Paralegix-account-backed signing
 * request to", not the general client picker's much wider contract.
 *
 * A client linked to a company (via `client_company_links`) gets one row per
 * link (LEFT JOIN, not a subquery), carrying `companyLinkId` (the exact
 * `client_company_links.id`) and `companyName` so a firm signing-request flow
 * can show "{person name} - {company name}" and, if the same person is linked
 * to more than one company, offer them once per company they represent -
 * mirroring the old roster-contact-per-link behavior. A standalone person (no
 * company link at all) gets exactly one row with both fields null. A COMPANY
 * client itself never appears as a row: `clients_company_no_user_id_check`
 * guarantees a company never carries `user_id`, so `user_id is not null`
 * excludes it structurally, same as before.
 *
 * `user_id is not null` and non-archived status are both required: a
 * recipient with no login cannot be addressed for in-app/portal delivery,
 * which is what this list is for. A firm sending to someone with no portal
 * account at all still has the plain email/copy-link delivery methods, which
 * need no client lookup. A link to an archived company is treated as if it
 * didn't exist (both `companyLinkId`/`companyName` come back null) rather
 * than hiding the linked person entirely - they may still be a legitimate
 * recipient in their own right or through another, still-active company.
 *
 * Optional `clientId` narrows to one client record's own recipient row(s) -
 * used when the firm is already working from a known client/matter context.
 * Omitted, this searches every portal-enabled recipient in the firm, same
 * breadth as the generic client picker's browse mode.
 */
export async function listSigningRecipients(lawFirmId: string, { search, clientId, limit = 20 }: any = {}) {
  if (!lawFirmId) return { items: [], hasMore: false };

  // Firm scoping happens inside the CTE (the base `clients` row is filtered by
  // law_firm_id there); the CTE's output carries no such column, so the outer
  // WHERE only ever narrows by the projected recipient columns below.
  const where: string[] = [];
  const params: any[] = [lawFirmId];

  if (clientId !== undefined && clientId !== null && clientId !== '') {
    if (!isUuid(clientId)) return { items: [], hasMore: false };
    params.push(clientId);
    // Match the client record itself, OR the company it is. A company never
    // appears as a row here (it holds no `user_id`, so the CTE excludes it), so
    // narrowing to a company's own id used to return nothing at all -- the firm
    // could not address anyone from an organization's own context. Its linked
    // people carry `company_client_id`, which is what resolves them.
    where.push(`(client_row_id = $${params.length} or company_client_id = $${params.length})`);
  }

  const term = toIlikeTerm(search);
  if (term) {
    params.push(term);
    const p = `$${params.length}`;
    where.push(`(recipient_name ilike ${p} escape '\\' or recipient_email::text ilike ${p} escape '\\' or client_name ilike ${p} escape '\\')`);
  }

  const lim = Math.max(1, Math.min(Number(limit) || 20, 100));
  params.push(lim + 1);

  const { rows } = await signatureSql(rootQueryExecutor,
    `with recipients as (
       select c.id as client_row_id, c.name as client_name, c.client_type,
              c.user_id as recipient_user_id, coalesce(nullif(btrim(c.name), ''), u.name) as recipient_name,
              coalesce(c.email, u.email)::text as recipient_email,
              case when comp.id is not null then l.id end as company_link_id,
              comp.id as company_client_id,
              comp.name as company_name
         from clients c
         left join users u on u.id = c.user_id
         left join client_company_links l on l.law_firm_id = c.law_firm_id and l.person_client_id = c.id
         left join clients comp on comp.id = l.company_client_id and comp.law_firm_id = l.law_firm_id
                                and comp.status is distinct from 'archived'
        where c.law_firm_id = $1 and c.user_id is not null and c.status is distinct from 'archived'
     )
     select * from recipients
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by recipient_name asc nulls last, client_row_id asc, company_link_id asc nulls first
      limit $${params.length}`,
    params
  );

  const hasMore = rows.length > lim;
  const items = rows.slice(0, lim).map((r: any) => ({
    userId: r.recipient_user_id,
    name: r.recipient_name || '',
    email: r.recipient_email || null,
    clientId: r.client_row_id,
    clientName: r.client_name || '',
    clientType: r.client_type || 'person',
    companyLinkId: r.company_link_id || null,
    companyName: r.company_name || null,
  }));

  return { items, hasMore };
}


/**
 * (token, participantId) pairs for the still-actionable participant SLOTS one
 * portal client holds across the firm's open sessions - the MODERN multi-signer
 * binding, companion to `listOpenSessionTokensForClient` above.
 *
 * A `signers[]` session (buildSessionRecord in signingSessions.ts) never
 * populates the session-level `client_id` column - only the legacy
 * single-recipient fallback path does that - so a client bound as one signer
 * among several is invisible to the lookup above. Left unhandled, deleting
 * that client left their public signing link live inside an otherwise-open
 * multi-party session: the exact hole `listOpenSessionTokensForClient` exists
 * to close for the single-recipient case.
 *
 * Scoped to `status in ('active','waiting')` on the participant: a participant
 * who already completed, declined, or was already cancelled needs no further
 * handling, and returning them here would just push that same filtering into
 * the caller instead.
 */
export async function listOpenParticipantSessionsForClient(lawFirmId: string, clientUserId: string) {
  if (!lawFirmId || !clientUserId) return [];
  const { rows } = await signatureSql(rootQueryExecutor,
    `select s.token, p.id as participant_id
       from signature_participants p
       join signature_sessions s on s.id = p.session_id
      where s.law_firm_id = $1
        and p.client_user_id = $2
        and p.status in ('active', 'waiting')
        and s.status in ('pending', 'in_progress')`,
    [lawFirmId, clientUserId]
  );
  return rows.map((r: any) => ({ token: r.token, participantId: r.participant_id }));
}

/**
 * Cancel a single session in ONE transaction using a set-based participant
 * UPDATE instead of a whole-array rewrite (mirrors bulkExpireSessions). The
 * session is marked 'cancelled' and every non-completed participant is set to
 * 'cancelled'.
 */
export async function cancelSession(token: any) {
  await withDrizzleTransaction(async (client: any) => {
    await signatureSql(client,
      `update signature_sessions
          set status = 'cancelled', current_signer_order = null, updated_at = now()
        where token = $1`,
      [token]
    );
    await signatureSql(client,
      `update signature_participants p
          set status = 'cancelled'
         from signature_sessions s
        where s.token = $1 and p.session_id = s.id and p.status <> 'completed'`,
      [token]
    );
  });
}

/**
 * S3: slim expired-session listing: token + status only, no session-graph load.
 * Drives the cleanup job (was ~4 queries/session via loadSessionGraph).
 *
 * Covers 'in_progress' as well as 'pending'. A session becomes 'in_progress' the
 * moment its first signer submits, and expiring only 'pending' rows left every
 * partially-signed session open forever: past its own expiry, unsignable, never
 * swept, holding a scratch PDF per participant that nothing would ever delete.
 *
 * An 'in_progress' session whose participants have ALL completed is excluded: it
 * is not an abandoned session but a finalize that has not landed yet, and it
 * belongs to the recovery pass. Expiring it would discard signatures that were
 * genuinely collected.
 */
export async function listExpiredOpenSessions(cutoffIso: any) {
  const { rows } = await signatureSql(rootQueryExecutor,
    // law_firm_id rides along so the cleanup job can sweep each session's
    // firm-scoped working prefix without re-reading the session row.
    `select s.token, s.status, s.law_firm_id from signature_sessions s
       where s.status in ('pending', 'in_progress')
         and s.expires_at < $1
         and (
           s.status = 'pending'
           or exists (
             select 1 from signature_participants p
              where p.session_id = s.id and p.status <> 'completed'
           )
         )
       limit 500`,
    [toDbTs(cutoffIso)]
  );
  return rows;
}

/**
 * Sessions whose participants have all completed but which never reached the
 * terminal 'completed' state, indicating a finalize (build/seal/upload) that
 * failed after the last signer's completion committed. `cutoffIso` filters to
 * rows untouched for a grace period so an in-flight finalize is not disturbed.
 * Returns the session tokens (up to 200).
 */
export async function listStuckFinalizingSessions(cutoffIso: any) {
  const { rows } = await signatureSql(rootQueryExecutor,
    `select s.token from signature_sessions s
       where s.status = 'in_progress'
         and s.updated_at < $1
         and exists (select 1 from signature_participants p where p.session_id = s.id)
         and not exists (
           select 1 from signature_participants p
            where p.session_id = s.id and p.status <> 'completed'
         )
       limit 200`,
    [toDbTs(cutoffIso)]
  );
  return rows.map((r: any) => r.token);
}

/**
 * Move a session to its terminal state, once.
 *
 * The transition is the PUBLICATION: everything that happens to the outside
 * world (the executed copies going out, the quota charge, the completion
 * notification) hangs off it. So it is guarded rather than blind, and the
 * caller is told whether it was the one that moved the row.
 *
 * Two workers can legitimately reach this point for one session: a request
 * finishing a small document inline and a drain that picked the job up when the
 * request looked slow. Postgres serializes them on the row lock, exactly one
 * observes a non-terminal status, and the other delivers nothing. Without the
 * guard the firm gets two completion emails, the signers get two copies, and
 * the storage quota is charged twice for one document.
 *
 * Who signed is NOT written here. That lives on the participant rows, which the
 * consent transaction already wrote; a session-level copy would be the same
 * fact in two places and free to disagree.
 */
export async function markSessionCompleted(token: any, patch: { completedAt: string }) {
  const { rowCount } = await signatureSql(rootQueryExecutor,
    `update signature_sessions
        set status = 'completed',
            current_signer_order = null,
            completed_at = $2,
            delivery_owed_at = now(),
            updated_at = now()
      where token = $1
        and status <> 'completed'`,
    [token, toDbTs(patch.completedAt)]
  );
  return rowCount > 0;
}

/**
 * Claim the right to send a completed session's copies, or learn it is not ours.
 *
 * The claim is a lease taken BEFORE the send, and the session is stamped
 * delivered only AFTER it (`markSessionDelivered`). Between the two, a worker
 * that dies leaves the lease to lapse and the drain claims it again. That is a
 * deliberate choice of at-least-once over at-most-once: a crash mid-send can
 * repeat a copy, but nothing loses one. Stamping first would make a crash
 * mid-send silently drop the signers' copies, which is the failure this exists
 * to remove.
 *
 * One conditional UPDATE, so two workers cannot both win: the second waits on
 * the row lock, re-evaluates the WHERE against the first's lease, and matches
 * nothing. Only a session whose completion recorded a delivery as owed can be
 * claimed, which is what keeps every session completed before that marker
 * existed from being sent again.
 */
export async function claimSessionDelivery(token: any, leaseSeconds: number, maxAttempts: number) {
  const { rowCount } = await signatureSql(rootQueryExecutor,
    `update signature_sessions
        set delivery_lease_expires_at = now() + make_interval(secs => $2),
            delivery_attempts = delivery_attempts + 1
      where token = $1
        and status = 'completed'
        and delivery_owed_at is not null
        and delivered_at is null
        and (delivery_lease_expires_at is null or delivery_lease_expires_at < now())
        and delivery_attempts < $3`,
    [token, leaseSeconds, maxAttempts]
  );
  return rowCount > 0;
}

/** Record that a claimed delivery was sent. A second stamp changes nothing. */
export async function markSessionDelivered(token: any) {
  const { rowCount } = await signatureSql(rootQueryExecutor,
    `update signature_sessions
        set delivered_at = now(),
            delivery_lease_expires_at = null
      where token = $1
        and delivery_owed_at is not null
        and delivered_at is null`,
    [token]
  );
  return rowCount > 0;
}

/**
 * Completed sessions whose copies are owed and not currently claimed.
 *
 * Across firms on purpose: this is the drain's backstop for a worker that died
 * between completing a session and delivering it, and each token is then
 * claimed and delivered within its own firm. Oldest first, bounded, and served
 * by the partial `signature_sessions_delivery_owed_idx`.
 */
export async function listOwedSessionDeliveries(maxAttempts: number, limit = 50) {
  const { rows } = await signatureSql(rootQueryExecutor,
    `select token, law_firm_id from signature_sessions
       where delivery_owed_at is not null
         and delivered_at is null
         and status = 'completed'
         and (delivery_lease_expires_at is null or delivery_lease_expires_at < now())
         and delivery_attempts < $1
       order by delivery_owed_at asc
       limit $2`,
    [maxAttempts, limit]
  );
  return rows;
}

/**
 * Settled sessions whose scratch copies may still be on disk.
 *
 * The workspace sweep is fired inline whenever a session reaches a terminal
 * state, but it is best-effort and not awaited, so any of them can be lost to a
 * crash, a deploy, or a transient GCS error. This is the backstop that finds what
 * those missed: terminal sessions old enough that no reader remains.
 *
 * Driven from the sessions table rather than by walking the bucket, because the
 * working copies live under `lawfirmids/{firmId}/signing-work/` — one prefix per
 * firm, with no single parent to page through.
 *
 * Bounded at BOTH ends, which is what makes it a backstop rather than a treadmill.
 * With only a "settled before X" bound the oldest rows match forever, so every run
 * would re-sweep the same already-empty prefixes and never reach anything newer.
 * The window gives each settled session a fixed number of attempts (one per run
 * while it sits inside the window) and then lets it go. Ordered oldest-first
 * within the window so the sessions about to age out are tried first.
 */
export async function listSettledSessionsForWorkspaceSweep(cutoffIso: any, windowStartIso: any, limit = 500) {
  const { rows } = await signatureSql(rootQueryExecutor,
    `select token, law_firm_id from signature_sessions
       where status in ('completed', 'cancelled', 'expired')
         and updated_at < $1
         and updated_at >= $2
       order by updated_at asc
       limit $3`,
    [toDbTs(cutoffIso), toDbTs(windowStartIso), limit]
  );
  return rows;
}

/**
 * S3: expire a set of sessions in ONE transaction using set-based UPDATEs
 * (= any($1)) instead of per-session participant rewrites. Non-completed
 * participants of the given sessions are marked 'expired'.
 *
 * CLAIMING, not blind. The status guard means each token can only be expired
 * once, and the returned list is the set THIS caller expired. That matters
 * because the caller writes a `SESSION_EXPIRED` row into the signing audit
 * trail for each one, and that trail is tamper-evident evidence rendered onto
 * the signing certificate. Without the guard, two sweeps running concurrently
 * both select the same open sessions, both update them, and both append audit
 * rows — duplicate entries in a record whose whole purpose is to be relied on.
 *
 * Same shape as `claimStuckFinalization` above: guard the state transition in
 * the `where` clause and let the database pick the winner.
 *
 * @returns {Promise<string[]>} the tokens this call actually expired.
 */
export async function bulkExpireSessions(tokens: any) {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];
  return withDrizzleTransaction(async (client: any) => {
    const { rows: claimed } = await signatureSql(client,
      `update signature_sessions
          set status = 'expired', current_signer_order = null, updated_at = now()
        where token = any($1)
          and status in ('pending', 'in_progress')
        returning token`,
      [tokens]
    );
    if (claimed.length === 0) return [];

    const claimedTokens = claimed.map((r: any) => r.token);
    // Scoped to the claimed tokens, not the requested ones: a session another
    // worker expired is already handled, and its participants with it.
    await signatureSql(client,
      `update signature_participants p
          set status = 'expired'
         from signature_sessions s
        where s.token = any($1) and p.session_id = s.id and p.status <> 'completed'`,
      [claimedTokens]
    );
    return claimedTokens;
  });
}

// ── transactional session work (parallel-routing complete path) ────────────
/**
 * Loads the session graph FOR UPDATE (locks the session row + its participants),
 * runs fn(sessionGraph, txRepo), and commits. txRepo exposes updateSession /
 * updateParticipant / replaceParticipants bound to the transaction client.
 */
export async function runSessionTransaction(token: any, fn: any) {
  return withDrizzleTransaction(async (client: any) => {
    const lockRes = await signatureSql(client,
      `select * from signature_sessions where token = $1 for update`,
      [token]
    );
    // Returning commits an empty transaction, which releases the row lock just
    // as the previous explicit rollback did.
    if (!lockRes.rows[0]) return null;

    // Lock participants too.
    await signatureSql(client,
      `select 1 from signature_participants where session_id = $1 for update`,
      [lockRes.rows[0].id]);

    const sessionGraph = await loadSessionGraph(client, lockRes.rows[0]);
    const txRepo = {
      /** The session's uuid, which the token alone does not carry. */
      sessionId: lockRes.rows[0].id,
      updateSession: (patch: any) => updateSession(token, patch, client),
      updateParticipant: (pid: any, patch: any) => updateParticipant(token, pid, patch, client),
      replaceParticipants: (parts: any) => replaceParticipants(token, parts, client),
      invalidateParticipantToken: (pid: any) => invalidateParticipantToken(token, pid, client),
      /**
       * Commit a processing job in THIS transaction.
       *
       * A finalize job enqueued after the consent commits is lost by a process
       * that dies in between, and the session is then complete with nothing
       * owed and nothing produced. Committing it with the consent is what makes
       * the work survive the request that asked for it.
       */
      enqueueProcessingJob: (input: {
        sourceId: string;
        sessionId?: string | null;
        kind: 'prepare' | 'finalize';
        inputRevision?: string | null;
      }) => enqueueProcessingJob(
        lockRes.rows[0].law_firm_id,
        { sessionId: lockRes.rows[0].id, ...input },
        client,
      ),
    };
    return fn(sessionGraph, txRepo);
  });
}

export async function deleteSession(token: any) {
  await signatureSql(rootQueryExecutor, `delete from signature_sessions where token = $1`, [token]);
}

// ── templates ──────────────────────────────────────────────────────────────
export async function listTemplates(lawFirmId: string) {
  const { rows } = await signatureSql(rootQueryExecutor,
    `select * from signature_templates where law_firm_id = $1 order by updated_at desc`,
    [lawFirmId]
  );
  return rows;
}

export async function getTemplate(id: any, lawFirmId: string) {
  // `signature_templates.id` is a uuid column, so a malformed id reaches
  // Postgres as a cast error and surfaces as a 500. It can never name a real
  // template, so answer it the way a well-formed id for a template that does
  // not exist is answered: the routes turn null into their own 404.
  if (!isUuid(id)) return null;
  const { rows } = await signatureSql(rootQueryExecutor,
    `select * from signature_templates where id = $1 and law_firm_id is not distinct from $2`,
    [id, lawFirmId]
  );
  return rows[0] || null;
}

export async function createTemplate(data: any) {
  const { rows } = await signatureSql(rootQueryExecutor,
    `insert into signature_templates
      (law_firm_id, name, description, fields, signer_roles, source_file_name,
       source_object_path, source_id, routing_mode, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [
      data.lawFirmId, data.name, data.description ?? '',
      JSON.stringify(data.fields ?? []), JSON.stringify(data.signerRoles ?? []),
      data.sourceFileName ?? null, data.sourceObjectPath ?? null,
      data.sourceId ?? null,
      data.routingMode ?? 'sequential', data.createdBy ?? null,
    ]
  );
  return rows[0];
}

const TEMPLATE_COLUMN_MAP: any = {
  name: 'name',
  description: 'description',
  sourceFileName: 'source_file_name',
  sourceObjectPath: 'source_object_path',
  sourceId: 'source_id',
  routingMode: 'routing_mode',
};

export async function updateTemplate(id: any, lawFirmId: string, patch: any) {
  if (!isUuid(id)) return null;
  const sets = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch) as Array<[string, any]>) {
    if (key === 'fields') { params.push(JSON.stringify(value ?? [])); sets.push(`fields = $${params.length}`); continue; }
    if (key === 'signerRoles') { params.push(JSON.stringify(value ?? [])); sets.push(`signer_roles = $${params.length}`); continue; }
    const col = TEMPLATE_COLUMN_MAP[key];
    if (!col) continue;
    params.push(value); sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return getTemplate(id, lawFirmId);
  params.push(id, lawFirmId);
  const { rows } = await signatureSql(rootQueryExecutor,
    `update signature_templates set ${sets.join(', ')}
       where id = $${params.length - 1} and law_firm_id is not distinct from $${params.length} returning *`,
    params
  );
  return rows[0] || null;
}

export async function deleteTemplate(id: any, lawFirmId: string) {
  if (!isUuid(id)) return false;
  const { rowCount } = await signatureSql(rootQueryExecutor,
    `delete from signature_templates where id = $1 and law_firm_id is not distinct from $2`,
    [id, lawFirmId]
  );
  return rowCount > 0;
}

// ── signature sources (the admission boundary) ─────────────────────────────
//
// Every document that reaches a signer has a row here, whichever route uploaded
// it. The status on that row, not the code path that created it, is what
// downstream reads are allowed to trust.

/** Columns as the module reads them. `digest_state` stays a Buffer. */
function mapSourceRow(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    lawFirmId: row.law_firm_id,
    uploadedBy: row.uploaded_by || null,
    objectPath: row.object_path,
    // A GCS generation stays a string all the way through. Coercing it to a
    // number rounds past 2^53 and makes two versions compare equal.
    objectGeneration: row.object_generation === null || row.object_generation === undefined
      ? null : String(row.object_generation),
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    documentHash: row.document_hash || null,
    profileVersion: Number(row.profile_version || 1),
    status: row.status,
    failureCode: row.failure_code || null,
    failureDetail: row.failure_detail || null,
    preparedObjectPath: row.prepared_object_path || null,
    preparedGeneration: row.prepared_generation === null || row.prepared_generation === undefined
      ? null : String(row.prepared_generation),
    preparedSizeBytes: row.prepared_size_bytes === null || row.prepared_size_bytes === undefined
      ? null : Number(row.prepared_size_bytes),
    preparedHash: row.prepared_hash || null,
    pageCount: row.page_count === null || row.page_count === undefined ? null : Number(row.page_count),
    digestAlgorithm: row.digest_algorithm || null,
    digestLibraryVersion: row.digest_library_version || null,
    digestState: row.digest_state ? Buffer.from(String(row.digest_state), 'base64') : null,
    digestStateBytes: row.digest_state_bytes === null || row.digest_state_bytes === undefined
      ? null : Number(row.digest_state_bytes),
    digestStateGeneration: row.digest_state_generation === null || row.digest_state_generation === undefined
      ? null : String(row.digest_state_generation),
    operationId: row.operation_id || null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Claim the one source row for a stored object, or return the existing one.
 *
 * `on conflict do nothing` plus a read makes a repeated finalize idempotent
 * rather than a duplicate-key error. Two finalize calls for one upload is the
 * normal shape of a retried request, not a caller mistake.
 */
export async function createSource(lawFirmId: string, input: {
  uploadedBy?: string | null;
  objectPath: string;
  profileVersion?: number;
}) {
  const { rows } = await signatureSql(rootQueryExecutor,
    `insert into signature_sources (law_firm_id, uploaded_by, object_path, profile_version)
     values ($1, $2, $3, $4)
     on conflict (law_firm_id, object_path) do nothing
     returning *`,
    [lawFirmId, input.uploadedBy || null, input.objectPath, input.profileVersion || 1],
  );
  if (rows[0]) return mapSourceRow(rows[0]);
  return getSourceByObjectPath(lawFirmId, input.objectPath);
}

export async function getSource(lawFirmId: string, id: any) {
  if (!isUuid(id)) return null;
  const { rows } = await signatureSql(rootQueryExecutor,
    `select * from signature_sources where law_firm_id = $1 and id = $2 limit 1`,
    [lawFirmId, id],
  );
  return mapSourceRow(rows[0]);
}

export async function getSourceByObjectPath(lawFirmId: string, objectPath: string) {
  const { rows } = await signatureSql(rootQueryExecutor,
    `select * from signature_sources where law_firm_id = $1 and object_path = $2 limit 1`,
    [lawFirmId, objectPath],
  );
  return mapSourceRow(rows[0]);
}

const SOURCE_COLUMN_MAP: Record<string, string> = {
  objectGeneration: 'object_generation',
  sizeBytes: 'size_bytes',
  documentHash: 'document_hash',
  status: 'status',
  failureCode: 'failure_code',
  failureDetail: 'failure_detail',
  preparedObjectPath: 'prepared_object_path',
  preparedGeneration: 'prepared_generation',
  preparedSizeBytes: 'prepared_size_bytes',
  preparedHash: 'prepared_hash',
  pageCount: 'page_count',
  digestAlgorithm: 'digest_algorithm',
  digestLibraryVersion: 'digest_library_version',
  digestState: 'digest_state',
  digestStateBytes: 'digest_state_bytes',
  digestStateGeneration: 'digest_state_generation',
  operationId: 'operation_id',
};

export async function updateSource(lawFirmId: string, id: any, patch: Record<string, any>) {
  if (!isUuid(id)) return null;
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = SOURCE_COLUMN_MAP[key];
    if (!col) continue;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return getSource(lawFirmId, id);
  params.push(lawFirmId, id);
  const { rows } = await signatureSql(rootQueryExecutor,
    `update signature_sources set ${sets.join(', ')}
       where law_firm_id = $${params.length - 1} and id = $${params.length} returning *`,
    params,
  );
  return mapSourceRow(rows[0]);
}

/**
 * Move a source into `preparing`, but only from `pending` or `preparing`.
 *
 * The status is the fence. Two workers that both pick up the same source would
 * otherwise both hash it and both write a digest state, and the second write
 * would land after the first reader already resumed from it. The row count says
 * which one won.
 */
export async function claimSourceForPreparation(lawFirmId: string, id: any, operationId: string) {
  if (!isUuid(id)) return null;
  const { rows } = await signatureSql(rootQueryExecutor,
    `update signature_sources
        set status = 'preparing', operation_id = $3, failure_code = null, failure_detail = null
      where law_firm_id = $1 and id = $2 and status in ('pending', 'preparing')
      returning *`,
    [lawFirmId, id, operationId],
  );
  return mapSourceRow(rows[0]);
}

// ── signature processing jobs (durable work) ───────────────────────────────
//
// A row is the promise that work is owed. The LEASE on it is what keeps two
// workers from both publishing: every write below re-checks the token, so a
// worker that stalled past its expiry finds its updates refused rather than
// landing on top of its replacement's.

function mapJobRow(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    lawFirmId: row.law_firm_id,
    sourceId: row.source_id,
    sessionId: row.session_id || null,
    kind: row.kind,
    status: row.status,
    inputRevision: row.input_revision === null || row.input_revision === undefined
      ? null : String(row.input_revision),
    attempt: Number(row.attempt || 0),
    nextAttemptAt: toIso(row.next_attempt_at),
    leaseOwner: row.lease_owner || null,
    leaseToken: row.lease_token || null,
    leaseExpiresAt: toIso(row.lease_expires_at),
    phase: row.phase || null,
    phaseState: row.phase_state || null,
    failureCode: row.failure_code || null,
    failureDetail: row.failure_detail || null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Commit a job, or return the live one that already exists.
 *
 * `executor` lets the caller commit the job in the SAME transaction as the
 * thing that owes it, which is the whole point: a job enqueued after the commit
 * can be lost by a process that dies in between, and the session is then
 * complete with nothing owed and nothing produced.
 *
 * The conflict target is the live-operation index, so a second finalize for one
 * session returns the first job instead of creating a rival that would seal,
 * publish and notify a second time.
 */
export async function enqueueProcessingJob(lawFirmId: string, input: {
  sourceId: string;
  sessionId?: string | null;
  kind: 'prepare' | 'finalize';
  inputRevision?: string | null;
}, executor: any = rootQueryExecutor) {
  const { rows } = await signatureSql(executor,
    `insert into signature_processing_jobs (law_firm_id, source_id, session_id, kind, input_revision)
     values ($1, $2, $3, $4, $5)
     on conflict do nothing
     returning *`,
    [lawFirmId, input.sourceId, input.sessionId || null, input.kind, input.inputRevision || null],
  );
  if (rows[0]) return mapJobRow(rows[0]);

  const { rows: existing } = await signatureSql(executor,
    // `is not distinct from` on BOTH nullable columns. `source_id = null` is
    // never true, so an equality here would find nothing for exactly the rows
    // that carry a null, and the caller would read the conflict as "no live job"
    // and go on to act as if it had created one.
    `select * from signature_processing_jobs
      where law_firm_id = $1 and kind = $2
        and source_id is not distinct from $3
        and session_id is not distinct from $4
        and status in ('queued', 'leased')
      limit 1`,
    [lawFirmId, input.kind, input.sourceId, input.sessionId || null],
  );
  return mapJobRow(existing[0]);
}

/**
 * Take the next job that is ready, with a lease.
 *
 * `for update skip locked` is what lets several instances poll the same table
 * without serializing on it: a row another worker is claiming is skipped rather
 * than waited for. A job whose lease has expired is claimable again, which is
 * how work escapes a worker that died holding it.
 *
 * The attempt counter increments HERE, on the claim, not on the failure. A
 * worker that dies without reporting anything would otherwise retry forever.
 */
export async function claimProcessingJob(owner: string, leaseSeconds: number) {
  const { rows } = await signatureSql(rootQueryExecutor,
    `update signature_processing_jobs j
        set status = 'leased',
            lease_owner = $1,
            lease_token = gen_random_uuid(),
            lease_expires_at = now() + make_interval(secs => $2::double precision),
            attempt = j.attempt + 1
      where j.id = (
        select id from signature_processing_jobs
         where (status = 'queued' and next_attempt_at <= now())
            or (status = 'leased' and lease_expires_at < now())
         order by next_attempt_at
         limit 1
         for update skip locked
      )
      returning *`,
    [owner, leaseSeconds],
  );
  return mapJobRow(rows[0]);
}

/**
 * Claim ONE named job, if it is free.
 *
 * The request that created a job usually runs it straight away, because waiting
 * for a scheduler to notice a 200 KB document is a worse experience than doing
 * the work. It has to claim through the same lease as the drain, or the two
 * race and both publish.
 *
 * Returns null when another worker already holds it, which is not an error: the
 * caller reports the job as in progress and the client polls.
 */
export async function claimProcessingJobById(
  lawFirmId: string,
  jobId: any,
  owner: string,
  leaseSeconds: number,
) {
  if (!isUuid(jobId)) return null;
  const { rows } = await signatureSql(rootQueryExecutor,
    `update signature_processing_jobs
        set status = 'leased',
            lease_owner = $3,
            lease_token = gen_random_uuid(),
            lease_expires_at = now() + make_interval(secs => $4::double precision),
            attempt = attempt + 1
      where law_firm_id = $1 and id = $2
        and (status = 'queued' or (status = 'leased' and lease_expires_at < now()))
      returning *`,
    [lawFirmId, jobId, owner, leaseSeconds],
  );
  return mapJobRow(rows[0]);
}

/**
 * Extend a lease, if it is still ours.
 *
 * Returns false when the token no longer matches, which means the job was taken
 * away. A worker that keeps going after that is doing work nobody will accept,
 * so the caller stops rather than racing the new holder.
 */
export async function renewProcessingLease(jobId: string, leaseToken: string, leaseSeconds: number) {
  if (!isUuid(jobId) || !isUuid(leaseToken)) return false;
  const { rowCount } = await signatureSql(rootQueryExecutor,
    `update signature_processing_jobs
        set lease_expires_at = now() + make_interval(secs => $3::double precision)
      where id = $1 and lease_token = $2 and status = 'leased'`,
    [jobId, leaseToken, leaseSeconds],
  );
  return rowCount > 0;
}

/**
 * Record a durable phase output, if the lease is still ours.
 *
 * The state names artifact GENERATIONS rather than paths, so a resumed job can
 * tell its own output from a rival attempt's at the same path.
 */
export async function checkpointProcessingJob(
  jobId: string,
  leaseToken: string,
  phase: string,
  phaseState: unknown,
) {
  if (!isUuid(jobId) || !isUuid(leaseToken)) return false;
  const { rowCount } = await signatureSql(rootQueryExecutor,
    `update signature_processing_jobs
        set phase = $3, phase_state = $4
      where id = $1 and lease_token = $2 and status = 'leased'`,
    [jobId, leaseToken, phase, JSON.stringify(phaseState ?? null)],
  );
  return rowCount > 0;
}

/** Settle a job as done, if the lease is still ours. */
export async function completeProcessingJob(jobId: string, leaseToken: string) {
  if (!isUuid(jobId) || !isUuid(leaseToken)) return false;
  const { rowCount } = await signatureSql(rootQueryExecutor,
    `update signature_processing_jobs
        set status = 'succeeded', lease_token = null, lease_owner = null, lease_expires_at = null,
            failure_code = null, failure_detail = null
      where id = $1 and lease_token = $2 and status = 'leased'`,
    [jobId, leaseToken],
  );
  return rowCount > 0;
}

/**
 * Record a failure, if the lease is still ours.
 *
 * A retryable failure goes back to `queued` with a later `next_attempt_at`; a
 * permanent one is `failed` and stays for a person to look at. Failed work is
 * kept rather than deleted, because the row is the only record that anything
 * was ever owed.
 */
export async function failProcessingJob(jobId: string, leaseToken: string, failure: {
  code: string;
  detail?: string;
  retryInSeconds?: number | null;
}) {
  if (!isUuid(jobId) || !isUuid(leaseToken)) return false;
  const retry = failure.retryInSeconds;
  const { rowCount } = await signatureSql(rootQueryExecutor,
    `update signature_processing_jobs
        set status = case when $3::double precision is null then 'failed' else 'queued' end,
            next_attempt_at = case
              when $3::double precision is null then next_attempt_at
              else now() + make_interval(secs => $3::double precision) end,
            lease_token = null, lease_owner = null, lease_expires_at = null,
            failure_code = $4, failure_detail = $5
      where id = $1 and lease_token = $2 and status = 'leased'`,
    [jobId, leaseToken, retry ?? null, failure.code, (failure.detail || '').slice(0, 500)],
  );
  return rowCount > 0;
}

/**
 * Stop every live job for a source or session.
 *
 * Cancellation, expiry and firm deletion all have to invalidate the lease, not
 * merely mark an intent: clearing the token is what stops a worker already
 * inside the operation from publishing when it finishes.
 */
export async function cancelProcessingJobs(lawFirmId: string, scope: {
  sourceId?: string | null;
  sessionId?: string | null;
}) {
  const { rowCount } = await signatureSql(rootQueryExecutor,
    `update signature_processing_jobs
        set status = 'cancelled', lease_token = null, lease_owner = null, lease_expires_at = null
      where law_firm_id = $1
        and status in ('queued', 'leased')
        and ($2::uuid is null or source_id = $2)
        and ($3::uuid is null or session_id = $3)`,
    [lawFirmId, scope.sourceId || null, scope.sessionId || null],
  );
  return rowCount;
}

/**
 * The live job for one logical operation, if there is one.
 *
 * The same predicate the live-operation unique index enforces, read rather than
 * written. A caller that wants to RUN what is owed asks this; a caller that
 * wants to OWE something calls `enqueueProcessingJob`, which returns the live
 * one anyway. Keeping the read separate is what lets the recovery pass tell
 * "nothing is owed" from "something is owed and someone else has it".
 */
export async function findLiveProcessingJob(lawFirmId: string, scope: {
  sessionId?: string | null;
  sourceId?: string | null;
  kind: 'prepare' | 'finalize';
}) {
  const { rows } = await signatureSql(rootQueryExecutor,
    `select * from signature_processing_jobs
      where law_firm_id = $1 and kind = $2
        and ($3::uuid is null or session_id = $3)
        and ($4::uuid is null or source_id = $4)
        and status in ('queued', 'leased')
      order by created_at
      limit 1`,
    [lawFirmId, scope.kind, scope.sessionId || null, scope.sourceId || null],
  );
  return mapJobRow(rows[0]);
}

export async function getProcessingJob(lawFirmId: string, id: any) {
  if (!isUuid(id)) return null;
  const { rows } = await signatureSql(rootQueryExecutor,
    `select * from signature_processing_jobs where law_firm_id = $1 and id = $2 limit 1`,
    [lawFirmId, id],
  );
  return mapJobRow(rows[0]);
}

/** How many jobs are waiting, for the drain's own report. */
export async function countReadyProcessingJobs() {
  const { rows } = await signatureSql(rootQueryExecutor,
    `select count(*)::int as n from signature_processing_jobs
      where (status = 'queued' and next_attempt_at <= now())
         or (status = 'leased' and lease_expires_at < now())`,
  );
  return rows[0]?.n || 0;
}

// ── the artifact audit ─────────────────────────────────────────────────────

/**
 * How long an audited artifact rests before it is due to be audited again.
 *
 * The audit is a fixity check: it re-downloads a sealed PDF from storage and
 * re-hashes every byte. Digital-preservation practice (the NDSA Levels of
 * Digital Preservation) checks fixity on ingest and then at fixed intervals,
 * not continuously. Without an interval the every-minute signing drain cycled
 * through the same few artifacts forever, paying a full download and hash per
 * minute to learn nothing new. A never-audited artifact is still taken first,
 * so a new signature is checked on the next drain; this bounds only the repeats.
 */
const AUDIT_REPEAT_INTERVAL_DAYS = 30;

/**
 * Take the completed session most due for an audit, and stamp it as taken.
 *
 * Never-audited sessions come first, oldest completion first. After that, a
 * session is taken again only once its last audit is older than
 * `AUDIT_REPEAT_INTERVAL_DAYS`, least recently audited first; until then there
 * is nothing to take and the drain moves on.
 *
 * Two picks joined by `coalesce` rather than one `audited_at is null or
 * audited_at < ...` filter. An OR cannot bound `signature_sessions_audit_idx`, so
 * once every artifact is inside its interval, the usual state, the single pick
 * walked every completed session on every drain to find nothing. Each pick here
 * is an index range on its own, and the second runs only when the first is empty.
 *
 * The stamp goes on in the SAME statement that picks the row, so two instances
 * draining at once cannot both audit the same artifact while leaving every
 * other one unchecked. The result is recorded afterwards; this only reserves.
 */
export async function claimSessionForAudit() {
  const { rows } = await signatureSql(rootQueryExecutor,
    `update signature_sessions
        set audited_at = now()
      where id = coalesce(
        (select id from signature_sessions
          where status = 'completed'
            and signed_object_path is not null
            and signed_document_hash is not null
            and audited_at is null
          order by audited_at nulls first, completed_at
          limit 1
          for update skip locked),
        (select id from signature_sessions
          where status = 'completed'
            and signed_object_path is not null
            and signed_document_hash is not null
            and audited_at < now() - make_interval(days => $1::int)
          order by audited_at nulls first, completed_at
          limit 1
          for update skip locked)
      )
      returning id, law_firm_id, token, signed_object_path, signed_document_hash,
                delivery_document_hash, audited_at`,
    [AUDIT_REPEAT_INTERVAL_DAYS],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    lawFirmId: row.law_firm_id,
    token: row.token,
    signedObjectPath: row.signed_object_path,
    signedDocumentHash: row.signed_document_hash,
    deliveryDocumentHash: row.delivery_document_hash || null,
    auditedAt: toIso(row.audited_at),
  };
}

/** What the audit found. Kept, because a mismatch is a thing a person reads. */
export async function recordAuditResult(id: string, result: string, detail?: string | null) {
  if (!isUuid(id)) return false;
  const { rowCount } = await signatureSql(rootQueryExecutor,
    `update signature_sessions set audit_result = $2, audit_detail = $3 where id = $1`,
    [id, result, (detail || '').slice(0, 500) || null],
  );
  return rowCount > 0;
}

/**
 * A session's token from its uuid.
 *
 * The token is the session's primary key everywhere else, but a job row names
 * the uuid, because that is what a foreign key can point at. This is the one
 * place the two are joined.
 */
export async function getSessionTokenById(lawFirmId: string, id: any) {
  if (!isUuid(id)) return null;
  const { rows } = await signatureSql(rootQueryExecutor,
    `select token from signature_sessions where law_firm_id = $1 and id = $2 limit 1`,
    [lawFirmId, id],
  );
  return rows[0]?.token || null;
}

/**
 * Which of these stored objects something live still points at.
 *
 * The transient upload prefix is swept by age, and age alone is the wrong
 * question: a session may stay open for thirty days while the sweep collects at
 * ten, so a document signed on day fifteen had its source deleted five days
 * earlier and cannot be finalized at all. Deleting it is silent, and the failure
 * surfaces as a signing link that stops working for no stated reason.
 *
 * "Live" means an open session's source or working copy, or an admitted source
 * that has not failed. A settled session's scratch is collected by the workspace
 * sweep, which knows the session is done; this one only has to refuse to delete
 * what is still in use.
 */
export async function findReferencedObjectPaths(paths: string[]): Promise<Set<string>> {
  if (!Array.isArray(paths) || paths.length === 0) return new Set();
  const { rows } = await signatureSql(rootQueryExecutor,
    `select object_path as p from signature_sessions
       where status in ('pending', 'in_progress') and object_path = any($1)
     union
     select working_object_path from signature_sessions
       where status in ('pending', 'in_progress') and working_object_path = any($1)
     union
     select p.working_object_path from signature_participants p
       join signature_sessions s on s.id = p.session_id
      where s.status in ('pending', 'in_progress') and p.working_object_path = any($1)
     union
     select object_path from signature_sources
       where status <> 'failed' and object_path = any($1)
     union
     select prepared_object_path from signature_sources
       where status <> 'failed' and prepared_object_path = any($1)
     union
     select source_object_path from signature_templates
       where source_object_path = any($1)`,
    [paths],
  );
  return new Set(rows.map((r: any) => r.p).filter(Boolean));
}
