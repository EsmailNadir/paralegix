/**
 * FILE_SHARED: the client-facing "we shared a document with you" email.
 *
 * Same shape as the DOCUMENT_REQUESTED and MESSAGE cases in
 * documentRequests.test.ts / messagingCore.test.ts: drive the real
 * `PATCH /client-visibility` route, then prove the real
 * `clients.settings.notifications.emailOnFileShared` toggle actually gates
 * the email `shareNotifications.service.ts` sends.
 *
 * FILE_SHARED's own listener (files.events.ts) only enqueues the share and
 * schedules a debounced flush (`SHARE_DIGEST_DEBOUNCE_MS`, 60s default) - the
 * email itself is sent later by `flushClient`. Waiting out a real 60-second
 * timer, or faking it, buys nothing here: `flushClient` is exported
 * specifically so a caller who wants to exercise the send doesn't have to
 * (see its neighbouring `startupSweep`'s own comment). Calling it directly
 * still runs every line this test cares about - the real preference lookup,
 * the real email send - only the timer itself is skipped.
 *
 * FINDING: `clients.settings.notifications.emailOnFileShared` has real,
 * correct backend wiring (confirmed below), but the client portal settings
 * page (frontend/src/app/client/lawfirm/[lawFirmId]/settings/page.tsx) offers
 * no checkbox for it - only emailOnNewInvoice, emailOnNewMessage and
 * emailOnMatterUpdate are exposed there. A real client can never reach this
 * toggle through the product; only a firm member with `clients.manage` can
 * set it, through the firm-side client settings route this test uses.
 */
import { rejectNextEmail, holdNextEmail } from '../support/email.mock';
import { installInMemoryBucket } from '../support/inMemoryBucket';
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  createPortalUser,
  ownerOf,
  recipientsOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { rootOf, seedFile } from './fileWorld';

// Module scope, before the app is first required: files.storage.ts resolves
// its bucket once, on load.
installInMemoryBucket();

const shareNotifications = require('../../src/modules/files/shareNotifications.service');

let firm: Firm;
let owner: Actor;

async function sharedClient() {
  const portal = await createPortalUser();
  const email = `${portal.uid}@example.test`;
  const client = await createPersonClient(firm.id, { name: 'Shared-With Client', userId: portal.uid, email });
  return { clientId: client.id, uid: portal.uid, email };
}

/** One document in the client's own file area, ready to be shared with them. */
async function documentFor(clientId: string): Promise<string> {
  const root = await rootOf(firm.id, { clientId });
  const row = await seedFile(firm.id, { parentId: root, name: 'Agreement.pdf' });
  return row.id;
}

