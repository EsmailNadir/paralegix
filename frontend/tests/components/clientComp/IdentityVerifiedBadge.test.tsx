/**
 * The firm's "ID verified" badge on a client, through the real service and the
 * firm route with only the transport faked.
 *
 * Red if: a verified client loses the green badge, its date or its issuing
 * jurisdiction; the check list disappears from the tooltip or shows raw keys;
 * a differing name is shown as plain "ID verified" instead of amber "Verified,
 * name differs"; or anything renders for a client who was never verified (a
 * failed attempt alone, or a refused read).
 */
jest.unmock('@/services/identityVerification.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IdentityVerifiedBadge from '@/components/clientComp/IdentityVerifiedBadge';
import { STATUS_VARIANTS } from '@/constants/statusMeta';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock } from '../../support/apiMock';
import { scanAccessibility } from '../../support/accessibility';
import type { VerificationResult } from '@/types/identityVerification';

const api = setupApiMock();
const URL = '/api/lawfirms/firm-a/clients/client-1/identity-verification';

const result = (overrides: Partial<VerificationResult> = {}): VerificationResult => ({
  verificationId: 'ver-1',
  method: 'mdoc_dcapi',
  status: 'verified',
  verifiedName: { given: 'Jane', family: 'Smith' },
  issuer: 'California',
  docType: 'org.iso.18013.5.1.mDL',
  credentialExpiresOn: '2030-01-01',
  nameMatchesRecord: true,
  checks: { issuerSignedAuthenticated: true, deviceSignedAuthenticated: true, issuerRecognized: false },
  failureReason: null,
  createdAt: '2026-10-14T16:00:00.000Z',
  completedAt: '2026-10-14T16:01:00.000Z',
  ...overrides,
});

const render = () => renderWithProviders(<IdentityVerifiedBadge lawFirmId="firm-a" clientId="client-1" />);

it('shows a green badge with the verification date and issuing jurisdiction', async () => {
  api.getExact(URL, { verified: result(), latestAttempt: result() });
  const { container } = render();

  const badge = await screen.findByText('ID verified Oct 14, 2026 · California');
  expect(badge).toHaveClass(STATUS_VARIANTS.success.text);
  expect(screen.queryByText('Verified, name differs')).not.toBeInTheDocument();
  expect((await scanAccessibility(container)).violations).toEqual([]);
});

it('lists the checks in its tooltip with readable labels', async () => {
  api.getExact(URL, { verified: result(), latestAttempt: result() });
  render();

  await userEvent.hover(await screen.findByText('ID verified Oct 14, 2026 · California'));

  const tooltip = await screen.findByRole('tooltip');
  expect(tooltip).toHaveTextContent('Issuer signature valid: passed');
  expect(tooltip).toHaveTextContent('Device signature valid: passed');
  expect(tooltip).toHaveTextContent('Issuer recognized: failed');
  expect(tooltip).not.toHaveTextContent('issuerSignedAuthenticated');
});

it('shows an amber "Verified, name differs" badge when the name does not match the record', async () => {
  api.getExact(URL, { verified: result({ nameMatchesRecord: false }), latestAttempt: null });
  render();

  const badge = await screen.findByText('Verified, name differs');
  expect(badge).toHaveClass(STATUS_VARIANTS.warning.text);
  expect(screen.queryByText(/ID verified/)).not.toBeInTheDocument();
});

it('renders nothing for a client who was never verified, even after a failed attempt', async () => {
  api.getExact(URL, { verified: null, latestAttempt: result({ status: 'failed', verifiedName: null }) });
  const { container } = render();

  await waitFor(() => expect(api.callsTo('/identity-verification')).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(container).toBeEmptyDOMElement();
});

it('renders nothing when the read is refused', async () => {
  api.getExact(URL, { status: 403, body: { error: 'Forbidden' } });
  const { container } = render();

  await waitFor(() => expect(api.callsTo('/identity-verification')).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(container).toBeEmptyDOMElement();
});
