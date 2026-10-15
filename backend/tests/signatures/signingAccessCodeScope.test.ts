/**
 * How far a verified access code reaches, and where it must stop.
 *
 * `signingAccessCode.test.ts` records that an already-verified participant
 * passes the gate with any code, and reasons that the check is idempotent by
 * design: a signer who reloads mid-signing must not be re-prompted.
 *
 * That is true, and it is not the whole story. The gate's verified stamp is a
 * column on the PARTICIPANT ROW, not on a browser session, so the verified state
 * is durable and belongs to the link rather than to whoever cleared the gate.
 * The consequence, which no test stated: the code is a ONE-TIME gate. Once the
 * legitimate signer enters it, the URL alone is sufficient forever, for anyone
 * who obtains it afterwards.
 *
 * Whether that is the right tradeoff is a product decision and is not changed
 * here. What this file does is make the blast radius explicit, so the decision
 * is made with it visible, and pin the boundary that must hold regardless: one
 * participant clearing the gate must never clear it for another.
 *
 * If the boundary case in this file ever goes red, that is a cross-signer
 * disclosure of an executed legal document, not a test to update.
 */
import {
  testPool,
  createFirm,
  ownerOf,
  as,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedSigningSession, sha256 } from '../support/signing';

const CODE_A = '482913';
const CODE_B = '735104';
const WRONG = '000000';

/** A signer arrives carrying no credentials at all. */
const signer = () => as('');

let firm: Firm;
let owner: Actor;

/**
 * A session with TWO participants, each with their own code and public token.
 * Two is the minimum that can show a boundary; the sibling file uses one.
 */
async function seedTwoSignerSession() {
  // The gate is a `signature_challenges` row, one per participant per kind.
  // Separate rows are what keeps one signer's failures off another's counter,
  // which is what this spec is about.
  const codes = [CODE_A, CODE_B];
  const { sessionToken, participants } = await seedSigningSession({
    lawFirmId: firm.id,
    createdBy: owner.uid,
    session: { object_path: 'firms/seed/agreement.pdf' },
    participants: codes.map((code, index) => ({
      email: `signer${index + 1}@example.test`, roleLabel: null, challenge: { secretHash: sha256(code) },
    })),
  });

  return {
    sessionToken,
    participants: participants.map((p, index) => ({
      participantId: p.participantId, publicToken: p.publicToken, code: codes[index],
    })),
  };
}

const gate = (publicToken: string, code: unknown) =>
  signer().post(`/api/signing/${publicToken}/verify-access-code`).send({ code });

const openSession = (publicToken: string) =>
  signer().get(`/api/signing/${publicToken}`);

