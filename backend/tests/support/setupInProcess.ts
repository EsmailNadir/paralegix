/**
 * The single import an in-process spec needs:
 *
 *     import { createFirm, ownerOf, drainEvents } from '../support/setupInProcess';
 *
 * ORDER IS LOAD-BEARING. `installFirebaseMock()` and `installEmailCapture()`
 * register jest.mock factories, and the app pulls both Firebase and the Resend
 * client in transitively the first time anything reaches `src/`. A mock
 * installed after that first require has no effect, and the failure is
 * confusing: the app appears to load, then talks to real Firebase. Installing
 * them here, above every other import, is what makes a spec's own import order
 * irrelevant.
 *
 * Registering the lifecycle hooks here rather than in each spec means the reset
 * cannot be forgotten. A forgotten `resetCaches()` does not fail loudly; it
 * makes an unrelated spec pass against stale data.
 */
import { installFirebaseMock, resetTokens } from './firebase.mock';
import { installEmailCapture, resetEmails } from './email.mock';

installFirebaseMock();
installEmailCapture();

import { installEventDrain, drainEvents, discardPendingEvents } from './events';
import { closeAppPool } from './app';
import { truncateAll, closeTestPool, testPool } from './db';
import { resetCaches } from './caches';
import { unfreezeClock } from './clock';

installEventDrain();

/**
 * Fail loudly when the database clock has drifted from this process's clock.
 *
 * Postgres stamps `created_at` with its own `now()`, and the app compares that
 * against `Date.now()` here. A `podman machine` VM routinely loses time while
 * the host sleeps, and once it is more than a few minutes behind, every rule
 * written as "within N minutes of" starts refusing work that just happened.
 * Observed at 58 minutes behind: seven messaging specs failed on
 * "Messages can only be edited within 30 minutes of sending", for a message
 * created milliseconds earlier, and nothing in the message named a clock.
 *
 * Sixty seconds is far tighter than any window the app enforces (the shortest
 * is thirty minutes) and far looser than any real scheduling jitter.
 *
 * The remedy is `podman machine ssh 'sudo systemctl restart systemd-timesyncd'`,
 * which resyncs without stopping the container.
 */
const MAX_CLOCK_DRIFT_MS = 60 * 1000;
let clockChecked = false;

beforeAll(async () => {
  if (clockChecked) return;
  clockChecked = true;

  const { rows } = await testPool.query<{ now: Date }>('select now() as now');
  const drift = Date.now() - new Date(rows[0].now).getTime();
  if (Math.abs(drift) > MAX_CLOCK_DRIFT_MS) {
    throw new Error(
      `The database clock is ${Math.round(drift / 1000)}s from this process's clock. `
      + 'Every "within N minutes" rule in the app is measured across that gap, so specs will '
      + 'fail for reasons that never mention time. Resync the container: '
      + "podman machine ssh 'sudo systemctl restart systemd-timesyncd'",
    );
  }
});

beforeEach(async () => {
  // Settle before wiping. Some writes are deliberately fire-and-forget and
  // outlive the request that started them: the audit log is the clearest case,
  // and truncating underneath one produces a foreign-key error on a law_firms
  // row that no longer exists. Draining the bus covers listener work; the
  // setImmediate turn gives untracked promises a chance to land. Neither is a
  // guarantee, because a fire-and-forget write is by definition unawaitable, but
  // together they remove the ordinary case.
  await drainEvents();
  await require('../../src/modules/files/shareNotifications.service').drainPendingFlushes();
  // The audit log does NOT go through the event bus: the global middleware fires
  // it from `res.on('finish')` and never awaits it. Left straggling, that insert
  // deadlocks against the ACCESS EXCLUSIVE lock `truncateAll` takes below
  // (Postgres 40P01), and the surviving symptom is a bare `socket hang up` on
  // whichever request is in flight, which reads as a bug in that request.
  const { drainAuditWrites } = require('../../src/modules/audit/audit.service');
  // The audit log is not the only writer that outlives its request. The
  // signature audit trail and the timezone capture do the same and go through
  // neither the bus nor audit.service, so they need their own drain. Three
  // Postgres deadlocks were recorded against signature_audit_events versus this
  // truncate before this line existed; see shared/utils/backgroundWrites.ts.
  const { drainBackgroundWrites } = require('../../src/shared/utils/backgroundWrites');
  await Promise.all([drainAuditWrites(), drainBackgroundWrites()]);
  await new Promise((resolve) => setImmediate(resolve));
  // Drained TWICE, either side of the turn. `res.on('finish')` can fire a tick
  // after the response the test already awaited, so a write can start between
  // the first drain and the truncate below. Draining once took the deadlock rate
  // from 16 per three runs to 1; this closes the remaining window.
  await Promise.all([drainAuditWrites(), drainBackgroundWrites()]);

  await truncateAll();
  resetCaches();
  resetTokens();
  resetEmails();
  discardPendingEvents();
});

afterEach(() => {
  // A spec that froze the clock and then failed would otherwise leave every
  // later spec in the file frozen at its instant.
  unfreezeClock();
});

afterAll(async () => {
  // Let anything still in flight finish against a live pool before closing it,
  // so a late listener does not log an error against an ended pool.
  await drainEvents();
  await require('../../src/modules/files/shareNotifications.service').drainPendingFlushes();
  // A calendar sync waits out a coalescing window on a timer; run it now, so it
  // neither fires after teardown nor queries a pool that has already closed.
  await require('../../src/modules/calendar/calendar.events').flushPendingSyncs();
  await closeTestPool();
  // The app keeps its own pool, separate from the test pool. Both must close or
  // Jest cannot exit: every background timer in the app is unref'd, so the pools
  // are the only handles holding the event loop open. `closeAppPool` is a no-op
  // when the spec never made a request.
  await closeAppPool();
});

export * from './app';
export * from './actors';
export * from './factories';
export * from './events';
export * from './email.mock';
export * from './clock';
export * from './caches';
export { testPool, truncateAll } from './db';
export { tokenFor, unverifiedTokenFor } from './firebase.mock';
