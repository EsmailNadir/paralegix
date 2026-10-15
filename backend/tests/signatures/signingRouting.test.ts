/**
 * The signing state machine: whose turn it is, what a finished turn moves, and
 * what a terminal session still allows.
 *
 * `signingAccess.test.ts` covers who may reach a session and `signingAccessCode`
 * covers the code gate on the link. Neither touches the two routes that actually
 * change a session: `/:token/complete` and `/:token/decline`. Those hold the
 * ordering rules that a legal document depends on, and every one of them fails
 * silently if it breaks - the response still says success, and the damage is
 * only visible in the participant rows nobody looks at.
 *
 * The four rules pinned here:
 *
 *   TURN ORDER. A sequential session hands exactly one participant the turn.
 *   Signer two POSTing early must be refused, and refused BEFORE anything is
 *   written, or the executed agreement carries signatures collected out of the
 *   order the parties agreed to.
 *
 *   PROMOTION. Finishing a turn promotes exactly the next lowest-order waiting
 *   participant and nobody else. Promoting two would let signer three act before
 *   signer two; promoting none strands the document forever with no actionable
 *   signer.
 *
 *   SINGLE USE. A completed signer's link is consumed. A link that still
 *   authorised signing after its turn would let anyone who received a forwarded
 *   email re-open a session that had already moved on.
 *
 *   DECLINE IS TERMINAL. One signer's refusal ends the whole session, and the
 *   other signers' links stop working with it.
 *
 * Parallel routing has no turn to advance, so the same routes must NOT apply any
 * of the ordering rules to it. That is asserted as its own group, because a fix
 * to the sequential rules that leaked into parallel would block every signer but
 * the first and look like a turn-order bug that had been correctly enforced.
 *
 * SEEDING. Sessions are built with SQL for the reason the sibling specs give:
 * the harness's GCS mock is inert, so a fixture routed through the real upload
 * would be testing the mock. A session needs a `signature_participants` row and
 * a `signature_participant_tokens` row. The PUBLIC token on that second row is
 * what a signer holds; the session token alone resolves no participant,
 * and every case below would then be asserting against the "no access" branch.
 *
 * THE GCS STUB. `/complete` writes: a working copy per intermediate turn, and on
 * the final turn a sealed document, two archive copies and a `files` mirror.
 * There is no version of these routes that stops before the bucket, so this file
 * swaps `admin.storage()` for the shared in-memory bucket. The swap happens at
 * module scope because `signing.routes.ts` resolves its bucket once, at module
 * load, and the app is not loaded until the first request.
 *
 * That double is the shared one rather than a local map because finalization
 * reads the stored source through RANGED requests against a PINNED generation.
 * A map of buffers answers neither, so the seal would fail before any state
 * transition under test was reached. Nothing below asserts that the double
 * works; every assertion is about what the ROUTE decided to do to the session.
 *
 * EVERY SIGNER OWNS ONE FIELD. The server rebuilds the executed document from
 * the stored original plus the values each signer submitted, so a routing case
 * needs a field to submit a value for. A session with none is fieldless, which
 * is a different transport and a different file.
 */
