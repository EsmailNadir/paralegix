/**
 * Deleting a CLIENT through the real route cascades away its standalone
 * `events` rows by a plain `events.client_id ... on delete
 * cascade` FK (schema.sql) - there is no application-level subcollection
 * delete the way `matterEvents.repository#deleteAllForMatter` provides for
 * matters. `matters.service#deleteMatter` already learned this lesson: it
 * calls `purgeExternalCalendarsBeforeMatterRemoval`, which emits
 * `MATTER_EVENT_DELETED` for every one of the matter's events BEFORE the
 * cascade, so `calendar.events.ts` can pull the event off every member's real
 * Google/Outlook calendar and drop the `calendar_mappings` row. Nothing
 * analogous exists for `clients.service#removeClient`: it purges the client's
 * synced INVOICES (`billing.events.ts`'s `CLIENT_DELETED` listener calls
 * `emitCalendarDeletesForInvoicesInContext`) but never touches the client's
 * own calendar events.
 *
 * The practical effect: a client meeting or deadline that was pushed to a
 * firm member's real Google calendar survives the client's deletion forever
 * - Paralegix has no record of it, but the member's actual calendar still
 * shows it, and the `calendar_mappings` row naming the now-gone client_event
 * id is never cleaned up either.
 *
 * This file proves the gap with the real `DELETE /clients/:clientId` route,
 * a real Postgres client_event wired to a `calendar_mappings` row, and the
 * `googleFetch` network wall from `calendarEventListeners.test.ts` asserting
 * on the actual outbound DELETE call.
 */
import {
  installGoogleFetchWall,
  uninstallGoogleFetchWall,
  resetGoogleFetch,
  route,
  callsMatching,
} from './support/googleFetch';

// Before `setupInProcess` pulls in the app graph, so nothing can reach the
// network on the way in (see googleFetch.ts's own top comment).
installGoogleFetchWall();

import { randomUUID } from 'crypto';

import { installInMemoryBucket } from '../support/inMemoryBucket';
import {
  testPool,
  createFirm,
  createFirmMember,
  createPersonClient,
  ownerOf,
  drainEvents,
  type Firm,
} from '../support/setupInProcess';

// removeClient's CLIENT_DELETED fan-out includes a GCS attachment sweep
// (files.events); without a working bucket double it throws "GCS is not
// available" noise on every delete in this file even though nothing here
// asserts on storage (see matterDeletionCascade.test.ts's identical note).
installInMemoryBucket();

const EVENTS_URL = '/calendars/primary/events';

beforeEach(async () => {
  resetGoogleFetch();
});

afterAll(() => {
  uninstallGoogleFetchWall();
});

