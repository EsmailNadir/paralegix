/**
 * Two PUBLIC signing routes that no other spec exercises through HTTP:
 *
 *   POST /api/signing/verify        — public document-authenticity checker.
 *   GET  /api/signing/:token/status — public waiting-signer status poll.
 *
 * `signingAccess.test.ts`, `signingAccessCode(Scope).test.ts` and
 * `signingRouting.test.ts` cover who may open a session, clear its gate, and
 * complete/decline a turn. None of them touch these two. `/verify` is not even
 * keyed by a URL token: the credential is the document's own bytes, searched
 * with NO law-firm scope by design (`findSessionBySignedHash` runs on
 * `rootQueryExecutor`, the same deliberately-unscoped path every other
 * token-authorized signing lookup uses, per the "TENANT SCOPING" note atop
 * `signaturesRepository.test.ts`). `/status` IS keyed by a token, but it is the
 * PARTICIPANT's public token specifically — `getParticipantStatusByToken`
 * joins through `signature_participant_tokens`, so the SESSION token that
 * `/verify` hands back as `transactionId` does not resolve here at all. That
 * distinction is asserted directly below rather than assumed from reading the
 * query.
 *
 * The two routes interact in a way worth pinning on its own: `/verify` returns
 * the session's own token as `transactionId`, and that token is also what
 * appears in firm-side URLs and audit rows. If it ALSO worked as a signing or
 * status credential, then possessing a copy of a completed document — which
 * can circulate well beyond the original signers — would be enough to pull
 * session metadata or a live status feed for a document you were never a
 * party to. `signingRouting.test.ts` already proves a session token can't
 * complete a turn (`refuses a session token used as if it were a signing
 * link`); this file proves the other two routes a leaked `transactionId`
 * could plausibly reach — GET /:token and GET /:token/status — refuse it too.
 *
 * Fixtures are plain SQL, matching the shape `signaturesRepository.test.ts`
 * and `signingRouting.test.ts` already use: a `signature_sessions` row plus
 * `signature_participants`/`signature_participant_tokens` rows. Neither route
 * under test touches GCS, so unlike `signingRouting.test.ts` there is no fake
 * bucket here — `/verify` hashes the uploaded buffer in memory and `/status`
 * never reads a file at all.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  request,
  createFirm,
  ensureUser,
  type Firm,
} from '../support/setupInProcess';
import { sessionKeysSql } from '../support/factories';
import { seedSigningSession, seedSigningParticipant, sha256 } from '../support/signing';

const anon = () => request();
/**
 * Check a document the way the browser does: hash it locally, send the digest.
 *
 * The route used to accept the document itself and hash it as it streamed. That
 * held an unauthenticated request open for a whole transfer to produce 32 bytes
 * the caller could produce alone, so the bytes stay where they are and only the
 * digest travels.
 */
const verify = (buffer: Buffer | null) => {
  const req = anon().post('/api/signing/verify');
  return buffer ? req.send({ hash: sha256(buffer) }) : req;
};
const status = (token: string) => anon().get(`/api/signing/${token}/status`);

let firm: Firm;

type SessionOverrides = {
  status?: string;
  fileName?: string;
  signedHash?: string | null;
  deliveryHash?: string | null;
  completedAt?: string | null;
  expiresAt?: string;
  currentSignerOrder?: number | null;
};

async function seedSession(lawFirmId: string, overrides: SessionOverrides = {}): Promise<string> {
  const sessionToken = `sess-${randomUUID().slice(0, 12)}`;
  await ensureUser('creator-uid');
  await seedSigningSession({
    lawFirmId,
    createdBy: 'creator-uid',
    token: sessionToken,
    session: {
      status: overrides.status ?? 'pending',
      file_name: overrides.fileName ?? 'Engagement Agreement.pdf',
      object_path: `signing-uploads/${lawFirmId}/${sessionToken}/agreement.pdf`,
      signed_document_hash: overrides.signedHash === undefined ? null : overrides.signedHash,
      delivery_document_hash: overrides.deliveryHash === undefined ? null : overrides.deliveryHash,
      completed_at: overrides.completedAt === undefined ? null : overrides.completedAt,
      current_signer_order: overrides.currentSignerOrder === undefined ? 1 : overrides.currentSignerOrder,
      ...(overrides.expiresAt ? { expires_at: overrides.expiresAt } : {}),
    },
  });
  return sessionToken;
}

