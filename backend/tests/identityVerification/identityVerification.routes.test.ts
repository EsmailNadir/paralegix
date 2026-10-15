/**
 * Client identity verification, through the real portal and firm routes.
 *
 * The Credence client is replaced with a double, so these specs drive every
 * branch of the provider's answer without a network. Everything else is real:
 * the portal gate, the association resolver, the table, the audit entry and the
 * notification listener.
 *
 * WHAT MAKES THESE GO RED: a route that answers another firm or another client
 * (the first three blocks), a completion that can run twice or after expiry,
 * a persisted or echoed claim the design says to drop (portrait, license
 * number, the provider session id), or a name comparison that stops ignoring
 * accents, case and hyphens.
 */
import {
  createFirm,
  createOrgClient,
  createPortalUser,
  drainEvents,
  linkPersonToOrg,
  memberWith,
  ownerOf,
  stranger,
  testPool,
  tokenFor,
  as,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { portalPath, portalPerson, type PortalPerson } from '../clients/portalWorld';

const mockCredence = {
  configured: true,
  getDocRequest: jest.fn(),
  verifyDocRequest: jest.fn(),
  initiateOpenId4vp: jest.fn(),
  validateOpenId4vp: jest.fn(),
  initiateW3c: jest.fn(),
  pollW3c: jest.fn(),
};

jest.mock('../../src/modules/identityVerification/credence.client', () => ({
  isCredenceConfigured: () => mockCredence.configured,
  getDocRequest: (...args: unknown[]) => mockCredence.getDocRequest(...args),
  verifyDocRequest: (...args: unknown[]) => mockCredence.verifyDocRequest(...args),
  initiateOpenId4vp: (...args: unknown[]) => mockCredence.initiateOpenId4vp(...args),
  validateOpenId4vp: (...args: unknown[]) => mockCredence.validateOpenId4vp(...args),
  initiateW3c: (...args: unknown[]) => mockCredence.initiateW3c(...args),
  pollW3c: (...args: unknown[]) => mockCredence.pollW3c(...args),
}));

/** Fake claim values. None of these is real data. */
const FAKE_LICENSE_NUMBER = 'FAKE-DL-0000-1111';
const FAKE_PORTRAIT = 'RkFLRS1QT1JUUkFJVC1CWVRFUw==';
const FAKE_BIRTH_DATE = '1901-01-01';
const FAKE_ADDRESS = '1 Fake Street, Nowhere';

let sessionCounter = 0;
const nextSessionId = () => `credence-session-${(sessionCounter += 1)}-secret`;

const passingAuth = {
  authenticationResult: 'Success',
  issuerRecognized: true,
  issuerSignedAuthenticated: true,
  deviceSignedAuthenticated: true,
  dataIntegrity: true,
  msoValidity: 'Valid',
};

function mdocResult(identity: Record<string, unknown>, authentication: Record<string, unknown> = passingAuth) {
  const fullIdentity = {
    issuing_authority: 'California',
    issuing_country: 'US',
    expiry_date: '2031-05-04',
    document_number: FAKE_LICENSE_NUMBER,
    portrait: FAKE_PORTRAIT,
    birth_date: FAKE_BIRTH_DATE,
    resident_address: FAKE_ADDRESS,
    ...identity,
  };
  return {
    res: true,
    resDetails: JSON.stringify({
      identity: fullIdentity,
      authentication,
      documents: [{ docType: 'org.iso.18013.5.1.mDL', identity: fullIdentity, authentication }],
    }),
  };
}

interface World {
  home: Firm;
  away: Firm;
  homeOwner: Actor;
  awayOwner: Actor;
  alice: PortalPerson;
  bob: PortalPerson;
  awayClient: PortalPerson;
}

async function world(aliceName = 'Jose Nunez Diaz'): Promise<World> {
  const home = await createFirm({ name: 'Hale & Co' });
  const away = await createFirm({ name: 'Vale LLP' });
  return {
    home,
    away,
    homeOwner: await ownerOf(home.id),
    awayOwner: await ownerOf(away.id),
    alice: await portalPerson(home.id, aliceName),
    bob: await portalPerson(home.id, 'Bob Barker'),
    awayClient: await portalPerson(away.id, 'Avery Away'),
  };
}

const verificationsPath = (firmId: string, suffix = '') =>
  portalPath(firmId, `identity/verifications${suffix}`);
const firmReadPath = (firmId: string, clientId: string) =>
  `/api/lawfirms/${firmId}/clients/${clientId}/identity-verification`;

async function startMdoc(firmId: string, person: PortalPerson) {
  mockCredence.getDocRequest.mockResolvedValueOnce({
    sessionId: nextSessionId(),
    dcRequest: { deviceRequest: 'device-request', encryptionInfo: 'encryption-info' },
  });
  const res = await person.api.post(verificationsPath(firmId)).send({ method: 'mdoc_dcapi' });
  expect(res.status).toBe(201);
  return res.body.verificationId as string;
}

async function rowOf(id: string) {
  const { rows } = await testPool.query('select * from client_identity_verifications where id = $1', [id]);
  return rows[0];
}

beforeEach(() => {
  mockCredence.configured = true;
  for (const fn of Object.values(mockCredence)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as jest.Mock).mockReset();
  }
});

