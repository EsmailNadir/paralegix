/**
 * Fixture builders shared by the calendar specs.
 *
 * Every builder writes plain SQL through the test pool and asserts its own
 * insert landed. Seeding through a route would mean a broken route produced
 * both the fixture and the expectation, and a fixture that silently wrote
 * nothing surfaces much later as a confusing empty result.
 *
 * The connections here carry fake tokens only. Nothing they seed can reach a
 * real provider, because every spec that uses them also installs the network
 * wall in `googleFetch.ts`.
 */
import { randomUUID } from 'crypto';

import { createFirmMember, testPool, type Firm } from '../../support/setupInProcess';
import { BLOCKED, googleCalls, wallIsUp } from './googleFetch';

/**
 * A firm member with a Google connection that syncs both ways.
 *
 * `syncToken: null` seeds a connection with no delta cursor yet, and
 * `inbound: false` one that pushes to Google but imports nothing.
 */
export async function connectGoogle(
  targetFirm: Firm,
  opts: { syncToken?: string | null; inbound?: boolean } = {},
): Promise<string> {
  const { uid } = await createFirmMember(targetFirm.id);
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token)
     values ($1, 'google', 'access-seed', 'refresh-seed')`,
    [uid],
  );
  expect(tokens.rowCount).toBe(1);
  const settings = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, is_sync_to_provider, is_sync_from_provider, sync_cursor)
     values ($1, 'google', true, $2, $3)
     on conflict (user_id, provider) do update set is_sync_to_provider = excluded.is_sync_to_provider, is_sync_from_provider = excluded.is_sync_from_provider, sync_cursor = excluded.sync_cursor`,
    [uid, opts.inbound ?? true, opts.syncToken === undefined ? 'token-seed' : opts.syncToken],
  );
  expect(settings.rowCount).toBe(1);
  return uid;
}

/**
 * A non-owner member with a Microsoft connection that syncs both ways.
 *
 * The mailbox timezone is pre-cached, so an inbound fetch does not also need a
 * `/me/mailboxSettings/timeZone` route registered, and the member's own zone
 * is set to match it.
 */
export async function connectMicrosoft(targetFirm: Firm): Promise<string> {
  const { uid } = await createFirmMember(targetFirm.id, { isOwner: false });
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, meta)
     values ($1, 'microsoft', 'access-seed', 'refresh-seed', $2::jsonb)`,
    [uid, JSON.stringify({ outlookTimezone: 'America/New_York' })],
  );
  expect(tokens.rowCount).toBe(1);
  const settings = await testPool.query(
    `with touched as (update users set timezone = 'America/New_York', updated_at = now() where id = $1)
     insert into user_oauth_tokens (user_id, provider, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'microsoft', true, true)
     on conflict (user_id, provider) do update set is_sync_to_provider = excluded.is_sync_to_provider, is_sync_from_provider = excluded.is_sync_from_provider`,
    [uid],
  );
  expect(settings.rowCount).toBe(1);
  return uid;
}

/**
 * A hearing on an existing matter, on 10 September 2026 at 14:00 UTC.
 *
 * `createdBy` matters to a "sync existing" press: an unassigned event goes only
 * to its creator, and one with no recorded creator goes to nobody.
 */
export async function seedMatterEvent(
  lawFirmId: string,
  matterId: string,
  title = 'Preliminary hearing',
  calendarSync: object = {},
  createdBy: string | null = null,
): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into events (id, law_firm_id, matter_id, type, title, date, calendar_sync, created_by)
     values ($1, $2, $3, 'hearing', $4, '2026-09-10T14:00:00Z', $5::jsonb, $6)`,
    [id, lawFirmId, matterId, title, JSON.stringify(calendarSync), createdBy],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

/** A new matter holding one hearing, as `seedMatterEvent` writes it. */
export async function seedMatterWithEvent(
  targetFirm: Firm,
  title: string,
  calendarSync: object = {},
  createdBy: string | null = null,
): Promise<{ matterId: string; eventId: string }> {
  const matterId = randomUUID();
  const matter = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, 'Bell v. Ward', $3)`,
    [matterId, targetFirm.id, `M-${matterId.slice(0, 8)}`],
  );
  expect(matter.rowCount).toBe(1);
  const eventId = await seedMatterEvent(targetFirm.id, matterId, title, calendarSync, createdBy);
  return { matterId, eventId };
}

/** The mapping row that ties one member's provider copy to a matter event. */
export async function seedMapping(opts: {
  provider?: 'google' | 'outlook';
  externalEventId: string;
  lawFirmId: string;
  userId: string;
  entityId: string;
  scopeId: string;
}): Promise<void> {
  const res = await testPool.query(
    `insert into calendar_mappings
       (provider, external_event_id, calendar_id, user_id, law_firm_id,
        entity_type, entity_id, scope_id, item_key)
     values ($1, $2, 'primary', $3, $4, 'matterEvent', $5, $6, 'event')`,
    [opts.provider ?? 'google', opts.externalEventId, opts.userId, opts.lawFirmId, opts.entityId, opts.scopeId],
  );
  expect(res.rowCount).toBe(1);
}

/**
 * The case each wall-installing spec opens with: an unrouted request is
 * recorded and then refused.
 *
 * The wall is per process, so every spec file proves its own. Without that
 * proof, each "the provider was not called" assertion in the file would pass
 * just as well against a wall that was never installed. Call it at the top
 * level of the spec, after `installGoogleFetchWall()` and a `beforeEach` that
 * calls `resetGoogleFetch()`.
 */
export function describeNetworkWall(url = 'https://www.googleapis.com/calendar/v3/users/me/calendarList') {
  describe('the network wall', () => {
    test('blocks and records an unrouted provider request', async () => {
      expect(wallIsUp()).toBe(true);
      await expect(fetch(url)).rejects.toThrow(BLOCKED);
      expect(googleCalls().map((c) => c.url)).toEqual([url]);
    });
  });
}