type ParticipantOverrides = {
  status?: string;
  order?: number;
  name?: string;
  signerName?: string | null;
  consumed?: boolean;
};

async function seedParticipant(
  sessionToken: string,
  overrides: ParticipantOverrides = {},
): Promise<{ participantId: string; publicToken: string }> {
  const suffix = randomUUID().slice(0, 12);
  const status = overrides.status ?? 'waiting';
  const { participantId, publicToken } = await seedSigningParticipant({ sessionToken }, {
    roleLabel: 'Signer',
    order: overrides.order ?? 1,
    name: overrides.name ?? 'Ada Signer',
    email: `${suffix}@example.test`,
    status,
    consumed: overrides.consumed ?? false,
    columns: {
      signer_name: overrides.signerName === undefined ? null : overrides.signerName,
      completed_at: status === 'completed' ? new Date().toISOString() : null,
    },
  }, { index: 0, idSuffix: suffix });
  return { participantId, publicToken };
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Harlow & Reyes LLP' });
});

// ---------------------------------------------------------------------------
// POST /api/signing/verify
// ---------------------------------------------------------------------------

describe('POST /api/signing/verify: a match', () => {
  it('confirms a document matching the FILED (signed) copy', async () => {
    const buffer = Buffer.from('the filed copy, certificate page and all');
    const sessionToken = await seedSession(firm.id, {
      status: 'completed',
      signedHash: sha256(buffer),
      completedAt: new Date('2026-01-15T10:00:00Z').toISOString(),
    });
    await seedParticipant(sessionToken, { status: 'completed', signerName: 'Dana Reed' });

    const res = await verify(buffer);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      valid: true,
      fileName: 'Engagement Agreement.pdf',
      signerName: 'Dana Reed',
      signedAt: '2026-01-15T10:00:00.000Z',
      transactionId: sessionToken,
      matchedCopy: 'filed',
    });
  });

  it('confirms a document matching the DELIVERED copy, and names which one matched', async () => {
    const buffer = Buffer.from('the delivered copy, no certificate page');
    const sessionToken = await seedSession(firm.id, {
      status: 'completed',
      deliveryHash: sha256(buffer),
      completedAt: new Date().toISOString(),
    });
    await seedParticipant(sessionToken, { status: 'completed', signerName: 'Priya Nair' });

    const res = await verify(buffer);

    // The two sealed copies differ byte-for-byte (the filed one carries an
    // appended certificate page), so `/verify` has to recognise either hash.
    // Without this, the copy every signer and portal client actually received
    // would fail its own authenticity check.
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.matchedCopy).toBe('delivered');
  });

  it('joins the names of every COMPLETED signer, in signing order', async () => {
    const buffer = Buffer.from('two-signer agreement');
    const sessionToken = await seedSession(firm.id, { status: 'completed', signedHash: sha256(buffer) });
    await seedParticipant(sessionToken, { order: 2, status: 'completed', signerName: 'Second Signer' });
    await seedParticipant(sessionToken, { order: 1, status: 'completed', signerName: 'First Signer' });

    const res = await verify(buffer);

    expect(res.body.signerName).toBe('First Signer, Second Signer');
  });

  it('excludes a participant who never actually completed', async () => {
    const buffer = Buffer.from('completed session with a leftover cancelled slot');
    // A session can reach 'completed' with a participant row that is not
    // itself 'completed' (e.g. a facilitated in-person replacement that
    // cancelled the original invite). The public verifier must not credit
    // someone who never signed with having signed.
    const sessionToken = await seedSession(firm.id, { status: 'completed', signedHash: sha256(buffer) });
    await seedParticipant(sessionToken, { order: 1, status: 'completed', signerName: 'Actually Signed' });
    await seedParticipant(sessionToken, { order: 2, status: 'cancelled', signerName: 'Never Signed' });

    const res = await verify(buffer);

    expect(res.body.signerName).toBe('Actually Signed');
    expect(res.body.signerName).not.toContain('Never Signed');
  });

  it('falls back to the participant name when no signer name was captured', async () => {
    const buffer = Buffer.from('signer name fallback');
    const sessionToken = await seedSession(firm.id, { status: 'completed', signedHash: sha256(buffer) });
    await seedParticipant(sessionToken, { status: 'completed', name: 'Fallback Name', signerName: null });

    const res = await verify(buffer);

    expect(res.body.signerName).toBe('Fallback Name');
  });

  it('does not require the document to belong to any particular firm', async () => {
    const other = await createFirm({ name: 'Other Firm LLP' });
    const buffer = Buffer.from('cross-firm verification');
    const sessionToken = await seedSession(other.id, { status: 'completed', signedHash: sha256(buffer) });
    await seedParticipant(sessionToken, { status: 'completed', signerName: 'Their Signer' });

    // The caller supplies no lawFirmId anywhere - the search is deliberately
    // global, by design, because a document can be checked by anyone who has
    // it regardless of which firm produced it.
    const res = await verify(buffer);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('returns EXACTLY the documented fields on a match', async () => {
    const buffer = Buffer.from('exact key set on match');
    const sessionToken = await seedSession(firm.id, { status: 'completed', signedHash: sha256(buffer) });
    await seedParticipant(sessionToken, { status: 'completed' });

    const res = await verify(buffer);

    // Enumerated so that a future spread of the internal session object -
    // which carries `lawFirmId`, `objectPath`, `createdBy` and every
    // participant's email - is a deliberate decision, not a silent leak to an
    // anonymous caller who merely uploaded a file.
    expect(Object.keys(res.body).sort()).toEqual(
      ['fileName', 'matchedCopy', 'signedAt', 'signerName', 'transactionId', 'valid'].sort(),
    );
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(firm.id);
  });


});

