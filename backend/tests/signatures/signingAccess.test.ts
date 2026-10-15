/**
 * Who may reach a signing session, and what state permits what.
 *
 * `signing.routes.ts` was at 7% and it is the most exposed surface in the
 * product: `/api/signing/:token` is reachable without a login, because a signer
 * is often not a user of the system at all. What sits behind it is an executed
 * legal document.
 *
 * So this file is deliberately about ACCESS and STATE rather than about the
 * signing mechanics. The existing specs in this folder
 * (`signatureLayout`, `textFit`, `signingArchive`) already
 * cover how a signature is placed and sealed. Nothing covered who is allowed to
 * ask.
 *
 * Sessions are seeded with SQL rather than created through the upload route. The
 * harness's GCS mock is inert by design, so a fixture that went through the real
 * upload would be testing the mock. Seeding puts a session in an exact, known
 * state, which is what these rules are about.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createOrgClient,
  createPersonClient,
  createPortalUser,
  linkPersonToOrg,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { sessionIdSql } from '../support/factories';
import { seedSigningSession } from '../support/signing';

let firm: Firm;
let owner: Actor;
/** A firm with no connection to the session, used for every cross-firm case. */
let otherFirm: Firm;
let otherOwner: Actor;
let token: string;

/** A caller carrying no credentials at all, which is how a signer arrives. */
const anonymous = () => as('');

const signing = (suffix = '') => `/api/signing/${token}${suffix}`;

async function seedSession(overrides: Record<string, string | null> = {}) {
  const value = `tok-${Math.random().toString(36).slice(2, 12)}`;
  await seedSigningSession({
    lawFirmId: firm.id,
    createdBy: owner.uid,
    token: value,
    session: { status: overrides.status ?? 'pending', object_path: 'firms/seed/agreement.pdf' },
    participants: [{
      id: `p-${value}`, name: 'Signer One', email: 'signer@example.test', roleLabel: null, token: false,
    }],
  });
  return value;
}

/** Move the seeded session to completed, with the sealed artefacts a real one has. */
async function markCompleted() {
  await testPool.query(
    `update signature_sessions
        set status = 'completed', completed_at = now(),
            signed_object_path = 'firms/seed/signed.pdf',
            signed_document_hash = 'deadbeefdeadbeef'
      where token = $1`,
    [token],
  );
}

const sessionStatus = async () => {
  const { rows } = await testPool.query(
    'select status from signature_sessions where token = $1', [token],
  );
  return rows[0]?.status;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  otherFirm = await createFirm();
  otherOwner = await ownerOf(otherFirm.id);
  token = await seedSession();
  await drainEvents();
});

describe('holding the token is not enough', () => {
  it('refuses an anonymous caller the session itself', async () => {
    const res = await anonymous().get(signing());

    // The session carries the document, the signer list and the field layout. A
    // link forwarded in an email must not open all of that to whoever receives
    // it; the participant still has to prove who they are.
    expect(res.status).toBe(403);
  });

  it('refuses an anonymous caller the document', async () => {
    const res = await anonymous().get(signing('/file'));

    expect(res.status).toBe(403);
  });

  it('refuses an anonymous caller the decline action, and leaves the session untouched', async () => {
    const res = await anonymous().post(signing('/decline')).send({ reason: 'No thanks' });

    // Declining ends the signing. Anyone who saw the link could otherwise kill
    // an agreement the parties were in the middle of executing.
    expect(res.status).toBe(403);
    // Asserting the STATE. A route that refused after already writing would
    // satisfy the status check and still have ended the signing.
    expect(await sessionStatus()).toBe('pending');
  });

  it('answers not-found for a token that does not exist', async () => {
    const res = await anonymous().get('/api/signing/tok-does-not-exist');

    expect(res.status).toBe(404);
  });
});

