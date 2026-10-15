/**
 * The portal's identity verification flows, driven through the real service
 * with only the transport and the browser's Digital Credentials API faked.
 *
 * Red if: the wallet request is not the org-iso-mdoc shape Safari expects; the
 * pointerdown prefetch is not reused by the click (a second start, or a start
 * that only begins on click, which iOS rejects as outside the gesture); a
 * NotAllowedError or a null credential is reported as anything but cancelled;
 * a browser without the API sends a start at all; the QR flow reads a 202 poll
 * as finished, keeps polling past a result, past three minutes, or after the
 * page unmounts.
 */
jest.unmock('@/services/identityVerification.service');
jest.unmock('@/services/requestDeduplicator');

import { act, renderHook, waitFor } from '@testing-library/react';
import { setupApiMock, sequence } from '../support/apiMock';
import { useIdentityVerification } from '@/hooks/useIdentityVerification';
import type { VerificationResult } from '@/types/identityVerification';

const api = setupApiMock();
const PORTAL = '/api/client-portal/lawfirm/firm-a/identity/verifications';
const DC_REQUEST = { deviceRequest: 'device-request', encryptionInfo: 'encryption-info' };

const verified = (overrides: Partial<VerificationResult> = {}): VerificationResult => ({
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

let credentialsGet: jest.Mock;

function installDigitalCredentials() {
  credentialsGet = jest.fn();
  (window as unknown as { DigitalCredential?: unknown }).DigitalCredential = class {};
  Object.defineProperty(navigator, 'credentials', { value: { get: credentialsGet }, configurable: true });
}

function removeDigitalCredentials() {
  delete (window as unknown as { DigitalCredential?: unknown }).DigitalCredential;
  Object.defineProperty(navigator, 'credentials', { value: undefined, configurable: true });
}

const render = (onFinished = jest.fn()) =>
  renderHook(() => useIdentityVerification({ lawFirmId: 'firm-a', clientRecordId: 'rec-a', onFinished }));

beforeEach(() => { process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off'; });
afterEach(() => {
  delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN;
  removeDigitalCredentials();
});

describe('Flow A: the browser wallet', () => {
  beforeEach(installDigitalCredentials);

  it('verifies with the prefetched request and finishes with the result', async () => {
    api.postExact(`${PORTAL}?clientRecordId=rec-a`, { status: 201, body: { verificationId: 'ver-1', method: 'mdoc_dcapi', request: DC_REQUEST } });
    api.postExact(`${PORTAL}/ver-1/complete?clientRecordId=rec-a`, { result: verified() });
    credentialsGet.mockResolvedValue({ protocol: 'org-iso-mdoc', data: { response: 'wallet-response' } });
    const onFinished = jest.fn();
    const { result } = render(onFinished);

    expect(result.current.supportsWallet).toBe(true);
    act(() => result.current.prefetch());
    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    await act(async () => { await result.current.verifyWithWallet(); });

    expect(api.callsTo('/verifications')).toHaveLength(1);
    expect(api.calls('POST')[0].body).toEqual({ method: 'mdoc_dcapi' });
    expect(credentialsGet).toHaveBeenCalledWith({
      digital: { requests: [{ protocol: 'org-iso-mdoc', data: DC_REQUEST }] },
      mediation: 'required',
    });
    expect(api.callsTo('/complete')[0].body).toEqual({ data: JSON.stringify({ response: 'wallet-response' }) });
    expect(result.current.state).toEqual({ kind: 'finished', result: verified() });
    expect(onFinished).toHaveBeenCalledWith(verified());
  });

  it('starts on click when no pointerdown came first', async () => {
    api.postExact(`${PORTAL}?clientRecordId=rec-a`, { status: 201, body: { verificationId: 'ver-1', method: 'mdoc_dcapi', request: DC_REQUEST } });
    api.postExact(`${PORTAL}/ver-1/complete?clientRecordId=rec-a`, { result: verified() });
    credentialsGet.mockResolvedValue({ protocol: 'org-iso-mdoc', data: 'string-response' });
    const { result } = render();

    await act(async () => { await result.current.verifyWithWallet(); });

    expect(api.callsTo('/verifications')).toHaveLength(1);
    expect(api.callsTo('/complete')[0].body).toEqual({ data: 'string-response' });
  });

  it('treats a NotAllowedError from the wallet as cancelled and sends nothing to complete', async () => {
    api.postExact(`${PORTAL}?clientRecordId=rec-a`, { status: 201, body: { verificationId: 'ver-1', method: 'mdoc_dcapi', request: DC_REQUEST } });
    credentialsGet.mockRejectedValue(new DOMException('The user dismissed the sheet.', 'NotAllowedError'));
    const onFinished = jest.fn();
    const { result } = render(onFinished);

    await act(async () => { await result.current.verifyWithWallet(); });

    expect(credentialsGet).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ kind: 'cancelled' });
    expect(api.callsTo('/complete')).toHaveLength(0);
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('treats a null credential as cancelled', async () => {
    api.postExact(`${PORTAL}?clientRecordId=rec-a`, { status: 201, body: { verificationId: 'ver-1', method: 'mdoc_dcapi', request: DC_REQUEST } });
    credentialsGet.mockResolvedValue(null);
    const { result } = render();

    await act(async () => { await result.current.verifyWithWallet(); });

    expect(credentialsGet).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ kind: 'cancelled' });
    expect(api.callsTo('/complete')).toHaveLength(0);
  });

  it('reports a refused start with its status, without opening the wallet', async () => {
    api.postExact(`${PORTAL}?clientRecordId=rec-a`, { status: 429, body: { error: 'Too many', code: 'RATE_LIMITED' } });
    const { result } = render();

    await act(async () => { await result.current.verifyWithWallet(); });

    expect(credentialsGet).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ kind: 'error', status: 429, code: 'RATE_LIMITED' });
  });

  it('reports a provider failure on complete with its status', async () => {
    api.postExact(`${PORTAL}?clientRecordId=rec-a`, { status: 201, body: { verificationId: 'ver-1', method: 'mdoc_dcapi', request: DC_REQUEST } });
    api.postExact(`${PORTAL}/ver-1/complete?clientRecordId=rec-a`, { status: 502, body: { error: 'Provider down', code: 'IDENTITY_PROVIDER_ERROR' } });
    credentialsGet.mockResolvedValue({ protocol: 'org-iso-mdoc', data: 'x' });
    const { result } = render();

    await act(async () => { await result.current.verifyWithWallet(); });

    expect(result.current.state).toEqual({ kind: 'error', status: 502, code: 'IDENTITY_PROVIDER_ERROR' });
  });

  it('goes back to idle on reset so the client can try again', async () => {
    api.postExact(`${PORTAL}?clientRecordId=rec-a`, { status: 201, body: { verificationId: 'ver-1', method: 'mdoc_dcapi', request: DC_REQUEST } });
    credentialsGet.mockRejectedValue(new DOMException('dismissed', 'NotAllowedError'));
    const { result } = render();
    await act(async () => { await result.current.verifyWithWallet(); });

    act(() => result.current.reset());

    expect(result.current.state).toEqual({ kind: 'idle' });
  });
});

