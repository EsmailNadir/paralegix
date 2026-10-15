/**
 * The portal's "Verify your identity" page, through the real service and hook
 * with only the transport and the browser wallet faked.
 *
 * Red if a state renders the wrong copy or the wrong control: the wallet button
 * offered where the browser has no Digital Credentials API (or the QR fallback
 * where it does), a differing name shown as a failure or without the "contact
 * your attorney's office" request, an unconfigured firm offered a button, a
 * cancel or failure left without a way to retry, a 429/502/503 shown as a raw
 * server message, the identity calls sent without the active client record,
 * or any of these states failing the axe scan.
 */
jest.unmock('@/services/identityVerification.service');
jest.unmock('@/services/requestDeduplicator');

const mockUser = { uid: 'test-uid' };
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('next/navigation', () => ({ useParams: () => ({ lawFirmId: 'firm-a' }), useSearchParams: () => new URLSearchParams() }));
let mockAssociation: { clientRecordId: string; clientType: 'person' | 'company' } = { clientRecordId: 'rec-a', clientType: 'person' };
jest.mock('@/contexts/ClientPortalContext', () => ({
  useClientPortal: () => ({
    associations: [],
    associationsLoading: false,
    activeAssociation: mockAssociation,
    selectionRequired: false,
    setActiveClientRecordId: () => {},
  }),
}));

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IdentityPage from '@/app/client/lawfirm/[lawFirmId]/identity/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock } from '../../support/apiMock';
import { scanAccessibility } from '../../support/accessibility';
import type { VerificationResult } from '@/types/identityVerification';

const api = setupApiMock();
const STATUS = '/api/client-portal/lawfirm/firm-a/identity?clientRecordId=rec-a';
const START = '/api/client-portal/lawfirm/firm-a/identity/verifications?clientRecordId=rec-a';
const COMPLETE = '/api/client-portal/lawfirm/firm-a/identity/verifications/ver-1/complete?clientRecordId=rec-a';
const INTRO = "Your attorney asks for this once. You'll share your name and the state that issued your ID. Paralegix doesn't keep a copy of your ID.";

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
function installWallet() {
  credentialsGet = jest.fn();
  (window as unknown as { DigitalCredential?: unknown }).DigitalCredential = class {};
  Object.defineProperty(navigator, 'credentials', { value: { get: credentialsGet }, configurable: true });
}
function startsWalletVerification() {
  api.postExact(START, { status: 201, body: { verificationId: 'ver-1', method: 'mdoc_dcapi', request: { deviceRequest: 'd', encryptionInfo: 'e' } } });
}

beforeEach(() => { process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off'; });
afterEach(() => {
  delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN;
  delete (window as unknown as { DigitalCredential?: unknown }).DigitalCredential;
  Object.defineProperty(navigator, 'credentials', { value: undefined, configurable: true });
  mockAssociation = { clientRecordId: 'rec-a', clientType: 'person' };
});

it('shows a loading state while the status is read', async () => {
  api.getExact(STATUS, { status: 200, body: { configured: true, latest: null }, delayMs: 50 });
  renderWithProviders(<IdentityPage />);

  expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  await screen.findByRole('heading', { level: 1, name: 'Verify your identity' });
});

it('says verification is not available yet when the firm has not configured it', async () => {
  api.getExact(STATUS, { configured: false, latest: null });
  const { container } = renderWithProviders(<IdentityPage />);

  expect(await screen.findByText("Identity verification isn't available yet. Your attorney's office will let you know when it is.")).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect((await scanAccessibility(container)).violations).toEqual([]);
});

it('offers the wallet button with the intro copy when the browser has the Digital Credentials API', async () => {
  installWallet();
  api.getExact(STATUS, { configured: true, latest: null });
  const { container } = renderWithProviders(<IdentityPage />);

  expect(await screen.findByRole('button', { name: "Verify with my phone's wallet" })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1, name: 'Verify your identity' })).toBeInTheDocument();
  expect(screen.getByText(INTRO)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Show QR code' })).not.toBeInTheDocument();
  expect((await scanAccessibility(container)).violations).toEqual([]);
});

it('offers the QR code instead when the browser cannot open a wallet, then waits for the wallet app', async () => {
  api.getExact(STATUS, { configured: true, latest: null });
  api.postExact(START, { status: 201, body: { verificationId: 'ver-9', method: 'w3c_openid4vp', request: { walletUrl: 'openid4vp://authorize?client_id=a&request_uri=b' } } });
  api.postExact('/api/client-portal/lawfirm/firm-a/identity/verifications/ver-9/poll?clientRecordId=rec-a', { status: 202, body: {} });
  const { container } = renderWithProviders(<IdentityPage />);

  await userEvent.click(await screen.findByRole('button', { name: 'Show QR code' }));

  expect(await screen.findByRole('img', { name: 'QR code to open your wallet app' })).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/));
  expect(screen.getByRole('link', { name: 'Open wallet app' })).toHaveAttribute('href', 'openid4vp://authorize?client_id=a&request_uri=b');
  expect(screen.getByText('Waiting for your wallet app...')).toBeInTheDocument();
  expect(api.callsTo('/verifications')[0].body).toEqual({ method: 'w3c_openid4vp' });
  expect(screen.queryByRole('button', { name: "Verify with my phone's wallet" })).not.toBeInTheDocument();
  expect((await scanAccessibility(container)).violations).toEqual([]);
});

