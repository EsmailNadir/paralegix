/**
 * What a firm's EXTERNAL calendars do when Paralegix data changes.
 *
 * `calendar/calendar.events.ts` is the fan-out layer: it subscribes to fourteen
 * event types and turns each one into "whose Google/Outlook calendar must change,
 * and how". The sync services themselves are covered elsewhere
 * (`googleCalendarSync.test.ts`, `outlookSync.test.ts`) and the sync ROUTES in
 * `googleSyncRoutes.test.ts` / `outlookSyncRoutes.test.ts`. What none of those can
 * see is the decision this file owns: a matter event created by one lawyer must
 * land on every matter member's calendar, an invoice must reach only the people
 * allowed to see money, and neither may reach another firm.
 *
 * ── WHY THIS FILE HAS TO SEED OAUTH TOKENS ──────────────────────────────────
 *
 * Every path in `calendar.events.ts` short-circuits on the SAME pre-check:
 * `getOutboundSyncCapabilities(userId)` asks whether the user has a
 * `user_oauth_tokens` row whose provider is connected AND whose matching
 * `user_settings` sync flag is on. With no such row the listener resolves
 * `preloaded === null` and returns before touching a provider. A spec that seeds
 * only firms and matters therefore exercises nothing: deleting an entire handler
 * changes no observable behaviour and every assertion passes vacuously.
 *
 * So every case here seeds real `user_oauth_tokens` + `user_settings` rows, and
 * asserts on the OUTBOUND CALLS recorded at the network wall
 * (`tests/calendar/support/googleFetch.ts`), which replaces `globalThis.fetch`
 * with a router that answers only registered urls and THROWS on anything else.
 * Each connected user gets a distinct access token, so "whose calendar was
 * written" is answered by the bearer on the recorded call rather than inferred.
 *
 * The first case below proves the wall is reached: a real POST, carrying a real
 * bearer, produced by a real emit. Every later "no call was made" assertion rests
 * on that one.
 *
 * Fixtures are plain SQL through `testPool`, never the app's repositories, and
 * every seed asserts its own rowCount: a fixture that silently failed to insert
 * turns an absence-of-effect assertion into a false green.
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

// Before `setupInProcess` pulls in the app graph, so nothing can reach the
// network on the way in.
installGoogleFetchWall();

import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createFirmMember,
  createPersonClient,
  drainEvents,
  tokenFor,
  as,
  type Firm,
} from '../support/setupInProcess';
import { request } from '../support/app';
import { gateMethod } from '../support/gate';

const eventBus = require('../../src/shared/events/eventBus');
// The listeners under test. Requiring the module registers them; the app requires
// the same module (src/app.ts), so the cron case at the bottom shares these
// registrations rather than adding a second copy.
require('../../src/modules/calendar/calendar.events');

const {
  MATTER_EVENT_CREATED, MATTER_EVENT_UPDATED, MATTER_EVENT_DELETED,
  CLIENT_EVENT_CREATED, CLIENT_EVENT_UPDATED, CLIENT_EVENT_DELETED,
  INVOICE_CREATED, INVOICE_UPDATED, INVOICE_DELETED,
  MATTER_MEMBERS_UPDATED,
  TASK_DELETED, TASK_UPDATED,
} = require('../../src/shared/events/eventTypes');

// Used directly (not through the calendar.events.ts fan-out) by the C02/C07/C08/C09
// specs below, which exercise the underlying create-and-lock mechanism, the outbox
// retry contract, and cross-provider isolation rather than the listener wiring.
const { withLock } = require('../../src/shared/database/advisoryLock');
const { _dispatchRow } = require('../../src/shared/events/eventOutbox');
const googleService = require('../../src/modules/calendar/google/google.service');
const calendarSyncRepo = require('../../src/modules/calendar/shared/calendarSync.repository');
const { getAdapter } = require('../../src/modules/calendar/shared/calendarAdapters');
const calendarTokens = require('../../src/modules/calendar/shared/calendarTokens');

const EVENTS_URL = '/calendars/primary/events';
const TOKEN_URL = 'oauth2.googleapis.com/token';
const OUTLOOK_EVENTS_URL = '/me/events';

let firm: Firm;

beforeEach(async () => {
  resetGoogleFetch();
  firm = await createFirm();
});

afterEach(async () => {
  // The outbound-push stamp and the cross-sync hop are fire-and-forget; let them
  // land against a live pool before the next truncate.
  await drainEvents();
});

afterAll(() => {
  uninstallGoogleFetchWall();
});

// ── emitting ────────────────────────────────────────────────────────────────

/**
 * Emit exactly as a service does, then wait for the listeners.
 *
 * `eventBus.emit` does not await its async listeners, and `calendar.events.ts`
 * debounces each (entity, user) sync by 1.5s before talking to a provider, so an
 * assertion without this drain races both.
 */
async function emitAndDrain(eventType: string, payload: Record<string, unknown>) {
  eventBus.emit(eventType, payload);
  await drainEvents();
}

// ── fixtures (plain SQL) ────────────────────────────────────────────────────

interface ConnectedUser {
  uid: string;
  accessToken: string;
}

/**
 * A firm member with Google connected and outbound sync enabled.
 *
 * A distinct access token per user is what makes "whose calendar" assertable:
 * the bearer on each recorded call names the recipient.
 */
async function connectGoogle(
  lawFirmId: string,
  opts: {
    accessToken?: string;
    refreshToken?: string | null;
    outbound?: boolean;
    isOwner?: boolean;
    permissions?: string[];
  } = {},
): Promise<ConnectedUser> {
  const accessToken = opts.accessToken ?? `tok-${randomUUID().slice(0, 8)}`;
  const { uid } = await createFirmMember(lawFirmId, {
    // Undefined, not `?? true`: a firm has at most one owner
    // (`members_one_owner_per_firm_idx`), and this helper is called repeatedly for
    // one firm. The factory makes the first member the owner and the rest plain
    // members, which is the shape the product actually produces.
    isOwner: opts.isOwner,
    permissions: opts.permissions ?? ['calendar.sync', 'calendar.view', 'tasks.view', 'matters.view', 'clients.view'],
  });

  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token)
     values ($1, 'google', $2, $3)`,
    [uid, accessToken, opts.refreshToken === undefined ? 'refresh-seed' : opts.refreshToken],
  );
  expect(tokens.rowCount).toBe(1);

  const settings = await testPool.query(
    `with touched as (update users set preferences = '{}'::jsonb, updated_at = now() where id = $1)
     insert into user_oauth_tokens (user_id, provider, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'google', $2, true)
     on conflict (user_id, provider) do update set is_sync_to_provider = excluded.is_sync_to_provider, is_sync_from_provider = excluded.is_sync_from_provider`,
    [uid, opts.outbound ?? true],
  );
  expect(settings.rowCount).toBe(1);

  return { uid, accessToken };
}

/**
 * Add a working Outlook connection to a user who already has `user_settings`
 * (from `connectGoogle`), so calendar.events.ts sees BOTH providers connected
 * and attempts both. Used only by the C08 cross-provider-isolation specs.
 */
async function connectOutlookAlso(uid: string, opts: { outbound?: boolean; accessToken?: string } = {}) {
  const accessToken = opts.accessToken ?? `tok-outlook-${randomUUID().slice(0, 8)}`;
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token)
     values ($1, 'microsoft', $2, 'refresh-seed')`,
    [uid, accessToken],
  );
  expect(tokens.rowCount).toBe(1);

  const settings = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'microsoft', $2, true)
     on conflict (user_id, provider) do update set
       is_sync_to_provider = excluded.is_sync_to_provider,
       is_sync_from_provider = excluded.is_sync_from_provider`,
    [uid, opts.outbound ?? true],
  );
  expect(settings.rowCount).toBe(1);
}

/** A firm member with no calendar connection at all. */
async function unconnectedMember(lawFirmId: string): Promise<string> {
  const { uid } = await createFirmMember(lawFirmId);
  const none = await testPool.query(
    `select count(*)::int as n from user_oauth_tokens where user_id = $1`, [uid],
  );
  expect(none.rows[0].n).toBe(0);
  return uid;
}

async function seedMatter(lawFirmId: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, 'Bell v. Ward', $3)`,
    [id, lawFirmId, `M-${id.slice(0, 8)}`],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function addMatterMember(lawFirmId: string, matterId: string, userId: string) {
  const res = await testPool.query(
    `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
     values ($1, $2, $3, 'member', now())`,
    [matterId, userId, lawFirmId],
  );
  expect(res.rowCount).toBe(1);
}

/** `calendar_sync` is the per-user jsonb map the adapters read event ids out of. */
function googleSyncMap(entries: Array<{ userId: string; key: string; eventId: string }>) {
  const google: Record<string, Record<string, { eventId: string }>> = {};
  for (const entry of entries) {
    google[entry.userId] = { ...(google[entry.userId] || {}), [entry.key]: { eventId: entry.eventId } };
  }
  return { google };
}

async function seedMatterEvent(
  lawFirmId: string,
  matterId: string,
  opts: { title?: string; date?: string | null; status?: string; calendarSync?: unknown } = {},
): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into events (id, law_firm_id, matter_id, type, title, date, status, calendar_sync)
     values ($1, $2, $3, 'hearing', $4, $5, $6, $7::jsonb)`,
    [
      id, lawFirmId, matterId,
      opts.title ?? 'Preliminary hearing',
      opts.date === undefined ? '2026-09-10T14:00:00Z' : opts.date,
      opts.status ?? 'upcoming',
      JSON.stringify(opts.calendarSync ?? {}),
    ],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

/** The `eventData` snapshot `matterEvents.service` puts on the event payload. */
async function matterEventPayload(lawFirmId: string, matterId: string, eventId: string) {
  const { rows } = await testPool.query(
    `select id, title, type, date, calendar_sync from events where id = $1`, [eventId],
  );
  expect(rows).toHaveLength(1);
  return {
    id: rows[0].id,
    lawFirmId,
    matterId,
    title: rows[0].title,
    type: rows[0].type,
    date: rows[0].date,
    calendarSync: rows[0].calendar_sync,
  };
}

async function seedClientEvent(
  lawFirmId: string,
  clientId: string,
  opts: { title?: string; calendarSync?: unknown } = {},
): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into events (id, law_firm_id, client_id, type, title, date, calendar_sync)
     values ($1, $2, $3, 'meeting', $4, '2026-09-12T15:00:00Z', $5::jsonb)`,
    [id, lawFirmId, clientId, opts.title ?? 'Intake meeting', JSON.stringify(opts.calendarSync ?? {})],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function clientEventPayload(lawFirmId: string, clientId: string, eventId: string) {
  const { rows } = await testPool.query(
    `select id, title, type, date, calendar_sync from events where id = $1`, [eventId],
  );
  expect(rows).toHaveLength(1);
  return {
    id: rows[0].id,
    lawFirmId,
    clientId,
    title: rows[0].title,
    type: rows[0].type,
    date: rows[0].date,
    calendarSync: rows[0].calendar_sync,
  };
}

/**
 * An invoice row plus the `invoiceData` snapshot the billing service emits.
 * Money on the wire is dollars on the entity and cents in the column.
 */
