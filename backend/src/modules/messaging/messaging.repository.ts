/**
 * Messaging repository (Postgres). conversations + messages + (derived) unread
 * counts. A conversation is unique per (law_firm_id, client_id). Unread counts
 * are derived from message read flags, so there is no aggregate doc to keep in
 * sync.
 */

const { ConflictError, ForbiddenError, NotFoundError } = require('../../shared/errors/AppError');
const { assertLawFirmMembership } = require('../../shared/utils/membership');
const { isUuid } = require('../../shared/utils/isUuid');
const {
  adminQuery,
  parameterizedSql,
  rootQueryExecutor,
  withDrizzleTransaction,
} = require('../../shared/database/queryContext');
const { restorePgTypes } = require('../../shared/database/pgTypeRestore');
const { toIlikeTerm } = require('../../shared/database/searchTerm');
const { buildOrderBy, buildPageClause, resolveWindowTotal } = require('../../shared/database/pagination');
const { stripAttachmentUrls } = require('../../shared/utils/attachmentSigning');

const { rowIso: iso } = require('../../shared/utils/dateConversion');

/**
 * Messaging authorizes several reads by conversation/participant identity before
 * a tenant id is available. Keep those deliberately privileged paths searchable,
 * parameterized, and on the same Drizzle executor as tenant-scoped operations.
 */
function messagingSql(reason: string, executor: any, text: string, params: unknown[] = []) {
  return adminQuery(
    reason,
    (queryExecutor: any) => queryExecutor.execute(parameterizedSql(text, params)),
    executor,
  ).then(restorePgTypes);
}

function authorizedMessagingSql(text: string, params: unknown[] = []) {
  return messagingSql(
    'messaging access is authorized by the repository caller',
    rootQueryExecutor,
    text,
    params,
  );
}

function transactionalMessagingSql(executor: any, text: string, params: unknown[] = []) {
  return messagingSql(
    'messaging transaction is scoped by its parent conversation or firm',
    executor,
    text,
    params,
  );
}

function convEntity(r: any) {
  if (!r) return null;
  // The preview is the newest message, joined at read time. It used to be a
  // `last_message_preview` column written once at send and never updated, which
  // the read then coalesced over this; an edited or deleted message left the
  // list showing text the thread no longer contained.
  const derivedPreview = r.derived_last_message_content || '';
  return {
    conversationId: r.id,
    // Always 'direct' on these read paths, but carried explicitly so a merged
    // direct+group list can tell the two row shapes apart client-side.
    conversationType: r.conversation_type || 'direct',
    clientId: r.client_id,
    clientName: r.derived_client_name || '',
    clientEmail: r.derived_client_email || '',
    lawFirmId: r.law_firm_id,
    lawFirmName: r.derived_law_firm_name || '',
    lastMessageAt: iso(r.last_message_at),
    lastMessagePreview: derivedPreview,
    lastNotificationEmailAt: iso(r.last_notification_email_at),
    unreadCountClient: r.unread_client == null ? 0 : Number(r.unread_client),
    unreadCountFirm: r.unread_firm == null ? 0 : Number(r.unread_firm),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    archivedAt: iso(r.archived_at),
  };
}

function messageEntity(r: any) {
  // Soft delete masks the message on EVERY read path: content is blanked and
  // attachments stripped from the payload, but the row is retained (legal record)
  // and still occupies its slot in the thread. The `deleted` flag drives the
  // client tombstone. Read receipts / ordering are unaffected.
  const deleted = r.deleted_at != null;
  return {
    messageId: r.id,
    senderId: r.sender_user_id,
    senderType: r.sender_type,
    senderName: r.sender_name,
    // True when the firm member sent this message under the firm's identity;
    // the client-facing read paths mask the sender to the firm name/logo.
    sentAsFirm: r.sent_as_firm === true,
    content: deleted ? '' : (r.content || ''),
    attachments: deleted ? [] : (r.attachments || []),
    status: r.status || 'sent',
    read: r.read || false,
    readByClient: r.read_by_client || false,
    readByFirm: r.read_by_firm || false,
    matterId: r.matter_id || null,
    mentions: r.mentions || [],
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    readAt: iso(r.read_at),
    // Marker only (the pre-edit text is intentionally not retained).
    editedAt: iso(r.edited_at),
    deleted,
    deletedAt: iso(r.deleted_at),
    // 'system' rows are inline participant add/remove events; systemEvent carries
    // the structured payload the UI renders (and the read paths filter/mask on).
    kind: r.kind || 'user',
    systemEvent: r.system_event || null,
  };
}

// Join the live users/law_firms rows and the latest message so convEntity renders
// participant names and previews directly.
//
// Both `messages` reads are LATERAL, so each one runs per returned conversation
// and rides `messages (conversation_id, created_at)`. A grouped subquery
// (`select … from messages group by conversation_id`) joined on
// `conversation_id = c.id` reads more naturally, but Postgres cannot push a join
// qualifier through a GROUP BY: it aggregates every row in `messages` — across
// every conversation and every tenant — and then hash-joins the handful it needs.
// Confirmed on a plan as `Nested Loop Left Join … Rows Removed by Join Filter`
// over the full table.
//
// The select list and the join tree are separate constants because the windowed
// firm list re-uses them against a page CTE (`join conversations c on c.id = p.id`)
// rather than against the bare table, so both laterals only run for the rows that
// are actually returned.
//
// The column list is explicit rather than `c.*`. It was written that way to keep
// `last_message_content` (a full copy of the most recent message body) out of
// every list read; migration 0199 dropped that column, so the reason is gone,
// but naming the columns is still the better shape for a query with three
// laterals joined onto it.
/**
 * The conversation's list preview: its newest real message, as the list shows it.
 *
 * Derived, not stored. `conversations.last_message_preview` held this and was
 * written once at send, so an edited or deleted message left the list showing
 * text the thread no longer contained.
 *
 * Its rules:
 *   - system rows (`kind = 'system'`, an inline participant add or remove) are
 *     skipped, so the preview stays on real messages;
 *   - a message with no text but an attachment reads as its first attachment;
 *   - a soft-deleted newest message reads as `Message deleted`, the same
 *     tombstone the thread shows in its place. Its text is never quoted, and an
 *     empty string would read as "No messages yet" on a thread that has them.
 *
 * `visibleFromSql` names the VIEWER's history cutoff column, for a group read
 * joined to that viewer's participant row. A client added with "hide previous
 * chats" must not have the list quote a message the thread itself withholds.
 *
 * A correlated scalar subquery rather than a join, because the search predicates
 * run inside a paging CTE that joins only `conversations` and `users`. It is
 * correlated on `c`, so it works anywhere `conversations` is aliased `c`.
 */
function newestMessagePreview(visibleFromSql: string | null = null) {
  const cutoff = visibleFromSql
    ? `and (${visibleFromSql} is null or m2.created_at >= ${visibleFromSql})`
    : '';
  return `(
  select case
           when m2.deleted_at is not null then 'Message deleted'
           when nullif(btrim(m2.content), '') is not null then left(m2.content, 100)
           when jsonb_array_length(coalesce(m2.attachments, '[]'::jsonb)) > 0
             then '[Attachment: ' || coalesce(m2.attachments->0->>'name', '') || ']'
           else ''
         end
    from messages m2
   where m2.conversation_id = c.id and m2.kind = 'user' ${cutoff}
   order by m2.created_at desc, m2.id desc limit 1)`;
}

const NEWEST_MESSAGE_PREVIEW = newestMessagePreview();

/** The group list's preview, bounded by the viewer's participant row `cp`. */
const VIEWER_NEWEST_MESSAGE_PREVIEW = newestMessagePreview('cp.history_visible_from');

/**
 * What a viewer's unread count may include: a real message (system rows have a
 * null sender and drop out on the `<>`), not their own, not soft-deleted, sent
 * after their read cursor and at or after their history cutoff. `m` is the
 * message and `cp` the viewer's participant row; `$1` is the viewer.
 */
const VIEWER_UNREAD_MESSAGE = `m.sender_user_id <> $1
                and m.deleted_at is null
                and m.created_at > coalesce(cp.last_read_at, '-infinity'::timestamptz)
                and (cp.history_visible_from is null or m.created_at >= cp.history_visible_from)`;

const CONV_FIELDS = `c.id, c.law_firm_id, c.client_id, c.conversation_type,
         c.last_message_at, c.last_notification_email_at,
         c.created_at, c.updated_at, c.archived_at,
         u.name     as derived_client_name,
         u.email    as derived_client_email,
         lf.name    as derived_law_firm_name,
         ${NEWEST_MESSAGE_PREVIEW} as derived_last_message_content,
         coalesce(uc.unread_firm, 0)   as unread_firm,
         coalesce(uc.unread_client, 0) as unread_client`;

const CONV_JOINS = `left join users u      on u.id = c.client_id
    left join law_firms lf on lf.id = c.law_firm_id
    left join lateral (
      select count(*) filter (where um.sender_type = 'client' and um.read_by_firm = false)        as unread_firm,
             count(*) filter (where um.sender_type = 'firm_member' and um.read_by_client = false) as unread_client
        from messages um
       where um.conversation_id = c.id and um.deleted_at is null
    ) uc on true`;

const CONV_SELECT = `
  select ${CONV_FIELDS}
    from conversations c
    ${CONV_JOINS}`;

// Conversation lists are always newest-activity-first. The id tiebreaker makes the
// ordering total, so growing a window never repeats or skips a conversation whose
// `last_message_at` ties another's. Both the direct and the group list alias the
// conversations table as `c`, so the same clause serves both.
const CONV_ORDER = buildOrderBy({
  columns: { lastMessageAt: 'c.last_message_at' },
  fallback: { field: 'lastMessageAt', dir: 'desc' },
  tiebreaker: 'c.id asc',
});

export async function getUser(userId: string) {
  const { rows } = await authorizedMessagingSql(`select id, name, user_type, email from users where id = $1 limit 1`, [userId]);
  if (!rows[0]) throw new NotFoundError('User');
  return { name: rows[0].name, userType: rows[0].user_type, email: rows[0].email };
}

/**
 * Display names for a set of users, as a Map keyed by id. One query in place of
 * a `getUser` per id, for callers that label a batch (adding participants).
 * Missing ids are simply absent from the map.
 */
export async function getUserNames(userIds: string[]) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const { rows } = await authorizedMessagingSql(`select id, name from users where id = any($1)`, [ids]);
  return new Map(rows.map((r: any) => [r.id, r.name || '']));
}

export async function getLawFirmName(lawFirmId: string) {
  const { rows } = await authorizedMessagingSql(`select name from law_firms where id = $1 limit 1`, [lawFirmId]);
  return rows[0]?.name || '';
}

/** Firm display name + logo object path, for "send as firm" masking. */
export async function getFirmNameAndLogo(lawFirmId: string) {
  const { rows } = await authorizedMessagingSql(`select name, logo_object_path from law_firms where id = $1 limit 1`, [lawFirmId]
  );
  return { name: rows[0]?.name || '', logoObjectPath: rows[0]?.logo_object_path || null };
}

/** Whether a firm member has opted to appear to clients as the firm. */
export async function getMemberPresentAsFirm(lawFirmId: string, userId: string) {
  const { rows } = await authorizedMessagingSql(`select present_as_firm from members where law_firm_id = $1 and user_id = $2 limit 1`,
    [lawFirmId, userId]
  );
  return rows[0]?.present_as_firm === true;
}

/** Set a member's "present as firm to clients" preference. */
export async function setMemberPresentAsFirm(lawFirmId: string, userId: string, value: any) {
  await authorizedMessagingSql(`update members set present_as_firm = $3, updated_at = now()
      where law_firm_id = $1 and user_id = $2`,
    [lawFirmId, userId, !!value]
  );
  return !!value;
}

/** A client is associated with the firm if a clients row links them. */
export async function verifyClientAccess(lawFirmId: string, clientId: string) {
  const { rows } = await authorizedMessagingSql(`select 1 from clients where law_firm_id = $1 and user_id = $2 limit 1`,
    [lawFirmId, clientId]
  );
  if (rows[0]) return true;
  throw new ForbiddenError('Client is not associated with this law firm');
}

