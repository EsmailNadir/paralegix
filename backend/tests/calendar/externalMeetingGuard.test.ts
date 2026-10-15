/**
 * The meeting guard on an imported event whose meeting details were never
 * recorded.
 *
 * The update and delete routes refuse to change a meeting the member is only
 * invited to, reading who organizes it from `provider_details`. Events
 * imported before that column was filled carry `{}`, so the guard saw no
 * attendees and let a guest rewrite or delete the organizer's meeting. The
 * service now reads the event from the provider, with the importing member's
 * own connection, before deciding.
 *
 * `support/googleFetch` replaces `globalThis.fetch` for Google and Graph; any
 * request no case registered is recorded and rejected.
 */
import {
  installGoogleFetchWall,
  uninstallGoogleFetchWall,
  resetGoogleFetch,
  route,
  callsMatching,
} from './support/googleFetch';

installGoogleFetchWall();

import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ownerOf,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { describeNetworkWall } from './support/calendarWorld';

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  resetGoogleFetch();
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

afterEach(async () => {
  await drainEvents();
});

afterAll(() => {
  uninstallGoogleFetchWall();
});

describeNetworkWall('https://graph.microsoft.com/v1.0/me/events');

const path = (suffix = '') => `/api/lawfirms/${firm.id}/calendar-events${suffix}`;

async function connectMicrosoft(uid: string) {
  const tokens = await testPool.query(
    `insert into user_oauth_tokens
       (user_id, provider, access_token, refresh_token, meta, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'microsoft', 'ms-access', 'ms-refresh-seed', $2::jsonb, true, true)`,
    [uid, JSON.stringify({ outlookTimezone: 'UTC', outlookMailboxTimezoneWritable: true })],
  );
  expect(tokens.rowCount).toBe(1);
}

async function connectGoogle(uid: string) {
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'google', 'g-access', 'refresh-seed', true, true)`,
    [uid],
  );
  expect(tokens.rowCount).toBe(1);
}

/** An import from before meeting details were recorded: `provider_details` is `{}`. */
async function seedLegacyImport(provider: 'google' | 'outlook', providerId: string) {
  const id = randomUUID();
  const column = provider === 'google' ? 'google_event_id' : 'outlook_id';
  const res = await testPool.query(
    `insert into calendar_events (id, law_firm_id, title, starts_at, ends_at, provider, source,
       external_event_id, ${column}, created_by)
     values ($1, $2, 'Opposing counsel sync', '2026-10-07T15:00:00Z', '2026-10-07T16:00:00Z',
       $3, 'external', $4, $4, $5)`,
    [id, firm.id, provider, providerId, owner.uid],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function row(id: string) {
  const { rows } = await testPool.query(`select title, provider_details from calendar_events where id = $1`, [id]);
  return rows[0] || null;
}

const INVITED = {
  id: 'AAMk-invite', subject: 'Opposing counsel sync', isOrganizer: false, isAllDay: false, isCancelled: false,
  organizer: { emailAddress: { address: 'counsel@opposing.test', name: 'Counsel' } },
  attendees: [{ emailAddress: { address: 'owner@firm.test' }, status: { response: 'accepted' } }],
  responseStatus: { response: 'accepted' }, changeKey: 'CK-1',
  start: { dateTime: '2026-10-07T15:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-10-07T16:00:00.0000000', timeZone: 'UTC' },
};

describe('an imported meeting with no recorded meeting details', () => {
  /**
   * Goes red if the update guard still trusts the empty details: the guest's
   * rename is saved (and would be pushed over the organizer's meeting).
   */
  test('Outlook: a guest\'s edit is refused once the provider says who organizes it', async () => {
    await connectMicrosoft(owner.uid);
    const id = await seedLegacyImport('outlook', 'AAMk-invite');
    route('/me/events/AAMk-invite', { status: 200, json: INVITED }, { method: 'GET' });

    const res = await owner.api.put(path(`/${id}`)).send({ title: 'Renamed by a guest' });

    expect(res.status).toBe(403);
    expect(callsMatching('/me/events/AAMk-invite').map((c) => c.method)).toEqual(['GET']);
    const saved = await row(id);
    expect(saved.title).toBe('Opposing counsel sync');
    // The details read are kept, so the next edit does not read them again.
    expect(saved.provider_details).toMatchObject({ isOrganizer: false, organizer: { address: 'counsel@opposing.test' } });
  });

  /** Goes red if the delete route removes the provider copy before the guard runs. */
  test('Outlook: a guest\'s delete is refused and nothing is removed', async () => {
    await connectMicrosoft(owner.uid);
    const id = await seedLegacyImport('outlook', 'AAMk-invite');
    route('/me/events/AAMk-invite', { status: 200, json: INVITED }, { method: 'GET' });

    const res = await owner.api.delete(path(`/${id}`));

    expect(res.status).toBe(403);
    expect(callsMatching('/me/events/AAMk-invite').map((c) => c.method)).toEqual(['GET']);
    expect(await row(id)).not.toBeNull();
  });

  /**
   * The provider cannot be reached. Goes red if the edit is let through
   * unchecked, or fails with an unexplained 500.
   */
  test('Google: an edit is refused with a clear error when the provider cannot answer', async () => {
    await connectGoogle(owner.uid);
    const id = await seedLegacyImport('google', 'g-invite');
    route('/calendars/primary/events/g-invite', { status: 500 }, { method: 'GET' });

    const res = await owner.api.put(path(`/${id}`)).send({ title: 'Renamed' });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/could not check this meeting with Google/i);
    expect((await row(id)).title).toBe('Opposing counsel sync');
  });

  /**
   * The member organizes it: the details say so and the edit proceeds to the
   * attendee confirmation, as for any meeting with recorded details.
   * Goes red if the fetched details are not applied to the guard at all.
   */
  test('Google: the organizer is asked to confirm attendee notification', async () => {
    await connectGoogle(owner.uid);
    const id = await seedLegacyImport('google', 'g-invite');
    route('/calendars/primary/events/g-invite', {
      status: 200,
      json: {
        id: 'g-invite', summary: 'Opposing counsel sync', status: 'confirmed', etag: '"e1"',
        organizer: { email: 'owner@firm.test', self: true },
        attendees: [{ email: 'counsel@opposing.test', responseStatus: 'accepted' }],
        start: { dateTime: '2026-10-07T15:00:00Z' }, end: { dateTime: '2026-10-07T16:00:00Z' },
      },
    }, { method: 'GET' });

    const res = await owner.api.put(path(`/${id}`)).send({ title: 'Renamed' });

    expect(res.status).toBe(409);
    expect((await row(id)).title).toBe('Opposing counsel sync');
  });
});