import {
  testPool,
  request,
  drainEvents,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { sessionIdSql } from '../support/factories';
import { objects, objectReads, installInMemoryBucket } from '../support/inMemoryBucket';
import {
  seedSigningSession, storeSigningSource, makePdf, completionBody, sha256,
} from '../support/signing';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;
/** A one-page PDF, stored as every session's source. */
let onePagePdf: Buffer;

type SeedParticipant = {
  name: string;
  status?: 'active' | 'waiting' | 'completed' | 'declined' | 'cancelled';
  order?: number;
  email?: string | null;
  accessCodeHash?: string | null;
  accessCodeVerified?: boolean;
  consumed?: boolean;
};

type SeedOptions = {
  routingMode?: 'sequential' | 'parallel';
  status?: string;
  expiresAt?: string;
  currentSignerOrder?: number | null;
  notifyEmail?: string | null;
  participants: SeedParticipant[];
};

/**
 * Seed a v2 session and return the session token plus each participant's public
 * token, in the order given.
 *
 * The source PDF is placed in the fake bucket at the session's `object_path`
 * because the fieldless finalize path compares the uploaded document's page
 * count against the stored original before it will seal anything.
 *
 * One field per participant. A session with no fields is FIELDLESS, and a
 * fieldless completion has to name an uploaded object it executed; that is
 * `signingFieldlessDirectUpload.test.ts`. Everything here is about routing, so
 * each signer submits a value the server stamps itself.
 */
async function seedSession(options: SeedOptions) {
  const objectPath = await storeSigningSource(firm.id, onePagePdf);
  const { sessionToken, participants } = await seedSigningSession({
    lawFirmId: firm.id,
    createdBy: owner.uid,
    session: {
      routing_mode: options.routingMode ?? 'sequential',
      status: options.status ?? 'pending',
      object_path: objectPath,
      current_signer_order: options.currentSignerOrder === undefined ? 1 : options.currentSignerOrder,
      notify_email: options.notifyEmail === undefined ? 'sender@example.test' : options.notifyEmail,
      document_hash: 'originalhash',
      ...(options.expiresAt ? { expires_at: options.expiresAt } : {}),
    },
    participants: options.participants.map((input) => ({
      name: input.name,
      status: input.status ?? 'waiting',
      order: input.order,
      email: input.email,
      consumed: input.consumed,
      // The access-code gate is its own row, and only exists for a participant
      // the firm actually set a code on.
      challenge: input.accessCodeHash || input.accessCodeVerified
        ? {
          secretHash: input.accessCodeHash ?? null,
          verifiedAt: input.accessCodeVerified ? new Date().toISOString() : null,
        }
        : undefined,
      fields: [{ fieldType: 'text' as const, label: 'Full name', yPercent: 30 }],
    })),
  });

  return { sessionToken, objectPath, participants };
}

/** The field this signer owns, which a completion has to carry a value for. */
const fieldValuesFor = async (publicToken: string, value: string) => {
  const { rows } = await testPool.query(
    `select f.id from signature_fields f
       join signature_participant_tokens t
         on t.participant_id = f.signer_id and t.law_firm_id = f.law_firm_id
      where t.token = $1`,
    [publicToken],
  );
  return rows.map((row) => ({ fieldId: row.id, value }));
};

/**
 * The revision the signing page carried.
 *
 * A link that resolves no session answers no revision. Those cases are refused
 * by the turn, expiry and access rules, all of which run BEFORE the revision is
 * compared, so the placeholder is never the reason such a case is refused.
 */
const viewRevision = async (publicToken: string) => {
  const res = await request().get(`/api/signing/${publicToken}`);
  return typeof res.body?.sourceRevision === 'string' ? res.body.sourceRevision : 'unresolvable';
};

/**
 * A signer submitting their turn: JSON, unauthenticated, exactly the shape the
 * signing page posts.
 */
const complete = async (publicToken: string, consentName = 'A Signer') =>
  request().post(`/api/signing/${publicToken}/complete`)
    .set('Content-Type', 'application/json')
    .send(completionBody({
      consentName,
      sourceRevision: await viewRevision(publicToken),
      fieldValues: await fieldValuesFor(publicToken, consentName),
    }) as never);

const decline = (publicToken: string, reason = 'Terms are not acceptable') =>
  request().post(`/api/signing/${publicToken}/decline`).send({ reason });

const sessionRow = async (sessionToken: string) => {
  const { rows } = await testPool.query(
    `select status, current_signer_order, signed_object_path, signed_document_hash
       from signature_sessions where token = $1`,
    [sessionToken],
  );
  return rows[0];
};

/** Participant statuses in signing order, which is how a turn rule reads. */
const statusesInOrder = async (sessionToken: string) => {
  const { rows } = await testPool.query(
    `select status from signature_participants
      where session_id = ${sessionIdSql('$1')} order by signing_order`,
    [sessionToken],
  );
  return rows.map((row: { status: string }) => row.status);
};

const tokenConsumed = async (publicToken: string) => {
  const { rows } = await testPool.query(
    'select consumed_at from signature_participant_tokens where token = $1',
    [publicToken],
  );
  return rows[0]?.consumed_at !== null;
};

beforeAll(async () => {
  onePagePdf = await makePdf(1);
});

beforeEach(async () => {
  objects.clear();
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

describe('sequential routing: whose turn it is', () => {
  it('refuses a signer whose turn has not arrived, and writes nothing', async () => {
    const { sessionToken, participants } = await seedSession({
      participants: [
        { name: 'Ada First', status: 'active' },
        { name: 'Bo Second', status: 'waiting' },
      ],
    });

    const res = await complete(participants[1].publicToken, 'Bo Second');

    // The whole point of sequential routing. Signer two signing first produces a
    // document executed in an order the parties did not agree to, and no screen
    // afterwards shows that it happened.
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not your turn/i);
    // The status assertion would still pass if the route refused after marking
    // the participant completed. This is the assertion that cannot.
    expect(await statusesInOrder(sessionToken)).toEqual(['active', 'waiting']);
    expect(await tokenConsumed(participants[1].publicToken)).toBe(false);
  });

  it('distinguishes a spent turn from an unarrived one', async () => {
    const { participants } = await seedSession({
      currentSignerOrder: 2,
      participants: [
        { name: 'Ada First', status: 'completed' },
        { name: 'Bo Second', status: 'active' },
      ],
    });

    const res = await complete(participants[0].publicToken, 'Ada First');

    // Same 409, different sentence. A signer who already signed and reloads the
    // page must be told they are done, not that they are waiting for a turn that
    // will never come back to them.
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already completed their turn/i);
  });

  it('lets the active signer through', async () => {
    const { participants } = await seedSession({
      participants: [
        { name: 'Ada First', status: 'active' },
        { name: 'Bo Second', status: 'waiting' },
      ],
    });

    const res = await complete(participants[0].publicToken, 'Ada First');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      completed: false,
      waitingForNextSigner: true,
      nextSignerName: 'Bo Second',
    });
  });
});

