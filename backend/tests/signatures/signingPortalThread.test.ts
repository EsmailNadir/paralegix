/**
 * Signing requests that travel through a client's portal message thread.
 *
 * A portal signer is a `signature_participants` row bound to a client's portal
 * account (`client_user_id`, delivery `portal`). Everything the firm tells that
 * signer (the request, a reminder, a decline, the signed copy) is posted into
 * the client's direct conversation by the backend, never by the browser.
 *
 * NAME WHAT HAS TO BREAK, per group:
 *
 *   SEND TO PORTAL. Require fields again on `/send`, or stop binding the
 *   portal signer, and the single-recipient portal request is refused or lands
 *   as an unbound email participant the client's pending list never shows.
 *
 *   NO BEARER TOKEN IN THE THREAD. Put `/signature?token=` back in the portal
 *   message and the content assertions find a live participant credential in a
 *   thread other people can read.
 *
 *   TENANT. Drop the `clientId` check on `/generate` and a member binds another
 *   firm's client as the signer, which later posts into that client's thread.
 *
 *   A FAILED POST IS NOT A FAILED OPERATION. Let a thread post throw out of
 *   `sendParticipantInvitation` and `/send` answers a bare 500 with the later
 *   signer never notified, and `/complete` reports an error for a signature it
 *   already recorded.
 *
 *   MESSAGING INVARIANTS. Insert the message beside the conversation instead of
 *   through the messaging repository and an archived thread stays archived.
 *
 *   SIGNED COPY. Post the copy as the client and the client can edit it.
 *
 *   WORDING. A reminder and a decline each say what they are.
 *
 * A failed thread post is injected with a trigger on `messages` that refuses
 * rows for one conversation's client, so the failure happens in Postgres at the
 * same insert whatever code path reaches it.
 */
