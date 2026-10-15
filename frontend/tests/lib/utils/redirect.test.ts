/**
 * Where a fresh login lands, when the URL carries a `next` deep link.
 *
 * The case that matters is the FIRST one. Signing out of `/lawfirm/<id>` leaves
 * that path in the login URL, so the next sign-in on the same browser, often a
 * different account, used to be sent straight back into the previous session's
 * firm. The backend answered 403 and the workspace shell rendered it as
 * "your account is not a member of this workspace" - a dead end produced
 * entirely by the client picking the wrong destination.
 *
 * The other cases pin what this must NOT do: a deep link the account can open
 * still wins, a non-firm path is never second-guessed, and a failed membership
 * lookup keeps the deep link rather than inventing a destination.
 *
 * `getRedirectPath`, the destination with no `next` at all, is pinned at the
 * end: one firm opens that firm, several land on the dashboard, a firm that has
 * not finished checkout goes to plan selection, and a client goes to the portal.
 */
const mockGetProfile = jest.fn();
const mockGetMyLawFirms = jest.fn();
const mockGetStatus = jest.fn();

jest.mock('@/services/users.service', () => ({
  __esModule: true,
  default: {
    getProfile: (...args: unknown[]) => mockGetProfile(...args),
    getMyLawFirms: (...args: unknown[]) => mockGetMyLawFirms(...args),
  },
}));

jest.mock('@/services/subscription.service', () => ({
  __esModule: true,
  default: {
    getStatus: (...args: unknown[]) => mockGetStatus(...args),
  },
}));

// The signed-in Firebase user, swappable per spec. `null` is a signed-out
// browser. The module reads it through a dynamic import on every call, so a
// change here is seen by the next call.
// `mockFirebase.initialized = false` models the module exporting `auth: null`,
// which is what it does on the server or when Firebase failed to start.
const mockFirebaseAuth: { currentUser: { uid: string } | null } = {
  currentUser: { uid: 'test-uid' },
};
const mockFirebase = { initialized: true };
jest.mock('@/lib/firebase/config', () => ({
  get auth() {
    return mockFirebase.initialized ? mockFirebaseAuth : null;
  },
}));

import {
  getRedirectPath,
  getUserTypeFromProfile,
  resolveLoginDestination,
} from '@/lib/utils/redirect';
import { sanitizeNextPath } from '@/lib/utils/safeNext';

const OWN_FIRM = '11111111-1111-4111-8111-111111111111';
const OTHER_FIRM = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  jest.clearAllMocks();
  mockFirebaseAuth.currentUser = { uid: 'test-uid' };
  mockFirebase.initialized = true;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockGetProfile.mockResolvedValue({ userType: 'firm_member' });
  mockGetMyLawFirms.mockResolvedValue({ lawFirmIds: [OWN_FIRM] });
  mockGetStatus.mockResolvedValue({ billingStatus: 'active', trialEndsAt: null });
});

describe('a firm-scoped `next`', () => {
  it('is refused when the signed-in account is not a member of that firm', async () => {
    await expect(resolveLoginDestination(`/lawfirm/${OTHER_FIRM}/matters`)).resolves.toBe(
      `/lawfirm/${OWN_FIRM}`,
    );
  });

  it('is honored intact when the account is a member', async () => {
    await expect(
      resolveLoginDestination(`/lawfirm/${OWN_FIRM}/matters/m-1?tab=notes#doc`),
    ).resolves.toBe(`/lawfirm/${OWN_FIRM}/matters/m-1?tab=notes#doc`);
  });

  it('sends a client who followed a firm link to the client portal', async () => {
    mockGetProfile.mockResolvedValue({ userType: 'client' });
    mockGetMyLawFirms.mockResolvedValue({ lawFirmIds: [] });

    await expect(resolveLoginDestination(`/lawfirm/${OTHER_FIRM}`)).resolves.toBe(
      '/client/dashboard',
    );
  });

  it('keeps the deep link when the membership lookup itself fails', async () => {
    mockGetMyLawFirms.mockRejectedValue(new Error('network down'));

    await expect(resolveLoginDestination(`/lawfirm/${OTHER_FIRM}/tasks`)).resolves.toBe(
      `/lawfirm/${OTHER_FIRM}/tasks`,
    );
  });
});

describe('everything else', () => {
  it('takes a non-firm path as given, without asking who the user belongs to', async () => {
    await expect(resolveLoginDestination('/settings/profile')).resolves.toBe('/settings/profile');
    expect(mockGetMyLawFirms).not.toHaveBeenCalled();
    expect(mockGetProfile).not.toHaveBeenCalled();
  });

  it('falls back to the account destination when there is no `next` at all', async () => {
    await expect(resolveLoginDestination(null)).resolves.toBe(`/lawfirm/${OWN_FIRM}`);
  });
});