describe('sequential routing: promoting the next signer', () => {
  it('promotes exactly one signer, the next in order, and advances the pointer to them', async () => {
    const { sessionToken, participants } = await seedSession({
      participants: [
        { name: 'Ada First', status: 'active' },
        { name: 'Bo Second', status: 'waiting' },
        { name: 'Cy Third', status: 'waiting' },
      ],
    });

    expect((await complete(participants[0].publicToken, 'Ada First')).status).toBe(200);

    // Three participants rather than two, deliberately. With two, promoting
    // "everyone waiting" and promoting "the next one" produce the same rows, and
    // a rule that activated the whole queue would pass unnoticed.
    expect(await statusesInOrder(sessionToken)).toEqual(['completed', 'active', 'waiting']);
    // `current_signer_order` is what the firm's signing view reads to say who is
    // being waited on. Left at 1 it reports the finished signer as outstanding.
    const row = await sessionRow(sessionToken);
    expect(row.current_signer_order).toBe(2);
    expect(row.status).toBe('in_progress');
  });

  it('promotes by signing order, not by row order', async () => {
    const { sessionToken, participants } = await seedSession({
      // Inserted highest-order first, so an implementation that took the first
      // waiting row it found would promote Cy and hand the turn to the wrong
      // party. The rule is lowest remaining order.
      participants: [
        { name: 'Cy Third', status: 'waiting', order: 3 },
        { name: 'Bo Second', status: 'waiting', order: 2 },
        { name: 'Ada First', status: 'active', order: 1 },
      ],
    });

    await complete(participants[2].publicToken, 'Ada First');

    const { rows } = await testPool.query(
      `select name, status from signature_participants
        where session_id = ${sessionIdSql('$1')} order by signing_order`,
      [sessionToken],
    );
    expect(rows).toEqual([
      { name: 'Ada First', status: 'completed' },
      { name: 'Bo Second', status: 'active' },
      { name: 'Cy Third', status: 'waiting' },
    ]);
  });

  it('lets the promoted signer sign immediately afterwards', async () => {
    const { participants } = await seedSession({
      participants: [
        { name: 'Ada First', status: 'active' },
        { name: 'Bo Second', status: 'waiting' },
        { name: 'Cy Third', status: 'waiting' },
      ],
    });
    await complete(participants[0].publicToken, 'Ada First');

    const res = await complete(participants[1].publicToken, 'Bo Second');

    // The promotion is only real if it authorises. A row flipped to 'active'
    // that the route still refused would satisfy the state assertions above and
    // leave the session unsignable.
    expect(res.status).toBe(200);
    expect(res.body.nextSignerName).toBe('Cy Third');
  });

  it('still refuses the signer two turns away', async () => {
    const { participants } = await seedSession({
      participants: [
        { name: 'Ada First', status: 'active' },
        { name: 'Bo Second', status: 'waiting' },
        { name: 'Cy Third', status: 'waiting' },
      ],
    });
    await complete(participants[0].publicToken, 'Ada First');

    // The consequence of promoting exactly one, stated as behaviour rather than
    // as a row: after the first turn Cy is still locked out.
    expect((await complete(participants[2].publicToken, 'Cy Third')).status).toBe(409);
  });
});

