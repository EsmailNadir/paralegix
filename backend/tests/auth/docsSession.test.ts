/**
 * Documentation-session exchange tests.
 *
 * The docs site accepts only the short-lived cookie minted here, not a Firebase
 * token. These route-level checks keep the exchange, its failure mode, and
 * sign-out cookie cleanup aligned with the docs edge middleware contract.
 */
import { as, request, tokenFor } from '../support/setupInProcess';

const jwt = require('jsonwebtoken');

const DOCS_SECRET = 'docs-session-test-secret';

function cookieValue(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(header).toBeTruthy();
  return header!.split(';', 1)[0].split('=', 2)[1];
}

describe('documentation-session exchange', () => {
  beforeEach(() => {
    process.env.DOCS_SESSION_SECRET = DOCS_SECRET;
  });

  afterEach(() => {
    delete process.env.DOCS_SESSION_SECRET;
  });

  it('mints a 12-hour, docs-scoped cookie for a verified caller', async () => {
    const token = tokenFor({ uid: 'docs-user', email: 'docs.user@example.test' });

    const response = await as(token).post('/api/auth/docs-session');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ expiresIn: 12 * 60 * 60 });

    const setCookie = response.headers['set-cookie'];
    const claims = jwt.verify(cookieValue(setCookie), DOCS_SECRET, { algorithms: ['HS256'] });
    expect(claims).toMatchObject({
      sub: 'docs-user',
      email: 'docs.user@example.test',
      scope: 'docs',
    });
    expect(claims.exp - claims.iat).toBe(12 * 60 * 60);

    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Path=/');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain(`Max-Age=${12 * 60 * 60}`);
  });

  it('refuses an anonymous caller before attempting to issue a cookie', async () => {
    const response = await request().post('/api/auth/docs-session');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('NO_TOKEN');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('fails closed when the shared docs secret is not configured', async () => {
    delete process.env.DOCS_SESSION_SECRET;
    const response = await as(tokenFor({ uid: 'docs-unconfigured' })).post('/api/auth/docs-session');

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('DOCS_SESSION_UNCONFIGURED');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('clears the docs cookie without requiring a Firebase token', async () => {
    const response = await request().delete('/api/auth/docs-session');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: 'Documentation session cleared' });

    const header = Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie'][0]
      : response.headers['set-cookie'];
    expect(header).toContain('plx_docs=;');
    expect(header).toContain('Path=/');
    expect(header).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  });
});