describe('POST /api/signing/verify: no match', () => {
  it('reports invalid for a document nothing was signed against, and discloses nothing else', async () => {
    const res = await verify(Buffer.from('never seen this document before'));

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.message).toMatch(/not signed through paralegix|modified/i);
    // Not a bare status check: a 200 that still carried a `transactionId` or
    // `fileName` here would be handing out real session data disguised as a
    // failed lookup.
    expect(Object.keys(res.body).sort()).toEqual(['message', 'valid']);
  });

  it('reports invalid for a document altered by one byte', async () => {
    const original = Buffer.from('perfectly sealed document bytes');
    const altered = Buffer.from('perfectly sealed document bytes.');
    await seedSession(firm.id, {
      status: 'completed',
      signedHash: sha256(original),
    });

    const res = await verify(altered);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.message).toMatch(/not signed through paralegix|modified/i);
  });


  it('does not match a PENDING session that was never signed', async () => {
    // A pending session has no signed/delivery hash yet. Uploading its
    // original (unsigned) source document must not be treated as proof it was
    // executed.
    const buffer = Buffer.from('still-pending original document');
    await seedSession(firm.id, { status: 'pending', signedHash: null, deliveryHash: null });

    const res = await verify(buffer);

    expect(res.body.valid).toBe(false);
  });

  it('does not match a CANCELLED session even if a hash happens to be set', async () => {
    // The query filters on status = 'completed'; a cancelled session should
    // never authenticate a document as genuinely executed.
    const buffer = Buffer.from('cancelled session leftover hash');
    await seedSession(firm.id, { status: 'cancelled', signedHash: sha256(buffer) });

    const res = await verify(buffer);

    expect(res.body.valid).toBe(false);
  });

  it('refuses a request with no hash at all', async () => {
    const res = await verify(null);

    expect(res.status).toBe(400);
  });

  it('refuses anything that is not a SHA-256 digest', async () => {
    // The hash is now caller-supplied, so its SHAPE is the only thing standing
    // between this lookup and an arbitrary string reaching the query. A short
    // or non-hex value is refused rather than reported as an unrecognised
    // document, which would read as a genuine answer about a real file.
    for (const hash of ['', 'not-a-hash', 'ab'.repeat(31), 'z'.repeat(64), `${'a'.repeat(64)}b`]) {
      const res = await anon().post('/api/signing/verify').send({ hash });

      expect(res.status).toBe(400);
      expect(res.body.valid).toBeUndefined();
    }
  });
});

