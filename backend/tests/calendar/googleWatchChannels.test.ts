/**
 * The Google watch-channel lifecycle in `calendar/google/google.service.ts`.
 *
 * A watch channel is the subscription that makes a firm's calendar changes
 * arrive at all. It carries a seven-day ttl, so the whole feature depends on a
 * cron renewing channels before they lapse, and on the stop half of that renewal
 * actually taking effect at Google.
 *
 * The stop half is the part with teeth. `calendar_subscriptions` holds the ONLY
 * copy of the channel id and resource id that `channels/stop` needs, and the row
 * is deleted after every stop attempt whether the stop worked or not, because a
 * renewal is replacing it. So a failed stop that is not written down anywhere is
 * unrecoverable: Google keeps pushing to a channel nothing can address, and the
 * user's live channel count grows by one on every failed renewal until the ttl
 * expires. `calendar_sync_failures` (kind 'stop_channel') is that write-down, and most of
 * the cases below exist to pin when a row lands in it and when it must not.
 *
 * NO LIVE GOOGLE CALL IS POSSIBLE HERE, for the reason set out at the top of
 * `googleCalendarSync.test.ts`: `globalThis.fetch` is replaced at module load
 * with a router that throws on any url a test did not register. The first case
 * proves that wall is up, because every "Google was not called" assertion in
 * this file is worthless without it.
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
  testPool,
  createFirm,
  createFirmMember,
  drainEvents,
  type Firm,
} from '../support/setupInProcess';

const googleService = require('../../src/modules/calendar/google/google.service');
const calendarSyncRepo = require('../../src/modules/calendar/shared/calendarSync.repository');

const WATCH_URL = '/events/watch';
const STOP_URL = 'channels/stop';

let firm: Firm;
let originalWebhookBase: string | undefined;

/**
 * `createWatchChannel` refuses to run without an https webhook base, which is
 * the correct production guard and would otherwise make every case here a no-op.
 */
beforeAll(() => {
  originalWebhookBase = process.env.WEBHOOK_BASE_URL;
  process.env.WEBHOOK_BASE_URL = 'https://api-test.paralegix.test';
});

afterAll(() => {
  if (originalWebhookBase === undefined) delete process.env.WEBHOOK_BASE_URL;
  else process.env.WEBHOOK_BASE_URL = originalWebhookBase;
  uninstallGoogleFetchWall();
});

beforeEach(async () => {
  resetGoogleFetch();
  firm = await createFirm();
});

afterEach(async () => {
  await drainEvents();
});

// ── fixtures (plain SQL) ────────────────────────────────────────────────────

async function connectGoogle(opts: { accessToken?: string; connected?: boolean } = {}) {
  const { uid } = await createFirmMember(firm.id);
  const accessToken = opts.connected === false ? null : (opts.accessToken ?? 'access-seed');
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token)
     values ($1, 'google', $2, 'refresh-seed')`,
    [uid, accessToken],
  );
  expect(tokens.rowCount).toBe(1);
  const settings = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'google', true, true)
     on conflict (user_id, provider) do update set is_sync_to_provider = excluded.is_sync_to_provider, is_sync_from_provider = excluded.is_sync_from_provider`,
    [uid],
  );
  expect(settings.rowCount).toBe(1);
  return uid;
}

async function seedChannel(opts: {
  userId: string;
  channelId?: string;
  resourceId?: string;
  token?: string;
  expiresInMs?: number;
}) {
  const channelId = opts.channelId ?? `chan-${randomUUID().slice(0, 8)}`;
  const res = await testPool.query(
    `insert into calendar_subscriptions (provider, id, user_id, law_firm_id, calendar_id, resource, secret, expiration)
     values ('google', $1, $2, $3, 'primary', $4, $5, now() + ($6 || ' milliseconds')::interval)`,
    [
      channelId, opts.userId, firm.id,
      opts.resourceId ?? `res-${channelId}`,
      opts.token ?? 'channel-token',
      String(opts.expiresInMs ?? 7 * 24 * 60 * 60 * 1000),
    ],
  );
  expect(res.rowCount).toBe(1);
  return channelId;
}

const channelRows = async () => (await testPool.query(
  `select id, user_id, law_firm_id, resource, secret, expiration from calendar_subscriptions where provider = 'google' order by id`,
)).rows;

const stopFailureRows = async () => (await testPool.query(
  `select dedupe_key as channel_id, payload->>'resourceId' as resource_id,
          user_id, law_firm_id, attempts, last_error,
          next_attempt_at > now() as scheduled_ahead
     from calendar_sync_failures where kind = 'stop_channel' order by dedupe_key`,
)).rows;