describe('an organization person assigned to a signing session', () => {
  it('can open the session through their portal identity, and keeps an assigned signing session after organization removal', async () => {
    const portal = await createPortalUser();
    const person = await createPersonClient(firm.id, {
      name: 'Organization Signer',
      userId: portal.uid,
      email: 'organization-signer@example.test',
    });
    const organization = await createOrgClient(firm.id, { name: 'Northwind Holdings' });
    await linkPersonToOrg(firm.id, person.id, organization.id, { canViewBilling: false });
    await testPool.query(
      `update signature_participants
          set client_user_id = $1, delivery_method = 'portal'
        where session_id = ${sessionIdSql('$2')}`,
      [portal.uid, token],
    );

    const before = await as(tokenFor({ uid: portal.uid })).get(signing());

    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      participantName: 'Signer One',
      participantDeliveryMethod: 'portal',
    });

    const link = await testPool.query(
      `select id from client_company_links
        where law_firm_id = $1 and person_client_id = $2 and company_client_id = $3`,
      [firm.id, person.id, organization.id],
    );
    const removed = await owner.api.delete(
      `/api/lawfirms/${firm.id}/clients/${organization.id}/contacts/${link.rows[0].id}`,
    );
    expect(removed.status).toBe(200);

    const after = await as(tokenFor({ uid: portal.uid })).get(signing());

    // Signing is assigned to the person's own client identity, not to the
    // organization relationship. Removing the roster link revokes organization
    // portal surfaces, but it does not silently cancel a legal document already
    // sent to that person. Keep this explicit until product policy changes.
    expect(after.status).toBe(200);
    expect(after.body.participantDeliveryMethod).toBe('portal');
  });
});

describe('another firm gets nothing', () => {
  it('cannot read the audit trail', async () => {
    const res = await otherOwner.api.get(signing('/audit'));

    // The audit trail names the signers, their email addresses, and every view
    // and action with timestamps. It is the record that proves the document was
    // executed, and it belongs to one firm.
    expect(res.status).toBe(403);
  });

  it('cannot download the document', async () => {
    const res = await otherOwner.api.get(signing('/file'));

    expect(res.status).toBe(403);
  });

  it('cannot cancel the session', async () => {
    const res = await otherOwner.api.post(signing('/cancel')).send({});

    expect(res.status).toBe(403);
    expect(await sessionStatus()).toBe('pending');
  });

  it('cannot download the SIGNED document once it exists', async () => {
    await markCompleted();

    const res = await otherOwner.api.get(signing('/signed-document'));

    // Checked against a COMPLETED session on purpose. While the session is
    // pending this route answers 400 on a state check that runs before
    // authorization, so a pending fixture would pass whether the authorization
    // check existed or not. Completing it removes the state gate and leaves only
    // the access rule standing.
    expect(res.status).toBe(403);
  });

  it('cannot download the certificate once it exists', async () => {
    await markCompleted();

    const res = await otherOwner.api.get(signing('/certificate'));

    // Same reasoning as the signed document above. The certificate is the page
    // that evidences who signed and when.
    expect(res.status).toBe(403);
  });

  it('cannot read the audit trail of a completed session either', async () => {
    await markCompleted();

    const res = await otherOwner.api.get(signing('/audit'));

    expect(res.status).toBe(403);
  });
});

describe('the firm that owns the session', () => {
  it('can cancel it', async () => {
    const res = await owner.api.post(signing('/cancel')).send({});

    // The positive half of every refusal above. A gate that refused everyone
    // would satisfy all of them while making the feature unusable.
    expect(res.status).toBe(200);
    expect(await sessionStatus()).toBe('cancelled');
  });

  it('can read the audit trail', async () => {
    const res = await owner.api.get(signing('/audit'));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Engagement Agreement.pdf');
  });

  it('can still read the audit trail after cancelling', async () => {
    await owner.api.post(signing('/cancel')).send({});

    const res = await owner.api.get(signing('/audit'));

    // A cancelled session is still a record of an attempted execution. Losing
    // the audit on cancel would destroy the evidence that it happened.
    expect(res.status).toBe(200);
  });
});

describe('state decides what is allowed', () => {
  it('refuses to cancel a COMPLETED session', async () => {
    await markCompleted();

    const res = await owner.api.post(signing('/cancel')).send({});

    // The document is executed. Cancelling it afterwards would put a signed
    // agreement into a state that says it was never completed.
    expect(res.status).toBe(409);
    expect(await sessionStatus()).toBe('completed');
  });

  it('refuses the signed document before signing is complete', async () => {
    const res = await owner.api.get(signing('/signed-document'));

    // There is nothing to serve yet, and answering with the unsigned original
    // would hand out a document that looks executed and is not.
    expect(res.status).toBe(400);
  });

  it('refuses the certificate before signing is complete', async () => {
    const res = await owner.api.get(signing('/certificate'));

    // A certificate for an unfinished session would attest to signatures that
    // do not exist.
    expect(res.status).toBe(400);
  });


});

describe('firm members', () => {
  it('refuses a member of the firm who lacks the signing permission', async () => {
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi.post(signing('/cancel')).send({});

    // Being inside the firm is not the same as being allowed to end an
    // execution in progress.
    expect(res.status).toBe(403);
    expect(await sessionStatus()).toBe('pending');
  });
});
