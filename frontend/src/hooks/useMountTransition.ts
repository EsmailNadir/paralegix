import { useEffect, useRef, useState } from "react";

/**
 * Keeps a component mounted across its enter AND exit animation.
 *
 * Conditional rendering (`if (!open) return null`) unmounts instantly, so an
 * exit animation never gets a chance to play. This hook delays unmount until
 * the close animation finishes and exposes an `exiting` flag so the consumer
 * can swap between its enter and exit CSS animation classes.
 *
 * Usage (pair with the `overlay-*` animation classes in global.css):
 *   const { mounted, exiting } = useMountTransition(open);
 *   if (!mounted) return null;
 *   <div className={exiting ? "overlay-card-exit" : "overlay-card-enter"} />
 *
 * Keep `durationMs` in sync with the CSS animation EXIT duration on the element:
 * that is what this delays the unmount by. The default matches the `overlay-card`
 * and `overlay-backdrop` exits (100ms); a menu passes 150 explicitly.
 * `tests/styles/overlayTiming.test.ts` fails if the two sides drift apart.
 */
export function useMountTransition(isOpen: boolean, durationMs = 100) {
  const [mounted, setMounted] = useState(isOpen);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mount (and cancel any in-progress exit) when opened
      setExiting(false);
      setMounted(true);
      return;
    }

    if (!mounted) return;

    // Play the exit animation, then unmount once it has finished.
    setExiting(true);
    const timeout = setTimeout(() => {
      setMounted(false);
      setExiting(false);
    }, durationMs);
    return () => clearTimeout(timeout);
  }, [isOpen, mounted, durationMs]);

  return { mounted, exiting };
}

/**
 * Runs a modal's cleanup once it has finished animating closed.
 *
 * Emptying a form, dropping the record being edited, or clearing an error is
 * visible work, and a modal stays on screen for its exit animation. Doing it in
 * the close handler means the user watches the dialog blank out and *then*
 * disappear. Move that work here instead, so the modal closes showing whatever
 * it was showing:
 *
 *   const close = () => setOpen(false);            // hides, nothing else
 *   useResetAfterClose(open, () => { … });         // clears once it is gone
 *
 * `reset` is read through a ref, so it does not need to be memoized. Nothing
 * runs until the dialog has actually been opened once, and reopening inside the
 * delay cancels the pending reset.
 *
 * Keep `delayMs` at or above the exit animation's duration.
 */
export function useResetAfterClose(isOpen: boolean, reset: () => void, delayMs = 200) {
  const resetRef = useRef(reset);
  useEffect(() => {
    resetRef.current = reset;
  });

  const hasOpened = useRef(isOpen);
  useEffect(() => {
    if (isOpen) {
      hasOpened.current = true;
      return;
    }
    if (!hasOpened.current) return;
    const timeout = setTimeout(() => {
      hasOpened.current = false;
      resetRef.current();
    }, delayMs);
    return () => clearTimeout(timeout);
  }, [isOpen, delayMs]);
}

/**
 * Holds on to the last value a dialog was given while it was open.
 *
 * Parents routinely clear the record a dialog is showing in the same handler
 * that closes it (`setOpen(false); setEditing(null)`), which blanks the dialog's
 * content for the length of its exit animation - "Delete ""?" and the like.
 * Render this instead of the raw prop and the content holds still on the way
 * out. It reads the prop normally whenever the dialog is open, so nothing goes
 * stale while the user can see it.
 */
export function useLastOpenValue<T>(isOpen: boolean, value: T): T {
  const held = useRef(value);
  if (isOpen) held.current = value;
  return isOpen ? value : held.current;
}

export default useMountTransition;
