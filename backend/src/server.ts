require('dotenv').config();

// Fail fast in production when a hard-required secret is missing, instead of
// booting a half-configured server that 500s on first use. DATABASE_URL is the
// sole data store, so its absence is fatal. The Firebase key may legitimately be
// a local file in dev, and SUPABASE_JWT_SECRET / CRON_SECRET / DOCS_SESSION_SECRET
// disable specific features when unset, so those are warned about rather than
// fatal. (An unset DOCS_SESSION_SECRET fails closed: the docs site stays locked
// and nobody can be issued a session for it.)
if (process.env.NODE_ENV === 'production') {
  const missing = ['DATABASE_URL'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[startup] Missing required env var(s) in production: ${missing.join(', ')}. Exiting.`);
    process.exit(1);
  }
  for (const k of ['SUPABASE_JWT_SECRET', 'CRON_SECRET', 'DOCS_SESSION_SECRET']) {
    if (!process.env[k]) {
      console.warn(`[startup] WARNING: ${k} is not set; the feature/safeguard that depends on it is disabled.`);
    }
  }
  // Stripe webhook routes verify signatures with these secrets. If one is missing
  // in production the corresponding webhook silently fails signature checks, so
  // plan/billing-status updates stop syncing. Warn loudly; do not crash.
  const missingWebhookSecrets = ['STRIPE_WEBHOOK_SECRET', 'STRIPE_SUBSCRIPTION_WEBHOOK_SECRET']
    .filter((k) => !process.env[k]);
  if (missingWebhookSecrets.length) {
    console.warn(`[startup] WARNING: missing Stripe webhook signing secret(s): ${missingWebhookSecrets.join(', ')}. The affected Stripe webhooks will fail signature verification and billing/plan updates will not sync.`);
  }
}

const app = require('./app');

const port = process.env.PORT || 5001;

// Safety net: a stray unhandled promise rejection (e.g. a transient Firebase /
// network blip on a detached promise) must NOT take the whole multi-tenant API
// down. Log it loudly and keep serving. The originating request still fails on
// its own awaited path. uncaughtException is left to log-and-exit because process
// state may be corrupt after a truly synchronous uncaught throw.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// Node prints warnings without a stack; this logs where each one came from.
require('./shared/utils/processWarnings').installWarningLogger(process, require('./shared/utils/logger').logger);

// Cloud Run's front end pools connections to this container and reuses them on
// an idle window longer than Node's 5s default. When Node hangs up a socket the
// proxy still believes is good, the next request sent on it dies as a 502 that
// no application log explains — intermittent, spread across unrelated URLs, and
// indistinguishable from "the app is flaky". Outlasting the proxy's window is
// the fix; `headersTimeout` must stay above `keepAliveTimeout` so a reused
// connection is never cut off between its handshake and its headers.
const KEEP_ALIVE_TIMEOUT_MS = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 620000);
const HEADERS_TIMEOUT_MS = KEEP_ALIVE_TIMEOUT_MS + 1000;

// How long a client may take to finish SENDING a request. Node's default is
// five minutes, which on Cloud Run means a client that stalls mid-body holds an
// instance slot for five minutes; this is the backstop for that, and for slow-
// loris-style requests generally.
//
// It is NOT a ceiling on how long a request takes to answer, and must not be
// reasoned about as one. `server.requestTimeout` covers the receive phase only:
// once the request has arrived, Node stops counting, and a handler may then run
// for as long as it likes with the socket left open and the eventual response
// delivered normally (verified directly — a handler sleeping 2x past the limit
// still returned 200 on an intact socket, while the identical server killed a
// client that stalled mid-body with ERR_HTTP_REQUEST_TIMEOUT). Enforcement is
// also polled on `connectionsCheckingInterval`, 30s by default, so the real
// receive budget is this value plus up to one polling interval.
//
// Two consequences worth keeping straight:
//   - It does not conflict with the longer deadlines elsewhere. The 20s read
//     and 40s write budgets in `middleware/requestTimeout.ts` and the cron
//     budgets in `utils/reminderHelpers.ts` all measure handler time, which this
//     never touches. What actually bounds a daily cron pass is Cloud Scheduler's
//     180s attempt deadline, and the 150s cron budget sits under that on purpose.
//   - Upload bytes go browser-to-storage, so this socket deadline now applies
//     only to the small JSON init/finalize requests, not to the file transfer.
const SOCKET_REQUEST_TIMEOUT_MS = Number(process.env.SOCKET_REQUEST_TIMEOUT_MS || 60000);

const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;
server.requestTimeout = SOCKET_REQUEST_TIMEOUT_MS;

// Graceful shutdown. Cloud Run sends SIGTERM before it tears a revision down —
// on every deploy, every scale-in, and every instance recycle. Without a handler
// the process dies immediately and whatever was mid-flight dies with it, which
// for this API means half-applied multi-table writes (invoices + line items,
// trust entries, junction syncs). Stop accepting new connections, let the
// in-flight requests finish, then drain the Postgres pool.
//
// SHUTDOWN_TIMEOUT_MS is the backstop for a request that will not finish; it is
// kept under Cloud Run's own 10s SIGKILL grace so the clean path wins the race.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 8000);
let shuttingDown = false;

async function shutdown(signal: any) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received; draining.`);

  const forceExit = setTimeout(() => {
    console.error(`[shutdown] still busy after ${SHUTDOWN_TIMEOUT_MS}ms; exiting anyway.`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  // Don't let the timer itself keep the process alive once draining finishes.
  if (typeof forceExit.unref === 'function') forceExit.unref();

  // Keep-alive sockets sitting idle between requests would otherwise hold
  // `close` open until they time out on their own. Hang those up now; sockets
  // with a request in flight are left alone.
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();

  server.close(async () => {
    // Detached work first, while the pool is still open. `server.close()` waits
    // only for in-flight HTTP; work deliberately scheduled outside a request —
    // a debounced calendar sync, an outbox batch — is invisible to it and would
    // otherwise die here. Each hook is individually bounded, so a stuck one
    // cannot eat the shutdown budget.
    try {
      const { runShutdownHooks } = require('./shared/utils/shutdownHooks');
      await runShutdownHooks();
    } catch (err: any) {
      console.error('[shutdown] hooks failed:', err.message);
    }

    try {
      const { pool } = require('./shared/database/db');
      await pool.end();
    } catch (err: any) {
      console.error('[shutdown] pool drain failed:', err.message);
    }
    clearTimeout(forceExit);
    console.log('[shutdown] done.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// The process entry point exports nothing; the empty export marks it as a
// MODULE so its top-level bindings stay file-scoped.
export {};
