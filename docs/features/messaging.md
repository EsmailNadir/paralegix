# Messaging / Messages

## Summary

Messaging has two thread types that share one `messages` table and the same Realtime pipeline:

- **Direct (1:1)**, the original channel between a firm and a single client. Unique per `(law_firm_id, client_id)`, exactly one thread per client per firm, lazily created on the first message (`backend/db/schema/86_messaging.sql:35`, `messaging.repository.ts:536`).
- **Group (Option B, migrations `0102`/`0103`)**, a shared multi-participant thread (`conversation_type = 'group'`, `client_id = NULL`) whose membership lives in `conversation_participants` and whose per-participant `last_read_at` cursor drives unread. Groups can be tagged to one or more matters (junction `conversation_matters`, migration `0104`) as an organizational label, and a firm can opt to mask co-client identities from clients in a group (see [Group Conversations, Matter Scope & Client-Name Privacy](#group-conversations-matter-scope-client-name-privacy) below).

Firm members reach threads through the firm portal (`/lawfirm/[lawFirmId]/messages`, plus a **Messages tab on every matter and every client**); clients reach the same threads through the client portal (`/client/messages`). Messages support text plus up to 5 file attachments, either uploaded from the device (straight to GCS through an upload-init/finalize pair) or **copied in from the firm's file manager** (bytes in GCS, signed URLs regenerated on each read). A **company client** gets one canonical group thread, found or created on demand, and a client record without a portal account can be seated on a group as a **pending recipient** until they register. A sender can **edit or soft-delete their own message within 30 minutes**; a member can **archive** a thread out of the firm inbox; and both sides can **full-text search** message content. A firm member can also opt to **appear to clients as the firm** (name + logo) instead of as an individual.

The defining architectural trait is a **dual data path**:

- **Writes go through the Express backend** (`POST .../messaging/send`, `PUT .../mark-read`). The backend connects to Postgres as the `postgres` role (`rolbypassrls`), so Row-Level Security never constrains writes. Authorization for writes is entirely app-code (Firebase token verification + `requirePermission` + membership/client-access checks).
- **Reads for live updates go directly from the browser to Supabase Realtime** over a WebSocket, subscribing to `postgres_changes` on the `conversations` and `messages` tables. Those tables have **RLS enabled** (`86_messaging.sql:197`, `:261`), and the browser authenticates with a short-lived Supabase JWT minted by the backend whose `sub` claim is the user's Firebase UID. RLS policies authorize each row by that UID.

Realtime does two things depending on the payload. For the **message thread**: a plain-text message INSERT/UPDATE **applies the snake_case payload row directly** (one `normalizeMessage` maps it to camelCase and merges by `messageId`, no REST round-trip); attachment-bearing rows, DELETEs, or incomplete payloads **fall back to a debounced REST refetch** (the REST API re-signs attachment URLs and stays the source of truth for those). For the **conversation list**: a changed `conversations` row that already exists in the list is **patched in place** from the payload (preview, timestamp, re-sort, and a sender-type-derived unread increment), falling back to a debounced full-list refetch only for new conversations, DELETEs, or incomplete payloads. The initial message list, pagination, and conversation metadata always come from the REST API.

## Key Takeaways

- **Read-via-RLS / write-via-backend split.** The browser subscribes to Postgres changes directly (RLS-scoped); the backend performs all mutations as `postgres` and bypasses RLS. The two paths never share a connection or auth mechanism.
- **JWT minting bridges Firebase Auth and Supabase.** Firebase is the identity source of truth. `GET /api/messaging/realtime-token` (`messaging.routes.ts:710`) signs an `HS256` JWT with `SUPABASE_JWT_SECRET`, `sub = firebaseUid`, `role = authenticated`, **15-minute TTL** (`TTL_SECONDS`, `messaging.realtime.ts:11`; `signRealtimeToken`, `:13`). The frontend injects it via `supabase.realtime.setAuth(token)` and refreshes 5 min before expiry (`realtimeClient.ts:108`, `:116`).
- **RLS reads the raw text `sub` claim, not `auth.uid()`.** Firebase UIDs aren't UUIDs, so policies use `auth.jwt() ->> 'sub'` (`86_messaging.sql:201`, `:264`). `auth.uid()` would try to cast to uuid and fail.
- **RLS SELECT policies authorize through `SECURITY DEFINER` helpers, no per-row correlated subqueries.** `rls_is_firm_member`, `rls_is_conversation_participant`, and the composed `messaging_can_access_conversation` / `messaging_realtime_message_access` are all `security definer stable`, so the `authenticated` role can decide access without being granted SELECT on `members`/`conversations`/`conversation_participants` and without inlining a subquery per candidate row. The **`messages`** policy is `messaging_realtime_message_access(conversation_id, sub)` (migration `0105`): for **group** conversations only firm-member participants may stream rows (clients are excluded so a plaintext `sender_name` can't leak co-client identities, see Client-Name Privacy below); for **direct** threads it's the conversation's client owner OR any firm member. The **`conversations`** policy splits the same way (group → participant; direct → client owner or firm member).
- **Realtime applies the payload directly for plain text; refetches only for attachments.** `canApplyRowDirectly` gates the fast path; rows with attachments fall back to REST because the Realtime payload never carries a signed `url` (`useConversationMessages.ts:136`, `:244`).
- **Unread counts are derived, never stored.** For direct threads, computed from `messages.read_by_firm` / `read_by_client` flags. The conversation list derives them with one lateral aggregate over `messages` (`CONV_JOINS`, `messaging.repository.ts:184`); direct-thread badge totals come from a single `COUNT(*)` join (`getFirmUnreadCount` `:751`, `getClientUnreadCount` `:762`), and group unread (per-participant `last_read_at` cursor) is summed and added on top in the service (`getGroupUnreadForUser` `:1911`). Firm-side unread counts **only** client-authored messages; client-side unread counts **only** firm-authored ones.
- **The unread badge is event-driven.** `useConversations` broadcasts `unread-count-updated` on every list change and `useConversationMessages` dispatches `messages-marked-read` after a read POST; `useUnreadCount` keeps only a slow 10-minute poll as a fallback when Realtime is unavailable (`useUnreadCount.ts:20`, `:29`).

---

## How It Works

### Entry Points

**Backend routes**, `backend/src/modules/messaging/messaging.routes.ts`, all mounted under `/api`:

Firm-scoped (under `/api/lawfirms/:lawFirmId/messaging`), all guarded by `verifyToken` plus the noted permission:

| Method & Path | Guards | Handler | Line |
|---|---|---|---|
| `POST /send` | `messaging.send`, `messageSendLimiter` (30/min), `validate(sendMessageSchema)` | `sendMessage` | `messaging.routes.ts:106` |
| `GET /conversations` | `messaging.view`, `validate(listConversationsSchema)` | `listFirmConversations` | `:121` |
| `GET /inbox` | `messaging.view`, `validate(listConversationsSchema)` | `listFirmInbox` | `:138` |
| `GET /conversations/:conversationId` | `messaging.view`, `validate(getConversationSchema)` | `getConversation` | `:150` |
| `PUT /conversations/:conversationId/archive` | `messaging.send`, `validate(setArchivedSchema)` | `setConversationArchived` | `:164` |
| `GET /search?q=` | `messaging.view`, `validate(searchMessagesSchema)` | `searchFirmMessages` | `:179` |
| `PATCH /messages/:messageId` (edit) | `messaging.send`, `validate(editMessageSchema)` | `editMessage` | `:191` |
| `DELETE /messages/:messageId` (soft delete) | `messaging.send`, `validate(deleteMessageSchema)` | `deleteMessage` | `:204` |
| `PUT /mark-read` | `messaging.view`, `validate(markReadSchema)` | `markRead` | `:216` |
| `GET /unread-count` | `messaging.view` | `getFirmUnreadCount` | `:228` |
| `GET /present-as-firm` | `verifyToken` only (service asserts membership) | `getPresentAsFirm` | `:239` |
| `PUT /present-as-firm` | `verifyToken`, `validate(setPresentAsFirmSchema)` | `setPresentAsFirm` | `:247` |
| `POST /groups` | `messaging.send`, `validate(createGroupSchema)`; adding any client also needs `messaging.manageParticipants` | `createGroupConversation` | `:258` |
| `GET /groups` | `messaging.view`, `validate(listConversationsSchema)` | `listFirmGroupConversations` | `:275` |
| `POST /groups/:cid/messages` | `messaging.send`, `messageSendLimiter`, `validate(groupSendSchema)` | `sendGroupMessage` | `:284` |
| `GET /groups/:cid` | `messaging.view`, `validate(getConversationSchema)` | `getGroupConversation` | `:292` |
| `GET /company-conversation/:clientId` | `messaging.view` | `getCompanyConversation` (find or create) | `:306` |
| `PUT /groups/:cid/mark-read` | `messaging.view` | `markGroupRead` | `:314` |
| `PUT /groups/:cid/matters` | `messaging.send`, `validate(setGroupMattersSchema)` | `setGroupMatters` | `:323` |
| `PUT /groups/:cid/privacy` | `messaging.send`, `validate(setGroupPrivacySchema)` | `setGroupPrivacy` | `:333` |
| `POST /groups/:cid/participants` | `messaging.send`, `validate(groupParticipantsSchema)`; clients also need `messaging.manageParticipants` | `addGroupParticipants` | `:342` |
| `DELETE /groups/:cid/participants/:userId` | `messaging.send`; a client target also needs `messaging.manageParticipants` | `removeGroupParticipant` | `:359` |
| `DELETE /groups/:cid/pending/:clientId` | `messaging.send` + `messaging.manageParticipants` | `removePendingGroupClient` | `:371` |
| `POST /attachments/upload-init` | `messaging.send`, `uploadLimiter`, `assertLawFirmMembership`, quota reserved per file (5 files, 100 MB each) | inline (`beginDirectUploadBatch`) | `:401` |
| `POST /attachments/upload-finalize` | `messaging.send`, `assertLawFirmMembership`, path must sit directly in the conversation folder | inline (`settleDirectUploadBatch`) | `:437` |
| `POST /attachments/upload-cancel` | `messaging.send`, `assertLawFirmMembership`, at most 5 uploads | inline (`discardDirectUploadBatch`) | `:506` |
| `POST /attachments/from-files` | `messaging.send`, `validate(attachFromFilesSchema)`, quota | inline (GCS copy) | `:497` |

Client-scoped (under `/api/messaging`, no `:lawFirmId`), guarded by `verifyToken` + `requireUserType(['client'])` except the last:

| Method & Path | Handler | Line |
|---|---|---|
| `GET /client-conversations` | `listClientConversations` | `:604` |
| `GET /search?q=` | `searchClientMessages` | `:614` |
| `PATCH /messages/:messageId` (edit) | `editMessage` (isClient) | `:625` |
| `DELETE /messages/:messageId` (soft delete) | `deleteMessage` (isClient) | `:638` |
| `GET /unread-count` | `getClientUnreadCount` | `:650` |
| `GET /client-groups` | `listGroupConversations` | `:661` |
| `GET /client-groups/:cid` | `getGroupConversation` | `:669` |
| `POST /client-groups/:cid/messages` | `sendGroupMessage` (`messageSendLimiter`) | `:679` |
| `PUT /client-groups/:cid/mark-read` | `markGroupRead` | `:689` |
| `GET /messaging/realtime-token` | `signRealtimeToken` (`verifyToken` only, identity-scoped) | `:710` |

(A portal client's direct-thread read/list/send also flows through the client-portal module, `clientPortalService.getMessages` / `.sendMessage` / `.markAsRead` / `.editMessage` / `.deleteMessage`, used by `useConversationMessages` and `useSendMessage`.)

**Frontend pages, components & hooks:**

- Firm conversation list: `frontend/src/app/lawfirm/[lawFirmId]/messages/page.tsx` (uses `useConversations`).
- Firm single conversation → `ConversationView` (`ConversationView.tsx:29` uses `useConversationMessages`; `:35` uses `useSendMessage`).
- Hooks: `useConversations.ts`, `useConversationMessages.ts`, `useSendMessage.ts`, `useUnreadCount.ts`.
- Realtime client singleton + token authorization: `frontend/src/lib/supabase/realtimeClient.ts`.

### The Firm Inbox (`GET /inbox`)

The firm Messages page does not read the direct and group lists separately. `useConversations` calls `messagesService.getFirmInboxPage()` against `GET /lawfirms/:lawFirmId/messaging/inbox` → `listFirmInbox` (`messaging.service.ts:886`) → `msgRepo.getFirmInboxPage` (`messaging.repository.ts`), which interleaves direct threads and the caller's group threads by recency **in one paged SQL query**. The split `GET /conversations` and `GET /groups` endpoints still exist and still back the matter/client tab-scoped views (`MatterMessagesTab.tsx`, `ClientMessagesTab.tsx`), but the primary inbox is the merged one: paging the two halves separately and merging client-side cannot produce an exact page N, since a page boundary can fall in the middle of either half.

`useConversations` takes `limit`/`page`/`search`/`archived` and pushes them to the server rather than filtering a fully-loaded list client-side. Two consequences for the Realtime patch-in-place path (`useConversations.ts`): `patchInPlace` now bails to a full refetch for any conversation not on page 1, and for any group conversation (group unread needs the viewer's per-participant cursor, which a bare Realtime payload can't carry) — narrower conditions than the sender-type-derivation fix described below, which still governs the direct-thread case that *is* patched in place.

### Data Flow, Send a Message (firm member)

1. User types in `MessageInput`; `ConversationView.handleSend` calls `useSendMessage.sendMessage` (`ConversationView.tsx:162`, `:166`).
2. The hook derives `senderType` from the explicit `isClient` flag passed by the call site (no profile fetch), builds an **optimistic message** with id `temp-${Date.now()}`, and calls `onSuccess` immediately so it renders before the server confirms (`useSendMessage.ts:36`, `:39`, `:54`).
3. The hook POSTs to `messagesService.sendMessage` → `POST /api/lawfirms/:lawFirmId/messaging/send` with a Firebase bearer token (`messages.service.ts:9`).
4. Route guards run: token verify, `requirePermission('messaging.send')`, `messageSendLimiter` (30/min), zod `sendMessageSchema` (requires `clientId`, and either non-empty `content ≤ 4000` or ≥1 attachment, at most 5 attachments and 50 mentions) (`messaging.routes.ts:106`, `messaging.validation.ts:13`).
5. `messagingService.sendMessage` (`messaging.service.ts:45`) resolves the sender via `getUser`, sets `senderType` (`client` vs `firm_member`), then authorizes: clients may only send as themselves and must pass `verifyClientAccess`; firm members must pass `assertLawFirmMembership` **and** `verifyClientAccess` on the target client, and a `matterId` must belong to the firm (`messaging.service.ts:52-66`). Every attachment path must sit under this conversation's folder (`:75-80`), mentions are filtered to firm members, and the member's `present_as_firm` preference is snapshotted into `sent_as_firm` (`:92`).
6. `msgRepo.sendMessage` runs one transaction (`messaging.repository.ts:536`): `select ... for update` on the conversation; if missing, INSERT a new conversation (`law_firm_id`, `client_id`, `last_message_at`, `last_sender_user_id` only; names are joined at read); otherwise UPDATE `last_message_at`/`last_sender_user_id` (and clear `archived_at`). Then INSERT the message row with `read_by_client`/`read_by_firm` seeded by sender side. Attachment URLs are stripped before storage (`stripAttachmentUrls`) so only `objectPath` persists (`messaging.repository.ts:579`).
7. If the sender is a firm member, a fire-and-forget client email notification runs with a **1-hour per-conversation cooldown**, honouring the client's "email me on new messages" preference (`shouldSendClientEmail`). The cooldown is claimed in one conditional update (`claimNotificationEmailSlot`, shared with the group path), so two concurrent sends cannot both mail the client. A member who presents as the firm is named as the firm in the email (`_maybeNotifyClient`, `messaging.service.ts`). A client sender instead gets firm recipients for the in-app bell (`getFirmRecipientsForMessage`), and either way `MESSAGE_SENT` is emitted (`:117`).
8. Response returns `{ message, messageId, conversationId }`. The INSERT/UPDATE on `messages`/`conversations` replicates to the `supabase_realtime` publication → subscribed clients receive a `postgres_changes` event.

### Data Flow, Receive via Supabase Realtime

1. On mount, `useConversationMessages` does an initial REST fetch of the last 25 messages and the conversation via `fetchConversationMessages` (one consolidated fetch+map path keyed on `isClient`) (`useConversationMessages.ts:92`, `:326`), then calls `subscribe()`. It opens channel `messages:${conversationId}` subscribing to `postgres_changes` with `event: '*'`, `table: 'messages'`, `filter: conversation_id=eq.${conversationId}` (`:258`). RLS additionally restricts visible rows to the authenticated UID's conversations.
2. `subscribe` calls `authorizeRealtime()` (`realtimeClient.ts:96`): fetches a fresh Supabase JWT from `GET /api/messaging/realtime-token`, calls `supabase.realtime.setAuth(token)`, and schedules a refresh 5 min before expiry (`realtimeClient.ts:108`, `:117`).
3. On each event (only after `hasLoadedRef.current` is true), `handleRealtimeEvent` decides the path (`useConversationMessages.ts:240`):
   - **Fast path**, INSERT/UPDATE where `canApplyRowDirectly(row)` is true (has `id` + `created_at`, **no attachments**): the single `normalizeMessage(row, isClient, true)` maps snake→camel (forcing `attachments: []`) and `mergeMessages` merges by `messageId` (updating read/content/status in place, appending new, preserving already-signed attachment URLs on existing rows), no REST call (`:244`, `:48`, `:182`).
   - **Fallback path**, DELETEs, attachment-bearing rows, or incomplete payloads: `refetchLatest()` runs **debounced 250 ms**, re-fetches the last 25 messages via REST (which re-signs attachments), and merges new ones (`:249`, `:213`).
4. The conversation **list** subscribes separately: `useConversations` opens channel `conversations:${lawFirmId||'client'}:${uid}` on the `conversations` table (`useConversations.ts:235`). On an INSERT/UPDATE whose row is already in the list, `patchInPlace` applies the payload directly, snake→camel merge, re-sort newest-first, and an unread increment **derived from the sender's participant type**, then `broadcastUnread` (`useConversations.ts:146`, `:196`). The increment is NOT a bare "not me" test: the payload has no `sender_type`, so the hook reconstructs it from `last_sender_user_id` vs `client_id` (`lastSenderIsClient = lastSender === clientId`) and only bumps firm unread for client→firm and client unread for firm→client (`:163`–`:184`), exactly mirroring the server's `unread_firm`/`unread_client` filters. A separate `messages-marked-read` listener zeroes the acting side's list-row unread when the open thread is read (`:261`–`:286`). New conversations, DELETEs, or incomplete payloads fall back to a **debounced 300 ms** full-list refetch (`:126`, `:210`). For firm members the subscription is pinned with `filter: law_firm_id=eq.${lawFirmId}` so a member only wakes for their own firm's rows; clients keep the RLS-only table subscription (they may belong to several firms) (`useConversations.ts:230`).
5. Optimistic messages are correlated to their server `messageId` (returned by `sendMessage`) via `tempToServerIdRef`, and the optimistic copy is dropped deterministically once that server id appears in the hook's messages (`ConversationView.tsx:44`, `:65`, `:183`).

### Data Flow, Read-State Updates & Unread Counts

1. When a conversation is open and messages are loaded, `useConversationMessages` auto-calls `markAsRead` (`useConversationMessages.ts:450`).
2. `markAsRead` filters to messages that are `!read` and not in `markedReadIdsRef` (a `Set` of already-POSTed ids, read from `messagesRef` so it isn't recreated on every Realtime append), optimistically records them, then POSTs `PUT .../mark-read` (`useConversationMessages.ts:417`). On failure it rolls back the Set so a retry can fire on the next append (`:442`).
3. Backend `markRead` re-verifies conversation access via the cheap auth lookup, then updates only messages sent by the **other** side that are currently unread for the acting side: sets `read_by_firm`/`read_by_client = true`, `read = true`, `read_at = now()` (`messaging.service.ts:213`, `messaging.repository.ts:406`). (Group threads instead advance the viewer's `conversation_participants.last_read_at` cursor via `markGroupRead`, `:800`.)
4. After a successful read POST the frontend dispatches a `messages-marked-read` window event (`useConversationMessages.ts:439`).
5. The sidebar badge uses `useUnreadCount`, a React Query query that `refetch`es on the `messages-marked-read` and `unread-count-updated` window events, plus a **10-minute fallback poll** for when Realtime is down (`useUnreadCount.ts:20`, `:29`). `useConversations.broadcastUnread` dispatches `unread-count-updated` whenever it (re-)loads or patches the list (`useConversations.ts:60`).
6. Server-side, direct-thread unread totals are a single `COUNT(*)` over `messages` joined to `conversations`, filtered to the opposite sender type and the unread flag (`getFirmUnreadCount` / `getClientUnreadCount`, `messaging.repository.ts:422`/`:434`); the firm total also filters `archived_at is null`. Group unread is summed from participant cursors and added in the service (`getGroupUnreadForUser`, `:859`).

### Conversation Authorization (single vs. double read)

`getConversation` (`messaging.service.ts:197`) now authorizes with a **cheap lookup** and materializes the full conversation entity exactly once:

1. `verifyConversationAccess` (`messaging.repository.ts:391`) → `loadConversationAuthRow` runs `select client_id, law_firm_id, conversation_type from conversations where id = $1`, just the columns needed to decide access (`messaging.repository.ts:380`). For a **group** it requires active participation (via `isActiveParticipant`) even for firm members; for a **direct** thread it's client owner OR firm member. It also enforces that the conversation's `law_firm_id` equals the route's path `:lawFirmId` (`getConversation` / `markRead` pass it through). Without this the `requirePermission('messaging.view')` check, which is evaluated against the path firm, would authorize reading (or marking read) a conversation in a *different* firm for a user who belongs to both firms with different roles.
2. Only then does `getConversation` → `loadConversationRow` run the heavy `CONV_SELECT` (lateral unread aggregate + the derived `NEWEST_MESSAGE_PREVIEW` subquery) once for the response (`messaging.repository.ts:193`, `:368`, `:420`). For a firm viewer it also synthesizes the direct thread's participant roster so the header can offer the same "add people" affordance a group has (`getDirectConversationParticipants`, `:1483`).

This avoids the prior double-`CONV_SELECT` per request, the auth step no longer runs the aggregate.

### Group Conversations, Matter Scope & Client-Name Privacy

Group threads are an **additive** layer: direct 1:1 threads above are untouched. A group sets `conversation_type = 'group'` and `client_id = NULL` (the existing `unique (law_firm_id, client_id)` permits unlimited NULLs), and carries its members in `conversation_participants` instead of a single `client_id`.

**Schema (`schema.sql`, source migrations `0102`/`0103`/`0104`):**

- `conversations` gains `conversation_type` (`'direct'|'group'`), `title`, `matter_id`, `created_by` (migration `0102`).
- `conversation_participants (id, conversation_id, law_firm_id, participant_user_id, client_id, participant_type 'client'|'firm_member', added_by, added_at, removed_at, last_read_at, history_visible_from)` (`86_messaging.sql:58-98`). A row names a portal user (`participant_user_id`), a client record (`client_id`), or both; a CHECK requires at least one, and unique indexes allow one row per `(conversation_id, participant_user_id)` and per `(conversation_id, client_id)`. A row with a `client_id` and no user is a **pending recipient** (see below). A **participant is removed by setting `removed_at`**, not deleting the row, so their prior messages still resolve. `last_read_at` is a **per-participant unread cursor**.
- `conversation_matters (conversation_id, law_firm_id, matter_id, position, created_at)`, PK `(conversation_id, matter_id)`, FK `(law_firm_id, matter_id) → matters` (migration `0104`; `position` added by migration `0123_conversation_matters_position.sql` so ordering doesn't rely on `created_at` ties). `conversations.matter_id` is kept as the **primary** matter (first of the set) so message-event routing keeps working off one column; the junction, ordered by `position, matter_id`, is the authoritative full set (`messaging.repository.ts` `setConversationMatters` / `getConversationMatterIds`).

**Routes (firm-scoped under `/api/lawfirms/:lawFirmId/messaging/groups`, plus client-scoped mirrors under `/api/messaging/client-groups`):** `POST /groups` (`createGroupConversation`), `GET /groups` (`listFirmGroupConversations`), `GET /groups/:cid` (`getGroupConversation`), `POST /groups/:cid/messages` (`sendGroupMessage`), `PUT /groups/:cid/mark-read` (`markGroupRead`), `PUT /groups/:cid/matters` (`setGroupMatters`, migration `0104`), `POST /groups/:cid/participants` / `DELETE /groups/:cid/participants/:userId`. All firm-side group routes require `messaging.send`/`messaging.view`; managing participants, matter scope, privacy and archive state additionally require `assertConversationManageAccess` (`messaging.service.ts:276`, the same check as reading the thread, so participant-gated on a group). Seating or removing a CLIENT, or removing a pending recipient, also requires `messaging.manageParticipants` (`permissions.ts:84`), checked in the service because one endpoint serves both colleagues and clients (`:880-882`, `:988-990`, `:815`). Creating a group that includes any client needs it too (`:485-487`). Clients can take part but cannot restructure a group.

**Access is participant-gated for everyone, firm members included.** Because the backend connects as `postgres` and bypasses RLS, the app-layer `isActiveParticipant` check is the real boundary: `verifyConversationAccess` returns 403 for a non-participant even if they belong to the firm (`messaging.repository.ts` `verifyConversationAccess`), and every group service call re-checks `isActiveParticipant`. Migration `0103` adds participant-aware RLS so the browser Realtime subscription only surfaces group rows the viewer participates in.

**Unread for groups** is derived per viewer from `last_read_at`: `getGroupConversationsForUser` counts messages newer than the participant's cursor, not sent by them, not soft-deleted, and at or after their `history_visible_from` cutoff (`VIEWER_UNREAD_MESSAGE`), and `getGroupUnreadForUser` sums that for the badge. Direct-thread counts also skip soft-deleted messages. The group list row's preview and `lastMessageAt` are bounded by the same cutoff (`VIEWER_NEWEST_MESSAGE_PREVIEW`), so a client added with hidden history is never quoted a message the thread withholds. Group unread is added to the direct-thread unread in the service; direct-thread queries are scoped `conversation_type = 'direct'` so groups never double-count.

**Matter scope is an organizational tag, not a confidentiality gate.** `createGroupConversation` accepts `matterId`/`matterIds`, validates each belongs to the firm, and no longer requires a matter for multi-client groups or checks that clients are on it, a multi-client group with no matter is allowed after a **frontend confirmation** (`NewGroupModal`). `setGroupMatters` replaces the whole set (and re-syncs the primary `matter_id`); `getGroupConversation` and `getGroupConversationsForUser` both return `matterIds[]`. The matter **Messages tab** (`frontend/src/components/matterComp/MatterMessagesTab.tsx`) uses these to list the matter's portal clients (1:1 direct threads) and any groups scoped to the matter, and to pre-scope a new group.

**Client-name privacy** (per-conversation flag `conversations.hide_client_names`, migration `0106`; toggled from the conversation settings gear via `PUT /lawfirms/:id/messaging/groups/:cid/privacy` → `setGroupPrivacy`. This replaced the old firm-wide `settings.messaging.hideClientNamesFromClients` setting, which is gone):

The redaction is enforced at **three** layers so a real co-client name never reaches a client through any path:

1. **REST payload.** When the conversation's `hide_client_names` is on and the viewer is a client, `getGroupConversation` redacts every **other** client's `name`/`email`/`photoUrl` in the participants list and `senderName`/`senderPhotoUrl` in the messages to a generic `"Client"`/`null`. Firm members and the viewer's own identity are untouched. The payload carries `clientNamesMasked` (the applied flag, client viewers only) plus `hideClientNames` (the raw setting, so a firm manager's toggle reflects the real state). The co-client's `userId` stays in the payload (needed to map senders to bubbles) but is un-resolvable to a name, see layer 3.
2. **Realtime transport (migration `0105`).** The `messages` RLS SELECT policy is `messaging_realtime_message_access`: for a GROUP conversation only **firm-member participants** may stream message rows; clients are excluded entirely. So the raw `messages` row, which carries a plaintext `sender_name`, is never delivered to a client over the WebSocket, even by a hand-rolled `postgres_changes` subscription. Direct 1:1 threads are unchanged (no co-client to leak). Because clients no longer stream group message rows, the backend fires a **content-free Broadcast ping** on every group send (`messaging.realtime.ts` `broadcastConversationEvent` → `POST {SUPABASE_URL}/realtime/v1/api/broadcast`, topic `groupmsg:<conversationId>`, best-effort/non-blocking); the client subscribes to that channel (`useConversationMessages.ts`, `isGroup && isClient` branch) and re-fetches the **masked** REST payload on each ping. The ping carries only `{conversationId, messageId}`, nothing sensitive crosses the wire. A client's **direct** thread listens on the same topic as well as its own `conversations` row (migration `0040` keeps clients off direct message rows too): a send moves the row, while an edit, a soft delete and a firm-side mark-read (only when it marked something) move only message rows, so those fire the same ping for every thread kind.
3. **Cross-lookup.** `users.getUserById` (`canReadProfile`) forbids a client from reading another **client's** profile, so a client can't take the co-client `userId` from a group payload and resolve it to a real name/email. A client may still read firm members (their legal team) and themselves.

`ConversationView` also resolves each group message's displayed sender from the (already-masked) participants list and falls back to the firm name for the thread title when masked, belt-and-suspenders on top of the server-side redaction.

**Send-as-firm preference + preview.** The preference is per-member (`members.present_as_firm`), read/written through `GET`/`PUT /lawfirms/:id/messaging/present-as-firm` (`getPresentAsFirm`/`setPresentAsFirm`, `messaging.service.ts:706`, `:712`). It is surfaced both from Settings → General (`PresentAsFirmCard`) and from the conversation header gear (`MessagingSettingsMenu.tsx`) on **every** thread (direct + group), not just groups; the gear adds a **live preview** of the message header a client will see: the toggle flips the previewed avatar/name between the firm's logo+name and the member's own photo+name (`MessagingSettingsMenu.tsx:224`–`:248`). The preference and the member's own profile are lazily loaded the first time the menu opens (`:90`–`:115`).

### Message Edit & Soft Delete

A sender can edit or delete **only their own** message, and only within a **30-minute window** of sending (`MESSAGE_MODIFY_WINDOW_MS`, `messaging.service.ts:17`). Both work for firm members (`PATCH`/`DELETE /lawfirms/:id/messaging/messages/:messageId`) and portal clients (`PATCH`/`DELETE /messaging/messages/:messageId`, `isClient: true`).

- **Edit** (`editMessage`, `messaging.service.ts:281`): loads the message with its parent conversation (`loadMessageWithConversation`, `messaging.repository.ts:884`), re-verifies conversation access, enforces sender-only, rejects editing a deleted message, and re-applies the same "non-empty content OR ≥1 attachment" rule as sending. It stamps `edited_at` (a marker, **the pre-edit text is intentionally not retained**, `migrations/0110_message_edit_delete.sql`) via a scoped UPDATE that also requires `deleted_at is null` (`messaging.repository.ts:903`).
- **Delete** (`deleteMessage`, `messaging.service.ts:323`) is a **soft delete**: `deleted_at`/`deleted_by` are stamped but the row is kept in place (legal record) and still occupies its slot in the thread. Idempotent, deleting an already-deleted message returns success without a second broadcast. Every read path masks a deleted message: `messageEntity` blanks `content` and returns `attachments: []` while keeping ordering/read state, and sets a `deleted` flag that drives the client tombstone (`messaging.repository.ts:41`–`:72`).
- **Realtime**: every edit and delete fires the content-free `broadcastConversationEvent` ping, in direct and group threads alike, so a client viewer (who never streams message rows) re-fetches the masked version. Firm members on a direct thread also get the `postgres_changes` UPDATE the row edit emits (the fast path merges it in place, comparing `deleted`/`editedAt` and dropping attachments on a newly-deleted row).
- Frontend: `ConversationView.handleEditMessage` / `handleDeleteMessage` call the firm or client service by `isClient` and let Realtime propagate the change (`ConversationView.tsx:388`, `:398`); the per-bubble edit/delete affordances render only for the viewer's own messages (`:704`–`:705`).

### Message Search

Full-text (case-insensitive substring) search over **message content**, distinct from the conversation-list name/preview filter. Firm side: `GET /lawfirms/:id/messaging/search?q=` → `searchFirmMessages` (`messaging.service.ts:414`); client side: `GET /messaging/search?q=` → `searchClientMessages` (`:427`). `q` is validated to 2–200 chars (`searchMessagesSchema`) and re-guarded after trimming; results are capped at `SEARCH_RESULT_CAP = 50` (`:354`).

- **Scope mirrors read access.** A firm member searches every **direct** thread in the firm (firm-wide) plus **group** threads they actually participate in; a client searches only their own direct thread(s) and the groups they're an active participant of (`searchFirmMessages`/`searchClientMessages`, `messaging.repository.ts:967`, `:1003`). Soft-deleted messages are excluded. The user term is escaped for `ILIKE` (`likePattern`, `:935`) so a literal `%`/`_` can't act as a wildcard.
- **Results are masked the same way reads are.** `shapeSearchResult` (`messaging.service.ts:375`) applies send-as-firm and client-name masking for a client viewer (a "sent as firm" member shows as the firm name; a co-client in a `hide_client_names` group shows as `"Client"`), builds a short single-line `snippet` centered on the first match (`buildSnippet`, `:358`), and derives a `conversationTitle` (the firm name for a client viewing a direct thread, the client name for a firm member, or the group title).
- Frontend: `MessageSearch.tsx` is a debounced (300 ms) dropdown; picking a result opens that conversation (`page.tsx` `handleOpenSearchResult`). The firm Messages page renders both the list filter and `MessageSearch` (`page.tsx:187`, `:192`).

### Conversation Archiving

Archiving is **firm-side and firm-wide**, one flag on the conversation, no effect on the client portal (`migrations/0109_conversation_archive.sql`). `PUT /lawfirms/:id/messaging/conversations/:cid/archive` → `setConversationArchived` (`messaging.service.ts:261`) requires the same access as reading the thread (`assertConversationManageAccess` → `verifyConversationAccess`, so a non-participant member can't archive a group they're not in), then sets/clears `archived_at` + `archived_by` (`messaging.repository.ts:252`).

- **Any new message un-archives.** Both `sendMessage` and `sendGroupMessage` clear `archived_at`/`archived_by` in the same UPDATE that bumps `last_message_*` (`messaging.repository.ts:300`, `:786`), so a reply resurfaces the thread automatically.
- **Archived threads don't inflate the firm badge.** `getFirmUnreadCount` filters direct threads to `archived_at is null` (`messaging.repository.ts:427`), and the group side is summed with `excludeArchived: true` for firm callers (`getGroupUnreadForUser`, `:859`, called from `messaging.service.ts:236`). The **client** badge counts everything (archiving is firm-side only, `:243`).
- **A replaced company thread stays archived.** Archiving a company's canonical thread frees its slot in `conversations_client_record_active_idx`, so the company's Messages tab creates a new one. A later message in the old thread is still stored and delivered, but no longer un-archives it (`CANONICAL_SLOT_TAKEN` in `sendGroupMessage`), and an explicit firm restore of it answers 409 with an explanation instead of a unique-violation error (`setConversationArchived`).
- Frontend: the firm Messages page has an inbox/archived toggle (`page.tsx:74`–`:76`, `:154`), split on `archivedAt`; `ConversationList` exposes a per-row archive/unarchive action gated on `canManage` (`page.tsx:227`).

### Attaching Files from the File Manager

**Device uploads go straight to storage.** `POST /attachments/upload-init` (`messaging.routes.ts:401-433`) asserts membership, resolves the conversation folder from the caller's own access (`resolveConversationFolder`, `:61-81`), and calls `beginDirectUploadBatch`, which admits every file against the upload policy, holds one quota reservation per file, and opens one resumable session per file at `lawfirmids/{firm}/messaging/{folder}/{ts}_{rand}_{name}` (at most 5 files, 100 MB each). Each session comes back with its `reservationId`. The browser PUTs the bytes, then `POST /attachments/upload-finalize` (`:437-490`) re-resolves the folder, refuses any echoed path that is not directly inside it, settles each object against its `uploadedBy` stamp and size, charges what landed, deletes the reservations the uploads name, stamps each object `finalizedAt` (charging an object only the first time it is stamped), and returns `{ attachments, failures }` with 1-hour signed URLs. The send endpoint refuses an object without that stamp, then records only the `objectPath` plus the name, type and size storage holds. Frontend: `messagesService.uploadAttachments` (`messages.service.ts:261`).

Storage usage counts saved files only; an attachment in flight holds its reservation for up to two hours (see [files.md](files.md#storage-usage)). **A composer cancel releases it at once:** `POST /attachments/upload-cancel` (`:506`) takes `{ clientId | conversationId, uploads: [{ objectPath, reservationId }] }` and deletes the reservations, plus any partial object that sits directly in the conversation folder, carries this caller's stamp and that reservation while it is still live, and no saved message names. It answers `{ cancelled: n }`. The frontend sends it for every session init opened whenever an upload stops short of finalize, cancelled or failed, including an init that answers after the cancel; it is not awaited and its failure is not reported. The client portal has the same route at `POST /api/client-portal/lawfirm/:lawFirmId/messages/attachments/upload-cancel` (`{ conversationId?, uploads }`, `clientPortalService.uploadMessageAttachments`).

**Removing an uploaded chip discards it.** Finalize charges an attachment the moment it lands, and a message attachment has no file row, so a chip removed from the composer before sending would stay in storage and on the quota forever. `POST /attachments/discard` takes `{ clientId | conversationId, objectPaths }` (at most 5) and deletes each object that sits directly in the folder the caller may upload to for that conversation, carries the finalize stamp, names this caller as `uploadedBy`, and no message names (`isAttachmentObjectReferenced`). Device uploads and file-manager copies (`from-files` stamps both keys) qualify alike. Usage drops by the size storage reports, and the delete is pinned to that generation, so a repeat or a concurrent discard subtracts once. Anything else is skipped rather than refused; the answer is `{ discarded: n }`. The portal has the same route at `POST /api/client-portal/lawfirm/:lawFirmId/messages/attachments/discard` (`{ conversationId?, objectPaths }`). Both go through `messagingService.discardUnsentAttachments`; `MessageInput.removeAttachment` calls them without waiting and only logs a failure.

Beyond device uploads, a member can attach documents that **already live in the firm's file manager**: `POST /lawfirms/:id/messaging/attachments/from-files`, validated by `attachFromFilesSchema`. Each one is named by its `fileId`, and:

1. the row is looked up scoped to this firm, then **re-authorized for read access** with `assertFileReadAccess` (matter membership, task visibility, firm membership), so a member cannot forward a document from a matter or task they lack access to. The display name comes from the row, so a request cannot forward one document into a chat under another's name;
2. it is **copied**, not referenced, into the conversation's own folder (`resolveConversationFolder` → `{firm}_{clientId}` for direct, `group_{conversationId}` for group). Copying keeps the conversation-prefix security model intact (the send endpoints trust only paths under the conversation folder) and lets a portal client on the thread read the attachment without being granted access to the firm-internal source document.

The same executable/script deny-list (`assertUploadsAllowed`) and storage-quota accounting as a device upload apply, because the copy consumes real bytes. Frontend: `MessageFilePicker.tsx` (device upload vs. file-manager pick); service methods `uploadAttachments` / `attachExistingFiles` (`messages.service.ts:204`, `:249`).

### Participant Management & Direct→Group Conversion

Adding or removing anyone (firm-side only, `POST`/`DELETE .../groups/:cid/participants`) goes through `addGroupParticipants` / `removeGroupParticipant` (`messaging.service.ts:861`, `:964`). Both require `assertConversationManageAccess` (participant-gated for groups, firm-wide for direct), and any client in the request (by uid, by client record, or by expanding a picked company's roster with `organizationClientIds`) also requires `messaging.manageParticipants`. A client record with no portal account becomes a pending recipient instead of a participant (`addPendingClientRecipients`, `messaging.repository.ts:1064`).

The notable behavior: **these also work on a direct 1:1 thread**. Adding or removing a person on a direct thread first **converts it into a group in place**, same conversation id and full message history, via `convertDirectToGroup` (`messaging.repository.ts:1523-1588`). Conversion seeds `conversation_participants` from the real roster (the client + the firm members who actually messaged and are still members + the acting member) and, crucially, **preserves each side's unread across the read-model switch**: it seeds each seeded participant's `last_read_at` cursor to the newest message they had already read (computed from the per-message `read_by_firm`/`read_by_client` flags, `:1534-1547`), because groups track unread by cursor rather than per-message flags. It then flips `conversation_type = 'group'` and releases `client_id` (freeing the `(law_firm_id, client_id)` unique slot so a fresh direct thread with that client can start later). Removing a participant is a soft `removed_at` stamp (`removeParticipant`, `:1353`) so their prior messages still resolve; you cannot remove yourself (`messaging.service.ts:977`). A newly-added participant's cursor is seeded to `now()` so they don't inherit the group's entire back-history as unread (`addParticipants`, `:1017-1061`).

Firm membership keeps rosters in step through `messaging.events.ts`: `MEMBER_REMOVED` soft-removes the departed member from every conversation in the firm, and `MEMBER_ADDED` seats a new member on every company conversation.

### Inline System Messages (participant add/remove)

"Sarah was added to the conversation" is stored as an ordinary `messages` row, not a side table. Migration `0114` added two columns: `kind text not null default 'user' check (kind in ('user','system'))` and `system_event jsonb`.

Making it a message row is the whole point: the event slots into the thread at the moment it happened, ordered by `created_at` alongside real messages, with no merge-two-streams logic on read.

`insertGroupSystemEvent` (`messaging.repository.ts:1446-1463`) writes `kind='system'`, `sender_user_id = null`, a human-readable `content` fallback, and a structured `system_event` payload of `{ action, subjectUserId, subjectType, subjectName }`. Three consequences fall out of the NULL sender, all deliberate:

- **System rows are never unread.** Every group unread aggregate counts messages where `sender_user_id <> viewer`, and `NULL <> uid` evaluates to NULL, not true — so a system row can't inflate anyone's badge.
- **The actor doesn't see their own action as new.** The insert advances the acting user's `last_read_at` to `now()` in the same call (`:1456-1461`).
- **The list preview stays on real messages.** `NEWEST_MESSAGE_PREVIEW` reads only `kind = 'user'` rows. A soft-deleted newest message reads as `Message deleted`, the thread's own tombstone, rather than an empty string the list would render as "No messages yet".

**Audience filtering happens on read, per viewer, in SQL.** `getGroupConversation` (`messaging.service.ts:649`) passes `clientVisibleOnly` for a client viewer, and `getMessages` adds `kind <> 'system' or system_event->>'subjectType' = 'client'` to the page query (`messaging.repository.ts:707-709`), so firm staffing changes are invisible to clients and a page is never short or empty because of hidden events. Firm members see everything.

**Co-client names are masked afterwards.** When client-name privacy is on, a client-subject event about *another* client is rewritten to `subjectName: 'Client'` and `content` is rebuilt from the masked payload (`messaging.service.ts:718-723`). The stored fallback string carries the real name, so re-deriving it rather than reusing it is what keeps the mask airtight.

### Per-Participant History Visibility

When a firm adds a client to an existing group, it chooses whether that client may read what was said before they joined. The answer is one nullable column on `conversation_participants` (migration `0115`):

- `history_visible_from IS NULL` → full history (the default, and every pre-existing row)
- `history_visible_from = <ts>` → only messages with `created_at >= ts`

**The default depends on whose words are in the thread.** `addGroupParticipants` (`messaging.service.ts:928-936`) hides history when the firm unticks "share history" (`shareHistory === false`), shares it on an explicit `true`, and when the flag is unset hides it only if the thread already holds messages from a DIFFERENT client (`hasOtherClientMessages`, `messaging.repository.ts:1366`). A firm-only thread, or one holding only this client's words, keeps full history. `addPersonToCompanyConversation` (`:1097`) applies the same rule when a person is linked to a company after its thread exists.

**Only clients ever get a cutoff.** `addParticipants` (`messaging.repository.ts:1017-1061`) computes one `clientCutoff` timestamp for the whole batch and applies it only where `p.type === 'client'`; firm members always get `null`. Using a single timestamp per batch keeps every client added in the same action on an identical cutoff.

The read cursor is separately seeded to `now()` so a new participant starts caught up rather than inheriting the group's entire back-history as unread. On a **re-add** (`on conflict`) the cursor only moves forward, to the new cutoff when there is one, and the cutoff only moves FORWARD: it becomes the latest of the cutoff they already had, the one this add would set, and, for someone who had been removed, the moment of the re-add (`:1035-1041`). Only an explicit `shareHistory: true` on this add clears it. So removing a client, talking, and re-adding them does not replay what was said while they were gone.

Enforcement is in SQL on both client-facing read paths: `getMessages` bounds the page with `created_at >= visibleFrom` (`messaging.repository.ts:692-734`), and the client message search carries `and (cp.history_visible_from is null or m.created_at >= cp.history_visible_from)` (`:2069`). This is safe precisely because a client's group thread is delivered over REST and never as a raw message-row stream: there is no Realtime path that could bypass the predicate. `getGroupConversation` reads the viewer's own cutoff at `messaging.service.ts:670`.

### Company Conversations & Pending Recipients

A **company** client (`clients.client_type = 'company'`) has no portal login of its own, so it cannot own a direct thread. Instead it gets one canonical GROUP conversation, marked by `conversations.client_record_id` (`86_messaging.sql:22-30`). A partial unique index allows one non-archived canonical thread per `(law_firm_id, client_record_id)` (`conversations_client_record_active_idx`, `:47-49`), so archiving it lets a fresh one be created later.

- **Find or create.** `GET /company-conversation/:clientId` → `getCompanyConversation` (`messaging.service.ts:836-843`) asserts membership and that the client is a company in this firm, then calls `findOrCreateCanonicalCompanyConversation` (`messaging.repository.ts:1279-1351`). That inserts with `on conflict ... do nothing` and re-reads the winner if it lost the race. On creation it seats EVERY current firm member (every member holds `messaging.view`, so the thread is one they may already see) and every person on the company's roster.
- **Roster changes follow.** `MEMBER_ADDED` seats a new firm member on every company conversation (`messaging.events.ts`, `addMemberToCompanyConversations`); linking a person to a company after the thread exists seats them through `addPersonToCompanyConversation` (`messaging.repository.ts:1097`).
- **Deletion.** The FK from `client_record_id` is `restrict`, so a company with a live canonical thread cannot be deleted. Once only archived threads remain, the client delete severs them and `sweepArchivedCompanyConversationAttachments` (`:1223`) reclaims their `group_{id}/` attachment folders and credits the bytes back.

A **pending recipient** is a client record the firm put on a group before that person has a portal account: a `conversation_participants` row with `client_id` set and `participant_user_id` null (`addPendingClientRecipients`, `messaging.repository.ts:1064`). They are created by `createGroupConversation` / `addGroupParticipants` for any roster record with no `user_id`, and by company-thread creation. When the person registers, `reconcilePendingClientRecipients` (`:821`, `:862`, called from auth, invitations and identity linking) fills in their uid. Firm viewers see them in `pendingClients` on the group payload (`getPendingClientRecipients`, `:1127`); clients never do. `DELETE /groups/:cid/pending/:clientId` removes one (`removePendingGroupClient`, `messaging.service.ts:811`), which needs `messaging.manageParticipants`.

### Embedded Messaging (Matter & Client tabs)

Two firm-side surfaces embed `ConversationView` inline (both reuse the firm conversation/group lists, so they share the same React Query caches):

- **Matter Messages tab** (`frontend/src/components/matterComp/MatterMessagesTab.tsx`) lists the matter's portal clients (each opens a 1:1 direct thread, so you can message one client without the others), the group threads scoped to the matter (`matterIds` includes the matter), and a "new group for this matter" action. A single-client, no-group matter opens straight into that client's thread.
- **Client Messages tab** (`frontend/src/components/clientComp/ClientMessagesTab.tsx`) is the mirror scoped to one client: every 1:1 direct thread with that client (duplicates all reachable) plus every group the client is in, picked out via the firm-side `clientParticipantIds` that `listFirmGroupConversations` attaches (`messaging.service.ts:762`–`:769`). A client with one thread and no groups opens straight into it.

Both resolve an existing direct thread by id or fall back to the synthetic `${lawFirmId}_${clientUserId}` key that `ConversationView` opens as a fresh thread (created on first send), and both offer "Open in Messages" to jump to the full page (groups carry a `?type=group` hint). Only clients with a portal account can be messaged.

**Send as firm** (per-member preference `members.present_as_firm`, per-message snapshot `messages.sent_as_firm`, migration `0107`). A firm member toggles "message clients as the firm" in Settings → General (`PresentAsFirmCard` → `GET`/`PUT /lawfirms/:id/messaging/present-as-firm`). On send, `sendMessage`/`sendGroupMessage` snapshot the sender's current preference into `messages.sent_as_firm` (so history stays stable). On the **client-facing** read paths (`getGroupConversation` for groups, `portal.service.ts` `listPortalMessages` for 1:1), a firm-member message with `sent_as_firm=true` is presented under the firm's name and logo (`getFirmNameAndLogo` + `signUserPhotoUrl`); firm members always see the real sender. Group threads are airtight (clients read only the masked REST payload, per the Broadcast path above). **1:1 caveat:** a direct-thread client streams the raw `messages` row over Realtime, which still carries the real `sender_name`; the UI re-masks it (`ConversationView` `displayMessages`, direct branch), but a raw-socket inspection is not redacted. This is a branding preference, not a confidentiality control, so the UI-level mask is acceptable.

### Data Model

**`conversations`** (`backend/db/schema/86_messaging.sql:5-49`):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `law_firm_id` | uuid FK | tenant |
| `client_id` | text FK → users(id) | Firebase UID; **NULL for group threads** (`on delete set null`) |
| `conversation_type` | text | `'direct'` \| `'group'`, default `'direct'` (migration `0102`) |
| `title`, `matter_id`, `created_by` | text / uuid / text | group title, primary matter, creator (migration `0102`) |
| `hide_client_names` | boolean | per-conversation client-name masking, default false (migration `0106`) |
| `archived_at`, `archived_by` | timestamptz / text | firm-side archive; NULL = active (migration `0109`) |
| `last_message_at` | timestamptz | when the newest message landed, for list ordering. The two columns that used to sit beside it are gone: `last_message_content` (migration 0199) and `last_message_preview` (0001 after the collapse). The list preview is derived from the newest message by `NEWEST_MESSAGE_PREVIEW` in `messaging.repository.ts`, so it follows an edit and masks a deleted message, which a copy written at send could not. |
| `last_sender_user_id` | text | |
| `last_notification_email_at` | timestamptz | email cooldown stamp |
| `client_record_id` | uuid | the company `clients.id` this group is the canonical thread for; FK `(law_firm_id, client_record_id)` with `restrict` |
| | | **`unique (law_firm_id, client_id)`**, one direct thread per client per firm; groups set `client_id = NULL` (Postgres treats NULLs as distinct, so groups coexist) (`86_messaging.sql:35`) |

There is no stored client name, client email or firm name any more: `CONV_FIELDS` joins them from `users` and `law_firms` at read (`messaging.repository.ts:174-191`), so a rename shows everywhere at once.

Indexes: `conversations_firm_idx (law_firm_id, last_message_at desc)`, `conversations_client_idx (client_id, last_message_at desc)`, `conversations_archived_idx (law_firm_id, archived_at)`, and the partial unique `conversations_client_record_active_idx` (`86_messaging.sql:40-49`).

> The messaging-specific columns (`sender_type`, `read_by_*`, `status`, `read_at`, the group columns, `sent_as_firm`, `edited_at`, `deleted_at`, etc.) are inline in the base `schema.sql` tables, which is now the only description of the schema: the numbered chain was collapsed into it and the numbering restarts at `0001`.

**`messages`** (`86_messaging.sql:113-161`):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `conversation_id` | uuid FK | `on delete cascade` |
| `law_firm_id` | uuid FK | |
| `sender_user_id` | text FK | |
| `sender_type` | text | `client` \| `firm_member` |
| `sender_name` | text | Who spoke, as this firm recorded it. NOT a cache of `users.name`: it is one firm's copy of the sender's personal data, erasable per firm by `anonymizeParticipantIdentity` for a person who may still be a live client of another firm. A join could not express that. `recipient_id` sat beside it and was dropped: it held "the other side of this thread", derivable from the conversation, meaningless for a group, and read by nothing. |
| `sent_as_firm` | boolean | "send as firm" snapshot, default false (migration `0107`) |
| `content` | text | not null default `''`; masked to `''` on soft delete |
| `attachments`, `mentions` | jsonb | attachments stored **without** `url` (only `objectPath`); stripped on soft delete |
| `read`, `read_by_firm`, `read_by_client` | boolean | direct-thread derived-unread source (group unread uses participant cursors) |
| `read_at`, `matter_id`, `status` | | `status` default `'sent'` |
| `edited_at` | timestamptz | set on sender edit; **marker only, pre-edit text not retained** (migration `0110`) |
| `deleted_at`, `deleted_by` | timestamptz / text | soft delete: row retained, content masked on read (migration `0110`) |

Indexes: **`messages_conversation_created_idx (conversation_id, created_at desc) include (content)`**, the covering index the last-message lateral in `CONV_SELECT` rides, plus `messages_firm_idx` and the partial `messages_deleted_by_idx (where deleted_by is not null)`. The older `messages_conversation_idx (conversation_id, created_at)` was dropped as redundant once the covering index existed (migration `0145_drop_redundant_tenant_indexes.sql`).

`conversation_read_state` **no longer exists**, dropped in migration `0039` because direct-thread unread is derived from per-message flags and group unread from `conversation_participants.last_read_at`.

**`conversation_participants`** (`86_messaging.sql:58-98`), group membership: `id` PK, unique `(conversation_id, participant_user_id)` and `(conversation_id, client_id)`, `participant_user_id` and/or `client_id` (a row with only `client_id` is a pending recipient), `participant_type` (`'client'|'firm_member'`), `added_by`/`added_at`, `removed_at` (soft-remove; prior messages still resolve), `last_read_at` (the per-participant unread cursor), and `history_visible_from` (a client's history cutoff). **`conversation_matters`** (`86_messaging.sql:101-111`), the group's full matter-scope set, PK `(conversation_id, matter_id)`, FK `(law_firm_id, matter_id) → matters`; `conversations.matter_id` mirrors the first of the set for message-event routing.

**RLS policies** (`86_messaging.sql:166-282`; the historical source migrations were `0025`, `0072`, `0103` and `0105`, before the chain was collapsed):

| Table | Policy | Predicate (`sub = auth.jwt()->>'sub'`) |
|---|---|---|
| `conversations` | `conversations_realtime_select` | **group** → `rls_is_conversation_participant(id, sub)`; **direct** → `sub = client_id OR rls_is_firm_member(law_firm_id, sub)` (`86_messaging.sql:199-204`) |
| `messages` | `messages_realtime_select` | `messaging_realtime_message_access(conversation_id, sub)`, **group** → firm-member participants only (clients excluded); **direct** → client owner OR firm member (`:263-265`) |
| `conversation_participants` | `conversation_participants_select` | `messaging_can_access_conversation(conversation_id, sub)` (`:269-271`) |

Only SELECT policies exist (Realtime only reads). All predicates authorize through `security definer stable` helper functions (each with `set search_path` pinned to block the SECURITY DEFINER search-path hijack) so the `authenticated` role can decide access without being granted SELECT on `members`/`conversations`/`conversation_participants` and without inlining a per-row correlated subquery:

- `rls_is_firm_member(p_firm, p_uid)` → `exists(members ...)` (`86_messaging.sql:166`).
- `rls_is_conversation_participant(p_conversation, p_uid)` → `exists(conversation_participants where ... removed_at is null)` (`:185`).
- `messaging_can_access_conversation(p_conversation, p_uid)` folds the client-owner / firm-member / group-participant checks into one call for the `conversation_participants` policy (`:213`).
- `messaging_realtime_message_access(p_conversation, p_uid)` is the **stricter** message-row helper: for a group it requires the uid be BOTH a participant AND a firm member, so a client never streams a group `messages` row (which carries a plaintext `sender_name`); for a direct thread it's client owner OR firm member (`:240-257`). (`rls_is_conversation_client` still exists at `:173` but the messages policy now routes through this stricter helper.)

A pending recipient's row has no `participant_user_id`, so no helper can match it and it streams nothing until the person registers.

Every helper does `revoke all ... from public` + `grant execute ... to authenticated`. All three tables are `grant select ... to authenticated` and added to the `supabase_realtime` publication (`:273-282`).

### Key Logic & Rules

- **JWT minting** (`messaging.realtime.ts:15`): HS256, `SUPABASE_JWT_SECRET`, payload `{ sub: firebaseUid, role: 'authenticated', aud: 'authenticated', iat, exp }`, **TTL 15 min** (`:13`). Returns 503 if the secret is unset (`:17`). The frontend refreshes the single timer 5 min before expiry (`realtimeClient.ts:116`).
- **RLS uses the text `sub` claim** (`auth.jwt()->>'sub'`), not `auth.uid()`, because Firebase UIDs are not UUIDs.
- **Tenancy:** every query is keyed by `law_firm_id`; conversations are unique per `(law_firm_id, client_id)`. The folder `${lawFirmId}_${clientId}` is used for the attachment-upload path before a real conversation UUID exists; `resolveConversationFolder` derives it (or `group_{conversationId}`) from the caller's own access, never from the request (`messaging.routes.ts:61-81`).
- **Attachment path scoping:** because the read path re-signs a download URL for whatever `objectPath` a message carries, `sendMessage` validates every attachment path against the **conversation's own folder** `lawfirmids/{firm}/messaging/{firm}_{clientId}/`, not just the firm-level `lawfirmids/{firm}/messaging/` prefix, so a caller cannot attach another of the firm's clients' objects to their own message. `sendGroupMessage` does the same against `group_{conversationId}/`. Both go through `admitSendAttachments` (`messaging.service.ts`), which also requires the object to exist and carry the `finalizedAt` stamp (written by upload-finalize through `stampDirectUploadFinalized`, and by the from-files copy), requires its `uploadedBy` stamp to be the sender, and refuses a path any saved message already names. Name, type and size are then replaced with what storage recorded, so a sender cannot claim a size. Deleting a message deletes only objects no other live message names (`isAttachmentObjectReferencedElsewhere`) and subtracts the size storage reports, pinned to the object's generation (`deleteAttachmentObjects`). A repeated finalize of the same object charges nothing, and the firm finalize takes at most 5 uploads, like the portal's.
- **Permissions:** firm side requires `messaging.view` / `messaging.send` (RBAC, both in every member's baseline); seating or removing a client needs `messaging.manageParticipants`; client side requires `userType === 'client'`. Send-time authorization re-checks membership / client-firm association in the service (`messaging.service.ts:52-66`).
- **Single message normalizer:** one `normalizeMessage(row, isClient, directApply)` serves the firm REST, client-portal REST, and Realtime-payload paths by reading both camelCase and snake_case keys; the one branch that differs (`read` derivation) is keyed on `isClient` (`useConversationMessages.ts:48`). It replaced the three near-parallel mappers from the prior round.
- **Direct-apply safety fallback:** the Realtime fast path is gated by `canApplyRowDirectly`, any row with attachments, missing `id`/`created_at`, or a DELETE event routes to the REST refetch, which re-signs attachments and stays authoritative (`useConversationMessages.ts:136`, `:240`).
- **Read amplification guard:** `markedReadIdsRef` Set + `messagesRef` prevent re-POSTing reads on every Realtime append (`useConversationMessages.ts:411`, `:423`).
- **Deterministic optimistic de-dup:** the optimistic `temp-` message is correlated to its server `messageId` via `tempToServerIdRef` and dropped once that real id appears in the hook's messages, no timestamp-window guessing (`ConversationView.tsx:44`, `:65`).
- **Attachment URL lifecycle:** signed URLs are stripped before persistence (`stripAttachmentUrls`) and re-signed on REST read via `resignAttachments` (`messaging.service.ts:99`, `attachmentSigning.ts:40`). Signing a v4 URL is a **local cryptographic op** (no GCS API call), TTL 1 hour (`attachmentSigning.ts:19`).
- **Validation:** `getConversationSchema` coerces `limit` to a bounded int (1–100) and validates `lastMessageId` as a uuid, so malformed pagination input is a clean 400 rather than a confusing 404 from the repo's cursor lookup (`messaging.validation.ts:36`). `getMessages` no longer re-validates these, it trusts the validated contract (`messaging.repository.ts:261`–`:264`).
- **Email cooldown:** firm→client notifications throttled to 1/hour/conversation; the cooldown is claimed atomically before sending (`claimNotificationEmailSlot`).

### Dependencies

- **Supabase Realtime** (`@supabase/supabase-js`), browser WebSocket subscription to `postgres_changes`.
- **`jsonwebtoken`**, backend JWT minting.
- **Firebase Auth**, identity source; ID token exchanged for the Supabase JWT.
- **GCS** (`admin.storage()`), attachment bytes; signed URLs.
- **Postgres / `pg` pool**, single data store; backend connects as `postgres` (bypasses RLS).
- **React Query**, unread-count fallback poll + event refetch.

| Env var | Side | Purpose |
|---|---|---|
| `SUPABASE_JWT_SECRET` | backend | signs the Realtime JWT (`messaging.realtime.ts:16`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | backend | Supabase project (service role) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | frontend | Realtime client init (`realtimeClient.ts:19`, `:20`) |
| `NEXT_PUBLIC_API_URL` | frontend | REST + realtime-token endpoint |
| `GCS_BUCKET`, `FRONTEND_URL` | backend | attachments / email links |

### Example

Firm member sends "Can you confirm the hearing date?" to a client:

1. `POST /api/lawfirms/<firm>/messaging/send` `{ clientId, content }` → 201 `{ messageId, conversationId }`.
2. Backend transaction upserts the conversation, inserts the message (`read_by_client = false`, `read_by_firm = true`), stamps `last_message_*`.
3. Postgres replicates the `messages` INSERT to the `supabase_realtime` publication.
4. The client's browser, subscribed to `messages:<conversationId>` under an RLS-scoped JWT, receives the event. RLS authorized the row via `messaging_realtime_message_access(conversation_id, sub)` (direct thread → client owner OR firm member). Because it's plain text (no attachments) and passes `canApplyRowDirectly`, the payload row is mapped by `normalizeMessage` and merged **without** a REST fetch, the new message appears instantly. The client's conversation-list row is likewise patched in place (preview + unread `+1`).
5. When the client opens the thread, `markAsRead` POSTs the messageId; the `messages-marked-read` event refreshes the firm's now-zero unread badge.

---

## What Can Be Improved

Ordered by impact. Each item is specific and traceable. (Items fixed in prior rounds are intentionally not relisted: the double `CONV_SELECT` in `getConversation`; `getConversationSchema` limit/lastMessageId validation; the grouped unread aggregate + covering index; the dead `conversation_read_state` table; the shortened JWT TTL; the firm-scoped conversation filter; the consolidated client/firm fetch path; the removed Firestore-timestamp shims; the RLS `messages` correlated subquery → `rls_is_conversation_client` SECURITY DEFINER helper; the single `normalizeMessage`; optimistic-message correlation via `tempToServerIdRef`; the patch-in-place over-count for other firm members' messages; the zero-on-read listener for the open thread; the Realtime JWT refresh timer outliving its subscribers.)

### New in this pass

1. **Attachment objects that never reach a message are never reclaimed.** `POST /attachments/upload-finalize` settles objects into the conversation folder and reserves their quota (`messaging.routes.ts:433-487`), and `from-files` copies bytes there before any send (`:497-599`). If the message is never sent, nothing references the object, and nothing sweeps the folder: the only reclaim paths are a person client's direct-thread folder on client delete (`files.events.ts:61`) and an archived company thread's folder (`messaging.repository.ts:1223`). An ad-hoc group's `group_{id}/` folder is never swept at all. An age-based sweep of objects under `messaging/` that no `messages.attachments` entry names would close it. **Open (storage, medium).**

2. **Only the attachment upload-init is rate-limited.** `upload-init` carries `uploadLimiter` (`messaging.routes.ts:400`) but `upload-finalize` (`:433-436`) and `from-files` (`:497-500`) do not, and each finalize or copy does a signed-URL mint and GCS metadata reads per file. Add `uploadLimiter` to both for parity with the templates and signing upload routes. **Open (robustness, low).**

### Residual race (minor, newly characterized)

4. **The zero-on-read and the patch increment can still transiently disagree across tabs/devices.** The `messages-marked-read` listener only zeroes the list row in the *same browser context* that issued the read POST. If the same user has the thread open in tab A (read POST fires, server unread → 0) but tab B's list is not viewing it, tab B's `patchInPlace` still increments off its own stale local count on the next inbound message; it self-corrects only on the next full refetch. This is a pre-existing limitation of local-state patching (the payload carries no authoritative unread), not a regression from the fixes above. Acceptable; if precise cross-context counts matter, fall back to a refetch whenever the patched row is the currently-open conversation. **Open (correctness, low).**

### Still-open from prior rounds

5. **`realtime-token` endpoint has no permission gate (by design).** The route is `verifyToken`-only, no `requirePermission('messaging.view')` (`messaging.routes.ts:710`). The in-code comment (`:698-709`) explains why: the path has no `:lawFirmId`, it serves both firm members and portal clients, and `requirePermission` needs a path firm-id and only understands `members`, so it would reject every caller. Security rests on RLS (the JWT carries only the uid; the caller sees only rows it is party to) plus the 15-min TTL (`messaging.realtime.ts:13`). Acceptable, but a firm member whose role lacks `messaging.view` can still mint a token (and see nothing via RLS). A messaging-specific guard accepting either a client identity or *any* firm membership with the messaging permission would tighten this. **Still open (by design).**

6. **Attachment re-signing still happens on every REST read.** `getConversation` re-signs all attachment URLs for the returned page on each call (`messaging.service.ts:211-213`; `getGroupConversation` does the same at `:687-689`). Far less amplified than before, the Realtime fast path skips REST for plain-text messages, and signing is a *local* crypto op, not a GCS round-trip (`attachmentSigning.ts:8`–`:12`). Remaining cost is CPU per attachment on initial load / pagination / attachment-bearing events. Low priority; only worth a per-`objectPath` short-TTL cache if attachment-heavy threads show up in profiling. **Still open (low).**

8. **Message search is an unindexed `ILIKE '%…%'` substring scan.** `searchFirmMessages` / `searchClientMessages` (`messaging.repository.ts:2014`, `:2050`) filter `m.content ilike` with a leading-wildcard pattern, which cannot use a b-tree index. No `pg_trgm` GIN index exists on `messages.content` today; the schema's trigram indexes are on `clients` and `users` names and emails (`95_deferred_fks.sql:85-89`), and the data-model rules require an `explain` showing a plan change before adding another. Fine at current data sizes (capped at 50 rows, newest-first), but on a large firm this scans the `messages` table. If it shows up in profiling, add a `pg_trgm` GIN index on `content` the same way those other tables did. **Still open (low).**

9. **The 1:1 "send as firm" / masking mask is UI-level only over Realtime.** For a **direct** thread, a client streams the raw `messages` row over the WebSocket, which still carries the sender's real `sender_name`; the UI re-masks it, but a raw-socket inspection is not redacted (`getGroupConversation` documents the same caveat, `messaging.service.ts:699-703`). Group threads are airtight (clients don't stream group message rows at all). Since "send as firm" is a branding preference and direct threads never have a co-client to protect, the UI mask is acceptable; a fully airtight direct path would need the same broadcast-ping + masked-refetch treatment groups use. **Still open (accepted).**
