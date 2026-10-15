/**
 * Where the login page actually sends a user, given an attacker-controllable
 * `next` parameter.
 *
 * `sanitizeNextPath` and `resolveLoginDestination` each have their own unit
 * tests. Neither proves the login page CALLS them, and a validator its only
 * caller ignores is an open redirect with a green test suite. So both stay real
 * here, along with the whole redirect module and the services beneath it; only
 * the Firebase-facing pieces and the network are faked.
 *
 * The open-redirect cases are the reason this file exists. Anyone can mail a
 * victim a `/login?next=https://evil.example` link, and a login page that honors
 * it turns the product's own sign-in into a credible phishing hop.
 */
jest.unmock('@/services/users.service');
jest.unmock('@/services/requestDeduplicator');

const mockRouterReplace = jest.fn();
const mockRouterPush = jest.fn();
const mockRouter = {
  replace: mockRouterReplace,
  push: mockRouterPush,
  back: jest.fn(),
  forward: jest.fn(),
  refresh: jest.fn(),
  prefetch: jest.fn(),
};
let mockSearch = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearch,
  usePathname: () => '/login',
  useParams: () => ({}),
}));

jest.mock('@/hooks/useAuth', () => ({ __esModule: true, useAuth: jest.fn() }));

// Firebase itself, and the two helpers that talk to it. Everything between them
// and the router stays real, which is the point of the file.
jest.mock('@/services/auth.service', () => ({
  __esModule: true,
  default: {
    signIn: jest.fn(),
    signInWithGoogle: jest.fn(),
    signInWithMicrosoft: jest.fn(),
    checkRegistrationStatus: jest.fn(),
    sendPasswordReset: jest.fn(),
    forgotPassword: jest.fn(),
  },
}));
// Spread the real modules and replace only the two functions that talk to
// Firebase. Replacing the whole module drops `getFirebaseToken`, which every
// service reaches for when it builds its auth header, and the service layer
// then fails in a way that looks like a routing decision.
jest.mock('@/lib/utils/auth', () => ({
  ...jest.requireActual('@/lib/utils/auth'),
  __esModule: true,
  clearTokenCache: jest.fn(),
  refreshToken: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/utils/emailVerification', () => ({
  ...jest.requireActual('@/lib/utils/emailVerification'),
  __esModule: true,
  reloadAndCheckVerified: jest.fn(),
}));

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import LoginClient from '@/app/login/LoginClient';
import { useAuth } from '@/hooks/useAuth';
import authService from '@/services/auth.service';
import { reloadAndCheckVerified } from '@/lib/utils/emailVerification';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { setupApiMock } from '../../support/apiMock';
import { deferred } from '../../support/deferred';
import { scanAccessibility } from '../../support/accessibility';

const useAuthMock = useAuth as jest.Mock;
const signInMock = authService.signIn as jest.Mock;
const registrationStatusMock = authService.checkRegistrationStatus as jest.Mock;
const verifiedMock = reloadAndCheckVerified as jest.Mock;

const OWN_FIRM = '11111111-1111-4111-8111-111111111111';
const OTHER_FIRM = '22222222-2222-4222-8222-222222222222';

const api = setupApiMock();

/** The signed-out page, before any credential is entered. */
function renderSignedOut(next?: string) {
  mockSearch = new URLSearchParams(next === undefined ? '' : `next=${encodeURIComponent(next)}`);
  useAuthMock.mockReturnValue({ user: null, loading: false });
  return render(<LoginClient />);
}

/** A page that mounts with a session already present, as a deep link does. */
function renderSignedIn(next?: string) {
  mockSearch = new URLSearchParams(next === undefined ? '' : `next=${encodeURIComponent(next)}`);
  useAuthMock.mockReturnValue({
    user: { uid: 'user-1', email: 'ada@example.test', emailVerified: true },
    loading: false,
  });
  return render(<LoginClient />);
}

async function signInWithPassword() {
  await userEvent.type(screen.getByPlaceholderText('you@example.com'), 'ada@example.test');
  await userEvent.type(screen.getByPlaceholderText('Enter your password'), 'correct horse');
  await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
}