// ── the wall ────────────────────────────────────────────────────────────────

describe('the network wall', () => {
  /**
   * Goes red if `globalThis.fetch` is no longer replaced or the router stops
   * throwing on an unregistered url. Also proves `createWatchChannel` really
   * reaches Google, which is what the later "no request was made" cases are
   * measured against.
   */
  test('blocks the unrouted watch request and records the attempt', async () => {
    const userId = await connectGoogle();

    expect(wallIsUp()).toBe(true);
    await expect(googleService.createWatchChannel({ userId, lawFirmId: firm.id }))
      .rejects.toThrow(BLOCKED);

    const attempts = callsMatching(WATCH_URL);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].method).toBe('POST');
    expect(attempts[0].body.type).toBe('web_hook');
  });
});

// ── creating a channel ──────────────────────────────────────────────────────

describe('createWatchChannel', () => {
  /**
   * Goes red if `saveWatchChannel` stops persisting the resource id (the value
   * `channels/stop` cannot be called without), if the expiration stops being
   * parsed off Google's response, or if the follow-up `initSyncToken` call that
   * seeds `user_settings.google_sync_token` is dropped. Without that token the
   * first notification falls back to a full one-year re-sync.
   */
  test('stores the channel and seeds the incremental sync token', async () => {
    const userId = await connectGoogle();
    const expiration = Date.now() + 7 * 24 * 60 * 60 * 1000;

    route(WATCH_URL, {
      status: 200,
      json: { resourceId: 'res-google-1', expiration: String(expiration) },
    }, { method: 'POST' });
    route(/\/events\?maxResults=2500&showDeleted=true/, { status: 200, json: { nextSyncToken: 'sync-token-1', items: [] } });

    const result = await googleService.createWatchChannel({ userId, lawFirmId: firm.id });
    expect(result).toMatchObject({ resourceId: 'res-google-1' });

    const rows = await channelRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.channelId,
      user_id: userId,
      law_firm_id: firm.id,
      resource: 'res-google-1',
    });
    // The verification token is a per-channel secret; the webhook route compares
    // it against the X-Goog-Channel-Token header before doing any work.
    expect(rows[0].secret).toEqual(callsMatching(WATCH_URL)[0].body.token);
    expect(rows[0].expiration.getTime()).toBe(expiration);

    const { rows: settings } = await testPool.query(
      `select sync_cursor as google_sync_token from user_oauth_tokens
     where user_id = $1 and provider = 'google'`, [userId],
    );
    expect(settings[0].google_sync_token).toBe('sync-token-1');
  });

  /**
   * Goes red if the non-ok branch starts persisting a row anyway. A stored
   * channel Google never created would be renewed forever and, worse, would make
   * `findWatchChannelForUser` hand the outbound-push stamp a dead id.
   */
  test('stores nothing when Google refuses to create the channel', async () => {
    const userId = await connectGoogle();

    // 400 rather than 403: `makeGoogleApiCall` treats a non-rate-limit 403 as an
    // auth failure and drives a token refresh, which is a different code path
    // from the one this case is about.
    route(WATCH_URL, {
      status: 400,
      text: '{"error":{"code":400,"message":"Push notifications are not supported by this resource."}}',
    }, { method: 'POST' });

    const result = await googleService.createWatchChannel({ userId, lawFirmId: firm.id });
    expect(result).toBeNull();
    // The request really was attempted, so the empty table below is the refusal
    // being honoured rather than the call never happening.
    expect(callsMatching(WATCH_URL)).toHaveLength(1);
    expect(await channelRows()).toHaveLength(0);
  });
});

// ── stopping a channel ──────────────────────────────────────────────────────

