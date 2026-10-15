/**
 * Await the async listeners an emit started.
 *
 * `eventBus.emit` is a plain EventEmitter emit, and every listener in the app is
 * registered as an `async` function:
 *
 *     eventBus.on(TASK_CREATED, async ({ ... }) => { ... })
 *
 * `emit` calls each listener and returns the moment they yield. It does not
 * await their bodies. That is right in production, where a request must not wait
 * on a notification write, but in a test it means the assertion races the
 * listener. Three of the six organization bugs in be459ec0 are notification
 * fan-out bugs, so a spec covering them has to be able to wait.
 *
 * The mechanism wraps REGISTRATION, not emit. Each listener handed to
 * `on`/`once`/`addListener`/`prependListener` is replaced by a wrapper that
 * calls it once and records the promise it returns. `drainEvents()` awaits those
 * promises.
 *
 * Wrapping emit instead was the obvious approach and is wrong: to capture a
 * promise there you have to invoke each listener yourself, on top of the real
 * emit, so every listener runs TWICE. That changes what the app does under test,
 * which is the one thing a harness must not do. A listener that is not perfectly
 * idempotent double-writes, and a spec asserting "one notification" sees two.
 *
 * ORDERING: `installEventDrain()` must run before the app registers its
 * listeners, which `setupInProcess.ts` guarantees by installing at module scope
 * while the app is required lazily on the first request. Listeners already
 * registered at install time are wrapped in place as a fallback.
 */
const bus = require('../../src/shared/events/eventBus');

type Listener = (...args: unknown[]) => unknown;

let pending: Promise<unknown>[] = [];
let installed = false;

// original -> wrapper, so removeListener/off with the ORIGINAL function still
// finds the registered wrapper. EventEmitter removes by identity, so without
// this a module that unsubscribes could never do so.
const wrappers = new Map<Listener, Listener>();

function wrap(listener: Listener): Listener {
  const existing = wrappers.get(listener);
  if (existing) return existing;

  const wrapped: Listener = function wrapped(this: unknown, ...args: unknown[]) {
    const result = listener.apply(this, args);
    // Only async listeners return anything awaitable. A sync listener has
    // already finished by the time it returns, so there is nothing to record.
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      // The rejection is swallowed HERE only, on the copy held for draining.
      // The listener's own promise is untouched, so the app's error handling
      // (each listener has its own try/catch) is unaffected.
      pending.push((result as Promise<unknown>).catch(() => undefined));
    }
    return result;
  };

  // Node's own `once` uses this convention to expose the original; matching it
  // keeps `bus.listeners()` inspectable and rawListeners() meaningful.
  (wrapped as unknown as { listener: Listener }).listener = listener;
  wrappers.set(listener, wrapped);
  return wrapped;
}

export function installEventDrain(): void {
  if (installed) return;
  installed = true;

  for (const method of ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener']) {
    const native = bus[method].bind(bus);
    bus[method] = (eventName: string, listener: Listener) => native(eventName, wrap(listener));
  }

  for (const method of ['removeListener', 'off']) {
    const native = bus[method].bind(bus);
    bus[method] = (eventName: string, listener: Listener) =>
      native(eventName, wrappers.get(listener) || listener);
  }

  // Fallback for anything registered before this ran, so a spec that reaches
  // src/ on its own import path is still covered.
  for (const eventName of bus.eventNames()) {
    for (const listener of bus.rawListeners(eventName) as Listener[]) {
      if (wrappers.has(listener)) continue;
      bus.removeListener(eventName, listener);
      bus.on(eventName, listener);
    }
  }
}

/**
 * Await every listener started since the last drain.
 *
 * Loops because a listener may itself emit, which enqueues more work while this
 * batch is settling. It returns once a full pass adds nothing new.
 *
 * The macrotask yield before declaring the queue empty is what makes "nothing
 * new" trustworthy. A producer that bounds its fan-out (the bulk task routes run
 * three listener chains at a time) starts the NEXT event only once a running one
 * settles, and the hop from "this listener's promise resolved" to "the next
 * listener has been called and registered here" is several microtasks long. An
 * empty `pending` read in the same microtask drain therefore means "not yet",
 * not "done". `setImmediate` runs after the whole microtask queue, so the next
 * batch has registered by the time the emptiness check is believed.
 */
export async function drainEvents(): Promise<void> {
  for (;;) {
    while (pending.length) {
      const batch = pending;
      pending = [];
      await Promise.allSettled(batch);
    }
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    if (!pending.length) return;
  }
}

/** Forget anything queued without awaiting it. For teardown, not for specs. */
export function discardPendingEvents(): void {
  pending = [];
}
