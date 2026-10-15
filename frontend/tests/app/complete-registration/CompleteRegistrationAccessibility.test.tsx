jest.unmock('@/services/auth.service');
jest.unmock('@/services/users.service');
jest.unmock('@/services/privacy.service');
jest.unmock('@/services/requestDeduplicator');

const mockRouter = { replace: jest.fn() };
let mockUser: { uid: string } | null = { uid: 'test-uid' };
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser, loading: false }) }));

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CompleteRegistration from '@/app/complete-registration/page';
import { setupApiMock, sequence } from '../../support/apiMock';
import { scanAccessibility } from '../../support/accessibility';
import { holdResponse } from '../../support/deferred';

const api = setupApiMock();
beforeEach(() => {
  mockUser = { uid: 'test-uid' };
  mockRouter.replace.mockReset();
});

it('announces the initial profile check and focuses the main heading when the form becomes available', async () => {
  let release!: () => void;
  api.getExact('/api/users/profile', async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return { id: 'pending-user', userType: 'pending' };
  });
  const { container } = render(<CompleteRegistration />);
  await waitFor(() => expect(api.callsTo('/users/profile')).toHaveLength(1));
  try {
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Checking registration status...');
    expect(screen.getByRole('main')).toContainElement(status);
  } finally {
    await act(async () => release());
  }
  const heading = await screen.findByRole('heading', { level: 1, name: 'Complete Your Registration' });
  expect(screen.getByRole('main')).toContainElement(heading);
  expect(heading).toHaveFocus();
  await userEvent.tab();
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus();
  expect((await scanAccessibility(container)).violations).toEqual([]);
});

it('focuses repeated refusals, restores focus on dismissal and completes a keyboard retry through the real service', async () => {
  api.getExact('/api/users/profile', sequence({ id: 'pending-user', userType: 'pending' }, { id: 'pending-user', userType: 'firm_member' }));
  api.post('/auth/complete-registration', sequence(
    { status: 403, body: { error: 'Registration refused' } },
    { status: 403, body: { error: 'Registration refused' } },
    { userData: { id: 'pending-user', userType: 'firm_member' } },
  ));
  api.post('/privacy/accept-terms', { message: 'Accepted', consentVersion: '1' });
  render(<CompleteRegistration />);
  await screen.findByRole('button', { name: 'Continue' });
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Registration refused');
    expect(api.callsTo('/auth/complete-registration')).toHaveLength(attempt + 1);
    expect(alert.parentElement).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(api.callsTo('/privacy/accept-terms')).toHaveLength(0);
  }
  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/dashboard'));
  expect(api.callsTo('/auth/complete-registration')).toHaveLength(3);
  for (const request of api.callsTo('/auth/complete-registration')) {
    expect(request.body).toEqual({ token: 'mock-token', userType: 'firm_member' });
  }
  expect(api.callsTo('/privacy/accept-terms')).toHaveLength(1);
  expect(api.callsTo('/users/profile')).toHaveLength(2);
});

it('announces completion progress while keeping the workspace information in place', async () => {
  api.getExact('/api/users/profile', sequence({ userType: 'pending' }, { userType: 'firm_member' }));
  let release!: () => void;
  api.post('/auth/complete-registration', async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return { userData: { userType: 'firm_member' } };
  });
  api.post('/privacy/accept-terms', { message: 'Accepted' });
  render(<CompleteRegistration />);
  await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(api.callsTo('/auth/complete-registration')).toHaveLength(1));
  try {
    expect(screen.getByRole('status')).toHaveTextContent('Completing registration...');
    expect(screen.getByRole('button', { name: 'Completing Registration...' })).toBeDisabled();
    expect(screen.getByText('Law Firm workspace')).toBeInTheDocument();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  } finally {
    await act(async () => release());
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/dashboard'));
  }
});

it.each([
  ['client', '/client/dashboard'],
  ['firm_member', '/dashboard'],
])('keeps an already registered %s out of the enrollment form', async (userType, destination) => {
  api.getExact('/api/users/profile', { userType });
  render(<CompleteRegistration />);
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(destination));
  expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
  expect(api.callsTo('/auth/complete-registration')).toHaveLength(0);
});

it('sends a signed-out visitor to login without querying or completing a profile', async () => {
  mockUser = null;
  render(<CompleteRegistration />);
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/login'));
  expect(api.calls()).toHaveLength(0);
});

// Lets every pending fetch, JSON parse and state update triggered by a released
// response settle, so an assertion that nothing happened runs after the stale
// path has had its chance to act.
async function settle(ms = 0) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
}

it('announces and focuses a failed initial profile check on every attempt, then retries it into the redirect', async () => {
  api.getExact('/api/users/profile', sequence(
    { status: 500, body: { error: 'Profile unavailable' } },
    { status: 500, body: { error: 'Profile unavailable' } },
    { userType: 'firm_member' },
  ));
  const { container } = render(<CompleteRegistration />);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.callsTo('/users/profile')).toHaveLength(attempt + 1));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't check your registration status");
    await waitFor(() => expect(alert.parentElement).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  }
  expect((await scanAccessibility(container)).violations).toEqual([]);
  expect(mockRouter.replace).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/dashboard'));
  expect(api.callsTo('/users/profile')).toHaveLength(3);
  expect(api.callsTo('/auth/complete-registration')).toHaveLength(0);
});