beforeEach(() => {
  __resetDuplicateRequestGuard();
  verifiedMock.mockResolvedValue('verified');
  registrationStatusMock.mockResolvedValue({ needsRegistration: false });
  signInMock.mockResolvedValue({});
  api.getExact('/api/users/profile', { id: 'user-1', userType: 'firm_member' });
  api.getExact('/api/users/my-lawfirms', { lawFirmIds: [OWN_FIRM] });
  api.getExact(`/api/lawfirms/${OWN_FIRM}/subscriptions/status`, { billingStatus: 'active' });
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('a hostile `next` never reaches the router', () => {
  it.each([
    ['an absolute https url', 'https://evil.example/harvest'],
    ['a protocol-relative host', '//evil.example/harvest'],
    ['a backslash-smuggled host', '/\\evil.example/harvest'],
    ['a javascript uri', 'javascript:alert(1)'],
  ])('drops %s and uses the account\'s own destination', async (_label, hostile) => {
    renderSignedOut(hostile);
    await signInWithPassword();

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalled());
    // Every argument, not just the last: a page that navigated somewhere hostile
    // and then corrected itself has still navigated somewhere hostile.
    for (const [target] of mockRouterReplace.mock.calls) {
      expect(target).toBe(`/lawfirm/${OWN_FIRM}`);
    }
  });

  it('drops a `next` pointing back at the login page, so sign-in cannot loop', async () => {
    renderSignedOut('/login?next=%2Flogin');
    await signInWithPassword();

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith(`/lawfirm/${OWN_FIRM}`));
  });
});

describe('a legitimate `next`', () => {
  it('carries a deep link into a firm this account belongs to, query string intact', async () => {
    renderSignedOut(`/lawfirm/${OWN_FIRM}/matters?status=open`);
    await signInWithPassword();

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith(
      `/lawfirm/${OWN_FIRM}/matters?status=open`,
    ));
  });

  it('refuses a deep link into a firm this account does not belong to', async () => {
    renderSignedOut(`/lawfirm/${OTHER_FIRM}/matters`);
    await signInWithPassword();

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith(`/lawfirm/${OWN_FIRM}`));
    expect(mockRouterReplace).not.toHaveBeenCalledWith(`/lawfirm/${OTHER_FIRM}/matters`);
  });

  it('takes a non-firm path as given without asking who the account belongs to', async () => {
    renderSignedOut('/account/profile');
    await signInWithPassword();

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/account/profile'));
    expect(api.callsTo('/users/my-lawfirms')).toHaveLength(0);
  });
});

describe('states that outrank the deep link', () => {
  it('sends an unverified account to verification and never to `next`', async () => {
    verifiedMock.mockResolvedValue('not-verified');
    renderSignedOut(`/lawfirm/${OWN_FIRM}/matters`);
    await signInWithPassword();

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/verify-email'));
    expect(mockRouterReplace).not.toHaveBeenCalledWith(`/lawfirm/${OWN_FIRM}/matters`);
  });

  it('sends an account that still needs registration to finish it, keeping `next` unused', async () => {
    registrationStatusMock.mockResolvedValue({ needsRegistration: true });
    renderSignedIn(`/lawfirm/${OWN_FIRM}/matters`);

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/complete-registration'));
    expect(mockRouterReplace).not.toHaveBeenCalledWith(`/lawfirm/${OWN_FIRM}/matters`);
  });
});

describe('a sign-in that fails', () => {
  it('reports the failure and navigates nowhere at all', async () => {
    signInMock.mockRejectedValue(
      Object.assign(new Error('bad'), { code: 'auth/invalid-credential' }),
    );
    renderSignedOut(`/lawfirm/${OWN_FIRM}/matters`);
    await signInWithPassword();

    await waitFor(() => expect(screen.getByText(/invalid email or password/i)).toBeInTheDocument());
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });
});

describe('a session that is already present when the page mounts', () => {
  it('honors the deep link without waiting for a credential', async () => {
    renderSignedIn(`/lawfirm/${OWN_FIRM}/matters`);

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith(
      `/lawfirm/${OWN_FIRM}/matters`,
    ));
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('still drops a hostile deep link on that same path', async () => {
    renderSignedIn('https://evil.example/harvest');

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith(`/lawfirm/${OWN_FIRM}`));
    for (const [target] of mockRouterReplace.mock.calls) {
      expect(target).toBe(`/lawfirm/${OWN_FIRM}`);
    }
  });
});


