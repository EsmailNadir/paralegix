import { installFirebaseMock, tokenFor, unverifiedTokenFor, resetTokens } from './firebase.mock';

installFirebaseMock();

// Required after the mock is installed, so the stub is what loads.
const { auth, admin } = require('../../src/shared/database/firebase');

describe('firebase mock', () => {
  afterEach(() => resetTokens());

  it('resolves a token string into the payload it was minted for', async () => {
    const token = tokenFor({ uid: 'user-abc', email: 'abc@example.com' });

    const decoded = await auth.verifyIdToken(token, true);

    expect(decoded.uid).toBe('user-abc');
    expect(decoded.email).toBe('abc@example.com');
    expect(decoded.email_verified).toBe(true);
  });

  it('gives each call a distinct token even for the same uid', () => {
    expect(tokenFor({ uid: 'same' })).not.toBe(tokenFor({ uid: 'same' }));
  });

  it('mints an unverified-email payload on request', async () => {
    const decoded = await auth.verifyIdToken(unverifiedTokenFor('user-unverified'), true);

    expect(decoded.email_verified).toBe(false);
  });

  it('rejects an unknown token the way Firebase does', async () => {
    await expect(auth.verifyIdToken('not-a-real-token', true))
      .rejects.toMatchObject({ code: 'auth/argument-error' });
  });

  it('forgets tokens on reset', async () => {
    const token = tokenFor({ uid: 'transient' });
    resetTokens();

    await expect(auth.verifyIdToken(token, true))
      .rejects.toMatchObject({ code: 'auth/argument-error' });
  });

  it('hands out a bucket that loads but refuses to work', () => {
    // Reading a bucket must succeed: shared/utils/attachmentSigning.ts calls
    // admin.storage().bucket(...) at module scope, so a throw here would take
    // the whole app down on import.
    const bucket: any = admin.storage().bucket('lawfirms');
    expect(bucket.name).toBe('lawfirms');

    // Doing anything with it must not.
    expect(() => bucket.getFiles()).toThrow(/GCS is not available/);
    expect(() => bucket.file('a/b.pdf').getSignedUrl()).toThrow(/GCS is not available/);
  });
});