/**
 * A COMPANY client belongs to this firm (organization-clients plan Phase 7).
 * Used by the firm-facing canonical company-conversation route to 404 cleanly
 * on a non-company or cross-firm clientId before calling into
 * findOrCreateCanonicalCompanyConversation, whose own client_type check only
 * runs on the create branch (see its doc comment) and would otherwise let a
 * bad id fall through silently when a conversation already exists.
 */
export async function assertCompanyClientInFirm(lawFirmId: string, clientId: string) {
  if (!isUuid(clientId)) throw new NotFoundError('Client');
  const { rows } = await authorizedMessagingSql(
    `select 1 from clients where law_firm_id = $1 and id = $2 and client_type = 'company' limit 1`,
    [lawFirmId, clientId]
  );
  if (!rows[0]) throw new NotFoundError('Client');
}

/** A matter belongs to the firm when a matters row scopes it to law_firm_id. */
export async function assertMatterInFirm(lawFirmId: string, matterId: string) {
  if (!isUuid(matterId)) return true;
  const { rows } = await authorizedMessagingSql(`select 1 from matters where law_firm_id = $1 and id = $2 limit 1`,
    [lawFirmId, matterId]
  );
  if (rows[0]) return true;
  throw new ForbiddenError('Matter is not associated with this law firm');
}

/**
 * `verifyClientAccess` for a whole set, in one query.
 *
 * The callers were validating an entire participant list one client at a time,
 * which is a round trip per person to answer a question the database can answer
 * for all of them at once. The failure is identical — the first id that does not
 * belong to the firm throws the same ForbiddenError — so the caller sees no
 * difference beyond the latency.
 */
/**
 * Every participant uid a group can carry now resolves through the plain
 * `clients.user_id` lookup: a company-linked person is a real standalone
 * `clients` row, not a separate roster identity arm, so there is only one
 * table to check. Group composition (ad-hoc groups and the participants
 * endpoint) is the one place that ever verifies a whole batch at once; a
 * direct 1:1 thread stays person-only and never calls this.
 */
export async function verifyClientAccessMany(lawFirmId: string, clientIds: string[]) {
  const ids = [...new Set((clientIds || []).filter(Boolean))];
  if (!ids.length) return true;
  const { rows } = await authorizedMessagingSql(
    `select user_id from clients where law_firm_id = $1 and user_id = any($2::text[])`,
    [lawFirmId, ids]
  );
  const found = new Set(rows.map((r: any) => r.user_id));
  if (ids.every((id) => found.has(id))) return true;
  throw new ForbiddenError('Client is not associated with this law firm');
}

/**
 * Return every person client linked to a company, including people who do not
 * have a portal account yet. The record id is retained so messaging can create
 * a pending recipient that becomes active when the person signs up.
 */
export async function getCompanyRosterClientRecords(lawFirmId: string, clientId: string) {
  if (!isUuid(clientId)) return [];
  const { rows } = await authorizedMessagingSql(
    `select p.id, p.user_id, p.client_type
       from client_company_links l
       join clients p on p.id = l.person_client_id and p.law_firm_id = l.law_firm_id
      where l.law_firm_id = $1 and l.company_client_id = $2`,
    [lawFirmId, clientId]
  );
  return rows;
}

/** Resolve client record ids and reject records outside the current firm. */
export async function resolveMessagingClientRecords(lawFirmId: string, clientRecordIds: any[]) {
  const ids = [...new Set((clientRecordIds || []).filter(isUuid))];
  if (!ids.length) return [];
  const { rows } = await authorizedMessagingSql(
    `select id, user_id, client_type
       from clients
      where law_firm_id = $1 and id = any($2::uuid[])`,
    [lawFirmId, ids]
  );
  if (rows.length !== ids.length) throw new ForbiddenError('One or more clients are not associated with this law firm');
  if (rows.some((row: any) => row.client_type !== 'person')) {
    throw new ForbiddenError('Only person clients can be added as message recipients');
  }
  return rows;
}

/** `assertMatterInFirm` for a whole set, in one query. See above. */
export async function assertMattersInFirm(lawFirmId: string, matterIds: string[]) {
  // Non-uuid ids are ignored rather than rejected, matching the single-id
  // version, which returns true for anything that is not a uuid.
  const ids = [...new Set((matterIds || []).filter((id: any) => isUuid(id)))];
  if (!ids.length) return true;
  const { rows } = await authorizedMessagingSql(`select id from matters where law_firm_id = $1 and id = any($2::uuid[])`,
    [lawFirmId, ids]
  );
  const found = new Set(rows.map((r: any) => r.id));
  if (ids.every((id) => found.has(id))) return true;
  throw new ForbiddenError('Matter is not associated with this law firm');
}

async function loadConversationRow(conversationId: string) {
  if (!isUuid(conversationId)) return null;
  const { rows } = await authorizedMessagingSql(`${CONV_SELECT} where c.id = $1 limit 1`,
    [conversationId]
  );
  return rows[0] || null;
}

// Cheap authorization lookup: just the columns needed to decide access
// (client_id / law_firm_id). Avoids running the heavy CONV_SELECT (unread-count
// aggregate + last-message lateral) for the auth step. Callers that also need
// the full conversation load it once via getConversation/loadConversationRow.
export async function loadConversationAuthRow(conversationId: string) {
  if (!isUuid(conversationId)) return null;
  const { rows } = await authorizedMessagingSql(`select client_id, law_firm_id, conversation_type from conversations where id = $1 limit 1`,
    [conversationId]
  );
  return rows[0] || null;
}

// Authorize access without materializing the full conversation entity. Same
// decision and errors as before: client owner OR firm member; NotFound for a
// missing/invalid conversation id, Forbidden otherwise.
export async function verifyConversationAccess(conversationId: string, userId: string, userType: any, expectedLawFirmId = null) {
  const row = await loadConversationAuthRow(conversationId);
  if (!row) throw new NotFoundError('Conversation');
  // When reached through a firm-scoped route, the conversation MUST belong to the
  // path :lawFirmId. requirePermission('messaging.view') is evaluated against that
  // path firm, so without this a user who is a member of two firms with different
  // roles could read/mark-read a conversation in firm B (where they lack
  // messaging.view) by routing the request through firm A (where they have it).
  if (expectedLawFirmId && row.law_firm_id !== expectedLawFirmId) {
    throw new ForbiddenError('Conversation does not belong to this law firm');
  }
  // Group threads are participant-gated for EVERYONE (firm members included):
  // a non-participant member must not read a multi-client group via the direct
  // route just because they belong to the firm. The backend bypasses RLS, so
  // this app-layer check is the real boundary.
  if (row.conversation_type === 'group') {
    if (await isActiveParticipant(conversationId, userId)) return true;
    throw new ForbiddenError('Access denied to conversation');
  }
  if (userType === 'client' && row.client_id === userId) return true;
  if (userType === 'firm_member' || !userType) {
    try {
      await assertLawFirmMembership(row.law_firm_id, userId);
      return true;
    } catch { /* fall through */ }
  }
  throw new ForbiddenError('Access denied to conversation');
}

export async function getConversation(conversationId: string) {
  const row = await loadConversationRow(conversationId);
  if (!row) throw new NotFoundError('Conversation');
  return convEntity(row);
}

/**
 * Direct conversations in a firm, newest activity first, with the total number of
 * matches alongside the returned window.
 *
 * Every option is additive and optional. With no `limit` the read returns every
 * matching direct conversation, which is the contract the firm-wide callers rely on
 * (a client's or a matter's messages tab pick one thread out of the whole set).
 * `search` matches the fields the list row renders; `archived` selects one side of
 * the firm's archive split, and omitting it returns both. `totalItems` counts every
 * match regardless of the window, so a partial list still carries a real total.
 */
export async function getConversationsByLawFirm(
  lawFirmId: string,
  { limit = null, offset, page, search, archived, clientId, clientIds }: any = {},
) {
  const params: unknown[] = [lawFirmId];
  const where = ['c.law_firm_id = $1', `c.conversation_type = 'direct'`];

  if (archived === true) where.push('c.archived_at is not null');
  else if (archived === false) where.push('c.archived_at is null');
  const scopedClientIds = [...new Set([
    ...(clientId ? [clientId] : []),
    ...(Array.isArray(clientIds) ? clientIds : []),
  ].filter(Boolean))].slice(0, 200);
  if (scopedClientIds.length > 0) {
    params.push(scopedClientIds);
    where.push(`c.client_id = any($${params.length}::text[])`);
  }

  const term = toIlikeTerm(search);
  if (term) {
    params.push(term);
    const t = `$${params.length}`;
    // The name and email predicates fall back to the linked portal user exactly as
    // convEntity does, so a row whose denormalized snapshot is null still matches on
    // the value the list actually displays. Both columns are citext, which has no
    // ilike operator of its own, hence the casts.
    where.push(`(u.name ilike ${t} escape '\\'
                 or u.email::text ilike ${t} escape '\\'
                 or c.title ilike ${t} escape '\\'
                 or ${NEWEST_MESSAGE_PREVIEW} ilike ${t} escape '\\')`);
  }
  const whereSql = where.join(' and ');
  // Snapshot the filter params before the paging params are appended, so the
  // out-of-range count below reuses `whereSql` with identical $N numbering.
  const filterParams = params.slice();
  // `max` matches the ceiling the list endpoint's schema accepts, so a request at
  // that ceiling is served in full rather than silently truncated.
  const { pageClause, pageOffset } = buildPageClause({
    limit, offset, page, params, max: 200, optional: true,
  });

  const { rows } = await authorizedMessagingSql(`with page as (
       select c.id, count(*) over() as total_count
         from conversations c
         left join users u on u.id = c.client_id
        where ${whereSql}
        order by ${CONV_ORDER}${pageClause}
     )
     select ${CONV_FIELDS}, p.total_count
       from page p
       join conversations c on c.id = p.id
       ${CONV_JOINS}
      order by ${CONV_ORDER}`,
    params
  );

  // The `users` join is repeated in the fallback count because the search predicate
  // reaches into the linked portal user.
  const totalItems = await resolveWindowTotal({
    rows,
    pageOffset,
    countSql: `select count(*)::int as total
                 from conversations c
                 left join users u on u.id = c.client_id
                where ${whereSql}`,
    filterParams,
  });

  return { conversations: rows.map(convEntity), totalItems };
}

export async function getConversationsByClient(clientId: string) {
  const { rows } = await authorizedMessagingSql(`${CONV_SELECT} where c.client_id = $1 and c.conversation_type = 'direct' order by ${CONV_ORDER}`,
    [clientId]
  );
  return rows.map(convEntity);
}

/**
 * True, for a conversation aliased `c`, when it is a company's canonical thread
 * and ANOTHER non-archived thread already holds that company's canonical slot.
 * That happens once an archived canonical thread has been replaced (opening the
 * company's Messages tab finds no live thread and creates a new one), and it is
 * exactly when un-archiving `c` would violate
 * `conversations_client_record_active_idx`.
 */
const CANONICAL_SLOT_TAKEN = `(c.client_record_id is not null and exists (
  select 1 from conversations live
   where live.law_firm_id = c.law_firm_id
     and live.client_record_id = c.client_record_id
     and live.archived_at is null
     and live.id <> c.id))`;

// Firm-side archive toggle. Sets/clears archived_at (+ who set it) for a
// conversation in this firm. Works for direct and group threads alike (both are
// conversations rows). Returns the updated row id, or null if it isn't in this firm.
// Restoring a company thread whose canonical slot a newer thread holds is a
// ConflictError: two live canonical threads for one company is what the unique
// index exists to prevent.
export async function setConversationArchived(conversationId: string, lawFirmId: string, archived: any, userId: string) {
  if (!isUuid(conversationId)) return null;
  const { rows } = await authorizedMessagingSql(`update conversations c
        set archived_at = case when $3 then now() else null end,
            archived_by = case when $3 then $4 else null end,
            updated_at = now()
      where c.id = $1 and c.law_firm_id = $2
        and ($3 or not ${CANONICAL_SLOT_TAKEN})
      returning c.id`,
    [conversationId, lawFirmId, !!archived, userId]
  );
  if (rows[0]) return rows[0].id;
  if (!archived) {
    const { rows: existing } = await authorizedMessagingSql(
      `select 1 from conversations where id = $1 and law_firm_id = $2 limit 1`,
      [conversationId, lawFirmId]
    );
    if (existing[0]) {
      throw new ConflictError(
        'This organization already has an active conversation. Archive that one before restoring this one.'
      );
    }
  }
  return null;
}