describe('stopWatchChannel', () => {
  /**
   * The happy path and the unknown-channel path in one case, so the "no request
   * was made" half is measured against a call that demonstrably does happen from
   * the same fixture.
   *
   * Goes red if a successful stop stops deleting the local row, or if the stop
   * request stops carrying the resource id `channels/stop` needs.
   *
   * It does NOT go red on removing the `if (!channelData) return` guard alone:
   * with no row there is no user to load a token for, so the very next check
   * (`!userData?.googleAccessToken`) turns the unknown id into the same silent
   * no-op. The guard is defensive rather than behavioural, and saying so is more
   * useful than an assertion that cannot tell the difference.
   */
  test('stops a known channel and ignores an unknown id', async () => {
    const userId = await connectGoogle();
    const channelId = await seedChannel({ userId, resourceId: 'res-known' });

    route(STOP_URL, { status: 204 }, { method: 'POST' });

    await googleService.stopWatchChannel('chan-that-does-not-exist');
    expect(googleCalls()).toHaveLength(0);

    await googleService.stopWatchChannel(channelId);
    const stopCalls = callsMatching(STOP_URL);
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0].body).toEqual({ id: channelId, resourceId: 'res-known' });

    expect(await channelRows()).toHaveLength(0);
    expect(await stopFailureRows()).toHaveLength(0);
  });

  /**
   * A 404 from `channels/stop` means Google no longer has the channel, which is
   * the same end state a successful stop produces. Recording it as a failure
   * would put a permanently unstoppable row into the retry sweep.
   *
   * Goes red if `requestChannelStop` drops `|| response.status === 404` from its
   * `stopped` test. The previous behaviour is what the next case pins, so the
   * two together distinguish "no row because 404 is success" from "no row
   * because nothing is ever recorded".
   */
  test('treats a 404 from channels/stop as already stopped', async () => {
    const userId = await connectGoogle();
    const channelId = await seedChannel({ userId });

    route(STOP_URL, { status: 404, text: '{"error":{"code":404}}' }, { method: 'POST' });

    await googleService.stopWatchChannel(channelId);

    expect(callsMatching(STOP_URL)).toHaveLength(1);
    expect(await channelRows()).toHaveLength(0);
    expect(await stopFailureRows()).toHaveLength(0);
  });

  /**
   * The durability rule. A stop Google refused leaves the channel LIVE, and the
   * local row is deleted regardless, so the retry row is the only remaining
   * record of a channel that still needs shutting off.
   *
   * Goes red if the `if (!stopped)` branch stops calling
   * `recordWatchChannelStopFailure`, or if the recorded row loses the resource
   * id that `channels/stop` cannot be retried without.
   */
  test('records a retry row when Google refuses the stop', async () => {
    const userId = await connectGoogle();
    const channelId = await seedChannel({ userId, resourceId: 'res-stuck' });

    route(STOP_URL, { status: 500, text: '{"error":{"code":500}}' }, { method: 'POST' });

    await googleService.stopWatchChannel(channelId);

    expect(await channelRows()).toHaveLength(0);
    const failures = await stopFailureRows();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      channel_id: channelId,
      // The queue row keeps its own resourceId in `payload`; only the
      // merged calendar_subscriptions table renamed the column to `resource`
      // (migration 0203). This is a different table and was not part of that merge.
      resource_id: 'res-stuck',
      user_id: userId,
      law_firm_id: firm.id,
      attempts: 1,
    });
    expect(failures[0].last_error).toContain('500');
  });

  /**
   * A disconnected user has no token to call Google with, but the channel may
   * still be live for the rest of its ttl and they may reconnect inside it.
   *
   * Goes red if the no-token branch stops recording, or starts calling Google
   * with an absent access token.
   */
  test('records a retry row when there is no token left to call Google with', async () => {
    const userId = await connectGoogle({ connected: false });
    const channelId = await seedChannel({ userId, resourceId: 'res-orphan' });

    await googleService.stopWatchChannel(channelId);

    expect(googleCalls()).toHaveLength(0);
    expect(await channelRows()).toHaveLength(0);
    const failures = await stopFailureRows();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ channel_id: channelId, resource_id: 'res-orphan', attempts: 1 });
    expect(failures[0].last_error).toContain('no Google access token');
  });
});

// ── renewal ─────────────────────────────────────────────────────────────────