describe('POST /api/signing/verify: the leaked transactionId buys nothing extra', () => {
  it('cannot be used to open the session metadata route anonymously', async () => {
    const buffer = Buffer.from('transactionId replay: metadata route');
    const sessionToken = await seedSession(firm.id, { status: 'completed', signedHash: sha256(buffer) });
    await seedParticipant(sessionToken, { status: 'completed', signerName: 'Replay Target' });

    const verified = await verify(buffer);
    expect(verified.body.transactionId).toBe(sessionToken);

    // The session token resolves a SESSION but never a PARTICIPANT (it is not
    // a row in signature_participant_tokens), so an anonymous caller replaying
    // it here must be refused exactly like any other non-participant.
    const replay = await anon().get(`/api/signing/${sessionToken}`);
    expect(replay.status).toBe(403);
  });

  it('cannot be used to download the document anonymously', async () => {
    const buffer = Buffer.from('transactionId replay: file route');
    const sessionToken = await seedSession(firm.id, { status: 'completed', signedHash: sha256(buffer) });
    await seedParticipant(sessionToken, { status: 'completed' });

    const replay = await anon().get(`/api/signing/${sessionToken}/file`);
    expect(replay.status).toBe(403);
  });

  it('does not resolve on the participant status poll', async () => {
    const buffer = Buffer.from('transactionId replay: status route');
    const sessionToken = await seedSession(firm.id, { status: 'completed', signedHash: sha256(buffer) });
    await seedParticipant(sessionToken, { status: 'completed' });

    // `getParticipantStatusByToken` joins through
    // `signature_participant_tokens`, a table the session token was never
    // written to. A session token that DID resolve here would let anyone
    // holding a finished document poll that document's session forever.
    const replay = await status(sessionToken);
    expect(replay.status).toBe(404);
  });

  it('cannot be used to query the cryptographic verification route anonymously', async () => {
    const buffer = Buffer.from('transactionId replay: verification route');
    const sessionToken = await seedSession(firm.id, { status: 'completed', signedHash: sha256(buffer) });
    await seedParticipant(sessionToken, { status: 'completed' });

    const replay = await anon().get(`/api/signing/${sessionToken}/verification`);
    expect(replay.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/signing/:token/status
// ---------------------------------------------------------------------------

describe('GET /:token/status: a live token', () => {
  it('reports each participant their own status against the shared totals', async () => {
    const sessionToken = await seedSession(firm.id, { status: 'in_progress' });
    const first = await seedParticipant(sessionToken, { order: 1, status: 'completed' });
    const second = await seedParticipant(sessionToken, { order: 2, status: 'active' });

    const firstPoll = await status(first.publicToken);
    const secondPoll = await status(second.publicToken);

    expect(firstPoll.status).toBe(200);
    expect(firstPoll.body).toEqual({
      sessionStatus: 'in_progress', participantStatus: 'completed',
      totalParticipants: 2, completedParticipants: 1,
    });
    // Same session, same totals, but each token reports its OWN participant's
    // status - a poll that returned the same participantStatus for both
    // tokens would tell the second signer they were done before they signed.
    expect(secondPoll.body).toMatchObject({ participantStatus: 'active', totalParticipants: 2, completedParticipants: 1 });
  });

  it('returns EXACTLY the four documented fields', async () => {
    const sessionToken = await seedSession(firm.id, { status: 'pending' });
    const { publicToken } = await seedParticipant(sessionToken, { status: 'active', name: 'Confidential Name' });

    const res = await status(publicToken);

    // No name, no email, no firm id - this route is public and unauthenticated
    // by design, so the ONLY thing it may ever say is aggregate progress.
    expect(Object.keys(res.body).sort()).toEqual(
      ['completedParticipants', 'participantStatus', 'sessionStatus', 'totalParticipants'].sort(),
    );
    expect(JSON.stringify(res.body)).not.toContain('Confidential Name');
    expect(JSON.stringify(res.body)).not.toContain(firm.id);
  });
});

describe('GET /:token: a sequential signer whose turn has not arrived', () => {
  it('reports the waiting state without handing over the editable document surface', async () => {
    const sessionToken = await seedSession(firm.id, { status: 'in_progress' });
    await seedParticipant(sessionToken, { order: 1, status: 'active', name: 'Ada First' });
    const waiting = await seedParticipant(sessionToken, { order: 2, status: 'waiting', name: 'Bo Second' });
    await testPool.query(
      `insert into signature_fields
         (id, session_id, law_firm_id, signer_id, page, x_percent, y_percent, width_percent,
          height_percent, field_type, label, required, sort_order)
       values ($1, ${sessionKeysSql('$2')}, $3, 1, 10, 10, 20, 5, 'signature', 'Bo signature', true, 0)`,
      [`field-${randomUUID().slice(0, 12)}`, sessionToken, waiting.participantId],
    );

    const res = await anon().get(`/api/signing/${waiting.publicToken}`);

    // Possessing the later signer's public link is enough to learn that the
    // request exists and that it is waiting, but not enough to obtain a
    // working-copy path or fields before their sequential turn is active.
    // `/complete` already rejects this state; this pins the separate read
    // boundary that would otherwise expose an editable document first.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'in_progress',
      participantStatus: 'waiting',
      participantName: 'Bo Second',
      fields: [],
    });
    expect(res.body).not.toHaveProperty('objectPath');
    expect(res.body).not.toHaveProperty('lawFirmId');
    expect(JSON.stringify(res.body)).not.toContain('Bo signature');

    // The view audit is deliberately asynchronous in the route. Let it finish
    // while this fixture still exists instead of racing the harness teardown.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});

describe('GET /:token/status: refusals', () => {
  it('answers not-found for a token nobody issued', async () => {
    const res = await status(`pub-${randomUUID()}`);

    expect(res.status).toBe(404);
  });

  it('answers a spent link that never completed with not-found', async () => {
    const sessionToken = await seedSession(firm.id, { status: 'cancelled' });
    const { publicToken } = await seedParticipant(sessionToken, { status: 'declined', consumed: true });

    // A token can be spent without its signer completing: they declined, or the
    // session was cancelled underneath them. The poll runs on every page load,
    // so a link like that kept answering would keep reporting a session's
    // progress to whoever holds the old URL.
    const res = await status(publicToken);
    expect(res.status).toBe(404);
  });

  it('answers a signer polling their OWN completed turn', async () => {
    const sessionToken = await seedSession(firm.id, { status: 'in_progress' });
    const { publicToken } = await seedParticipant(sessionToken, { status: 'completed', consumed: true });

    // Completing a turn consumes the token that would carry the poll, and the
    // signer still has to watch for the executed document being produced. This
    // discloses nothing `GET /:token` does not: that route already answers a
    // consumed, completed token with `alreadySigned` and the file name.
    const res = await status(publicToken);

    expect(res.status).toBe(200);
    expect(res.body.participantStatus).toBe('completed');
    expect(res.body.sessionStatus).toBe('in_progress');
  });

  it('does not distinguish "never existed" from "belongs to another firm" in its response', async () => {
    const other = await createFirm({ name: 'Rival Firm LLP' });
    const sessionToken = await seedSession(other.id, { status: 'in_progress' });
    const { publicToken } = await seedParticipant(sessionToken, { status: 'active' });

    // Not a refusal case - the opposite. This route has no firm scoping at
    // all (by design: a signer holds no firm identity), so a genuine token
    // from another firm succeeds exactly like one from this test's own firm
    // would, and must still disclose nothing beyond the four counters.
    const res = await status(publicToken);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['completedParticipants', 'participantStatus', 'sessionStatus', 'totalParticipants'].sort(),
    );
  });
});