async function shareWithClient(clientId: string, fileId: string) {
  const res = await owner.api
    .patch(`/api/lawfirms/${firm.id}/files/client-visibility`)
    .send({ clientId, fileId, clientVisible: true });
  await drainEvents();
  return res;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

describe('the client-facing file-shared email', () => {
  it('sends the digest by default, once flushed', async () => {
    const { clientId, uid, email } = await sharedClient();

    const shared = await shareWithClient(clientId, await documentFor(clientId));
    expect(shared.status).toBe(200);

    await shareNotifications.flushClient(firm.id, uid);

    expect(recipientsOf(/shared/i)).toContain(email);
  });

  it('does not send once the client turns off "email on file shared"', async () => {
    const { clientId, uid, email } = await sharedClient();
    const off = await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${clientId}/settings`)
      .send({ settings: { notifications: { emailOnFileShared: false } } });
    expect(off.status).toBe(200);

    const shared = await shareWithClient(clientId, await documentFor(clientId));
    expect(shared.status).toBe(200);

    await shareNotifications.flushClient(firm.id, uid);

    expect(recipientsOf(/shared/i)).not.toContain(email);
  });

  it('still posts the in-app bell even when the email toggle is off', async () => {
    // The in-app notification is deliberately NOT gated by this preference
    // (shareNotifications.service.ts's own comment: "costs the client
    // nothing and is the record that the share happened"). A regression that
    // gated both on the same flag would silently drop the bell too.
    const { clientId, uid } = await sharedClient();
    await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${clientId}/settings`)
      .send({ settings: { notifications: { emailOnFileShared: false } } });

    await shareWithClient(clientId, await documentFor(clientId));
    await shareNotifications.flushClient(firm.id, uid);

    const { rows } = await testPool.query(
      `select 1 from notifications where law_firm_id = $1 and user_id = $2 and type = 'file_shared'`,
      [firm.id, uid],
    );
    expect(rows).toHaveLength(1);
  });

  it('turning the toggle back on restores the email', async () => {
    const { clientId, uid, email } = await sharedClient();
    await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${clientId}/settings`)
      .send({ settings: { notifications: { emailOnFileShared: false } } });
    await owner.api
      .put(`/api/lawfirms/${firm.id}/clients/${clientId}/settings`)
      .send({ settings: { notifications: { emailOnFileShared: true } } });

    await shareWithClient(clientId, await documentFor(clientId));
    await shareNotifications.flushClient(firm.id, uid);

    expect(recipientsOf(/shared/i)).toContain(email);
  });
});

it('drains a scheduled share digest before its request lifecycle is torn down', async () => {
  const { clientId, uid, email } = await sharedClient();
  const shared = await shareWithClient(clientId, await documentFor(clientId));
  expect(shared.status).toBe(200);
  await shareNotifications.drainPendingFlushes();
  expect(recipientsOf(/shared/i)).toContain(email);
  const { rows } = await testPool.query(
    'select notified_at from file_client_access where law_firm_id = $1 and client_user_id = $2',
    [firm.id, uid],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].notified_at).not.toBeNull();
});

it('keeps a failed share digest pending so the same persisted work can retry', async () => {
  const { clientId, uid, email } = await sharedClient();
  const shared = await shareWithClient(clientId, await documentFor(clientId));
  expect(shared.status).toBe(200);
  const repo = require('../../src/modules/files/shareNotifications.repository');
  const failedLookup = jest.spyOn(repo, 'getClientContact').mockRejectedValueOnce(new Error('contact lookup unavailable'));
  try {
    await expect(shareNotifications.flushClient(firm.id, uid)).rejects.toThrow('contact lookup unavailable');
    const { rows } = await testPool.query(
      'select notified_at from file_client_access where law_firm_id = $1 and client_user_id = $2',
      [firm.id, uid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].notified_at).toBeNull();
    await shareNotifications.flushClient(firm.id, uid);
    expect(recipientsOf(/shared/i)).toContain(email);
  } finally { failedLookup.mockRestore(); }
});

it('retries a provider refusal without duplicating the bell after the ordinary dedupe window', async () => {
  const { clientId, uid, email } = await sharedClient();
  expect((await shareWithClient(clientId, await documentFor(clientId))).status).toBe(200);
  rejectNextEmail('mail provider unavailable');
  await expect(shareNotifications.flushClient(firm.id, uid)).rejects.toThrow('not delivered');
  expect(recipientsOf(/shared/i)).not.toContain(email);
  const pending = await testPool.query('select notified_at from file_client_access where law_firm_id = $1', [firm.id]);
  expect(pending.rows).toHaveLength(1);
  expect(pending.rows[0].notified_at).toBeNull();
  await testPool.query("update notifications set created_at = now() - interval '2 minutes' where law_firm_id = $1", [firm.id]);
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 120000);
  try { await shareNotifications.flushClient(firm.id, uid); } finally { clock.mockRestore(); }
  expect(recipientsOf(/shared/i)).toContain(email);
  const bells = await testPool.query("select id from notifications where law_firm_id = $1 and type = 'file_shared'", [firm.id]);
  expect(bells.rows).toHaveLength(1);
});

it('acknowledges a pre-existing pending share with microsecond timestamp precision', async () => {
  const { clientId, uid } = await sharedClient();
  expect((await shareWithClient(clientId, await documentFor(clientId))).status).toBe(200);
  await testPool.query("update file_client_access set shared_at = '2026-10-01 10:00:00.123456+00' where law_firm_id = $1", [firm.id]);
  await shareNotifications.flushClient(firm.id, uid);
  const rows = await testPool.query('select notified_at from file_client_access where law_firm_id = $1', [firm.id]);
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0].notified_at).not.toBeNull();
});

it('leaves a re-share pending when it arrives while an older digest is being sent', async () => {
  const { clientId, uid } = await sharedClient();
  const fileId = await documentFor(clientId);
  expect((await shareWithClient(clientId, fileId)).status).toBe(200);
  const held = holdNextEmail();
  const delivering = shareNotifications.flushClient(firm.id, uid);
  try {
    await held.arrived;
    const hidden = await owner.api.patch(`/api/lawfirms/${firm.id}/files/client-visibility`)
      .send({ clientId, fileId, clientVisible: false });
    expect(hidden.status).toBe(200);
    expect((await shareWithClient(clientId, fileId)).status).toBe(200);
  } finally { held.release(); await delivering; }
  const pending = await testPool.query('select notified_at from file_client_access where law_firm_id = $1', [firm.id]);
  expect(pending.rows).toHaveLength(1);
  expect(pending.rows[0].notified_at).toBeNull();
  await shareNotifications.flushClient(firm.id, uid);
  const bells = await testPool.query("select id from notifications where law_firm_id = $1 and type = 'file_shared'", [firm.id]);
  expect(bells.rows).toHaveLength(2);
});

it('does not reopen a delivered digest when its file-share event is replayed', async () => {
  const { clientId, uid, email } = await sharedClient();
  const eventBus = require('../../src/shared/events/eventBus');
  const { FILE_SHARED } = require('../../src/shared/events/eventTypes');
  let payload: any;
  const capture = (event: any) => { payload = event; };
  eventBus.on(FILE_SHARED, capture);
  try {
    expect((await shareWithClient(clientId, await documentFor(clientId))).status).toBe(200);
    expect(payload.fileId).toBeDefined();
    await shareNotifications.flushClient(firm.id, uid);
    expect(recipientsOf(/shared/i).filter((recipient) => recipient === email)).toHaveLength(1);
    await eventBus.emitAsync(FILE_SHARED, payload);
    await shareNotifications.flushClient(firm.id, uid);
    expect(recipientsOf(/shared/i).filter((recipient) => recipient === email)).toHaveLength(1);
    const bells = await testPool.query("select id from notifications where law_firm_id = $1 and type = 'file_shared'", [firm.id]);
    expect(bells.rows).toHaveLength(1);
  } finally { eventBus.off(FILE_SHARED, capture); }
});