/**
 * Send a message atomically: upsert the conversation, insert the message, bump
 * last-message metadata. Returns send metadata (incl. whether the conversation
 * was newly created and the client/firm snapshot for notifications).
 */
export async function sendMessage(lawFirmId: string, { senderId, senderType, senderName, sentAsFirm = false, clientId, clientData, content, attachments, matterId, mentions = [] }: any) {

  return withDrizzleTransaction(async (client: any) => {
    const existing = await transactionalMessagingSql(client, `select * from conversations where law_firm_id = $1 and client_id = $2 limit 1 for update`,
      [lawFirmId, clientId]
    );

    let convId;
    let isNew = false;
    let snapshot;
    if (existing.rows[0]) {
      convId = existing.rows[0].id;
      snapshot = {
        clientEmail: clientData.email || '',
        clientName: clientData.name || '',
        lawFirmName: await getLawFirmName(lawFirmId),
        lastNotificationEmailAt: existing.rows[0].last_notification_email_at,
      };
      await transactionalMessagingSql(client, `update conversations set last_message_at = now(),
            last_sender_user_id = $2, updated_at = now(),
            archived_at = null, archived_by = null
          where id = $1`,
        [convId, senderId]
      );
    } else {
      isNew = true;
      const lawFirmName = await getLawFirmName(lawFirmId);
      const ins = await transactionalMessagingSql(client, `insert into conversations
           (law_firm_id, client_id, last_message_at, last_sender_user_id)
         values ($1,$2, now(), $3) returning id`,
        [lawFirmId, clientId, senderId]
      );
      convId = ins.rows[0].id;
      snapshot = { clientEmail: clientData.email || '', clientName: clientData.name || '', lawFirmName, lastNotificationEmailAt: null };
    }

    const msg = await transactionalMessagingSql(client, `insert into messages
         (conversation_id, law_firm_id, sender_user_id, sender_type, sender_name, sent_as_firm,
          content, attachments, mentions, status, read, read_by_client, read_by_firm, matter_id, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'sent',false,$10,$11,$12, now()) returning id`,
      [
        convId, lawFirmId, senderId, senderType, senderName,
        senderType === 'firm_member' && sentAsFirm === true,
        content.trim(), JSON.stringify(stripAttachmentUrls(attachments) || []),
        JSON.stringify(Array.isArray(mentions) ? mentions : []),
        senderType === 'client', senderType === 'firm_member',
        isUuid(matterId) ? matterId : null,
      ]
    );

    return { conversationId: convId, messageId: msg.rows[0].id, isNew, ...snapshot };
  });
}

/**
 * Firm-side recipients to notify in-app about a new message in a conversation:
 * the firm members who have already participated (sent a message) in it. For a
 * brand-new conversation with no firm participant yet, falls back to all firm
 * members so an inbound client message isn't missed. The sender is excluded.
 */
export async function getFirmRecipientsForMessage(lawFirmId: string, conversationId: string, excludeUserId: any) {
  if (!isUuid(conversationId)) return [];
  // Joined to `members`, so someone who has since left the firm stops being
  // notified about a thread they once posted in.
  const { rows: prior } = await authorizedMessagingSql(`select distinct m.sender_user_id from messages m
       join members mem on mem.user_id = m.sender_user_id and mem.law_firm_id = $2
      where m.conversation_id = $1 and m.sender_type = 'firm_member' and m.sender_user_id is not null`,
    [conversationId, lawFirmId]
  );
  let ids = prior.map((r: any) => r.sender_user_id);
  if (!ids.length) {
    const { rows } = await authorizedMessagingSql('select user_id from members where law_firm_id = $1', [lawFirmId]);
    ids = rows.map((r: any) => r.user_id);
  }
  return ids.filter((id: any) => id && id !== excludeUserId);
}

/**
 * `getFirmRecipientsForMessage` for a GROUP thread: the firm members actually on
 * it, minus the sender.
 *
 * A group's roster is explicit, so unlike the direct version this never falls
 * back to the whole firm. Joined to `members` so someone who has since left the
 * firm, but whose participant row is still there, stops being notified.
 */
export async function getGroupFirmRecipients(conversationId: string, excludeUserId: any) {
  if (!isUuid(conversationId)) return [];
  const { rows } = await authorizedMessagingSql(`select cp.participant_user_id from conversation_participants cp
       join members mem on mem.user_id = cp.participant_user_id and mem.law_firm_id = cp.law_firm_id
      where cp.conversation_id = $1 and cp.removed_at is null
        and cp.participant_type = 'firm_member' and cp.participant_user_id <> $2`,
    [conversationId, excludeUserId]
  );
  return rows.map((r: any) => r.participant_user_id).filter(Boolean);
}

/**
 * The client participants of a group thread who can be emailed about it: portal
 * uid, name and address, minus the sender.
 *
 * Used by the "you have a new message" email a group thread never sent. Rows
 * without an address are dropped here rather than downstream, so the caller's
 * "is there anyone to tell" test is the same as its "who do I write to" list.
 */
export async function getGroupClientRecipients(lawFirmId: string, conversationId: string, excludeUserId: any) {
  if (!isUuid(conversationId)) return [];
  // DISTINCT ON the uid, not the whole row: `clients.user_id` carries no unique
  // constraint, so one person can hold more than one client row in a firm, and a
  // plain DISTINCT would mail them once per row.
  const { rows } = await authorizedMessagingSql(`select distinct on (cp.participant_user_id)
            cp.participant_user_id, c.name, c.email
       from conversation_participants cp
       join clients c on c.user_id = cp.participant_user_id and c.law_firm_id = $2
      where cp.conversation_id = $1 and cp.removed_at is null
        and cp.participant_type = 'client' and cp.participant_user_id <> $3
        and c.email is not null
      order by cp.participant_user_id, c.created_at`,
    [conversationId, lawFirmId, excludeUserId]
  );
  return rows
    .map((r: any) => ({ userId: r.participant_user_id, name: r.name || '', email: (r.email || '').trim() }))
    .filter((r: any) => r.email);
}

/**
 * Claim the notification-email cooldown slot for a conversation in ONE update:
 * the stamp only moves when it is unset or older than `cooldownMs`, and the
 * caller sends only if a row came back. Concurrent sends therefore cannot both
 * pass a read-then-write and double-mail the thread.
 */
export async function claimNotificationEmailSlot(conversationId: string, cooldownMs: any) {
  if (!isUuid(conversationId)) return false;
  const { rowCount } = await authorizedMessagingSql(`update conversations
        set last_notification_email_at = now()
      where id = $1
        and (last_notification_email_at is null
             or last_notification_email_at < now() - ($2::bigint * interval '1 millisecond'))`,
    [conversationId, Math.max(0, Math.trunc(Number(cooldownMs) || 0))]
  );
  return (rowCount || 0) > 0;
}

/** Subset of the given userIds that are members of this firm (for @mention validation). */
export async function filterFirmMemberIds(lawFirmId: string, userIds: string[]) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const { rows } = await authorizedMessagingSql(`select user_id from members where law_firm_id = $1 and user_id = any($2)`,
    [lawFirmId, ids]
  );
  return rows.map((r: any) => r.user_id);
}

export async function getMessages(conversationId: string, { limit, lastMessageId, visibleFrom = null, clientVisibleOnly = false }: any) {
  if (!isUuid(conversationId)) throw new NotFoundError('Conversation');
  // `limit` (int 1–100) and `lastMessageId` (uuid) are guaranteed by
  // getConversationSchema on the validated route; the only other caller (the
  // client portal) passes a numeric literal and no cursor. Trust the contract.
  const limitNum = limit || 25;
  // `visibleFrom` (a group participant's history cutoff) bounds the page at the
  // DB level so pre-join messages are excluded and `hasMore` stays accurate.
  // null = no bound (firm members and full-history clients).
  //
  // `clientVisibleOnly` drops the participant-change events a client viewer may
  // not see (a firm member joining or leaving is internal). It belongs in SQL
  // for the same reason `visibleFrom` does: filtering the page in JS afterwards
  // returned short pages, and a page made entirely of hidden events returned
  // nothing at all with `hasMore` still true - which left the caller no cursor
  // to page past it, so the rest of the client's history became unreachable.
  const visibilitySql = clientVisibleOnly
    ? `and (kind <> 'system' or system_event->>'subjectType' = 'client')`
    : '';

  // The cursor is a (created_at, id) keyset, compared against the cursor row in
  // SQL. `created_at < cursor` alone dropped every other message sharing the
  // cursor's timestamp, and reading the timestamp into a JS Date would lose its
  // microseconds; the row-value comparison against the stored row has neither
  // problem. The caller still sends only `lastMessageId`.
  let rows;
  if (lastMessageId) {
    const cursor = await authorizedMessagingSql(`select 1 from messages where id = $1 and conversation_id = $2 limit 1`, [lastMessageId, conversationId]);
    if (!cursor.rows[0]) throw new NotFoundError('Last message');
    ({ rows } = await authorizedMessagingSql(`select * from messages where conversation_id = $1
         and (created_at, id) < (select k.created_at, k.id from messages k where k.id = $2)
         and ($4::timestamptz is null or created_at >= $4)
         ${visibilitySql}
        order by created_at desc, id desc limit $3`,
      [conversationId, lastMessageId, limitNum, visibleFrom]
    ));
  } else {
    ({ rows } = await authorizedMessagingSql(`select * from messages where conversation_id = $1
         and ($3::timestamptz is null or created_at >= $3)
         ${visibilitySql}
        order by created_at desc, id desc limit $2`,
      [conversationId, limitNum, visibleFrom]
    ));
  }

  const messages = rows.map(messageEntity).reverse(); // oldest first
  return { messages, hasMore: rows.length === limitNum };
}

/** Mark the given messages read for the acting user; returns count newly marked. */
export async function markRead(conversationId: string, userType: any, messageIds: any) {
  if (!isUuid(conversationId) || !messageIds?.length) return 0;
  const ids = messageIds.filter(isUuid);
  if (!ids.length) return 0;
  const col = userType === 'client' ? 'read_by_client' : 'read_by_firm';
  // Only mark messages the acting side is the recipient of (i.e. sent by the other side);
  // for those, the acting user is the recipient, so read is now true.
  const senderSide = userType === 'client' ? 'firm_member' : 'client';
  const { rowCount } = await authorizedMessagingSql(`update messages set ${col} = true, read = true, read_at = now(), updated_at = now()
      where conversation_id = $1 and id = any($2) and sender_type = $3 and ${col} = false`,
    [conversationId, ids, senderSide]
  );
  return rowCount;
}

export async function getFirmUnreadCount(lawFirmId: string) {
  // Direct threads only — group unread is tracked per-participant and added
  // separately in the service. Group messages must not be counted here.
  const { rows } = await authorizedMessagingSql(`select count(*)::int c from messages m join conversations c on c.id = m.conversation_id
      where c.law_firm_id = $1 and c.conversation_type = 'direct' and c.archived_at is null
        and m.sender_type = 'client' and m.read_by_firm = false and m.deleted_at is null`,
    [lawFirmId]
  );
  return rows[0].c;
}

export async function getClientUnreadCount(userId: string) {
  const { rows } = await authorizedMessagingSql(`select count(*)::int c from messages m join conversations c on c.id = m.conversation_id
      where c.client_id = $1 and c.conversation_type = 'direct'
        and m.sender_type = 'firm_member' and m.read_by_client = false and m.deleted_at is null`,
    [userId]
  );
  return rows[0].c;
}

// ── Group conversations (Option B) ──────────────────────────────────────
// Additive: direct (1:1) conversations above are untouched. Group threads set
// client_id = NULL and carry membership in conversation_participants, with a
// per-participant last_read_at cursor driving unread.

