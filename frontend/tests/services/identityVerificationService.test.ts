/**
 * The four portal identity calls and the firm read, through the real service
 * with only the transport faked.
 *
 * Red if a call goes to the wrong route or method, drops the portal's active
 * client record from the query, sends a body other than the contract's, reads
 * a 202 poll as a finished result, or loses the HTTP status the portal page
 * picks its copy from (429, 502, 503).
 */
jest.unmock('@/services/identityVerification.service');
jest.unmock('@/services/requestDeduplicator');

import { setupApiMock } from '../support/apiMock';
import { ApiError } from '@/lib/utils/apiErrors';
import identityVerificationService from '@/services/identityVerification.service';
import type { VerificationResult } from '@/types/identityVerification';

const api = setupApiMock();
beforeEach(() => { process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off'; });
afterEach(() => { delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN; });

const PORTAL = '/api/client-portal/lawfirm/firm-a/identity';

const result = (overrides: Partial<VerificationResult> = {}): VerificationResult => ({
  verificationId: 'ver-1',
  method: 'mdoc_dcapi',
  status: 'verified',
  verifiedName: { given: 'Jane', family: 'Smith' },
  issuer: 'California',
  docType: 'org.iso.18013.5.1.mDL',
  credentialExpiresOn: '2030-01-01',
  nameMatchesRecord: true,
  checks: { issuerSignedAuthenticated: true },
  failureReason: null,
  createdAt: '2026-10-14T16:00:00.000Z',
  completedAt: '2026-10-14T16:01:00.000Z',
  ...overrides,
});

describe('portal calls', () => {
  it('reads the identity status for the active client record', async () => {
    api.getExact(`${PORTAL}?clientRecordId=rec-a`, { configured: true, latest: result() });

    await expect(identityVerificationService.getPortalStatus('firm-a', 'rec-a'))
      .resolves.toEqual({ configured: true, latest: result() });
  });

  it('starts a verification with the method in the body and the client record in the query', async () => {
    api.postExact(`${PORTAL}/verifications?clientRecordId=rec-a`, {
      status: 201,
      body: { verificationId: 'ver-1', method: 'mdoc_dcapi', request: { deviceRequest: 'dr', encryptionInfo: 'ei' } },
    });

    await expect(identityVerificationService.start('firm-a', 'mdoc_dcapi', 'rec-a')).resolves.toEqual({
      verificationId: 'ver-1',
      method: 'mdoc_dcapi',
      request: { deviceRequest: 'dr', encryptionInfo: 'ei' },
    });
    expect(api.calls('POST')[0].body).toEqual({ method: 'mdoc_dcapi' });
  });

  it('completes with the credential data and unwraps the result', async () => {
    api.postExact(`${PORTAL}/verifications/ver-1/complete?clientRecordId=rec-a`, { result: result() });

    await expect(identityVerificationService.complete('firm-a', 'ver-1', 'wallet-response', 'rec-a'))
      .resolves.toEqual(result());
    expect(api.calls('POST')[0].body).toEqual({ data: 'wallet-response' });
  });

  it('polls without a body and unwraps a 200 result', async () => {
    api.postExact(`${PORTAL}/verifications/ver-1/poll?clientRecordId=rec-a`, { result: result({ method: 'w3c_openid4vp' }) });

    await expect(identityVerificationService.poll('firm-a', 'ver-1', 'rec-a'))
      .resolves.toEqual(result({ method: 'w3c_openid4vp' }));
    expect(api.calls('POST')[0].body).toBeNull();
  });

  it('reads a 202 poll as still waiting, not as a result', async () => {
    api.postExact(`${PORTAL}/verifications/ver-1/poll`, { status: 202, body: {} });

    await expect(identityVerificationService.poll('firm-a', 'ver-1')).resolves.toBeNull();
  });

  it('omits the client record query when there is no active record', async () => {
    api.postExact(`${PORTAL}/verifications`, { status: 201, body: { verificationId: 'v', method: 'w3c_openid4vp', request: { walletUrl: 'openid4vp://x' } } });

    await identityVerificationService.start('firm-a', 'w3c_openid4vp');
    expect(api.calls('POST')[0].query).toEqual({});
  });

  it.each([
    [429, 'RATE_LIMITED'],
    [502, 'IDENTITY_PROVIDER_ERROR'],
    [503, 'IDENTITY_VERIFICATION_UNCONFIGURED'],
    [409, 'VERIFICATION_NOT_PENDING'],
  ])('throws an ApiError carrying status %i and its code', async (status, code) => {
    api.postExact(`${PORTAL}/verifications`, { status, body: { error: 'Refused', code } });

    const error = await identityVerificationService.start('firm-a', 'mdoc_dcapi').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
    expect((error as ApiError).code).toBe(code);
  });

  it('keeps the status on a refused completion', async () => {
    api.postExact(`${PORTAL}/verifications/ver-1/complete`, { status: 404, body: { error: 'Not found' } });

    const error = await identityVerificationService.complete('firm-a', 'ver-1', 'x').catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(404);
  });
});

describe('firm read', () => {
  it("reads one client's verification from the firm route", async () => {
    api.getExact('/api/lawfirms/firm-a/clients/client-1/identity-verification', { verified: result(), latestAttempt: result() });

    await expect(identityVerificationService.getClientVerification('firm-a', 'client-1'))
      .resolves.toEqual({ verified: result(), latestAttempt: result() });
  });

  it('throws an ApiError when the firm route refuses', async () => {
    api.getExact('/api/lawfirms/firm-a/clients/client-1/identity-verification', { status: 403, body: { error: 'Forbidden' } });

    const error = await identityVerificationService.getClientVerification('firm-a', 'client-1').catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(403);
  });
});