async function seedInvoice(
  lawFirmId: string,
  opts: {
    contextType: 'matter' | 'client';
    matterId?: string;
    clientId?: string;
    dueDate?: string;
    totalDollars?: number;
    calendarSync?: unknown;
  },
) {
  const id = randomUUID();
  const total = opts.totalDollars ?? 500;
  const res = await testPool.query(
    `insert into invoices
       (id, law_firm_id, matter_id, client_context_id, context_type, invoice_number,
        due_date, total_cents, status, calendar_sync)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'outstanding', $9::jsonb)`,
    [
      id, lawFirmId,
      opts.contextType === 'matter' ? opts.matterId : null,
      opts.contextType === 'client' ? opts.clientId : null,
      opts.contextType,
      `INV-${id.slice(0, 8)}`,
      opts.dueDate ?? '2026-10-01',
      total * 100,
      JSON.stringify(opts.calendarSync ?? {}),
    ],
  );
  expect(res.rowCount).toBe(1);

  return {
    id,
    lawFirmId,
    contextType: opts.contextType,
    matterId: opts.matterId ?? null,
    clientId: opts.clientId ?? null,
    clientContextId: opts.contextType === 'client' ? opts.clientId : null,
    invoiceNumber: `INV-${id.slice(0, 8)}`,
    dueDate: opts.dueDate ?? '2026-10-01',
    totalAmount: total,
    amountPaid: 0,
    totalWrittenOff: 0,
    isPaid: false,
    status: 'outstanding',
    calendarSync: opts.calendarSync ?? {},
  };
}

async function seedTask(
  lawFirmId: string,
  opts: { matterId?: string | null; createdBy?: string; calendarSync?: unknown } = {},
) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into tasks (id, law_firm_id, title, due_date, matter_id, created_by, calendar_sync)
     values ($1, $2, 'File the motion', '2026-09-20', $3, $4, $5::jsonb)`,
    [id, lawFirmId, opts.matterId ?? null, opts.createdBy ?? null,
      JSON.stringify(opts.calendarSync ?? {})],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function seedMapping(opts: {
  externalEventId: string;
  lawFirmId: string;
  userId: string;
  entityType: string;
  entityId: string;
  scopeId?: string | null;
  itemKey?: string;
}) {
  const res = await testPool.query(
    `insert into calendar_mappings
       (provider, external_event_id, calendar_id, user_id, law_firm_id,
        entity_type, entity_id, scope_id, item_key)
     values ('google', $1, 'primary', $2, $3, $4, $5, $6, $7)`,
    [opts.externalEventId, opts.userId, opts.lawFirmId, opts.entityType, opts.entityId,
      opts.scopeId ?? null, opts.itemKey ?? 'event'],
  );
  expect(res.rowCount).toBe(1);
}

// ── readers ─────────────────────────────────────────────────────────────────

const mappingRows = async () => (await testPool.query(
  `select external_event_id, law_firm_id, user_id, entity_type, entity_id, scope_id, item_key
     from calendar_mappings order by external_event_id`,
)).rows;

const matterEventSync = async (eventId: string) => (await testPool.query(
  `select calendar_sync from events where id = $1`, [eventId],
)).rows[0]?.calendar_sync;

const storedAccessToken = async (uid: string) => (await testPool.query(
  `select access_token from user_oauth_tokens where user_id = $1 and provider = 'google'`, [uid],
)).rows[0]?.access_token;

/** Mapping rows WITH provider, for the cross-provider (C08) specs. */
const mappingRowsByProvider = async () => (await testPool.query(
  `select provider, external_event_id, law_firm_id, user_id, entity_type, entity_id, scope_id, item_key
     from calendar_mappings order by provider, external_event_id`,
)).rows;

/** Outbound calls split by verb, since one url serves create, update and delete. */
const posts = () => callsMatching(EVENTS_URL).filter((c) => c.method === 'POST');
const patches = () => callsMatching(EVENTS_URL).filter((c) => c.method === 'PATCH');
const deletes = () => callsMatching(EVENTS_URL).filter((c) => c.method === 'DELETE');
const outlookPosts = () => callsMatching(OUTLOOK_EVENTS_URL).filter((c) => c.method === 'POST');

/**
 * Seed an `event_outbox` row directly, and read back the exact shape a real
 * worker claim hands `dispatchRow`: row columns plus `xmin::text` as the fenced
 * lease token. Mirrors the pattern in `tests/events/eventOutbox.test.ts`. `xmin`
 * changes on every UPDATE, so a snapshot must be re-read before each dispatch of
 * the same row (a retry included).
 */
async function seedOutboxRow(eventType: string, payload: Record<string, unknown>): Promise<string> {
  // Mirror eventOutbox.ts's real `enqueue()`: the row's own `law_firm_id`
  // column is derived from `payload.lawFirmId`, not left unset. dispatchRow
  // refuses a row whose denormalized `law_firm_id` disagrees with its
  // payload (see the B08.3 cross-tenant replay guard) - a row seeded here
  // with a lawFirmId-bearing payload but no row-level law_firm_id trips that
  // guard exactly as it should for a genuinely inconsistent row, so this
  // fixture must produce the same shape a real enqueue would.
  const lawFirmId = typeof payload.lawFirmId === 'string' ? payload.lawFirmId : null;
  const { rows } = await testPool.query(
    `insert into event_outbox (law_firm_id, event_type, payload, status, attempts)
     values ($1, $2, $3::jsonb, 'pending', 0) returning id`,
    [lawFirmId, eventType, JSON.stringify(payload)],
  );
  return rows[0].id;
}

async function claimSnapshot(id: string) {
  const { rows } = await testPool.query(
    `select id, law_firm_id, event_type, payload, attempts, xmin::text as lease_token from event_outbox where id = $1`,
    [id],
  );
  return rows[0];
}

const outboxRowStatus = async (id: string) => (await testPool.query(
  `select status, attempts from event_outbox where id = $1`, [id],
)).rows[0];

/** Answer every create with a distinct id, so duplicates are visible as rows. */
function routeCreates(prefix = 'g-evt') {
  route(EVENTS_URL, (_call, hit) => ({ status: 200, json: { id: `${prefix}-${hit}` } }), { method: 'POST' });
}

// ── the wall ────────────────────────────────────────────────────────────────

describe('the network wall and the path to it', () => {
  /**
   * THE FOUNDATION CASE. It proves an emit alone, with real oauth-token fixtures,
   * drives a real outbound Google request for EVERY matter member. Every later
   * "no call was made" assertion is worthless without it, and so is every case in
   * this file if the fan-out cannot be reached.
   *
   * Goes red if the MATTER_EVENT_CREATED handler is removed or stops fanning out
   * to matter members, if the capability pre-check stops recognising a connected
   * user, if the adapter stops producing an item, or if the mapping/writeback
   * bookkeeping after a successful create is dropped.
   */
  test('MATTER_EVENT_CREATED reaches Google the creator when no assignees were selected', async () => {
    const author = await connectGoogle(firm.id, { accessToken: 'tok-author' });
    const colleague = await connectGoogle(firm.id, { accessToken: 'tok-colleague' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, author.uid);
    await addMatterMember(firm.id, matterId, colleague.uid);
    const eventId = await seedMatterEvent(firm.id, matterId, { title: 'Preliminary hearing' });

    expect(wallIsUp()).toBe(true);
    routeCreates();

    await emitAndDrain(MATTER_EVENT_CREATED, {
      lawFirmId: firm.id,
      matterId,
      eventId,
      eventData: await matterEventPayload(firm.id, matterId, eventId),
      userId: author.uid,
    });

    const created = posts();
    expect(created).toHaveLength(1);
    expect(created.map((c) => c.bearer).sort()).toEqual(['tok-author']);
    expect(created[0].body.summary).toBe('Preliminary hearing');
    // The adapter really ran, rather than some generic body being posted.
    expect(created[0].body.description).toContain('Matter event from Paralegix');

    // The durable bookkeeping that decides create-versus-update next time.
    const mappings = await mappingRows();
    expect(mappings).toHaveLength(1);
    expect(mappings.map((m) => m.user_id).sort()).toEqual([author.uid]);
    for (const mapping of mappings) {
      expect(mapping.law_firm_id).toBe(firm.id);
      expect(mapping.entity_type).toBe('matterEvent');
      expect(mapping.entity_id).toBe(eventId);
      expect(mapping.scope_id).toBe(matterId);
    }

    const sync = await matterEventSync(eventId);
    expect(Object.keys(sync.google).sort()).toEqual([author.uid]);
  });

  /**
   * Goes red if the router starts answering unregistered urls instead of
   * throwing, or if the listener stops containing a provider failure. The
   * recorded attempt is what separates "blocked" from "never tried".
   */
  test('an unrouted provider call is blocked, recorded, and contained by the listener', async () => {
    const user = await connectGoogle(firm.id, { accessToken: 'tok-blocked' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, user.uid);
    const eventId = await seedMatterEvent(firm.id, matterId);

    // No route registered on purpose.
    await emitAndDrain(MATTER_EVENT_CREATED, {
      lawFirmId: firm.id,
      matterId,
      eventId,
      eventData: await matterEventPayload(firm.id, matterId, eventId),
      userId: user.uid,
    });

    const attempts = posts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].bearer).toBe('tok-blocked');
    expect(await mappingRows()).toHaveLength(0);
    // The wall's refusal carries this marker; nothing swallowed it into a success.
    await expect(fetch(`https://www.googleapis.com/calendar/v3${EVENTS_URL}`))
      .rejects.toThrow(BLOCKED);
  });
});

// ── matter events ───────────────────────────────────────────────────────────

