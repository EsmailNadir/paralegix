/**
 * Unverified-account sweep.
 *
 * The sweep is the only code path that deletes a live account with nobody
 * asking, so these tests are mostly about what it must NOT delete. Every guard
 * gets a case, and so does every way a dependency can fail: the rule the service
 * is built on is that anything unknown, unreachable or unexpected KEEPS the
 * account, and a test that only proved the happy path would not notice that
 * rule breaking.
 *
 * Fully offline. The repository, Firebase Auth, the whitelist and GCS are all
 * mocked, so nothing here touches a database or the network:
 *
 *   __TEST_TOKEN__=offline npx jest tests/users/unverifiedAccounts.test.ts
 *
 * NOTE ON MODULE RELOADING. The service reads UNVERIFIED_ACCOUNT_SWEEP_MODE and
 * the grace period into consts at import time, which is what makes a misconfigured
 * env impossible to change under a running process. Tests therefore go through
 * `loadService()`, which resets the module registry and re-imports; setting
 * process.env after import would have no effect.
 */

const mockRepo = {
  findOlderThanDays: jest.fn(),
  findWhitelistedEmails: jest.fn(),
  findEmailsWithFirmRecords: jest.fn(),
  findAccountActivity: jest.fn(),
  deleteAccount: jest.fn(),
};

const mockAuth = {
  getUsers: jest.fn(),
  getUser: jest.fn(),
  deleteUser: jest.fn(),
};

const mockDeletePhotos = jest.fn();
let mockEnvWhitelist: string[] = [];

jest.mock('../../src/modules/users/users.repository', () => mockRepo);
jest.mock('../../src/shared/database/firebase', () => ({ auth: mockAuth }));
jest.mock('../../src/shared/utils/emailWhitelist', () => ({
  get ENV_WHITELIST() { return mockEnvWhitelist; },
}));
jest.mock('../../src/shared/utils/userPhoto', () => ({
  deleteUserPhotoObjects: mockDeletePhotos,
}));

const DAY = 24 * 60 * 60 * 1000;

/** A users row as `findOlderThanDays` returns it. */
function row(overrides: any = {}) {
  return {
    id: 'uid-1',
    email: 'squatter@example.com',
    isAdmin: false,
    createdAt: new Date(Date.now() - 30 * DAY),
    ...overrides,
  };
}

/** A Firebase record for an unverified password signup, old enough to sweep. */
function authRecord(overrides: any = {}) {
  return {
    uid: 'uid-1',
    emailVerified: false,
    providerData: [{ providerId: 'password' }],
    metadata: { creationTime: new Date(Date.now() - 30 * DAY).toISOString() },
    ...overrides,
  };
}

/**
 * Re-import the service with a given mode. Returns its entry point.
 */
function loadService(mode = 'on', env: Record<string, string> = {}) {
  jest.resetModules();
  process.env.UNVERIFIED_ACCOUNT_SWEEP_MODE = mode;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  // eslint-disable-next-line global-require
  return require('../../src/modules/users/unverifiedAccounts.service').purgeUnverifiedAccounts;
}

/** Wire the default "one sweepable squatter, nothing blocking" scenario. */
function givenSweepable(rows = [row()], records = [authRecord()]) {
  mockRepo.findOlderThanDays.mockResolvedValue(rows);
  mockRepo.findWhitelistedEmails.mockResolvedValue(new Set());
  mockRepo.findEmailsWithFirmRecords.mockResolvedValue({
    invited: new Set(), clients: new Set(),
  });
  mockRepo.findAccountActivity.mockResolvedValue(null);
  mockRepo.deleteAccount.mockResolvedValue(true);
  mockAuth.getUsers.mockResolvedValue({ users: records });
  mockAuth.deleteUser.mockResolvedValue(undefined);
  mockDeletePhotos.mockResolvedValue(undefined);
}

