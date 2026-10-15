/**
 * Incremental sync: what a Google push notification does to Paralegix data.
 *
 * `processWatchNotification` is the inbound half of calendar sync, and it is the
 * half that can lose a court date. It reads the user's stored `googleSyncToken`,
 * asks Google only for what changed since, and reconciles each changed event
 * against the local task / external event / `calendar_mappings` chain.
 *
 * Three rules in it are worth more than the rest:
 *
 *   A 410 means the stored sync token is dead and Google will not answer a delta
 *   again until a full re-sync has happened. Getting the recovery wrong strands
 *   the user on a token that can never work.
 *
 *   A TRANSIENT failure (429, 5xx, a retryable Google reason) must THROW, because
 *   throwing is the only thing that makes the webhook route persist a durable
 *   retry. A TERMINAL failure (a permanently bad token) must return instead, or
 *   the sweep retries it forever. The two are one `if` apart and look identical
 *   from the outside, which is exactly why they are pinned separately here.
 *
 *   A CANCELLED event in the delta is the only signal a deletion ever produces.
 *   `syncFromGoogle` lists without `showDeleted` and skips cancelled events, so a
 *   deletion missed here is never seen again and the local event orphans.
 *
 * NO LIVE GOOGLE CALL IS POSSIBLE HERE, for the reason set out at the top of
 * `googleCalendarSync.test.ts`: `globalThis.fetch` is replaced at module load
 * with a router that throws on any url a test did not register, and the first
 * case proves that wall is up.
 */
import {
  installGoogleFetchWall,
  uninstallGoogleFetchWall,
  resetGoogleFetch,
  route,
  callsMatching,
  googleCalls,
  wallIsUp,
  BLOCKED,
} from './support/googleFetch';

installGoogleFetchWall();

import { randomUUID } from 'crypto';

import {
  request,
  testPool,
  createFirm,
  createFirmMember,
  drainEvents,
  type Firm,
} from '../support/setupInProcess';
import { connectGoogle, seedMapping, seedMatterWithEvent } from './support/calendarWorld';

const googleService = require('../../src/modules/calendar/google/google.service');

/** The delta read carries `syncToken=`; the full re-sync read carries `timeMin=`. */
const DELTA = 'syncToken=';
const FULL_SYNC = 'timeMin=';
const INIT_TOKEN = 'maxResults=2500&showDeleted=true';

/** Comfortably newer than any fixture row's `updated_at`, so the inbound event wins
 * the last-writer-wins guard rather than being skipped as stale. */
const FUTURE = '2030-01-01T00:00:00.000Z';

let firm: Firm;

beforeEach(async () => {
  resetGoogleFetch();
  firm = await createFirm();
});

afterEach(async () => {
  await drainEvents();
});

afterAll(() => {
  uninstallGoogleFetchWall();
});

// ── fixtures (plain SQL) ────────────────────────────────────────────────────

