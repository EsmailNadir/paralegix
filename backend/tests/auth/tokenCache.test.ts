/**
 * Token verification cache and email-verification bypass integration tests.
 *
 * These tests drive the real auth middleware through actual routes via supertest,
 * observing identity, verification, and permission behavior from the outside.
 * The token cache itself is an implementation detail; these tests prove its
 * observable contracts: identity isolation and expiry enforcement.
 *
 * The permission cache is covered elsewhere, through the events that invalidate
 * it: `support/harness.test.ts` proves the cache really serves a stale role,
 * and `permissions/roleLifecycleAccess.test.ts` and `members/membersServiceOps.test.ts`
 * prove a role edit and a member removal reach the very next request.
 */
import {
  createFirm,
  ownerOf,
  as,
  tokenFor,
  unverifiedTokenFor,
  testPool,
  freezeClockAt,
  request,
} from '../support/setupInProcess';

describe('Token verification and cache behavior', () => {
  describe('identity isolation', () => {
    it('same full token reuses verified claims within TTL', async () => {
      const firm = await createFirm();
      const owner = await ownerOf(firm.id);
      const token = tokenFor({ uid: owner.uid });
      const api = as(token);
      const { auth } = require('../../src/shared/database/firebase');
      const verify = jest.spyOn(auth, 'verifyIdToken');

      try {
        const res1 = await api.get('/api/users/profile');
        expect(res1.status).toBe(200);

        const res2 = await api.get('/api/users/profile');
        expect(res2.status).toBe(200);

        expect(res1.body.id).toBe(owner.uid);
        expect(res2.body.id).toBe(owner.uid);
        expect(verify).toHaveBeenCalledTimes(1);
        expect(verify).toHaveBeenCalledWith(token, true);
      } finally {
        verify.mockRestore();
      }
    });

    it('different tokens for the same UID are independently verified', async () => {
      const firm = await createFirm();
      const owner = await ownerOf(firm.id);

      const tokenA = tokenFor({ uid: owner.uid });
      const tokenB = tokenFor({ uid: owner.uid });

      const resA = await as(tokenA).get('/api/users/profile');
      const resB = await as(tokenB).get('/api/users/profile');

      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      expect(resA.body.id).toBe(owner.uid);
      expect(resB.body.id).toBe(owner.uid);
    });

    it('two users alternating calls never receive the other identity', async () => {
      const firmA = await createFirm();
      const firmB = await createFirm();
      const ownerA = await ownerOf(firmA.id);
      const ownerB = await ownerOf(firmB.id);

      // Interleave requests
      const resA1 = await ownerA.api.get('/api/users/profile');
      const resB1 = await ownerB.api.get('/api/users/profile');
      const resA2 = await ownerA.api.get('/api/users/profile');

      expect(resA1.body.id).toBe(ownerA.uid);
      expect(resB1.body.id).toBe(ownerB.uid);
      expect(resA2.body.id).toBe(ownerA.uid);
    });
  });

  describe('token expiry', () => {
    it('expired token is rejected even if still within cache TTL', async () => {
      const firm = await createFirm();
      const owner = await ownerOf(firm.id);

      // Token expires 10 seconds from the frozen instant
      const exp = Math.floor(new Date('2026-03-15T09:00:10-04:00').getTime() / 1000);
      const token = tokenFor({ uid: owner.uid, exp });

      freezeClockAt('2026-03-15T09:00:05-04:00');
      const api = as(token);

      // Before expiry: succeeds
      const res1 = await api.get('/api/users/profile');
      expect(res1.status).toBe(200);

      // After expiry: cache should reject based on token's own exp
      freezeClockAt('2026-03-15T09:00:15-04:00');
      const res2 = await api.get('/api/users/profile');
      expect(res2.status).toBe(401);
      expect(res2.body.code).toBe('TOKEN_EXPIRED');
    });
  });

  describe('revocation freshness boundary', () => {
    it('rejects a disabled account on a cold verification', async () => {
      const firm = await createFirm();
      const owner = await ownerOf(firm.id);
      const token = tokenFor({ uid: owner.uid });
      const { auth } = require('../../src/shared/database/firebase');
      const disabled = Object.assign(new Error('The user record is disabled'), {
        code: 'auth/user-disabled',
      });
      const verify = jest.spyOn(auth, 'verifyIdToken').mockRejectedValueOnce(disabled);

      try {
        const response = await as(token).get('/api/users/profile');

        expect(response.status).toBe(401);
        expect(response.body.code).toBe('ACCOUNT_DISABLED');
        expect(verify).toHaveBeenCalledWith(token, true);
      } finally {
        verify.mockRestore();
      }
    });

    it('honors a warmed token only until the 30-second cache TTL, then rejects it on cold verification', async () => {
      const firm = await createFirm();
      const owner = await ownerOf(firm.id);
      const token = tokenFor({ uid: owner.uid });
      const api = as(token);

      freezeClockAt('2026-03-15T09:00:00-04:00');
      const warmed = await api.get('/api/users/profile');
      expect(warmed.status).toBe(200);

      const { auth } = require('../../src/shared/database/firebase');
      const revoked = Object.assign(new Error('Firebase ID token has been revoked'), {
        code: 'auth/id-token-revoked',
      });
      const verify = jest.spyOn(auth, 'verifyIdToken').mockRejectedValue(revoked);

      try {
        // A cached verification is intentionally still valid within the
        // documented freshness window; the provider is not called again.
        freezeClockAt('2026-03-15T09:00:29-04:00');
        const warmCache = await api.get('/api/users/profile');
        expect(warmCache.status).toBe(200);
        expect(verify).not.toHaveBeenCalled();

        // Once the TTL has elapsed, the same token must be checked again and
        // the provider's revocation response must reach the caller.
        freezeClockAt('2026-03-15T09:00:31-04:00');
        const coldCache = await api.get('/api/users/profile');
        expect(coldCache.status).toBe(401);
        expect(coldCache.body.code).toBe('TOKEN_REVOKED');
        expect(verify).toHaveBeenCalledWith(token, true);
      } finally {
        verify.mockRestore();
      }
    });
  });

  describe('concurrent verification and retries', () => {
    it('shares one pending verification between concurrent requests for the same token', async () => {
      const firm = await createFirm();
      const owner = await ownerOf(firm.id);
      const token = tokenFor({ uid: owner.uid });
      const { auth } = require('../../src/shared/database/firebase');
      const { verifyToken } = require('../../src/shared/middleware/auth');
      const originalVerify = auth.verifyIdToken.bind(auth);

      let releaseVerification: (() => void) | undefined;
      const pendingVerification = new Promise<void>((resolve) => {
        releaseVerification = resolve;
      });
      let markVerificationStarted: (() => void) | undefined;
      const verificationStarted = new Promise<void>((resolve) => {
        markVerificationStarted = resolve;
      });
      const verify = jest.spyOn(auth, 'verifyIdToken').mockImplementation(async (...args: any[]) => {
        markVerificationStarted!();
        await pendingVerification;
        return originalVerify(...args);
      });

      const makeRequest = () => ({
        headers: { authorization: `Bearer ${token}` },
        id: 'concurrent-token-cache-test',
        ip: '127.0.0.1',
        log: { warn: jest.fn() },
      });
      const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const nextOne = jest.fn();
      const nextTwo = jest.fn();

      try {
        const first = verifyToken(makeRequest(), response, nextOne);
        await verificationStarted;
        const second = verifyToken(makeRequest(), response, nextTwo);

        // The second middleware invocation reaches the pending map before the
        // provider is released. A second provider call would prove de-duplication
        // is broken before either request can succeed.
        expect(verify).toHaveBeenCalledTimes(1);

        releaseVerification!();
        await Promise.all([first, second]);
        expect(nextOne).toHaveBeenCalledWith();
        expect(nextTwo).toHaveBeenCalledWith();
      } finally {
        releaseVerification?.();
        verify.mockRestore();
      }
    });

    it('verifies concurrent different tokens independently without swapping their identities', async () => {
      const tokenA = tokenFor({ uid: 'concurrent-user-a' });
      const tokenB = tokenFor({ uid: 'concurrent-user-b' });
      const { auth } = require('../../src/shared/database/firebase');
      const { verifyToken } = require('../../src/shared/middleware/auth');
      const originalVerify = auth.verifyIdToken.bind(auth);

      let releaseVerification: (() => void) | undefined;
      const pendingVerification = new Promise<void>((resolve) => {
        releaseVerification = resolve;
      });
      let startedCount = 0;
      let markBothStarted: (() => void) | undefined;
      const bothStarted = new Promise<void>((resolve) => {
        markBothStarted = resolve;
      });
      const verify = jest.spyOn(auth, 'verifyIdToken').mockImplementation(async (...args: any[]) => {
        startedCount += 1;
        if (startedCount === 2) markBothStarted!();
        await pendingVerification;
        return originalVerify(...args);
      });

      const makeRequest = (token: string) => ({
        headers: { authorization: `Bearer ${token}` },
        id: `different-token-${token}`,
        ip: '127.0.0.1',
        log: { warn: jest.fn() },
      });
      const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const requestA: any = makeRequest(tokenA);
      const requestB: any = makeRequest(tokenB);
      const nextA = jest.fn();
      const nextB = jest.fn();

      try {
        const first = verifyToken(requestA, response, nextA);
        const second = verifyToken(requestB, response, nextB);
        await bothStarted;

        expect(verify).toHaveBeenCalledTimes(2);
        expect(verify).toHaveBeenCalledWith(tokenA, true);
        expect(verify).toHaveBeenCalledWith(tokenB, true);

        releaseVerification!();
        await Promise.all([first, second]);
        expect(requestA.user.uid).toBe('concurrent-user-a');
        expect(requestB.user.uid).toBe('concurrent-user-b');
        expect(nextA).toHaveBeenCalledWith();
        expect(nextB).toHaveBeenCalledWith();
      } finally {
        releaseVerification?.();
        verify.mockRestore();
      }
    });

    it('does not cache a failed verification and permits a later retry', async () => {
      const firm = await createFirm();
      const owner = await ownerOf(firm.id);
      const token = tokenFor({ uid: owner.uid });
      const api = as(token);
      const { auth } = require('../../src/shared/database/firebase');
      const originalVerify = auth.verifyIdToken.bind(auth);
      const rejected = Object.assign(new Error('temporary provider failure'), {
        code: 'auth/argument-error',
      });
      const verify = jest.spyOn(auth, 'verifyIdToken')
        .mockRejectedValueOnce(rejected)
        .mockImplementation(originalVerify);

      try {
        const rejectedResponse = await api.get('/api/users/profile');
        expect(rejectedResponse.status).toBe(401);
        expect(rejectedResponse.body.code).toBe('INVALID_TOKEN');

        // Let the in-flight cleanup callback run before making the separate
        // later request that must perform a new verification.
        await Promise.resolve();
        const retriedResponse = await api.get('/api/users/profile');
        expect(retriedResponse.status).toBe(200);
        expect(retriedResponse.body.id).toBe(owner.uid);
        expect(verify).toHaveBeenCalledTimes(2);
      } finally {
        verify.mockRestore();
      }
    });
  });

  describe('invalid tokens', () => {
    it('missing Authorization header -> 401 NO_TOKEN', async () => {
      const res = await request().get('/api/users/profile');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('NO_TOKEN');
    });

    it('empty Bearer token -> 401 NO_TOKEN', async () => {
      const res = await request()
        .get('/api/users/profile')
        .set('Authorization', 'Bearer ');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('NO_TOKEN');
    });

    it('unknown/garbage token -> 401 INVALID_TOKEN', async () => {
      const res = await request()
        .get('/api/users/profile')
        .set('Authorization', 'Bearer garbage-token-xyz');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_TOKEN');
    });
  });

  describe('email verification', () => {
    it('unverified password user on a verified-required route -> 403 EMAIL_NOT_VERIFIED', async () => {
      const firm = await createFirm();
      const owner = await ownerOf(firm.id);

      const token = unverifiedTokenFor(owner.uid);
      const api = as(token);

      const res = await api.get(`/api/lawfirms/${firm.id}/matters`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('treats a password token with an absent email_verified claim as unverified', async () => {
      const firm = await createFirm();
      const owner = await ownerOf(firm.id);
      const token = tokenFor({
        uid: owner.uid,
        email_verified: undefined as unknown as boolean,
        firebase: { sign_in_provider: 'password' },
      });

      const response = await as(token).get(`/api/lawfirms/${firm.id}/matters`);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('unverified OAuth user (google.com provider) is allowed through', async () => {
      const firm = await createFirm();
      const owner = await ownerOf(firm.id);

      const token = tokenFor({
        uid: owner.uid,
        email_verified: false,
        firebase: { sign_in_provider: 'google.com' },
      });
      const api = as(token);

      const res = await api.get(`/api/lawfirms/${firm.id}/matters`);
      expect(res.status).toBe(200);
    });

    it('whitelisted email bypasses verification check', async () => {
      const firm = await createFirm();
      const owner = await ownerOf(firm.id);

      // Add email to the verification whitelist table
      await testPool.query(
        `INSERT INTO email_verification_whitelist (email) VALUES ($1) ON CONFLICT DO NOTHING`,
        [`${owner.uid}@example.test`],
      );

      // Refresh the in-memory whitelist cache
      const { refresh } = require('../../src/shared/utils/emailWhitelist');
      await refresh();

      const token = unverifiedTokenFor(owner.uid);
      const api = as(token);

      const res = await api.get(`/api/lawfirms/${firm.id}/matters`);
      expect(res.status).toBe(200);
    });

    it('removing a DB whitelist entry restores password-email verification on the next refresh', async () => {
      const firm = await createFirm();
      const owner = await ownerOf(firm.id);
      const email = `${owner.uid}@example.test`;
      const token = unverifiedTokenFor(owner.uid);
      const api = as(token);
      const { refresh } = require('../../src/shared/utils/emailWhitelist');

      await testPool.query(
        `INSERT INTO email_verification_whitelist (email) VALUES ($1)`,
        [email],
      );
      await refresh();
      const allowed = await api.get(`/api/lawfirms/${firm.id}/matters`);
      expect(allowed.status).toBe(200);

      await testPool.query(
        `DELETE FROM email_verification_whitelist WHERE email = $1`,
        [email],
      );
      await refresh();
      const refused = await api.get(`/api/lawfirms/${firm.id}/matters`);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('EMAIL_NOT_VERIFIED');
    });
  });
});