it('clears a failed initial check and focuses the form heading once a retry finds a pending profile', async () => {
  api.getExact('/api/users/profile', sequence(
    { status: 500, body: { error: 'Profile unavailable' } },
    { userType: 'pending' },
  ));
  render(<CompleteRegistration />);
  await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(api.callsTo('/users/profile')).toHaveLength(2);
  expect(screen.getByRole('heading', { level: 1, name: 'Complete Your Registration' })).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('does not apply a profile check that resolves after the user signed out', async () => {
  const held = holdResponse();
  api.getExact('/api/users/profile', held.handler);
  const view = render(<CompleteRegistration />);
  await held.untilRequested();
  mockUser = null;
  view.rerender(<CompleteRegistration />);
  expect(mockRouter.replace).toHaveBeenCalledWith('/login');
  await act(async () => held.release({ userType: 'firm_member' }));
  await settle();
  expect(mockRouter.replace.mock.calls).toEqual([['/login']]);
});

it('abandons an in-flight registration for an identity that signed out before it finished', async () => {
  api.getExact('/api/users/profile', sequence({ userType: 'pending' }, { userType: 'firm_member' }));
  const held = holdResponse();
  api.post('/auth/complete-registration', held.handler);
  api.post('/privacy/accept-terms', { message: 'Accepted' });
  const view = render(<CompleteRegistration />);
  await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
  await held.untilRequested();
  mockUser = null;
  view.rerender(<CompleteRegistration />);
  expect(mockRouter.replace).toHaveBeenCalledWith('/login');
  await act(async () => held.release({ userData: { userType: 'firm_member' } }));
  // One full poll interval (500ms) passes, long enough for the unguarded flow to
  // record terms, confirm the profile and redirect to the dashboard.
  await settle(700);
  expect(api.callsTo('/privacy/accept-terms')).toHaveLength(0);
  expect(api.callsTo('/users/profile')).toHaveLength(1);
  expect(mockRouter.replace.mock.calls).toEqual([['/login']]);
});

it('still continues to the dashboard after the profile poll gives up on ten unconfirmed reads', async () => {
  api.getExact('/api/users/profile', { userType: 'pending' });
  api.post('/auth/complete-registration', { userData: { userType: 'firm_member' } });
  api.post('/privacy/accept-terms', { message: 'Accepted' });
  render(<CompleteRegistration />);
  const continueButton = await screen.findByRole('button', { name: 'Continue' });
  jest.useFakeTimers();
  try {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.click(continueButton);
    await waitFor(() => expect(api.callsTo('/privacy/accept-terms')).toHaveLength(1));
    for (let poll = 1; poll <= 10; poll++) {
      expect(mockRouter.replace).not.toHaveBeenCalled();
      await act(async () => { jest.advanceTimersByTime(500); });
      await waitFor(() => expect(api.callsTo('/users/profile')).toHaveLength(poll + 1));
    }
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/dashboard'));
    expect(api.callsTo('/users/profile')).toHaveLength(11);
  } finally { jest.clearAllTimers(); jest.useRealTimers(); }
});

it('stops polling for an identity that switched accounts while the poll was waiting', async () => {
  // Initial check, then the new account's own check: both pending, so neither
  // redirects. A poll read the stale flow makes after the switch would get the
  // confirmed profile and send the new account to the dashboard.
  api.getExact('/api/users/profile', sequence({ userType: 'pending' }, { userType: 'pending' }, { userType: 'firm_member' }));
  api.post('/auth/complete-registration', { userData: { userType: 'firm_member' } });
  api.post('/privacy/accept-terms', { message: 'Accepted' });
  const view = render(<CompleteRegistration />);
  await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(api.callsTo('/privacy/accept-terms')).toHaveLength(1));
  // Inside the 500ms wait before the first poll read.
  await settle(50);
  expect(api.callsTo('/users/profile')).toHaveLength(1);
  mockUser = { uid: 'other-uid' };
  view.rerender(<CompleteRegistration />);
  await settle(700);
  // Only the new account's own status check read the profile.
  expect(api.callsTo('/users/profile')).toHaveLength(2);
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('ignores a poll read that confirms the profile after the user signed out', async () => {
  // Signed out rather than switched: a second account's status check would
  // share this in-flight profile read and legitimately act on its answer.
  const pollRead = holdResponse();
  api.getExact('/api/users/profile', sequence({ userType: 'pending' }, pollRead.handler));
  api.post('/auth/complete-registration', { userData: { userType: 'firm_member' } });
  api.post('/privacy/accept-terms', { message: 'Accepted' });
  const view = render(<CompleteRegistration />);
  await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
  await pollRead.untilRequested();
  mockUser = null;
  view.rerender(<CompleteRegistration />);
  expect(mockRouter.replace).toHaveBeenCalledWith('/login');
  await act(async () => pollRead.release({ userType: 'firm_member' }));
  await settle();
  expect(api.callsTo('/users/profile')).toHaveLength(2);
  expect(mockRouter.replace.mock.calls).toEqual([['/login']]);
});

it('shows no error for a registration that fails after the identity switched accounts', async () => {
  api.getExact('/api/users/profile', { userType: 'pending' });
  const held = holdResponse();
  api.post('/auth/complete-registration', held.handler);
  const view = render(<CompleteRegistration />);
  await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
  await held.untilRequested();
  mockUser = { uid: 'other-uid' };
  view.rerender(<CompleteRegistration />);
  // The new account's own status check has run and settled.
  await waitFor(() => expect(api.callsTo('/users/profile')).toHaveLength(2));
  await settle();
  await act(async () => held.release({ status: 403, body: { error: 'Registration refused' } }));
  await settle();
  expect(api.callsTo('/auth/complete-registration')).toHaveLength(1);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText('Registration refused')).not.toBeInTheDocument();
});
