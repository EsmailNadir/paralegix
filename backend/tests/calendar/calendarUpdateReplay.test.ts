/**
 * C05 (replay/partial-success matrix): an inbound calendar UPDATE delivered
 * twice, or an older update arriving after a newer one has already landed.
 *
 * Neither `calendar_mappings` nor `events`/`events` carries a
 * version or sequence column (checked against `db/schema.sql` before writing
 * this file), so there is no true optimistic-concurrency guarantee here. What
 * the shared inbound engine (`shared/providerSyncEngine.ts`) actually promises
 * is narrower and is exactly what this file pins:
 *
 *   - `siblingOrParalegixIsNewer` rejects an inbound update whose provider
 *     `updated` timestamp is OLDER than the sibling provider's own stamped
 *     `google_last_modified` / `outlook_last_modified` column on the same
 *     entity. That column is real, provider-specific stored state (not the
 *     generic `updated_at` wall-clock column every table gets bumped on any
 *     write), so it lets Google's guard compare against what Outlook already
 *     applied without needing a shared version counter.
 *   - Every inbound Google/Outlook fetch (delta page, full re-sync, or a
 *     single by-id Graph GET) reads the provider's CURRENT state, never a
 *     cached historical payload. Combined with the sync token/deltaLink
 *     advancing on every processed batch, a redelivered "something changed"
 *     ping naturally resolves to an empty diff instead of reprocessing.
 *
 * What this file deliberately does NOT claim: two truly concurrent inbound
 * syncs for the same shared entity from two DIFFERENT users' independent
 * provider connections race on a plain read-then-write with no lock keyed by
 * entity (`CALENDAR_WEBHOOK`'s advisory lock is keyed by userId, and the
 * outbound `CALENDAR_SYNC` lock by `entityType:entityId:userId` - neither
 * serializes two different users touching the same matterEvent/clientEvent).
 * That is a real, narrower gap, but fixing it well means adding a new
 * entity-scoped lock across both providers' shared/matterEvents/clientEvents
 * paths, which is a bigger and riskier change than pinning down the ordering
 * contract that already exists. Recorded here, not invented a fix for.
 */
import {
  installGoogleFetchWall,
  uninstallGoogleFetchWall,
  resetGoogleFetch,
  route,
  callsMatching,
} from './support/googleFetch';

installGoogleFetchWall();

import {
  testPool,
  createFirm,
  drainEvents,
  type Firm,
} from '../support/setupInProcess';
import { connectGoogle, describeNetworkWall, seedMapping, seedMatterWithEvent } from './support/calendarWorld';

const googleService = require('../../src/modules/calendar/google/google.service');

const DELTA = 'syncToken=';

/** Two fixed instants, comfortably apart and comfortably newer than any
 * fixture row's `updated_at`, so the ONLY thing that can skip an update is
 * the cross-provider `*_last_modified` comparison this file is pinning, not
 * the generic wall-clock fallback. */
const OLDER = '2030-01-01T00:00:00.000Z';
const NEWER = '2030-06-01T00:00:00.000Z';

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

// ── fixtures (plain SQL; mirrors googleWatchNotification.test.ts) ───────────

/** Simulates "Outlook already applied a more recent edit to this shared
 * matter event", without running a live Outlook fetch: what Google's guard
 * reads back is the stored `outlook_last_modified` column, so seeding it
 * directly exercises the exact same comparison a real Outlook inbound apply
 * would have left behind (see `outlookStrategy.ts#applyExternalLastModified`,
 * which stamps this same column). */
async function stampOutlookApplied(eventId: string, title: string, outlookModifiedIso: string) {
  const res = await testPool.query(
    `update events set title = $1, outlook_last_modified = $2 where id = $3`,
    [title, outlookModifiedIso, eventId],
  );
  expect(res.rowCount).toBe(1);
}

const matterEventRow = async (eventId: string) => (await testPool.query(
  `select title, outlook_last_modified, google_last_modified from events where id = $1`,
  [eventId],
)).rows[0];

const mappingCount = async (eventId: string) => Number((await testPool.query(
  `select count(*)::int as n from calendar_mappings where entity_id = $1`, [eventId],
)).rows[0].n);

const syncTokenOf = async (uid: string) => (await testPool.query(
  `select sync_cursor as google_sync_token from user_oauth_tokens
     where user_id = $1 and provider = 'google'`, [uid],
)).rows[0]?.google_sync_token;

function googleEvent(id: string, summary: string, updatedIso: string) {
  return {
    id,
    summary,
    status: 'confirmed',
    updated: updatedIso,
    start: { dateTime: '2026-09-11T15:00:00Z' },
    end: { dateTime: '2026-09-11T16:00:00Z' },
  };
}

// ── the wall ──────────────────────────────────────────────────────────────

describeNetworkWall();

// ── cross-provider ordering: the guarantee that actually exists ────────────

