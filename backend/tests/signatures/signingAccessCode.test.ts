/**
 * The access-code gate on a signing link, and the brute-force controls behind it.
 *
 * `signing.routes.ts` is the largest uncovered file in the backend (833
 * statements). `signingAccess.test.ts` already covers WHO may reach a session
 * and what state permits what. Nothing covered the gate itself: the six-digit
 * code a firm puts on a link so that possession of the URL is not enough.
 *
 * That gate is the only secret protecting an executed legal document from
 * anyone who obtains a forwarded link, so its guessing controls are the point of
 * this file. There are two of them and they are deliberately different:
 *
 *   THE SOFT LOCK fires every fifth failure and holds for 60 seconds. It is a
 *   speed limit. Waiting it out returns the signer to a working link, because a
 *   real signer who mistypes a code five times is a support ticket, not an
 *   attacker.
 *
 *   THE HARD CAP is cumulative and NOT resettable by waiting. It counts every
 *   failure the link has ever seen in `access_code_lifetime_attempts` and locks
 *   the gate outright at twenty. Without it the soft lock alone is only a
 *   throttle: an attacker sleeps 60 seconds between batches of five and works
 *   through a six-digit space unimpeded.
 *
 * The property that makes the hard cap worth anything is that clearing the SOFT
 * counters does not clear it. Several cases below exist only to pin that.
 *
 * Sessions are seeded with SQL, for the reason given in `signingAccess.test.ts`:
 * the harness's GCS mock is inert, so a fixture routed through the real upload
 * would be testing the mock rather than the gate. Seeding also puts the attempt
 * counters at an exact value, which is what these rules are about.
 *
 * The in-process harness sets RATE_LIMITS_DISABLED, so `signingGateLimiter`
 * (5/min, keyed on the token) is inert here and the counters exercised below are
 * the durable ones on the participant row. That is the layer that matters: the
 * limiter is an in-front throttle that a distributed caller degrades, and the
 * comment on it in `rateLimiters.ts` says as much.
 */