describe('a browser without the Digital Credentials API', () => {
  it('reports unsupported and never starts a verification', async () => {
    const { result } = render();

    expect(result.current.supportsWallet).toBe(false);
    act(() => result.current.prefetch());
    await act(async () => { await result.current.verifyWithWallet(); });

    expect(result.current.state).toEqual({ kind: 'unsupported' });
    expect(api.calls()).toHaveLength(0);
  });
});

describe('Flow D: the QR code', () => {
  const WALLET_URL = 'openid4vp://authorize?client_id=x&request_uri=y';
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
  const advance = async (ms: number) => { await act(async () => { await jest.advanceTimersByTimeAsync(ms); }); };

  // The QR image is encoded off the fake clock (the encoder yields on real
  // ticks), so the flow is kicked off and then given real ticks until it
  // leaves `starting`, without moving the fake clock the poll loop runs on.
  async function openQr(result: { current: ReturnType<typeof useIdentityVerification> }) {
    act(() => { void result.current.showQrCode(); });
    for (let i = 0; i < 200 && result.current.state.kind === 'starting'; i += 1) {
      await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
    }
  }

  function startQr() {
    api.postExact(`${PORTAL}?clientRecordId=rec-a`, {
      status: 201,
      body: { verificationId: 'ver-9', method: 'w3c_openid4vp', request: { walletUrl: WALLET_URL } },
    });
  }

  it('shows the wallet link as a QR, keeps polling through a 202, and finishes on the 200', async () => {
    startQr();
    api.postExact(`${PORTAL}/ver-9/poll?clientRecordId=rec-a`, sequence(
      { status: 202, body: {} },
      { result: verified({ verificationId: 'ver-9', method: 'w3c_openid4vp' }) },
    ));
    const onFinished = jest.fn();
    const { result } = render(onFinished);

    await openQr(result);
    expect(api.calls('POST')[0].body).toEqual({ method: 'w3c_openid4vp' });
    expect(result.current.state).toMatchObject({ kind: 'qr', walletUrl: WALLET_URL });
    const qr = result.current.state as { qrDataUrl: string };
    expect(qr.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    await advance(2000);
    expect(api.callsTo('/poll')).toHaveLength(1);
    expect(result.current.state.kind).toBe('qr');

    await advance(2000);
    expect(api.callsTo('/poll')).toHaveLength(2);
    expect(result.current.state).toEqual({ kind: 'finished', result: verified({ verificationId: 'ver-9', method: 'w3c_openid4vp' }) });
    expect(onFinished).toHaveBeenCalledTimes(1);

    await advance(10_000);
    expect(api.callsTo('/poll')).toHaveLength(2);
  });

  it('keeps polling while a 200 still says pending', async () => {
    startQr();
    api.postExact(`${PORTAL}/ver-9/poll?clientRecordId=rec-a`, sequence(
      { result: verified({ status: 'pending', verifiedName: null }) },
      { result: verified({ status: 'failed', verifiedName: null, failureReason: 'Signature invalid' }) },
    ));
    const { result } = render();
    await openQr(result);

    await advance(2000);
    expect(result.current.state.kind).toBe('qr');
    await advance(2000);
    expect(result.current.state).toMatchObject({ kind: 'finished', result: { status: 'failed' } });
  });

  it('stops after three minutes and reports a timeout', async () => {
    startQr();
    api.postExact(`${PORTAL}/ver-9/poll?clientRecordId=rec-a`, { status: 202, body: {} });
    const { result } = render();
    await openQr(result);

    await advance(180_000);
    expect(result.current.state).toEqual({ kind: 'timedOut' });
    const polls = api.callsTo('/poll').length;
    expect(polls).toBe(90);

    await advance(20_000);
    expect(api.callsTo('/poll')).toHaveLength(polls);
  });

  it('stops polling when the page unmounts', async () => {
    startQr();
    api.postExact(`${PORTAL}/ver-9/poll?clientRecordId=rec-a`, { status: 202, body: {} });
    const { result, unmount } = render();
    await openQr(result);
    await advance(2000);
    expect(api.callsTo('/poll')).toHaveLength(1);

    unmount();
    await advance(20_000);

    expect(api.callsTo('/poll')).toHaveLength(1);
  });

  it('stops polling on reset', async () => {
    startQr();
    api.postExact(`${PORTAL}/ver-9/poll?clientRecordId=rec-a`, { status: 202, body: {} });
    const { result } = render();
    await openQr(result);

    act(() => result.current.reset());
    await advance(20_000);

    expect(api.callsTo('/poll')).toHaveLength(0);
    expect(result.current.state).toEqual({ kind: 'idle' });
  });
});