const rowOf = async (participantId: string) => {
  const { rows } = await testPool.query(
    `select (c.verified_at is not null) as verified,
            coalesce(c.attempts, 0) as attempts,
            coalesce(c.lifetime_attempts, 0) as lifetime
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

describe('the boundary that must hold: one signer clearing the gate clears only their own', () => {
  it('leaves the other participant still gated, with their counters untouched', async () => {
    const { participants } = await seedTwoSignerSession();
    const [first, second] = participants;

    expect((await gate(first.publicToken, first.code)).status).toBe(200);

    // The other signer's link is unchanged. If this ever passes with the first
    // signer's code, or without a code, two parties to one agreement can read
    // each other's signing surface.
    const wrongCodeForSecond = await gate(second.publicToken, first.code);
    // 400 with the same wording any wrong code gets. Notably NOT a distinct
    // status or message for "that is another signer's code", which would tell a
    // caller they had guessed a real code from the same agreement.
    expect(wrongCodeForSecond.status).toBe(400);
    expect(wrongCodeForSecond.body.error).toMatch(/incorrect access code/i);

    const secondRow = await rowOf(second.participantId);
    expect(secondRow.verified).toBe(false);
  });

  it('still hides the document from the other participant', async () => {
    // The disclosure question, asked of the surface rather than the gate. Before
    // the code is cleared the route returns only what the code-entry screen
    // needs, so the file name and the signer names must not appear.
    const { participants } = await seedTwoSignerSession();
    const [first, second] = participants;

    await gate(first.publicToken, first.code);

    const res = await openSession(second.publicToken);

    expect(res.status).toBe(200);
    expect(res.body.accessCodeVerified).toBe(false);
    expect(res.body.requiresAccessCode).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/Engagement Agreement/);
    expect(JSON.stringify(res.body)).not.toMatch(/Signer 1/);
  });

  it('opens the document to the signer who DID clear the gate', async () => {
    // The positive control. Without it, a route that hid the document from
    // everyone would satisfy both cases above.
    const { participants } = await seedTwoSignerSession();
    const [first] = participants;

    await gate(first.publicToken, first.code);
    const res = await openSession(first.publicToken);

    expect(res.status).toBe(200);
    expect(res.body.accessCodeVerified).toBe(true);
    expect(JSON.stringify(res.body)).toMatch(/Engagement Agreement/);
  });
});

describe('the blast radius: verification belongs to the link, not to the browser', () => {
  it('lets a SECOND, independent caller in with no code at all once the signer has verified', async () => {
    // This is the fact the sibling file's characterisation implies and does not
    // state. The verified stamp is a durable column on the gate row,
    // so there is nothing browser-bound about it: a fresh request carrying no
    // cookie, no header and no code reaches the document.
    //
    // The code therefore protects the link ONCE. A forwarded url after the
    // signer has opened it is enough.
    const { participants } = await seedTwoSignerSession();
    const [first] = participants;

    await gate(first.publicToken, first.code);

    // A different agent instance: no shared state of any kind with the request
    // that cleared the gate.
    const forwarded = await signer().get(`/api/signing/${first.publicToken}`);

    expect(forwarded.status).toBe(200);
    expect(forwarded.body.accessCodeVerified).toBe(true);
    expect(JSON.stringify(forwarded.body)).toMatch(/Engagement Agreement/);
  });

  it('freezes the guessing counters once verified, because the gate returns early', async () => {
    // A consequence worth knowing before relying on the lifetime cap: a wrong
    // code against a VERIFIED participant does not increment anything, since the
    // route answers before comparing. The hard cap protects the window before
    // first verification, and only that window.
    const { participants } = await seedTwoSignerSession();
    const [first] = participants;

    await gate(first.publicToken, first.code);
    const before = await rowOf(first.participantId);

    await gate(first.publicToken, WRONG);
    await gate(first.publicToken, WRONG);

    const after = await rowOf(first.participantId);
    expect(after.attempts).toBe(before.attempts);
    expect(after.lifetime).toBe(before.lifetime);
  });

  it('does NOT freeze them before verification, which is the window the cap covers', async () => {
    // The other half, so the case above cannot be read as "counters never move".
    const { participants } = await seedTwoSignerSession();
    const [, second] = participants;

    await gate(second.publicToken, WRONG);
    const after = await rowOf(second.participantId);

    expect(after.lifetime).toBe(1);
    expect(after.verified).toBe(false);
  });
});

describe('a wrong code never manufactures a verified state', () => {
  it('leaves the participant unverified after a failed attempt', async () => {
    const { participants } = await seedTwoSignerSession();
    const [first] = participants;

    const res = await gate(first.publicToken, WRONG);

    expect(res.status).toBe(400);
    expect((await rowOf(first.participantId)).verified).toBe(false);

    // And the document stays closed.
    const res2 = await openSession(first.publicToken);
    expect(res2.body.accessCodeVerified).toBe(false);
    expect(JSON.stringify(res2.body)).not.toMatch(/Engagement Agreement/);
  });

  it('does not carry a verified participant across sessions', async () => {
    // Two separate agreements, same firm, same code value. Clearing one must
    // say nothing about the other.
    const a = await seedTwoSignerSession();
    const b = await seedTwoSignerSession();

    await gate(a.participants[0].publicToken, CODE_A);

    const other = await openSession(b.participants[0].publicToken);
    expect(other.body.accessCodeVerified).toBe(false);
    expect((await rowOf(b.participants[0].participantId)).verified).toBe(false);
  });
});