describe('purgeUnverifiedAccounts', () => {
  const originalEnv = { ...process.env };
  // The service logs deliberately on a per-account failure. Several cases below
  // provoke that on purpose, so keep the expected noise out of the report.
  let errorSpy: any;

  beforeAll(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterAll(() => { errorSpy.mockRestore(); });

  beforeEach(() => {
    jest.clearAllMocks();
    mockEnvWhitelist = [];
    delete process.env.UNVERIFIED_ACCOUNT_GRACE_DAYS;
    delete process.env.UNVERIFIED_ACCOUNT_SWEEP_BATCH;
  });

  afterAll(() => { process.env = originalEnv; });

  describe('the case it exists for', () => {
    it('deletes an unverified password account and frees the address', async () => {
      givenSweepable();
      const results = await loadService('on')();

      expect(results.deleted).toBe(1);
      expect(results.scanned).toBe(1);
      expect(mockRepo.deleteAccount).toHaveBeenCalledWith('uid-1');
      expect(mockAuth.deleteUser).toHaveBeenCalledWith('uid-1');
      expect(mockDeletePhotos).toHaveBeenCalledWith('uid-1');
    });

    it('deletes the row BEFORE the Firebase identity', async () => {
      givenSweepable();
      const order: string[] = [];
      mockRepo.deleteAccount.mockImplementation(async () => { order.push('row'); return true; });
      mockAuth.deleteUser.mockImplementation(async () => { order.push('identity'); });

      await loadService('on')();

      // The row delete is the guarded step: the no-action foreign keys abort it.
      // Doing it first is what keeps a missed reference from costing a real user
      // their login.
      expect(order).toEqual(['row', 'identity']);
    });
  });

  describe('modes', () => {
    it('deletes nothing in dry-run but reports what it would delete', async () => {
      givenSweepable();
      const results = await loadService('dry-run')();

      expect(results.wouldDelete).toBe(1);
      expect(results.deleted).toBe(0);
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
      expect(mockAuth.deleteUser).not.toHaveBeenCalled();
    });

    it('defaults to dry-run when the mode is unset', async () => {
      givenSweepable();
      delete process.env.UNVERIFIED_ACCOUNT_SWEEP_MODE;
      jest.resetModules();
      // eslint-disable-next-line global-require
      const { purgeUnverifiedAccounts } = require('../../src/modules/users/unverifiedAccounts.service');
      const results = await purgeUnverifiedAccounts();

      expect(results.mode).toBe('dry-run');
      expect(results.deleted).toBe(0);
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
    });

    it('does not even query when the mode is off', async () => {
      givenSweepable();
      const results = await loadService('off')();

      expect(results.scanned).toBe(0);
      expect(mockRepo.findOlderThanDays).not.toHaveBeenCalled();
    });
  });

  describe('accounts it must never touch', () => {
    it('keeps a verified account', async () => {
      givenSweepable([row()], [authRecord({ emailVerified: true })]);
      const results = await loadService('on')();

      expect(results.keptVerified).toBe(1);
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
    });

    it('keeps an OAuth account even if emailVerified is somehow false', async () => {
      givenSweepable([row()], [authRecord({ providerData: [{ providerId: 'google.com' }] })]);
      const results = await loadService('on')();

      expect(results.keptVerified).toBe(1);
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
    });

    it('keeps an account whose provider list is empty or missing', async () => {
      givenSweepable([row()], [authRecord({ providerData: [] })]);
      const results = await loadService('on')();

      expect(results.keptVerified).toBe(1);
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
    });

    it('keeps a platform admin', async () => {
      givenSweepable([row({ isAdmin: true })]);
      const results = await loadService('on')();

      expect(results.keptAdmin).toBe(1);
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
    });

    it('keeps an address on the database whitelist', async () => {
      givenSweepable();
      mockRepo.findWhitelistedEmails.mockResolvedValue(new Set(['squatter@example.com']));
      const results = await loadService('on')();

      expect(results.keptWhitelisted).toBe(1);
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
    });

    it('keeps an address on the env whitelist', async () => {
      givenSweepable();
      mockEnvWhitelist = ['squatter@example.com'];
      const results = await loadService('on')();

      expect(results.keptWhitelisted).toBe(1);
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
    });

    it('matches the whitelist case-insensitively', async () => {
      givenSweepable([row({ email: 'Squatter@Example.COM' })]);
      mockRepo.findWhitelistedEmails.mockResolvedValue(new Set(['squatter@example.com']));
      const results = await loadService('on')();

      expect(results.keptWhitelisted).toBe(1);
    });

    it('keeps an account with a pending invitation at that address', async () => {
      givenSweepable();
      mockRepo.findEmailsWithFirmRecords.mockResolvedValue({
        invited: new Set(['squatter@example.com']), clients: new Set(),
      });
      const results = await loadService('on')();

      expect(results.keptInvited).toBe(1);
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
    });

    it('keeps an account when a firm already has a client at that address', async () => {
      givenSweepable();
      mockRepo.findEmailsWithFirmRecords.mockResolvedValue({
        invited: new Set(), clients: new Set(['squatter@example.com']),
      });
      const results = await loadService('on')();

      expect(results.keptClientRecord).toBe(1);
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
    });

    it('keeps a row with a blank email, which it cannot reason about', async () => {
      givenSweepable([row({ email: '   ' })]);
      const results = await loadService('on')();

      expect(results.keptNoEmail).toBe(1);
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
    });

    it('keeps an account Firebase says was created inside the grace period', async () => {
      // The DB row is old, but Firebase disagrees. The more generous clock wins,
      // so a row backdated by an import cannot drag in a fresh signup.
      givenSweepable([row()], [authRecord({
        metadata: { creationTime: new Date(Date.now() - 2 * DAY).toISOString() },
      })]);
      const results = await loadService('on')();

      expect(results.keptRecent).toBe(1);
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
    });

    it('keeps an account that is in use, and records which check caught it', async () => {
      givenSweepable();
      mockRepo.findAccountActivity.mockResolvedValue('members');
      const results = await loadService('on')();

      expect(results.keptInUse).toBe(1);
      expect(results.keptInUseBy).toEqual({ members: 1 });
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
    });
  });

  describe('orphaned rows', () => {
    it('re-confirms a missing identity one-to-one before deleting', async () => {
      givenSweepable([row()], []); // absent from the batch response
      mockAuth.getUser.mockRejectedValue(Object.assign(new Error('nope'), {
        code: 'auth/user-not-found',
      }));
      const results = await loadService('on')();

      expect(mockAuth.getUser).toHaveBeenCalledWith('uid-1');
      expect(results.deleted).toBe(1);
    });

    it('keeps the account when the individual re-check finds the identity alive', async () => {
      givenSweepable([row()], []);
      mockAuth.getUser.mockResolvedValue(authRecord());
      const results = await loadService('on')();

      expect(results.keptAuthPresent).toBe(1);
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
    });

    it('keeps the account when the re-check errors for any other reason', async () => {
      givenSweepable([row()], []);
      mockAuth.getUser.mockRejectedValue(Object.assign(new Error('unavailable'), {
        code: 'auth/internal-error',
      }));
      const results = await loadService('on')();

      expect(results.failed).toBe(1);
      expect(results.deleted).toBe(0);
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
    });
  });

  describe('failures must never widen the delete set', () => {
    it('aborts the whole run if the whitelist cannot be read', async () => {
      givenSweepable();
      mockRepo.findWhitelistedEmails.mockRejectedValue(new Error('db down'));

      await expect(loadService('on')()).rejects.toThrow('db down');
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
    });

    it('aborts the whole run if firm records cannot be read', async () => {
      givenSweepable();
      mockRepo.findEmailsWithFirmRecords.mockRejectedValue(new Error('db down'));

      await expect(loadService('on')()).rejects.toThrow('db down');
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
    });

    it('aborts the whole run if Firebase is unreachable', async () => {
      givenSweepable();
      mockAuth.getUsers.mockRejectedValue(new Error('firebase unreachable'));

      await expect(loadService('on')()).rejects.toThrow('firebase unreachable');
      expect(mockRepo.deleteAccount).not.toHaveBeenCalled();
    });

    it('counts a foreign-key violation as a clean skip, not a failure', async () => {
      givenSweepable();
      mockRepo.deleteAccount.mockRejectedValue(Object.assign(new Error('FK'), { code: '23503' }));
      const results = await loadService('on')();

      // The database backstop refusing the delete is the design working.
      expect(results.keptReferenced).toBe(1);
      expect(results.failed).toBe(0);
      expect(mockAuth.deleteUser).not.toHaveBeenCalled();
    });

    it('leaves the identity alone when the row delete reports no row removed', async () => {
      givenSweepable();
      mockRepo.deleteAccount.mockResolvedValue(false);
      const results = await loadService('on')();

      expect(results.failed).toBe(1);
      expect(results.deleted).toBe(0);
      expect(mockAuth.deleteUser).not.toHaveBeenCalled();
    });

    it('does not let one account failing stop the rest of the batch', async () => {
      givenSweepable(
        [row({ id: 'uid-1' }), row({ id: 'uid-2', email: 'b@example.com' })],
        [authRecord({ uid: 'uid-1' }), authRecord({ uid: 'uid-2' })],
      );
      mockRepo.deleteAccount.mockImplementation(async (id: string) => {
        if (id === 'uid-1') throw new Error('boom');
        return true;
      });
      const results = await loadService('on')();

      expect(results.failed).toBe(1);
      expect(results.deleted).toBe(1);
    });

    it('tolerates an identity that vanished between the row delete and the auth delete', async () => {
      givenSweepable();
      mockAuth.deleteUser.mockRejectedValue(Object.assign(new Error('gone'), {
        code: 'auth/user-not-found',
      }));
      const results = await loadService('on')();

      expect(results.deleted).toBe(1);
      expect(results.failed).toBe(0);
    });
  });

  describe('configuration cannot be made dangerous', () => {
    it('falls back to 7 days when the grace period is zero or negative', async () => {
      givenSweepable();
      const results = await loadService('on', { UNVERIFIED_ACCOUNT_GRACE_DAYS: '0' })();

      expect(results.graceDays).toBe(7);
      expect(mockRepo.findOlderThanDays).toHaveBeenCalledWith(
        expect.objectContaining({ days: 7 }),
      );
    });

    it('falls back to 7 days when the grace period is not a number', async () => {
      givenSweepable();
      const results = await loadService('on', { UNVERIFIED_ACCOUNT_GRACE_DAYS: 'soon' })();

      expect(results.graceDays).toBe(7);
    });

    it('honours a valid grace period', async () => {
      givenSweepable();
      const results = await loadService('on', { UNVERIFIED_ACCOUNT_GRACE_DAYS: '30' })();

      expect(results.graceDays).toBe(30);
      expect(mockRepo.findOlderThanDays).toHaveBeenCalledWith(
        expect.objectContaining({ days: 30 }),
      );
    });

    it('caps the batch size', async () => {
      givenSweepable();
      await loadService('on', { UNVERIFIED_ACCOUNT_SWEEP_BATCH: '999999' })();

      expect(mockRepo.findOlderThanDays).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1000 }),
      );
    });
  });

  describe('batching', () => {
    it('looks Firebase up in chunks of 100', async () => {
      const rows = Array.from({ length: 250 }, (_, i) => row({
        id: `uid-${i}`, email: `user${i}@example.com`,
      }));
      givenSweepable(rows, []);
      mockAuth.getUsers.mockResolvedValue({ users: [] });
      mockAuth.getUser.mockRejectedValue(Object.assign(new Error('nope'), {
        code: 'auth/user-not-found',
      }));

      await loadService('dry-run')();

      expect(mockAuth.getUsers).toHaveBeenCalledTimes(3);
      expect(mockAuth.getUsers.mock.calls[0][0]).toHaveLength(100);
      expect(mockAuth.getUsers.mock.calls[2][0]).toHaveLength(50);
    });

    it('returns early without touching Firebase when nothing is due', async () => {
      givenSweepable([]);
      const results = await loadService('on')();

      expect(results.scanned).toBe(0);
      expect(mockAuth.getUsers).not.toHaveBeenCalled();
    });
  });
});