describe('tenant isolation (first)', () => {
  it('a client of another firm cannot start a verification here: 403, and no provider call', async () => {
    const w = await world();

    const res = await w.awayClient.api.post(verificationsPath(w.home.id)).send({ method: 'mdoc_dcapi' });

    expect(res.status).toBe(403);
    expect(mockCredence.getDocRequest).not.toHaveBeenCalled();
    const { rows } = await testPool.query('select count(*)::int as n from client_identity_verifications');
    expect(rows[0].n).toBe(0);
  });

  it("a client of another firm cannot complete or poll this firm's verification: 404", async () => {
    const w = await world();
    const id = await startMdoc(w.home.id, w.alice);

    const viaHome = await w.awayClient.api.post(verificationsPath(w.home.id, `/${id}/complete`)).send({ data: 'x' });
    const viaAway = await w.awayClient.api.post(verificationsPath(w.away.id, `/${id}/complete`)).send({ data: 'x' });
    const pollAway = await w.awayClient.api.post(verificationsPath(w.away.id, `/${id}/poll`));

    expect([viaHome.status, viaAway.status, pollAway.status]).toEqual([404, 404, 404]);
    expect(mockCredence.verifyDocRequest).not.toHaveBeenCalled();
    expect((await rowOf(id)).status).toBe('pending');
  });

  it("another firm's owner cannot read this firm's client verification: 403", async () => {
    const w = await world();
    const id = await startMdoc(w.home.id, w.alice);
    mockCredence.verifyDocRequest.mockResolvedValueOnce(mdocResult({ given_name: 'Jose', family_name: 'Nunez Diaz' }));
    await w.alice.api.post(verificationsPath(w.home.id, `/${id}/complete`)).send({ data: 'wallet' }).expect(200);

    const res = await w.awayOwner.api.get(firmReadPath(w.home.id, w.alice.clientId));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Nunez');
  });
});

describe('ownership inside one firm', () => {
  it("client B cannot complete client A's verification: 404, row untouched", async () => {
    const w = await world();
    const id = await startMdoc(w.home.id, w.alice);

    const res = await w.bob.api.post(verificationsPath(w.home.id, `/${id}/complete`)).send({ data: 'wallet' });

    expect(res.status).toBe(404);
    expect(mockCredence.verifyDocRequest).not.toHaveBeenCalled();
    expect((await rowOf(id)).status).toBe('pending');
  });

  it('a person on an organization roster with no personal client here is refused: 403', async () => {
    const firm = await createFirm();
    const { uid } = await createPortalUser({ name: 'Roster Only' });
    // The person row makes the uid a real client of this firm; selecting the
    // organization they are linked to makes the active client a company.
    const org = await createOrgClient(firm.id, { name: 'Acme Org' });
    const { rows } = await testPool.query(
      `insert into clients (law_firm_id, name, client_type, user_id)
       values ($1, 'Roster Person', 'person', $2) returning id`,
      [firm.id, uid],
    );
    await linkPersonToOrg(firm.id, rows[0].id, org.id, { canViewBilling: false });
    const api = as(tokenFor({ uid }));

    const res = await api.post(`${verificationsPath(firm.id)}?clientRecordId=${org.id}`).send({ method: 'mdoc_dcapi' });

    expect(res.status).toBe(403);
    expect(mockCredence.getDocRequest).not.toHaveBeenCalled();
  });
});

