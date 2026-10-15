/**
 * A completed session's copies are retried until delivered, with claims preventing concurrent sends.
 *
 * Completion emails used to be sent once, by the worker that won the guarded
 * completion write, in that same process. A crash between that write and the
 * send lost them for good: every retry found the session already completed and
 * stopped. So the completion write now records the delivery as OWED, a worker
 * claims it with a lease before sending and stamps it delivered after, and the
 * drain sends whatever is owed and unclaimed.
 *
 * NAME WHAT HAS TO BREAK, per case:
 *
 *   STAMPED WHEN SENT. Stop stamping `delivered_at` after a send and the first
 *   case finds it null, and every later drain would send the copies again.
 *
 *   A LOST SEND IS SENT LATER. Drop the owed-delivery sweep from the drain (or
 *   stop stamping `delivery_owed_at` in the completion write) and the second
 *   case's signer never receives a copy.
 *
 *   A LIVE CLAIM IS RESPECTED. Let the sweep ignore an unexpired lease and the
 *   second case's first drain sends while the original worker may still be
 *   mid-send.
 *
 *   ONE SENDER. Drop the lease predicate from the claim and both concurrent
 *   drains reach the send in the third case.
 *
 *   NO MASS RE-SEND. Pick owed sessions by `status = 'completed' and
 *   delivered_at is null` instead of by the owed marker and every session
 *   completed before the marker existed is emailed again by the fourth case.
 */
import {
  testPool,
  request,
  createFirm,
  ownerOf,
  portalUser,
  createPersonClient,
  emailsMatching,
  resetEmails,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod } from '../support/gate';
import { rejectNextEmail } from '../support/email.mock';
import { objects, installInMemoryBucket } from '../support/inMemoryBucket';
import { minimalPdf } from '../support/minimalPdf';
import {
  seedSigningSession, storeSigningSource, completionBody, SIGNATURE_DATA_URL, settleAfterResponse,
} from '../support/signing';

installInMemoryBucket();

const signingDelivery = require('../../src/modules/signatures/signingDelivery');
const { drainSigningJobs } = require('../../src/modules/signatures/signingJobs');

let firm: Firm;
let owner: Actor;

async function completedSession(notifySender = true, portal?: Actor) {
  const objectPath = await storeSigningSource(firm.id, minimalPdf({ pages: 1 }).bytes);
  const { sessionToken, participants: [signer] } = await seedSigningSession({
    lawFirmId: firm.id,
    createdBy: owner.uid,
    session: {
      routing_mode: 'sequential',
      object_path: objectPath,
      current_signer_order: 1,
      notify_email: notifySender ? 'sender@example.test' : null,
      email_signers_on_complete: true,
      document_hash: 'originalhash',
    },
    participants: [{
      name: 'Signer One',
      email: 'signer@example.test',
      ...(portal ? { deliveryMethod: 'portal', columns: { client_user_id: portal.uid } } : {}),
      fields: [{ fieldType: 'signature', label: 'Sign', yPercent: 20 }],
    }],
  });
  const caller = portal ? portal.api : request();
  const page = await caller.get(`/api/signing/${signer.publicToken}`);
  expect(page.status).toBe(200);
  const res = await caller
    .post(`/api/signing/${signer.publicToken}/complete`)
    .set('Content-Type', 'application/json')
    .send(completionBody({
      sourceRevision: page.body.sourceRevision,
      fieldValues: [{ fieldId: signer.fieldIds[0], value: SIGNATURE_DATA_URL }],
    }) as never);
  expect(res.status).toBe(200);
  await settleAfterResponse();
  return sessionToken;
}

const deliveryRow = async (token: string) => (await testPool.query(
  `select status, delivery_owed_at, delivery_lease_expires_at, delivery_attempts, delivered_at
     from signature_sessions where token = $1`,
  [token],
)).rows[0];

const lapseDeliveryLease = (token: string) => testPool.query(
  `update signature_sessions set delivery_lease_expires_at = now() - interval '1 minute'
    where token = $1`,
  [token],
);

/** Complete a session whose worker dies at the send, after claiming it. */
async function completedButNotDelivered() {
  const gate = gateMethod(signingDelivery, 'deliverCompletedSession');
  gate.failNext(new Error('instance killed while sending'));
  const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await completedSession();
  } finally {
    gate.restore();
    errors.mockRestore();
  }
}

const signedCopies = () => emailsMatching(/Your signed copy/);