describe('renewExpiringChannels', () => {
  test('a refused replacement leaves the old channel live and preserves its cursor', async () => {
    const userId = await connectGoogle();
    const oldChannelId = await seedChannel({ userId, expiresInMs: 60 * 60 * 1000 });
    await testPool.query("update user_oauth_tokens set sync_cursor = 'missed-changes' where user_id = $1 and provider = 'google'", [userId]);
    route(WATCH_URL, { status: 503 });
    route(STOP_URL, { status: 204 });
    expect(await googleService.renewExpiringChannels({})).toMatchObject({ failed: 1 });
    expect((await channelRows()).map((r) => r.id)).toEqual([oldChannelId]);
    expect(callsMatching(STOP_URL)).toHaveLength(0);
    expect((await testPool.query("select sync_cursor from user_oauth_tokens where user_id = $1 and provider = 'google'", [userId])).rows[0].sync_cursor).toBe('missed-changes');
  });
  /**
   * Goes red if the renewal stops replacing the channel: either half missing
   * (stop without create, or create without stop) changes the row set or the
   * request sequence asserted here.
   */
  test('stops the expiring channel and creates a replacement', async () => {
    const userId = await connectGoogle();
    const oldChannelId = await seedChannel({ userId, resourceId: 'res-old', expiresInMs: 60 * 60 * 1000 });

    route(STOP_URL, { status: 204 }, { method: 'POST' });
    route(WATCH_URL, {
      status: 200,
      json: { resourceId: 'res-new', expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000) },
    }, { method: 'POST' });
    route(/\/events\?maxResults=2500&showDeleted=true/, { status: 200, json: { nextSyncToken: 'sync-token-2', items: [] } });

    const result = await googleService.renewExpiringChannels({});
    expect(result).toEqual({ renewed: 1, failed: 0, truncated: false });

    const rows = await channelRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(oldChannelId);
    expect(rows[0].resource).toBe('res-new');
    expect(await stopFailureRows()).toHaveLength(0);
  });

  /**
   * A channel that is not due yet must be left alone, or every cron run would
   * churn every channel on the platform.
   *
   * Goes red if the 24-hour cutoff widens: the far-future channel would be
   * stopped and recreated, changing both the count and the row id. The expiring
   * channel in the same fixture proves the sweep ran.
   */
  test('leaves a channel that is not due within 24 hours', async () => {
    const userId = await connectGoogle();
    const dueSoon = await seedChannel({ userId, expiresInMs: 60 * 60 * 1000 });
    const notDue = await seedChannel({ userId, expiresInMs: 6 * 24 * 60 * 60 * 1000 });

    route(STOP_URL, { status: 204 }, { method: 'POST' });
    route(WATCH_URL, {
      status: 200,
      json: { resourceId: 'res-renewed', expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000) },
    }, { method: 'POST' });
    route(/\/events\?maxResults=2500&showDeleted=true/, { status: 200, json: { nextSyncToken: 'sync-token-3', items: [] } });

    const result = await googleService.renewExpiringChannels({});
    expect(result).toMatchObject({ renewed: 1, failed: 0 });

    const ids = (await channelRows()).map((r) => r.id);
    expect(ids).toContain(notDue);
    expect(ids).not.toContain(dueSoon);
    expect(callsMatching(STOP_URL)).toHaveLength(1);
  });

  /**
   * The cron budget. A platform with more due channels than one request has time
   * for must stop cleanly and say so, rather than being cut off mid-channel:
   * a channel not reached is still inside its 24-hour window next run.
   *
   * Goes red if the `deadline` check is removed from the loop, which would let
   * the run stop and recreate the channel despite the budget being spent.
   */
  test('stops before touching anything once the deadline has passed', async () => {
    const userId = await connectGoogle();
    await seedChannel({ userId, expiresInMs: 60 * 60 * 1000 });

    const result = await googleService.renewExpiringChannels({ deadline: Date.now() - 1 });
    expect(result).toEqual({ renewed: 0, failed: 0, truncated: true });

    expect(googleCalls()).toHaveLength(0);
    expect(await channelRows()).toHaveLength(1);
  });
});

// ── overlapping replacements ────────────────────────────────────────────────