async function connectGoogle(lawFirmId: string, accessToken: string) {
  const { uid } = await createFirmMember(lawFirmId);
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token)
     values ($1, 'google', $2, 'refresh-seed')`,
    [uid, accessToken],
  );
  expect(tokens.rowCount).toBe(1);
  const settings = await testPool.query(
    `with touched as (update users set preferences = '{}'::jsonb, updated_at = now() where id = $1)
     insert into user_oauth_tokens (user_id, provider, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'google', true, true)
     on conflict (user_id, provider) do update set is_sync_to_provider = excluded.is_sync_to_provider, is_sync_from_provider = excluded.is_sync_from_provider`,
    [uid],
  );
  expect(settings.rowCount).toBe(1);
  return uid;
}

async function seedClientEvent(lawFirmId: string, clientId: string, createdBy: string, googleEventId: string) {
  const id = randomUUID();
  const calendarSync = { google: { [createdBy]: { event: { eventId: googleEventId } } } };
  const res = await testPool.query(
    `insert into events (id, law_firm_id, client_id, type, title, date, created_by, calendar_sync)
     values ($1, $2, $3, 'meeting', 'Intake meeting', '2026-09-12T15:00:00Z', $4, $5::jsonb)`,
    [id, lawFirmId, clientId, createdBy, JSON.stringify(calendarSync)],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function seedMapping(opts: {
  externalEventId: string; lawFirmId: string; userId: string; entityId: string; scopeId: string;
}) {
  const res = await testPool.query(
    `insert into calendar_mappings
       (provider, external_event_id, calendar_id, user_id, law_firm_id, entity_type, entity_id, scope_id, item_key)
     values ('google', $1, 'primary', $2, $3, 'clientEvent', $4, $5, 'event')`,
    [opts.externalEventId, opts.userId, opts.lawFirmId, opts.entityId, opts.scopeId],
  );
  expect(res.rowCount).toBe(1);
}

const mappingRows = async () => (await testPool.query(
  `select external_event_id, entity_type, entity_id from calendar_mappings order by external_event_id`,
)).rows;

const deletes = () => callsMatching(EVENTS_URL).filter((c) => c.method === 'DELETE');

describe('deleting a client purges its synced calendar events (not just its invoices)', () => {
  it('issues the Google DELETE for the client event and drops the mapping row', async () => {
    const firm: Firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const memberUid = await connectGoogle(firm.id, 'tok-member');
    const client = await createPersonClient(firm.id);

    const eventId = await seedClientEvent(firm.id, client.id, memberUid, 'g-client-event');
    await seedMapping({
      externalEventId: 'g-client-event',
      lawFirmId: firm.id,
      userId: memberUid,
      entityId: eventId,
      scopeId: client.id,
    });

    route(`${EVENTS_URL}/g-client-event`, { status: 204 }, { method: 'DELETE' });

    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/clients/${client.id}`);
    expect(res.status).toBe(200);
    await drainEvents();

    // RED IF: nothing purges the client's own calendar events before the
    // cascade removes the events row, so this DELETE never fires and
    // the event silently stays on the member's real Google calendar forever.
    const removed = deletes();
    expect(removed).toHaveLength(1);
    expect(removed[0].url).toContain('/events/g-client-event');
    expect(removed[0].bearer).toBe('tok-member');

    // RED IF: the calendar_mappings row (a soft reference with no FK to
    // events) is left behind, naming a client_event id that no longer
    // exists anywhere.
    expect(await mappingRows()).toHaveLength(0);

    // The cascade itself must still have done its ordinary job: no orphaned
    // events row left behind naming a now-deleted client.
    const remaining = await testPool.query(`select 1 from events where id = $1`, [eventId]);
    expect(remaining.rowCount).toBe(0);
  });

  it('leaves an unrelated client and firm untouched', async () => {
    const firm: Firm = await createFirm();
    const owner = await ownerOf(firm.id);
    const memberUid = await connectGoogle(firm.id, 'tok-member');
    const doomedClient = await createPersonClient(firm.id);
    const survivingClient = await createPersonClient(firm.id);

    const doomedEventId = await seedClientEvent(firm.id, doomedClient.id, memberUid, 'g-doomed');
    const survivingEventId = await seedClientEvent(firm.id, survivingClient.id, memberUid, 'g-surviving');
    await seedMapping({
      externalEventId: 'g-doomed', lawFirmId: firm.id, userId: memberUid, entityId: doomedEventId, scopeId: doomedClient.id,
    });
    await seedMapping({
      externalEventId: 'g-surviving', lawFirmId: firm.id, userId: memberUid, entityId: survivingEventId, scopeId: survivingClient.id,
    });

    route(`${EVENTS_URL}/g-doomed`, { status: 204 }, { method: 'DELETE' });

    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/clients/${doomedClient.id}`);
    expect(res.status).toBe(200);
    await drainEvents();

    const removed = deletes();
    expect(removed).toHaveLength(1);
    expect(removed[0].url).toContain('/events/g-doomed');

    const rows = await mappingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].external_event_id).toBe('g-surviving');

    const survivingRow = await testPool.query(`select 1 from events where id = $1`, [survivingEventId]);
    expect(survivingRow.rowCount).toBe(1);
  });
});
