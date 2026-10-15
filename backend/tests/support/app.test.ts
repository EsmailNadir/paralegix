import { installFirebaseMock, tokenFor } from './firebase.mock';

installFirebaseMock();
import { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request, as } from './app';

const ABSENT_FIRM = '00000000-0000-0000-0000-000000000000';

describe('the harness server', () => {
  /**
   * `supertest(app)` given an Express handler binds a fresh ephemeral port per
   * request. Tens of thousands of those per worker outran the kernel's ability
   * to recycle ports, and the occasional request landed on one whose previous
   * server had gone: `socket hang up`, or `Parse Error: Expected HTTP/`, in
   * whichever spec happened to be running. Twelve runs of the auth and billing
   * specs went from four failures to none once every request shared one
   * listening server.
   *
   * So this is not a style preference. If these go red, that flakiness is back.
   */
  it('serves every request from one listening server', async () => {
    const first = request().get('/api/health');
    const second = as(tokenFor({ uid: 'nobody-uid' })).get('/api/health');

    expect(first.app).toBe(second.app);
    expect(first.app).toBeInstanceOf(Server);
    expect((first.app as Server).listening).toBe(true);

    await first;
    await second;
  });

  it('keeps the same port across many requests', async () => {
    // Each request is awaited rather than merely built. An unawaited supertest
    // Test on the old per-request server left a listener open, so a broken
    // harness made this hang instead of failing, which is useless as a guard.
    const ports: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const call = request().get('/api/health');
      const server = call.app as Server;
      await call;
      const address = server.address();
      expect(typeof address === 'object' && address !== null).toBe(true);
      ports.push((address as AddressInfo).port);
    }

    expect(new Set(ports).size).toBe(1);
  });
});

describe('in-process app', () => {
  it('gets past auth with a minted token', async () => {
    const res = await as(tokenFor({ uid: 'nobody-uid' })).get(`/api/lawfirms/${ABSENT_FIRM}/clients`);

    // The uid is valid as far as auth is concerned but holds no membership row,
    // so the request reaches the app and is refused by the membership gate. Any
    // status but 401 proves auth was satisfied in process, with no network.
    expect(res.status).toBe(403);
  });

  it('answers a mistyped path with ROUTE_NOT_FOUND', async () => {
    const res = await request().get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ROUTE_NOT_FOUND');
  });
});

// Closing the app's own pool (separate from the test pool) is what lets Jest
// exit on its own. Every background timer in the app is already unref'd, so the
// pg pool is the only handle holding the event loop open.
afterAll(async () => {
  await require('../../src/shared/database/db').pool.end();
});