describe('start', () => {
  it('answers 201 with the request and never the provider session id', async () => {
    const w = await world();
    const sessionId = nextSessionId();
    mockCredence.getDocRequest.mockResolvedValueOnce({
      sessionId,
      dcRequest: { deviceRequest: 'device-request', encryptionInfo: 'encryption-info' },
    });

    const res = await w.alice.api.post(verificationsPath(w.home.id)).send({ method: 'mdoc_dcapi' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      verificationId: expect.any(String),
      method: 'mdoc_dcapi',
      request: { deviceRequest: 'device-request', encryptionInfo: 'encryption-info' },
    });
    expect(JSON.stringify(res.body)).not.toContain(sessionId);
    const row = await rowOf(res.body.verificationId);
    expect(row).toMatchObject({
      law_firm_id: w.home.id, client_id: w.alice.clientId, user_id: w.alice.uid,
      status: 'pending', provider_session_id: sessionId,
    });
  });

  it('builds the wallet link for the W3C flow', async () => {
    const w = await world();
    mockCredence.initiateW3c.mockResolvedValueOnce({
      sessionId: nextSessionId(),
      authorizationRequest: { client_id: 'x509_san_dns:verifier.example.test' },
      callbackUrl: 'https://cb.example.test',
      requestUri: 'https://verifier.example.test/request?id=1&x=2',
    });

    const res = await w.alice.api.post(verificationsPath(w.home.id)).send({ method: 'w3c_openid4vp' });

    expect(res.status).toBe(201);
    expect(res.body.request).toEqual({
      walletUrl: 'openid4vp://authorize?client_id=x509_san_dns%3Averifier.example.test'
        + '&request_uri=https%3A%2F%2Fverifier.example.test%2Frequest%3Fid%3D1%26x%3D2',
    });
  });

  it('answers 503 IDENTITY_VERIFICATION_UNCONFIGURED when Credence is not configured', async () => {
    const w = await world();
    mockCredence.configured = false;

    const res = await w.alice.api.post(verificationsPath(w.home.id)).send({ method: 'mdoc_dcapi' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('IDENTITY_VERIFICATION_UNCONFIGURED');
    expect(mockCredence.getDocRequest).not.toHaveBeenCalled();
  });

  it('rejects an unknown method: 400', async () => {
    const w = await world();

    const res = await w.alice.api.post(verificationsPath(w.home.id)).send({ method: 'selfie' });

    expect(res.status).toBe(400);
  });
});

describe('complete', () => {
  it('completing twice answers 409', async () => {
    const w = await world();
    const id = await startMdoc(w.home.id, w.alice);
    mockCredence.verifyDocRequest.mockResolvedValue(mdocResult({ given_name: 'Jose', family_name: 'Nunez Diaz' }));

    const first = await w.alice.api.post(verificationsPath(w.home.id, `/${id}/complete`)).send({ data: 'wallet' });
    const second = await w.alice.api.post(verificationsPath(w.home.id, `/${id}/complete`)).send({ data: 'wallet' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(mockCredence.verifyDocRequest).toHaveBeenCalledTimes(1);
  });

  it('completing after expires_at answers 409 and marks the row expired', async () => {
    const w = await world();
    const id = await startMdoc(w.home.id, w.alice);
    await testPool.query(
      "update client_identity_verifications set expires_at = now() - interval '1 second' where id = $1",
      [id],
    );

    const res = await w.alice.api.post(verificationsPath(w.home.id, `/${id}/complete`)).send({ data: 'wallet' });

    expect(res.status).toBe(409);
    expect(mockCredence.verifyDocRequest).not.toHaveBeenCalled();
    const row = await rowOf(id);
    expect(row.status).toBe('expired');
    expect(row.completed_at).not.toBeNull();
  });

  it('res false stores failed with the provider reason and no names', async () => {
    const w = await world();
    const id = await startMdoc(w.home.id, w.alice);
    mockCredence.verifyDocRequest.mockResolvedValueOnce({
      ...mdocResult(
        { given_name: 'Jose', family_name: 'Nunez Diaz' },
        { ...passingAuth, authenticationResult: 'IssuerNotTrusted', issuerRecognized: false },
      ),
      res: false,
    });

    const res = await w.alice.api.post(verificationsPath(w.home.id, `/${id}/complete`)).send({ data: 'wallet' });

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({
      verificationId: id, status: 'failed', failureReason: 'IssuerNotTrusted', verifiedName: null,
    });
    const row = await rowOf(id);
    expect(row).toMatchObject({
      status: 'failed', failure_reason: 'IssuerNotTrusted',
      verified_given_name: null, verified_family_name: null, is_name_match: null,
    });
  });

  it('a cancelled wallet answer stores cancelled', async () => {
    const w = await world();
    const id = await startMdoc(w.home.id, w.alice);
    mockCredence.verifyDocRequest.mockResolvedValueOnce({ res: false, resDetails: '', cancelled: true });

    const res = await w.alice.api.post(verificationsPath(w.home.id, `/${id}/complete`)).send({ data: 'wallet' });

    expect(res.status).toBe(200);
    expect(res.body.result.status).toBe('cancelled');
    expect((await rowOf(id)).status).toBe('cancelled');
  });

  it('res true stores the name, issuer and a name match that ignores accents, case and hyphens', async () => {
    const w = await world('Jose Nunez Diaz');
    const id = await startMdoc(w.home.id, w.alice);
    mockCredence.verifyDocRequest.mockResolvedValueOnce(
      mdocResult({ given_name: 'José ', family_name: ' Núñez-Díaz' }),
    );

    const res = await w.alice.api.post(verificationsPath(w.home.id, `/${id}/complete`)).send({ data: 'wallet' });

    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({
      verificationId: id,
      method: 'mdoc_dcapi',
      status: 'verified',
      verifiedName: { given: 'José', family: 'Núñez-Díaz' },
      issuer: 'California',
      docType: 'org.iso.18013.5.1.mDL',
      credentialExpiresOn: '2031-05-04',
      nameMatchesRecord: true,
      checks: {
        authenticationResult: 'Success',
        issuerRecognized: true,
        issuerSignedAuthenticated: true,
        deviceSignedAuthenticated: true,
        dataIntegrity: true,
        msoValidity: 'Valid',
      },
      failureReason: null,
      createdAt: expect.any(String),
      completedAt: expect.any(String),
    });
    expect(mockCredence.verifyDocRequest).toHaveBeenCalledWith(expect.stringContaining('credence-session-'), 'wallet');
    const row = await rowOf(id);
    expect(row).toMatchObject({
      status: 'verified', verified_given_name: 'José', verified_family_name: 'Núñez-Díaz',
      issuer: 'California', is_name_match: true, credential_expires_on: '2031-05-04',
    });
  });

  it('the spacing variant "José  Núñez-Díaz" against "Jose Nunez Diaz" matches', async () => {
    const w = await world('Jose Nunez Diaz');
    const id = await startMdoc(w.home.id, w.alice);
    mockCredence.verifyDocRequest.mockResolvedValueOnce(mdocResult({ given_name: 'José ', family_name: ' Núñez-Díaz' }));

    const res = await w.alice.api.post(verificationsPath(w.home.id, `/${id}/complete`)).send({ data: 'wallet' });

    expect(res.body.result.nameMatchesRecord).toBe(true);
  });

  it('a different name is still verified, with nameMatchesRecord false', async () => {
    const w = await world('Jane Smith');
    const id = await startMdoc(w.home.id, w.alice);
    mockCredence.verifyDocRequest.mockResolvedValueOnce(mdocResult({ given_name: 'Jon', family_name: 'Smith' }));

    const res = await w.alice.api.post(verificationsPath(w.home.id, `/${id}/complete`)).send({ data: 'wallet' });

    expect(res.body.result).toMatchObject({ status: 'verified', nameMatchesRecord: false });
    expect((await rowOf(id)).is_name_match).toBe(false);
  });

  it('never persists or returns the portrait, license number, birth date or address', async () => {
    const w = await world();
    const id = await startMdoc(w.home.id, w.alice);
    mockCredence.verifyDocRequest.mockResolvedValueOnce(mdocResult({ given_name: 'Jose', family_name: 'Nunez Diaz' }));

    const res = await w.alice.api.post(verificationsPath(w.home.id, `/${id}/complete`)).send({ data: 'wallet' });
    const row = await rowOf(id);
    const firmRead = await w.homeOwner.api.get(firmReadPath(w.home.id, w.alice.clientId));

    expect(res.body.result.status).toBe('verified');
    for (const text of [JSON.stringify(row), JSON.stringify(res.body), JSON.stringify(firmRead.body)]) {
      expect(text).not.toContain('portrait');
      expect(text).not.toContain(FAKE_PORTRAIT);
      expect(text).not.toContain(FAKE_LICENSE_NUMBER);
      expect(text).not.toContain(FAKE_BIRTH_DATE);
      expect(text).not.toContain(FAKE_ADDRESS);
    }
  });

  it('writes an audit entry and notifies the firm on success', async () => {
    const w = await world();
    const id = await startMdoc(w.home.id, w.alice);
    mockCredence.verifyDocRequest.mockResolvedValueOnce(mdocResult({ given_name: 'Jose', family_name: 'Nunez Diaz' }));

    await w.alice.api.post(verificationsPath(w.home.id, `/${id}/complete`)).send({ data: 'wallet' }).expect(200);
    await drainEvents();

    const audit = await testPool.query(
      `select actor_uid, resource_id, metadata from audit_events
        where law_firm_id = $1 and action = 'client.identity_verified'`,
      [w.home.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_uid: w.alice.uid, resource_id: w.alice.clientId });
    expect(JSON.stringify(audit.rows[0].metadata)).not.toContain(FAKE_LICENSE_NUMBER);

    const notes = await testPool.query(
      `select user_id, law_firm_id, title, action_url from notifications where type = 'client_identity_verified'`,
    );
    expect(notes.rows).toEqual([expect.objectContaining({
      user_id: w.homeOwner.uid,
      law_firm_id: w.home.id,
      title: 'Jose Nunez Diaz verified their identity',
    })]);
    expect(notes.rows[0].action_url).toContain(`/clients/${w.alice.clientId}`);
  });

  it('a failed attempt neither audits a verification nor notifies the firm', async () => {
    const w = await world();
    const id = await startMdoc(w.home.id, w.alice);
    mockCredence.verifyDocRequest.mockResolvedValueOnce({ res: false, resDetails: '{}' });

    const res = await w.alice.api.post(verificationsPath(w.home.id, `/${id}/complete`)).send({ data: 'wallet' });
    await drainEvents();

    expect(res.body.result.status).toBe('failed');
    const notes = await testPool.query("select 1 from notifications where type = 'client_identity_verified'");
    expect(notes.rows).toHaveLength(0);
  });

  it('refuses a wallet response over the size cap: 400', async () => {
    const w = await world();
    const id = await startMdoc(w.home.id, w.alice);

    const res = await w.alice.api.post(verificationsPath(w.home.id, `/${id}/complete`))
      .send({ data: 'a'.repeat(210_000) });

    expect(res.status).toBe(400);
    expect(mockCredence.verifyDocRequest).not.toHaveBeenCalled();
  });

  it('a W3C verification is polled, not completed: 400', async () => {
    const w = await world();
    mockCredence.initiateW3c.mockResolvedValueOnce({
      sessionId: nextSessionId(), authorizationRequest: { client_id: 'c' }, callbackUrl: 'u', requestUri: 'r',
    });
    const start = await w.alice.api.post(verificationsPath(w.home.id)).send({ method: 'w3c_openid4vp' });

    const res = await w.alice.api.post(verificationsPath(w.home.id, `/${start.body.verificationId}/complete`))
      .send({ data: 'wallet' });

    expect(res.status).toBe(400);
  });
});

describe('poll (W3C flow)', () => {
  const allChecks = {
    vpSignatureValid: true, vcSignatureValid: true, nonceMatches: true, audienceMatches: true,
    issuerTrusted: true, notExpired: true, credentialTypeMatches: true,
  };

  async function startW3c(w: World) {
    mockCredence.initiateW3c.mockResolvedValueOnce({
      sessionId: nextSessionId(), authorizationRequest: { client_id: 'c' }, callbackUrl: 'u', requestUri: 'r',
    });
    const res = await w.alice.api.post(verificationsPath(w.home.id)).send({ method: 'w3c_openid4vp' });
    return res.body.verificationId as string;
  }

  it('stays pending while the wallet has not answered, then verifies', async () => {
    const w = await world('Jose Nunez Diaz');
    const id = await startW3c(w);
    mockCredence.pollW3c.mockResolvedValueOnce(null).mockResolvedValueOnce({
      success: true,
      claims: { given_name: 'Jose', family_name: 'Nunez Diaz', document_number: FAKE_LICENSE_NUMBER },
      issuer: 'US-CA',
      issuanceDate: '2024-01-01T00:00:00Z',
      expirationDate: '2030-02-03T00:00:00Z',
      credentialType: ['VerifiableCredential', 'Iso18013DriversLicenseCredential'],
      verificationDetails: allChecks,
      error: null,
    });

    const pending = await w.alice.api.post(verificationsPath(w.home.id, `/${id}/poll`));
    const done = await w.alice.api.post(verificationsPath(w.home.id, `/${id}/poll`));

    expect(pending.status).toBe(200);
    expect(pending.body.result.status).toBe('pending');
    expect(done.body.result).toMatchObject({
      status: 'verified', issuer: 'US-CA', credentialExpiresOn: '2030-02-03',
      docType: 'Iso18013DriversLicenseCredential', nameMatchesRecord: true, checks: allChecks,
    });
    expect(JSON.stringify(done.body)).not.toContain(FAKE_LICENSE_NUMBER);
  });

  it('success with any failed check is failed', async () => {
    const w = await world();
    const id = await startW3c(w);
    mockCredence.pollW3c.mockResolvedValueOnce({
      success: true,
      claims: { given_name: 'Jose', family_name: 'Nunez Diaz' },
      issuer: 'US-CA', issuanceDate: null, expirationDate: null, credentialType: null,
      verificationDetails: { ...allChecks, issuerTrusted: false },
      error: null,
    });

    const res = await w.alice.api.post(verificationsPath(w.home.id, `/${id}/poll`));

    expect(res.body.result).toMatchObject({ status: 'failed', verifiedName: null });
    expect((await rowOf(id)).verified_given_name).toBeNull();
  });
});

describe('portal summary', () => {
  it('reports configured and the latest attempt for the active client', async () => {
    const w = await world();
    const id = await startMdoc(w.home.id, w.alice);

    const res = await w.alice.api.get(portalPath(w.home.id, 'identity'));
    const bobs = await w.bob.api.get(portalPath(w.home.id, 'identity'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: true, latest: { verificationId: id, status: 'pending' } });
    expect(bobs.body).toEqual({ configured: true, latest: null });
  });

  it('reports configured false when Credence is not configured', async () => {
    const w = await world();
    mockCredence.configured = false;

    const res = await w.alice.api.get(portalPath(w.home.id, 'identity'));

    expect(res.body).toEqual({ configured: false, latest: null });
  });
});

describe('firm read', () => {
  it('answers the latest verified attempt and the latest attempt of any status', async () => {
    const w = await world();
    const verifiedId = await startMdoc(w.home.id, w.alice);
    mockCredence.verifyDocRequest.mockResolvedValueOnce(mdocResult({ given_name: 'Jose', family_name: 'Nunez Diaz' }));
    await w.alice.api.post(verificationsPath(w.home.id, `/${verifiedId}/complete`)).send({ data: 'w' }).expect(200);
    const laterId = await startMdoc(w.home.id, w.alice);

    const res = await w.homeOwner.api.get(firmReadPath(w.home.id, w.alice.clientId));

    expect(res.status).toBe(200);
    expect(res.body.verified).toMatchObject({ verificationId: verifiedId, status: 'verified' });
    expect(res.body.latestAttempt).toMatchObject({ verificationId: laterId, status: 'pending' });
    expect(JSON.stringify(res.body)).not.toMatch(/providerSessionId|provider_session_id|credence-session-/);
  });

  it('answers nulls for a client never verified', async () => {
    const w = await world();

    const res = await w.homeOwner.api.get(firmReadPath(w.home.id, w.bob.clientId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: null, latestAttempt: null });
  });

  it("answers 404 for another firm's client and for a malformed id", async () => {
    const w = await world();

    const foreign = await w.homeOwner.api.get(firmReadPath(w.home.id, w.awayClient.clientId));
    const malformed = await w.homeOwner.api.get(firmReadPath(w.home.id, 'not-a-uuid'));

    expect([foreign.status, malformed.status]).toEqual([404, 404]);
  });

  it('any member reads it through the clients.view baseline; a non-member and a portal client are refused', async () => {
    // clients.view is in DEFAULT_PERMISSIONS, so a member holding nothing else
    // still has it; the refusals that can exist are non-members.
    const w = await world();
    const member = await memberWith(w.home.id, ['matters.view']);
    const outsider = stranger();

    const allowed = await member.api.get(firmReadPath(w.home.id, w.alice.clientId));
    const refused = await outsider.api.get(firmReadPath(w.home.id, w.alice.clientId));
    const portal = await w.alice.api.get(firmReadPath(w.home.id, w.alice.clientId));

    expect(allowed.status).toBe(200);
    expect(refused.status).toBe(403);
    expect(portal.status).toBe(403);
  });
});
