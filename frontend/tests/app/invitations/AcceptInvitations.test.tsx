const mockRouter = { push: jest.fn(), replace: jest.fn() };
let mockQuery = new URLSearchParams('token=invite-a');
let mockUser: { uid: string } | null = { uid: 'test-uid' };
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter, useSearchParams: () => mockQuery }));
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser, loading: false }) }));

import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ClientInvite from '@/app/accept-invite/AcceptInvitePageClient';
import MemberInvite from '@/app/accept-member-invite/page';
import { setupApiMock, sequence } from '../../support/apiMock';
import { holdResponse } from '../../support/deferred';
import { renderWithProviders } from '../../support/renderWithProviders';

const api = setupApiMock();
const invitation = { invitation: { lawFirmName: 'Inviting Firm' } };
beforeEach(() => {
  mockQuery = new URLSearchParams('token=invite-a'); mockUser = { uid: 'test-uid' };
  mockRouter.push.mockReset(); mockRouter.replace.mockReset();
  process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off';
});
afterEach(() => { delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN; });

describe.each([
  { name: 'client', Page: ClientInvite, path: '/api/invitations/accept', destination: '/client/dashboard', payload: { token: 'invite-a' } },
  { name: 'member', Page: MemberInvite, path: '/api/invitations/member-accept', destination: '/lawfirm/firm-b/matters', payload: { token: 'invite-a', confirmSwitch: false } },
])('$name invitation', ({ Page, path, destination, payload }) => {
  it('preserves the invitation token through sign-in and account creation', async () => {
    mockUser = null;
    api.getExact(`${path}/invite-a`, invitation);
    renderWithProviders(<Page />);
    const link = await screen.findByRole('link', { name: 'Go to sign in' });
    expect(new URL(link.getAttribute('href')!, 'http://localhost').searchParams.get('redirect')).toContain('token=invite-a');
    expect(screen.getByRole('link', { name: 'Create account' }).getAttribute('href')).toContain('token=invite-a');
    expect(api.calls('POST')).toHaveLength(0);
  });

  it('renders an expired link without attempting acceptance', async () => {
    api.getExact(`${path}/invite-a`, { status: 410, body: { error: 'Invitation expired' } });
    renderWithProviders(<Page />);
    expect(await screen.findByText('Invitation expired')).toBeInTheDocument();
    expect(api.calls('GET')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Accept Invitation' })).not.toBeInTheDocument();
  });

  it('keeps the loaded invitation available after a wrong-account refusal', async () => {
    api.getExact(`${path}/invite-a`, invitation);
    api.postExact(path, { status: 403, body: { error: 'Sign in with the invited account' } });
    renderWithProviders(<Page />);
    await userEvent.click(await screen.findByRole('button', { name: 'Accept Invitation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in with the invited account');
    expect(screen.getByText('Inviting Firm')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept Invitation' })).toBeEnabled();
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(api.calls('POST')[0].body).toEqual(payload);
  });

  it('submits once while acceptance is pending and navigates after success', async () => {
    const pending = holdResponse();
    api.getExact(`${path}/invite-a`, invitation);
    api.postExact(path, pending.handler);
    renderWithProviders(<Page />);
    await userEvent.click(await screen.findByRole('button', { name: 'Accept Invitation' }));
    await pending.untilRequested();
    await userEvent.click(screen.getByRole('button', { name: 'Accepting...' }));
    expect(api.calls('POST')).toHaveLength(1);
    expect(mockRouter.push).not.toHaveBeenCalled();
    await act(async () => pending.release({ lawFirmId: 'firm-b' }));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(destination));
  });
});

it('requires explicit confirmation before leaving the current firm', async () => {
  api.getExact('/api/invitations/member-accept/invite-a', invitation);
  api.postExact('/api/invitations/member-accept', sequence(
    { status: 409, body: { code: 'FIRM_SWITCH_REQUIRED', details: { currentFirms: [{ name: 'Old Firm', willBeDeleted: true }] } } },
    { lawFirmId: 'firm-b' },
  ));
  renderWithProviders(<MemberInvite />);
  await userEvent.click(await screen.findByRole('button', { name: 'Accept Invitation' }));
  expect(await screen.findByText('Old Firm')).toBeInTheDocument();
  expect(screen.getByText(/leaving will schedule it for deletion/)).toBeInTheDocument();
  expect(api.calls('POST')).toHaveLength(1);
  expect(mockRouter.push).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Leave and Join' }));
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/lawfirm/firm-b/matters'));
  expect(api.calls('POST').map((call) => call.body)).toEqual([
    { token: 'invite-a', confirmSwitch: false }, { token: 'invite-a', confirmSwitch: true },
  ]);
});

it('explains a member seat limit without flattening provider details into the message', async () => {
  api.getExact('/api/invitations/member-accept/invite-a', invitation);
  api.postExact('/api/invitations/member-accept', { status: 403, body: {
    code: 'PLAN_LIMIT_REACHED', details: { resource: 'maxMembers', current: 3, limit: 3, planId: 'starter' },
  } });
  renderWithProviders(<MemberInvite />);
  await userEvent.click(await screen.findByRole('button', { name: 'Accept Invitation' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Ask whoever invited you to free up a seat or upgrade');
  expect(screen.getByRole('alert')).not.toHaveTextContent('maxMembers');
});

it('redirects an already processed client invitation without posting it again', async () => {
  api.getExact('/api/invitations/accept/invite-a', { invitation: { alreadyProcessed: true } });
  renderWithProviders(<ClientInvite />);
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/client/dashboard'));
  expect(api.calls('POST')).toHaveLength(0);
});

it('redirects an already processed member invitation to its confirmed firm', async () => {
  api.getExact('/api/invitations/member-accept/invite-a', { invitation: { alreadyProcessed: true, lawFirmId: 'firm-b' } });
  renderWithProviders(<MemberInvite />);
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/lawfirm/firm-b/matters'));
  expect(api.calls('POST')).toHaveLength(0);
});


it('focuses a client acceptance refusal on every attempt, then allows a successful retry', async () => {
  api.getExact('/api/invitations/accept/invite-a', invitation);
  api.postExact('/api/invitations/accept', sequence(
    { status: 403, body: { error: 'Sign in with the invited account' } },
    { status: 403, body: { error: 'Sign in with the invited account' } },
    { accepted: true },
  ));
  renderWithProviders(<ClientInvite />);
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(await screen.findByRole('button', { name: 'Accept Invitation' }));
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(alert.parentElement).toHaveFocus());
    expect(alert).toHaveTextContent('Sign in with the invited account');
  }
  expect(api.calls('POST')).toHaveLength(2);
  expect(mockRouter.push).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Accept Invitation' }));
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/client/dashboard'));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('announces the client invitation lookup as a status, then focuses the expired-link heading', async () => {
  const held = holdResponse();
  api.getExact('/api/invitations/accept/invite-a', held.handler);
  renderWithProviders(<ClientInvite />);
  await held.untilRequested();
  expect(screen.getByRole('status')).toHaveTextContent('Loading...');
  expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  await act(async () => held.release({ status: 410, body: { error: 'Invitation expired' } }));
  const heading = await screen.findByRole('heading', { name: 'This client invitation is no longer valid', level: 1 });
  expect(heading).toHaveFocus();
  expect(screen.getByRole('main')).toContainElement(heading);
  expect(screen.getByText('Invitation expired')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Back to login' })).toHaveAttribute('href', '/login');
  expect(api.calls('POST')).toHaveLength(0);
});

it('focuses the invalid-link heading at once when the client invitation token is missing', () => {
  mockQuery = new URLSearchParams('');
  renderWithProviders(<ClientInvite />);
  expect(screen.getByRole('heading', { name: 'This client invitation is no longer valid', level: 1 })).toHaveFocus();
  expect(api.calls()).toHaveLength(0);
});
