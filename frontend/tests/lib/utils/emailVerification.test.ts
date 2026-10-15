/**
 * Whether a signed-in user counts as email-verified, which the login page and
 * every workspace layout use to decide between the app and `/verify-email`.
 *
 * Four routes to "verified" exist (the Firebase claim, an OAuth provider, the
 * test-account whitelist, and accounts created before the feature launched),
 * and each is pinned separately so dropping one goes red on its own. The
 * whitelist's source of truth is an env var read once at module load; the
 * production default must be EMPTY so no test account is ever baked into a
 * shipped bundle, so those cases load the module fresh under each setting.
 *
 * This is a client-side guard only: the backend's own whitelist is the real
 * boundary.
 */
import type { User } from 'firebase/auth';

type FakeUser = {
  emailVerified: boolean;
  email: string | null;
  providerData: { providerId: string }[];
  metadata?: { creationTime?: string };
  reload: jest.Mock;
};

const mockFirebase: { auth: { currentUser: FakeUser | null } | null } = { auth: null };
jest.mock('@/lib/firebase/config', () => ({
  get auth() {
    return mockFirebase.auth;
  },
}));

type Mod = typeof import('@/lib/utils/emailVerification');

const ENV_KEY = 'NEXT_PUBLIC_EMAIL_VERIFICATION_WHITELIST';
const env = process.env as Record<string, string | undefined>;
const originalWhitelist = env[ENV_KEY];
const originalNodeEnv = env.NODE_ENV;

/** Load the module fresh with the given env, so its load-time whitelist is recomputed. */
function load(whitelist: string | undefined, nodeEnv = 'test'): Mod {
  if (whitelist === undefined) delete env[ENV_KEY];
  else env[ENV_KEY] = whitelist;
  env.NODE_ENV = nodeEnv;
  let mod!: Mod;
  jest.isolateModules(() => {
    mod = require('@/lib/utils/emailVerification');
  });
  return mod;
}