beforeEach(async () => {
  objects.clear();
  resetEmails();
  await testPool.query('delete from signature_processing_jobs');
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

describe('an ordinary completion', () => {
  it('records the delivery as owed, then as delivered, after one send', async () => {
    const token = await completedSession();

    expect(signedCopies()).toHaveLength(1);
    const row = await deliveryRow(token);
    expect(row.status).toBe('completed');
    expect(row.delivery_owed_at).toBeInstanceOf(Date);
    expect(row.delivered_at).toBeInstanceOf(Date);
    expect(row.delivery_attempts).toBe(1);

    // Delivered, so nothing a drain does sends it again, lease or no lease.
    await lapseDeliveryLease(token);
    await drainSigningJobs({ owner: 'drain-after-delivered' });
    expect(signedCopies()).toHaveLength(1);
  });
});

describe('a worker that dies after completing and before delivering', () => {
  it('leaves the delivery owed, and the drain sends it once the claim lapses', async () => {
    const token = await completedButNotDelivered();

    expect(signedCopies()).toHaveLength(0);
    const owed = await deliveryRow(token);
    expect(owed.status).toBe('completed');
    expect(owed.delivery_owed_at).toBeInstanceOf(Date);
    expect(owed.delivered_at).toBeNull();

    // The dead worker's claim is still live, and might belong to a worker that
    // is merely slow. The drain leaves it alone.
    await drainSigningJobs({ owner: 'drain-claim-live' });
    expect(signedCopies()).toHaveLength(0);

    await lapseDeliveryLease(token);
    await drainSigningJobs({ owner: 'drain-claim-lapsed' });

    expect(signedCopies()).toHaveLength(1);
    expect((await deliveryRow(token)).delivered_at).toBeInstanceOf(Date);

    await lapseDeliveryLease(token);
    await drainSigningJobs({ owner: 'drain-again' });
    expect(signedCopies()).toHaveLength(1);
  });
});

describe('two drains reaching one owed delivery', () => {
  it('lets exactly one of them send', async () => {
    const token = await completedButNotDelivered();
    await lapseDeliveryLease(token);

    const gate = gateMethod(signingDelivery, 'deliverCompletedSession');
    try {
      const both = Promise.all([
        drainSigningJobs({ owner: 'drain-one' }),
        drainSigningJobs({ owner: 'drain-two' }),
      ]);
      await gate.arrived(1);
      await expect(gate.arrived(2, 300)).rejects.toThrow(/waited 300ms for 2 concurrent calls/);
      gate.open();
      await both;
      expect(gate.entered()).toBe(1);
    } finally {
      gate.restore();
    }

    expect(signedCopies()).toHaveLength(1);
  });
});

describe('a session completed before deliveries were recorded', () => {
  it('is treated as delivered and never sent again', async () => {
    const token = await completedSession();
    expect(signedCopies()).toHaveLength(1);
    // Exactly what every row that predates migration 0018 looks like.
    await testPool.query(
      `update signature_sessions
          set delivery_owed_at = null, delivered_at = null,
              delivery_lease_expires_at = null, delivery_attempts = 0
        where token = $1`,
      [token],
    );

    await drainSigningJobs({ owner: 'drain-legacy' });

    expect(signedCopies()).toHaveLength(1);
  });
});


describe('a provider that refuses completion email', () => {
  it.each(['sender', 'signer'] as const)('keeps a refused %s copy owed and delivers it after the lease lapses', async (recipient) => {
    rejectNextEmail('Provider temporarily unavailable');
    const token = await completedSession(recipient === 'sender');
    const refusedSubject = recipient === 'sender' ? /Document signed:/ : /Your signed copy:/;
    expect(emailsMatching(refusedSubject)).toHaveLength(0);
    const owed = await deliveryRow(token);
    expect(owed.status).toBe('completed');
    expect(owed.delivery_owed_at).toBeInstanceOf(Date);
    expect(owed.delivered_at).toBeNull();
    expect(owed.delivery_attempts).toBe(1);

    await lapseDeliveryLease(token);
    await drainSigningJobs({ owner: 'drain-provider-recovered' });
    expect(emailsMatching(refusedSubject)).toHaveLength(1);
    const sent = await deliveryRow(token);
    expect(sent.delivered_at).toBeInstanceOf(Date);
    expect(sent.delivery_attempts).toBe(2);
    await drainSigningJobs({ owner: 'drain-after-recovery' });
    expect(emailsMatching(refusedSubject)).toHaveLength(1);
  });
});

it('stops retrying a provider refusal after the delivery attempt limit', async () => {
  rejectNextEmail('Provider unavailable');
  const token = await completedSession(false);
  const maxAttempts = Number(process.env.SIGNING_DELIVERY_MAX_ATTEMPTS) || 5;
  for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
    rejectNextEmail('Provider unavailable');
    // eslint-disable-next-line no-await-in-loop
    await lapseDeliveryLease(token);
    // eslint-disable-next-line no-await-in-loop
    await drainSigningJobs({ owner: `drain-refused-${attempt}` });
    // eslint-disable-next-line no-await-in-loop
    expect((await deliveryRow(token)).delivery_attempts).toBe(attempt);
  }
  expect(signedCopies()).toHaveLength(0);
  resetEmails();
  await lapseDeliveryLease(token);
  await drainSigningJobs({ owner: 'drain-attempt-limit' });
  expect(signedCopies()).toHaveLength(0);
  const row = await deliveryRow(token);
  expect(row.delivery_attempts).toBe(maxAttempts);
  expect(row.delivered_at).toBeNull();
  expect(row.status).toBe('completed');
});

const portalMessages = async (client: Actor) => (await testPool.query(
  `select m.attachments from messages m join conversations c on c.id = m.conversation_id
    where m.law_firm_id = $1 and c.client_id = $2`, [firm.id, client.uid],
)).rows;
const firmUsage = async () => Number((await testPool.query(
  'select storage_used_bytes from law_firms where id = $1', [firm.id],
)).rows[0].storage_used_bytes);
async function portalSigner() {
  const client = await portalUser();
  await createPersonClient(firm.id, { userId: client.uid, name: 'Signer One' });
  return client;
}

it('posts the executed delivery copy into only the portal signer firm conversation', async () => {
  const client = await portalSigner();
  const unrelatedFirm = await createFirm();
  const token = await completedSession(true, client);
  const messages = await portalMessages(client);
  expect(messages).toHaveLength(1);
  expect(messages[0].attachments).toHaveLength(1);
  const attachment = messages[0].attachments[0];
  expect(attachment.objectPath).toContain(`lawfirmids/${firm.id}/messaging/${firm.id}_${client.uid}/`);
  const session = (await testPool.query('select final_object_path, signed_object_path from signature_sessions where token = $1', [token])).rows[0];
  const delivery = objects.get(session.final_object_path);
  expect(Buffer.isBuffer(delivery?.body)).toBe(true);
  const copy = objects.get(attachment.objectPath);
  expect(Buffer.isBuffer(copy?.body)).toBe(true);
  expect(copy?.body).toEqual(delivery?.body);
  expect(attachment.size).toBe(delivery?.bytes);
  expect(attachment.mimeType).toBe('application/pdf');
  expect((await deliveryRow(token)).delivered_at).toBeInstanceOf(Date);
  const otherMessages = await testPool.query('select id from messages where law_firm_id = $1', [unrelatedFirm.id]);
  expect(otherMessages.rowCount).toBe(0);
  const filed = objects.get(session.signed_object_path);
  expect(filed).toBeDefined();
  expect(await firmUsage()).toBe(filed!.bytes + delivery!.bytes);
});

it('removes an unattached portal copy and its storage charge before retrying a failed post', async () => {
  const client = await portalSigner();
  const messaging = require('../../src/modules/messaging/messaging.repository');
  const gate = gateMethod(messaging, 'sendMessage');
  gate.failNext(new Error('Message write refused'));
  let token: string;
  try {
    token = await completedSession(true, client);
    expect(gate.entered()).toBe(1);
  } finally { gate.restore(); }
  expect(await portalMessages(client)).toHaveLength(0);
  expect([...objects.keys()].filter((key) => key.includes('/messaging/'))).toEqual([]);
  const row = await deliveryRow(token);
  expect(row.status).toBe('completed');
  expect(row.delivered_at).toBeNull();
  const session = (await testPool.query('select signed_object_path, final_object_path from signature_sessions where token = $1', [token])).rows[0];
  const filed = objects.get(session.signed_object_path);
  const delivery = objects.get(session.final_object_path);
  expect(filed).toBeDefined();
  expect(delivery).toBeDefined();
  expect(await firmUsage()).toBe(filed!.bytes);
  await lapseDeliveryLease(token);
  await drainSigningJobs({ owner: 'drain-portal-post-recovered' });
  const messages = await portalMessages(client);
  expect(messages).toHaveLength(1);
  expect(objects.has(messages[0].attachments[0].objectPath)).toBe(true);
  expect(await firmUsage()).toBe(filed!.bytes + delivery!.bytes);
  expect((await deliveryRow(token)).delivered_at).toBeInstanceOf(Date);
});
