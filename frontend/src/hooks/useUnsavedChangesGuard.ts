'use client';

import { useCallback, useEffect, useRef } from 'react';

/** Marks the placeholder entry this hook parks on the history stack. */
const GUARD_STATE_KEY = "__unsavedGuard";

/**
 * Warn before work in progress is thrown away by leaving the page.
 *
 * Covers the two exits an in-app Back button cannot: the browser's Back
 * gesture, and reload / tab close.
 *
 * Back cannot be cancelled, only undone, so while `enabled` the hook parks a
 * duplicate history entry on top of the current one. The first Back press pops
 * the duplicate instead of leaving the page; the handler pushes it straight
 * back on and calls `onBlocked`, which is where the caller opens its own
 * confirm dialog. History depth stays put however many times Back is pressed.
 *
 * Reload and tab close get the browser's own generic prompt via `beforeunload`
 * - the wording there belongs to the browser and cannot be customised.
 *
 * Confirming the discard is the caller's job. Where the surface has a leave
 * action of its own - the placer's Back button navigates to the signatures page
 * - run that: a full navigation moves forward off the parked entry, so nothing
 * needs unwinding. Where it does not, call the returned `leave()`, which steps
 * back past both the placeholder and the page. On a tab whose only entry is
 * this page (a signing link opened straight from an email) there is nowhere to
 * step back to and it does nothing, exactly as Back would without the guard.
 *
 * @param enabled  Whether there is unsaved work worth warning about.
 * @param onBlocked Called when Back was intercepted; open the confirm dialog.
 */
export function useUnsavedChangesGuard(enabled: boolean, onBlocked: () => void) {
  const enabledRef = useRef(enabled);
  const onBlockedRef = useRef(onBlocked);
  const parked = useRef(false);
  const released = useRef(false);

  useEffect(() => {
    enabledRef.current = enabled;
    onBlockedRef.current = onBlocked;
  });

  // Park the placeholder the moment there is something to lose. Re-armed rather
  // than parked once, because the placeholder is spent if the user empties their
  // changes and presses Back before starting over.
  useEffect(() => {
    if (!enabled || parked.current || released.current) return;
    window.history.pushState({ ...window.history.state, [GUARD_STATE_KEY]: true }, "");
    parked.current = true;
  }, [enabled]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!enabledRef.current || released.current) return;
      event.preventDefault();
      // Older browsers only show the prompt when returnValue is set.
      event.returnValue = "";
    };

    const onPopState = () => {
      // Nothing left to lose, or the user already confirmed: let the press
      // through and note that the placeholder is gone, so a later edit parks a
      // fresh one.
      if (!enabledRef.current || released.current) {
        parked.current = false;
        return;
      }
      // Some browsers (Safari in particular) can refire popstate right after a
      // pushState call made from inside a popstate handler. If the entry we just
      // landed on is already the parked placeholder, this is that spurious
      // re-fire rather than a real Back press - pushing again would trigger
      // another one, looping forever. Bail out.
      const currentState = window.history.state as Record<string, unknown> | null;
      if (currentState?.[GUARD_STATE_KEY]) return;
      window.history.pushState({ ...window.history.state, [GUARD_STATE_KEY]: true }, "");
      onBlockedRef.current();
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  // Stand down for a departure the user has already agreed to, so the browser's
  // own reload/close prompt doesn't fire on top of the confirm dialog they just
  // accepted. Call it immediately before navigating away.
  const release = useCallback(() => {
    released.current = true;
  }, []);

  const leave = useCallback(() => {
    release();
    // Past the placeholder and the page under it, back to wherever the user
    // came from.
    window.history.go(parked.current ? -2 : -1);
  }, [release]);

  return { release, leave };
}

export default useUnsavedChangesGuard;
