/**
 * Replaces Firebase Admin for the in-process suite.
 *
 * `verifyToken` is the only thing between supertest and every authenticated
 * route, and it makes a network call to Firebase. Swapping the module lets a
 * test name its caller instead of signing in: `tokenFor({ uid })` mints an
 * opaque string, and the mocked `verifyIdToken` hands back the payload that
 * string was minted for.
 *
 * That is also what makes a client, or a person on an organization's roster,
 * testable at all. The live suite has one seeded firm member and can be nobody
 * else, which is why cross-tenant and permission behaviour has never had a test.
 *
 * GCS is present but inert. `admin.storage().bucket(name)` has to SUCCEED,
 * because several modules call it at module scope and would otherwise take the
 * whole app down on import (`shared/utils/attachmentSigning.ts:24` is the first
 * one the loader reaches, via tasks.repository). What it hands back is a proxy
 * whose every operation throws by name. So loading the app is free, and a test
 * that actually reaches the bucket fails loudly instead of passing against a
 * silent no-op.
 */

export interface DecodedToken {
  uid: string;
  email: string;
  email_verified: boolean;
  firebase: { sign_in_provider: string };
  exp: number;
  [key: string]: unknown;
}

export interface TokenOptions extends Partial<DecodedToken> {
  uid: string;
}

// 2099-01-01. See the note on `exp` below.
const EXPIRY_2099 = Math.floor(Date.UTC(2099, 0, 1) / 1000);

// Module-level rather than per-call, because the jest.mock factory below closes
// over it and must see every token minted afterwards.
const mintedTokens = new Map<string, DecodedToken>();
let counter = 0;

/**
 * Mint an opaque token string bound to a decoded payload.
 *
 * The string is unique per call even for the same uid, matching the real
 * relationship between a token and a session. That also keeps the auth
 * middleware's token cache, which is keyed on the full token string, from
 * serving one test's payload to another.
 */
export function tokenFor(overrides: TokenOptions): string {
  counter += 1;
  const token = `test-token-${overrides.uid}-${counter}`;
  mintedTokens.set(token, {
    email: `${overrides.uid}@example.test`,
    email_verified: true,
    firebase: { sign_in_provider: 'password' },
    // Far future, not "an hour from now".
    //
    // The auth middleware refuses a payload past its own `exp` independently of
    // its cache TTL, so this cannot be a past value. It must also not be a
    // NEAR-future one: `freezeClockAt` moves the clock, and a billing-window or
    // reminder spec that freezes to a date beyond the expiry would see its
    // actors answered 401, which reads as a permission bug rather than a clock
    // one. Nothing in the suite tests expiry through this path, so a token that
    // never expires is the honest default. Pass `exp` explicitly to test it.
    exp: EXPIRY_2099,
    ...overrides,
  });
  return token;
}

/**
 * Mint a token for an account that has NOT verified its email. The API answers
 * 403 EMAIL_NOT_VERIFIED for these on every route but the registration
 * bootstrap, which is worth having a test for.
 */
export function unverifiedTokenFor(uid: string): string {
  return tokenFor({ uid, email_verified: false });
}

/** Forget every minted token, so ids never leak between spec files. */
export function resetTokens(): void {
  mintedTokens.clear();
}

class FirebaseAuthError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FirebaseAuthError';
    this.code = code;
  }
}

/**
 * Register the mock. MUST run before the spec imports anything that reaches
 * `src/`: the app pulls Firebase in transitively at load time, and a mock
 * registered afterwards arrives too late.
 */
export function installFirebaseMock(): void {
  jest.mock('../../src/shared/database/firebase', () => {
    const verifyIdToken = async (token: string) => {
      const decoded = mintedTokens.get(token);
      if (!decoded) {
        // The same code the real SDK raises for a malformed token, so the
        // middleware's authFailurePayload switch takes its INVALID_TOKEN branch
        // exactly as it would in production.
        throw new FirebaseAuthError('auth/argument-error', 'The provided token is malformed');
      }
      // The middleware can evict an expired cache entry only by returning to
      // Firebase verification. Model Firebase's expiry check here so that path
      // refuses the token rather than turning a cache miss into a false pass.
      if (decoded.exp && Date.now() >= decoded.exp * 1000) {
        throw new FirebaseAuthError('auth/id-token-expired', 'Firebase ID token has expired');
      }
      return decoded;
    };

    const authStub = {
      verifyIdToken,
      revokeRefreshTokens: async () => undefined,
      // `emailVerified` is stated EXPLICITLY, not omitted. Real Firebase always
      // returns it, and leaving it undefined made every account read as
      // unverified through a field that was not there to see. Anything gated on
      // it silently took the false branch: member-invite auto-processing in
      // `createUser` could never fire in this suite, so a spec asserting an
      // invite was NOT claimed passed no matter what the code did.
      //
      // False is the right default here, because an account created through
      // these fixtures has not verified anything. A spec that needs a verified
      // account replaces `firebase.auth.getUser` for its own cases and restores
      // it afterwards; see `tests/auth/registrationAndInvites.test.ts`. It is
      // deliberately NOT flipped here, which would switch invite sweeps on
      // across every other spec at once.
      getUser: async (uid: string) => ({ uid, email: `${uid}@example.test`, emailVerified: false }),
    };

    // Every property read off a bucket returns a function that throws under its
    // own name. Reading is safe, calling is not, which is exactly the split
    // between "the module loaded" and "the test touched GCS".
    const makeInertBucket = (bucketName: string): unknown => new Proxy({}, {
      get(_target, prop: string | symbol) {
        if (prop === 'name') return bucketName;
        // Jest and node both probe these during inspection and promise
        // resolution; answering undefined keeps the proxy printable and
        // non-thenable rather than exploding in a stack trace.
        if (typeof prop === 'symbol' || prop === 'then' || prop === 'inspect') return undefined;
        return (...args: unknown[]) => {
          if (prop === 'file') return makeInertBucket(`${bucketName}/${String(args[0])}`);
          throw new Error(
            `GCS is not available in the in-process test suite (called .${String(prop)}() on `
            + `bucket "${bucketName}"). Stub the module under test, or move this case to the `
            + 'live suite.',
          );
        };
      },
    });

    return {
      auth: authStub,
      admin: {
        auth: () => authStub,
        storage: () => ({ bucket: (name: string) => makeInertBucket(name) }),
      },
    };
  });
}
