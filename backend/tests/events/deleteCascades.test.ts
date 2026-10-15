/**
 * The delete cascades that live in `*.events.ts`.
 *
 * Deleting a matter, a client, a task or a firm member does far more than
 * remove one row. Eighteen listener files subscribe to those four events and
 * each does its own cleanup, none of it visible on any screen and none of it
 * covered by the module specs, which stop at the route's 200. Two properties
 * matter here and neither had a test:
 *
 *  1. THE CASCADE HAPPENS, AND ONLY WHERE IT SHOULD. Every case below seeds a
 *     sibling entity that must survive, plus a second firm holding rows that
 *     WOULD match if a listener forgot its `law_firm_id`. A spec that only
 *     proved rows disappeared would pass against a listener that wiped the firm.
 *
 *  2. THE CASCADE IS IDEMPOTENT. With `EVENT_OUTBOX_WORKER=true` the durable
 *     outbox re-dispatches an event whose listeners threw, and a partial-failure
 *     retry re-runs ALL of that event's listeners, not just the one that failed
 *     (backend/AGENTS.md, "Durable outbox backstop"). So every listener has to
 *     survive a second delivery of the same payload. Each cascade below is
 *     therefore driven once through the real route, snapshotted (row counts plus
 *     an md5 over every row's text, across fourteen tables and the bucket), then
 *     re-emitted through `eventBus` with the EXACT payload the service emitted,
 *     and the two snapshots must be identical. That is the property nothing else
 *     in this suite tests and the one the outbox design depends on.
 *
 * WHAT IS ATTRIBUTABLE TO A LISTENER. Several of these tables also cascade in
 * the database: `files` has an ON DELETE CASCADE on `(law_firm_id, matter_id)`,
 * `document_requests` has one on `(law_firm_id, matter_id)`, and `tasks` has one
 * too. A fixture that sets those columns proves the FK works, not the listener.
 * So the rows this file asserts on are deliberately chosen to have NO foreign
 * key to the entity being deleted: share links (`file_share_links` carries only
 * `law_firm_id`), notifications (same), the storage-usage counter on `law_firms`,
 * the bucket objects themselves, `document_requests.client_id` (no FK, which is
 * exactly why documentRequests.events exists), and `signature_sessions.client_id`
 * (no FK, likewise). Where a `files` row is asserted on it is seeded with a null
 * `matter_id`, so the only thing that can remove it is
 * `deleteFileRecordsByPrefix` in files.events.
 *
 * The in-memory bucket is installed because the storage half of the cascade is
 * half its point: `deleteByPrefix` reports the bytes it freed and files.events
 * decrements the firm's tracked usage by them. With the default inert bucket
 * that number is always zero and a double-decrement would be invisible.
 */
import { createHash, randomUUID } from 'crypto';

import { installInMemoryBucket, objects, putObject } from '../support/inMemoryBucket';
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createPersonClient,
  createPortalUser,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

installInMemoryBucket();

const eventBus = require('../../src/shared/events/eventBus');
const {
  MATTER_DELETED,
  CLIENT_DELETED,
  TASK_DELETED,
  MEMBER_REMOVED,
} = require('../../src/shared/events/eventTypes');

// ── payload capture ──────────────────────────────────────────────────────
//
// The re-run has to use the payload the SERVICE emitted, not one this file
// reconstructs: matters.service ships a pre-delete snapshot of the matter's
// tasks on the event, and clients.service ships the roster uids it collected
// before the cascade. A hand-built payload would exercise a code path the outbox
// never replays. Registered at module scope, so it is subscribed before the app
// registers anything and before the first request.

const CAPTURED: Record<string, Record<string, unknown>[]> = {};
for (const eventName of [MATTER_DELETED, CLIENT_DELETED, TASK_DELETED, MEMBER_REMOVED]) {
  CAPTURED[eventName] = [];
  eventBus.on(eventName, (payload: Record<string, unknown>) => {
    CAPTURED[eventName].push(payload);
  });
}

/** The payload the service most recently emitted for this event. */
function emittedPayload(eventName: string): Record<string, unknown> {
  const list = CAPTURED[eventName];
  expect(list.length).toBeGreaterThan(0);
  return list[list.length - 1];
}

/** Deliver the same payload a second time, exactly as an outbox retry would. */
async function redeliver(eventName: string, payload: Record<string, unknown>): Promise<void> {
  eventBus.emit(eventName, payload);
  await drainEvents();
}

// ── snapshots ────────────────────────────────────────────────────────────

/**
 * Every table a delete cascade touches. `law_firms` is in the list because the
 * storage-usage counter lives there: a listener that decremented twice would
 * change that row and nothing else.
 *
 * `audit_events` is deliberately absent. The audit log is written
 * fire-and-forget from `res.on('finish')` and can land between two snapshots
 * taken in the same test, which would make every idempotency case flaky for a
 * reason that has nothing to do with the cascade.
 */
const SNAPSHOT_TABLES = [
  'matters',
  'matter_members',
  'tasks',
  'task_assignees',
  'files',
  'file_share_links',
  'notifications',
  'clients',
  'document_requests',
  'conversations',
  'conversation_participants',
  'signature_sessions',
  'members',
  'law_firms',
];

interface TableState {
  count: number;
  digest: string;
}

/**
 * Row counts plus a content digest per table, so "nothing changed" means every
 * column of every row, not just how many rows there are. A listener that
 * re-stamped `updated_at`, flipped a flag back, or resurrected a row moves the
 * digest even when the count holds.
 */
async function snapshotWorld(): Promise<Record<string, TableState>> {
  const state: Record<string, TableState> = {};
  for (const table of SNAPSHOT_TABLES) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await testPool.query<TableState>(
      `select count(*)::int as count,
              coalesce(md5(string_agg(line, '|' order by line)), 'empty') as digest
         from (select t::text as line from public.${table} t) s`,
    );
    state[table] = rows[0];
  }
  state.__bucket = {
    count: objects.size,
    digest: createHash('md5')
      .update(Array.from(objects.entries()).map(([path, o]) => `${path}:${o.bytes}`).sort().join('|'))
      .digest('hex'),
  };
  return state;
}