/** Create a group conversation with its initial participants + matter scope (one txn). */
export async function createGroupConversation(lawFirmId: string, { title, matterIds = [], createdBy, participants, pendingClientIds = [] }: any) {
  const matters = [...new Set((matterIds || []).filter(isUuid))];
  // Primary matter (first of the set) mirrors into conversations.matter_id so
  // message-event routing keeps working off a single column.
  const primaryMatter = matters[0] || null;
  return withDrizzleTransaction(async (client: any) => {
    const conv = await transactionalMessagingSql(client, `insert into conversations (law_firm_id, conversation_type, title, matter_id, created_by,
                                  last_message_at)
       values ($1,'group',$2,$3,$4, now())
       returning id`,
      [lawFirmId, title || null, primaryMatter, createdBy]
    );
    const convId = conv.rows[0].id;
    for (const p of participants) {
      await transactionalMessagingSql(client, `insert into conversation_participants
           (conversation_id, law_firm_id, participant_user_id, participant_type, added_by, last_read_at)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (conversation_id, participant_user_id) do nothing`,
        [convId, lawFirmId, p.userId, p.type, createdBy, p.userId === createdBy ? new Date() : null]
      );
    }
    for (const clientId of [...new Set(pendingClientIds.filter(isUuid))]) {
      await transactionalMessagingSql(client, `insert into conversation_participants
           (conversation_id, law_firm_id, client_id, participant_type, added_by)
         values ($1,$2,$3,'client',$4)
         on conflict (conversation_id, client_id) do nothing`,
        [convId, lawFirmId, clientId, createdBy]
      );
    }
    for (const [position, mid] of matters.entries()) {
      await transactionalMessagingSql(client, `insert into conversation_matters (conversation_id, law_firm_id, matter_id, position)
         values ($1,$2,$3,$4) on conflict do nothing`,
        [convId, lawFirmId, mid, position]
      );
    }
    return convId;
  });
}

/**
 * Promote pending message recipients after a client record receives a portal
 * user id. This is intentionally idempotent because account linking can be
 * retried during registration or login.
 */
export async function reconcilePendingClientRecipients(lawFirmId: string, clientId: string, userId: string) {
  if (!lawFirmId || !isUuid(clientId) || !userId) return [];
  const { rows } = await authorizedMessagingSql(
    `select id, conversation_id, added_by, history_visible_from
       from conversation_participants
      where law_firm_id = $1 and client_id = $2 and participant_user_id is null and removed_at is null`,
    [lawFirmId, clientId]
  );
  if (!rows.length) return [];

  await withDrizzleTransaction(async (client: any) => {
    for (const row of rows) {
      const { rows: existing } = await transactionalMessagingSql(client,
        `select id from conversation_participants
          where conversation_id = $1 and participant_user_id = $2`,
        [row.conversation_id, userId]
      );
      if (existing.length > 0) {
        await transactionalMessagingSql(client,
          `update conversation_participants set removed_at = null, client_id = coalesce(client_id, $2) where id = $1`,
          [existing[0].id, clientId]
        );
        await transactionalMessagingSql(client,
          `delete from conversation_participants where id = $1`,
          [row.id]
        );
      } else {
        await transactionalMessagingSql(client,
          `update conversation_participants
              set participant_user_id = $2,
                  last_read_at = coalesce(last_read_at, now())
            where id = $1`,
          [row.id, userId]
        );
      }
    }
  });
  return rows.map((row: any) => row.conversation_id);
}

/** Promote every pending recipient belonging to a newly-linked portal user. */
export async function reconcilePendingClientRecipientsForUser(userId: string) {
  if (!userId) return 0;
  const { rows } = await authorizedMessagingSql(
    `select p.id, p.conversation_id, p.law_firm_id, p.client_id, p.added_by, p.history_visible_from
       from conversation_participants p
       join clients c on c.id = p.client_id and c.law_firm_id = p.law_firm_id
      where c.user_id = $1 and p.participant_user_id is null and p.removed_at is null`,
    [userId]
  );
  if (!rows.length) return 0;
  await withDrizzleTransaction(async (client: any) => {
    for (const row of rows) {
      const { rows: existing } = await transactionalMessagingSql(client,
        `select id from conversation_participants
          where conversation_id = $1 and participant_user_id = $2`,
        [row.conversation_id, userId]
      );
      if (existing.length > 0) {
        await transactionalMessagingSql(client,
          `update conversation_participants set removed_at = null, client_id = coalesce(client_id, $2) where id = $1`,
          [existing[0].id, row.client_id]
        );
        await transactionalMessagingSql(client,
          `delete from conversation_participants where id = $1`,
          [row.id]
        );
      } else {
        await transactionalMessagingSql(client,
          `update conversation_participants
              set participant_user_id = $2,
                  last_read_at = coalesce(last_read_at, now())
            where id = $1`,
          [row.id, userId]
        );
      }
    }
  });
  return rows.length;
}

/**
 * The matters a group conversation is scoped to, with their name and number so
 * the thread header can display them without a separate (permissioned) matters
 * fetch. Ordered by saved position, matching getConversationMatterIds.
 * A matter deleted after being linked is skipped (inner join).
 */
export async function getConversationMatters(conversationId: string) {
  if (!isUuid(conversationId)) return [];
  const { rows } = await authorizedMessagingSql(`select m.id, m.name, m.matter_number
       from conversation_matters cm
       join matters m on m.id = cm.matter_id
      where cm.conversation_id = $1
      order by cm.position, cm.matter_id`,
    [conversationId]
  );
  return rows.map((r: any) => ({ id: r.id, name: r.name || '', matterNumber: r.matter_number || null }));
}

/**
 * Replace a group conversation's matter scope with the given set (one txn), and
 * keep the primary conversations.matter_id column in sync (first of the set).
 * Returns the saved matter ids. Callers validate firm ownership of each id first.
 */
export async function setConversationMatters(conversationId: string, lawFirmId: string, matterIds: string[]) {
  const matters = [...new Set((matterIds || []).filter(isUuid))];
  return withDrizzleTransaction(async (client: any) => {
    await transactionalMessagingSql(client, `delete from conversation_matters where conversation_id = $1`, [conversationId]);
    for (const [position, mid] of matters.entries()) {
      await transactionalMessagingSql(client, `insert into conversation_matters (conversation_id, law_firm_id, matter_id, position)
         values ($1,$2,$3,$4) on conflict do nothing`,
        [conversationId, lawFirmId, mid, position]
      );
    }
    await transactionalMessagingSql(client, `update conversations set matter_id = $2, updated_at = now() where id = $1`,
      [conversationId, matters[0] || null]
    );
    return matters;
  });
}

/** Active participants of a group, enriched with name/email/type. */
/** Set a group conversation's per-conversation client-name masking flag. */
export async function setConversationHideClientNames(conversationId: string, hide: any) {
  if (!isUuid(conversationId)) throw new NotFoundError('Conversation');
  await authorizedMessagingSql(`update conversations set hide_client_names = $2, updated_at = now() where id = $1`,
    [conversationId, !!hide]
  );
  return !!hide;
}

export async function getParticipants(conversationId: string) {
  if (!isUuid(conversationId)) return [];
  const { rows } = await authorizedMessagingSql(`select cp.participant_user_id, cp.participant_type, cp.last_read_at, cp.history_visible_from,
            u.name, u.email, u.photo_object_path
       from conversation_participants cp
       left join users u on u.id = cp.participant_user_id
      where cp.conversation_id = $1 and cp.removed_at is null and cp.participant_user_id is not null
      order by cp.participant_type, u.name`,
    [conversationId]
  );
  return rows.map((r: any) => ({
    userId: r.participant_user_id, type: r.participant_type,
    name: r.name || '', email: r.email || '', photoObjectPath: r.photo_object_path || null,
    lastReadAt: iso(r.last_read_at),
    // null = full history visible; else only messages at/after this join point.
    historyVisibleFrom: iso(r.history_visible_from),
  }));
}

/**
 * Ids of people who were on this conversation and were removed from it. The add-
 * people picker marks them, so whoever adds them back can see they are returning
 * and decide about the history deliberately.
 */
export async function getRemovedParticipantIds(conversationId: string) {
  if (!isUuid(conversationId)) return [];
  const { rows } = await authorizedMessagingSql(`select participant_user_id from conversation_participants
      where conversation_id = $1 and removed_at is not null`,
    [conversationId]
  );
  return rows.map((r: any) => r.participant_user_id);
}

/**
 * The same people as `getRemovedParticipantIds`, keyed by their `clients.id`
 * instead of their portal uid. The client picker selects on the client record,
 * so this is the key it can match a returning person against.
 */
export async function getRemovedParticipantClientIds(lawFirmId: string, conversationId: string) {
  if (!isUuid(conversationId)) return [];
  const { rows } = await authorizedMessagingSql(`select c.id from clients c
       join conversation_participants cp on cp.participant_user_id = c.user_id
      where cp.conversation_id = $1 and cp.removed_at is not null and c.law_firm_id = $2`,
    [conversationId, lawFirmId]
  );
  return rows.map((r: any) => r.id);
}

/**
 * Whether any saved message in the firm names this object as an attachment,
 * soft-deleted messages included.
 *
 * Firm-wide rather than one conversation, because it gates a DELETE of the
 * object: a check that missed a message because it looked in the wrong thread
 * would destroy what the other side was sent. `messages_firm_idx` bounds it
 * to the firm's own rows.
 */
export async function isAttachmentObjectReferenced(lawFirmId: string, objectPath: string) {
  if (!isUuid(lawFirmId) || !objectPath) return true;
  const { rows } = await authorizedMessagingSql(`select 1 from messages
      where law_firm_id = $1 and attachments @> $2::jsonb limit 1`,
    [lawFirmId, JSON.stringify([{ objectPath: String(objectPath) }])]
  );
  return !!rows[0];
}

/**
 * Whether a live message OTHER than `messageId` names this object as an
 * attachment. Gates deleting the object when `messageId` is deleted.
 *
 * Soft-deleted messages do not count: every read strips their attachments, so
 * an object only they name is reachable by nobody. Firm-wide for the same
 * reason as `isAttachmentObjectReferenced`. Answers true when the arguments
 * cannot be checked, so a doubtful case keeps the object.
 */
export async function isAttachmentObjectReferencedElsewhere(
  lawFirmId: string,
  objectPath: string,
  messageId: string,
) {
  if (!isUuid(lawFirmId) || !isUuid(messageId) || !objectPath) return true;
  const { rows } = await authorizedMessagingSql(`select 1 from messages
      where law_firm_id = $1 and id <> $3 and deleted_at is null and attachments @> $2::jsonb limit 1`,
    [lawFirmId, JSON.stringify([{ objectPath: String(objectPath) }]), messageId]
  );
  return !!rows[0];
}

export async function isActiveParticipant(conversationId: string, userId: string) {
  if (!isUuid(conversationId)) return false;
  const { rows } = await authorizedMessagingSql(`select 1 from conversation_participants
      where conversation_id = $1 and participant_user_id = $2 and removed_at is null limit 1`,
    [conversationId, userId]
  );
  return !!rows[0];
}

export async function loadGroupConversationRow(conversationId: string) {
  if (!isUuid(conversationId)) return null;
  const { rows } = await authorizedMessagingSql(`select * from conversations where id = $1 and conversation_type = 'group' limit 1`,
    [conversationId]
  );
  return rows[0] || null;
}

export async function addParticipants(conversationId: string, lawFirmId: string, addedBy: any, participants: any, { hideHistoryForClients = false, shareHistoryExplicit = false }: any = {}) {
  const clientCutoff = hideHistoryForClients
    ? (await authorizedMessagingSql('select clock_timestamp() as now')).rows[0].now
    : null;
  for (const p of participants) {
    const historyVisibleFrom = p.type === 'client' ? clientCutoff : null;
    // A re-add must never hand a client MORE history than they had. Left to
    // itself the cutoff only moves forward, to the latest of: the cutoff they
    // already carried, the one this add would set, and - for someone who had
    // been removed - this moment, which is what keeps the conversation held
    // while they were gone out of their view. Without it, removing a client,
    // talking, and re-adding them replayed everything they were kept out of, and
    // re-adding a client first added with "hide previous chats" quietly dropped
    // that cutoff. `shareHistoryExplicit` (the firm ticking "let them see
    // previous messages" on THIS add) is the one thing that clears it, so
    // reopening the history stays a deliberate act rather than a default.
    // Firm members never carry a cutoff.
    const isClient = p.type === 'client';
    const historyRule = isClient
      ? `case when $7 then null else nullif(greatest(
             coalesce(conversation_participants.history_visible_from, '-infinity'::timestamptz),
             coalesce(excluded.history_visible_from, '-infinity'::timestamptz),
             case when conversation_participants.removed_at is not null
                  then now() else '-infinity'::timestamptz end
           ), '-infinity'::timestamptz) end`
      : 'null';
    // `$7` only exists on the client branch, so the parameter list is built to
    // match: Postgres takes the parameter count from the highest `$n` the
    // statement mentions and rejects a bind that supplies more.
    const params: unknown[] = [conversationId, lawFirmId, p.userId, p.type, addedBy, historyVisibleFrom];
    if (isClient) params.push(shareHistoryExplicit === true);
    // Seed the read cursor to now() so a freshly-added participant starts caught up
    // rather than seeing the group's entire prior history as unread (which would also
    // inflate their firm/portal unread badge). Messages sent before they joined aren't
    // theirs to "catch up" on. On a re-add (on conflict) the cursor only moves
    // forward, to the new history cutoff when there is one, so nothing the cutoff
    // now hides is still counted as unread. `greatest` ignores a null cutoff.
    await authorizedMessagingSql(`insert into conversation_participants
         (conversation_id, law_firm_id, participant_user_id, participant_type, added_by, last_read_at, history_visible_from)
       values ($1,$2,$3,$4,$5, now(), $6)
       on conflict (conversation_id, participant_user_id)
         do update set removed_at = null, participant_type = excluded.participant_type,
                       history_visible_from = ${historyRule},
                       last_read_at = greatest(conversation_participants.last_read_at, ${historyRule})`,
      params
    );
  }
}