describe('matter event listeners', () => {
  test('records outbound work before a failed provider call and replays it through the cron route', async () => {
    const user = await connectGoogle(firm.id, { accessToken: 'tok-retry' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id,matterId,user.uid);
    const eventId = await seedMatterEvent(firm.id,matterId);
    let queuedBeforeCall = 0;
    let attempts = 0;
    route(EVENTS_URL, async () => {
      queuedBeforeCall = (await testPool.query("select count(*)::int as n from calendar_sync_failures where kind = 'outbound' and user_id = $1", [user.uid])).rows[0].n;
      return ++attempts === 1 ? { status: 503 } : { status: 200, json: { id: 'g-recovered' } };
    }, { method: 'POST' });
    await emitAndDrain(MATTER_EVENT_CREATED, { lawFirmId: firm.id,matterId,eventData: await matterEventPayload(firm.id,matterId,eventId),userId:user.uid });
    expect(posts()).toHaveLength(1);
    expect(queuedBeforeCall).toBe(1);
    expect((await testPool.query("select count(*)::int as n from calendar_sync_failures where kind = 'outbound'")).rows[0].n).toBe(1);
    await testPool.query("update calendar_sync_failures set next_attempt_at = now() where kind = 'outbound'");
    const cron = request().post('/api/cron/calendar-watch');
    const response = await (process.env.CRON_SECRET ? cron.set('x-cron-secret', process.env.CRON_SECRET) : cron.set('x-cloudscheduler', 'true'));
    expect(response.status).toBe(200);
    expect(posts()).toHaveLength(2);
    expect((await mappingRows()).map((row) => row.external_event_id)).toEqual(['g-recovered']);
    expect((await testPool.query("select count(*)::int as n from calendar_sync_failures where kind = 'outbound'")).rows[0].n).toBe(0);
  });
  test('sends a private copy to assigned people and removes the former roster copy', async () => {
    const author = await connectGoogle(firm.id, { accessToken: 'tok-author' });
    const assignee = await connectGoogle(firm.id, { accessToken: 'tok-assignee' });
    const roster = await connectGoogle(firm.id, { accessToken: 'tok-roster' });
    const matterId = await seedMatter(firm.id);
    for (const member of [author, assignee, roster]) await addMatterMember(firm.id, matterId, member.uid);
    const eventId = await seedMatterEvent(firm.id, matterId, { calendarSync: googleSyncMap([{ userId: roster.uid, key: 'event', eventId: 'g-old-roster' }]) });
    await testPool.query('insert into event_assignees (law_firm_id,event_id,user_id) values ($1,$2,$3)', [firm.id,eventId,assignee.uid]);
    routeCreates();
    route(`${EVENTS_URL}/g-old-roster`, { status: 204 }, { method: 'DELETE' });
    const payload = { ...await matterEventPayload(firm.id,matterId,eventId), assignedTo: [assignee.uid], createdBy: author.uid };
    await emitAndDrain(MATTER_EVENT_UPDATED, { lawFirmId: firm.id, matterId, eventData: payload, userId: author.uid });
    expect(posts().map((call) => call.bearer)).toEqual(['tok-assignee']);
    expect(deletes().map((call) => call.bearer)).toEqual(['tok-roster']);
    expect(posts()[0].body.attendees).toBeUndefined();
  });

  test('client event assignments survive a different last editor', async () => {
    const editor = await connectGoogle(firm.id, { accessToken: 'tok-editor' });
    const assignee = await connectGoogle(firm.id, { accessToken: 'tok-assignee' });
    const client = await createPersonClient(firm.id);
    const eventId = await seedClientEvent(firm.id,client.id);
    await testPool.query('insert into event_assignees (law_firm_id,event_id,user_id) values ($1,$2,$3)', [firm.id,eventId,assignee.uid]);
    routeCreates();
    await emitAndDrain(CLIENT_EVENT_UPDATED, { eventData: { ...await clientEventPayload(firm.id,client.id,eventId), assignedTo: [assignee.uid], createdBy: editor.uid }, userId: editor.uid });
    expect(posts().map((call) => call.bearer)).toEqual(['tok-assignee']);
  });
  /**
   * Goes red if MATTER_EVENT_UPDATED stops reading the per-user writeback (it
   * would POST a second event instead of patching the first) or if the handler
   * stops fanning out.
   */
  test('MATTER_EVENT_UPDATED patches the creator copy and removes an unassigned roster copy', async () => {
    const author = await connectGoogle(firm.id, { accessToken: 'tok-author' });
    const colleague = await connectGoogle(firm.id, { accessToken: 'tok-colleague' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, author.uid);
    await addMatterMember(firm.id, matterId, colleague.uid);
    const eventId = await seedMatterEvent(firm.id, matterId, {
      title: 'Hearing moved',
      calendarSync: googleSyncMap([
        { userId: author.uid, key: 'event', eventId: 'g-author' },
        { userId: colleague.uid, key: 'event', eventId: 'g-colleague' },
      ]),
    });

    route(`${EVENTS_URL}/g-author`, { status: 200, json: { id: 'g-author' } }, { method: 'PATCH' });
    route(`${EVENTS_URL}/g-colleague`, { status: 204 }, { method: 'DELETE' });
    routeCreates();

    await emitAndDrain(MATTER_EVENT_UPDATED, {
      lawFirmId: firm.id,
      matterId,
      eventId,
      eventData: await matterEventPayload(firm.id, matterId, eventId),
      userId: author.uid,
    });

    expect(posts()).toHaveLength(0);
    const patched = patches();
    expect(patched).toHaveLength(1);
    expect(patched.map((c) => new URL(c.url).pathname.split('/').pop()).sort()).toEqual(['g-author']);
    expect(patched.map((c) => c.bearer).sort()).toEqual(['tok-author']);
    expect(patched[0].body.summary).toBe('Hearing moved');
    expect(deletes().map((call) => call.bearer)).toEqual(['tok-colleague']);
  });

  /**
   * Goes red if MATTER_EVENT_DELETED stops issuing the DELETE, stops fanning out
   * to members, or stops clearing the mapping row (a stale mapping makes the next
   * update PATCH an event that no longer exists at the provider).
   */
  test('MATTER_EVENT_DELETED removes the event from each member calendar and drops the mapping', async () => {
    const author = await connectGoogle(firm.id, { accessToken: 'tok-author' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, author.uid);
    const eventId = await seedMatterEvent(firm.id, matterId, {
      calendarSync: googleSyncMap([{ userId: author.uid, key: 'event', eventId: 'g-author' }]),
    });
    await seedMapping({
      externalEventId: 'g-author', lawFirmId: firm.id, userId: author.uid,
      entityType: 'matterEvent', entityId: eventId, scopeId: matterId,
    });

    route(`${EVENTS_URL}/g-author`, { status: 204 }, { method: 'DELETE' });

    await emitAndDrain(MATTER_EVENT_DELETED, {
      lawFirmId: firm.id,
      matterId,
      eventId,
      eventData: await matterEventPayload(firm.id, matterId, eventId),
      userId: author.uid,
    });

    const removed = deletes();
    expect(removed).toHaveLength(1);
    expect(removed[0].url).toContain('/events/g-author');
    expect(removed[0].bearer).toBe('tok-author');
    expect(await mappingRows()).toHaveLength(0);
  });

  /**
   * The `if (!eventData) return` guard. Goes red if it is removed: the fan-out
   * would run with an undefined entity and reach the adapter.
   *
   * The second half is what keeps this from passing vacuously. Deleting the whole
   * handler also produces "no provider call", so the same fixtures have to be
   * shown reaching Google once the payload is complete.
   */
  test('an event payload with no eventData makes no provider call', async () => {
    const user = await connectGoogle(firm.id);
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, user.uid);
    const eventId = await seedMatterEvent(firm.id, matterId);
    routeCreates();

    await emitAndDrain(MATTER_EVENT_CREATED, {
      lawFirmId: firm.id, matterId, eventId, eventData: null, userId: user.uid,
    });
    expect(googleCalls()).toHaveLength(0);

    await emitAndDrain(MATTER_EVENT_CREATED, {
      lawFirmId: firm.id,
      matterId,
      eventId,
      eventData: await matterEventPayload(firm.id, matterId, eventId),
      userId: user.uid,
    });
    expect(posts()).toHaveLength(1);
  });
});

// ── client events ───────────────────────────────────────────────────────────

describe('client event listeners', () => {
  /**
   * A client event is NOT a matter event: it goes to the acting user alone, with
   * no fan-out. Goes red if the CLIENT_EVENT_CREATED handler is removed (no call)
   * or if it is ever switched to a firm-wide/member fan-out (the colleague seeded
   * here, who is connected and would receive one, proves the difference).
   */
  test('CLIENT_EVENT_CREATED posts only to the acting user calendar', async () => {
    const actor = await connectGoogle(firm.id, { accessToken: 'tok-actor' });
    await connectGoogle(firm.id, { accessToken: 'tok-colleague' });
    const client = await createPersonClient(firm.id);
    const eventId = await seedClientEvent(firm.id, client.id, { title: 'Intake meeting' });

    routeCreates('g-client');

    await emitAndDrain(CLIENT_EVENT_CREATED, {
      lawFirmId: firm.id,
      clientId: client.id,
      eventId,
      eventData: await clientEventPayload(firm.id, client.id, eventId),
      userId: actor.uid,
    });

    const created = posts();
    expect(created).toHaveLength(1);
    expect(created[0].bearer).toBe('tok-actor');
    expect(created[0].body.summary).toBe('Intake meeting');

    const mappings = await mappingRows();
    expect(mappings).toHaveLength(1);
    expect(mappings[0].entity_type).toBe('clientEvent');
    expect(mappings[0].scope_id).toBe(client.id);
  });

  /**
   * Goes red if either handler stops issuing its verb, or if the update path
   * stops reading the stored per-user event id and POSTs a duplicate instead.
   */
  test('CLIENT_EVENT_UPDATED patches and CLIENT_EVENT_DELETED deletes the same event', async () => {
    const actor = await connectGoogle(firm.id, { accessToken: 'tok-actor' });
    const client = await createPersonClient(firm.id);
    const eventId = await seedClientEvent(firm.id, client.id, {
      calendarSync: googleSyncMap([{ userId: actor.uid, key: 'event', eventId: 'g-client-1' }]),
    });

    route(`${EVENTS_URL}/g-client-1`, { status: 200, json: { id: 'g-client-1' } }, { method: 'PATCH' });
    route(`${EVENTS_URL}/g-client-1`, { status: 204 }, { method: 'DELETE' });
    routeCreates('g-unexpected');

    const payload = await clientEventPayload(firm.id, client.id, eventId);
    await emitAndDrain(CLIENT_EVENT_UPDATED, {
      lawFirmId: firm.id, clientId: client.id, eventId, eventData: payload, userId: actor.uid,
    });
    await emitAndDrain(CLIENT_EVENT_DELETED, {
      lawFirmId: firm.id, clientId: client.id, eventId, eventData: payload, userId: actor.uid,
    });

    expect(posts()).toHaveLength(0);
    expect(patches()).toHaveLength(1);
    expect(patches()[0].bearer).toBe('tok-actor');
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0].url).toContain('/events/g-client-1');
  });

  /**
   * The `if (!eventData || !userId) return` guard. Goes red if it is removed.
   */
  test('a client event with no acting user makes no provider call', async () => {
    const actor = await connectGoogle(firm.id);
    const client = await createPersonClient(firm.id);
    const eventId = await seedClientEvent(firm.id, client.id);
    routeCreates();

    await emitAndDrain(CLIENT_EVENT_CREATED, {
      lawFirmId: firm.id,
      clientId: client.id,
      eventId,
      eventData: await clientEventPayload(firm.id, client.id, eventId),
      userId: null,
    });
    expect(googleCalls()).toHaveLength(0);

    // The same payload WITH the user reaches Google, so the absence above is the
    // guard rather than a broken fixture.
    await emitAndDrain(CLIENT_EVENT_CREATED, {
      lawFirmId: firm.id,
      clientId: client.id,
      eventId,
      eventData: await clientEventPayload(firm.id, client.id, eventId),
      userId: actor.uid,
    });
    expect(posts()).toHaveLength(1);
  });
});

// ── invoices ────────────────────────────────────────────────────────────────

