jest.unmock('@/services/auth.service');
jest.unmock('@/services/privacy.service');
jest.unmock('@/services/requestDeduplicator');

const mockRouter = { push: jest.fn(), replace: jest.fn() };
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null, loading: false }) }));
jest.mock('@/lib/utils/emailVerification', () => ({ isWhitelistedEmail: () => false }));
jest.mock('next/image', () => ({ __esModule: true, default: (props: React.ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => jest.requireActual('react').createElement('img', { ...props, priority: undefined }) }));
jest.mock('firebase/auth', () => ({
  ...jest.requireActual('firebase/auth'),
  createUserWithEmailAndPassword: jest.fn(),
  updateProfile: jest.fn().mockResolvedValue(undefined),
  sendEmailVerification: jest.fn().mockResolvedValue(undefined),
}));

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createUserWithEmailAndPassword, sendEmailVerification } from 'firebase/auth';
import Register from '@/app/register/RegisterClient';
import { setupApiMock } from '../../support/apiMock';
import { scanAccessibility } from '../../support/accessibility';

const api = setupApiMock();
const createUser = jest.mocked(createUserWithEmailAndPassword);
const deleteUser = jest.fn().mockResolvedValue(undefined);

beforeEach(() => {
  jest.clearAllMocks();
  createUser.mockReset();
  createUser.mockResolvedValue({ user: { getIdToken: jest.fn().mockResolvedValue('signup-token'), delete: deleteUser } } as any);
  api.post('/auth/create-user', { user: { id: 'new-user' } });
  api.post('/privacy/accept-terms', { message: 'Accepted', consentVersion: '1' });
});

async function fillForm(password = 'abcdef', confirmation = password) {
  await userEvent.type(screen.getByLabelText('Full Name *'), 'Ada Client');
  await userEvent.type(screen.getByLabelText('Email *'), 'ada@example.test');
  await userEvent.type(screen.getByLabelText('Password *'), password);
  await userEvent.type(screen.getByLabelText('Confirm Password *'), confirmation);
}

it('exposes the page heading, persistent password instructions and keyboard visibility controls', async () => {
  render(<Register />);
  expect(screen.getByRole('main')).toContainElement(screen.getByRole('heading', { level: 1, name: 'Create your account' }));
  expect(screen.getByRole('button', { name: 'Google' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Microsoft' })).toBeInTheDocument();
  const password = screen.getByLabelText('Password *');
  expect(password).toBeRequired();
  expect(password).toHaveAccessibleDescription(/at least 6 characters/);
  password.focus();
  await userEvent.tab();
  expect(screen.getAllByRole('button', { name: 'Show password' })[0]).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  expect(password).toHaveAttribute('type', 'text');
  expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
  screen.getByLabelText('Confirm Password *').focus();
  await userEvent.tab();
  expect(screen.getByRole('button', { name: 'Show password' })).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  expect(screen.getByLabelText('Confirm Password *')).toHaveAttribute('type', 'text');
});

it.each([
  ['abcdef', 'different', 'Confirm Password *', 'Passwords do not match'],
  ['short', 'short', 'Password *', 'Password must be at least 6 characters'],
])('focuses and describes invalid passwords on repeated attempts (%s)', async (password, confirmation, label, message) => {
  render(<Register />);
  await fillForm(password, confirmation);
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(screen.getByRole('button', { name: 'Create Account' }));
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByLabelText(label)).toHaveFocus();
    expect(screen.getByLabelText(label)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(label)).toHaveAccessibleDescription(new RegExp(message));
  }
  expect(createUser).not.toHaveBeenCalled();
  expect(api.callsTo('/auth/create-user')).toHaveLength(0);
});

it.each([
  ['auth/email-already-in-use', 'Email *', 'This email is already registered.'],
  ['auth/weak-password', 'Password *', 'Password is too weak.'],
])('associates a provider rejection with its field and lets a corrected submission reach verification (%s)', async (code, label, message) => {
  createUser.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
  const { container } = render(<Register />);
  await fillForm();
  await userEvent.click(screen.getByRole('button', { name: 'Create Account' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(createUser).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText(label)).toHaveFocus();
  expect(screen.getByLabelText(label)).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText(label)).toHaveAccessibleDescription(new RegExp(message));
  expect((await scanAccessibility(container)).violations).toEqual([]);
  await userEvent.clear(screen.getByLabelText(label));
  await userEvent.type(screen.getByLabelText(label), label === 'Email *' ? 'new@example.test' : 'new-password');
  if (label === 'Password *') {
    await userEvent.clear(screen.getByLabelText('Confirm Password *'));
    await userEvent.type(screen.getByLabelText('Confirm Password *'), 'new-password');
  }
  screen.getByRole('button', { name: 'Create Account' }).focus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/verify-email'));
  expect(api.callsTo('/auth/create-user')[0].body).toEqual({ email: label === 'Email *' ? 'new@example.test' : 'ada@example.test', name: 'Ada Client', userType: 'firm_member' });
  expect(api.callsTo('/privacy/accept-terms')).toHaveLength(1);
  expect(sendEmailVerification).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByLabelText(label)).not.toHaveAttribute('aria-invalid', 'true');
});

it('focuses a backend refusal without marking valid fields invalid and restores focus after dismissal', async () => {
  api.reset();
  api.post('/auth/create-user', { status: 503, body: { error: 'Unavailable' } });
  render(<Register />);
  await fillForm();
  await userEvent.click(screen.getByRole('button', { name: 'Create Account' }));
  const alert = await screen.findByRole('alert');
  expect(api.callsTo('/auth/create-user')).toHaveLength(1);
  expect(deleteUser).toHaveBeenCalledTimes(1);
  expect(alert.parentElement).toHaveFocus();
  expect(screen.getByLabelText('Email *')).not.toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText('Password *')).not.toHaveAttribute('aria-invalid', 'true');
  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create Account' })).toHaveFocus();
  expect(screen.getByLabelText('Full Name *')).toHaveValue('Ada Client');
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('offers sign-in and consent destinations as native links', () => {
  render(<Register />);
  expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms');
  expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
});