/** Add unclaimed client records to a group without granting portal access yet. */
export async function addPendingClientRecipients(conversationId: string, lawFirmId: string, addedBy: any, clientIds: string[], { hideHistoryForClients = false }: any = {}) {
  const historyVisibleFrom = hideHistoryForClients
    ? (await authorizedMessagingSql('select clock_timestamp() as now')).rows[0].now
    : null;
  for (const clientId of [...new Set((clientIds || []).filter(isUuid))]) {
    await authorizedMessagingSql(`insert into conversation_participants
         (conversation_id, law_firm_id, client_id, participant_type, added_by, history_visible_from)
       values ($1,$2,$3,'client',$4,$5)
       on conflict (conversation_id, client_id)
         do update set removed_at = null,
                       history_visible_from = coalesce(conversation_participants.history_visible_from, excluded.history_visible_from)`,
      [conversationId, lawFirmId, clientId, addedBy, historyVisibleFrom]
    );
  }
}

/**
 * Seat a person on their company's canonical conversation, if that thread
 * already exists. No-op when it does not: `findOrCreateCanonicalCompanyConversation`
 * seeds the whole roster when it is eventually created.
 *
 * The counterpart of the `removeParticipant` call that unlinking a person
 * already makes. Membership of the thread lives in its own table, not derived
 * from `client_company_links`, so only removal was kept in step: someone linked
 * to a company after its thread existed never reached it, in the portal or
 * anywhere else, and no screen said so.
 *
 * `hideHistory` decides what they may read of what came before, and follows the
 * same rule `addGroupParticipants` applies to any other client added to a live
 * thread: sharing is the default, unless the thread already carries a DIFFERENT
 * client's words, at which point sharing would hand one client another's
 * correspondence.
 */
export async function addPersonToCompanyConversation(lawFirmId: string, companyClientId: any, person: any, addedBy: any) {
  const conversationId = await findCanonicalCompanyConversation(lawFirmId, companyClientId);
  if (!conversationId) return null;

  const userId = person && person.userId ? person.userId : null;
  const hideHistory = await hasOtherClientMessages(conversationId, userId ? [userId] : []);

  if (userId) {
    await addParticipants(conversationId, lawFirmId, addedBy, [{ userId, type: 'client' }], {
      hideHistoryForClients: hideHistory,
    });
  } else if (isUuid(person?.clientRecordId)) {
    await addPendingClientRecipients(conversationId, lawFirmId, addedBy, [person.clientRecordId], {
      hideHistoryForClients: hideHistory,
    });
  }
  return conversationId;
}

/**
 * Pending (not yet portal-enabled) recipients of a conversation, with the name
 * and email of the client record each one stands for.
 *
 * A pending recipient is a real, deliberate addition to the thread: the firm
 * picked that person, and they join it the moment they register. Nothing
 * surfaced them, so the firm-side roster showed no trace of anyone chosen this
 * way and they appeared later without explanation. Firm-side only, like the
 * removed-participant lists beside it; a client viewer is never told who else
 * has been lined up.
 */
export async function getPendingClientRecipients(lawFirmId: string, conversationId: string) {
  if (!isUuid(conversationId)) return [];
  const { rows } = await authorizedMessagingSql(`select p.client_id, p.history_visible_from, c.name, c.email
       from conversation_participants p
       join clients c on c.id = p.client_id and c.law_firm_id = p.law_firm_id
      where p.conversation_id = $1 and p.law_firm_id = $2 and p.participant_user_id is null and p.removed_at is null
      order by c.name, p.client_id`,
    [conversationId, lawFirmId]
  );
  return rows.map((r: any) => ({
    clientRecordId: r.client_id,
    name: r.name || '',
    email: r.email || '',
    historyVisibleFrom: iso(r.history_visible_from),
  }));
}

/**
 * Drop a pending recipient from one conversation. Returns whether a row went.
 *
 * The counterpart of `removeParticipant` for someone who has no portal uid to
 * key a participant row on yet. Without it a pending recipient could not be
 * taken off a thread at all, and would still be promoted onto it whenever they
 * eventually registered.
 */
export async function removePendingClientRecipient(lawFirmId: string, conversationId: string, clientRecordId: any) {
  if (!isUuid(conversationId) || !isUuid(clientRecordId)) return false;
  const { rowCount } = await authorizedMessagingSql(`delete from conversation_participants
      where conversation_id = $1 and law_firm_id = $2 and client_id = $3 and participant_user_id is null`,
    [conversationId, lawFirmId, clientRecordId]
  );
  return (rowCount || 0) > 0;
}

/**
 * The canonical (non-archived) company conversation for a client record, if
 * one already exists (`conversations_client_record_active_idx`, migration
 * 0172). Callers that only need to SYNCHRONIZE an existing canonical thread's
 * participants (revocation) treat a null result as a no-op rather than
 * creating one themselves; `findOrCreateCanonicalCompanyConversation` below
 * is for callers that should create it on first need.
 */
export async function findCanonicalCompanyConversation(lawFirmId: string, clientRecordId: any) {
  if (!isUuid(clientRecordId)) return null;
  const { rows } = await authorizedMessagingSql(`select id from conversations
      where law_firm_id = $1 and client_record_id = $2 and archived_at is null
      limit 1`,
    [lawFirmId, clientRecordId]
  );
  return rows[0]?.id || null;
}

/**
 * Every ARCHIVED conversation still (or ever) bound to this client record as
 * its canonical company thread. A client can accumulate more than one over
 * time: `conversations_client_record_active_idx` only dedupes NON-archived
 * rows, so archiving the canonical thread and letting a new one get created
 * leaves the old row behind with the same `client_record_id`.
 *
 * Called before `clientsRepository.deleteClientCascade` severs
 * `client_record_id` on these rows (migration 0172's RESTRICT FK forces every
 * match here to already be archived - a live one blocks the delete entirely,
 * see `clients.service.ts`'s `removeClient` and `privacy.service.ts`'s
 * `eraseClient`), so callers can sweep each conversation's GCS attachment
 * folder while they can still find it by client id.
 */
export async function listArchivedCompanyConversationIds(lawFirmId: string, clientRecordId: any) {
  if (!isUuid(clientRecordId)) return [];
  const { rows } = await authorizedMessagingSql(`select id from conversations
      where law_firm_id = $1 and client_record_id = $2 and archived_at is not null`,
    [lawFirmId, clientRecordId]
  );
  return rows.map((r: any) => r.id);
}

/**
 * Reclaim the GCS attachment bytes of archived company-canonical
 * conversations once the client they belonged to is gone.
 *
 * Group-conversation attachments live under `messaging/group_{conversationId}/`
 * (see `messaging.service.ts`'s `sendGroupMessage` attachment-prefix check) -
 * a path keyed on the conversation, not the client, so no per-client file
 * sweep ever reaches it. `deleteClientCascade` deliberately keeps the
 * conversation row and its messages as the historical record migration 0172
 * was written to protect, but nothing else in the app can ever reach this
 * folder afterward: it isn't listed in the file browser and there is no
 * delete-conversation route, so without this the bytes stay billed to the
 * firm forever. Mirrors `files.events.ts`'s CLIENT_DELETED handling of a
 * person's direct-thread folder, just for the company case, which needs its
 * own path shape and its own trigger point because `client_record_id` (not a
 * portal uid) is what identifies it.
 *
 * Best-effort like every other CLIENT_DELETED-adjacent cleanup: a storage
 * failure here must never surface as a failure of the client deletion that
 * already committed.
 */
export async function sweepArchivedCompanyConversationAttachments(lawFirmId: string, conversationIds: any) {
  if (!Array.isArray(conversationIds) || !conversationIds.length) return { freedBytes: 0 };
  // eslint-disable-next-line global-require
  const filesRepo = require('../files/files.repository');
  // eslint-disable-next-line global-require
  const { BASE_FOLDER } = require('../files/files.context');
  // eslint-disable-next-line global-require
  const { adjustStorageUsageByDelta } = require('../../shared/utils/storageUsage');
  let freedBytes = 0;
  try {
    for (const conversationId of conversationIds) {
      const prefix = `${BASE_FOLDER}/${lawFirmId}/messaging/group_${conversationId}/`;
      // eslint-disable-next-line no-await-in-loop
      const { deletedBytes } = await filesRepo.deleteByPrefix(prefix);
      freedBytes += deletedBytes;
    }
    if (freedBytes > 0) await adjustStorageUsageByDelta(lawFirmId, -freedBytes);
  } catch (err: any) {
    console.error('messaging.repository: sweepArchivedCompanyConversationAttachments failed', err?.message || err);
  }
  return { freedBytes };
}

/** Every current member of a firm (Firebase uids). See findOrCreateCanonicalCompanyConversation. */
export async function getAllFirmMemberIds(lawFirmId: string) {
  const { rows } = await authorizedMessagingSql(`select user_id from members where law_firm_id = $1`, [lawFirmId]);
  return rows.map((r: any) => r.user_id).filter(Boolean);
}

/**
 * Find or create the canonical (non-archived) company conversation for a
 * client record (organization-clients plan Phase 7). Idempotent under
 * concurrent callers via the partial unique index added in migration 0172
 * (`conversations_client_record_active_idx`): `insert ... on conflict ...
 * do nothing` either wins and returns the new row, or loses the race and
 * returns no row, in which case this re-reads and returns the winner's
 * conversation rather than erroring or creating a duplicate - the same
 * lose-the-race-then-re-read discipline `billingRecipientSnapshot.service.ts`
 * uses for the invoice snapshot guard.
 *
 * On first creation, seeds the conversation's firm-side participants with
 * EVERY current firm member. Group-conversation access is participant-gated
 * for firm members too (see `verifyConversationAccess`'s group branch), but
 * `messaging.send`/`messaging.view` are DEFAULT_PERMISSIONS every member
 * holds regardless of role (`lawfirms/roles/permissions.ts`) - a company's
 * canonical thread is, by that firm-wide baseline, something every member is
 * already entitled to see, the same way any firm member can already read any
 * PERSON client's direct thread. Seeding the full roster at creation makes
 * that entitlement real without requiring a firm member to manually add
 * themselves (or every colleague) to a thread they didn't "compose" (the
 * plan's own words for this thread - it is "found or created automatically",
 * not composed by hand). A member who joins the firm AFTER creation is not
 * auto-added by this function; the MEMBER_ADDED listener in
 * `messaging.events.ts` closes that gap by calling
 * `addMemberToCompanyConversations` at the moment they join.
 */