function fakeUser(overrides: Partial<FakeUser> = {}): FakeUser {
  return {
    emailVerified: false,
    email: 'someone@firm.com',
    providerData: [{ providerId: 'password' }],
    metadata: { creationTime: '2025-06-01T00:00:00Z' },
    reload: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const asUser = (u: FakeUser) => u as unknown as User;

afterEach(() => {
  if (originalWhitelist === undefined) delete env[ENV_KEY];
  else env[ENV_KEY] = originalWhitelist;
  env.NODE_ENV = originalNodeEnv;
  mockFirebase.auth = null;
});

describe('isEmailVerified', () => {
  const mod = () => load('');

  it('is false for no user', () => {
    expect(mod().isEmailVerified(null)).toBe(false);
  });

  it('is false for an unverified, password, post-launch, non-whitelisted user', () => {
    expect(mod().isEmailVerified(asUser(fakeUser()))).toBe(false);
  });

  it('is true when Firebase says the email is verified', () => {
    expect(mod().isEmailVerified(asUser(fakeUser({ emailVerified: true })))).toBe(true);
  });

  it.each(['google.com', 'microsoft.com'])('is true for a %s sign-in', (providerId) => {
    const u = fakeUser({ providerData: [{ providerId: 'password' }, { providerId }] });
    expect(mod().isEmailVerified(asUser(u))).toBe(true);
  });

  it('is false for another OAuth provider, which Paralegix does not trust for verification', () => {
    const u = fakeUser({ providerData: [{ providerId: 'github.com' }] });
    expect(mod().isEmailVerified(asUser(u))).toBe(false);
  });

  it('grandfathers an account created before the 2025-02-21 launch, and not one created at it', () => {
    const m = mod();
    const before = fakeUser({ metadata: { creationTime: 'Thu, 20 Feb 2025 23:59:59 GMT' } });
    const atLaunch = fakeUser({ metadata: { creationTime: 'Fri, 21 Feb 2025 00:00:00 GMT' } });
    expect(m.isEmailVerified(asUser(before))).toBe(true);
    expect(m.isEmailVerified(asUser(atLaunch))).toBe(false);
  });

  it('does not grandfather a user with no creation time', () => {
    expect(mod().isEmailVerified(asUser(fakeUser({ metadata: undefined })))).toBe(false);
  });
});

describe('the verification whitelist', () => {
  it('is the env var list, trimmed and lowercased, when the env var is set', () => {
    const m = load(' QA@Firm.com , second@firm.com ,,');
    expect(m.isWhitelistedEmail('qa@firm.com')).toBe(true);
    expect(m.isWhitelistedEmail('second@firm.com')).toBe(true);
    expect(m.isEmailVerified(asUser(fakeUser({ email: 'qa@firm.com' })))).toBe(true);
    // The env var replaces the dev list rather than adding to it.
    expect(m.isWhitelistedEmail('test1@gmail.com')).toBe(false);
  });

  it('is empty when the env var is set to an empty string', () => {
    const m = load('');
    expect(m.isWhitelistedEmail('test1@gmail.com')).toBe(false);
    expect(m.isWhitelistedEmail('')).toBe(false);
  });

  it('is EMPTY in a production build when the env var is unset', () => {
    const m = load(undefined, 'production');
    expect(m.isWhitelistedEmail('test1@gmail.com')).toBe(false);
    expect(m.isEmailVerified(asUser(fakeUser({ email: 'test1@gmail.com' })))).toBe(false);
  });

  it('falls back to the dev test accounts outside production when the env var is unset', () => {
    const m = load(undefined, 'development');
    expect(m.isWhitelistedEmail('test1@gmail.com')).toBe(true);
    expect(m.isWhitelistedEmail('c3@gmail.com')).toBe(true);
    expect(m.isWhitelistedEmail('stranger@gmail.com')).toBe(false);
  });

  it('compares the address exactly: a differently cased address does not match', () => {
    // The env list is lowercased but the address checked is not. Firebase
    // stores emails lowercased, so this only matters for a hand-typed call.
    const m = load('qa@firm.com');
    expect(m.isWhitelistedEmail('QA@firm.com')).toBe(false);
  });
});

describe('isOAuthUser', () => {
  it('is false for null and for a password-only user', () => {
    const m = load('');
    expect(m.isOAuthUser(null)).toBe(false);
    expect(m.isOAuthUser(asUser(fakeUser()))).toBe(false);
  });
});

describe('reloadAndCheckVerified', () => {
  it('reports no-user when Firebase is not initialised or nobody is signed in', async () => {
    const m = load('');
    mockFirebase.auth = null;
    await expect(m.reloadAndCheckVerified()).resolves.toBe('no-user');
    mockFirebase.auth = { currentUser: null };
    await expect(m.reloadAndCheckVerified()).resolves.toBe('no-user');
  });

  it('reloads the live user first and judges the refreshed state', async () => {
    // The user clicked the email link in another tab: only after reload()
    // does the in-memory user flip to verified.
    const m = load('');
    const u = fakeUser();
    u.reload.mockImplementation(async () => {
      u.emailVerified = true;
    });
    mockFirebase.auth = { currentUser: u };

    await expect(m.reloadAndCheckVerified()).resolves.toBe('verified');
    expect(u.reload).toHaveBeenCalledTimes(1);
  });

  it('reports not-verified for a live unverified user', async () => {
    const m = load('');
    mockFirebase.auth = { currentUser: fakeUser() };
    await expect(m.reloadAndCheckVerified()).resolves.toBe('not-verified');
  });

  it('still answers from the current state when reload() fails', async () => {
    const m = load('');
    const u = fakeUser({ emailVerified: true });
    u.reload.mockRejectedValue(new Error('auth/network-request-failed'));
    mockFirebase.auth = { currentUser: u };
    await expect(m.reloadAndCheckVerified()).resolves.toBe('verified');
  });

  it('reports no-user when the reload signed the user out', async () => {
    const m = load('');
    const u = fakeUser();
    const auth = { currentUser: u as FakeUser | null };
    u.reload.mockImplementation(async () => {
      auth.currentUser = null;
    });
    mockFirebase.auth = auth;
    await expect(m.reloadAndCheckVerified()).resolves.toBe('no-user');
  });
});
