/**
 * Drives the real Express app in this process.
 *
 * `src/app.ts` already exports the configured app without calling `listen()`;
 * `src/server.ts` owns the listen and the shutdown handling. So there is no app
 * to split: supertest plus a mocked Firebase is the whole mechanism.
 *
 * Every middleware the app mounts runs for real here: helmet, the request
 * logger, the membership and permission gates, the plan gates, the timezone
 * requirement, and the centralized error handler. That is the point. Those gates
 * are where the tenancy and permission bugs live, and a harness that stubbed
 * them would test nothing worth testing.
 *
 * `installFirebaseMock()` MUST run in the spec file before it imports this
 * module. `jest.mock` registers per file, and the app pulls Firebase in
 * transitively at load time, so a mock installed afterwards arrives too late.
 * Importing `setupInProcess` instead of this module handles that ordering.
 */
import http from 'node:http';
import supertest from 'supertest';

// Side-effect import, and it must come before the app is required: it points
// DATABASE_URL at this worker's test database.
import './db';

type Agent = ReturnType<typeof supertest>;

let cachedApp: unknown = null;
let cachedServer: http.Server | null = null;

/**
 * ONE listening server per worker, not one per request.
 *
 * `supertest(app)` given an Express handler binds a fresh ephemeral port for
 * every single call and closes it afterwards. A full run makes tens of
 * thousands of those per worker, and the kernel recycles ports faster than the
 * closed sockets leave TIME_WAIT, so a new request occasionally lands on a port
 * whose previous server is gone. The client then reads no response, or reads
 * bytes that are not a status line, and reports `socket hang up` or
 * `Parse Error: Expected HTTP/, RTSP/ or ICE/`.
 *
 * Neither message names the spec that suffers it, and the victim moves from run
 * to run, which is why this read for a long time as unrelated flakiness in
 * whichever billing spec drew the short straw.
 *
 * Handing supertest a server that is ALREADY listening makes it reuse that
 * address instead of binding its own: the whole suite then shares one port per
 * worker. `unref` keeps the listener from holding the event loop open, and
 * `closeAppPool` closes it so nothing outlives the run.
 */
function listeningServer(): http.Server {
  if (!cachedServer) {
    cachedServer = http.createServer(cachedApp as never);
    cachedServer.listen(0);
    cachedServer.unref();
  }
  return cachedServer;
}

/**
 * Close the app's pool. Separate from the test pool, and both must close or Jest
 * cannot exit: every background timer in the app is unref'd, so the pools are the
 * only handles holding the event loop open.
 *
 * Unconditional on purpose. Guarding this on "was the app loaded" looks like a
 * saving and is a teardown leak: `resetCaches()` runs in beforeEach and requires
 * the portal and permission modules, which pull in the database module, so the
 * pool exists for every spec whether or not it ever issued a request. Requiring
 * the module here does not open a connection, so closing an unused pool is free.
 */
export async function closeAppPool(): Promise<void> {
  if (cachedServer) {
    const server = cachedServer;
    cachedServer = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await require('../../src/shared/database/db').pool.end();
}

/**
 * The bare app, with no caller attached. Use it for routes that are meant to be
 * reachable unauthenticated, and for asserting the 401 envelope.
 */
export function request(): Agent {
  if (!cachedApp) {
    // Required at call time rather than at module scope, so the spec's
    // jest.mock factories are registered before the app's import graph is walked.
    // The environment it reads is set in ./db, which loads first.
    cachedApp = require('../../src/app');
  }
  return supertest(listeningServer() as never);
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export type CallerAgent = {
  [M in (typeof METHODS)[number]]: (path: string) => supertest.Test;
};

/**
 * An agent that carries one caller's token on every request.
 *
 * `x-timezone` is sent by default because `requireTimezone` is mounted on the
 * client, calendar and billing routers. Without it those routes fail for a
 * reason that has nothing to do with what the test is checking, which is a
 * costly way to spend an afternoon. A spec that cares about the timezone
 * overrides it with a further `.set()`.
 */
export function as(token: string, timeZone = 'America/New_York'): CallerAgent {
  const agent = request();
  const build = (method: (typeof METHODS)[number]) => (path: string) => agent[method](path)
    .set('Authorization', `Bearer ${token}`)
    .set('x-timezone', timeZone);

  return Object.fromEntries(
    METHODS.map((method) => [method, build(method)]),
  ) as CallerAgent;
}