export async function findOrCreateCanonicalCompanyConversation(
  lawFirmId: string,
  clientRecordId: any,
  { createdBy = null }: any = {},
) {
  if (!isUuid(clientRecordId)) throw new NotFoundError('Client');

  const existing = await findCanonicalCompanyConversation(lawFirmId, clientRecordId);
  if (existing) return { conversationId: existing, created: false };

  const { rows: clientRows } = await authorizedMessagingSql(
    `select name from clients where law_firm_id = $1 and id = $2 and client_type = 'company' limit 1`,
    [lawFirmId, clientRecordId],
  );
  const clientRow = clientRows[0];
  if (!clientRow) throw new NotFoundError('Client');

  const [lawFirmName, memberIds, rosterRecords] = await Promise.all([
    getLawFirmName(lawFirmId),
    getAllFirmMemberIds(lawFirmId),
    getCompanyRosterClientRecords(lawFirmId, clientRecordId),
  ]);

  const conversationId = await withDrizzleTransaction(async (client: any) => {
    const ins = await transactionalMessagingSql(client, `insert into conversations
         (law_firm_id, conversation_type, title, client_record_id, created_by, last_message_at)
       values ($1,'group',$2,$3,$4, now())
       on conflict (law_firm_id, client_record_id) where client_record_id is not null and archived_at is null
       do nothing
       returning id`,
      [lawFirmId, clientRow.name || null, clientRecordId, createdBy]
    );
    if (!ins.rows[0]) return null; // lost the race
    const convId = ins.rows[0].id;
    for (const memberId of memberIds) {
      await transactionalMessagingSql(client, `insert into conversation_participants
           (conversation_id, law_firm_id, participant_user_id, participant_type, added_by, last_read_at)
         values ($1,$2,$3,'firm_member',$4,null)
         on conflict (conversation_id, participant_user_id) do nothing`,
        [convId, lawFirmId, memberId, createdBy || memberId]
      );
    }
    for (const record of rosterRecords) {
      if (record.user_id) {
        await transactionalMessagingSql(client, `insert into conversation_participants
             (conversation_id, law_firm_id, participant_user_id, client_id, participant_type, added_by, last_read_at)
           values ($1,$2,$3,$4,'client',$5,now())
           on conflict (conversation_id, participant_user_id) do nothing`,
          [convId, lawFirmId, record.user_id, record.id, createdBy || record.user_id]
        );
      } else {
        await transactionalMessagingSql(client, `insert into conversation_participants
             (conversation_id, law_firm_id, client_id, participant_type, added_by)
           values ($1,$2,$3,'client',$4)
           on conflict (conversation_id, client_id) do nothing`,
          [convId, lawFirmId, record.id, createdBy]
        );
      }
    }
    return convId;
  });

  if (conversationId) return { conversationId, created: true };

  // Lost the race: another caller created the canonical conversation between
  // our read and our insert. Its row is authoritative.
  const winner = await findCanonicalCompanyConversation(lawFirmId, clientRecordId);
  if (winner) return { conversationId: winner, created: false };
  // Vanishingly unlikely (would require the winner's row to already be
  // archived again within this same request); surface a clear error rather
  // than silently returning nothing.
  throw new NotFoundError('Client conversation');
}

export async function removeParticipant(conversationId: string, userId: string) {
  await authorizedMessagingSql(`update conversation_participants set removed_at = now()
      where conversation_id = $1 and participant_user_id = $2 and removed_at is null`,
    [conversationId, userId]
  );
}

/**
 * True when the thread already carries messages from a client OTHER than the ones
 * named. Answers "would sharing this thread's history with the people being added
 * hand them another client's words?" - the case where sharing stops being a
 * convenience and becomes a confidentiality breach.
 */
export async function hasOtherClientMessages(conversationId: string, exceptUserIds: any) {
  if (!isUuid(conversationId)) return false;
  const except = [...new Set((exceptUserIds || []).filter(Boolean))];
  const { rows } = await authorizedMessagingSql(`select 1 from messages
      where conversation_id = $1 and sender_type = 'client' and sender_user_id is not null
        and not (sender_user_id = any($2))
      limit 1`,
    [conversationId, except]
  );
  return !!rows[0];
}

/**
 * Drop a user from every conversation of one firm, for a member who has left it.
 *
 * Soft-removed, like a single removal, so the record of who was on a thread
 * survives. No inline system event is posted: the person left the FIRM, which is
 * not a per-conversation act, and one event per thread would bury real messages
 * under a burst of notices.
 */
export async function removeParticipantFromFirmConversations(lawFirmId: string, userId: string) {
  const { rowCount } = await authorizedMessagingSql(`update conversation_participants set removed_at = now()
      where law_firm_id = $1 and participant_user_id = $2 and removed_at is null`,
    [lawFirmId, userId]
  );
  return rowCount || 0;
}

/**
 * Put a firm member on every canonical company conversation the firm already
 * has, the counterpart to `removeParticipantFromFirmConversations`.
 *
 * `findOrCreateCanonicalCompanyConversation` seeds the firm roster once, when
 * the thread is created. Group threads are participant-gated for firm members
 * too, so without this a member who joins the firm afterwards is locked out of
 * every company thread that already existed: the company's Messages tab 403s,
 * the thread never appears in their inbox, and they cannot add themselves
 * (managing participants itself requires being one).
 *
 * Restricted to `client_record_id is not null`. A company's canonical thread is
 * the one kind of group whose roster IS the firm, by the same firm-wide
 * `messaging.view`/`messaging.send` baseline that lets any member read any
 * person client's direct thread. An ad-hoc group is deliberately composed, so a
 * new colleague must not be dropped into every internal thread in the firm.
 *
 * `last_read_at` starts at now() rather than null, for the reason
 * `addParticipants` gives: messages sent before someone joined are not theirs to
 * catch up on, and a null cursor counts the whole history as unread. The create
 * path can leave it null only because the thread is empty at that moment.
 *
 * A returning member (one who left the firm, and so was soft-removed from
 * everything) has their removal cleared here, because the entitlement comes back
 * with the membership. `history_visible_from` is never set for a firm member.
 */
export async function addMemberToCompanyConversations(lawFirmId: string, userId: string) {
  if (!isUuid(lawFirmId) || !userId) return 0;
  const { rowCount } = await authorizedMessagingSql(`insert into conversation_participants
       (conversation_id, law_firm_id, participant_user_id, participant_type, added_by, last_read_at)
     select c.id, c.law_firm_id, $2, 'firm_member', $2, now()
       from conversations c
      where c.law_firm_id = $1
        and c.conversation_type = 'group'
        and c.client_record_id is not null
        and c.archived_at is null
     on conflict (conversation_id, participant_user_id)
       do update set removed_at = null, participant_type = 'firm_member'`,
    [lawFirmId, userId]
  );
  return rowCount || 0;
}

/**
 * Record an inline participant add/remove event as a `messages` row so it slots
 * into the thread at the point it happened. The row has kind='system' and a NULL
 * sender (which also excludes it from every unread aggregate). `content` is a
 * human-readable fallback; the UI renders from `system_event` (masked on read).
 * The actor's read cursor is advanced to now() so they don't see their own action
 * as a new/unread event. The conversation's last-message preview is deliberately
 * NOT touched, so the list preview stays on real messages.
 */
export async function insertGroupSystemEvent(conversationId: string, lawFirmId: string, { action, subjectUserId, subjectType, subjectName, actorUserId }: any) {
  if (!isUuid(conversationId)) throw new NotFoundError('Conversation');
  const verb = action === 'participant_removed' ? 'was removed from' : 'was added to';
  const content = `${subjectName || 'Someone'} ${verb} the conversation`;
  const event = { action, subjectUserId, subjectType, subjectName: subjectName || '' };
  const { rows } = await authorizedMessagingSql(`insert into messages
       (conversation_id, law_firm_id, sender_user_id, sender_type, content, kind, system_event, status, updated_at)
     values ($1,$2,null,null,$3,'system',$4,'sent', now()) returning id`,
    [conversationId, lawFirmId, content, JSON.stringify(event)]
  );
  if (actorUserId) {
    await authorizedMessagingSql(`update conversation_participants set last_read_at = now()
        where conversation_id = $1 and participant_user_id = $2 and removed_at is null`,
      [conversationId, actorUserId]
    );
  }
  return rows[0].id;
}

/** Load a conversation of any type (direct or group). */
export async function loadConversationBasic(conversationId: string) {
  if (!isUuid(conversationId)) return null;
  const { rows } = await authorizedMessagingSql(`select * from conversations where id = $1 limit 1`,
    [conversationId]
  );
  return rows[0] || null;
}

/**
 * Synthesize the participant roster of a DIRECT thread so its header can show
 * the same "participants" affordance a group has, before any conversion. The
 * roster is the client plus the firm members who have actually sent a message in
 * the thread (the people really in the conversation); `ensureFirmUserId` folds in
 * the current firm viewer even if they haven't sent yet, so a viewer always sees
 * themselves on the roster. Shape matches getParticipants (photoObjectPath is
 * signed by the caller).
 */
export async function getDirectConversationParticipants(conversationId: string, clientId: string, ensureFirmUserId = null) {
  if (!isUuid(conversationId)) return [];
  const parts = [];
  const seen = new Set();
  if (clientId) {
    const { rows } = await authorizedMessagingSql(`select id, name, email, photo_object_path from users where id = $1 limit 1`,
      [clientId]
    );
    if (rows[0]) {
      parts.push({ userId: rows[0].id, type: 'client', name: rows[0].name || '', email: rows[0].email || '', photoObjectPath: rows[0].photo_object_path || null });
      seen.add(rows[0].id);
    }
  }
  const firmIds = new Set();
  const { rows: senders } = await authorizedMessagingSql(`select distinct sender_user_id from messages
      where conversation_id = $1 and sender_type = 'firm_member' and sender_user_id is not null`,
    [conversationId]
  );
  senders.forEach((r: any) => firmIds.add(r.sender_user_id));
  if (ensureFirmUserId) firmIds.add(ensureFirmUserId);
  const firmList = [...firmIds].filter((id) => id && !seen.has(id));
  if (firmList.length) {
    const { rows: fm } = await authorizedMessagingSql(`select id, name, email, photo_object_path from users where id = any($1)`,
      [firmList]
    );
    fm.forEach((r: any) => parts.push({ userId: r.id, type: 'firm_member', name: r.name || '', email: r.email || '', photoObjectPath: r.photo_object_path || null }));
  }
  return parts;
}

/**
 * Whether `userId` is on a DIRECT thread's roster as `convertDirectToGroup`
 * would seat it: the thread's client, or a current member of the firm who has
 * sent a message in it. Anyone else has no seat to be removed from.
 */
export async function isDirectThreadParticipant(conversationId: string, userId: string) {
  if (!isUuid(conversationId) || !userId) return false;
  const { rows } = await authorizedMessagingSql(`select 1 from conversations c
      where c.id = $1 and c.conversation_type = 'direct'
        and (c.client_id = $2 or exists (
          select 1 from messages m
            join members mem on mem.user_id = m.sender_user_id and mem.law_firm_id = c.law_firm_id
           where m.conversation_id = c.id and m.sender_type = 'firm_member' and m.sender_user_id = $2))
      limit 1`,
    [conversationId, userId]
  );
  return !!rows[0];
}

/**
 * Convert a DIRECT (1:1) thread into a GROUP in place, keeping the same id and
 * message history. Adding anyone to a 1:1 goes through here first. The read model
 * switches from per-message read_by_firm/read_by_client flags to a per-participant
 * last_read_at cursor, so each seeded participant's cursor is set to the newest
 * message they had already read — preserving their unread count across the switch.
 * The firm side is seeded with the members who actually messaged (plus the acting
 * member), not the whole firm, so the resulting roster is the people really in the
 * conversation. No-op if the thread is already a group.
 */
