/**
 * Holds back a Realtime-triggered refetch while the tab is in the background.
 *
 * Realtime subscribers use a change event only as a signal to re-read data over
 * REST. A background tab has nobody looking at that data, and some tables change
 * on a schedule (a backend cron touches signature sessions every minute), so an
 * unattended tab would otherwise make one request per change all day.
 *
 * `run()` calls `fn` straight away while the page is visible. While it is hidden,
 * `run()` only records that something changed; the next time the page becomes
 * visible `fn` runs once, however many changes arrived in between. Nothing runs
 * on becoming visible if nothing changed.
 *
 * Create one per subscription, inside the effect that owns it, and call
 * `dispose()` in that effect's cleanup so a pending run cannot fire after the
 * subscriber is gone.
 */
export interface HiddenDeferral {
  run: () => void;
  dispose: () => void;
}

export function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export function deferWhileHidden(fn: () => void): HiddenDeferral {
  let pending = false;
  let disposed = false;

  const onVisibilityChange = () => {
    if (disposed || isPageHidden() || !pending) return;
    pending = false;
    fn();
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  return {
    run: () => {
      if (disposed) return;
      if (isPageHidden()) {
        pending = true;
        return;
      }
      pending = false;
      fn();
    },
    dispose: () => {
      disposed = true;
      pending = false;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    },
  };
}
