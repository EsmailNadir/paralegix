/**
 * Notification producers for the three terminal signing outcomes:
 * signing_completed, signing_declined, signing_participant_removed.
 *
 * Same shape as `notificationProducers.test.ts`: drive the real route, drain
 * the event bus, then read the `notifications` table directly. Sessions here
 * carry no matter (`destinationPath` unset), which keeps the fixture small -
 * `getMatterMemberIds` returns `[]` for a null matterId, so the only recipient
 * to check is the session's initiator.
 *
 * THE GCS STUB. `/complete` and the CLIENT_DELETED cascade both touch storage
 * (finalize seals a document; a terminal cancellation sweeps scratch copies),
 * so this needs the same shared in-memory bucket `signingRouting.test.ts` uses,
 * swapped in at module scope, before the app is first required. It has to be
 * that double rather than a map of buffers, because finalization reads the
 * stored source through ranged requests against a pinned generation.
 *
 * EACH SIGNER OWNS ONE FIELD, for the same reason: the server rebuilds the
 * executed document from the stored original plus the submitted values, and a
 * session with no fields is a different transport entirely.
 */
import {
  testPool,
  request,
  drainEvents,
  createFirm,
  ownerOf,
  createPortalUser,
  createPersonClient,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { sessionIdSql, sessionKeysSql, pointFirmSourceAt } from '../support/factories';
import { objects, putObject, inMemoryBucket } from '../support/inMemoryBucket';

const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const { admin } = require('../../src/shared/database/firebase');

admin.storage = () => ({ bucket: () => inMemoryBucket });

let firm: Firm;
let otherFirm: Firm;
let owner: Actor;
let onePagePdf: Buffer;

async function makePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

/** A single-participant, sequential session ready to complete or decline. */
async function seedSingleSignerSession(lawFirmId: string, createdBy: string) {
  const suffix = crypto.randomBytes(8).toString('hex');
  const sessionToken = `sess-${suffix}`;
  const objectPath = `signing-uploads/${lawFirmId}/${suffix}/agreement.pdf`;
  const participantId = `part-${suffix}`;
  const publicToken = `pub-${suffix}`;
  putObject(objectPath, { body: onePagePdf, contentType: 'application/pdf' });
  await pointFirmSourceAt(
    lawFirmId, objectPath, objects.get(objectPath)!.generation, objects.get(objectPath)!.bytes,
  );

  await testPool.query(
    `insert into signature_sessions
       (token, law_firm_id, source_id, created_by, routing_mode, status,
        file_name, object_path, current_signer_order, notify_email,
        document_hash, expires_at)
     values ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), $3, 'sequential', 'pending', 'Engagement Agreement.pdf', $4, 1,
             null, 'originalhash', now() + interval '7 days')`,
    [sessionToken, lawFirmId, createdBy, objectPath],
  );
  await testPool.query(
    `insert into signature_participants
       (id, session_id, law_firm_id, role_label, name, email, signing_order, status,
        delivery_method)
     values ($1, ${sessionKeysSql('$2')}, 'Signer 1', 'Jane Doe', 'jane@example.test', 1, 'active', 'email')`,
    [participantId, sessionToken],
  );
  await testPool.query(
    `insert into signature_participant_tokens
       (token, session_id, participant_id, law_firm_id, delivery_method)
     values ($1, ${sessionIdSql('$2')}, $3, $4, 'email')`,
    [publicToken, sessionToken, participantId, lawFirmId],
  );

  const { rowCount: fieldRows } = await testPool.query(
    `insert into signature_fields
       (id, session_id, law_firm_id, signer_id, page, x_percent, y_percent,
        width_percent, height_percent, field_type, label, required, sort_order)
     values ($1, ${sessionKeysSql('$2')}, $3, 1, 20, 30, 20, 6, 'text', 'Full name', true, 0)`,
    [`fld-${suffix}`, sessionToken, participantId],
  );
  expect(fieldRows).toBe(1);

  return { sessionToken, publicToken, fieldId: `fld-${suffix}` };
}

/** A completion the signing page could have sent: JSON, consent, one value. */
async function completionBody(publicToken: string, fieldId: string) {
  const view = await request().get(`/api/signing/${publicToken}`);
  return {
    consentAgreed: true,
    consentName: 'Jane Doe',
    consentTimestamp: new Date().toISOString(),
    sourceRevision: view.body.sourceRevision,
    idempotencyKey: crypto.randomUUID(),
    fieldValues: [{ fieldId, value: 'Jane Doe' }],
  };
}

const completeAnonymously = async (publicToken: string, fieldId: string) =>
  request().post(`/api/signing/${publicToken}/complete`)
    .set('Content-Type', 'application/json')
    .send(await completionBody(publicToken, fieldId) as never);

const completeAs = async (actor: Actor, publicToken: string, fieldId: string) =>
  actor.api.post(`/api/signing/${publicToken}/complete`)
    .set('Content-Type', 'application/json')
    .send(await completionBody(publicToken, fieldId) as never);

const declineAs = (actor: Actor | null, publicToken: string) =>
  (actor ? actor.api : request()).post(`/api/signing/${publicToken}/decline`).send({ reason: 'Not acceptable' });

async function notificationsFor(lawFirmId: string, type: string) {
  const { rows } = await testPool.query(
    `select user_id, entity_id, action_url, created_by
       from notifications where law_firm_id = $1 and type = $2
       order by user_id`,
    [lawFirmId, type],
  );
  return rows;
}

beforeEach(async () => {
  objects.clear();
  onePagePdf = await makePdf();
  firm = await createFirm();
  otherFirm = await createFirm();
  owner = await ownerOf(firm.id);
  await ownerOf(otherFirm.id);
});

describe('signing_completed: an anonymous signer completing the session notifies the sender', () => {
  it('notifies the session initiator, with a deep link to the signing history', async () => {
    const { publicToken, fieldId } = await seedSingleSignerSession(firm.id, owner.uid);

    const res = await completeAnonymously(publicToken, fieldId);
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
    await drainEvents();

    const rows = await notificationsFor(firm.id, 'signing_completed');
    expect(rows.map((r: any) => r.user_id)).toEqual([owner.uid]);
    expect(rows[0].action_url).toBe(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/lawfirm/${firm.id}/signatures/history`);
  });

  it('does not notify the initiator when they themselves completed it (no self-notify)', async () => {
    const { publicToken, fieldId } = await seedSingleSignerSession(firm.id, owner.uid);

    const res = await completeAs(owner, publicToken, fieldId);
    expect(res.status).toBe(200);
    await drainEvents();

    const rows = await notificationsFor(firm.id, 'signing_completed');
    expect(rows).toHaveLength(0);
  });

  it('never notifies a different firm', async () => {
    const { publicToken, fieldId } = await seedSingleSignerSession(firm.id, owner.uid);

    await completeAnonymously(publicToken, fieldId);
    await drainEvents();

    const otherFirmRows = await notificationsFor(otherFirm.id, 'signing_completed');
    expect(otherFirmRows).toHaveLength(0);
  });
});

describe('signing_declined: a decline notifies the sender', () => {
  it('notifies the session initiator, naming the declining signer', async () => {
    const { publicToken, fieldId } = await seedSingleSignerSession(firm.id, owner.uid);

    const res = await declineAs(null, publicToken);
    expect(res.status).toBe(200);
    await drainEvents();

    const rows = await notificationsFor(firm.id, 'signing_declined');
    expect(rows.map((r: any) => r.user_id)).toEqual([owner.uid]);
  });

  it('does not notify the initiator when they themselves declined it (no self-notify)', async () => {
    const { publicToken, fieldId } = await seedSingleSignerSession(firm.id, owner.uid);

    const res = await declineAs(owner, publicToken);
    expect(res.status).toBe(200);
    await drainEvents();

    const rows = await notificationsFor(firm.id, 'signing_declined');
    expect(rows).toHaveLength(0);
  });

  it('never notifies a different firm', async () => {
    const { publicToken, fieldId } = await seedSingleSignerSession(firm.id, owner.uid);

    await declineAs(null, publicToken);
    await drainEvents();

    const otherFirmRows = await notificationsFor(otherFirm.id, 'signing_declined');
    expect(otherFirmRows).toHaveLength(0);
  });
});

describe('signing_participant_removed: deleting a client cancels their only open session', () => {
  /** A session whose sole participant is bound to a portal client's own uid. */
  async function seedClientBoundSession(lawFirmId: string, createdBy: string, clientUserId: string) {
    const suffix = crypto.randomBytes(8).toString('hex');
    const sessionToken = `sess-${suffix}`;
    const objectPath = `signing-uploads/${lawFirmId}/${suffix}/agreement.pdf`;
    const participantId = `part-${suffix}`;
    putObject(objectPath, { body: onePagePdf, contentType: 'application/pdf' });
  await pointFirmSourceAt(
    lawFirmId, objectPath, objects.get(objectPath)!.generation, objects.get(objectPath)!.bytes,
  );

    await testPool.query(
      `insert into signature_sessions
         (token, law_firm_id, source_id, created_by, routing_mode, status,
          file_name, object_path, current_signer_order, notify_email,
          document_hash, expires_at)
       values ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), $3, 'sequential', 'in_progress', 'Engagement Agreement.pdf', $4, 1,
               null, 'originalhash', now() + interval '7 days')`,
      [sessionToken, lawFirmId, createdBy, objectPath],
    );
    await testPool.query(
      `insert into signature_participants
         (id, session_id, law_firm_id, role_label, name, email, signing_order, status,
          delivery_method, client_user_id)
       values ($1, ${sessionKeysSql('$2')}, 'Signer 1', 'Departing Client', 'departing@example.test', 1, 'active', 'email', $3)`,
      [participantId, sessionToken, clientUserId],
    );

    return { sessionToken };
  }

  it('notifies the session initiator when the only open signer is deleted', async () => {
    const portal = await createPortalUser();
    const client = await createPersonClient(firm.id, { name: 'Departing Client', userId: portal.uid });
    await seedClientBoundSession(firm.id, owner.uid, portal.uid);

    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/clients/${client.id}`);
    expect(res.status).toBe(200);
    await drainEvents();

    const rows = await notificationsFor(firm.id, 'signing_participant_removed');
    expect(rows.map((r: any) => r.user_id)).toEqual([owner.uid]);
    expect(rows[0].action_url).toBe(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/lawfirm/${firm.id}/signatures/history`);
  });

  it('never notifies a different firm', async () => {
    const portal = await createPortalUser();
    const client = await createPersonClient(firm.id, { name: 'Departing Client', userId: portal.uid });
    await seedClientBoundSession(firm.id, owner.uid, portal.uid);

    await owner.api.delete(`/api/lawfirms/${firm.id}/clients/${client.id}`);
    await drainEvents();

    const otherFirmRows = await notificationsFor(otherFirm.id, 'signing_participant_removed');
    expect(otherFirmRows).toHaveLength(0);
  });
});
