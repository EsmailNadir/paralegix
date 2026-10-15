import { createHash } from 'crypto';
import { withLock } from '../../shared/database/advisoryLock';
import { onShutdown } from '../../shared/utils/shutdownHooks';
const repo = require('./shareNotifications.repository');
const notificationsRepo = require('../notifications/notifications.repository');
const { sendFileSharedDigestEmail } = require('../../shared/services/emailService');
const { shouldSendClientEmail, EMAIL_CATEGORIES } = require('../../shared/services/emailPreferences');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Trailing-edge debounce: a share schedules a flush this far in the future, and
// each further share to the same client pushes it back — so a burst of shares in
// one sitting collapses into ONE digest ~1 min after the last one. The max-wait
// caps how long a continuous stream can defer delivery.
const DEBOUNCE_MS = Number(process.env.SHARE_DIGEST_DEBOUNCE_MS || 60 * 1000);
const MAX_WAIT_MS = Number(process.env.SHARE_DIGEST_MAX_WAIT_MS || 5 * 60 * 1000);
// How many file names to spell out in the digest before "+N more".
const MAX_NAMED_ITEMS = 5;

// One pending flush timer per (firm, client). Value:
// { timer, firstScheduledAt }. In-memory only; the DB `file_client_access`
// rows are the source of truth and the startup sweep reschedules after a restart.
const timers = new Map();
const inFlight = new Set<Promise<void>>();
const keyOf = (lawFirmId: string, clientUserId: string) => `${lawFirmId}:${clientUserId}`;

/**
 * Handle a FILE_SHARED event: work out which clients newly gained access, buffer
 * a pending row for each, and (re)schedule their digest flush. Persists the
 * notification buffer before scheduling delivery.
 */
export async function onFileShared(payload: any) {
  const {
    lawFirmId, scopeType, matterId, taskId, clientId, newVisibleClientIds, sharedByUserId,
  } = payload || {};

  /**
   * One event can carry a whole batch (`PATCH /bulk-client-visibility`) or a
   * single file (`PATCH /client-visibility`), so both shapes are normalized to a
   * list here. That is what keeps the scope lookup below at one query per EVENT
   * rather than one per file: a batched share that emitted per file would put
   * the round trips it removed from the request straight back on this side of
   * the bus.
   *
   * The share transition is per file (`wasVisible` and the audience it already
   * had), because a selection routinely mixes files that were already shared
   * with files that were not.
   */
  const shared = (Array.isArray(payload?.files) && payload.files.length > 0
    ? payload.files
    : [{
      fileId: payload?.fileId,
      fileName: payload?.fileName,
      isFolder: payload?.isFolder,
      wasVisible: payload?.wasVisible,
      prevVisibleClientIds: payload?.prevVisibleClientIds,
    }]
  ).filter((item: any) => item && item.fileId);
  if (!lawFirmId || !scopeType || shared.length === 0) return;

  const resolved = await repo.resolveScopeClients(lawFirmId, { scopeType, matterId, taskId, clientId });
  if (!resolved.length) return;

  // A restriction list of null means "every client on the scope".
  const inAllowed = (cid: any, allowed: any) => allowed === null || allowed.includes(cid);
  const newAllowed = newVisibleClientIds || null;

  const scopeId = scopeType === 'matter' ? matterId : scopeType === 'task' ? taskId : clientId;
  const pending: any[] = [];
  const toFlush = new Set<string>();

  for (const item of shared) {
    const prevAllowed = item.wasVisible ? (item.prevVisibleClientIds || null) : null;
    const recipients = resolved.filter((c: any) =>
      inAllowed(c.clientId, newAllowed) && !(item.wasVisible && inAllowed(c.clientId, prevAllowed)),
    );
    for (const c of recipients) {
      pending.push({
        clientUserId: c.userId,
        fileId: item.fileId,
        fileName: item.fileName || 'a document',
        scopeType,
        scopeId,
        isFolder: !!item.isFolder,
        emailEnabled: c.emailEnabled !== false,
        sharedBy: sharedByUserId || null,
      });
      toFlush.add(c.userId);
    }
  }
  if (pending.length === 0) return;

  await repo.enqueuePending(lawFirmId, pending, payload.sharedAt ? new Date(payload.sharedAt) : new Date());

  // One flush per client however many of their files this event carried: the
  // digest is per client, and scheduling it twice only pushes it back.
  for (const userId of toFlush) scheduleFlush(lawFirmId, userId);
}