describe('what an intermediate turn reads', () => {
  it('refreshes the next signer view without pulling the document in', async () => {
    const { participants } = await seedSession({
      participants: [
        { name: 'Ada First', status: 'active' },
        { name: 'Bo Second', status: 'waiting' },
      ],
    });
    objectReads.length = 0;

    expect((await complete(participants[0].publicToken, 'Ada First')).status).toBe(200);

    // Finishing a turn that is not the last one refreshes the working copy the
    // NEXT signer sees. That used to download the stored original, stamp it
    // with pdf-lib and save the whole thing back, which put the document in
    // this process once per signer. It composes an appended revision now and
    // streams the digest, so a ten-signer session on a large document costs the
    // same as this one.
    //
    // `kind`, not width: a bounded window is wider than a 600-byte fixture, so
    // a correct streamed read covers the whole of it. What must not appear is a
    // DOWNLOAD, which answers a Buffer and is resident all at once.
    expect(objectReads.length).toBeGreaterThan(0);
    expect(objectReads.filter((read) => read.kind === 'download')).toEqual([]);
  });
});

describe('sequential routing: the link is single use', () => {
  it('consumes the signer own link when their turn completes, and only theirs', async () => {
    const { participants } = await seedSession({
      participants: [
        { name: 'Ada First', status: 'active' },
        { name: 'Bo Second', status: 'waiting' },
      ],
    });

    await complete(participants[0].publicToken, 'Ada First');

    expect(await tokenConsumed(participants[0].publicToken)).toBe(true);
    // Consuming the whole session's tokens instead of the finishing signer's
    // would end the signing dead: every remaining invitation email would resolve
    // to nothing and the document could never be executed.
    expect(await tokenConsumed(participants[1].publicToken)).toBe(false);
  });

  it('refuses to re-authorise signing through a spent link, and leaves the promoted signer alone', async () => {
    const { sessionToken, participants } = await seedSession({
      participants: [
        { name: 'Ada First', status: 'active' },
        { name: 'Bo Second', status: 'waiting' },
      ],
    });
    await complete(participants[0].publicToken, 'Ada First');

    const res = await complete(participants[0].publicToken, 'Ada First');

    // A spent token resolves no session, which is what makes the consumption
    // worth anything: a forwarded link cannot reopen a turn already taken. A
    // SECOND submission carrying a new idempotency key is a second signature on
    // that turn, not the retry of a submission already recorded, so it is
    // refused as the conflict it is rather than silently replayed as success.
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already completed their turn/i);
    // The replay must be inert, not merely rejected. A refusal raised after the
    // handler had already advanced the session would leave Bo skipped.
    expect(await statusesInOrder(sessionToken)).toEqual(['completed', 'active']);
    expect((await sessionRow(sessionToken)).current_signer_order).toBe(2);
  });
});