import {
  testPool,
  request,
  createFirm,
  createPersonClient,
  createPortalUser,
  ownerOf,
  portalUser,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { sessionIdSql } from '../support/factories';
import { installInMemoryBucket, objects, putObject } from '../support/inMemoryBucket';
import { minimalPdfBytes } from '../support/minimalPdf';
import {
  seedSigningSession, storeSigningSource, makePdf, completionBody, SIGNATURE_DATA_URL, settleAfterResponse,
} from '../support/signing';

installInMemoryBucket();

process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';

let firm: Firm;
let owner: Actor;
let rival: Firm;
let sourcePath: string;
let onePagePdf: Buffer;

const links = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/signature-links`;

/** A portal person who is a client of `lawFirmId`. */
async function portalClientOf(lawFirmId: string, name: string): Promise<Actor> {
  const actor = await portalUser();
  await createPersonClient(lawFirmId, { name, userId: actor.uid, email: `${actor.uid}@example.test` });
  return actor;
}

/** Every message in the firm's direct conversation with `clientUid`, oldest first. */
async function thread(clientUid: string, lawFirmId: string = firm.id) {
  const { rows } = await testPool.query(
    `select m.id, m.content, m.sender_user_id, m.sender_type, m.sender_name, m.attachments
       from messages m
       join conversations c on c.id = m.conversation_id
      where c.law_firm_id = $1 and c.client_id = $2
      order by m.created_at asc, m.id asc`,
    [lawFirmId, clientUid],
  );
  return rows;
}

/** Wait for a fire-and-forget post to land, rather than sleeping a fixed time. */
async function threadEventually(clientUid: string, count: number) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await thread(clientUid);
    if (rows.length >= count || Date.now() > deadline) return rows;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

async function sessionTokens(sessionToken: string): Promise<string[]> {
  const { rows } = await testPool.query(
    `select t.token from signature_participant_tokens t
      where t.session_id = ${sessionIdSql('$1')}`,
    [sessionToken],
  );
  return rows.map((row: { token: string }) => row.token);
}

const FAIL_FN = 'test_refuse_signing_thread_post';

/** Make Postgres refuse every message posted into `clientUid`'s thread. */
async function refuseThreadPostsFor(clientUid: string) {
  await testPool.query(
    `create or replace function ${FAIL_FN}() returns trigger language plpgsql as $fn$
     begin
       if exists (select 1 from conversations c where c.id = new.conversation_id and c.client_id = '${clientUid}') then
         raise exception 'thread post refused for test';
       end if;
       return new;
     end
     $fn$`,
  );
  await testPool.query(
    `create trigger ${FAIL_FN} before insert on messages for each row execute function ${FAIL_FN}()`,
  );
}

beforeAll(async () => {
  onePagePdf = await makePdf(1);
});

beforeEach(async () => {
  objects.clear();
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  rival = await createFirm({ name: 'Rival LLP' });
  sourcePath = `lawfirmids/${firm.id}/general/Engagement Agreement.pdf`;
  putObject(sourcePath, { body: minimalPdfBytes({ pages: 2 }), contentType: 'application/pdf' });
  await drainEvents();
});

afterEach(async () => {
  await testPool.query(`drop trigger if exists ${FAIL_FN} on messages`);
  await testPool.query(`drop function if exists ${FAIL_FN}()`);
});

const sendToPortal = (signers: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  owner.api.post(`${links(firm.id)}/send`).send({
    objectPath: sourcePath,
    fileName: 'Engagement Agreement.pdf',
    signers,
    ...extra,
  });

const signatureFieldFor = (signerId: string) => ({
  id: `sign-${signerId}`,
  page: 1,
  xPercent: 10,
  yPercent: signerId === 'first' ? 10 : 40,
  widthPercent: 20,
  heightPercent: 5,
  fieldType: 'signature',
  signerId,
});

const portalSigner = (client: Actor, participantId: string, name: string) => ({
  participantId,
  roleLabel: 'Client',
  name,
  deliveryMethod: 'portal',
  clientUserId: client.uid,
});

describe('sending a document to one client portal', () => {
  it('creates a signer bound to the client, and the backend posts the request into their thread', async () => {
    const client = await portalClientOf(firm.id, 'Pat Client');

    const res = await sendToPortal([portalSigner(client, 'client', 'Pat Client')]);

    expect(res.status).toBe(200);
    const { rows: participants } = await testPool.query(
      `select client_user_id, delivery_method from signature_participants
        where session_id = ${sessionIdSql('$1')}`,
      [res.body.sessionToken],
    );
    expect(participants).toEqual([{ client_user_id: client.uid, delivery_method: 'portal' }]);

    const messages = await thread(client.uid);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('Engagement Agreement.pdf');
    // A system notice, not a message any one person can edit or delete.
    expect(messages[0].sender_user_id).toBeNull();
    expect(messages[0].sender_type).toBe('firm_member');

    // The client's pending list is how the portal opens the request.
    const pending = await client.api.get('/api/signing/pending-for-client');
    expect(pending.status).toBe(200);
    expect(pending.body.pendingDocuments.map((d: any) => d.sessionToken)).toEqual([res.body.sessionToken]);
  });

  it('puts no signing token in the thread, only the authenticated portal page', async () => {
    const client = await portalClientOf(firm.id, 'Pat Client');

    const res = await sendToPortal([portalSigner(client, 'client', 'Pat Client')]);

    expect(res.status).toBe(200);
    const [message] = await thread(client.uid);
    expect(message.content).toContain(`/client/lawfirm/${firm.id}/signatures`);
    const tokens = await sessionTokens(res.body.sessionToken);
    expect(tokens).toHaveLength(1);
    for (const token of [...tokens, res.body.sessionToken]) {
      expect(message.content).not.toContain(token);
    }
    expect(message.content).not.toContain('/signature?token=');
  });

  it('reopens an archived thread and records the notice as its latest message', async () => {
    const client = await portalClientOf(firm.id, 'Pat Client');
    const { rows: [conversation] } = await testPool.query(
      `insert into conversations (law_firm_id, client_id, last_message_at, last_sender_user_id, archived_at, archived_by)
       values ($1, $2, now() - interval '1 day', $2, now(), $3) returning id`,
      [firm.id, client.uid, owner.uid],
    );

    const res = await sendToPortal([portalSigner(client, 'client', 'Pat Client')]);

    expect(res.status).toBe(200);
    expect(await thread(client.uid)).toHaveLength(1);
    const { rows: [after] } = await testPool.query(
      'select archived_at, archived_by, last_sender_user_id from conversations where id = $1',
      [conversation.id],
    );
    expect(after.archived_at).toBeNull();
    expect(after.archived_by).toBeNull();
    // The client no longer spoke last; the system notice did.
    expect(after.last_sender_user_id).toBeNull();
  });
});

describe('the client a generated link is bound to', () => {
  it('refuses a clientId that is another firm\'s client, and creates nothing', async () => {
    const outsider = await portalClientOf(rival.id, 'Outside Client');

    const res = await owner.api.post(`${links(firm.id)}/generate`).send({
      objectPath: sourcePath,
      fileName: 'Engagement Agreement.pdf',
      clientId: outsider.uid,
    });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      'select count(*)::int as n from signature_sessions where law_firm_id = $1',
      [firm.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('refuses a clientId that names no client at all', async () => {
    const { uid } = await createPortalUser();

    const res = await owner.api.post(`${links(firm.id)}/generate`).send({
      objectPath: sourcePath,
      fileName: 'Engagement Agreement.pdf',
      clientId: uid,
    });

    expect(res.status).toBe(400);
  });

  it('binds a clientId that is this firm\'s client', async () => {
    const client = await portalClientOf(firm.id, 'Pat Client');

    const res = await owner.api.post(`${links(firm.id)}/generate`).send({
      objectPath: sourcePath,
      fileName: 'Engagement Agreement.pdf',
      clientId: client.uid,
    });

    expect(res.status).toBe(200);
    const { rows } = await testPool.query(
      `select client_user_id from signature_participants where session_id = ${sessionIdSql('$1')}`,
      [res.body.sessionToken],
    );
    expect(rows).toEqual([{ client_user_id: client.uid }]);
  });
});

describe('a thread post that fails does not undo a committed operation', () => {
  it('/send reports the undelivered signer with the session id and still notifies the rest', async () => {
    const first = await portalClientOf(firm.id, 'First Client');
    const second = await portalClientOf(firm.id, 'Second Client');
    await refuseThreadPostsFor(first.uid);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await sendToPortal(
        [portalSigner(first, 'first', 'First Client'), portalSigner(second, 'second', 'Second Client')],
        { routingMode: 'parallel', fields: [signatureFieldFor('first'), signatureFieldFor('second')] },
      );

      expect(res.status).toBe(502);
      expect(res.body.code).toBe('SIGNING_EMAIL_NOT_SENT');
      const { rows: [session] } = await testPool.query(
        'select token from signature_sessions where law_firm_id = $1',
        [firm.id],
      );
      expect(res.body.sessionId).toBe(session.token);
      // The second signer's request went out even though the first's did not.
      expect(await thread(second.uid)).toHaveLength(1);
      expect(await thread(first.uid)).toHaveLength(0);
    } finally {
      errors.mockRestore();
    }
  });

  it('/complete records the signature and promotes the next signer when their thread post fails', async () => {
    const next = await portalClientOf(firm.id, 'Next Client');
    const objectPath = await storeSigningSource(firm.id, onePagePdf);
    const { sessionToken, participants: [ada] } = await seedSigningSession({
      lawFirmId: firm.id,
      createdBy: owner.uid,
      session: {
        routing_mode: 'sequential',
        object_path: objectPath,
        current_signer_order: 1,
        document_hash: 'originalhash',
      },
      participants: [
        { name: 'Ada First', status: 'active', fields: [{ fieldType: 'text', label: 'Name', yPercent: 30 }] },
        {
          name: 'Next Client',
          status: 'waiting',
          deliveryMethod: 'portal',
          columns: { client_user_id: next.uid },
          fields: [{ fieldType: 'text', label: 'Name', yPercent: 50 }],
        },
      ],
    });
    await refuseThreadPostsFor(next.uid);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const page = await request().get(`/api/signing/${ada.publicToken}`);
      expect(page.status).toBe(200);
      const res = await request().post(`/api/signing/${ada.publicToken}/complete`)
        .set('Content-Type', 'application/json')
        .send(completionBody({
          consentName: 'Ada First',
          sourceRevision: page.body.sourceRevision,
          fieldValues: [{ fieldId: ada.fieldIds[0], value: 'Ada First' }],
        }) as never);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, waitingForNextSigner: true });
      const { rows } = await testPool.query(
        `select status from signature_participants
          where session_id = ${sessionIdSql('$1')} order by signing_order`,
        [sessionToken],
      );
      expect(rows.map((row: { status: string }) => row.status)).toEqual(['completed', 'active']);
    } finally {
      await settleAfterResponse();
      errors.mockRestore();
    }
  });
});

/** A pending session with one active portal signer, seeded directly. */
async function seedPortalSession(client: Actor, session: Record<string, unknown> = {}, participant: Record<string, unknown> = {}) {
  const seeded = await seedSigningSession({
    lawFirmId: firm.id,
    createdBy: owner.uid,
    session: { routing_mode: 'sequential', current_signer_order: 1, ...session },
    participants: [{
      name: 'Pat Client',
      status: 'active',
      deliveryMethod: 'portal',
      columns: { client_user_id: client.uid, ...participant },
    }],
  });
  return { sessionToken: seeded.sessionToken, participant: seeded.participants[0] };
}

describe('what a portal signer is told', () => {
  it('a manual resend says it is a reminder', async () => {
    const client = await portalClientOf(firm.id, 'Pat Client');
    const { sessionToken, participant } = await seedPortalSession(client);

    const res = await owner.api
      .post(`${links(firm.id)}/${sessionToken}/resend-participant/${participant.participantId}`)
      .send({});

    expect(res.status).toBe(200);
    const messages = await thread(client.uid);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toMatch(/^Reminder/);
    expect(messages[0].content).toContain('Engagement Agreement.pdf');
    expect(messages[0].content).not.toContain(participant.publicToken);
  });

  it('the scheduled reminder says the request is close to expiring', async () => {
    const client = await portalClientOf(firm.id, 'Pat Client');
    await seedPortalSession(
      client,
      { expires_at: new Date(Date.now() + 86_400_000).toISOString() },
      { started_at: new Date(Date.now() - 86_400_000 - 60_000).toISOString() },
    );
    const { sendSigningReminders } = require('../../src/modules/signatures/signingReminders.service');

    const stats = await sendSigningReminders();

    expect(stats.sent).toBeGreaterThanOrEqual(1);
    const messages = await thread(client.uid);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toMatch(/^Reminder/);
    expect(messages[0].content).toMatch(/close to expiring/);
  });

  it('a manual resend whose thread post fails answers the delivery failure, not a 500', async () => {
    const client = await portalClientOf(firm.id, 'Pat Client');
    const { sessionToken, participant } = await seedPortalSession(client);
    await refuseThreadPostsFor(client.uid);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await owner.api
        .post(`${links(firm.id)}/${sessionToken}/resend-participant/${participant.participantId}`)
        .send({});

      expect(res.status).toBe(502);
      expect(res.body.code).toBe('SIGNING_EMAIL_NOT_SENT');
    } finally {
      errors.mockRestore();
    }
  });

  it('a decline is called a decline, to the decliner and to the other signer', async () => {
    const decliner = await portalClientOf(firm.id, 'Dee Cliner');
    const other = await portalClientOf(firm.id, 'Otto Other');
    const { participants: [dee] } = await seedSigningSession({
      lawFirmId: firm.id,
      createdBy: owner.uid,
      session: { routing_mode: 'sequential', current_signer_order: 1 },
      participants: [
        { name: 'Dee Cliner', status: 'active', deliveryMethod: 'portal', columns: { client_user_id: decliner.uid } },
        { name: 'Otto Other', status: 'waiting', deliveryMethod: 'portal', columns: { client_user_id: other.uid } },
      ],
    });

    const res = await request().post(`/api/signing/${dee.publicToken}/decline`).send({ reason: 'No' });

    expect(res.status).toBe(200);
    const toDecliner = await threadEventually(decliner.uid, 1);
    const toOther = await threadEventually(other.uid, 1);
    expect(toDecliner).toHaveLength(1);
    expect(toDecliner[0].content).toMatch(/declined/i);
    expect(toOther).toHaveLength(1);
    expect(toOther[0].content).toMatch(/declined/i);
    expect(toOther[0].content).not.toMatch(/cancelled/i);
  });
});

describe('the signed copy in the client thread', () => {
  it('is a system notice the client cannot edit', async () => {
    const client = await portalClientOf(firm.id, 'Pat Client');
    const objectPath = await storeSigningSource(firm.id, onePagePdf);
    const { participants: [signer] } = await seedSigningSession({
      lawFirmId: firm.id,
      createdBy: owner.uid,
      session: {
        routing_mode: 'sequential',
        object_path: objectPath,
        current_signer_order: 1,
        document_hash: 'originalhash',
      },
      participants: [{
        name: 'Pat Client',
        deliveryMethod: 'portal',
        columns: { client_user_id: client.uid },
        fields: [{ fieldType: 'signature', label: 'Sign', yPercent: 20 }],
      }],
    });
    const page = await client.api.get(`/api/signing/${signer.publicToken}`);
    expect(page.status).toBe(200);
    const done = await client.api.post(`/api/signing/${signer.publicToken}/complete`)
      .set('Content-Type', 'application/json')
      .send(completionBody({
        sourceRevision: page.body.sourceRevision,
        fieldValues: [{ fieldId: signer.fieldIds[0], value: SIGNATURE_DATA_URL }],
      }) as never);
    expect(done.status).toBe(200);
    await settleAfterResponse();

    const withCopy = (await thread(client.uid)).filter((m: any) => Array.isArray(m.attachments) && m.attachments.length > 0);
    expect(withCopy).toHaveLength(1);
    expect(withCopy[0].sender_user_id).toBeNull();
    expect(withCopy[0].sender_type).toBe('firm_member');

    const edit = await client.api.patch(`/api/messaging/messages/${withCopy[0].id}`).send({ content: 'I never signed' });
    expect(edit.status).toBe(403);
  });
});
