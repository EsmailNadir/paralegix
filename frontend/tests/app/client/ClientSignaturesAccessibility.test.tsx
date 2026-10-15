jest.unmock('@/services/signatures.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@/lib/supabase/realtimeClient', () => ({ authorizeRealtime: jest.fn().mockResolvedValue(null), getRealtimeClient: jest.fn(), retainRealtime: jest.fn(), releaseRealtime: jest.fn(), onRealtimeResume: jest.fn(() => () => {}) }));
const mockUser = { uid: 'test-uid' };
const mockNavigate = jest.fn();
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('next/navigation', () => ({ useParams: () => ({ lawFirmId: 'firm-a' }) }));
jest.mock('@/contexts/NavigationContext', () => ({ useNavigation: () => ({ navigate: mockNavigate }) }));
import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Signatures from '@/app/client/lawfirm/[lawFirmId]/signatures/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock } from '../../support/apiMock';
const api = setupApiMock();
it('distinguishes signing destinations by document and retains the encoded participant token', async () => {
  api.get('/signing/pending-for-client', { pendingDocuments: [
    { sessionToken: 'session-a', publicToken: 'participant/a', lawFirmId: 'firm-a', fileName: 'Agreement.pdf', participantRole: 'signer', totalParticipants: 2, completedParticipants: 1 },
    { sessionToken: 'session-b', publicToken: 'participant-b', lawFirmId: 'firm-a', fileName: 'Disclosure.pdf', participantRole: 'signer', totalParticipants: 1, completedParticipants: 0 },
  ], totalItems: 2 });
  renderWithProviders(<Signatures />);
  const link = await screen.findByRole('link', { name: 'Review and sign Agreement.pdf' });
  expect(link).toHaveAttribute('href', '/signature?token=participant%2Fa');
  expect(screen.getByRole('link', { name: 'Review and sign Disclosure.pdf' })).toHaveAttribute('href', '/signature?token=participant-b');
  link.focus();
  await userEvent.keyboard('{Enter}');
  expect(mockNavigate).toHaveBeenCalledWith('/signature?token=participant%2Fa');
  expect(api.callsTo('/signing/pending-for-client')[0].url).toContain('lawFirmId=firm-a');
});