describe('accessible login feedback', () => {
  it('lets the keyboard open password recovery and focuses the replacement email field', async () => {
    renderSignedOut();
    const email = screen.getByLabelText('Email *');
    email.focus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Forgot password?' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Send Reset Email' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Reset your password' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email *')).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(screen.getByLabelText('Email *')).toHaveFocus();
  });

  it('focuses failed authentication feedback and connects the credentials to it', async () => {
    signInMock.mockRejectedValue(Object.assign(new Error('bad'), { code: 'auth/invalid-credential' }));
    renderSignedOut();
    await signInWithPassword();
    const alert = await screen.findByRole('alert');
    expect(alert.parentElement).toHaveFocus();
    expect(screen.getByLabelText('Email *')).toHaveAccessibleDescription(/invalid email or password/i);
    expect(screen.getByLabelText('Password *')).toHaveAccessibleDescription(/invalid email or password/i);
  });

  it('announces recovery success and returns keyboard focus to sign-in', async () => {
    (authService.forgotPassword as jest.Mock).mockResolvedValueOnce(undefined);
    renderSignedOut();
    await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await userEvent.type(screen.getByLabelText('Email *'), 'ada@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send Reset Email' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Password reset email sent!');
    expect(authService.forgotPassword).toHaveBeenCalledWith('ada@example.test');
    expect(screen.getByLabelText('Email *')).toHaveFocus();
  });
});


it('reports a recovery network failure without marking a valid email invalid', async () => {
  (authService.forgotPassword as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'auth/network-request-failed' }));
  renderSignedOut();
  await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
  await userEvent.type(screen.getByLabelText('Email *'), 'ada@example.test');
  await userEvent.click(screen.getByRole('button', { name: 'Send Reset Email' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Network error');
  expect(authService.forgotPassword).toHaveBeenCalledWith('ada@example.test');
  expect(screen.getByLabelText('Email *')).not.toHaveAttribute('aria-invalid', 'true');
  expect(alert.parentElement).toHaveFocus();
});

const googleMock = authService.signInWithGoogle as jest.Mock;
const microsoftMock = authService.signInWithMicrosoft as jest.Mock;
const firebaseError = (code: string) => Object.assign(new Error(code), { code });

/** The polite status region the page announces through (it also carries reset-email success). */
function statusRegion() {
  return screen.getByRole('status');
}

describe.each([
  { provider: 'Google', mock: () => googleMock },
  { provider: 'Microsoft', mock: () => microsoftMock },
])('$provider pop-up sign-in', ({ provider, mock }) => {
  it.each(['auth/popup-closed-by-user', 'auth/cancelled-popup-request'])(
    'exposes the open pop-up as busy, then announces %s as a cancellation and returns focus to the provider',
    async (code) => {
      const popup = deferred<never>();
      mock().mockReturnValueOnce(popup.promise);
      renderSignedOut();
      await userEvent.click(screen.getByRole('button', { name: provider }));

      const busy = await screen.findByRole('button', { name: 'Signing in...' });
      expect(busy).toBeDisabled();
      expect(busy).toHaveAttribute('aria-busy', 'true');
      expect(statusRegion()).toHaveTextContent(`Signing in with ${provider}...`);
      expect(screen.getByRole('button', { name: 'Sign In' })).toBeDisabled();
      // A browser drops focus from a control as it becomes disabled. jsdom keeps
      // it there and refuses to blur a disabled control, so park focus on the
      // landmark instead, or the restoration below would pass vacuously.
      screen.getByRole('main').focus();
      expect(screen.getByRole('main')).toHaveFocus();

      popup.reject(firebaseError(code));

      const button = await screen.findByRole('button', { name: provider });
      await waitFor(() => expect(button).toBeEnabled());
      expect(button).toHaveFocus();
      expect(button).not.toHaveAttribute('aria-busy', 'true');
      expect(statusRegion()).toHaveTextContent(`${provider} sign-in was cancelled.`);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sign In' })).toBeEnabled();
      expect(mockRouterReplace).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['auth/popup-blocked', /pop-up was blocked/i],
    ['auth/network-request-failed', /network error/i],
    ['auth/account-exists-with-different-credential', /different sign-in method/i],
  ])('focuses the %s summary without blaming the password fields, and dismissal returns to the provider', async (code, message) => {
    mock().mockRejectedValueOnce(firebaseError(code));
    const { container } = renderSignedOut();
    await userEvent.click(screen.getByRole('button', { name: provider }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert.parentElement).toHaveFocus();
    expect(statusRegion()).not.toHaveTextContent(/signing in with/i);
    expect(screen.getByRole('button', { name: provider })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeEnabled();
    expect(screen.getByLabelText('Email *')).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Password *')).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Email *')).not.toHaveAccessibleDescription(message);
    expect((await scanAccessibility(container)).violations).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: provider })).toHaveFocus();
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });
});