export async function convertDirectToGroup(conversationId: string, actingUserId: string) {
  await withDrizzleTransaction(async (client: any) => {
    const { rows: cr } = await transactionalMessagingSql(client, `select id, law_firm_id, client_id, conversation_type
         from conversations where id = $1 for update`,
      [conversationId]
    );
    const conv = cr[0];
    if (!conv) throw new NotFoundError('Conversation');
    if (conv.conversation_type === 'group') return;
    const lawFirmId = conv.law_firm_id;

    // Firm side is "caught up" through the newest message that is NOT unread to
    // the firm (a firm-unread message is a client-sent one with read_by_firm=false).
    const { rows: fc } = await transactionalMessagingSql(client, `select max(created_at) as ts from messages
        where conversation_id = $1 and not (sender_type = 'client' and read_by_firm = false)`,
      [conversationId]
    );
    const firmCaughtUp = fc[0]?.ts || null;
    // Client side is caught up through the newest message that is NOT unread to
    // the client (a client-unread message is firm-sent with read_by_client=false).
    const { rows: cc } = await transactionalMessagingSql(client, `select max(created_at) as ts from messages
        where conversation_id = $1 and not (sender_type = 'firm_member' and read_by_client = false)`,
      [conversationId]
    );
    const clientCaughtUp = cc[0]?.ts || null;

    // Current members only: the thread's prior senders may include people who
    // have since left the firm, and seating them as participants of the new group
    // would put a departed member on the roster.
    const { rows: senders } = await transactionalMessagingSql(client, `select distinct m.sender_user_id from messages m
         join members mem on mem.user_id = m.sender_user_id and mem.law_firm_id = $2
        where m.conversation_id = $1 and m.sender_type = 'firm_member' and m.sender_user_id is not null`,
      [conversationId, lawFirmId]
    );
    const firmMemberIds = [...new Set([...senders.map((r: any) => r.sender_user_id), actingUserId].filter(Boolean))];

    if (conv.client_id) {
      await transactionalMessagingSql(client, `insert into conversation_participants
           (conversation_id, law_firm_id, participant_user_id, participant_type, added_by, last_read_at)
         values ($1,$2,$3,'client',$4,$5)
         on conflict (conversation_id, participant_user_id)
           do update set removed_at = null, participant_type = 'client'`,
        [conversationId, lawFirmId, conv.client_id, actingUserId, clientCaughtUp]
      );
    }
    for (const uid of firmMemberIds) {
      await transactionalMessagingSql(client, `insert into conversation_participants
           (conversation_id, law_firm_id, participant_user_id, participant_type, added_by, last_read_at)
         values ($1,$2,$3,'firm_member',$4,$5)
         on conflict (conversation_id, participant_user_id)
           do update set removed_at = null, participant_type = 'firm_member'`,
        [conversationId, lawFirmId, uid, actingUserId, firmCaughtUp]
      );
    }

    // Flip the type and release client_id: it frees the (law_firm_id, client_id)
    // unique index (a fresh direct thread with this client can be started later)
    // and routes RLS/access through conversation_participants instead of client_id.
    await transactionalMessagingSql(client, `update conversations
          set conversation_type = 'group', client_id = null,
              created_by = coalesce(created_by, $2), updated_at = now()
        where id = $1`,
      [conversationId, actingUserId]
    );
  });
}

/** Insert a message into a group conversation and bump metadata + sender's read cursor. */
export async function sendGroupMessage(conversationId: string, { lawFirmId, senderId, senderType, senderName, sentAsFirm = false, content, attachments, mentions = [] }: any) {
  return withDrizzleTransaction(async (client: any) => {
    const msg = await transactionalMessagingSql(client, `insert into messages
         (conversation_id, law_firm_id, sender_user_id, sender_type, sender_name, sent_as_firm,
          content, attachments, mentions, status, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'sent', now()) returning id`,
      [conversationId, lawFirmId, senderId, senderType, senderName,
       senderType === 'firm_member' && sentAsFirm === true, content.trim(),
       JSON.stringify(stripAttachmentUrls(attachments) || []),
       JSON.stringify(Array.isArray(mentions) ? mentions : [])]
    );
    // A new message brings an archived thread back, EXCEPT an archived company
    // thread whose canonical slot (`conversations_client_record_active_idx`) a
    // newer thread now holds. Clearing `archived_at` there violated the index
    // and rolled back the whole transaction, message included. That thread
    // keeps the message and stays archived instead.
    await transactionalMessagingSql(client, `update conversations c set last_message_at = now(),
          last_sender_user_id = $2, updated_at = now(),
          archived_at = case when ${CANONICAL_SLOT_TAKEN} then c.archived_at else null end,
          archived_by = case when ${CANONICAL_SLOT_TAKEN} then c.archived_by else null end
        where c.id = $1`,
      [conversationId, senderId]
    );
    await transactionalMessagingSql(client, `update conversation_participants set last_read_at = now()
        where conversation_id = $1 and participant_user_id = $2`,
      [conversationId, senderId]
    );
    return { conversationId, messageId: msg.rows[0].id };
  });
}

/** Advance a participant's read cursor to now. */
export async function markGroupRead(conversationId: string, userId: string) {
  if (!isUuid(conversationId)) return 0;
  const { rowCount } = await authorizedMessagingSql(`update conversation_participants set last_read_at = now()
      where conversation_id = $1 and participant_user_id = $2 and removed_at is null`,
    [conversationId, userId]
  );
  return rowCount;
}

// Select list for a group-conversation row, with the matter scope, the roster and
// the viewer's unread count aggregated per row. It is written against `c`
// (conversations) joined to `cp` (the VIEWER's participant row), and it reads the
// viewer's id from `$1`, so every query using it must bind the viewer to $1 and
// join `cp` on that same user. Both the paged list and the by-id hydration below
// share it so the two produce identical rows.
const GROUP_CONV_FIELDS = `c.id, c.law_firm_id, c.title, c.matter_id, c.conversation_type, c.hide_client_names,
            (select name from law_firms where id = c.law_firm_id) as derived_law_firm_name,
            greatest(c.last_message_at, cp.history_visible_from) as last_message_at,
            c.created_at, c.updated_at, c.archived_at,
            ${VIEWER_NEWEST_MESSAGE_PREVIEW} as derived_last_message_content,
            c.client_record_id,
            coalesce((select array_agg(cm.matter_id order by cm.position, cm.matter_id)
                        from conversation_matters cm where cm.conversation_id = c.id), '{}') as matter_ids,
            coalesce((select json_agg(json_build_object(
                          'id', m.id,
                          'name', coalesce(m.name, ''),
                          'matterNumber', m.matter_number
                        ) order by cm.position, cm.matter_id)
                        from conversation_matters cm
                        join matters m on m.id = cm.matter_id
                       where cm.conversation_id = c.id), '[]') as matters,
            coalesce((select json_agg(json_build_object(
                          'userId', pt.participant_user_id,
                          'type', pt.participant_type,
                          'name', coalesce(nullif(u.name, ''), u.email, 'Member')
                        ) order by pt.participant_type, u.name)
                        from conversation_participants pt
                        join users u on u.id = pt.participant_user_id
                       where pt.conversation_id = c.id and pt.removed_at is null), '[]') as participants,
            (select count(*) from messages m
              where m.conversation_id = c.id
                and ${VIEWER_UNREAD_MESSAGE}) as unread`;

function groupConvEntity(r: any) {
  return {
    conversationId: r.id, lawFirmId: r.law_firm_id, conversationType: 'group',
    title: r.title || '', matterId: r.matter_id || null, matterIds: r.matter_ids || [],
    matters: r.matters || [],
    hideClientNames: r.hide_client_names === true,
    participants: r.participants || [],
    lawFirmName: r.derived_law_firm_name || '',
    // The clients.id this group is the canonical company thread for (null for
    // an ad-hoc group with no company binding). Organization-clients plan
    // Phase 7: lets a portal/firm conversation list tag which client record a
    // row belongs to without a second lookup.
    clientRecordId: r.client_record_id || null,
    lastMessageAt: iso(r.last_message_at),
    lastMessagePreview: r.derived_last_message_content || '',
    unreadCount: Number(r.unread) || 0, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    archivedAt: iso(r.archived_at),
  };
}

/**
 * Group conversations a user participates in, with per-viewer unread + matter scope,
 * plus the total number of matches alongside the returned window.
 *
 * `lawFirmId` narrows the result to a single firm, which the firm-scoped list needs;
 * omitted, the read spans every firm the user participates in, which is what the
 * portal needs. `search`, `archived` and the paging options mirror
 * getConversationsByLawFirm, and with no `limit` every match comes back.
 */
export async function getGroupConversationsForUser(
  userId: string,
  { lawFirmId = null, limit = null, offset, page, search, archived, clientId, matterId }: any = {},
) {
  const params: unknown[] = [userId];
  const where = [
    'cp.participant_user_id = $1',
    'cp.removed_at is null',
    `c.conversation_type = 'group'`,
  ];

  if (lawFirmId != null) {
    if (!isUuid(lawFirmId)) return { conversations: [], totalItems: 0 };
    params.push(lawFirmId);
    where.push(`c.law_firm_id = $${params.length}`);
  }
  if (archived === true) where.push('c.archived_at is not null');
  else if (archived === false) where.push('c.archived_at is null');
  if (clientId) {
    params.push(clientId);
    where.push(`exists (
      select 1
        from conversation_participants client_scope
       where client_scope.conversation_id = c.id
         and client_scope.participant_user_id = $${params.length}
         and client_scope.participant_type = 'client'
         and client_scope.removed_at is null
    )`);
  }
  if (matterId) {
    if (!isUuid(matterId)) return { conversations: [], totalItems: 0 };
    params.push(matterId);
    where.push(`exists (
      select 1
        from conversation_matters matter_scope
       where matter_scope.conversation_id = c.id
         and matter_scope.matter_id = $${params.length}
    )`);
  }

  const term = toIlikeTerm(search);
  if (term) {
    params.push(term);
    const t = `$${params.length}`;
    // An untitled group's list row reads as its participant names, so the search has
    // to reach the roster as well as the title and the last-message preview.
    // The preview predicate is the viewer's own (bounded by their history
    // cutoff), so a search cannot match on text the list would not show them.
    where.push(`(c.title ilike ${t} escape '\\'
                 or ${VIEWER_NEWEST_MESSAGE_PREVIEW} ilike ${t} escape '\\'
                 or exists (
                      select 1 from conversation_participants rp
                        join users ru on ru.id = rp.participant_user_id
                       where rp.conversation_id = c.id and rp.removed_at is null
                         and (ru.name ilike ${t} escape '\\' or ru.email ilike ${t} escape '\\')
                    ))`);
  }
  const whereSql = where.join(' and ');
  // Snapshotted before paging appends its params so the fallback count can reuse
  // `whereSql` with identical $N numbering.
  const filterParams = params.slice();
  const { pageClause, pageOffset } = buildPageClause({
    limit, offset, page, params, max: 200, optional: true,
  });

  // The window is resolved over the membership row joined to the bare conversation,
  // so the matter/participant aggregates and the unread count only run for the rows
  // actually returned.
  const { rows } = await authorizedMessagingSql(`with page as (
       select c.id, count(*) over() as total_count
         from conversation_participants cp
         join conversations c on c.id = cp.conversation_id
        where ${whereSql}
        order by ${CONV_ORDER}${pageClause}
     )
     select ${GROUP_CONV_FIELDS}, p.total_count
       from page p
       join conversations c on c.id = p.id
       join conversation_participants cp
         on cp.conversation_id = c.id and cp.participant_user_id = $1 and cp.removed_at is null
      order by ${CONV_ORDER}`,
    params
  );

  const totalItems = await resolveWindowTotal({
    rows,
    pageOffset,
    countSql: `select count(*)::int as total
                 from conversation_participants cp
                 join conversations c on c.id = cp.conversation_id
                where ${whereSql}`,
    filterParams,
  });

  return { conversations: rows.map(groupConvEntity), totalItems };
}

// ── Firm inbox (direct + group in one paged read) ───────────────────────

/**
 * Hydrate a set of DIRECT conversations by id, in no particular order. Used by the
 * merged inbox read, which resolves WHICH conversations make up a page first and
 * then fills in the expensive per-row derivations for only those rows.
 */
async function hydrateDirectConversations(ids: any) {
  if (!ids.length) return [];
  const { rows } = await authorizedMessagingSql(`select ${CONV_FIELDS}
       from conversations c
       ${CONV_JOINS}
      where c.id = any($1::uuid[])`,
    [ids]
  );
  return rows.map(convEntity);
}

/** Hydrate a set of GROUP conversations by id for one viewer (unread is per-viewer). */
async function hydrateGroupConversations(userId: string, ids: any) {
  if (!ids.length) return [];
  const { rows } = await authorizedMessagingSql(`select ${GROUP_CONV_FIELDS}
       from conversations c
       join conversation_participants cp
         on cp.conversation_id = c.id and cp.participant_user_id = $1 and cp.removed_at is null
      where c.id = any($2::uuid[])`,
    [userId, ids]
  );
  return rows.map(groupConvEntity);
}