// ── documents ────────────────────────────────────────────────────────────
//
// A document is a row in the tree plus the bytes behind it, and the row picks
// its own object path. There are no per-scope prefixes to build any more: a
// fixture says where a document IS by naming its scope, and the assertions below
// name the document itself rather than a prefix that might or might not match.
//
// The one prefix left is the conversation thread, which is not part of the
// browsable tree and has no row behind it.

const filesRepo = require('../../src/modules/files/files.repository');

const threadPrefix = (firmId: string, portalUid: string) => `lawfirmids/${firmId}/messaging/${firmId}_${portalUid}/`;

interface Doc { id: string; objectPath: string }

async function seedDoc(
  lawFirmId: string,
  scope: { matterId?: string; taskId?: string; clientId?: string },
  name: string,
  bytes: number,
): Promise<Doc> {
  // A matter-linked task's documents live in the MATTER's tree, tagged with the
  // task; a standalone task owns its own root. That is the rule the upload
  // routes follow, and getting it wrong here would seed a document neither the
  // matter nor the task can reach.
  const root = scope.matterId
    ? await filesRepo.ensureScopeRoot(lawFirmId, { scope: 'matter', matterId: scope.matterId })
    : scope.taskId
      ? await filesRepo.ensureScopeRoot(lawFirmId, { scope: 'task', taskId: scope.taskId })
      : scope.clientId
        ? await filesRepo.ensureScopeRoot(lawFirmId, { scope: 'client', clientId: scope.clientId })
        : await filesRepo.ensureScopeRoot(lawFirmId, { scope: 'firm' });

  const row = await filesRepo.createFile(lawFirmId, {
    parentId: root,
    name,
    mimeType: 'application/pdf',
    ...(scope.taskId ? { taskId: scope.taskId } : {}),
  });
  putObject(row.objectPath, { bytes });
  await filesRepo.finalize(lawFirmId, row.id, { sizeBytes: bytes, mimeType: 'application/pdf' });
  return { id: row.id, objectPath: row.objectPath };
}

// ── fixtures, all plain SQL through the test pool ────────────────────────