/**
 * Debounced schedule. Resets the client's flush timer on each new share, unless
 * the oldest still-pending share has already waited MAX_WAIT_MS, in which case we
 * flush promptly so a long continuous stream can't defer delivery forever.
 */
function scheduleFlush(lawFirmId: string, clientUserId: string) {
  const key = keyOf(lawFirmId, clientUserId);
  const now = Date.now();
  const existing = timers.get(key);

  if (existing) {
    if (now - existing.firstScheduledAt >= MAX_WAIT_MS) {
      clearTimeout(existing.timer);
      timers.delete(key);
      runFlush(lawFirmId, clientUserId);
      return;
    }
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => runFlush(lawFirmId, clientUserId), DEBOUNCE_MS);
    if (existing.timer.unref) existing.timer.unref();
    return;
  }

  const timer = setTimeout(() => runFlush(lawFirmId, clientUserId), DEBOUNCE_MS);
  if (timer.unref) timer.unref();
  timers.set(key, { timer, firstScheduledAt: now });
}

function runFlush(lawFirmId: string, clientUserId: string) {
  const key = keyOf(lawFirmId, clientUserId);
  const scheduled = timers.get(key);
  if (scheduled) clearTimeout(scheduled.timer);
  timers.delete(key);
  const delivery = flushClient(lawFirmId, clientUserId).catch((err) => {
    console.error('shareNotifications: flush failed:', err.message);
  });
  inFlight.add(delivery);
  void delivery.finally(() => inFlight.delete(delivery));
  return delivery;
}

/** Drain debounced and running deliveries before shutdown or database teardown. */
export async function drainPendingFlushes() {
  while (timers.size || inFlight.size) {
    for (const key of [...timers.keys()]) {
      const separator = key.indexOf(':');
      runFlush(key.slice(0, separator), key.slice(separator + 1));
    }
    await Promise.all([...inFlight]);
  }
}

onShutdown('file-share-digests', drainPendingFlushes);

/**
 * Deliver one client's buffered shares as a single digest: one in-app bell item
 * plus (if we have an email) one digest email. A per-client lease serializes
 * delivery; rows stay pending until both channels succeed.
 */
export async function flushClient(lawFirmId: string, clientUserId: string) {
  return withLock('HOUSEKEEPING', `share-digest:${lawFirmId}:${clientUserId}`,
    () => deliverClient(lawFirmId, clientUserId), { maxHoldMs: 5 * 60 * 1000 });
}

async function deliverClient(lawFirmId: string, clientUserId: string) {
  const rows = await repo.claimPendingForClient(lawFirmId, clientUserId);
  if (!rows.length) return;

  const [contact, firmName] = await Promise.all([
    repo.getClientContact(lawFirmId, clientUserId),
    repo.getFirmName(lawFirmId),
  ]);

  const digestId = createHash('sha256').update(rows.map((row: any) =>
    `${row.id}:${row.shared_at}`).sort().join('|')).digest('hex');
  const count = rows.length;
  const firm = firmName || 'Your law firm';
  const items = rows.map((r: any) => ({ name: r.file_name, isFolder: r.is_folder }));

  // Deep-link to the portal Documents view; when it's a single item, land the
  // client right on it via ?highlight.
  const base = `${FRONTEND_URL}/client/lawfirm/${lawFirmId}/documents`;
  const deepLink = count === 1
    ? `${base}?highlight=${encodeURIComponent(rows[0].object_path)}`
    : base;

  const noun = count === 1 ? (rows[0].is_folder ? 'a folder' : 'a document') : `${count} new documents`;
  const title = `${firm} shared ${noun} with you`;
  const named = items.slice(0, MAX_NAMED_ITEMS).map((i: any) => i.name);
  const extra = count - named.length;
  const body = named.join(', ') + (extra > 0 ? ` and ${extra} more` : '');

  await notificationsRepo.create(lawFirmId, clientUserId, {
    type: 'file_shared', title, body, entityType: 'file', entityId: null,
    matterId: allSameMatter(rows), actionUrl: deepLink,
    createdBy: rows[0].shared_by || null,
    eventId: `file-share-digest:${digestId}`,
  });

  // Digest email, subject to the portal's "Email me when a file is shared"
  // toggle and the firm's master switch. The in-app bell above is deliberately
  // NOT gated: it costs the client nothing and is the record that the share
  // happened.
  const emailAllowed = rows.some((row: any) => row.email_enabled !== false) && contact && contact.email
    ? await shouldSendClientEmail({
      lawFirmId,
      clientUserId,
      category: EMAIL_CATEGORIES.FILE_SHARED,
    })
    : false;

  // A provider refusal leaves the durable buffer available for a later retry.
  if (emailAllowed) {
    const delivery = await sendFileSharedDigestEmail({
      recipientEmail: contact.email,
      recipientName: contact.name,
      lawFirmName: firm,
      count,
      items,
      portalUrl: deepLink,
      idempotencyKey: `file-share-digest/${digestId}`,
    });
    if (!delivery.sent) throw new Error('File-share digest email was not delivered');
  }

  await repo.markNotified(lawFirmId, rows);
}