/**
 * One page of the firm's whole inbox: every direct thread in the firm plus the
 * group threads the caller participates in, interleaved by recency.
 *
 * This exists because the two halves cannot be paged separately and merged. Page N
 * of the union is not page N of each half, so a client-side merge either has to
 * over-fetch both halves up to the requested depth (two reads of `offset + limit`
 * rows to render `limit` of them) or silently drop rows. Resolving the window in
 * one ordered query over `conversations` makes the page exact and the cost flat:
 * the ordering read touches only the columns it sorts and filters on, and the
 * per-row derivations (unread aggregates, rosters, matter scope, last-message
 * fallbacks) run for the handful of ids the page actually contains.
 *
 * `search`, `archived` and the paging options mirror the split lists; with no
 * `limit` the whole inbox comes back. `totalItems` counts every match across both
 * halves.
 */
export async function getFirmInboxPage(lawFirmId: string, userId: string, { limit = null, offset, page, search, archived }: any = {}) {
  if (!isUuid(lawFirmId)) return { conversations: [], totalItems: 0 };

  const params: unknown[] = [lawFirmId, userId];
  const where = [
    'c.law_firm_id = $1',
    // Direct threads are firm-wide; group threads are visible only to their
    // participants, which mirrors what the two split list reads each enforce.
    `(c.conversation_type = 'direct' or exists (
        select 1 from conversation_participants cp
         where cp.conversation_id = c.id
           and cp.participant_user_id = $2
           and cp.removed_at is null))`,
  ];
  if (archived === true) where.push('c.archived_at is not null');
  else if (archived === false) where.push('c.archived_at is null');

  const term = toIlikeTerm(search);
  if (term) {
    params.push(term);
    const t = `$${params.length}`;
    // The union of what each half searches: a direct row's client name/email (with
    // the same fallback to the linked portal user that convEntity renders), a group
    // row's title and roster, and the last-message preview both share.
    where.push(`(u.name ilike ${t} escape '\\'
                 or u.email::text ilike ${t} escape '\\'
                 or c.title ilike ${t} escape '\\'
                 or ${NEWEST_MESSAGE_PREVIEW} ilike ${t} escape '\\'
                 or exists (
                      select 1 from conversation_participants rp
                        join users ru on ru.id = rp.participant_user_id
                       where rp.conversation_id = c.id and rp.removed_at is null
                         and (ru.name ilike ${t} escape '\\' or ru.email ilike ${t} escape '\\')
                    ))`);
  }
  // The users join only resolves the direct-thread name/email fallback the search
  // reaches for, so it is joined only when there is a term to match against it.
  const userJoin = term ? 'left join users u on u.id = c.client_id' : '';
  const whereSql = where.join(' and ');
  const filterParams = params.slice();
  const { pageClause, pageOffset } = buildPageClause({
    limit, offset, page, params, max: 200, optional: true,
  });

  const { rows: pageRows } = await authorizedMessagingSql(`select c.id, c.conversation_type, count(*) over() as total_count
       from conversations c
       ${userJoin}
      where ${whereSql}
      order by ${CONV_ORDER}${pageClause}`,
    params
  );

  const totalItems = await resolveWindowTotal({
    rows: pageRows,
    pageOffset,
    countSql: `select count(*)::int as total
                 from conversations c
                 ${userJoin}
                where ${whereSql}`,
    filterParams,
  });

  const [direct, groups] = await Promise.all([
    hydrateDirectConversations(pageRows.filter((r: any) => r.conversation_type !== 'group').map((r: any) => r.id)),
    hydrateGroupConversations(userId, pageRows.filter((r: any) => r.conversation_type === 'group').map((r: any) => r.id)),
  ]);

  // Re-apply the window's ordering: the hydration reads return their rows in
  // whatever order Postgres produced them.
  const byId = new Map();
  for (const c of direct) byId.set(c.conversationId, c);
  for (const c of groups) byId.set(c.conversationId, c);
  const conversations = pageRows.map((r: any) => byId.get(r.id)).filter(Boolean);

  return { conversations, totalItems };
}

// Total group unread across a user's group memberships (for the badge). Firm
// callers pass excludeArchived so archived threads don't inflate the firm badge;
// the client badge counts all (archiving is firm-side only).
export async function getGroupUnreadForUser(userId: string, { excludeArchived = false, lawFirmId = null }: any = {}) {
  const archivedJoin = excludeArchived
    ? 'join conversations c on c.id = cp.conversation_id and c.archived_at is null'
    : '';
  // `lawFirmId` narrows the count to one firm's threads. The firm-side badge
  // passes it: it is rendered inside one firm, and a user who belongs to two
  // firms was seeing the other firm's unread groups in this firm's number. The
  // client portal passes nothing, because a client's badge is deliberately the
  // total across every firm they talk to.
  const { rows } = await authorizedMessagingSql(`select coalesce(sum(u.unread),0)::int c from (
       select (select count(*) from messages m
                where m.conversation_id = cp.conversation_id
                  and ${VIEWER_UNREAD_MESSAGE}) as unread
         from conversation_participants cp
         ${archivedJoin}
        where cp.participant_user_id = $1 and cp.removed_at is null
          and ($2::uuid is null or cp.law_firm_id = $2)) u`,
    [userId, lawFirmId]
  );
  return rows[0].c;
}

// ── Message edit + soft delete ──────────────────────────────────────────

/**
 * Load a single message with the columns needed to authorize + route an edit or
 * delete: the sender, its deleted/attachment state, and the parent conversation's
 * type + firm + client. Returns null for a missing/invalid id.
 */
export async function loadMessageWithConversation(messageId: any) {
  if (!isUuid(messageId)) return null;
  const { rows } = await authorizedMessagingSql(`select m.id, m.sender_user_id, m.deleted_at, m.content, m.attachments, m.created_at,
            m.conversation_id, c.conversation_type, c.law_firm_id, c.client_id
       from messages m
       join conversations c on c.id = m.conversation_id
      where m.id = $1 limit 1`,
    [messageId]
  );
  return rows[0] || null;
}

/**
 * Edit a message's content in place: sets content + edited_at. Scoped to the
 * message's conversation, its sender, and a not-yet-deleted row so a stale/forged
 * request can't touch someone else's (or a deleted) message. Returns the new
 * edited_at (ISO), or null if nothing matched.
 */
export async function editMessage(conversationId: string, messageId: any, senderId: any, content: any) {
  if (!isUuid(conversationId) || !isUuid(messageId)) return null;
  const { rows } = await authorizedMessagingSql(`update messages set content = $4, edited_at = now(), updated_at = now()
      where id = $1 and conversation_id = $2 and sender_user_id = $3 and deleted_at is null
      returning edited_at`,
    [messageId, conversationId, senderId, content]
  );
  return rows[0] ? iso(rows[0].edited_at) : null;
}

/**
 * Soft-delete a message: stamps deleted_at + deleted_by. The row (and its
 * content) is retained in the database as a legal record; read paths mask it.
 * Scoped to the conversation, sender, and a not-yet-deleted row. Returns the
 * deleted_at (ISO), or null if nothing matched.
 */
export async function softDeleteMessage(conversationId: string, messageId: any, senderId: any) {
  if (!isUuid(conversationId) || !isUuid(messageId)) return null;
  const { rows } = await authorizedMessagingSql(`update messages set deleted_at = now(), deleted_by = $3, updated_at = now()
      where id = $1 and conversation_id = $2 and sender_user_id = $3 and deleted_at is null
      returning deleted_at`,
    [messageId, conversationId, senderId]
  );
  return rows[0] ? iso(rows[0].deleted_at) : null;
}

// ── Message full-text search ────────────────────────────────────────────

// Shared row shape for both search variants. Carries the fields the service needs
// to build a masked snippet result (sender identity masking + conversation title).
function searchRow(r: any) {
  return {
    messageId: r.id,
    conversationId: r.conversation_id,
    conversationType: r.conversation_type,
    title: r.title || '',
    clientName: r.client_name || '',
    lawFirmId: r.law_firm_id,
    lawFirmName: r.law_firm_name || '',
    hideClientNames: r.hide_client_names === true,
    content: r.content || '',
    senderId: r.sender_user_id,
    senderType: r.sender_type,
    senderName: r.sender_name || '',
    sentAsFirm: r.sent_as_firm === true,
    createdAt: iso(r.created_at),
  };
}

/**
 * Full-text (case-insensitive substring) search over message content for a firm
 * member. Scope mirrors read access: every DIRECT thread in the firm (firm-wide),
 * plus GROUP threads the member actually participates in. Soft-deleted messages
 * are excluded. Newest matches first, capped at `limit`.
 */
export async function searchFirmMessages(lawFirmId: string, userId: string, q: any, limit: any) {
  if (!isUuid(lawFirmId)) return [];
  const { rows } = await authorizedMessagingSql(`select m.id, m.conversation_id, m.content, m.sender_user_id, m.sender_type,
            m.sender_name, m.sent_as_firm, m.created_at,
            c.conversation_type, c.title, c.client_id, c.hide_client_names, c.law_firm_id,
            u.name as client_name, lf.name as law_firm_name
       from messages m
       join conversations c on c.id = m.conversation_id
       left join users u      on u.id = c.client_id
       left join law_firms lf on lf.id = c.law_firm_id
      where c.law_firm_id = $1
        and m.deleted_at is null
        and m.kind = 'user'
        and m.content ilike $2 escape '\\'
        and (
          c.conversation_type = 'direct'
          or exists (
            select 1 from conversation_participants cp
             where cp.conversation_id = c.id
               and cp.participant_user_id = $3
               and cp.removed_at is null
          )
        )
      order by m.created_at desc
      limit $4`,
    [lawFirmId, toIlikeTerm(q), userId, limit]
  );
  return rows.map(searchRow);
}

/**
 * Full-text search over message content for a portal client. Scope is strictly
 * the conversations the client participates in: their own DIRECT thread(s), plus
 * GROUP threads they are an active participant of. Soft-deleted messages are
 * excluded. Newest matches first, capped at `limit`.
 */
export async function searchClientMessages(userId: string, q: any, limit: any) {
  const { rows } = await authorizedMessagingSql(`select m.id, m.conversation_id, m.content, m.sender_user_id, m.sender_type,
            m.sender_name, m.sent_as_firm, m.created_at,
            c.conversation_type, c.title, c.client_id, c.hide_client_names, c.law_firm_id,
            u.name as client_name, lf.name as law_firm_name
       from messages m
       join conversations c on c.id = m.conversation_id
       left join users u      on u.id = c.client_id
       left join law_firms lf on lf.id = c.law_firm_id
      where m.deleted_at is null
        and m.kind = 'user'
        and m.content ilike $2 escape '\\'
        and (
          (c.conversation_type = 'direct' and c.client_id = $1)
          or (c.conversation_type = 'group' and exists (
            select 1 from conversation_participants cp
             where cp.conversation_id = c.id
               and cp.participant_user_id = $1
               and cp.removed_at is null
               and (cp.history_visible_from is null or m.created_at >= cp.history_visible_from)
          ))
        )
      order by m.created_at desc
      limit $3`,
    [userId, toIlikeTerm(q), limit]
  );
  return rows.map(searchRow);
}

/**
 * Strip one person's identity from the copy messaging keeps of it.
 *
 * `messages.sender_name` is written on every message sent, so a person's name
 * survives here after their `users` row has been anonymized and their client
 * record deleted. It is the last such copy: `conversations.client_name` and
 * `client_email` went with migration 0251, because every read already coalesced
 * them to the joined `users` row and clearing them just showed the tombstone.
 *
 * `sender_name` cannot follow them, and that is the point of this function
 * rather than an oversight. It is ONE FIRM's record of who spoke. A firm that
 * erases a client erases its own copy even when the person is still a live
 * client of another firm, whose threads keep the name. A join to `users.name`
 * has one value platform-wide and cannot express that, so the column stays and
 * this tombstones it directly.
 *
 * Pass `lawFirmId` to scope the scrub to one firm (a client erased by one firm may
 * still be a live client of another); omit it to scrub everywhere, which is what a
 * full account erasure wants.
 */
export async function anonymizeParticipantIdentity(userId: string, { lawFirmId }: any = {}) {
  if (!userId) return;
  const firmScope = lawFirmId ? ' and law_firm_id = $2' : '';
  const params = lawFirmId ? [userId, lawFirmId] : [userId];
  // The conversation carries no name or email of its own: both are joined from
  // `users`, so anonymizing that row anonymizes every thread at once.
  await authorizedMessagingSql(`update messages set sender_name = 'Deleted user'
      where sender_user_id = $1${firmScope}`,
    params
  );
}