describe('the last signer finishes the session', () => {
  it('completes the session with a sealed document and consumes the last link', async () => {
    const { sessionToken, participants } = await seedSession({
      currentSignerOrder: 2,
      participants: [
        { name: 'Ada First', status: 'completed' },
        { name: 'Bo Second', status: 'active' },
      ],
    });

    const res = await complete(participants[1].publicToken, 'Bo Second');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      completed: true,
      waitingForNextSigner: false,
      nextSignerName: null,
    });
    // The terminal flip is deliberately deferred until the sealed artifact is
    // stored, so 'completed' and a stored path have to arrive together. A
    // session marked completed with no `signed_object_path` is the exact failure
    // that ordering exists to prevent.
    const row = await sessionRow(sessionToken);
    expect(row.status).toBe('completed');
    expect(row.current_signer_order).toBeNull();
    expect(row.signed_object_path).toBeTruthy();
    expect(row.signed_document_hash).toBeTruthy();
    expect(objects.has(row.signed_object_path)).toBe(true);
    expect(await statusesInOrder(sessionToken)).toEqual(['completed', 'completed']);
    // Nothing promotes after the final turn, so this is the only thing stopping
    // the final link from re-entering a completed session.
    expect(await tokenConsumed(participants[1].publicToken)).toBe(true);
  });
});

describe('a terminal session refuses further action', () => {
  it('refuses to complete a session already marked completed', async () => {
    const { participants } = await seedSession({
      status: 'completed',
      currentSignerOrder: null,
      participants: [{ name: 'Ada First', status: 'active' }],
    });

    const res = await complete(participants[0].publicToken, 'Ada First');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already been completed/i);
  });

  it('refuses to complete a cancelled session, and leaves it untouched', async () => {
    const { sessionToken, participants } = await seedSession({
      status: 'cancelled',
      currentSignerOrder: null,
      participants: [{ name: 'Ada First', status: 'active' }],
    });

    const res = await complete(participants[0].publicToken, 'Ada First');

    // A firm that recalled a document must not receive a signature on it
    // afterwards from a signer whose tab was still open.
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cancelled/i);
    expect(await statusesInOrder(sessionToken)).toEqual(['active']);
    expect((await sessionRow(sessionToken)).status).toBe('cancelled');
  });

  it('refuses to decline a completed session', async () => {
    const { participants } = await seedSession({
      status: 'completed',
      currentSignerOrder: null,
      participants: [{ name: 'Ada First', status: 'active' }],
    });

    const res = await decline(participants[0].publicToken);

    // Declining after execution would move a finished agreement to 'cancelled'
    // and lose the record that it had been signed.
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already been completed/i);
  });

  it('treats declining an already-cancelled session as a no-op', async () => {
    const { sessionToken, participants } = await seedSession({
      status: 'cancelled',
      currentSignerOrder: null,
      participants: [{ name: 'Ada First', status: 'active' }],
    });

    const res = await decline(participants[0].publicToken);

    // Idempotent by design: the signer's browser retrying a decline it already
    // sent should not see an error. It also must not rewrite the participants,
    // which is why the row is checked rather than only the status code.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, status: 'declined' });
    expect(await statusesInOrder(sessionToken)).toEqual(['active']);
  });

  it('refuses a signer who has already declined', async () => {
    const { participants } = await seedSession({
      participants: [
        { name: 'Ada First', status: 'declined' },
        { name: 'Bo Second', status: 'waiting' },
      ],
    });

    const res = await decline(participants[0].publicToken);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/can no longer decline/i);
  });

  it('refuses an expired link', async () => {
    const { participants } = await seedSession({
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      participants: [{ name: 'Ada First', status: 'active' }],
    });

    // 410 rather than 404: the link was real, and telling the signer it expired
    // is what sends them back to the firm for a new one.
    expect((await complete(participants[0].publicToken, 'Ada First')).status).toBe(410);
    expect((await decline(participants[0].publicToken)).status).toBe(410);
  });

  it('answers not-found for a token nothing issued', async () => {
    expect((await complete('pub-nothing-here', 'Nobody')).status).toBe(404);
    expect((await decline('pub-nothing-here')).status).toBe(404);
  });
});

