/**
 * CORS as the browser sees it, through the real app.
 *
 * The frontend and the API live on different origins, and every authenticated
 * call carries an `Authorization` header, so the browser sends an OPTIONS
 * preflight ahead of it. Without `Access-Control-Max-Age` the browser caches that
 * answer for only a few seconds and repeats the preflight before almost every
 * request, which doubles the round trips of the whole frontend. Nothing on a
 * screen shows that, so it is pinned here.
 */
import { request } from '../support/setupInProcess';

// In the production default list, which is also part of the non-production
// fallback the test environment gets.
const ALLOWED_ORIGIN = 'https://paralegix.com';

const preflight = (origin: string) => request()
  .options('/api/health')
  .set('Origin', origin)
  .set('Access-Control-Request-Method', 'GET')
  .set('Access-Control-Request-Headers', 'authorization,x-timezone');

describe('CORS preflight', () => {
  it('lets the browser cache an allowed origin preflight for two hours', async () => {
    const res = await preflight(ALLOWED_ORIGIN);

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-max-age']).toBe('7200');
  });

  it('grants nothing to an origin outside the allow list', async () => {
    const res = await preflight('https://evil.example');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
