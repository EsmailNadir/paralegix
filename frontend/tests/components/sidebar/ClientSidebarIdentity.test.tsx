/**
 * The portal nav's "Identity" entry.
 *
 * Red if the entry disappears for a person client, points anywhere but the
 * firm's identity page, or is offered on an organization link (which has no
 * personal ID to verify and would only reach a dead end).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'u', displayName: 'Test', email: 't@example.com' }, loading: false }) }));
jest.mock('@/hooks/useUnreadCount', () => ({ useUnreadCount: () => ({ unreadCount: 0 }) }));
jest.mock('@/contexts/ProfileContext', () => ({ useProfile: () => ({ profile: null }) }));
jest.mock('@/components/notificationComp/ClientNotificationBell', () => ({ __esModule: true, default: () => null }));

import ClientSidebar from '@/components/sidebar/ClientSidebar';

const person = { clientRecordId: 'rec-p', clientType: 'person' as const, clientName: 'Jane', companyLinkId: null, canViewBilling: true };
const company = { clientRecordId: 'rec-c', clientType: 'company' as const, clientName: 'Acme', companyLinkId: 'link-1', canViewBilling: true };

it('links a person client to the identity page', () => {
  render(<ClientSidebar lawFirmId="firm-1" associations={[person]} activeClientRecordId="rec-p" />);

  const links = screen.getAllByRole('link', { name: /Identity/ });
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) expect(link).toHaveAttribute('href', '/client/lawfirm/firm-1/identity');
});

it('links the identity page while the active association is still unresolved', () => {
  render(<ClientSidebar lawFirmId="firm-1" />);

  expect(screen.getAllByRole('link', { name: /Identity/ }).length).toBeGreaterThan(0);
});

it('hides the entry on an organization link', () => {
  render(<ClientSidebar lawFirmId="firm-1" associations={[company, person]} activeClientRecordId="rec-c" />);

  expect(screen.queryByRole('link', { name: /Identity/ })).not.toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: /My Matters/ }).length).toBeGreaterThan(0);
});
