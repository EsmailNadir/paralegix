/**
 * Firebase ID tokens for the stress-test users, minted from Admin custom tokens
 * so the harness needs no passwords. The API caches verified tokens by their
 * string for 30 seconds, so reusing one token per user until it nears expiry is
 * also what a real browser session looks like to the server.
 */
export interface TokenSource {
  token(): Promise<string>;
}

const SIGN_IN_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken';
const REFRESH_MARGIN_MS = 5 * 60_000;

export function customTokenSource(uid: string, apiKey: string, mint: (uid: string) => Promise<string>): TokenSource {
  let cached: { idToken: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;

  const signIn = async (): Promise<string> => {
    const customToken = await mint(uid);
    const res = await fetch(`${SIGN_IN_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    });
    const body: any = await res.json();
    if (!res.ok) throw new Error(`Firebase sign-in for ${uid} failed: ${body?.error?.message || res.status}`);
    cached = { idToken: body.idToken, expiresAt: Date.now() + Number(body.expiresIn) * 1000 };
    return body.idToken;
  };

  return {
    async token() {
      if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) return cached.idToken;
      // Concurrent calls from one user's parallel page loads share one sign-in.
      pending ??= signIn().finally(() => { pending = null; });
      return pending;
    },
  };
}