describe('a decline ends the whole session', () => {
  it('marks the decliner declined, and cancels the session and every signer still waiting', async () => {
    const { sessionToken, participants } = await seedSession({
      participants: [
        { name: 'Ada First', status: 'active' },
        { name: 'Bo Second', status: 'waiting' },
        { name: 'Cy Third', status: 'waiting' },
      ],
    });

    const res = await decline(participants[0].publicToken);

    expect(res.status).toBe(200);
    // A refusal by one party ends the agreement for all of them. Leaving the
    // others 'waiting' would keep a dead document in their queue and keep the
    // reminder job emailing them about it.
    expect(await statusesInOrder(sessionToken)).toEqual(['declined', 'cancelled', 'cancelled']);
    const row = await sessionRow(sessionToken);
    expect(row.status).toBe('cancelled');
    expect(row.current_signer_order).toBeNull();
  });

  it('preserves the record of signers who had already signed', async () => {
    const { sessionToken, participants } = await seedSession({
      currentSignerOrder: 2,
      participants: [
        { name: 'Ada First', status: 'completed' },
        { name: 'Bo Second', status: 'active' },
        { name: 'Cy Third', status: 'waiting' },
      ],
    });

    await decline(participants[1].publicToken);

    // Ada genuinely signed. Sweeping her to 'cancelled' along with everyone else
    // would erase the only evidence of it from the session, and her signature is
    // already on the working copy.
    expect(await statusesInOrder(sessionToken)).toEqual(['completed', 'declined', 'cancelled']);
  });

  it('stops the remaining signers from signing afterwards', async () => {
    const { participants } = await seedSession({
      participants: [
        { name: 'Ada First', status: 'active' },
        { name: 'Bo Second', status: 'waiting' },
      ],
    });
    await decline(participants[0].publicToken);

    const res = await complete(participants[1].publicToken, 'Bo Second');

    // The rows above only matter if they actually stop a signature. Bo's link
    // was never consumed, so this is the session-status check doing the work.
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cancelled/i);
  });

  it('lets a waiting signer decline before their turn arrives', async () => {
    const { sessionToken, participants } = await seedSession({
      participants: [
        { name: 'Ada First', status: 'active' },
        { name: 'Bo Second', status: 'waiting' },
      ],
    });

    const res = await decline(participants[1].publicToken);

    // Declining is not turn-gated the way signing is: a party who knows they
    // will not sign should be able to say so without waiting to be asked, and
    // the session ends for everyone the same way.
    expect(res.status).toBe(200);
    expect(await statusesInOrder(sessionToken)).toEqual(['cancelled', 'declined']);
  });
});

describe('parallel routing has no turn to wait for', () => {
  it('lets the second participant sign first without promoting or consuming the other', async () => {
    const { sessionToken, participants } = await seedSession({
      routingMode: 'parallel',
      currentSignerOrder: null,
      participants: [
        { name: 'Ada First', status: 'active' },
        { name: 'Bo Second', status: 'active' },
      ],
    });

    const res = await complete(participants[1].publicToken, 'Bo Second');

    // Parallel routing exists so signers do not block each other. A turn rule
    // leaking into this mode would refuse everyone but the lowest order and look
    // exactly like correct sequential behaviour.
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(false);
    expect(await statusesInOrder(sessionToken)).toEqual(['active', 'completed']);
    // No "next" signer exists in this mode, so naming one would put a signer's
    // name in front of the wrong person on the confirmation screen.
    expect(res.body.nextSignerName).toBeNull();
    expect((await sessionRow(sessionToken)).current_signer_order).toBeNull();
    expect(await tokenConsumed(participants[1].publicToken)).toBe(true);
    expect(await tokenConsumed(participants[0].publicToken)).toBe(false);
  });

  it('refuses a participant who already signed', async () => {
    const { participants } = await seedSession({
      routingMode: 'parallel',
      currentSignerOrder: null,
      participants: [
        { name: 'Ada First', status: 'completed' },
        { name: 'Bo Second', status: 'active' },
      ],
    });

    const res = await complete(participants[0].publicToken, 'Ada First');

    // Not having a turn does not mean having unlimited turns. Without this a
    // parallel signer could submit repeatedly and overwrite their own record.
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already completed their turn/i);
  });

  it('completes the session only when the last participant signs', async () => {
    const { sessionToken, participants } = await seedSession({
      routingMode: 'parallel',
      currentSignerOrder: null,
      participants: [
        { name: 'Ada First', status: 'active' },
        { name: 'Bo Second', status: 'active' },
      ],
    });

    const first = await complete(participants[1].publicToken, 'Bo Second');
    const second = await complete(participants[0].publicToken, 'Ada First');

    // The completion side effects (sealing, filing, delivery) are gated on every
    // participant being done rather than on there being no next signer, because
    // in this mode there is never a next signer. Firing after the first would
    // deliver a half-signed document as the executed one.
    expect(first.body.completed).toBe(false);
    expect(second.body.completed).toBe(true);
    expect((await sessionRow(sessionToken)).status).toBe('completed');
    expect(await statusesInOrder(sessionToken)).toEqual(['completed', 'completed']);
  });
});