async function seedMatter(lawFirmId: string, memberUids: string[], name: string): Promise<string> {
  const id = randomUUID();
  const { rowCount } = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, $3, $4)`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  expect(rowCount).toBe(1);
  for (const uid of memberUids) {
    // eslint-disable-next-line no-await-in-loop
    await testPool.query(
      `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
       values ($1, $2, $3, 'lead', now())`,
      [id, uid, lawFirmId],
    );
  }
  return id;
}

async function seedTask(
  lawFirmId: string,
  opts: { matterId?: string | null; assignees?: string[]; title?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const { rowCount } = await testPool.query(
    `insert into tasks (id, law_firm_id, title, matter_id) values ($1, $2, $3, $4)`,
    [id, lawFirmId, opts.title ?? 'Fixture task', opts.matterId ?? null],
  );
  expect(rowCount).toBe(1);
  for (const uid of opts.assignees ?? []) {
    // eslint-disable-next-line no-await-in-loop
    await testPool.query(`insert into task_assignees (law_firm_id, task_id, user_id)
         select t.law_firm_id, t.id, $2 from tasks t where t.id = $1`, [id, uid]);
  }
  return id;
}

async function seedShareLink(lawFirmId: string, doc: Doc): Promise<string> {
  const token = `share-${randomUUID()}`;
  const { rowCount } = await testPool.query(
    `insert into file_share_links (token, law_firm_id, file_id, display_name, expires_at)
     values ($1, $2, $3, 'document.pdf', now() + interval '30 days')`,
    [token, lawFirmId, doc.id],
  );
  expect(rowCount).toBe(1);
  return token;
}

/**
 * Whether a public link still reaches a document.
 *
 * The link stores a file id under an `on delete set null`, so a destroyed
 * document leaves the row in place with nothing to serve, and the public route
 * answers "no longer available" rather than 404-ing on an unknown token. It used
 * to store a PATH, and a listener had to walk every link under a prefix and
 * revoke each one; a link the walk missed pointed at a path that the next upload
 * of the same name could land on, serving a stranger a document nobody granted
 * them.
 */
async function isDead(token: string): Promise<boolean> {
  const { rows } = await testPool.query(
    `select file_id, revoked_at from file_share_links where token = $1`, [token]);
  if (!rows[0]) return true;
  return rows[0].file_id === null || rows[0].revoked_at !== null;
}

async function rowExists(table: 'files' | 'notifications' | 'document_requests', id: string): Promise<boolean> {
  const { rowCount } = await testPool.query(`select 1 from public.${table} where id = $1`, [id]);
  return rowCount === 1;
}

async function seedNotification(
  lawFirmId: string,
  userId: string,
  cols: { entityType?: string | null; entityId?: string | null; matterId?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  const { rowCount } = await testPool.query(
    `insert into notifications (id, law_firm_id, user_id, type, title, body, entity_type, entity_id, matter_id)
     values ($1, $2, $3, 'fixture', 'Fixture', 'Body', $4, $5, $6)`,
    [id, lawFirmId, userId, cols.entityType ?? null, cols.entityId ?? null, cols.matterId ?? null],
  );
  expect(rowCount).toBe(1);
  return id;
}

async function seedDocumentRequest(lawFirmId: string, clientId: string): Promise<string> {
  const id = randomUUID();
  const { rowCount } = await testPool.query(
    `insert into document_requests (id, law_firm_id, client_id, title) values ($1, $2, $3, 'Onboarding checklist')`,
    [id, lawFirmId, clientId],
  );
  expect(rowCount).toBe(1);
  return id;
}

/**
 * An open signing session with the client on their participant row, which is
 * how every session binds a signer. Both inserts are checked: a session with no
 * participant would make the cancellation assertions pass vacuously.
 */
async function seedSigningSession(lawFirmId: string, clientPortalUid: string): Promise<string> {
  const token = `signing-${randomUUID()}`;
  const { rows } = await testPool.query(
    `insert into signature_sessions (token, law_firm_id, source_id, status, file_name)
     values ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), 'pending', 'engagement.pdf') returning id`,
    [token, lawFirmId],
  );
  expect(rows).toHaveLength(1);
  const participant = await testPool.query(
    `insert into signature_participants
       (session_id, law_firm_id, client_user_id, signing_order, status)
     values ($1, $2, $3, 1, 'active')`,
    [rows[0].id, lawFirmId, clientPortalUid],
  );
  expect(participant.rowCount).toBe(1);
  return token;
}

async function sessionStatus(token: string): Promise<string | undefined> {
  const { rows } = await testPool.query(`select status from signature_sessions where token = $1`, [token]);
  return rows[0]?.status as string | undefined;
}

async function seedGroupConversation(
  lawFirmId: string,
  participants: { uid: string; type: 'firm_member' | 'client' }[],
): Promise<string> {
  const id = randomUUID();
  const { rowCount } = await testPool.query(
    `insert into conversations (id, law_firm_id, conversation_type, title) values ($1, $2, 'group', 'Working group')`,
    [id, lawFirmId],
  );
  expect(rowCount).toBe(1);
  for (const participant of participants) {
    // eslint-disable-next-line no-await-in-loop
    await testPool.query(
      `insert into conversation_participants (conversation_id, law_firm_id, participant_user_id, participant_type)
       values ($1, $2, $3, $4)`,
      [id, lawFirmId, participant.uid, participant.type],
    );
  }
  return id;
}

async function activeParticipants(conversationId: string): Promise<string[]> {
  const { rows } = await testPool.query(
    `select participant_user_id from conversation_participants
      where conversation_id = $1 and removed_at is null order by 1`,
    [conversationId],
  );
  return rows.map((r) => r.participant_user_id as string);
}

async function matterMemberships(userId: string): Promise<string[]> {
  const { rows } = await testPool.query(
    `select law_firm_id from matter_members where user_id = $1 order by 1`,
    [userId],
  );
  return rows.map((r) => r.law_firm_id as string);
}

async function taskAssignments(userId: string): Promise<string[]> {
  const { rows } = await testPool.query(
    `select t.law_firm_id from task_assignees a join tasks t on t.id = a.task_id
      where a.user_id = $1 order by 1`,
    [userId],
  );
  return rows.map((r) => r.law_firm_id as string);
}

const STARTING_STORAGE_BYTES = 10_000_000;

async function setStorageUsed(lawFirmId: string, bytes: number): Promise<void> {
  await testPool.query(`update law_firms set storage_used_bytes = $2 where id = $1`, [lawFirmId, bytes]);
}

async function storageUsed(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(`select storage_used_bytes from law_firms where id = $1`, [lawFirmId]);
  return Number(rows[0].storage_used_bytes);
}

const bucketPaths = (prefix: string): string[] => Array.from(objects.keys()).filter((k) => k.startsWith(prefix)).sort();

beforeEach(() => {
  objects.clear();
  for (const list of Object.values(CAPTURED)) list.length = 0;
});

// =========================================================================
// MATTER_DELETED
// =========================================================================

describe('MATTER_DELETED cascade', () => {
  let firm: Firm;
  let owner: Actor;
  let rival: Firm;
  let rivalOwner: Actor;
  let doomed: string;
  let sibling: string;
  let doomedTask: string;

  let doomedLink: string;
  let siblingLink: string;
  let firmWideLink: string;
  let taskLink: string;
  let rivalLinkOnOurPath: string;

  let doomedDoc: Doc;
  let doomedExhibit: Doc;
  let siblingDoc: Doc;
  let taskDoc: Doc;
  let firmWideDoc: Doc;
  let rivalDoc: Doc;
  let rivalMatter: string;

  let matterNotification: string;
  let taskNotification: string;
  let siblingNotification: string;
  let firmWideNotification: string;
  let rivalNotificationOnOurMatter: string;

  const deleteDoomed = () => owner.api.delete(`/api/lawfirms/${firm.id}/matters/${doomed}`);

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    rival = await createFirm();
    rivalOwner = await ownerOf(rival.id);

    doomed = await seedMatter(firm.id, [owner.uid], 'Doomed matter');
    sibling = await seedMatter(firm.id, [owner.uid], 'Surviving matter');
    doomedTask = await seedTask(firm.id, { matterId: doomed, title: 'Task on the doomed matter' });
    rivalMatter = await seedMatter(rival.id, [rivalOwner.uid], 'Rival matter');

    doomedDoc = await seedDoc(firm.id, { matterId: doomed }, 'brief.pdf', 1000);
    doomedExhibit = await seedDoc(firm.id, { matterId: doomed }, 'exhibit-a.pdf', 500);
    siblingDoc = await seedDoc(firm.id, { matterId: sibling }, 'keep-me.pdf', 700);
    taskDoc = await seedDoc(firm.id, { matterId: doomed, taskId: doomedTask }, 'checklist.pdf', 300);
    firmWideDoc = await seedDoc(firm.id, {}, 'firm-handbook.pdf', 900);

    doomedLink = await seedShareLink(firm.id, doomedDoc);
    siblingLink = await seedShareLink(firm.id, siblingDoc);
    firmWideLink = await seedShareLink(firm.id, firmWideDoc);
    taskLink = await seedShareLink(firm.id, taskDoc);
    // Same document NAME, in the rival's own matter. A listener that matched on
    // anything but the firm's own rows would reach it.
    rivalDoc = await seedDoc(rival.id, { matterId: rivalMatter }, 'brief.pdf', 1000);
    rivalLinkOnOurPath = await seedShareLink(rival.id, rivalDoc);

    matterNotification = await seedNotification(firm.id, owner.uid, { matterId: doomed });
    // matter_id is null on purpose: nothing but the TASK_DELETED fan-out that
    // tasks.events re-emits for each of the matter's tasks can reach this row.
    taskNotification = await seedNotification(firm.id, owner.uid, { entityType: 'task', entityId: doomedTask });
    siblingNotification = await seedNotification(firm.id, owner.uid, { matterId: sibling });
    firmWideNotification = await seedNotification(firm.id, owner.uid, {});
    rivalNotificationOnOurMatter = await seedNotification(rival.id, rivalOwner.uid, { matterId: doomed });

    await setStorageUsed(firm.id, STARTING_STORAGE_BYTES);
    await setStorageUsed(rival.id, STARTING_STORAGE_BYTES);
  });

  // RED IF: files.events drops its MATTER_DELETED share-link revoke or its
  // `deleteFileRecordsByPrefix` call, notifications.events drops
  // `removeForMatter`, or any of them widens its prefix/scope to the whole firm.
  it('revokes, deletes and sweeps only the deleted matter subtree, leaving the firm intact', async () => {
    const res = await deleteDoomed();
    await drainEvents();
    expect(res.status).toBe(200);

    // Gone.
    expect(await isDead(doomedLink)).toBe(true);
    expect(await rowExists('files', doomedDoc.id)).toBe(false);
    expect(await rowExists('notifications', matterNotification)).toBe(false);
    expect(objects.has(doomedDoc.objectPath)).toBe(false);
    expect(objects.has(doomedExhibit.objectPath)).toBe(false);

    // Untouched, same firm.
    expect(await isDead(siblingLink)).toBe(false);
    expect(await isDead(firmWideLink)).toBe(false);
    expect(await rowExists('files', siblingDoc.id)).toBe(true);
    expect(await rowExists('notifications', siblingNotification)).toBe(true);
    expect(await rowExists('notifications', firmWideNotification)).toBe(true);
    expect(objects.has(siblingDoc.objectPath)).toBe(true);
    expect(objects.has(firmWideDoc.objectPath)).toBe(true);
  });

  // RED IF: files.events stops decrementing storage usage on MATTER_DELETED, or
  // decrements by anything other than the bytes it actually freed.
  it('frees exactly the bytes the deleted subtrees held from the firm storage counter', async () => {
    expect(await storageUsed(firm.id)).toBe(STARTING_STORAGE_BYTES);

    const res = await deleteDoomed();
    await drainEvents();
    expect(res.status).toBe(200);

    // 1000 + 500 filed against the matter, plus the 300 its task's document
    // holds. All three carry the matter id, so all three go with it.
    expect(await storageUsed(firm.id)).toBe(STARTING_STORAGE_BYTES - 1800);
    expect(await storageUsed(rival.id)).toBe(STARTING_STORAGE_BYTES);
  });

  // RED IF: tasks.events stops re-emitting TASK_DELETED per task on
  // MATTER_DELETED. The matter's `tasks` rows die by FK cascade either way, so
  // this fan-out is the ONLY thing that reaches task-scoped storage and bells.
  it('fans TASK_DELETED out per task, reaching the task-scoped files, links and bells', async () => {
    const res = await deleteDoomed();
    await drainEvents();
    expect(res.status).toBe(200);

    expect(CAPTURED[TASK_DELETED].map((p) => p.taskId)).toEqual([doomedTask]);
    expect(objects.has(taskDoc.objectPath)).toBe(false);
    expect(await isDead(taskLink)).toBe(true);
    expect(await rowExists('notifications', taskNotification)).toBe(false);
  });

  // RED IF: any MATTER_DELETED listener drops its `law_firm_id` predicate. Every
  // rival row here carries a value that would match on content alone: the same
  // object path, and this firm's matter id in `matter_id`.
  it('leaves another firm alone even when its object paths and matter id collide', async () => {
    const res = await deleteDoomed();
    await drainEvents();
    expect(res.status).toBe(200);

    expect(await isDead(rivalLinkOnOurPath)).toBe(false);
    expect(await rowExists('files', rivalDoc.id)).toBe(true);
    expect(objects.has(rivalDoc.objectPath)).toBe(true);
    expect(await rowExists('notifications', rivalNotificationOnOurMatter)).toBe(true);
  });

  // RED IF: any MATTER_DELETED listener is not idempotent under an outbox retry.
  it('is unchanged by a second delivery of the same MATTER_DELETED payload', async () => {
    const res = await deleteDoomed();
    await drainEvents();
    expect(res.status).toBe(200);

    const payload = emittedPayload(MATTER_DELETED);
    const afterFirst = await snapshotWorld();

    await redeliver(MATTER_DELETED, payload);

    expect(await snapshotWorld()).toEqual(afterFirst);
    // Stated separately because it is the value a double-decrement would move
    // and the one `greatest(0, ...)` would hide on a small enough number.
    expect(await storageUsed(firm.id)).toBe(STARTING_STORAGE_BYTES - 1800);
  });

  // RED IF: a listener stops wrapping its own body in try/catch, or the emit
  // becomes awaited so a listener failure could reach the request.
  it('contains a throwing listener: the delete still succeeds and the others still run', async () => {
    const notificationsRepo = require('../../src/modules/notifications/notifications.repository');
    const failing = jest.spyOn(notificationsRepo, 'removeForMatter')
      .mockRejectedValue(new Error('deliberate listener failure'));
    // The listeners log their own failures; silence only for this case.
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await deleteDoomed();
      await drainEvents();

      expect(res.status).toBe(200);
      expect(failing).toHaveBeenCalled();
      // The failing listener did not do its work...
      expect(await rowExists('notifications', matterNotification)).toBe(true);
      // ...and every other listener still did all of theirs.
      expect(await isDead(doomedLink)).toBe(true);
      expect(await rowExists('files', doomedDoc.id)).toBe(false);
      expect(objects.has(doomedDoc.objectPath)).toBe(false);
      expect(await storageUsed(firm.id)).toBe(STARTING_STORAGE_BYTES - 1800);
      const { rowCount } = await testPool.query(`select 1 from matters where id = $1`, [doomed]);
      expect(rowCount).toBe(0);
    } finally {
      failing.mockRestore();
      quiet.mockRestore();
    }
  });

  // RED IF: a listener that already succeeded redoes its work on a retry (a
  // second storage decrement, a second bucket-delete attempt) instead of
  // finding nothing left to do, or the listener that failed the first time
  // never completes its work on the retry that the durable outbox exists to
  // provide. Failure alone (the case above) is not the whole story: the
  // outbox's entire reason to exist is that the SAME payload comes back, and
  // "unaffected the second time" here specifically means "finishes the job
  // the first delivery could not," not merely "does nothing."
  it('converges on a retry after a partial failure: the stalled listener finishes, the rest do not redo their work', async () => {
    const notificationsRepo = require('../../src/modules/notifications/notifications.repository');
    // Fails only the FIRST call. jest.spyOn keeps calling through to the real
    // implementation once the queued rejection is consumed, so the retry
    // reaches the genuine cleanup rather than another mock.
    const failing = jest.spyOn(notificationsRepo, 'removeForMatter').mockRejectedValueOnce(
      new Error('deliberate listener failure'),
    );
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await deleteDoomed();
      await drainEvents();
      expect(res.status).toBe(200);

      // First delivery: the failing listener's row survives; everything else
      // (storage, bucket, links, task fan-out) already converged in one pass.
      expect(await rowExists('notifications', matterNotification)).toBe(true);
      expect(await isDead(doomedLink)).toBe(true);
      expect(objects.has(doomedDoc.objectPath)).toBe(false);
      expect(await storageUsed(firm.id)).toBe(STARTING_STORAGE_BYTES - 1800);
      const afterFirstAttempt = await snapshotWorld();

      const payload = emittedPayload(MATTER_DELETED);
      await redeliver(MATTER_DELETED, payload);

      // The stalled listener's work is now done: this is what "repeated
      // cleanup converges" means, not just "a retry is harmless."
      expect(await rowExists('notifications', matterNotification)).toBe(false);

      const afterConvergence = await snapshotWorld();
      // Every other table the retry touched is byte-identical: already-done
      // work was not redone. `notifications` is the one exception, and by
      // exactly one row (the row that just got the cleanup it was owed).
      for (const table of Object.keys(afterFirstAttempt)) {
        if (table === 'notifications') continue;
        expect(afterConvergence[table]).toEqual(afterFirstAttempt[table]);
      }
      expect(afterConvergence.notifications.count).toBe(afterFirstAttempt.notifications.count - 1);
      // Stated separately for the same reason as the plain-redelivery case:
      // this is the value a double decrement moves and `greatest(0, ...)`
      // would hide.
      expect(await storageUsed(firm.id)).toBe(STARTING_STORAGE_BYTES - 1800);
    } finally {
      failing.mockRestore();
      quiet.mockRestore();
    }
  });
});

// =========================================================================
// TASK_DELETED
// =========================================================================

describe('TASK_DELETED cascade', () => {
  let firm: Firm;
  let owner: Actor;
  let rival: Firm;
  let rivalOwner: Actor;
  let doomedTask: string;
  let siblingTask: string;

  let doomedLink: string;
  let siblingLink: string;
  let rivalLinkOnOurPath: string;
  let doomedDoc: Doc;
  let siblingDoc: Doc;
  let rivalDoc: Doc;
  let rivalTask: string;
  let doomedNotification: string;
  let siblingNotification: string;
  let rivalNotificationOnOurTask: string;

  const deleteDoomed = () => owner.api.delete(`/api/lawfirms/${firm.id}/tasks/${doomedTask}`);

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    rival = await createFirm();
    rivalOwner = await ownerOf(rival.id);

    // Standalone (no matter): that is the shape files.events' TASK_DELETED
    // handler exists for, and it keeps the matter FK cascade out of the picture.
    doomedTask = await seedTask(firm.id, { title: 'Doomed task' });
    siblingTask = await seedTask(firm.id, { title: 'Surviving task' });
    rivalTask = await seedTask(rival.id, { title: 'Rival task' });

    doomedDoc = await seedDoc(firm.id, { taskId: doomedTask }, 'scan.pdf', 2048);
    siblingDoc = await seedDoc(firm.id, { taskId: siblingTask }, 'keep.pdf', 64);
    // Same document name, in the rival's own task.
    rivalDoc = await seedDoc(rival.id, { taskId: rivalTask }, 'scan.pdf', 2048);

    doomedLink = await seedShareLink(firm.id, doomedDoc);
    siblingLink = await seedShareLink(firm.id, siblingDoc);
    rivalLinkOnOurPath = await seedShareLink(rival.id, rivalDoc);

    doomedNotification = await seedNotification(firm.id, owner.uid, { entityType: 'task', entityId: doomedTask });
    siblingNotification = await seedNotification(firm.id, owner.uid, { entityType: 'task', entityId: siblingTask });
    rivalNotificationOnOurTask = await seedNotification(rival.id, rivalOwner.uid, {
      entityType: 'task', entityId: doomedTask,
    });

    await setStorageUsed(firm.id, STARTING_STORAGE_BYTES);
  });

  // RED IF: files.events or notifications.events drops its TASK_DELETED handler,
  // or either widens its prefix beyond the one task.
  it('sweeps only the deleted task subtree and its bells', async () => {
    const res = await deleteDoomed();
    await drainEvents();
    expect(res.status).toBe(200);

    expect(objects.has(doomedDoc.objectPath)).toBe(false);
    expect(await isDead(doomedLink)).toBe(true);
    expect(await rowExists('files', doomedDoc.id)).toBe(false);
    expect(await rowExists('notifications', doomedNotification)).toBe(false);
    expect(await storageUsed(firm.id)).toBe(STARTING_STORAGE_BYTES - 2048);

    expect(objects.has(siblingDoc.objectPath)).toBe(true);
    expect(await isDead(siblingLink)).toBe(false);
    expect(await rowExists('notifications', siblingNotification)).toBe(true);
  });

  // RED IF: a TASK_DELETED listener drops its `law_firm_id` predicate. Both
  // rival rows would match on path/entity id alone.
  it('leaves another firm alone even when its object path and task id collide', async () => {
    const res = await deleteDoomed();
    await drainEvents();
    expect(res.status).toBe(200);

    expect(await isDead(rivalLinkOnOurPath)).toBe(false);
    expect(await rowExists('files', rivalDoc.id)).toBe(true);
    expect(await rowExists('notifications', rivalNotificationOnOurTask)).toBe(true);
  });

  // RED IF: a TASK_DELETED listener is not idempotent under an outbox retry.
  it('is unchanged by a second delivery of the same TASK_DELETED payload', async () => {
    const res = await deleteDoomed();
    await drainEvents();
    expect(res.status).toBe(200);

    const payload = emittedPayload(TASK_DELETED);
    const afterFirst = await snapshotWorld();

    await redeliver(TASK_DELETED, payload);

    expect(await snapshotWorld()).toEqual(afterFirst);
    expect(await storageUsed(firm.id)).toBe(STARTING_STORAGE_BYTES - 2048);
  });

  // RED IF: a TASK_DELETED listener that missed its first delivery cannot
  // complete on the same-payload retry, or a retry repeats already-settled
  // storage/file cleanup. This is deliberately separate from MATTER_DELETED:
  // task notifications use removeForEntity rather than removeForMatter.
  it('converges on a retry after task-notification cleanup fails once', async () => {
    const notificationsRepo = require('../../src/modules/notifications/notifications.repository');
    const failing = jest.spyOn(notificationsRepo, 'removeForEntity').mockRejectedValueOnce(
      new Error('deliberate task notification cleanup failure'),
    );
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await deleteDoomed();
      await drainEvents();
      expect(res.status).toBe(200);

      // The listener that failed leaves only its own row behind. Files and
      // storage already settled during the original delivery.
      expect(await rowExists('notifications', doomedNotification)).toBe(true);
      expect(await isDead(doomedLink)).toBe(true);
      expect(objects.has(doomedDoc.objectPath)).toBe(false);
      expect(await storageUsed(firm.id)).toBe(STARTING_STORAGE_BYTES - 2048);
      const afterFirstAttempt = await snapshotWorld();

      await redeliver(TASK_DELETED, emittedPayload(TASK_DELETED));

      expect(await rowExists('notifications', doomedNotification)).toBe(false);
      const afterConvergence = await snapshotWorld();
      for (const table of Object.keys(afterFirstAttempt)) {
        if (table === 'notifications') continue;
        expect(afterConvergence[table]).toEqual(afterFirstAttempt[table]);
      }
      expect(afterConvergence.notifications.count).toBe(afterFirstAttempt.notifications.count - 1);
      expect(await storageUsed(firm.id)).toBe(STARTING_STORAGE_BYTES - 2048);
    } finally {
      failing.mockRestore();
      quiet.mockRestore();
    }
  });
});

// =========================================================================
// CLIENT_DELETED
// =========================================================================

describe('CLIENT_DELETED cascade', () => {
  let firm: Firm;
  let owner: Actor;
  let rival: Firm;
  let portalUid: string;
  let doomedClient: string;
  let siblingClient: string;

  let doomedRequest: string;
  let siblingRequest: string;
  let rivalRequestForSamePerson: string;

  let doomedLink: string;
  let siblingLink: string;
  let doomedDoc: Doc;
  let siblingDoc: Doc;

  let ourSession: string;
  let rivalSessionSamePortalUser: string;

  const deleteDoomed = () => owner.api.delete(`/api/lawfirms/${firm.id}/clients/${doomedClient}`);

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    rival = await createFirm();
    await ownerOf(rival.id);

    // ONE portal identity held by a client of BOTH firms. That is what makes
    // the signing-session sweep a real tenant-scope case: the id genuinely
    // collides, so only `law_firm_id` separates the two sessions.
    ({ uid: portalUid } = await createPortalUser());
    ({ id: doomedClient } = await createPersonClient(firm.id, { userId: portalUid, name: 'Doomed client' }));
    ({ id: siblingClient } = await createPersonClient(firm.id, { name: 'Surviving client' }));
    const { id: rivalClient } = await createPersonClient(rival.id, { userId: portalUid, name: 'Same person, other firm' });

    // The rival's request is for the SAME PERSON through the rival's own client
    // row. It used to be seeded against OUR client id to prove the listener
    // scoped by firm; since migration 0225 the composite key to `clients`
    // refuses that row outright, so the sweep can never reach it and the case
    // that remains is the honest one: the other firm's record of the same
    // human survives our deletion.
    doomedRequest = await seedDocumentRequest(firm.id, doomedClient);
    siblingRequest = await seedDocumentRequest(firm.id, siblingClient);
    rivalRequestForSamePerson = await seedDocumentRequest(rival.id, rivalClient);

    doomedDoc = await seedDoc(firm.id, { clientId: doomedClient }, 'id-card.pdf', 400);
    siblingDoc = await seedDoc(firm.id, { clientId: siblingClient }, 'keep.pdf', 111);
    // The direct-thread attachment folder. It is not part of the browsable tree
    // and has no file row, so files.events is the only thing that reaches it.
    putObject(`${threadPrefix(firm.id, portalUid)}attachment.pdf`, { bytes: 250 });

    doomedLink = await seedShareLink(firm.id, doomedDoc);
    siblingLink = await seedShareLink(firm.id, siblingDoc);

    ourSession = await seedSigningSession(firm.id, portalUid);
    rivalSessionSamePortalUser = await seedSigningSession(rival.id, portalUid);

    await setStorageUsed(firm.id, STARTING_STORAGE_BYTES);
  });

  // RED IF: documentRequests.events drops its CLIENT_DELETED handler, or
  // files.events stops sweeping the client prefix or the direct-thread folder.
  it('removes the client checklists, files and thread attachments, and nobody else\'s', async () => {
    const res = await deleteDoomed();
    await drainEvents();
    expect(res.status).toBe(200);

    expect(await rowExists('document_requests', doomedRequest)).toBe(false);
    expect(objects.has(doomedDoc.objectPath)).toBe(false);
    expect(bucketPaths(threadPrefix(firm.id, portalUid))).toEqual([]);
    expect(await isDead(doomedLink)).toBe(true);
    expect(await rowExists('files', doomedDoc.id)).toBe(false);
    // 400 under the client prefix, 250 in the thread folder.
    expect(await storageUsed(firm.id)).toBe(STARTING_STORAGE_BYTES - 650);

    expect(await rowExists('document_requests', siblingRequest)).toBe(true);
    expect(objects.has(siblingDoc.objectPath)).toBe(true);
    expect(await isDead(siblingLink)).toBe(false);
  });

  // RED IF: signatures.events drops its CLIENT_DELETED handler. Cancelling is
  // what kills the public signing token; without it the link stays live for a
  // client the firm no longer has.
  it('cancels the deleted client open signing sessions', async () => {
    expect(await sessionStatus(ourSession)).toBe('pending');

    const res = await deleteDoomed();
    await drainEvents();
    expect(res.status).toBe(200);

    expect(await sessionStatus(ourSession)).toBe('cancelled');
  });

  // RED IF: `listOpenParticipantSessionsForClient` or `deleteByClientId` loses
  // its `law_firm_id` predicate. Both rival rows carry a genuinely colliding id:
  // the same portal uid, and this firm's client id.
  it('leaves the other firm rows for the same portal user and client id alone', async () => {
    const res = await deleteDoomed();
    await drainEvents();
    expect(res.status).toBe(200);

    expect(await sessionStatus(rivalSessionSamePortalUser)).toBe('pending');
    expect(await rowExists('document_requests', rivalRequestForSamePerson)).toBe(true);
  });

  // RED IF: a CLIENT_DELETED listener is not idempotent under an outbox retry.
  it('is unchanged by a second delivery of the same CLIENT_DELETED payload', async () => {
    const res = await deleteDoomed();
    await drainEvents();
    expect(res.status).toBe(200);

    const payload = emittedPayload(CLIENT_DELETED);
    const afterFirst = await snapshotWorld();

    await redeliver(CLIENT_DELETED, payload);

    expect(await snapshotWorld()).toEqual(afterFirst);
    expect(await storageUsed(firm.id)).toBe(STARTING_STORAGE_BYTES - 650);
  });

  // Until migration 0225 `document_requests.client_id` had no key to `clients`,
  // so the listener was the ONLY thing that removed a deleted client's requests,
  // and this case proved a retry finished the job after the listener failed once.
  // The key is now a composite `on delete cascade`, so the database removes the
  // request the moment the client row goes, listener or no listener. What is
  // left to pin is that: the request is gone even though its listener threw,
  // the failure did not break the delete or the other listeners, and a retry
  // changes nothing because there is nothing left to converge on.
  //
  // RED IF: the cascade is loosened (the request would survive the failed
  // listener), a listener failure surfaces as a non-200, or the retry repeats
  // already-settled files/signatures work.
  it('removes the request at the database even when its listener fails, and a retry is a no-op', async () => {
    const requestsRepo = require('../../src/modules/documentRequests/documentRequests.repository');
    const failing = jest.spyOn(requestsRepo, 'deleteByClientId').mockRejectedValueOnce(
      new Error('deliberate client document-request cleanup failure'),
    );
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await deleteDoomed();
      await drainEvents();
      expect(res.status).toBe(200);

      // Gone despite the listener throwing: the cascade, not the listener, is
      // the guarantee now. The independent files and signing-session listeners
      // have finished their work too.
      expect(await rowExists('document_requests', doomedRequest)).toBe(false);
      expect(objects.has(doomedDoc.objectPath)).toBe(false);
      expect(bucketPaths(threadPrefix(firm.id, portalUid))).toEqual([]);
      expect(await sessionStatus(ourSession)).toBe('cancelled');
      expect(await storageUsed(firm.id)).toBe(STARTING_STORAGE_BYTES - 650);
      const afterFirstAttempt = await snapshotWorld();

      await redeliver(CLIENT_DELETED, emittedPayload(CLIENT_DELETED));

      expect(await rowExists('document_requests', doomedRequest)).toBe(false);
      // Nothing left for the retry to do, and nothing it should redo.
      expect(await snapshotWorld()).toEqual(afterFirstAttempt);
      expect(await storageUsed(firm.id)).toBe(STARTING_STORAGE_BYTES - 650);
    } finally {
      failing.mockRestore();
      quiet.mockRestore();
    }
  });
});

// =========================================================================
// MEMBER_REMOVED
// =========================================================================

describe('MEMBER_REMOVED cascade', () => {
  let firm: Firm;
  let owner: Actor;
  let rival: Firm;
  let rivalOwner: Actor;
  /** In BOTH firms, so every assertion below has a cross-firm twin. */
  let leaverUid: string;
  let stayerUid: string;
  let clientUid: string;

  let ourMatter: string;
  let rivalMatter: string;
  let ourTask: string;
  let rivalTask: string;
  let ourConversation: string;
  let rivalConversation: string;
  /** A group whose only firm-side participant is the leaver. */
  let strandedConversation: string;

  const removeLeaver = () => owner.api.delete(`/api/lawfirms/${firm.id}/members/${leaverUid}`);

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    rival = await createFirm();
    rivalOwner = await ownerOf(rival.id);

    ({ uid: leaverUid } = await createFirmMember(firm.id, { isOwner: false, permissions: [] }));
    // The same person is also a member of the rival firm. `members` has no
    // unique constraint on user_id, and this is the shape a listener that forgot
    // its `law_firm_id` would destroy.
    await testPool.query(
      `insert into members (law_firm_id, user_id, role_id, is_owner, joined_at) values ($1, $2, null, false, now())`,
      [rival.id, leaverUid],
    );
    ({ uid: stayerUid } = await createFirmMember(firm.id, { isOwner: false, permissions: [] }));
    ({ uid: clientUid } = await createPortalUser());

    ourMatter = await seedMatter(firm.id, [owner.uid, leaverUid, stayerUid], 'Our matter');
    rivalMatter = await seedMatter(rival.id, [rivalOwner.uid, leaverUid], 'Their matter');

    ourTask = await seedTask(firm.id, { matterId: ourMatter, assignees: [leaverUid, stayerUid] });
    rivalTask = await seedTask(rival.id, { matterId: rivalMatter, assignees: [leaverUid] });

    ourConversation = await seedGroupConversation(firm.id, [
      { uid: owner.uid, type: 'firm_member' },
      { uid: leaverUid, type: 'firm_member' },
      { uid: stayerUid, type: 'firm_member' },
    ]);
    rivalConversation = await seedGroupConversation(rival.id, [
      { uid: rivalOwner.uid, type: 'firm_member' },
      { uid: leaverUid, type: 'firm_member' },
    ]);
    strandedConversation = await seedGroupConversation(firm.id, [
      { uid: leaverUid, type: 'firm_member' },
      { uid: clientUid, type: 'client' },
    ]);
  });

  // RED IF: matters.events drops either half of its MEMBER_REMOVED work (the
  // `matter_members` delete or the `task_assignees` delete), or either loses its
  // firm scope. `task_assignees` has no `law_firm_id` of its own and is scoped
  // through a subquery on `tasks`, which is exactly where that is easy to lose.
  it('unwinds the leaver matter memberships and task assignments in that firm only', async () => {
    expect(await matterMemberships(leaverUid)).toEqual([firm.id, rival.id].sort());
    expect(await taskAssignments(leaverUid)).toEqual([firm.id, rival.id].sort());

    const res = await removeLeaver();
    await drainEvents();
    expect(res.status).toBe(200);

    expect(await matterMemberships(leaverUid)).toEqual([rival.id]);
    expect(await taskAssignments(leaverUid)).toEqual([rival.id]);

    // The colleague who stayed keeps everything.
    expect(await matterMemberships(stayerUid)).toEqual([firm.id]);
    expect(await taskAssignments(stayerUid)).toEqual([firm.id]);
    // And the matters and tasks themselves are untouched.
    const { rowCount: mattersLeft } = await testPool.query(`select 1 from matters where id = any($1)`, [[ourMatter, rivalMatter]]);
    expect(mattersLeft).toBe(2);
    const { rowCount: tasksLeft } = await testPool.query(`select 1 from tasks where id = any($1)`, [[ourTask, rivalTask]]);
    expect(tasksLeft).toBe(2);
  });

  // RED IF: messaging.events drops its MEMBER_REMOVED handler, or
  // `removeParticipantFromFirmConversations` loses its `law_firm_id` predicate.
  it('soft-removes the leaver from that firm conversations and no other firm', async () => {
    const res = await removeLeaver();
    await drainEvents();
    expect(res.status).toBe(200);

    expect(await activeParticipants(ourConversation)).toEqual([owner.uid, stayerUid].sort());
    expect(await activeParticipants(rivalConversation)).toEqual([rivalOwner.uid, leaverUid].sort());
  });

  /**
   * CHARACTERIZATION, not an endorsement. Nothing in the cascade closes or
   * archives a thread that loses its last firm-side participant: the row stays
   * live and unarchived with only the client on it. This pins today's behaviour
   * so a deliberate change to it shows up as a failing test rather than a silent
   * product decision.
   */
  it('characterization: a conversation left with no firm participant survives, unarchived', async () => {
    const res = await removeLeaver();
    await drainEvents();
    expect(res.status).toBe(200);

    expect(await activeParticipants(strandedConversation)).toEqual([clientUid]);
    const { rows } = await testPool.query(
      `select archived_at from conversations where id = $1`,
      [strandedConversation],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].archived_at).toBeNull();
  });

  // RED IF: a MEMBER_REMOVED listener is not idempotent under an outbox retry.
  // The messaging one is the sharp edge: `set removed_at = now()` without its
  // `removed_at is null` guard would re-stamp the timestamp on every retry.
  it('is unchanged by a second delivery of the same MEMBER_REMOVED payload', async () => {
    const res = await removeLeaver();
    await drainEvents();
    expect(res.status).toBe(200);

    const payload = emittedPayload(MEMBER_REMOVED);
    const afterFirst = await snapshotWorld();

    await redeliver(MEMBER_REMOVED, payload);

    expect(await snapshotWorld()).toEqual(afterFirst);
    // Stated separately: the rival firm's rows are what a second, unscoped pass
    // would take, and a digest match alone would not say which firm survived.
    expect(await matterMemberships(leaverUid)).toEqual([rival.id]);
    expect(await activeParticipants(rivalConversation)).toEqual([rivalOwner.uid, leaverUid].sort());
  });

  // RED IF: the messaging listener misses a member removal and cannot repair
  // its participant roster from the exact same event payload on retry. This
  // listener is independent from the matter/task cleanup on MEMBER_REMOVED.
  it('converges on a retry after firm-conversation participant cleanup fails once', async () => {
    const messagingRepo = require('../../src/modules/messaging/messaging.repository');
    const failing = jest.spyOn(messagingRepo, 'removeParticipantFromFirmConversations').mockRejectedValueOnce(
      new Error('deliberate conversation participant cleanup failure'),
    );
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await removeLeaver();
      await drainEvents();
      expect(res.status).toBe(200);

      // The member/matter work settled, but the failed messaging listener left
      // the departed person visible in this firm's group roster.
      expect(await matterMemberships(leaverUid)).toEqual([rival.id]);
      expect(await taskAssignments(leaverUid)).toEqual([rival.id]);
      expect(await activeParticipants(ourConversation)).toEqual([owner.uid, leaverUid, stayerUid].sort());
      const afterFirstAttempt = await snapshotWorld();

      await redeliver(MEMBER_REMOVED, emittedPayload(MEMBER_REMOVED));

      expect(await activeParticipants(ourConversation)).toEqual([owner.uid, stayerUid].sort());
      expect(await activeParticipants(rivalConversation)).toEqual([rivalOwner.uid, leaverUid].sort());
      const afterConvergence = await snapshotWorld();
      for (const table of Object.keys(afterFirstAttempt)) {
        if (table === 'conversation_participants') continue;
        expect(afterConvergence[table]).toEqual(afterFirstAttempt[table]);
      }
      // Soft removal changes a row rather than deleting it. The stable row
      // count proves retry converged without duplicating a participant record.
      expect(afterConvergence.conversation_participants.count)
        .toBe(afterFirstAttempt.conversation_participants.count);
    } finally {
      failing.mockRestore();
      quiet.mockRestore();
    }
  });
});