import {
  testPool,
  createFirm,
  ownerOf,
  as,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import {
  seedSigningSession, seedSigningParticipant, sha256, type SigningChallengeSeed,
} from '../support/signing';

/** Mirrors GATE_SOFT_ATTEMPT_LIMIT / GATE_HARD_ATTEMPT_CAP in signing.routes.ts. */
const SOFT_LIMIT = 5;
const HARD_CAP = 20;

const CODE = '482913';
const WRONG = '000000';

let firm: Firm;
let owner: Actor;

/** A signer arrives carrying no credentials at all. */
const signer = () => as('');

type SeedOptions = {
  code?: string | null;
  verified?: boolean;
  attempts?: number;
  lifetimeAttempts?: number;
  lockedUntil?: string | null;
  expiresAt?: string;
  status?: string;
};

/**
 * Seed a v2 session with one participant and return that participant's PUBLIC
 * token, which is what a signer actually holds.
 *
 * The public token is the participant's, not the session's. A v2 session
 * resolved by its session token has no participant attached
 * (`resolveSigningContext` only matches a participant by public token), and the
 * gate refuses a request with no participant. So seeding the token row is not
 * incidental setup: without it the route answers 403 and every case below would
 * be asserting against the wrong branch.
 */
async function seedSession(options: SeedOptions = {}) {
  const code = options.code === undefined ? CODE : options.code;
  const { sessionToken, participants: [signer] } = await seedSigningSession({
    lawFirmId: firm.id,
    createdBy: owner.uid,
    session: {
      status: options.status ?? 'pending',
      object_path: 'firms/seed/agreement.pdf',
      ...(options.expiresAt ? { expires_at: options.expiresAt } : {}),
    },
    participants: [{
      name: 'Signer One',
      email: 'signer@example.test',
      roleLabel: null,
      challenge: accessCodeChallenge(code, options),
    }],
  });
  return { sessionToken, participantId: signer.participantId, publicToken: signer.publicToken };
}

const gate = (publicToken: string, code: unknown) =>
  signer().post(`/api/signing/${publicToken}/verify-access-code`).send({ code });

/**
 * The access-code gate for a participant, or none. The gate is a
 * `signature_challenges` row, not columns on the participant, so a participant
 * with no code and no counters has no row at all.
 */
function accessCodeChallenge(code: string | null, options: SeedOptions = {}): SigningChallengeSeed | undefined {
  const hasState = code !== null || options.verified || options.attempts
    || options.lifetimeAttempts || options.lockedUntil;
  if (!hasState) return undefined;
  return {
    secretHash: code === null ? null : sha256(code),
    attempts: options.attempts ?? 0,
    lifetimeAttempts: options.lifetimeAttempts ?? 0,
    lockedUntil: options.lockedUntil ?? null,
    verifiedAt: options.verified ? new Date().toISOString() : null,
  };
}

const participantRow = async (participantId: string) => {
  const { rows } = await testPool.query(
    `select (c.verified_at is not null) as verified,
            coalesce(c.attempts, 0) as attempts,
            coalesce(c.lifetime_attempts, 0) as lifetime,
            c.locked_until as locked_until
       from signature_participants p
       left join signature_challenges c
         on c.participant_id = p.id and c.kind = 'access_code'
      where p.id = $1`,
    [participantId],
  );
  return rows[0];
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

describe('getting through the gate', () => {
  it('accepts the correct code and records the participant as verified', async () => {
    const { publicToken, participantId } = await seedSession();

    const res = await gate(publicToken, CODE);

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    // Asserting the stored flag, not only the response. The response is what the
    // signer's browser reads; this column is what every LATER request on the
    // link is checked against. A gate that answered 200 without writing it
    // would send the signer straight back to the code prompt on the next page.
    expect((await participantRow(participantId)).verified).toBe(true);
  });

  it('refuses a wrong code without marking the participant verified', async () => {
    const { publicToken, participantId } = await seedSession();

    const res = await gate(publicToken, WRONG);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/incorrect access code/i);
    expect((await participantRow(participantId)).verified).toBe(false);
  });

  it('refuses a code that differs only in a single digit', async () => {
    const { publicToken } = await seedSession({ code: '482913' });

    // The comparison is over SHA-256 digests, so this cannot pass by prefix or
    // by coercion. The case is here because a near-miss is what a mistyping
    // signer and a walking attacker both actually send.
    expect((await gate(publicToken, '482914')).status).toBe(400);
  });

  it('refuses a code with surrounding whitespace', async () => {
    const { publicToken } = await seedSession();

    // Characterises the exact-match rule: the route hashes the submitted string
    // as given and does not trim. A signer who pastes the code with a trailing
    // space is refused, and this test goes red if someone adds trimming, which
    // would be a reasonable product change but is a change.
    expect((await gate(publicToken, ` ${CODE} `)).status).toBe(400);
  });

  it('reports how many attempts remain', async () => {
    const { publicToken } = await seedSession();

    const res = await gate(publicToken, WRONG);

    // Four of five. The number is shown to the signer, so it is the difference
    // between "you have room to try again" and a surprise lockout.
    expect(res.body.attemptsRemaining).toBe(SOFT_LIMIT - 1);
  });

  it('counts the remaining attempts DOWN across tries', async () => {
    const { publicToken } = await seedSession();

    const first = await gate(publicToken, WRONG);
    const second = await gate(publicToken, WRONG);
    const third = await gate(publicToken, WRONG);

    // A counter that reported a constant 4 would satisfy the case above. This
    // one needs the attempts to actually accumulate on the participant row.
    expect([first.body.attemptsRemaining, second.body.attemptsRemaining, third.body.attemptsRemaining])
      .toEqual([4, 3, 2]);
  });

  it('clears the failure history when the right code finally arrives', async () => {
    const { publicToken, participantId } = await seedSession();
    await gate(publicToken, WRONG);
    await gate(publicToken, WRONG);
    const before = await participantRow(participantId);

    await gate(publicToken, CODE);

    // Both counters are zeroed, the lifetime one included. Safe, because a
    // caller who produced the code has already passed the control the counters
    // exist to enforce; and necessary, or a signer who mistyped nineteen times
    // over a week would sit one failure from a permanent lock forever.
    //
    // The before-state is asserted so this is not vacuous against a seed that
    // never incremented.
    expect(Number(before.lifetime)).toBe(2);
    const after = await participantRow(participantId);
    expect(Number(after.attempts)).toBe(0);
    expect(Number(after.lifetime)).toBe(0);
    expect(after.locked_until).toBeNull();
  });
});

describe('the soft lock', () => {
  it('locks on the fifth failure', async () => {
    const { publicToken } = await seedSession({ attempts: SOFT_LIMIT - 1, lifetimeAttempts: SOFT_LIMIT - 1 });

    const res = await gate(publicToken, WRONG);

    expect(res.status).toBe(429);
    expect(res.body.lockedSeconds).toBe(60);
  });

  it('does NOT lock on the fourth', async () => {
    const { publicToken } = await seedSession({ attempts: SOFT_LIMIT - 2, lifetimeAttempts: SOFT_LIMIT - 2 });

    // The boundary from below. Without it, a lock that fired one attempt early
    // would satisfy the case above and cut a legitimate signer off a try sooner
    // than the interface promised them.
    expect((await gate(publicToken, WRONG)).status).toBe(400);
  });

  it('refuses the CORRECT code while the lock is holding, and does not verify', async () => {
    const { publicToken, participantId } = await seedSession({
      attempts: SOFT_LIMIT,
      lifetimeAttempts: SOFT_LIMIT,
      lockedUntil: new Date(Date.now() + 60_000).toISOString(),
    });

    const res = await gate(publicToken, CODE);

    // The whole value of a lock is that it gates BEFORE the comparison. If the
    // route compared first and only then checked the lock, an attacker would
    // learn the moment they guessed right and the lock would be decoration.
    expect(res.status).toBe(429);
    expect(res.body.lockedSeconds).toBeGreaterThan(0);
    // The same thing stated as state rather than status: a 429 that had already
    // written the flag would be a bypass.
    expect((await participantRow(participantId)).verified).toBe(false);
  });

  it('lets the signer through once the lock has EXPIRED', async () => {
    const { publicToken } = await seedSession({
      attempts: SOFT_LIMIT,
      lifetimeAttempts: SOFT_LIMIT,
      lockedUntil: new Date(Date.now() - 1_000).toISOString(),
    });

    // A soft lock is a speed limit, not a ban. A stale `lockedUntil` left in
    // place would strand a signer who waited exactly as instructed.
    expect((await gate(publicToken, CODE)).status).toBe(200);
  });
});

describe('the hard cap', () => {
  it('locks the link outright at the cap', async () => {
    const { publicToken } = await seedSession({ lifetimeAttempts: HARD_CAP });

    const res = await gate(publicToken, WRONG);

    expect(res.status).toBe(429);
    expect(res.body.locked).toBe(true);
    expect(res.body.error).toMatch(/request a new signing link/i);
  });

  it('does NOT lock on the NINETEENTH failure', async () => {
    const { publicToken } = await seedSession({ lifetimeAttempts: HARD_CAP - 2 });

    // The boundary from below, so an off-by-one that locked at nineteen cannot
    // hide behind the case above. Seeded at eighteen: this request is the
    // nineteenth failure and must still be answered as an ordinary wrong code.
    //
    // My first draft seeded nineteen here and failed, correctly. Nineteen plus
    // this attempt IS twenty, so it was asserting that the cap does not fire at
    // the cap.
    const res = await gate(publicToken, WRONG);

    expect(res.status).toBe(400);
    expect(res.body.locked).toBeUndefined();
  });

  it('reaches the cap on the twentieth failure', async () => {
    const { publicToken } = await seedSession({ lifetimeAttempts: HARD_CAP - 1 });

    const res = await gate(publicToken, WRONG);

    // Seeded at nineteen and driven over the line through the real route, so
    // the increment and the cap check are exercised together rather than the
    // cap being read off a hand-placed number.
    expect(res.status).toBe(429);
    expect(res.body.locked).toBe(true);
  });

  it('stays locked when the SOFT counters are clear', async () => {
    const { publicToken } = await seedSession({
      attempts: 0,
      lifetimeAttempts: HARD_CAP,
      lockedUntil: null,
    });

    // Nothing here is soft-locked: no `lockedUntil`, and the resettable
    // attempts counter reads zero. That is exactly the state an attacker is in
    // after sleeping out a 60-second lock, and the link must still be dead.
    //
    // Scope, stated plainly because I checked: this case pins the ANSWER, not
    // which counter produced it. Point the pre-check at the resettable
    // `attempts` counter and it still passes, because `recordGateFailure`
    // re-derives `hardCapped` from the lifetime counter after incrementing and
    // returns the same 429. The case that catches that mutation is 'refuses the
    // CORRECT code once capped' below, where the difference is a real bypass
    // rather than a different route to the same status.
    const res = await gate(publicToken, WRONG);

    expect(res.status).toBe(429);
    expect(res.body.locked).toBe(true);
  });

  it('refuses the CORRECT code once capped', async () => {
    const { publicToken, participantId } = await seedSession({ lifetimeAttempts: HARD_CAP });

    const res = await gate(publicToken, CODE);

    // Checked before the comparison, like the soft lock. A capped link is dead
    // until the firm reissues it, and a caller who happened to guess correctly
    // on attempt twenty-one must not be told so.
    //
    // This is the case that actually pins the cap to the NON-RESETTABLE
    // counter. Every other hard-cap case here is also satisfied by a gate that
    // reads the resettable `attempts` instead, because a wrong code reaches
    // `recordGateFailure` and gets locked on the way out anyway. A CORRECT code
    // does not: it skips that path entirely, so a gate reading the wrong
    // counter verifies the participant and the cap is bypassed outright.
    expect(res.status).toBe(429);
    expect((await participantRow(participantId)).verified).toBe(false);
  });

  it('does not spend an attempt when it refuses a capped link', async () => {
    const { publicToken, participantId } = await seedSession({ lifetimeAttempts: HARD_CAP });

    await gate(publicToken, WRONG);

    // The cap returns before `recordGateFailure`, so a locked link cannot be
    // driven further. Without this, an attacker could keep incrementing a
    // counter on every request and the row would be a free write amplifier.
    expect(Number((await participantRow(participantId)).lifetime)).toBe(HARD_CAP);
  });
});

describe('one participant does not lock another', () => {
  it('keeps the attempt counters separate', async () => {
    const first = await seedSession();
    const { participantId: secondId } = await seedSigningParticipant({ sessionToken: first.sessionToken }, {
      name: 'Signer Two',
      email: 'two@example.test',
      roleLabel: null,
      order: 2,
      status: 'waiting',
      challenge: accessCodeChallenge(CODE),
    });

    await gate(first.publicToken, WRONG);
    await gate(first.publicToken, WRONG);

    // `recordGateFailure` targets the participant ROW for a v2 session. If it
    // wrote to the session instead, one signer fumbling their code would lock
    // out every other signer on the same document, and the firm would see a
    // stalled signing with no explanation.
    expect(Number((await participantRow(first.participantId)).lifetime)).toBe(2);
    expect(Number((await participantRow(secondId)).lifetime)).toBe(0);
  });
});

describe('what the gate refuses to even consider', () => {
  it('rejects a request with no code without spending an attempt', async () => {
    const { publicToken, participantId } = await seedSession();

    const res = await signer().post(`/api/signing/${publicToken}/verify-access-code`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
    // A malformed request is not a guess. Counting it would let anyone burn a
    // signer's five attempts without knowing anything about the code.
    expect(Number((await participantRow(participantId)).lifetime)).toBe(0);
  });

  it('rejects a non-string code', async () => {
    const { publicToken } = await seedSession();

    // 482913 as a NUMBER is the same digits the correct code has. It must not
    // pass: `crypto.update` would throw on it rather than hash it, and a route
    // that coerced instead would be accepting a type the client never sends.
    const res = await gate(publicToken, 482913);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('answers not-found for a token that does not exist', async () => {
    const res = await gate('pub-does-not-exist', CODE);

    expect(res.status).toBe(404);
  });

  it('answers GONE for an expired link', async () => {
    const { publicToken } = await seedSession({
      expiresAt: new Date(Date.now() - 86400_000).toISOString(),
    });

    const res = await gate(publicToken, CODE);

    // 410 rather than 404, because the distinction is actionable: the signer
    // should ask the firm for a new link rather than conclude the document
    // never existed.
    expect(res.status).toBe(410);
  });

  it('checks expiry BEFORE the code', async () => {
    const { publicToken, participantId } = await seedSession({
      expiresAt: new Date(Date.now() - 86400_000).toISOString(),
    });

    const res = await gate(publicToken, WRONG);

    // A wrong code on an expired link is 410, not 400. Ordering it the other
    // way would leave an expired link answering "incorrect access code", which
    // tells a caller the link is still live and worth guessing at.
    expect(res.status).toBe(410);
    expect(Number((await participantRow(participantId)).lifetime)).toBe(0);
  });

  it('rejects a session that has no access code at all', async () => {
    const { publicToken } = await seedSession({ code: null });

    const res = await gate(publicToken, CODE);

    // Not 200. A link with no code is opened by holding the URL, and answering
    // "verified" here would let a caller manufacture a verified state on a
    // participant the firm never gated.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not require/i);
  });

  it('CHARACTERISATION: an already-verified participant passes with ANY code', async () => {
    const { publicToken } = await seedSession({ verified: true });

    const res = await gate(publicToken, WRONG);

    // 200. The route returns early on `accessCodeVerified` before comparing, so
    // a wrong code answers the same as the right one.
    //
    // Recorded rather than changed. The check is idempotent by design: a signer
    // who reloads the page mid-signing must not be re-prompted, and the caller
    // has already proved possession of the code once. Nothing is granted here
    // that the verified flag did not already grant. This goes red if someone
    // makes the gate re-compare, which would be a real behaviour change.
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
  });

  // B02.2 A14: every other stateful action on a v2 session -- /complete,
  // /decline, /cancel itself -- explicitly checks `data.status === 'cancelled'`
  // right after the expiry check and refuses (see signing.routes.ts around
  // lines 1308, 1836, 2183). This route checked expiry but never cancellation,
  // so a still-valid participant link could clear the access-code gate (and
  // set access_code_verified = true in storage) on a session the firm had
  // already terminated. `/complete` still refuses to actually finish signing a
  // cancelled session, so this could not forge a signature, but it let a link
  // holder pass a security control on a resource that should be entirely
  // inert, which is inconsistent with the checked-everywhere-else contract.
  it('answers CONFLICT for a cancelled session and does not verify even with the correct code', async () => {
    const { publicToken, participantId } = await seedSession({ status: 'cancelled' });

    const res = await gate(publicToken, CODE);

    expect(res.status).toBe(409);
    expect((await participantRow(participantId)).verified).toBe(false);
  });

  it('checks cancellation BEFORE the code, so a wrong code on a cancelled link is not "incorrect access code"', async () => {
    const { publicToken, participantId } = await seedSession({ status: 'cancelled' });

    const res = await gate(publicToken, WRONG);

    // Same ordering rationale as the expiry checks above: answering 400 here
    // would tell a caller the link is still live and worth guessing at, and
    // would spend an attempt against a session nothing can still be done to.
    expect(res.status).toBe(409);
    expect(Number((await participantRow(participantId)).lifetime)).toBe(0);
  });
});