describe('what has to be true before the state machine runs', () => {
  it('refuses a completion that leaves a required field empty', async () => {
    const { sessionToken, participants } = await seedSession({
      participants: [{ name: 'Ada First', status: 'active' }],
    });

    const res = await request().post(`/api/signing/${participants[0].publicToken}/complete`)
      .set('Content-Type', 'application/json')
      .send(completionBody({
        consentName: 'Ada First',
        sourceRevision: await viewRevision(participants[0].publicToken),
        fieldValues: [],
      }) as never);

    // Stamping skips an empty value silently, so a turn accepted here executes
    // a document with the signer's own field still blank.
    expect(res.status).toBe(400);
    expect(await statusesInOrder(sessionToken)).toEqual(['active']);
  });

  it('refuses a completion with no signer name', async () => {
    const { participants } = await seedSession({
      participants: [{ name: 'Ada First', status: 'active' }],
    });

    const res = await request().post(`/api/signing/${participants[0].publicToken}/complete`)
      .set('Content-Type', 'application/json')
      .send(completionBody({
        consentName: '',
        sourceRevision: await viewRevision(participants[0].publicToken),
        fieldValues: await fieldValuesFor(participants[0].publicToken, 'Ada First'),
      }) as never);

    // The typed name is the signature of record on the certificate page.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/legal name/i);
  });

  it('refuses to sign behind an unverified access code', async () => {
    const { sessionToken, participants } = await seedSession({
      participants: [{
        name: 'Ada First',
        status: 'active',
        accessCodeHash: sha256('482913'),
        accessCodeVerified: false,
      }],
    });

    const res = await complete(participants[0].publicToken, 'Ada First');

    // The gate is enforced again here, not only on the gate route. Otherwise
    // possession of the link alone would be enough to sign, and the code would
    // protect only the page that displays the document.
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/access code/i);
    expect(await statusesInOrder(sessionToken)).toEqual(['active']);
  });

  it('lets a verified access-code signer through', async () => {
    const { participants } = await seedSession({
      participants: [{
        name: 'Ada First',
        status: 'active',
        accessCodeHash: sha256('482913'),
        accessCodeVerified: true,
      }],
    });

    // The other side of the boundary. Without it, a route that refused every
    // access-code session would satisfy the case above.
    expect((await complete(participants[0].publicToken, 'Ada First')).status).toBe(200);
  });

  it('refuses a session token used as if it were a signing link', async () => {
    const { sessionToken } = await seedSession({
      participants: [{ name: 'Ada First', status: 'active' }],
    });

    const res = await complete(sessionToken, 'Ada First');

    // The session token resolves the session but never a participant, so nobody
    // holding it is authorised to sign. It appears in firm-side URLs and audit
    // records, which is exactly why it must not double as a signing credential.
    expect(res.status).toBe(403);
  });
});