describe('getRedirectPath', () => {
  it('redirects firm members with one law firm directly into that firm', async () => {
    mockGetMyLawFirms.mockResolvedValue({ lawFirmIds: ['firm-123'] });

    await expect(getRedirectPath()).resolves.toBe('/lawfirm/firm-123');
  });

  it('keeps firm members with multiple law firms on the dashboard', async () => {
    mockGetMyLawFirms.mockResolvedValue({ lawFirmIds: ['firm-123', 'firm-456'] });

    await expect(getRedirectPath()).resolves.toBe('/dashboard');
  });

  it('routes a single-firm member with incomplete billing to plan selection', async () => {
    mockGetMyLawFirms.mockResolvedValue({ lawFirmIds: ['firm-123'] });
    mockGetStatus.mockResolvedValue({ billingStatus: 'incomplete' });

    await expect(getRedirectPath()).resolves.toBe('/onboarding/plan');
  });

  it('routes clients to the client dashboard', async () => {
    mockGetProfile.mockResolvedValue({ userType: 'client' });

    await expect(getRedirectPath()).resolves.toBe('/client/dashboard');
  });
});

describe('getRedirectPath, the fallbacks', () => {
  it('sends a signed-out browser to /login without asking the backend anything', async () => {
    mockFirebaseAuth.currentUser = null;

    await expect(getRedirectPath()).resolves.toBe('/login');
    expect(mockGetProfile).not.toHaveBeenCalled();
    expect(mockGetMyLawFirms).not.toHaveBeenCalled();
  });

  it('sends the browser to /login when Firebase never initialized', async () => {
    mockFirebase.initialized = false;

    await expect(getRedirectPath()).resolves.toBe('/login');
    await expect(getUserTypeFromProfile()).resolves.toEqual({ userType: null, uid: null });
    expect(mockGetProfile).not.toHaveBeenCalled();
  });

  it('sends a pending account to finish registration', async () => {
    mockGetProfile.mockResolvedValue({ userType: 'pending' });

    await expect(getRedirectPath()).resolves.toBe('/complete-registration');
    expect(mockGetMyLawFirms).not.toHaveBeenCalled();
  });

  it('treats a profile with no userType as pending', async () => {
    mockGetProfile.mockResolvedValue({});

    await expect(getRedirectPath()).resolves.toBe('/complete-registration');
  });

  it('sends the user to registration when the profile lookup itself fails', async () => {
    // userType resolves to null on a failed profile read, which is not a
    // firm member, so it must never open a firm workspace.
    mockGetProfile.mockRejectedValue(new Error('500'));

    await expect(getRedirectPath()).resolves.toBe('/complete-registration');
    expect(mockGetMyLawFirms).not.toHaveBeenCalled();
  });

  it('retries a failed firms lookup once and routes on the retry answer', async () => {
    // Without the retry, one network blip would drop a single-firm member on
    // the multi-firm dashboard instead of in their firm.
    mockGetMyLawFirms
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce({ lawFirmIds: ['firm-123'] });

    await expect(getRedirectPath()).resolves.toBe('/lawfirm/firm-123');
    expect(mockGetMyLawFirms).toHaveBeenCalledTimes(2);
  });

  it('falls back to /dashboard when the firms lookup fails twice, without a third try', async () => {
    mockGetMyLawFirms.mockRejectedValue(new Error('down'));

    await expect(getRedirectPath()).resolves.toBe('/dashboard');
    expect(mockGetMyLawFirms).toHaveBeenCalledTimes(2);
    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it('opens the firm anyway when the billing status lookup fails', async () => {
    mockGetMyLawFirms.mockResolvedValue({ lawFirmIds: ['firm-123'] });
    mockGetStatus.mockRejectedValue(new Error('down'));

    await expect(getRedirectPath()).resolves.toBe('/lawfirm/firm-123');
    expect(mockGetStatus).toHaveBeenCalledWith('firm-123');
  });

  it('asks for the billing status of the one firm it is about to open', async () => {
    mockGetMyLawFirms.mockResolvedValue({ lawFirmIds: ['firm-123'] });

    await getRedirectPath();
    expect(mockGetStatus).toHaveBeenCalledWith('firm-123');
  });

  it('lands a member of no firm on /dashboard', async () => {
    mockGetMyLawFirms.mockResolvedValue({ lawFirmIds: [] });

    await expect(getRedirectPath()).resolves.toBe('/dashboard');
    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it('treats a firms response with no lawFirmIds field as no firms', async () => {
    mockGetMyLawFirms.mockResolvedValue({});

    await expect(getRedirectPath()).resolves.toBe('/dashboard');
  });
});

describe('getUserTypeFromProfile', () => {
  it('returns nulls for a signed-out browser without calling the profile API', async () => {
    mockFirebaseAuth.currentUser = null;

    await expect(getUserTypeFromProfile()).resolves.toEqual({ userType: null, uid: null });
    expect(mockGetProfile).not.toHaveBeenCalled();
  });

  it('returns the profile userType alongside the Firebase uid', async () => {
    mockFirebaseAuth.currentUser = { uid: 'uid-42' };
    mockGetProfile.mockResolvedValue({ userType: 'client' });

    await expect(getUserTypeFromProfile()).resolves.toEqual({ userType: 'client', uid: 'uid-42' });
  });

  it('keeps the uid but reports no userType when the profile lookup fails', async () => {
    mockFirebaseAuth.currentUser = { uid: 'uid-42' };
    mockGetProfile.mockRejectedValue(new Error('500'));

    await expect(getUserTypeFromProfile()).resolves.toEqual({ userType: null, uid: 'uid-42' });
  });
});

describe('resolveLoginDestination path parsing', () => {
  it('reads the firm id from the path only, ignoring a lawfirm path smuggled into the query', async () => {
    // `/settings?x=/lawfirm/<other>` is not a firm route; it must not trigger
    // (or be judged by) a membership check.
    const next = `/settings?x=/lawfirm/${OTHER_FIRM}`;
    await expect(resolveLoginDestination(next)).resolves.toBe(next);
    expect(mockGetMyLawFirms).not.toHaveBeenCalled();
  });

  it('honors a member firm root with a query or hash right after the id', async () => {
    // The id is read with the query and hash cut off; read whole, it would be
    // `<id>?tab=billing`, match no membership, and bounce a member out of
    // their own firm.
    await expect(resolveLoginDestination(`/lawfirm/${OWN_FIRM}?tab=billing`)).resolves.toBe(
      `/lawfirm/${OWN_FIRM}?tab=billing`,
    );
    await expect(resolveLoginDestination(`/lawfirm/${OWN_FIRM}#top`)).resolves.toBe(
      `/lawfirm/${OWN_FIRM}#top`,
    );
  });

  it('takes a bare /lawfirm path with no id as an ordinary path', async () => {
    await expect(resolveLoginDestination('/lawfirm')).resolves.toBe('/lawfirm');
    await expect(resolveLoginDestination('/lawfirm/')).resolves.toBe('/lawfirm/');
    expect(mockGetMyLawFirms).not.toHaveBeenCalled();
  });

  it('decodes a percent-encoded firm id before comparing it with the memberships', async () => {
    mockGetMyLawFirms.mockResolvedValue({ lawFirmIds: ['firm a'] });

    await expect(resolveLoginDestination('/lawfirm/firm%20a/matters')).resolves.toBe(
      '/lawfirm/firm%20a/matters',
    );
  });

  it('does not treat a lookalike section such as /lawfirms/<id> as firm-scoped', async () => {
    await expect(resolveLoginDestination(`/lawfirms/${OTHER_FIRM}`)).resolves.toBe(
      `/lawfirms/${OTHER_FIRM}`,
    );
    expect(mockGetMyLawFirms).not.toHaveBeenCalled();
  });

  it('sends a malformed percent-encoded firm segment to the account destination instead of throwing', async () => {
    // `/lawfirm/%E0%A4%A` survives sanitizeNextPath (URL keeps percent escapes
    // literal), and decoding it throws a URIError. The login page awaits this
    // after sign-in succeeds, so a throw would leave a signed-in user stuck on
    // the login page. A segment that cannot be decoded is no firm of theirs.
    const next = sanitizeNextPath('/lawfirm/%E0%A4%A/matters');
    expect(next).toBe('/lawfirm/%E0%A4%A/matters');

    const destination = await resolveLoginDestination(next);
    expect(destination).not.toBe(next);
    expect(destination).toBe(await resolveLoginDestination('/lawfirm/not-my-firm/matters'));
  });
});

describe('open-redirect safety at the login boundary', () => {
  // resolveLoginDestination trusts its input: anything that is not a firm path
  // comes back verbatim. The login page only ever hands it the output of
  // sanitizeNextPath, so the property worth pinning is the PAIR: whatever an
  // attacker puts in `?next=`, the destination is same-origin.

  it('CHARACTERISATION: returns a non-firm `next` verbatim, so it relies on the caller to sanitize', async () => {
    await expect(resolveLoginDestination('//evil.com/phish')).resolves.toBe('//evil.com/phish');
  });

  it.each([
    ['protocol-relative', '//evil.com/phish'],
    ['backslash-smuggled', '/\\evil.com'],
    ['tab-smuggled protocol-relative', '/\t/evil.com'],
    ['newline-smuggled protocol-relative', '/\n/evil.com'],
    ['absolute https', 'https://evil.com/lawfirm/x'],
    ['scheme-relative with credentials', '//user@evil.com'],
    ['javascript: URI', 'javascript:alert(document.cookie)'],
    ['data: URI', 'data:text/html,<script>alert(1)</script>'],
    ['encoded slashes with no leading slash', '%2F%2Fevil.com'],
    ['leading whitespace before //', ' //evil.com'],
  ])('a %s `next` lands on the account destination, not the attacker URL', async (_label, raw) => {
    const destination = await resolveLoginDestination(sanitizeNextPath(raw));

    expect(destination).toBe(`/lawfirm/${OWN_FIRM}`);
  });

  it('keeps a percent-encoded `//` as a literal same-origin path segment', async () => {
    // `/%2F%2Fevil.com` is not decoded into a protocol-relative URL, so the
    // browser navigates to a (404) path on this origin, never off-site.
    const destination = await resolveLoginDestination(sanitizeNextPath('/%2F%2Fevil.com'));

    expect(destination).toBe('/%2F%2Fevil.com');
    expect(destination.startsWith('//')).toBe(false);
  });
});