describe('replacing a channel while another replacement is in flight', () => {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const INIT_TOKEN = /\/events\?maxResults=2500&showDeleted=true/;

  /**
   * Answers every watch request, holding the FIRST one open until `release` is
   * called. `inFlight` resolves once that first request has reached Google, so
   * the case knows the first replacement is mid-way through creating its
   * channel and has not yet stopped the old one.
   */
  function holdFirstWatch() {
    let release!: () => void;
    let markInFlight!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const inFlight = new Promise<void>((resolve) => { markInFlight = resolve; });
    route(WATCH_URL, async (_call, hit) => {
      if (hit === 0) {
        markInFlight();
        await released;
      }
      return { status: 200, json: { resourceId: `res-new-${hit}`, expiration: String(Date.now() + WEEK_MS) } };
    }, { method: 'POST' });
    return { inFlight, release };
  }

  /**
   * Two renewal passes that overlap both see the same expiring channel. Each
   * used to create a replacement and then stop the old one, so the user ended
   * with two live channels and every calendar change notified twice until
   * Google's ttl ran out, and the next renewal renewed both.
   *
   * Goes red if renewal stops taking the per-user watch lock: the second pass
   * creates its own channel while the first is still creating, leaving two rows
   * and two watch requests.
   */
  test('a second renewal pass leaves the user with one live channel', async () => {
    const userId = await connectGoogle();
    const oldChannelId = await seedChannel({ userId, expiresInMs: 60 * 60 * 1000 });
    const { inFlight, release } = holdFirstWatch();
    route(STOP_URL, { status: 204 }, { method: 'POST' });
    route(INIT_TOKEN, { status: 200, json: { nextSyncToken: 'sync-token-overlap', items: [] } });

    const first = googleService.renewExpiringChannels({});
    await inFlight;
    const second = await googleService.renewExpiringChannels({});
    release();
    const firstResult = await first;

    expect(firstResult).toEqual({ renewed: 1, failed: 0, truncated: false });
    expect(second).toEqual({ renewed: 0, failed: 0, truncated: false });
    const rows = await channelRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(oldChannelId);
    expect(callsMatching(WATCH_URL)).toHaveLength(1);
  });

  /**
   * A pass that listed the channel before another pass replaced it reaches the
   * lock only after the replacement is done. It must see that the channel it
   * listed is gone rather than replace it a second time.
   *
   * Goes red if the renewal stops re-reading the channel once it holds the
   * lock: the late pass creates a second live channel, and its stop of the
   * listed one is a no-op because that row was already deleted.
   */
  test('a pass holding a stale listing does not replace the channel again', async () => {
    const userId = await connectGoogle();
    await seedChannel({ userId, expiresInMs: 60 * 60 * 1000 });
    const { inFlight, release } = holdFirstWatch();
    route(STOP_URL, { status: 204 }, { method: 'POST' });
    route(INIT_TOKEN, { status: 200, json: { nextSyncToken: 'sync-token-stale', items: [] } });

    const first = googleService.renewExpiringChannels({});
    await inFlight;

    // The second pass reads the due set now, while the old channel still
    // exists, then waits until the first pass has finished before going on.
    const realList = calendarSyncRepo.listExpiringWatchChannels;
    let markListed!: () => void;
    let openGate!: () => void;
    const listed = new Promise<void>((resolve) => { markListed = resolve; });
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const spy = jest.spyOn(calendarSyncRepo, 'listExpiringWatchChannels').mockImplementationOnce(async (cutoff: any) => {
      const due = await realList(cutoff);
      markListed();
      await gate;
      return due;
    });
    try {
      const second = googleService.renewExpiringChannels({});
      await listed;
      release();
      expect(await first).toEqual({ renewed: 1, failed: 0, truncated: false });
      openGate();
      expect(await second).toEqual({ renewed: 0, failed: 0, truncated: false });
    } finally {
      spy.mockRestore();
    }

    expect(await channelRows()).toHaveLength(1);
    expect(callsMatching(WATCH_URL)).toHaveLength(1);
  });

  /**
   * Re-pointing the watch after a calendar-target change also replaces the
   * channel. It listed the old channel, created its own, and stopped what it
   * listed, so overlapping a renewal left the renewal's new channel live beside
   * its own.
   *
   * Goes red if `rearmWatchChannel` stops taking the same per-user lock as
   * renewal: it runs straight through while the renewal is held, and the two
   * leave two channels.
   */
  test('a re-point overlapping a renewal leaves one live channel', async () => {
    const userId = await connectGoogle();
    await seedChannel({ userId, expiresInMs: 60 * 60 * 1000 });
    const { inFlight, release } = holdFirstWatch();
    route(STOP_URL, { status: 204 }, { method: 'POST' });
    route(INIT_TOKEN, { status: 200, json: { nextSyncToken: 'sync-token-rearm', items: [] } });

    const renewal = googleService.renewExpiringChannels({});
    await inFlight;
    let rearmSettled = false;
    const rearm = googleService.rearmWatchChannel(userId).finally(() => { rearmSettled = true; });
    // Unlocked, the re-point finishes on its own while the renewal is held.
    // Locked, it is still waiting when this second is up.
    for (let waited = 0; waited < 1000 && !rearmSettled; waited += 25) {
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    release();
    expect(await renewal).toEqual({ renewed: 1, failed: 0, truncated: false });
    await rearm;

    expect(await channelRows()).toHaveLength(1);
    expect(callsMatching(WATCH_URL)).toHaveLength(2);
  });
});

// ── the stop-failure retry sweep ────────────────────────────────────────────

describe('retryUnstoppedWatchChannels', () => {
  async function seedStopFailure(opts: {
    userId: string;
    channelId?: string;
    resourceId?: string;
    attempts?: number;
    expiresInMs?: number;
    dueInMs?: number;
  }) {
    const channelId = opts.channelId ?? `stuck-${randomUUID().slice(0, 8)}`;
    const res = await testPool.query(
      `insert into calendar_sync_failures
         (kind, dedupe_key, provider, payload, user_id, law_firm_id, expires_at,
          attempts, next_attempt_at)
       values ('stop_channel', $1, 'google', jsonb_build_object('resourceId', $2::text), $3, $4,
               now() + ($5 || ' milliseconds')::interval,
               $6,
               now() + ($7 || ' milliseconds')::interval)`,
      [
        channelId, opts.resourceId ?? `res-${channelId}`, opts.userId, firm.id,
        String(opts.expiresInMs ?? 3 * 24 * 60 * 60 * 1000),
        opts.attempts ?? 1,
        String(opts.dueInMs ?? -1000),
      ],
    );
    expect(res.rowCount).toBe(1);
    return channelId;
  }

  /**
   * Goes red if a successful retry stops calling
   * `resolveWatchChannelStopFailure`: the row would survive and the same channel
   * would be re-stopped on every sweep until it dead-lettered.
   */
  test('resolves the row when the channel finally stops', async () => {
    const userId = await connectGoogle();
    const channelId = await seedStopFailure({ userId, resourceId: 'res-retry' });

    route(STOP_URL, { status: 204 }, { method: 'POST' });

    const result = await googleService.retryUnstoppedWatchChannels({});
    expect(result).toMatchObject({ attempted: 1, stopped: 1, failed: 0, expired: 0 });

    expect(callsMatching(STOP_URL)[0].body).toEqual({ id: channelId, resourceId: 'res-retry' });
    expect(await stopFailureRows()).toHaveLength(0);
  });

  /**
   * Goes red if a second failure stops incrementing `attempts` or stops pushing
   * `next_attempt_at` forward. Either one turns the backoff into a hot loop that
   * re-hits Google on every sweep and burns the retry budget in one pass.
   */
  test('backs the row off when the stop fails again', async () => {
    const userId = await connectGoogle();
    const channelId = await seedStopFailure({ userId, attempts: 2 });

    route(STOP_URL, { status: 503, text: '{"error":{"code":503}}' }, { method: 'POST' });

    const result = await googleService.retryUnstoppedWatchChannels({});
    expect(result).toMatchObject({ attempted: 1, stopped: 0, failed: 1 });

    const rows = await stopFailureRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel_id: channelId, attempts: 3, scheduled_ahead: true });
    expect(rows[0].last_error).toContain('503');
  });

  /**
   * A channel Google has already expired needs no stopping, so its row is
   * dropped before the sweep spends a request on it.
   *
   * Goes red if `purgeExpiredWatchChannelStopFailures` stops running first: the
   * expired row would be attempted (or, with the selection filter intact, would
   * survive forever as an uncounted leak). The live row in the same fixture is
   * what proves the sweep ran at all.
   */
  test('purges rows whose channel already expired at Google', async () => {
    const userId = await connectGoogle();
    const expired = await seedStopFailure({ userId, expiresInMs: -60_000 });
    const live = await seedStopFailure({ userId });

    route(STOP_URL, { status: 204 }, { method: 'POST' });

    const result = await googleService.retryUnstoppedWatchChannels({});
    expect(result).toMatchObject({ expired: 1, attempted: 1, stopped: 1 });

    // Exactly one stop request: the live row's. The expired one was never tried.
    const stopCalls = callsMatching(STOP_URL);
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0].body.id).toBe(live);
    expect((await stopFailureRows()).map((r) => r.channel_id)).not.toContain(expired);
  });

  /**
   * Goes red if the deadline check leaves the loop: the due row would be
   * attempted despite the sweep's wall-clock budget being spent, which is the
   * behaviour that lets an unresponsive Google hold a cron request open.
   */
  test('attempts nothing once the deadline has passed', async () => {
    const userId = await connectGoogle();
    await seedStopFailure({ userId });

    const result = await googleService.retryUnstoppedWatchChannels({ deadline: Date.now() - 1 });
    expect(result).toMatchObject({ attempted: 0, stopped: 0, failed: 0, truncated: true });

    expect(googleCalls()).toHaveLength(0);
    expect(await stopFailureRows()).toHaveLength(1);
  });
});

export {};