async function seedExternalEvent(targetFirm: Firm, googleEventId: string, title: string) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into calendar_events
       (id, stable_id, law_firm_id, title, provider, external_event_id,
        google_event_id, starts_at, source)
     values ($1, $2, $3, $4, 'google', $5, $5, '2026-09-10T14:00:00Z', 'external')`,
    [id, `google_${googleEventId}`, targetFirm.id, title, googleEventId],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function seedChannel(userId: string, opts: { token?: string } = {}) {
  const channelId = `chan-${randomUUID().slice(0, 8)}`;
  const res = await testPool.query(
    `insert into calendar_subscriptions (provider, id, user_id, law_firm_id, calendar_id, resource, secret, expiration)
     values ('google', $1, $2, $3, 'primary', $4, $5, now() + interval '7 days')`,
    [channelId, userId, firm.id, `res-${channelId}`, opts.token ?? 'channel-token'],
  );
  expect(res.rowCount).toBe(1);
  return channelId;
}

const syncTokenOf = async (uid: string) => (await testPool.query(
  `select sync_cursor as google_sync_token from user_oauth_tokens
     where user_id = $1 and provider = 'google'`, [uid],
)).rows[0]?.google_sync_token;

const titleOfMatterEvent = async (eventId: string) => (await testPool.query(
  `select title, status from events where id = $1`, [eventId],
)).rows[0];

/** A confirmed Google event body, newer than anything seeded. */
function googleEvent(id: string, summary: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    summary,
    status: 'confirmed',
    updated: FUTURE,
    start: { dateTime: '2026-09-11T15:00:00Z' },
    end: { dateTime: '2026-09-11T16:00:00Z' },
    ...extra,
  };
}

// ── the wall ────────────────────────────────────────────────────────────────

describe('the network wall', () => {
  /**
   * Goes red if `globalThis.fetch` is no longer replaced or the router stops
   * throwing on an unregistered url. Every "Google was not called" assertion
   * below depends on it, and so does the guarantee that no real refresh token
   * ever leaves this process.
   */
  test('blocks the unrouted delta read and records the attempt', async () => {
    const uid = await connectGoogle(firm);

    expect(wallIsUp()).toBe(true);
    await expect(googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id }))
      .rejects.toThrow(BLOCKED);

    const attempts = callsMatching(DELTA);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].url).toContain('syncToken=token-seed');
    expect(attempts[0].url).toContain('showDeleted=true');
  });
});

// ── sync token lifecycle ────────────────────────────────────────────────────

describe('the sync token', () => {
  /**
   * Goes red if the delta stops persisting `nextSyncToken`, which would make
   * every later notification re-request the same window and re-process events
   * that were already handled.
   */
  test('advances to the token the delta returns', async () => {
    const uid = await connectGoogle(firm, { syncToken: 'token-old' });

    route(DELTA, { status: 200, json: { items: [], nextSyncToken: 'token-new' } });

    await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });

    expect(callsMatching('syncToken=token-old')).toHaveLength(1);
    expect(await syncTokenOf(uid)).toBe('token-new');
  });

  /**
   * A user with no stored token has never had a delta baseline, so the only
   * correct answer is the full one-year window.
   *
   * Goes red if the `if (!syncToken)` fallback is removed: the delta read would
   * be issued with an empty token, which Google answers with a 400 that this
   * service classifies as terminal and silently drops. Also red if the fallback
   * stops seeding a token, which leaves every later notification on a full
   * one-year re-read.
   */
  test('falls back to a full sync when no token is stored, and seeds one', async () => {
    const uid = await connectGoogle(firm, { syncToken: null });

    route(INIT_TOKEN, { status: 200, json: { items: [], nextSyncToken: 'token-seeded' } });
    route(FULL_SYNC, {
      status: 200,
      json: { items: [googleEvent('g-first', 'First sync event')] },
    });

    await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });

    expect(callsMatching(DELTA)).toHaveLength(0);
    expect(callsMatching(FULL_SYNC)).toHaveLength(1);
    const { rows } = await testPool.query(
      `select title from calendar_events where law_firm_id = $1`, [firm.id],
    );
    expect(rows.map((r) => r.title)).toEqual(['First sync event']);
    expect(await syncTokenOf(uid)).toBe('token-seeded');
  });

  /**
   * Google puts `nextSyncToken` only on the LAST page of a listing; every page
   * before it carries `nextPageToken` instead. A calendar holding more events
   * than one page therefore answers the first read with no token at all.
   *
   * Goes red if the token read stops following `nextPageToken`: nothing is
   * stored, and the user never gets an incremental sync.
   */
  test('reads every page of the calendar to reach the token', async () => {
    const uid = await connectGoogle(firm, { syncToken: null });

    route(INIT_TOKEN, [
      { status: 200, json: { items: [googleEvent('g-one', 'One')], nextPageToken: 'page-2' } },
      { status: 200, json: { items: [], nextSyncToken: 'token-from-last-page' } },
    ]);
    route(FULL_SYNC, { status: 200, json: { items: [] } });

    await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });

    const reads = callsMatching(INIT_TOKEN);
    expect(reads).toHaveLength(2);
    expect(reads[1].url).toContain('pageToken=page-2');
    expect(await syncTokenOf(uid)).toBe('token-from-last-page');
  });

  /**
   * Google answers 410 when the stored token has aged out. Recovery is three
   * steps and all three matter: clear the dead token, run a full re-sync, then
   * obtain a fresh token so the NEXT notification can be incremental again.
   *
   * Goes red if any of the three is dropped. Losing the re-init in particular is
   * invisible in the moment and permanently downgrades that user to a full
   * one-year read on every push.
   */
  test('recovers from an expired sync token with a full re-sync and a fresh token', async () => {
    const uid = await connectGoogle(firm, { syncToken: 'token-dead' });

    route(DELTA, {
      status: 410,
      text: '{"error":{"code":410,"errors":[{"reason":"fullSyncRequired"}]}}',
    });
    route(FULL_SYNC, {
      status: 200,
      json: { items: [googleEvent('g-resynced', 'Recovered event')] },
    });
    route(INIT_TOKEN, { status: 200, json: { items: [], nextSyncToken: 'token-reissued' } });

    await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });

    expect(callsMatching(FULL_SYNC)).toHaveLength(1);
    expect(callsMatching(INIT_TOKEN)).toHaveLength(1);
    expect(await syncTokenOf(uid)).toBe('token-reissued');

    const { rows } = await testPool.query(
      `select title from calendar_events where law_firm_id = $1`, [firm.id],
    );
    expect(rows.map((r) => r.title)).toEqual(['Recovered event']);
  });
});

// ── the page cap ─────────────────────────────────────────────────────────────

describe('the delta page cap', () => {
  /**
   * A provider that keeps answering with a `nextPageToken` and never a
   * `nextSyncToken` should not happen, but a delta large enough to look that
   * way (or a genuine provider bug) must not hold the webhook handler open
   * forever. `MAX_DELTA_PAGES` in `processWatchNotificationUnlocked` is the
   * safety stop; this proves it actually fires rather than existing only as a
   * comment.
   *
   * Goes red if the `pageCount < MAX_DELTA_PAGES` condition is removed or
   * loosened: the loop would keep calling Google past the documented cap of
   * 50, or forever.
   */
  test('stops paging a delta that never terminates at the documented cap', async () => {
    const uid = await connectGoogle(firm, { syncToken: 'token-runaway' });

    route(DELTA, (_call, hit) => ({
      status: 200,
      json: {
        // Every page reports more to fetch and never a nextSyncToken, modeling
        // a delta so large - or a provider bug - that it would otherwise page
        // forever.
        nextPageToken: `page-${hit + 1}`,
        items: [googleEvent(`g-runaway-${hit}`, `Runaway ${hit}`)],
      },
    }));

    await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });

    // Exactly the documented cap, not "at least" or "some large number" -
    // proves the loop condition itself stops it rather than an unrelated
    // timeout or crash cutting the run short.
    expect(callsMatching(DELTA)).toHaveLength(50);

    // No nextSyncToken was ever returned, so the stored token must be
    // untouched: advancing it here would silently skip whatever the cap left
    // unread on the NEXT notification instead of resuming from the same point.
    expect(await syncTokenOf(uid)).toBe('token-runaway');

    // The events collected across all 50 pages before the cap tripped still
    // get processed - the cap bounds the READ loop, not the work done with
    // what it already fetched. A count short of 50 would mean the cap is
    // silently discarding fetched pages instead of only stopping further reads.
    const { rows } = await testPool.query(
      `select count(*)::int as n from calendar_events where law_firm_id = $1`, [firm.id],
    );
    expect(rows[0].n).toBe(50);
  });
});

// ── transient versus terminal failure ───────────────────────────────────────

describe('failed delta reads', () => {
  /**
   * Throwing is not incidental here: it is the signal the webhook route watches
   * for when it decides whether to persist a `calendar_sync_failures` row. A
   * rate-limited read that returned quietly would drop the user's change with
   * nothing queued to recover it.
   *
   * Goes red if 429 (or any 5xx) stops being classified as retryable.
   */
  test('throws on a rate-limited read so the webhook route can queue a retry', async () => {
    const uid = await connectGoogle(firm, { syncToken: 'token-live' });

    route(DELTA, {
      status: 429,
      text: '{"error":{"code":429,"errors":[{"reason":"rateLimitExceeded"}]}}',
    });

    await expect(googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id }))
      .rejects.toThrow('Google incremental sync failed: 429');

    // The token is untouched, so the retry resumes from the same delta point.
    expect(await syncTokenOf(uid)).toBe('token-live');
  });

  /**
   * The other side of the same `if`. A 403 that is not a rate limit is a
   * permanently bad grant, and retrying it forever would burn the sweep's budget
   * on a user who has to reconnect by hand.
   *
   * Goes red if the terminal branch starts throwing (the retry loop returns) or
   * if the retryable set widens to include plain 403.
   */
  test('returns quietly on a terminal auth failure so it is not retried forever', async () => {
    const uid = await connectGoogle(firm, { syncToken: 'token-live' });

    // Answered twice: `makeGoogleApiCall` treats a non-rate-limit 403 as an auth
    // failure and retries once after refreshing, so the service sees the 403 the
    // second time and classifies it.
    route(DELTA, {
      status: 403,
      text: '{"error":{"code":403,"errors":[{"reason":"forbidden"}]}}',
    });
    route('oauth2.googleapis.com/token', { status: 200, json: { access_token: 'fresh' } });

    await expect(googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id }))
      .resolves.toBeUndefined();

    expect(await syncTokenOf(uid)).toBe('token-live');
  });
});

// ── reconciling changed events ──────────────────────────────────────────────

describe('the changed-event delta', () => {
  /**
   * A cancelled event is the only deletion signal inbound sync ever gets.
   *
   * Goes red if the `status === 'cancelled'` branch stops calling
   * `processInboundDelete`: the local event would survive a deletion made in
   * Google and no later sync would notice, because the full re-sync path never
   * asks for deleted events.
   */
  test('deletes the local external event when Google reports it cancelled', async () => {
    const uid = await connectGoogle(firm, { syncToken: 'token-live' });
    await seedExternalEvent(firm, 'g-cancelled', 'Deposition');
    await seedExternalEvent(firm, 'g-kept', 'Status conference');

    route(DELTA, {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [
          { id: 'g-cancelled', status: 'cancelled' },
          googleEvent('g-kept', 'Status conference'),
        ],
      },
    });

    await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });

    // The surviving sibling proves the delta was processed, so the missing row
    // is the cancellation being applied rather than nothing having run.
    const { rows } = await testPool.query(
      `select google_event_id from calendar_events where law_firm_id = $1`, [firm.id],
    );
    expect(rows.map((r) => r.google_event_id)).toEqual(['g-kept']);
  });

  /**
   * One event edited twice before the read appears on both delta pages. Only the
   * newest state should be applied, and only once.
   *
   * Goes red if the `latestById` dedupe is removed: the earlier copy would be
   * processed after the later one and the local title would end up as the stale
   * value asserted against below.
   */
  test('keeps only the last copy of an event repeated across delta pages', async () => {
    const uid = await connectGoogle(firm, { syncToken: 'token-live' });
    await seedExternalEvent(firm, 'g-edited', 'Original title');

    route(DELTA, (call, hit) => (hit === 0
      ? {
        status: 200,
        json: {
          nextPageToken: 'page-2',
          items: [googleEvent('g-edited', 'First edit')],
        },
      }
      : {
        status: 200,
        json: {
          nextSyncToken: 'token-after',
          items: [googleEvent('g-edited', 'Second edit')],
        },
      }));

    await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });

    expect(callsMatching('pageToken=page-2')).toHaveLength(1);
    const { rows } = await testPool.query(
      `select title from calendar_events where law_firm_id = $1`, [firm.id],
    );
    expect(rows.map((r) => r.title)).toEqual(['Second edit']);
  });

  /**
   * The inbound toggle gates the whole notification, not just the write.
   *
   * Goes red if the `allowGoogleToParalegixSync` check moves below the delta
   * read. The second user, on the same fixture with the flag on, is what makes
   * the absence for the first one meaningful.
   */
  test('ignores a notification for a user who disabled inbound sync', async () => {
    const off = await connectGoogle(firm, { inbound: false });
    const on = await connectGoogle(firm, { inbound: true });

    route(DELTA, { status: 200, json: { items: [], nextSyncToken: 'token-after' } });

    await googleService.processWatchNotification({ userId: off, lawFirmId: firm.id });
    expect(googleCalls()).toHaveLength(0);

    await googleService.processWatchNotification({ userId: on, lawFirmId: firm.id });
    expect(callsMatching(DELTA)).toHaveLength(1);
  });
});

// ── firm scoping on the mapping read ────────────────────────────────────────

describe('mapping resolution across firms', () => {
  /**
   * `calendar_mappings` is keyed by `(provider, external_event_id)` and read with
   * NO firm predicate, deliberately: one person can belong to several firms and
   * share a single Google calendar between them, so the mapping's own firm is
   * treated as authoritative over the firm that happens to own the watch channel.
   *
   * The mapping branch holds the syncing user to the same write access a
   * Paralegix edit needs, in the mapping's firm. This case measures that: a
   * user who belongs only to firm A processes a delta containing an event id
   * whose mapping belongs to firm B, and the assertion is that B's row did not
   * move.
   *
   * Goes red if the access check is dropped from the mapping branch.
   */
  test('refuses an inbound edit from a user who is not a member of the mapping firm', async () => {
    const otherFirm = await createFirm({ name: 'Unrelated Firm' });
    const outsiderUid = await connectGoogle(firm, { syncToken: 'token-live' });
    const { matterId, eventId } = await seedMatterWithEvent(otherFirm, 'Firm B hearing');
    const { uid: otherFirmUser } = await createFirmMember(otherFirm.id, { isOwner: true });

    await seedMapping({
      externalEventId: 'evt-shared',
      lawFirmId: otherFirm.id,
      userId: otherFirmUser,
      entityId: eventId,
      scopeId: matterId,
    });

    // Membership is one-way: the syncing user belongs to `firm`, not `otherFirm`.
    const { rows: membership } = await testPool.query(
      `select 1 from members where law_firm_id = $1 and user_id = $2`,
      [otherFirm.id, outsiderUid],
    );
    expect(membership).toHaveLength(0);

    route(DELTA, {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [googleEvent('evt-shared', 'Renamed from another calendar')],
      },
    });

    await googleService.processWatchNotification({ userId: outsiderUid, lawFirmId: firm.id });

    expect(callsMatching(DELTA)).toHaveLength(1);
    expect(await titleOfMatterEvent(eventId)).toMatchObject({
      title: 'Firm B hearing',
    });
  });

  /**
   * The counterpart on the create path, where a membership check DOES exist. A
   * brand-new external event (no task, no existing row, no mapping) is only
   * written after `membersRepo.findByUserId` confirms the user belongs to the
   * firm the notification named.
   *
   * Goes red if that check is dropped, since the outsider's event would then
   * create a row in a firm they have no relationship with. The member half of
   * the case proves the same payload does produce a row when membership holds.
   */
  test('creates a new external event only for a firm the user belongs to', async () => {
    const outsiderFirm = await createFirm({ name: 'Outsider Firm' });
    const outsider = await connectGoogle(outsiderFirm, { syncToken: 'token-live' });
    const member = await connectGoogle(firm, { syncToken: 'token-live' });

    route(DELTA, {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [googleEvent('g-unmapped', 'Unmapped external event')],
      },
    });

    // The outsider is a member of `outsiderFirm`, but the notification names `firm`.
    await googleService.processWatchNotification({ userId: outsider, lawFirmId: firm.id });
    expect(callsMatching(DELTA)).toHaveLength(1);
    expect((await testPool.query(
      `select id from calendar_events where law_firm_id = $1`, [firm.id],
    )).rowCount).toBe(0);

    await googleService.processWatchNotification({ userId: member, lawFirmId: firm.id });
    const { rows } = await testPool.query(
      `select title, created_by from calendar_events where law_firm_id = $1`, [firm.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Unmapped external event', created_by: member });
  });
});

// ── the webhook endpoint's own guards ───────────────────────────────────────

describe('POST /api/webhooks/google-calendar', () => {
  // No auth header: the route mounts no auth middleware, because Google cannot
  // present one. The channel row and its secret are the whole gate.
  const notify = (headers: Record<string, string>) => request()
    .post('/api/webhooks/google-calendar')
    .set(headers)
    .send();

  /**
   * The route carries no auth middleware, because Google cannot present a bearer
   * token. The channel row and its per-channel secret are the whole gate.
   *
   * Goes red if the response for an unknown channel stops being a 200. That
   * status is deliberate and load-bearing in the other direction from the usual:
   * anything else makes Google retry the notification, and a channel that keeps
   * answering with an error is eventually dropped at Google's end, which takes
   * the firm's sync down silently.
   *
   * It does NOT go red if the `if (!channelData)` guard alone is deleted, and
   * that is not a gap the test can close: the user id a sync would run under
   * comes from the missing row, so removing the guard only moves the failure to
   * a TypeError one line later that the route's own catch turns back into a 200.
   * The direct call at the end proves the fixture does reach Google when a
   * channel exists, so the empty call list above is not an artefact of a route
   * that never ran.
   */
  test('acknowledges an unknown channel without syncing anything', async () => {
    const uid = await connectGoogle(firm, { syncToken: 'token-live' });
    route(DELTA, { status: 200, json: { items: [], nextSyncToken: 'token-after' } });

    const res = await notify({
      'x-goog-channel-id': 'chan-nobody-registered',
      'x-goog-resource-state': 'exists',
      'x-goog-channel-token': 'anything',
    });
    expect(res.status).toBe(200);
    expect(googleCalls()).toHaveLength(0);

    await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });
    expect(callsMatching(DELTA)).toHaveLength(1);
  });

  /**
   * Goes red if `tokensMatch` starts accepting a mismatch, which would let
   * anyone who learns a channel id drive that firm's sync.
   */
  test('ignores a notification whose channel token does not match', async () => {
    const uid = await connectGoogle(firm, { syncToken: 'token-live' });
    const channelId = await seedChannel(uid, { token: 'the-real-secret' });
    route(DELTA, { status: 200, json: { items: [], nextSyncToken: 'token-after' } });

    const res = await notify({
      'x-goog-channel-id': channelId,
      'x-goog-resource-state': 'exists',
      'x-goog-channel-token': 'the-wrong-secret',
    });
    expect(res.status).toBe(200);
    expect(googleCalls()).toHaveLength(0);

    await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });
    expect(callsMatching(DELTA)).toHaveLength(1);
  });

  /**
   * The `sync` handshake Google sends the moment a channel is created carries no
   * change, and answering it with a delta read would waste a request per channel
   * creation.
   *
   * Goes red if the `resourceState === 'sync'` short-circuit is removed.
   */
  test('acknowledges the initial sync handshake without reading a delta', async () => {
    const uid = await connectGoogle(firm, { syncToken: 'token-live' });
    const channelId = await seedChannel(uid, { token: 'the-real-secret' });
    route(DELTA, { status: 200, json: { items: [], nextSyncToken: 'token-after' } });

    const res = await notify({
      'x-goog-channel-id': channelId,
      'x-goog-resource-state': 'sync',
      'x-goog-channel-token': 'the-real-secret',
    });
    expect(res.status).toBe(200);
    expect(googleCalls()).toHaveLength(0);

    await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });
    expect(callsMatching(DELTA)).toHaveLength(1);
  });

  describe('a channel whose earlier stop failed', () => {
    const STOP = 'channels/stop';

    /**
     * The `calendar_subscriptions` row is gone, so the only record of the
     * channel is the stop-retry row. Seeded dead-lettered and not due, so the
     * cron sweep would never try it again.
     */
    async function seedUnstopped(uid: string, channelId: string, resourceId: string) {
      const res = await testPool.query(
        `insert into calendar_sync_failures
           (kind, dedupe_key, provider, payload, user_id, law_firm_id, expires_at, attempts, next_attempt_at)
         values ('stop_channel', $1, 'google', jsonb_build_object('resourceId', $2::text), $3, $4,
                 now() + interval '3 days', 10, now() + interval '6 hours')`,
        [channelId, resourceId, uid, firm.id],
      );
      expect(res.rowCount).toBe(1);
    }

    const stopRows = async () => (await testPool.query(
      `select dedupe_key from calendar_sync_failures where kind = 'stop_channel'`,
    )).rows;

    /**
     * A notification on it is proof Google is still pushing. It must be stopped
     * then, with the owner's token, and never synced.
     *
     * Goes red if the route goes back to acknowledging an unknown channel and
     * nothing else: no stop request is made and the retry row survives.
     */
    test('stops the channel and drops its retry row without syncing', async () => {
      const uid = await connectGoogle(firm, { syncToken: 'token-live' });
      await seedUnstopped(uid, 'chan-stuck-1', 'res-stuck-1');
      route(STOP, { status: 204 }, { method: 'POST' });

      const res = await notify({
        'x-goog-channel-id': 'chan-stuck-1',
        'x-goog-resource-id': 'res-stuck-1',
        'x-goog-resource-state': 'exists',
        'x-goog-channel-token': 'anything',
      });
      expect(res.status).toBe(200);

      const stops = callsMatching(STOP);
      expect(stops).toHaveLength(1);
      expect(stops[0].body).toEqual({ id: 'chan-stuck-1', resourceId: 'res-stuck-1' });
      expect(stops[0].bearer).toBe('access-seed');
      expect(callsMatching(DELTA)).toHaveLength(0);
      expect(await stopRows()).toHaveLength(0);
    });

    /**
     * Only the resource the channel was recorded against may trigger a stop,
     * so a forged notification that guesses a stuck channel id cannot drive
     * requests to Google.
     *
     * Goes red if the resource check is dropped: a stop is attempted for the
     * forged notification.
     */
    test('ignores a notification naming a different resource', async () => {
      const uid = await connectGoogle(firm, { syncToken: 'token-live' });
      await seedUnstopped(uid, 'chan-stuck-2', 'res-stuck-2');
      route(STOP, { status: 204 }, { method: 'POST' });

      const res = await notify({
        'x-goog-channel-id': 'chan-stuck-2',
        'x-goog-resource-id': 'res-forged',
        'x-goog-resource-state': 'exists',
        'x-goog-channel-token': 'anything',
      });
      expect(res.status).toBe(200);
      expect(googleCalls()).toHaveLength(0);
      expect(await stopRows()).toHaveLength(1);
    });

    /**
     * Google refusing the stop again leaves the row for the sweep and still
     * answers 200, so Google does not retry the notification.
     *
     * Goes red if a refused stop resolves the row, losing the only record of a
     * channel that is still live.
     */
    test('keeps the retry row when Google refuses the stop again', async () => {
      const uid = await connectGoogle(firm, { syncToken: 'token-live' });
      await seedUnstopped(uid, 'chan-stuck-3', 'res-stuck-3');
      route(STOP, { status: 503, text: '{"error":{"code":503}}' }, { method: 'POST' });

      const res = await notify({
        'x-goog-channel-id': 'chan-stuck-3',
        'x-goog-resource-id': 'res-stuck-3',
        'x-goog-resource-state': 'exists',
        'x-goog-channel-token': 'anything',
      });
      expect(res.status).toBe(200);
      expect(callsMatching(STOP)).toHaveLength(1);
      expect(await stopRows()).toHaveLength(1);
    });
  });
});

export {};