describe('a cancelled pop-up sign-in', () => {
  // The cancellation is announced through the polite status region and raises
  // no banner, so nothing else would ever take it down.
  async function cancelGooglePopup() {
    googleMock.mockRejectedValueOnce(firebaseError('auth/popup-closed-by-user'));
    renderSignedOut();
    await userEvent.click(screen.getByRole('button', { name: 'Google' }));
    await waitFor(() => expect(statusRegion()).toHaveTextContent('Google sign-in was cancelled.'));
  }

  it('stops reporting the cancellation once a password sign-in starts', async () => {
    signInMock.mockRejectedValue(firebaseError('auth/invalid-credential'));
    await cancelGooglePopup();

    await signInWithPassword();

    await screen.findByRole('alert');
    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(statusRegion()).not.toHaveTextContent(/cancelled/);
  });

  it('stops reporting the cancellation when the visitor switches to password recovery', async () => {
    await cancelGooglePopup();

    await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));

    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
    expect(statusRegion()).not.toHaveTextContent(/cancelled/);
  });
});

describe('dismissing sign-in feedback', () => {
  it('returns focus to the email field after a credential failure is dismissed', async () => {
    signInMock.mockRejectedValue(firebaseError('auth/invalid-credential'));
    renderSignedOut();
    await signInWithPassword();
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email *')).toHaveFocus();
    expect(screen.getByLabelText('Email *')).toHaveValue('ada@example.test');
  });

  it('returns focus to the recovery email field after a recovery failure is dismissed', async () => {
    (authService.forgotPassword as jest.Mock).mockRejectedValueOnce(firebaseError('auth/network-request-failed'));
    renderSignedOut();
    await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await userEvent.type(screen.getByLabelText('Email *'), 'ada@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send Reset Email' }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByLabelText('Email *')).toHaveFocus();
  });
});

describe('a signed-in visitor being redirected', () => {
  it('announces the redirect inside a focused main landmark and never renders the sign-in form', async () => {
    const held = deferred<string>();
    verifiedMock.mockReturnValueOnce(held.promise);
    const { container } = renderSignedIn();

    const main = screen.getByRole('main');
    expect(main).toHaveFocus();
    const message = await screen.findByText('Redirecting to your dashboard...');
    expect(message.closest('[role="status"]')).not.toBeNull();
    // One announcement, not the spinner's "Loading" beside it.
    expect(screen.getAllByRole('status')).toEqual([message.closest('[role="status"]')]);
    expect(screen.queryByRole('heading', { name: 'Welcome back' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email *')).not.toBeInTheDocument();
    expect((await scanAccessibility(container)).violations).toEqual([]);

    held.resolve('verified');
    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith(`/lawfirm/${OWN_FIRM}`));
    expect(screen.queryByRole('heading', { name: 'Welcome back' })).not.toBeInTheDocument();
  });

  it('moves focus off the unmounted provider button onto the redirect screen after a pop-up sign-in succeeds', async () => {
    googleMock.mockResolvedValueOnce({ needsRegistration: false });
    renderSignedOut();
    await userEvent.click(screen.getByRole('button', { name: 'Google' }));
    expect(await screen.findByText('Redirecting to your dashboard...')).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveFocus();
    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith(`/lawfirm/${OWN_FIRM}`));
  });
});

describe('native constraint validation', () => {
  it('blocks an empty sign-in before any credential reaches Firebase', async () => {
    renderSignedOut();
    const form = screen.getByLabelText('Email *').closest('form')!;
    expect(form.noValidate).toBe(false);
    expect(screen.getByLabelText('Email *')).toBeRequired();
    expect(screen.getByLabelText('Email *')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Password *')).toBeRequired();
    await userEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    expect(screen.getByLabelText('Email *')).toBeInvalid();
    expect(signInMock).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Email *'), 'not-an-email');
    await userEvent.type(screen.getByLabelText('Password *'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    expect(screen.getByLabelText('Email *')).toBeInvalid();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('blocks an empty recovery request before it reaches Firebase', async () => {
    renderSignedOut();
    await userEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(screen.getByLabelText('Email *').closest('form')!.noValidate).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Send Reset Email' }));
    expect(screen.getByLabelText('Email *')).toBeInvalid();
    expect(authService.forgotPassword).not.toHaveBeenCalled();
  });
});