/** When every claimed row is under the same matter, tag the bell item with it. */
function allSameMatter(rows: any) {
  const matterIds = rows.filter((r: any) => r.scope_type === 'matter').map((r: any) => r.scope_id);
  if (matterIds.length !== rows.length || !matterIds.length) return null;
  return matterIds.every((m: any) => m === matterIds[0]) ? matterIds[0] : null;
}

/**
 * On boot, reschedule flushes for any clients left with unsent rows by a previous
 * process (a crash/restart between enqueue and flush). Staggered so a large
 * backlog doesn't fan out all at once. Deferred so the DB pool is warm first.
 */
export function startupSweep() {
  // Not scheduled under test. This fires ten seconds after module load, and the
  // app is loaded once per Jest worker, so in any suite that runs longer than
  // that the timer lands in the middle of an unrelated spec file: it does
  // database work against a pool that spec is about to close, and its deferred
  // `require` throws "after the Jest environment has been torn down". The
  // visible symptom is a "socket hang up" on whatever request was in flight,
  // which reads as a bug in that request.
  //
  // `.unref()` below stops the timer holding the event loop open; it does not
  // stop it firing. The function stays exported and callable, so a spec that
  // wants to exercise the sweep still can, deliberately, the way
  // `RATE_LIMITS_DISABLED` leaves the limiters assertable.
  if (process.env.NODE_ENV === 'test') return;

  setTimeout(async () => {
    try {
      // Gated across instances. This runs at module load on EVERY instance boot
      // and lists pending digests platform-wide, so without the lock a deploy or
      // a scale-out event has N instances each scheduling the same flushes ten
      // seconds later. Per-client delivery leases serialize those sends,
      // but duplicate scheduling would still waste work.
      const { tryLock } = require('../../shared/database/advisoryLock');
      const outcome = await tryLock('HOUSEKEEPING', 'share-notifications-startup-sweep', async () => {
        const pending = await repo.listPendingClients();
        pending.forEach((p: any, i: any) => {
          const key = keyOf(p.lawFirmId, p.clientUserId);
          if (timers.has(key)) return;
          const timer = setTimeout(() => runFlush(p.lawFirmId, p.clientUserId), i * 250);
          timer.unref?.();
          timers.set(key, { timer, firstScheduledAt: Date.now() });
        });
        return pending.length;
      });
      if (!outcome.acquired) return;
      if (outcome.result) {
        console.log(`[shareNotifications] startup sweep scheduled ${outcome.result} pending digest(s)`);
      }
    } catch (err: any) {
      console.error('shareNotifications: startup sweep failed:', err.message);
    }
  }, 10 * 1000).unref?.();
}

/**
 * Cron backstop: flush any client whose debounce window expired without firing.
 *
 * Bounded, because it fans out one digest send per client and each send is SMTP
 * plus database reads. Returns a small summary for the cron response.
 */
export async function flushExpiredDebounces() {
  const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');
  // A grace margin over the debounce so this never races a timer about to fire.
  const stale = await repo.listClientsWithExpiredDebounce(DEBOUNCE_MS * 2);
  if (!stale.length) return { flushed: 0 };
  const settled = await runWithConcurrency(
    stale.map((p: any) => () => flushClient(p.lawFirmId, p.clientUserId)),
    4,
  );
  return {
    candidates: stale.length,
    flushed: settled.filter((r: any) => r.status === 'fulfilled').length,
    failed: settled.filter((r: any) => r.status === 'rejected').length,
  };
}
