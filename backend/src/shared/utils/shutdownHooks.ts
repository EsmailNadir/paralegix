/**
 * Ordered work that must finish before the Postgres pool closes on SIGTERM.
 *
 * Cloud Run sends SIGTERM on every deploy, every scale-in, and every instance
 * recycle, so this path runs constantly rather than exceptionally. Draining HTTP
 * covers work the server knows about; it does not cover work that was
 * deliberately detached from a request — a debounced calendar sync waiting out
 * its coalescing window, an outbox batch mid-dispatch. That work is invisible to
 * `server.close()` and dies with the process.
 *
 * Registration order is run order, and hooks run BEFORE `pool.end()`, so a hook
 * may still use the database. Each is bounded and isolated: one hook that hangs
 * or throws must not stop the others or delay the shutdown past its own budget,
 * because the alternative is Cloud Run's SIGKILL taking everything.
 */

/** Per-hook budget. Deliberately small: the whole shutdown lives inside ~8s. */
export const HOOK_TIMEOUT_MS = Number(process.env.SHUTDOWN_HOOK_TIMEOUT_MS) || 2000;

type ShutdownHook = () => unknown | Promise<unknown>;

const hooks: Array<{ name: string; fn: ShutdownHook }> = [];

/**
 * Register work to run during graceful shutdown.
 *
 * `name` is used in logs, so make it greppable. A non-function `fn` is ignored
 * rather than throwing: registration happens at module load, and a bad
 * registration must not take the whole process down at import time.
 */
export function onShutdown(name: string, fn: ShutdownHook): void {
  if (typeof fn !== 'function') return;
  hooks.push({ name, fn });
}

/**
 * Run every hook in registration order, bounding each one.
 *
 * Sequential rather than parallel because the ordering is meaningful: stopping a
 * worker should happen before flushing what it might otherwise pick up.
 */
export async function runShutdownHooks(): Promise<void> {
  for (const { name, fn } of hooks) {
    const startedAt = Date.now();
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`shutdown hook "${name}" exceeded ${HOOK_TIMEOUT_MS}ms`)),
            HOOK_TIMEOUT_MS,
          ).unref?.()),
      ]);
      console.log(`[shutdown] hook "${name}" finished in ${Date.now() - startedAt}ms`);
    } catch (err) {
      // Never fatal. A hook that fails is strictly better than a shutdown that
      // stalls until SIGKILL and takes the clean pool drain with it.
      console.error(`[shutdown] hook "${name}" failed:`, (err as Error).message);
    }
  }
}