describe('invoice billing listeners', () => {
  /**
   * A matter-context invoice goes to firm billing recipients who are ALSO members
   * of that matter. The ethical wall lives in `resolveBillingRecipients`.
   *
   * Goes red if the matter-member intersection is dropped (the outsider, who is a
   * connected firm owner and therefore a firm-wide recipient, would receive the
   * invoice date) or if the INVOICE_CREATED handler is removed (nobody would).
   */
  test('INVOICE_CREATED on a matter reaches only recipients on that matter', async () => {
    const onMatter = await connectGoogle(firm.id, { accessToken: 'tok-on-matter' });
    const offMatter = await connectGoogle(firm.id, { accessToken: 'tok-off-matter' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, onMatter.uid);
    const invoice = await seedInvoice(firm.id, { contextType: 'matter', matterId });

    routeCreates('g-inv');

    await emitAndDrain(INVOICE_CREATED, {
      lawFirmId: firm.id, invoiceId: invoice.id, userId: onMatter.uid, invoiceData: invoice,
    });

    const created = posts();
    expect(created).toHaveLength(1);
    expect(created[0].bearer).toBe('tok-on-matter');
    expect(created.map((c) => c.bearer)).not.toContain(offMatter.accessToken);
    expect(created[0].body.summary).toContain('Billing:');

    const mappings = await mappingRows();
    expect(mappings).toHaveLength(1);
    expect(mappings[0].entity_type).toBe('invoiceBilling');
    expect(mappings[0].item_key).toBe('dueDate');
  });

  /**
   * A client-context invoice has no matter to narrow by, so every firm billing
   * recipient receives it. Goes red if the firm-wide branch stops resolving
   * recipients, and it is the control that proves the previous case's exclusion
   * came from the matter filter rather than from a broken recipient query.
   */
  test('INVOICE_CREATED on a client reaches every firm billing recipient', async () => {
    // `one` is the firm's owner, which the recipient query admits outright. A
    // colleague qualifies only by holding both permissions that query names, so
    // `two` spells them out rather than relying on a second owner the schema no
    // longer allows.
    const one = await connectGoogle(firm.id, { accessToken: 'tok-one' });
    const two = await connectGoogle(firm.id, {
      accessToken: 'tok-two',
      isOwner: false,
      permissions: ['billing.viewInvoices', 'calendar.sync'],
    });
    const client = await createPersonClient(firm.id);
    const invoice = await seedInvoice(firm.id, { contextType: 'client', clientId: client.id });

    routeCreates('g-inv');

    await emitAndDrain(INVOICE_CREATED, {
      lawFirmId: firm.id, invoiceId: invoice.id, userId: one.uid, invoiceData: invoice,
    });

    expect(posts().map((c) => c.bearer).sort()).toEqual([one.accessToken, two.accessToken].sort());
  });

  /**
   * RBAC_ENFORCED is true in `calendar.events.ts`, so a member's role has to grant
   * BOTH `billing.viewInvoices` and `calendar.sync` to receive billing dates.
   *
   * Goes red if the permission-filtered recipient query is replaced by the
   * "every member" branch: the calendar-only member would start receiving invoice
   * due dates, which is a money disclosure to someone whose role withholds it.
   */
  test('a member whose role lacks billing.viewInvoices receives no invoice date', async () => {
    const allowed = await connectGoogle(firm.id, {
      accessToken: 'tok-allowed',
      isOwner: false,
      permissions: ['billing.viewInvoices', 'calendar.sync'],
    });
    const denied = await connectGoogle(firm.id, {
      accessToken: 'tok-denied',
      isOwner: false,
      permissions: ['calendar.sync'],
    });
    const client = await createPersonClient(firm.id);
    const invoice = await seedInvoice(firm.id, { contextType: 'client', clientId: client.id });

    routeCreates('g-inv');

    await emitAndDrain(INVOICE_CREATED, {
      lawFirmId: firm.id, invoiceId: invoice.id, userId: allowed.uid, invoiceData: invoice,
    });

    expect(posts()).toHaveLength(1);
    expect(posts()[0].bearer).toBe('tok-allowed');
    expect(posts().map((c) => c.bearer)).not.toContain(denied.accessToken);
  });

  /**
   * Goes red if either handler stops issuing its verb for the billing adapter.
   * The stored per-user id is what turns an update into a PATCH rather than a
   * duplicate entry.
   */
  test('INVOICE_UPDATED patches and INVOICE_DELETED deletes the billing entry', async () => {
    const recipient = await connectGoogle(firm.id, { accessToken: 'tok-recipient' });
    const client = await createPersonClient(firm.id);
    const invoice = await seedInvoice(firm.id, {
      contextType: 'client',
      clientId: client.id,
      calendarSync: { google: { [recipient.uid]: { dueDate: { eventId: 'g-bill-1' } } } },
    });

    route(`${EVENTS_URL}/g-bill-1`, { status: 200, json: { id: 'g-bill-1' } }, { method: 'PATCH' });
    route(`${EVENTS_URL}/g-bill-1`, { status: 204 }, { method: 'DELETE' });
    routeCreates('g-unexpected');

    await emitAndDrain(INVOICE_UPDATED, {
      lawFirmId: firm.id, invoiceId: invoice.id, userId: recipient.uid, invoiceData: invoice,
    });
    expect(patches()).toHaveLength(1);
    expect(patches()[0].bearer).toBe('tok-recipient');

    await emitAndDrain(INVOICE_DELETED, {
      lawFirmId: firm.id, invoiceId: invoice.id, userId: recipient.uid, invoiceData: invoice,
    });
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0].url).toContain('/events/g-bill-1');
    expect(posts()).toHaveLength(0);
  });

  /**
   * A paid invoice produces no calendar items at all, so nobody's calendar is
   * touched. Goes red if the adapter starts emitting items for a settled invoice,
   * which would put a due date back on every recipient's calendar on any later
   * update.
   */
  test('a fully paid invoice reaches nobody', async () => {
    const recipient = await connectGoogle(firm.id, { accessToken: 'tok-recipient' });
    const client = await createPersonClient(firm.id);
    const invoice = await seedInvoice(firm.id, { contextType: 'client', clientId: client.id });
    routeCreates('g-inv');

    await emitAndDrain(INVOICE_CREATED, {
      lawFirmId: firm.id,
      invoiceId: invoice.id,
      userId: recipient.uid,
      invoiceData: { ...invoice, amountPaid: invoice.totalAmount, isPaid: true },
    });
    expect(googleCalls()).toHaveLength(0);

    // The unpaid version of the same invoice does reach Google, so the absence
    // above is the paid-invoice rule and not an inert fixture.
    await emitAndDrain(INVOICE_CREATED, {
      lawFirmId: firm.id, invoiceId: invoice.id, userId: recipient.uid, invoiceData: invoice,
    });
    expect(posts()).toHaveLength(1);
  });
});

// ── tasks ───────────────────────────────────────────────────────────────────