describe('an older update arriving after a newer one on the sibling provider', () => {
  /**
   * Outlook already applied a newer edit (stamped `outlook_last_modified`).
   * A Google delta then reports the SAME shared matter event with an OLDER
   * `updated` timestamp than that stamp. `siblingOrParalegixIsNewer` must
   * reject it, or the older Google content silently reverts a change the
   * user already made through Outlook.
   *
   * Goes red if the `otherTime > providerTime` branch in
   * `siblingOrParalegixIsNewer` (shared/providerSyncEngine.ts) is removed or
   * inverted: the title would come back as the stale Google value asserted
   * against below instead of surviving as Outlook's.
   */
  test('is rejected, so the newer sibling-provider content survives', async () => {
    const uid = await connectGoogle(firm);
    const { matterId, eventId } = await seedMatterWithEvent(firm, 'Original hearing');
    await seedMapping({
      externalEventId: 'g-shared', lawFirmId: firm.id, userId: uid, entityId: eventId, scopeId: matterId,
    });
    await stampOutlookApplied(eventId, 'Amended via Outlook', NEWER);

    route(DELTA, {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [googleEvent('g-shared', 'Reverted via stale Google edit', OLDER)],
      },
    });

    await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });

    // The delta really ran; a no-op guard case cannot be told apart from a
    // path that never fired without this.
    expect(callsMatching(DELTA)).toHaveLength(1);

    const row = await matterEventRow(eventId);
    expect(row.title).toBe('Amended via Outlook');
    expect(new Date(row.outlook_last_modified).toISOString()).toBe(NEWER);
    // The rejected update must not even stamp its own provider column,
    // since nothing about it was applied.
    expect(row.google_last_modified).toBeNull();
  });

  /**
   * The mirror case: Google's update IS the newer one. Proves the guard
   * above is a genuine ordering check and not a blanket "prefer Outlook"
   * rule that would happen to pass the first test for the wrong reason.
   *
   * Goes red if the guard starts rejecting every inbound Google update once
   * ANY `outlook_last_modified` is present, regardless of ordering.
   */
  test('a genuinely newer update on this provider is still applied', async () => {
    const uid = await connectGoogle(firm);
    const { matterId, eventId } = await seedMatterWithEvent(firm, 'Original hearing');
    await seedMapping({
      externalEventId: 'g-shared', lawFirmId: firm.id, userId: uid, entityId: eventId, scopeId: matterId,
    });
    await stampOutlookApplied(eventId, 'Amended via Outlook', OLDER);

    route(DELTA, {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [googleEvent('g-shared', 'Amended via Google, genuinely later', NEWER)],
      },
    });

    await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });

    const row = await matterEventRow(eventId);
    expect(row.title).toBe('Amended via Google, genuinely later');
    expect(new Date(row.google_last_modified).toISOString()).toBe(NEWER);
  });
});

// ── duplicate delivery of the same change ───────────────────────────────────

describe('the same change notification delivered twice', () => {
  /**
   * Google's push notifications carry no payload ("something changed, go
   * fetch"), so a redelivered ping is indistinguishable from the first one
   * at the webhook route. What makes a duplicate harmless is that the delta
   * read is keyed by the STORED sync token, which the first call already
   * advanced: the second call's delta genuinely has nothing new to report.
   *
   * Goes red if `processWatchNotificationUnlocked` stops persisting
   * `nextSyncToken` before returning (the second call would re-read the same
   * token and reprocess the identical item), or if it started creating a
   * second `calendar_mappings` row on a repeat apply.
   */
  test('advances the sync token so the redelivery is a no-op, not a reprocess', async () => {
    const uid = await connectGoogle(firm);
    const { matterId, eventId } = await seedMatterWithEvent(firm, 'Original hearing');
    await seedMapping({
      externalEventId: 'g-shared', lawFirmId: firm.id, userId: uid, entityId: eventId, scopeId: matterId,
    });

    route(DELTA, (_call, hit) => (hit === 0
      ? {
        status: 200,
        json: {
          nextSyncToken: 'token-after-1',
          items: [googleEvent('g-shared', 'Rescheduled to Friday', OLDER)],
        },
      }
      // The real Google shape for a redelivered ping: the delta since the
      // now-advanced token reports nothing new.
      : {
        status: 200,
        json: { nextSyncToken: 'token-after-2', items: [] },
      }));

    await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });
    expect((await matterEventRow(eventId)).title).toBe('Rescheduled to Friday');
    expect(await syncTokenOf(uid)).toBe('token-after-1');

    // The duplicate delivery: same user, same webhook, processed again.
    await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });

    expect(callsMatching(DELTA)).toHaveLength(2);
    expect(await syncTokenOf(uid)).toBe('token-after-2');
    expect((await matterEventRow(eventId)).title).toBe('Rescheduled to Friday');
    expect(await mappingCount(eventId)).toBe(1);
  });

  /**
   * The harder version: the redelivered notification's delta genuinely still
   * contains the same item again (Google does not promise a redelivery
   * always resolves to an empty diff; a coalesced batch can repeat an id).
   * Applying the identical content a second time must be idempotent, not
   * merely harmless by accident of the mock.
   *
   * Goes red if a second application somehow produces a second
   * `calendar_mappings` row instead of resolving through the existing one.
   */
  test('re-applying the identical content is idempotent', async () => {
    const uid = await connectGoogle(firm);
    const { matterId, eventId } = await seedMatterWithEvent(firm, 'Original hearing');
    await seedMapping({
      externalEventId: 'g-shared', lawFirmId: firm.id, userId: uid, entityId: eventId, scopeId: matterId,
    });

    route(DELTA, (_call, hit) => ({
      status: 200,
      json: {
        nextSyncToken: hit === 0 ? 'token-after-1' : 'token-after-2',
        items: [googleEvent('g-shared', 'Rescheduled to Friday', OLDER)],
      },
    }));

    await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });
    await googleService.processWatchNotification({ userId: uid, lawFirmId: firm.id });

    expect((await matterEventRow(eventId)).title).toBe('Rescheduled to Friday');
    expect(await mappingCount(eventId)).toBe(1);
  });
});

export {};