it('shows the verified name, issuing state and date from an earlier verification', async () => {
  api.getExact(STATUS, { configured: true, latest: verified() });
  const { container } = renderWithProviders(<IdentityPage />);

  expect(await screen.findByRole('heading', { level: 2, name: "You're verified" })).toBeInTheDocument();
  expect(screen.getByText('Jane Smith')).toBeInTheDocument();
  expect(screen.getByText('California')).toBeInTheDocument();
  expect(screen.getByText('Oct 14, 2026')).toBeInTheDocument();
  expect(screen.queryByText(/contact your attorney's office/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: "Verify with my phone's wallet" })).not.toBeInTheDocument();
  expect((await scanAccessibility(container)).violations).toEqual([]);
});

it('keeps a differing name verified and asks the client to contact the firm', async () => {
  api.getExact(STATUS, { configured: true, latest: verified({ verifiedName: { given: 'Jon', family: 'Smith' }, nameMatchesRecord: false }) });
  const { container } = renderWithProviders(<IdentityPage />);

  expect(await screen.findByRole('heading', { level: 2, name: "You're verified" })).toBeInTheDocument();
  expect(screen.getByText('Jon Smith')).toBeInTheDocument();
  expect(screen.getByText("The name on your ID doesn't match the name your attorney's office has on file. You're still verified, but please contact your attorney's office so they can update their records.")).toBeInTheDocument();
  expect(screen.queryByText("We couldn't verify your ID")).not.toBeInTheDocument();
  expect((await scanAccessibility(container)).violations).toEqual([]);
});

it('verifies with the wallet and shows the result without a reload', async () => {
  installWallet();
  api.getExact(STATUS, { configured: true, latest: null });
  startsWalletVerification();
  api.postExact(COMPLETE, { result: verified() });
  renderWithProviders(<IdentityPage />);
  credentialsGet.mockResolvedValue({ protocol: 'org-iso-mdoc', data: { response: 'r' } });

  await userEvent.click(await screen.findByRole('button', { name: "Verify with my phone's wallet" }));

  expect(await screen.findByRole('heading', { level: 2, name: "You're verified" })).toBeInTheDocument();
  expect(screen.getByText('Jane Smith')).toBeInTheDocument();
  expect(api.callsTo('/identity')).toHaveLength(1);
});

it('shows a checking state while the backend verifies the wallet response', async () => {
  installWallet();
  api.getExact(STATUS, { configured: true, latest: null });
  startsWalletVerification();
  api.postExact(COMPLETE, { status: 200, body: { result: verified() }, delayMs: 100 });
  renderWithProviders(<IdentityPage />);
  credentialsGet.mockResolvedValue({ protocol: 'org-iso-mdoc', data: 'r' });

  await userEvent.click(await screen.findByRole('button', { name: "Verify with my phone's wallet" }));

  expect(await screen.findByText('Checking your ID...')).toBeInTheDocument();
  await screen.findByRole('heading', { level: 2, name: "You're verified" });
});

it('reports a failed check and lets the client try again', async () => {
  installWallet();
  api.getExact(STATUS, { configured: true, latest: null });
  startsWalletVerification();
  api.postExact(COMPLETE, { result: verified({ status: 'failed', verifiedName: null, issuer: null, failureReason: 'Issuer not trusted' }) });
  renderWithProviders(<IdentityPage />);
  credentialsGet.mockResolvedValue({ protocol: 'org-iso-mdoc', data: 'r' });

  await userEvent.click(await screen.findByRole('button', { name: "Verify with my phone's wallet" }));

  expect(await screen.findByRole('heading', { level: 2, name: "We couldn't verify your ID" })).toBeInTheDocument();
  expect(screen.queryByText('Issuer not trusted')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.getByRole('button', { name: "Verify with my phone's wallet" })).toBeInTheDocument();
});

it('reports a cancelled wallet sheet and lets the client try again', async () => {
  installWallet();
  api.getExact(STATUS, { configured: true, latest: null });
  startsWalletVerification();
  renderWithProviders(<IdentityPage />);
  credentialsGet.mockRejectedValue(new DOMException('dismissed', 'NotAllowedError'));

  await userEvent.click(await screen.findByRole('button', { name: "Verify with my phone's wallet" }));

  expect(await screen.findByRole('heading', { level: 2, name: 'Verification cancelled' })).toBeInTheDocument();
  expect(screen.getByText('Nothing was shared. You can try again whenever you are ready.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.getByRole('button', { name: "Verify with my phone's wallet" })).toBeInTheDocument();
});

it.each([
  [429, 'RATE_LIMITED', "You've tried this several times. Please wait a little while, then try again."],
  [502, 'IDENTITY_PROVIDER_ERROR', "The ID check service isn't responding right now. Please try again in a few minutes."],
  [503, 'IDENTITY_PROVIDER_DOMAIN', "Identity verification isn't available right now. Please try again later or contact your attorney's office."],
])('shows friendly copy for a %i and offers a retry', async (status, code, copy) => {
  installWallet();
  api.getExact(STATUS, { configured: true, latest: null });
  api.postExact(START, { status, body: { error: 'Upstream said something technical', code } });
  renderWithProviders(<IdentityPage />);

  await userEvent.click(await screen.findByRole('button', { name: "Verify with my phone's wallet" }));

  expect(await screen.findByText(copy)).toBeInTheDocument();
  expect(screen.queryByText('Upstream said something technical')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /try again/i }));
  await waitFor(() => expect(screen.getByRole('button', { name: "Verify with my phone's wallet" })).toBeInTheDocument());
});

it('explains that verification is for individual clients on an organization account', async () => {
  mockAssociation = { clientRecordId: 'rec-org', clientType: 'company' };
  renderWithProviders(<IdentityPage />);

  expect(await screen.findByText('Identity verification is for individual clients. Switch to your personal account to verify your identity.')).toBeInTheDocument();
  expect(api.calls()).toHaveLength(0);
});