describe('TASK_DELETED', () => {
  test('a deleted matter task is removed from former members calendars', async () => {
    const author = await connectGoogle(firm.id, { accessToken: 'tok-former-author' });
    const colleague = await connectGoogle(firm.id, { accessToken: 'tok-former-colleague' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, author.uid);
    await addMatterMember(firm.id, matterId, colleague.uid);
    const calendarSync = googleSyncMap([
      { userId: author.uid, key: 'dueDate', eventId: 'g-former-author' },
      { userId: colleague.uid, key: 'dueDate', eventId: 'g-former-colleague' },
    ]);
    const taskId = await seedTask(firm.id, { matterId, createdBy: author.uid, calendarSync });
    const removedMatter = await testPool.query('delete from matters where id = $1', [matterId]);
    expect(removedMatter.rowCount).toBe(1);

    route(`${EVENTS_URL}/g-former-author`, { status: 204 }, { method: 'DELETE' });
    route(`${EVENTS_URL}/g-former-colleague`, { status: 204 }, { method: 'DELETE' });
    await emitAndDrain(TASK_DELETED, {
      lawFirmId: firm.id, taskId, userId: author.uid,
      recipientUserIds: [author.uid, colleague.uid],
      entityData: {
        id: taskId, lawFirmId: firm.id, matterId, title: 'File the motion',
        dueDate: '2026-09-20', createdBy: author.uid, calendarSync,
      },
    });
    expect(deletes().map((call) => call.url.split('/').pop()).sort())
      .toEqual(['g-former-author', 'g-former-colleague']);
  });

  /**
   * Goes red if the matter branch of TASK_DELETED stops fanning out to matter
   * members: the colleague's copy of the due date would be orphaned on their real
   * calendar with nothing left in Paralegix pointing at it.
   */
  test('a matter task is deleted from every matter member calendar', async () => {
    const author = await connectGoogle(firm.id, { accessToken: 'tok-author' });
    const colleague = await connectGoogle(firm.id, { accessToken: 'tok-colleague' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, author.uid);
    await addMatterMember(firm.id, matterId, colleague.uid);
    const calendarSync = googleSyncMap([
      { userId: author.uid, key: 'dueDate', eventId: 'g-task-author' },
      { userId: colleague.uid, key: 'dueDate', eventId: 'g-task-colleague' },
    ]);
    const taskId = await seedTask(firm.id, { matterId, createdBy: author.uid, calendarSync });

    route(`${EVENTS_URL}/g-task-author`, { status: 204 }, { method: 'DELETE' });
    route(`${EVENTS_URL}/g-task-colleague`, { status: 204 }, { method: 'DELETE' });

    await emitAndDrain(TASK_DELETED, {
      lawFirmId: firm.id,
      taskId,
      userId: author.uid,
      entityData: {
        id: taskId, lawFirmId: firm.id, matterId, title: 'File the motion',
        dueDate: '2026-09-20', createdBy: author.uid, calendarSync,
      },
    });

    const removed = deletes();
    expect(removed).toHaveLength(2);
    expect(removed.map((c) => c.url.split('/').pop()).sort())
      .toEqual(['g-task-author', 'g-task-colleague']);
    expect(removed.map((c) => c.bearer).sort()).toEqual(['tok-author', 'tok-colleague']);
  });

  /**
   * A task with no matter has a different recipient rule: creator plus assignees.
   *
   * Goes red if `getStandaloneTaskUserIds` stops including either the creator or
   * the assignee list, or if the matterless branch is removed. The unconnected
   * firm member proves the fan-out really is bounded by that rule rather than
   * reaching everyone.
   */
  test('a standalone task is deleted from the creator and assignee calendars', async () => {
    const creator = await connectGoogle(firm.id, { accessToken: 'tok-creator' });
    const assignee = await connectGoogle(firm.id, { accessToken: 'tok-assignee' });
    await connectGoogle(firm.id, { accessToken: 'tok-bystander' });
    const calendarSync = googleSyncMap([
      { userId: creator.uid, key: 'dueDate', eventId: 'g-task-creator' },
      { userId: assignee.uid, key: 'dueDate', eventId: 'g-task-assignee' },
    ]);
    const taskId = await seedTask(firm.id, { createdBy: creator.uid, calendarSync });

    route(`${EVENTS_URL}/g-task-creator`, { status: 204 }, { method: 'DELETE' });
    route(`${EVENTS_URL}/g-task-assignee`, { status: 204 }, { method: 'DELETE' });

    await emitAndDrain(TASK_DELETED, {
      lawFirmId: firm.id,
      taskId,
      userId: creator.uid,
      entityData: {
        id: taskId, lawFirmId: firm.id, matterId: null, title: 'File the motion',
        dueDate: '2026-09-20', createdBy: creator.uid, assignedTo: [assignee.uid], calendarSync,
      },
    });

    expect(deletes().map((c) => c.bearer).sort()).toEqual(['tok-assignee', 'tok-creator']);
  });
});

// ── matter membership changes ───────────────────────────────────────────────

describe('MATTER_MEMBERS_UPDATED', () => {
  /**
   * Adding a member backfills the matter's existing calendar items onto THEIR
   * calendar and nobody else's.
   *
   * Goes red if the backfill is removed (the new member gets nothing), if it
   * stops restricting itself to `addedUserIds` (the sitting member gets a second
   * copy of everything), or if the cancelled/undated filters are dropped (a
   * cancelled hearing and a dateless placeholder would appear on a real calendar).
   */
  test('backfills the matter onto an added member only, skipping cancelled and undated items', async () => {
    const sitting = await connectGoogle(firm.id, { accessToken: 'tok-sitting' });
    const added = await connectGoogle(firm.id, { accessToken: 'tok-added' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, sitting.uid);
    await addMatterMember(firm.id, matterId, added.uid);

    const live = await seedMatterEvent(firm.id, matterId, { title: 'Live hearing' });
    await testPool.query('insert into event_assignees (law_firm_id, event_id, user_id) values ($1,$2,$3)', [firm.id, live, added.uid]);
    await seedMatterEvent(firm.id, matterId, { title: 'Unassigned hearing' });
    await seedMatterEvent(firm.id, matterId, { title: 'Cancelled hearing', status: 'cancelled' });
    await seedMatterEvent(firm.id, matterId, { title: 'Undated placeholder', date: null });

    routeCreates('g-backfill');

    await emitAndDrain(MATTER_MEMBERS_UPDATED, {
      lawFirmId: firm.id,
      matterId,
      memberUserIds: [sitting.uid, added.uid],
      addedUserIds: [added.uid],
      actorUserId: sitting.uid,
    });

    const created = posts();
    expect(created).toHaveLength(1);
    expect(created[0].bearer).toBe('tok-added');
    expect(created[0].body.summary).toBe('Live hearing');

    const mappings = await mappingRows();
    expect(mappings).toHaveLength(1);
    expect(mappings[0].user_id).toBe(added.uid);
    expect(mappings[0].entity_id).toBe(live);
  });

  /**
   * Removing a member takes the matter off THEIR external calendar.
   *
   * `matterMembers.service.removeMembers` used to emit MATTER_MEMBERS_UPDATED
   * with no removed ids, and the calendar listener only had an add branch, so
   * an ex-member kept every hearing, deposition and deadline for a matter they
   * are no longer staffed on, and the `calendar_mappings` row pointing at it
   * survived. That is a confidentiality gap, not a missing nicety.
   *
   * Driven through `POST /matters/:matterId/members/remove` rather than a
   * hand-built payload, so it covers both halves: the service naming
   * `removedUserIds` on its event, and the listener's removal branch. Goes red
   * if either is dropped, as "no DELETE was issued and the mapping survived".
   */
  test('removing a member through the route clears their external event', async () => {
    const lead = await connectGoogle(firm.id, { accessToken: 'tok-lead' });
    const leaving = await connectGoogle(firm.id, { accessToken: 'tok-leaving' });
    const matterId = await seedMatter(firm.id);
    // Two members: removeMembers refuses to strip the last one.
    await addMatterMember(firm.id, matterId, lead.uid);
    await addMatterMember(firm.id, matterId, leaving.uid);
    const eventId = await seedMatterEvent(firm.id, matterId, {
      calendarSync: googleSyncMap([
        { userId: lead.uid, key: 'event', eventId: 'g-lead' },
        { userId: leaving.uid, key: 'event', eventId: 'g-leaving' },
      ]),
    });
    await seedMapping({
      externalEventId: 'g-lead', lawFirmId: firm.id, userId: lead.uid,
      entityType: 'matterEvent', entityId: eventId, scopeId: matterId,
    });
    await seedMapping({
      externalEventId: 'g-leaving', lawFirmId: firm.id, userId: leaving.uid,
      entityType: 'matterEvent', entityId: eventId, scopeId: matterId,
    });

    route(`${EVENTS_URL}/g-leaving`, { status: 204 }, { method: 'DELETE' });
    route(`${EVENTS_URL}/g-lead`, { status: 204 }, { method: 'DELETE' });

    const res = await as(tokenFor({ uid: lead.uid }))
      .post(`/api/lawfirms/${firm.id}/matters/${matterId}/members/remove`)
      .send({ targetUserIds: [leaving.uid] });
    expect(res.status).toBe(200);
    await drainEvents();

    // Only the ex-member's copy is removed; the remaining member keeps theirs.
    const removedCalls = deletes();
    expect(removedCalls).toHaveLength(1);
    expect(removedCalls[0].url).toContain('/events/g-leaving');
    expect(removedCalls[0].bearer).toBe('tok-leaving');
    // A removal is not a backfill: nothing is created for the member who stays.
    expect(posts()).toHaveLength(0);
    expect((await mappingRows()).map((m) => m.external_event_id)).toEqual(['g-lead']);
  });
});

// ── users the fan-out must skip ─────────────────────────────────────────────

describe('users with no usable calendar connection', () => {
  /**
   * Goes red if the capability pre-check stops short-circuiting: an unconnected
   * user would be loaded and handed to the provider services, and any provider
   * call attempted on their behalf would hit the wall and be recorded here. The
   * connected colleague on the same matter is what proves the fan-out ran at all.
   */
  test('a member with no calendar connection is skipped, and the fan-out still serves the rest', async () => {
    const connected = await connectGoogle(firm.id, { accessToken: 'tok-connected' });
    const bare = await unconnectedMember(firm.id);
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, connected.uid);
    await addMatterMember(firm.id, matterId, bare);
    const eventId = await seedMatterEvent(firm.id, matterId);

    routeCreates();

    await emitAndDrain(MATTER_EVENT_CREATED, {
      lawFirmId: firm.id,
      matterId,
      eventId,
      eventData: { ...await matterEventPayload(firm.id, matterId, eventId), assignedTo: [connected.uid, bare] },
      userId: bare,
    });

    const created = posts();
    expect(created).toHaveLength(1);
    expect(created[0].bearer).toBe('tok-connected');
    expect((await mappingRows()).map((m) => m.user_id)).toEqual([connected.uid]);
  });

  /**
   * Connected but outbound sync switched off. Goes red if
   * `getOutboundSyncCapabilities` stops consulting
   * `allow_paralegix_to_google_sync`: a user who turned Paralegix-to-Google sync
   * off would start receiving events again.
   */
  test('a member who disabled outbound sync is skipped', async () => {
    const enabled = await connectGoogle(firm.id, { accessToken: 'tok-enabled' });
    const disabled = await connectGoogle(firm.id, { accessToken: 'tok-disabled', outbound: false });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, enabled.uid);
    await addMatterMember(firm.id, matterId, disabled.uid);
    const eventId = await seedMatterEvent(firm.id, matterId);

    routeCreates();

    await emitAndDrain(MATTER_EVENT_CREATED, {
      lawFirmId: firm.id,
      matterId,
      eventId,
      eventData: await matterEventPayload(firm.id, matterId, eventId),
      userId: enabled.uid,
    });

    expect(posts().map((c) => c.bearer)).toEqual(['tok-enabled']);
  });

  /**
   * A revoked grant: Google answers 401 and then refuses the refresh token. The
   * listener must absorb that, leave the stored token alone (so the user is asked
   * to reconnect rather than silently losing their credentials), and let the
   * emitting request finish. The connected colleague proves one broken connection
   * does not cost the other members their sync.
   *
   * Goes red if the failed refresh starts overwriting the stored access token, if
   * the 401 path stops attempting exactly one refresh, or if the per-user failure
   * stops being contained inside the fan-out.
   */
  test('a revoked token fails that member alone and leaves the stored token intact', async () => {
    const revoked = await connectGoogle(firm.id, {
      accessToken: 'tok-revoked', refreshToken: 'refresh-revoked',
    });
    const healthy = await connectGoogle(firm.id, { accessToken: 'tok-healthy' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, revoked.uid);
    await addMatterMember(firm.id, matterId, healthy.uid);
    const eventId = await seedMatterEvent(firm.id, matterId);

    route(EVENTS_URL, (call) => (call.bearer === 'tok-revoked'
      ? { status: 401, json: { error: { code: 401, message: 'Invalid Credentials' } } }
      : { status: 200, json: { id: 'g-healthy' } }), { method: 'POST' });
    route(TOKEN_URL, { status: 400, json: { error: 'invalid_grant' } });

    let emitThrew = false;
    try {
      await emitAndDrain(MATTER_EVENT_CREATED, {
        lawFirmId: firm.id,
        matterId,
        eventId,
        eventData: { ...await matterEventPayload(firm.id, matterId, eventId), assignedTo: [revoked.uid, healthy.uid] },
        userId: revoked.uid,
      });
    } catch {
      emitThrew = true;
    }
    // The emitting request is never failed by a listener: `emit` does not await
    // them, and each handler carries its own try/catch.
    expect(emitThrew).toBe(false);

    expect(callsMatching(TOKEN_URL)).toHaveLength(1);
    expect(await storedAccessToken(revoked.uid)).toBe('tok-revoked');

    // The healthy member's event still landed, and only theirs.
    const mappings = await mappingRows();
    expect(mappings).toHaveLength(1);
    expect(mappings[0].user_id).toBe(healthy.uid);
  });
});

// ── tenancy ─────────────────────────────────────────────────────────────────

describe('tenant scope', () => {
  /**
   * A matter's calendar fan-out is derived from `matter_members` inside the
   * matter's OWN firm, not from the payload. Here the acting user on the payload
   * belongs to a different firm entirely.
   *
   * Goes red if the member lookup loses its `law_firm_id` scope, or if the
   * fallback-to-payload-user branch starts running even when the matter has
   * members: firm B's lawyer would receive firm A's hearing, which is a
   * cross-tenant disclosure of a matter title and its date.
   */
  test('a matter event never reaches a user connected under another firm', async () => {
    const firmB = await createFirm();
    const insider = await connectGoogle(firm.id, { accessToken: 'tok-insider' });
    const outsider = await connectGoogle(firmB.id, { accessToken: 'tok-outsider' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, insider.uid);
    const eventId = await seedMatterEvent(firm.id, matterId, { title: 'Confidential hearing' });

    routeCreates();

    await emitAndDrain(MATTER_EVENT_CREATED, {
      lawFirmId: firm.id,
      matterId,
      eventId,
      eventData: { ...await matterEventPayload(firm.id, matterId, eventId), assignedTo: [insider.uid] },
      // The other firm's user, as an emitter with a wrong actor would supply.
      userId: outsider.uid,
    });

    const created = posts();
    expect(created).toHaveLength(1);
    expect(created[0].bearer).toBe('tok-insider');
    expect(created.map((c) => c.bearer)).not.toContain('tok-outsider');
    expect((await mappingRows()).map((m) => m.user_id)).toEqual([insider.uid]);
  });

  /**
   * Goes red if the billing-recipient query loses its `law_firm_id` predicate:
   * the other firm's owner is a connected billing recipient in THEIR firm, so an
   * unscoped `members` read would hand them this firm's invoice due date.
   */
  test('an invoice never reaches a billing recipient of another firm', async () => {
    const firmB = await createFirm();
    const insider = await connectGoogle(firm.id, { accessToken: 'tok-insider' });
    await connectGoogle(firmB.id, { accessToken: 'tok-outsider' });
    const client = await createPersonClient(firm.id);
    const invoice = await seedInvoice(firm.id, { contextType: 'client', clientId: client.id });

    routeCreates('g-inv');

    await emitAndDrain(INVOICE_CREATED, {
      lawFirmId: firm.id, invoiceId: invoice.id, userId: insider.uid, invoiceData: invoice,
    });

    expect(posts().map((c) => c.bearer)).toEqual(['tok-insider']);
  });

  /** A forged recipient from another firm must fail closed even with a usable token. */
  test('a client event refuses a recipient from another firm', async () => {
    const firmB = await createFirm();
    const outsider = await connectGoogle(firmB.id, { accessToken: 'tok-outsider' });
    const client = await createPersonClient(firm.id);
    const eventId = await seedClientEvent(firm.id, client.id);

    routeCreates('g-client');

    await emitAndDrain(CLIENT_EVENT_CREATED, {
      lawFirmId: firm.id,
      clientId: client.id,
      eventId,
      eventData: await clientEventPayload(firm.id, client.id, eventId),
      userId: outsider.uid,
    });

    expect(posts()).toHaveLength(0);
  });
});

// ── containment ─────────────────────────────────────────────────────────────

describe('listener containment', () => {
  /**
   * `eventBus.emit` is a synchronous EventEmitter emit over async listeners, so a
   * listener that rejects must not stop its siblings or reach the emitting
   * request. This registers a hostile listener FIRST (prependListener) so it runs
   * before the calendar one.
   *
   * Goes red if the calendar listener stops running after a sibling throws, or if
   * a rejected sibling starts propagating out of `emit` into the caller.
   */
  test('a sibling listener that throws does not stop the calendar sync or the emit', async () => {
    const user = await connectGoogle(firm.id, { accessToken: 'tok-user' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, user.uid);
    const eventId = await seedMatterEvent(firm.id, matterId);

    routeCreates();

    let hostileRan = false;
    const hostile = async () => {
      hostileRan = true;
      throw new Error('sibling listener exploded');
    };
    eventBus.prependListener(MATTER_EVENT_CREATED, hostile);

    try {
      const payload = {
        lawFirmId: firm.id,
        matterId,
        eventId,
        eventData: await matterEventPayload(firm.id, matterId, eventId),
        userId: user.uid,
      };
      expect(() => eventBus.emit(MATTER_EVENT_CREATED, payload)).not.toThrow();
      await drainEvents();
    } finally {
      eventBus.removeListener(MATTER_EVENT_CREATED, hostile);
    }

    expect(hostileRan).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].bearer).toBe('tok-user');
    expect(await mappingRows()).toHaveLength(1);
  });
});

// ── idempotency under an outbox retry ───────────────────────────────────────

describe('re-dispatch of the same event (the outbox retry path)', () => {
  /**
   * THE NON-IDEMPOTENCY THIS FILE EXISTS FOR, now closed.
   *
   * `eventOutbox.dispatchRow` re-invokes every listener for a row with the SAME
   * persisted payload. It does so for EVERY enqueued event, not only ones whose
   * live listeners failed (see the outbox section of `backend/AGENTS.md`), so with
   * the worker on this second pass is the normal case rather than a rare retry.
   * Re-emitting the identical payload here is exactly that.
   *
   * This case used to pin the damage. The create path never consulted
   * `calendar_mappings` before POSTing (only the UPDATE path did), and the
   * replayed payload still carries the pre-sync `calendarSync` snapshot, so the
   * second pass created a SECOND Google event on the lawyer's real calendar. What
   * it left behind was worse than a duplicate: the bookkeeping ran writeback
   * first, mapping second, so the writeback repointed the entity at the NEW event
   * id and the mapping insert then violated `calendar_mappings_entity_item_uidx`
   * (unique on provider, user, entity_type, entity_id, item_key) because its
   * `on conflict` clause only covers the primary key (provider, external_event_id)
   * and the replay carried a different external id. `google.service` swallowed
   * that per-item error, and the run ended with two events on the calendar,
   * `calendar_sync` naming the second and `calendar_mappings` naming the first,
   * so a later delete removed the second copy and orphaned the first, which
   * nothing in Paralegix could address again.
   *
   * The create path now resolves the same durable mapping the update path does
   * before POSTing, so a replay is a no-op and the two records cannot disagree.
   *
   * Goes red if that lookup is dropped (a second POST appears), or if the
   * writeback and the mapping stop naming the same event.
   */
  test('re-dispatching MATTER_EVENT_CREATED creates nothing the second time', async () => {
    const user = await connectGoogle(firm.id, { accessToken: 'tok-user' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, user.uid);
    const eventId = await seedMatterEvent(firm.id, matterId, { title: 'Preliminary hearing' });

    routeCreates('g-dup');

    // One payload object, dispatched twice, exactly as the worker replays a row.
    const payload = {
      lawFirmId: firm.id,
      matterId,
      eventId,
      eventData: await matterEventPayload(firm.id, matterId, eventId),
      userId: user.uid,
    };

    await emitAndDrain(MATTER_EVENT_CREATED, payload);
    expect(posts()).toHaveLength(1);

    await emitAndDrain(MATTER_EVENT_CREATED, payload);

    // Still exactly one Google event for one Paralegix event.
    const created = posts();
    expect(created).toHaveLength(1);
    expect(created[0].bearer).toBe('tok-user');
    expect(created[0].body.summary).toBe('Preliminary hearing');

    // And the two records that used to diverge name the same event.
    const mappings = await mappingRows();
    expect(mappings.map((m) => m.external_event_id)).toEqual(['g-dup-0']);
    expect(mappings[0].entity_id).toBe(eventId);
    const sync = await matterEventSync(eventId);
    expect(sync.google[user.uid].event.eventId).toBe('g-dup-0');
  });

  /**
   * The reconciliation half. A mapping row exists but the entity's own writeback
   * does not name it: the state left by a crash between the two writes, or by a
   * replay of a payload whose snapshot predates the sync.
   *
   * The create must not POST (the event is already on the calendar), and it must
   * repair the writeback so the next update PATCHes rather than duplicating.
   *
   * Goes red if the create path stops consulting the mapping (a POST appears), or
   * if it consults it and then leaves the entity still pointing at nothing.
   */
  test('a create whose mapping exists repairs the writeback instead of posting', async () => {
    const user = await connectGoogle(firm.id, { accessToken: 'tok-user' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, user.uid);
    // No `calendarSync` on the row: only the mapping knows about g-orphan.
    const eventId = await seedMatterEvent(firm.id, matterId);
    await seedMapping({
      externalEventId: 'g-orphan', lawFirmId: firm.id, userId: user.uid,
      entityType: 'matterEvent', entityId: eventId, scopeId: matterId,
    });

    routeCreates('g-should-not-happen');

    await emitAndDrain(MATTER_EVENT_CREATED, {
      lawFirmId: firm.id,
      matterId,
      eventId,
      eventData: await matterEventPayload(firm.id, matterId, eventId),
      userId: user.uid,
    });

    expect(posts()).toHaveLength(0);
    expect((await mappingRows()).map((m) => m.external_event_id)).toEqual(['g-orphan']);
    const sync = await matterEventSync(eventId);
    expect(sync.google[user.uid].event.eventId).toBe('g-orphan');
  });

  /**
   * CHARACTERIZATION, the delete half of the same replay.
   *
   * The replayed payload still names the external event id that the first pass
   * already deleted, so the second pass issues a DELETE for an event Google no
   * longer has. Harmless at Google (it answers 404 and the listener absorbs it)
   * but it is a wasted provider round trip per retry, and it is the same stale
   * snapshot that makes the create case above duplicate.
   *
   * Goes red if the delete path starts checking the mapping table (or the live
   * entity) before calling out, which would make it a no-op the second time.
   */
  test('re-dispatching MATTER_EVENT_DELETED deletes an event that is already gone', async () => {
    const user = await connectGoogle(firm.id, { accessToken: 'tok-user' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, user.uid);
    const eventId = await seedMatterEvent(firm.id, matterId, {
      calendarSync: googleSyncMap([{ userId: user.uid, key: 'event', eventId: 'g-gone' }]),
    });
    await seedMapping({
      externalEventId: 'g-gone', lawFirmId: firm.id, userId: user.uid,
      entityType: 'matterEvent', entityId: eventId, scopeId: matterId,
    });

    // First delete succeeds; Google reports the event as missing from then on.
    route(`${EVENTS_URL}/g-gone`, [{ status: 204 }, { status: 404, json: { error: { code: 404 } } }],
      { method: 'DELETE' });

    const payload = {
      lawFirmId: firm.id,
      matterId,
      eventId,
      eventData: await matterEventPayload(firm.id, matterId, eventId),
      userId: user.uid,
    };

    await emitAndDrain(MATTER_EVENT_DELETED, payload);
    expect(deletes()).toHaveLength(1);
    expect(await mappingRows()).toHaveLength(0);

    await emitAndDrain(MATTER_EVENT_DELETED, payload);
    expect(deletes()).toHaveLength(2);
    expect(deletes()[1].url).toContain('/events/g-gone');
  });

  /**
   * The contrast that makes the two cases above readable: the UPDATE path DOES
   * consult `calendar_mappings` when the payload carries no per-user id, so a
   * replay patches the event it already created instead of making another.
   *
   * Goes red if `findMappingForEntityItem` is dropped from the update path, which
   * would turn every replayed update into a duplicate create as well.
   */
  test('re-dispatching MATTER_EVENT_UPDATED patches through the mapping instead of duplicating', async () => {
    const user = await connectGoogle(firm.id, { accessToken: 'tok-user' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, user.uid);
    const eventId = await seedMatterEvent(firm.id, matterId);
    await seedMapping({
      externalEventId: 'g-mapped', lawFirmId: firm.id, userId: user.uid,
      entityType: 'matterEvent', entityId: eventId, scopeId: matterId,
    });

    route(`${EVENTS_URL}/g-mapped`, { status: 200, json: { id: 'g-mapped' } }, { method: 'PATCH' });
    routeCreates('g-should-not-happen');

    // No `calendarSync` on the payload: the mapping row is the only thing that
    // can prevent a duplicate create.
    const payload = {
      lawFirmId: firm.id,
      matterId,
      eventId,
      eventData: await matterEventPayload(firm.id, matterId, eventId),
      userId: user.uid,
    };

    await emitAndDrain(MATTER_EVENT_UPDATED, payload);
    await emitAndDrain(MATTER_EVENT_UPDATED, payload);

    expect(posts()).toHaveLength(0);
    expect(patches()).toHaveLength(2);
    expect((await mappingRows()).map((m) => m.external_event_id)).toEqual(['g-mapped']);
  });
});

// ── two workers creating the same entity concurrently (C02) ────────────────
//
// These specs bypass `syncToCalendars`'s in-process debounce (`pendingSyncs`)
// on purpose: that Map only coalesces calls made to the SAME Node process, so
// exercising it here would prove nothing about two real workers (two Cloud Run
// instances, or a live emit racing an outbox redispatch on another instance)
// that never share that Map. The mechanism that actually has to hold across
// processes is `withLock('CALENDAR_SYNC', ...)` in calendar.events.ts, which is
// a lease row in Postgres `lock_leases`, real cross-connection, cross-process
// mutual exclusion (see `shared/database/advisoryLock.ts`). Both specs below
// call `googleService.createEventsFromEntity` directly with the exact lock
// domain/key format calendar.events.ts uses, which is the smallest slice that
// still exercises the real production mechanism rather than a stand-in for it.
describe('two workers creating the same entity concurrently (C02)', () => {
  /**
   * THE CONTROL. `createEventsFromEntity`'s own comment says its mapping
   * check-then-act is "correct against concurrency only under the calendar
   * sync lock ... on its own it is a narrower check-then-act". This proves
   * that claim: two callers, gated so both confirm "no mapping yet" before
   * either writes one, and NOTHING serializing them. Without the lock this is
   * exactly what two app instances handling the same entity/user at once
   * would do.
   *
   * Goes red (i.e. stops proving the danger this describe block exists to
   * close) if `createEventsFromEntity` stops calling
   * `findMappingForEntityItem` before creating, in which case the gate below
   * would never be reached and `gate.arrived` would time out.
   */
  test('CHARACTERIZATION: without the lock, two racing creates duplicate the Google event', async () => {
    const user = await connectGoogle(firm.id, { accessToken: 'tok-race' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, user.uid);
    const eventId = await seedMatterEvent(firm.id, matterId, { title: 'Race hearing' });
    const entityData = await matterEventPayload(firm.id, matterId, eventId);
    const adapter = getAdapter('matterEvent');

    routeCreates('g-race');

    const gate = gateMethod(calendarSyncRepo, 'findMappingForEntityItem');
    try {
      const workerA = googleService.createEventsFromEntity(adapter, entityData, user.uid, 'America/New_York');
      const workerB = googleService.createEventsFromEntity(adapter, entityData, user.uid, 'America/New_York');
      // PROOF, not hope: both workers are confirmed inside the "does a mapping
      // already exist" check, neither having written one yet.
      await gate.arrived(2);
      gate.open();
      await Promise.all([workerA, workerB]);
    } finally {
      gate.restore();
    }

    // The real defect this closes: a second, unrecoverable event on the user's
    // real calendar. Only one of the two mapping inserts can win the
    // (provider, user, entity_type, entity_id, item_key) unique index; the
    // loser's POST already landed at Google and is now orphaned.
    expect(posts()).toHaveLength(2);
    expect(await mappingRows()).toHaveLength(1);
  });

  /**
   * THE FIX. Same two workers, same gate, but each now runs inside the real
   * `withLock('CALENDAR_SYNC', ...)` wrapper calendar.events.ts uses, with the
   * exact key format (`${entityType}:${entityId}:${userId}`) it uses. The lock
   * is a lease row in Postgres `lock_leases`, taken by an upsert that only one
   * caller can win, so this proves cross-CONNECTION serialization, not an
   * in-process one: the second call keeps polling until the first call deletes
   * its lease.
   *
   * Goes red if `withLock` stops actually locking (see
   * the mutation note below), or if `createEventsFromEntity` stops
   * reconciling against `calendar_mappings` before posting.
   */
  test('the CALENDAR_SYNC advisory lock serializes two workers into exactly one event', async () => {
    const user = await connectGoogle(firm.id, { accessToken: 'tok-locked' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, user.uid);
    const eventId = await seedMatterEvent(firm.id, matterId, { title: 'Locked hearing' });
    const entityData = await matterEventPayload(firm.id, matterId, eventId);
    const adapter = getAdapter('matterEvent');
    const key = `${adapter.entityType}:${entityData.id}:${user.uid}`;

    routeCreates('g-locked');

    const worker = () => withLock('CALENDAR_SYNC', key, () =>
      googleService.createEventsFromEntity(adapter, entityData, user.uid, 'America/New_York'));

    await Promise.all([worker(), worker()]);

    const created = posts();
    expect(created).toHaveLength(1);
    expect(created[0].bearer).toBe('tok-locked');
    const mappings = await mappingRows();
    expect(mappings).toHaveLength(1);
    expect(mappings[0].entity_id).toBe(eventId);
    const sync = await matterEventSync(eventId);
    expect(sync.google[user.uid].event.eventId).toBe(mappings[0].external_event_id);
  });
});

// ── outbox retry across a mixed-outcome sibling (C07) ───────────────────────

describe('outbox retry with a live listener that succeeds and a sibling that fails (C07)', () => {
  /**
   * `eventOutbox.dispatchRow` marks the WHOLE row failed if ANY listener
   * rejects, and a retry re-runs EVERY listener for that row, including the
   * ones that already succeeded (see the "re-runs EVERY listener on retry"
   * spec in `tests/events/eventOutbox.test.ts`, which pins that contract with
   * synthetic listeners). What that spec cannot show is the thing this batch
   * cares about: a REAL side-effecting listener - one that posts to an
   * external calendar and writes a durable mapping - surviving being re-run
   * for a reason that had nothing to do with it.
   *
   * A sibling listener is registered on the SAME event that fails once and
   * succeeds on retry (standing in for, say, a flaky notification listener).
   * The row is seeded directly into `event_outbox` and dispatched through the
   * real exported `_dispatchRow`, exactly as the worker would, without
   * enabling `EVENT_OUTBOX_WORKER` anywhere.
   *
   * Goes red if the calendar create path stops consulting `calendar_mappings`
   * before posting (a second POST would appear on the retry - the successful
   * action WOULD be repeated destructively), or if `dispatchRow` stops
   * re-running a listener that already succeeded (the sibling's second call
   * would never happen and the row would stay 'failed' forever).
   */
  test('a failed sibling does not duplicate the calendar side effect, and is itself retried to success', async () => {
    const user = await connectGoogle(firm.id, { accessToken: 'tok-c07' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, user.uid);
    const eventId = await seedMatterEvent(firm.id, matterId, { title: 'Mixed outcome hearing' });
    const payload = {
      lawFirmId: firm.id,
      matterId,
      eventId,
      eventData: await matterEventPayload(firm.id, matterId, eventId),
      userId: user.uid,
    };

    routeCreates('g-c07');

    let siblingCalls = 0;
    const sibling = async () => {
      siblingCalls += 1;
      if (siblingCalls === 1) throw new Error('sibling transient failure');
    };
    eventBus.on(MATTER_EVENT_CREATED, sibling);

    const rowId = await seedOutboxRow(MATTER_EVENT_CREATED, payload);

    try {
      // First dispatch: the calendar listener succeeds for real (a POST and a
      // mapping row), the sibling throws, so `dispatchRow` marks the WHOLE row
      // failed regardless of the calendar listener's own success.
      await _dispatchRow(eventBus, await claimSnapshot(rowId));

      expect(siblingCalls).toBe(1);
      expect(posts()).toHaveLength(1);
      expect(await mappingRows()).toHaveLength(1);
      let row = await outboxRowStatus(rowId);
      expect(row.status).toBe('failed');
      expect(row.attempts).toBe(1);

      // Retry: dispatchRow re-runs EVERY listener, including the calendar one
      // that already succeeded, with the SAME persisted payload. The mapping
      // check makes that a no-op instead of a second Google event.
      await _dispatchRow(eventBus, await claimSnapshot(rowId));

      expect(siblingCalls).toBe(2);
      expect(posts()).toHaveLength(1);
      expect(await mappingRows()).toHaveLength(1);
      row = await outboxRowStatus(rowId);
      expect(row.status).toBe('done');
      expect(row.attempts).toBe(2);
    } finally {
      eventBus.removeListener(MATTER_EVENT_CREATED, sibling);
    }
  });
});

// ── one provider fails while the other succeeds, same user (C08) ───────────

describe('one provider fails while the other succeeds for the same user (C08)', () => {
  /**
   * `performSyncToCalendars.runBothProviders` wraps Google and Outlook each in
   * their own try/catch, sequentially. This proves the isolation: a user
   * connected to BOTH providers, Google routed to succeed and Outlook left
   * entirely unrouted (so its first network attempt is BLOCKED by the shared
   * wall). Outlook's own outer try/catch in `createEventsFromEntity` absorbs
   * that and returns null; the failure must not touch Google's own mapping or
   * the emitting request.
   *
   * Goes red if a provider failure starts propagating out of
   * `performSyncToCalendars` (the emit would throw), or if Google's mapping
   * write is affected by Outlook's failure in any way.
   */
  test('an Outlook failure does not stop the Google create, and only Google gets a mapping', async () => {
    const user = await connectGoogle(firm.id, { accessToken: 'tok-both-a' });
    await connectOutlookAlso(user.uid);
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, user.uid);
    const eventId = await seedMatterEvent(firm.id, matterId, { title: 'Dual provider hearing (outlook fails)' });

    routeCreates('g-dual-a'); // Google succeeds; no Outlook route is registered.

    let emitThrew = false;
    try {
      await emitAndDrain(MATTER_EVENT_CREATED, {
        lawFirmId: firm.id,
        matterId,
        eventId,
        eventData: await matterEventPayload(firm.id, matterId, eventId),
        userId: user.uid,
      });
    } catch {
      emitThrew = true;
    }
    expect(emitThrew).toBe(false);

    const created = posts();
    expect(created).toHaveLength(1);
    expect(created[0].bearer).toBe('tok-both-a');
    // Outlook's create WAS attempted (the call is recorded, same as the wall's
    // own "blocked, recorded, contained" contract) - the point is that the
    // attempt failing left nothing behind, not that it never happened.
    expect(outlookPosts()).toHaveLength(1);

    const mappings = await mappingRowsByProvider();
    expect(mappings).toHaveLength(1);
    expect(mappings[0].provider).toBe('google');
  });

  /**
   * The reverse boundary. Outlook is routed to succeed; Google is left
   * entirely unrouted, so its create is BLOCKED and swallowed by its own
   * outer try/catch, exactly symmetric to the case above.
   *
   * Goes red if the isolation is one-directional (e.g. Outlook's failure is
   * caught but a Google failure is not), or if Outlook's create path stops
   * writing its mapping under `provider = 'outlook'`.
   */
  test('a Google failure does not stop the Outlook create, and only Outlook gets a mapping', async () => {
    const user = await connectGoogle(firm.id, { accessToken: 'tok-both-b' });
    await connectOutlookAlso(user.uid, { accessToken: 'tok-both-b-outlook' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, user.uid);
    const eventId = await seedMatterEvent(firm.id, matterId, { title: 'Dual provider hearing (google fails)' });

    // No Google route is registered, so its create is BLOCKED.
    route(OUTLOOK_EVENTS_URL, { status: 200, json: { id: 'o-dual-1', changeKey: 'ck-dual-1' } }, { method: 'POST' });

    let emitThrew = false;
    try {
      await emitAndDrain(MATTER_EVENT_CREATED, {
        lawFirmId: firm.id,
        matterId,
        eventId,
        eventData: await matterEventPayload(firm.id, matterId, eventId),
        userId: user.uid,
      });
    } catch {
      emitThrew = true;
    }
    expect(emitThrew).toBe(false);

    // Google's create WAS attempted and recorded; the point is that its
    // failure left nothing behind, not that it never tried.
    expect(posts()).toHaveLength(1);
    const created = outlookPosts();
    expect(created).toHaveLength(1);
    expect(created[0].bearer).toBe('tok-both-b-outlook');

    const mappings = await mappingRowsByProvider();
    expect(mappings).toHaveLength(1);
    expect(mappings[0].provider).toBe('outlook');
  });
});

// ── work still queued when a member is removed or a provider disconnects (C09) ─

describe('a member removed or a provider disconnected while a sync is queued (C09)', () => {
  /**
   * THE RACE THE COALESCE KEY IS DESIGNED FOR. `syncToCalendars` debounces
   * calls for 1.5s keyed WITHOUT the action
   * (`${entityType}:${entityId}:${userId}`), and "the LATEST call wins
   * (including its action)" per its own comment - specifically so a stale
   * create cannot outrun a newer delete. `matterMembers.service.removeMembers`
   * re-syncs every one of the removed user's matter events as a delete,
   * unfiltered, for exactly this reason.
   *
   * Here a CREATE for a matter event is queued (still inside its 1.5s
   * debounce window) when that same user is removed from the matter. The
   * removal's delete for the SAME (entityType, entityId, userId) key must
   * overwrite the pending create rather than race it, so the removed member
   * never receives the hearing they are no longer authorized to see.
   *
   * A gate on the shared capability pre-check proves the create really is
   * queued (past its own capability check, mid-flight toward the debounce
   * timer) before the removal is emitted - without it, emitting both back to
   * back would leave the ordering to chance, which could pass by luck against
   * broken code.
   *
   * Goes red if the coalesce key starts including the action (a create and a
   * delete for the same entity/user would then queue independently, and the
   * create could fire after the delete), or if `syncToCalendars` stops
   * accepting a later call's action as authoritative.
   */
  test('removing the member while their create is queued leaves no event on their calendar', async () => {
    const user = await connectGoogle(firm.id, { accessToken: 'tok-c09-removed' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, user.uid);
    const eventId = await seedMatterEvent(firm.id, matterId, { title: 'Queued-then-removed hearing' });

    routeCreates('g-c09-removed');

    const capabilityGate = gateMethod(calendarTokens, 'getOutboundSyncCapabilities');
    try {
      eventBus.emit(MATTER_EVENT_CREATED, {
        lawFirmId: firm.id,
        matterId,
        eventId,
        eventData: await matterEventPayload(firm.id, matterId, eventId),
        userId: user.uid,
      });
      // PROOF the create is mid-flight (past nothing yet, but genuinely
      // in-progress) rather than assumed from timing.
      await capabilityGate.arrived(1);
      capabilityGate.open();
    } finally {
      capabilityGate.restore();
    }
    // The capability check plus the token/settings load it gates are two more
    // DB round trips before the debounce entry is created; 100ms is generous
    // for local Postgres and a small fraction of the 1.5s debounce window.
    await new Promise((resolve) => { setTimeout(resolve, 100); });

    eventBus.emit(MATTER_MEMBERS_UPDATED, {
      lawFirmId: firm.id,
      matterId,
      memberUserIds: [],
      removedUserIds: [user.uid],
    });

    await drainEvents();

    expect(posts()).toHaveLength(0);
    expect(deletes()).toHaveLength(0); // nothing existed yet to delete either
    expect(await mappingRows()).toHaveLength(0);
  });

  /** A disconnected connection must be rechecked when queued work reaches the provider. */
  test('a queued create skips the provider after the user disconnects mid-flight', async () => {
    const user = await connectGoogle(firm.id, { accessToken: 'tok-c09-stale' });
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, user.uid);
    const eventId = await seedMatterEvent(firm.id, matterId, { title: 'Disconnected-mid-flight hearing' });

    routeCreates('g-c09-stale');

    const createGate = gateMethod(googleService, 'createEventsFromEntity');
    try {
      eventBus.emit(MATTER_EVENT_CREATED, {
        lawFirmId: firm.id,
        matterId,
        eventId,
        eventData: await matterEventPayload(firm.id, matterId, eventId),
        userId: user.uid,
      });
      // Resolves only once the 1.5s debounce has fired and the queued sync is
      // about to call Google with its token snapshot from queue time.
      await createGate.arrived(1);

      const removed = await testPool.query(
        `delete from user_oauth_tokens where user_id = $1 and provider = 'google'`, [user.uid],
      );
      expect(removed.rowCount).toBe(1);

      createGate.open();
    } finally {
      createGate.restore();
    }

    await drainEvents();

    const created = posts();
    expect(created).toHaveLength(0);
    expect(await mappingRows()).toHaveLength(0);
  });
});

// ── the calendar-watch cron ─────────────────────────────────────────────────

describe('queued Outlook connection validation', () => {
  test('a queued Outlook create skips a disconnected connection while Google still syncs', async () => {
    const user = await connectGoogle(firm.id);
    await connectOutlookAlso(user.uid);
    const matterId = await seedMatter(firm.id);
    await addMatterMember(firm.id, matterId, user.uid);
    const eventId = await seedMatterEvent(firm.id, matterId);
    routeCreates('google-remains-connected');
    route(OUTLOOK_EVENTS_URL, { status: 200, json: { id: 'outlook-disconnected', changeKey: 'ck' } }, { method: 'POST' });
    const outlookService = require('../../src/modules/calendar/outlook/outlook.service');
    const gate = gateMethod(outlookService, 'createEventsFromEntity');
    try {
      eventBus.emit(MATTER_EVENT_CREATED, {
        lawFirmId: firm.id, matterId, eventId,
        eventData: await matterEventPayload(firm.id, matterId, eventId), userId: user.uid,
      });
      await gate.arrived(1);
      const removed = await testPool.query("delete from user_oauth_tokens where user_id = $1 and provider = 'microsoft'", [user.uid]);
      expect(removed.rowCount).toBe(1);
      gate.open();
    } finally { gate.restore(); }
    await drainEvents();
    expect(posts()).toHaveLength(1);
    expect(outlookPosts()).toHaveLength(0);
    expect((await mappingRowsByProvider()).map((row) => row.provider)).toEqual(['google']);
  });
});

describe('POST /api/cron/calendar-watch', () => {
  let originalWebhookBase: string | undefined;

  /** `createWatchChannel` refuses to run without an https webhook base. */
  beforeAll(() => {
    originalWebhookBase = process.env.WEBHOOK_BASE_URL;
    process.env.WEBHOOK_BASE_URL = 'https://api-test.paralegix.test';
  });

  afterAll(() => {
    if (originalWebhookBase === undefined) delete process.env.WEBHOOK_BASE_URL;
    else process.env.WEBHOOK_BASE_URL = originalWebhookBase;
  });

  function callCron() {
    const req = request().post('/api/cron/calendar-watch');
    return process.env.CRON_SECRET
      ? req.set('x-cron-secret', process.env.CRON_SECRET)
      : req.set('x-cloudscheduler', 'true');
  }

  const channelRows = async () => (await testPool.query(
    `select id, user_id, resource from calendar_subscriptions where provider = 'google' order by id`,
  )).rows;

  /**
   * The cron is the only thing that keeps a firm's inbound calendar sync alive:
   * a watch channel carries a seven-day ttl, so a pass that stops renewing means
   * changes made in Google stop arriving, silently.
   *
   * Goes red if the route stops calling `renewExpiringChannels`, if the renewal
   * stops replacing the due channel, or if the second pass starts churning a
   * channel that is not due (the id equality and the call counts both break).
   */
  test('renews a channel that is about to lapse, and a second pass renews nothing', async () => {
    const user = await connectGoogle(firm.id, { accessToken: 'tok-watch' });
    const oldChannelId = `chan-${randomUUID().slice(0, 8)}`;
    const seeded = await testPool.query(
      `insert into calendar_subscriptions (provider, id, user_id, law_firm_id, calendar_id, resource, secret, expiration)
       values ('google', $1, $2, $3, 'primary', 'res-old', 'channel-token', now() + interval '1 hour')`,
      [oldChannelId, user.uid, firm.id],
    );
    expect(seeded.rowCount).toBe(1);

    route('channels/stop', { status: 204 }, { method: 'POST' });
    route('/events/watch', {
      status: 200,
      json: { resourceId: 'res-new', expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000) },
    }, { method: 'POST' });
    route(/\/events\?maxResults=2500&showDeleted=true/, { status: 200, json: { nextSyncToken: 'sync-1', items: [] } });

    const first = await callCron();
    expect(first.status).toBe(200);
    expect(first.body.googleRenewal).toEqual({ renewed: 1, failed: 0, truncated: false });

    const afterFirst = await channelRows();
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].id).not.toBe(oldChannelId);
    expect(afterFirst[0].resource).toBe('res-new');
    expect(callsMatching('channels/stop')).toHaveLength(1);
    expect(callsMatching('/events/watch')).toHaveLength(1);

    // Idempotent across passes: the replacement is not due for seven days, so a
    // second run must leave it exactly where it is and talk to nobody.
    const second = await callCron();
    expect(second.status).toBe(200);
    expect(second.body.googleRenewal).toEqual({ renewed: 0, failed: 0, truncated: false });

    expect(await channelRows()).toEqual(afterFirst);
    expect(callsMatching('channels/stop')).toHaveLength(1);
    expect(callsMatching('/events/watch')).toHaveLength(1);
  });


});

test('moving a task off a matter removes its old unassigned copies', async () => {
  const creator = await connectGoogle(firm.id, { accessToken: 'tok-moving-creator' });
  const former = await connectGoogle(firm.id, { accessToken: 'tok-former-assignee' });
  const matterId = await seedMatter(firm.id);
  const calendarSync = googleSyncMap([{ userId: creator.uid, key: 'dueDate', eventId: 'g-moving' }, { userId: former.uid, key: 'dueDate', eventId: 'g-former-copy' }]);
  const taskId = await seedTask(firm.id, { createdBy: creator.uid, calendarSync });
  route(`${EVENTS_URL}/g-moving`, { status: 200, json: { id: 'g-moving' } }, { method: 'PATCH' });
  route(`${EVENTS_URL}/g-former-copy`, { status: 204 }, { method: 'DELETE' });
  await emitAndDrain(TASK_UPDATED, { lawFirmId: firm.id, taskId, userId: creator.uid,
    entityData: { id: taskId, lawFirmId: firm.id, matterId: null, title: 'Moved task', dueDate: '2026-11-10', createdBy: creator.uid, assignedTo: [], calendarSync },
    previousData: { matterId, assignedTo: [] },
  });
  expect(patches()).toHaveLength(1);
  expect(deletes().map((call) => call.bearer)).toEqual(['tok-former-assignee']);
});

test('revoking calendar access removes the member copy without waiting for another edit', async () => {
  const owner = await connectGoogle(firm.id, { accessToken: 'tok-owner' });
  const former = await connectGoogle(firm.id, { accessToken: 'tok-revoked', outbound: false });
  const matterId = await seedMatter(firm.id);
  const eventId = await seedMatterEvent(firm.id, matterId, { calendarSync: googleSyncMap([{ userId: former.uid, key: 'event', eventId: 'g-revoked' }]) });
  await calendarSyncRepo.saveMapping({ provider: 'google', externalEventId: 'g-revoked', userId: former.uid, lawFirmId: firm.id, entityType: 'matterEvent', entityId: eventId, scopeId: matterId, itemKey: 'event', calendarId: 'primary' });
  route(`${EVENTS_URL}/g-revoked`, { status: 204 }, { method: 'DELETE' });
  const removed = await testPool.query('delete from members where law_firm_id = $1 and user_id = $2', [firm.id, former.uid]);
  expect(removed.rowCount).toBe(1);
  await emitAndDrain(require('../../src/shared/events/eventTypes').MEMBER_REMOVED, { lawFirmId: firm.id, userId: former.uid });
  expect(deletes().map((call) => call.bearer)).toEqual(['tok-revoked']);
  expect(await mappingRows()).toHaveLength(0);
  void owner;
});
