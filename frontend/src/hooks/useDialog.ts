import { useEffect, useId, useRef } from "react";

const openDialogs: symbol[] = [];

/**
 * Accessibility plumbing shared by every modal dialog: focus management plus a
 * Tab focus trap and Escape-to-close, keyed off the dialog's open state.
 *
 * While `isOpen` is true the hook:
 *  - captures the element that was focused when the dialog opened and restores
 *    focus to it when the dialog closes or unmounts;
 *  - moves focus into the dialog (the first focusable element inside
 *    `dialogRef`, falling back to the container itself, which is given
 *    `tabIndex={-1}` so it can receive focus);
 *  - traps Tab / Shift+Tab so focus cycles within the dialog instead of
 *    escaping to the page behind it;
 *  - calls `onClose` when Escape is pressed.
 *
 * It deliberately does NOT lock body scroll. Modals already call
 * `useBodyScrollLock` directly, and doing it here too would double-count the
 * refcount. Spread `ref={dialogRef}` onto the dialog panel (the card, not the
 * backdrop) and put `id={titleId}` on the heading referenced by
 * `aria-labelledby`.
 *
 * SSR-safe: every DOM access is guarded for an undefined `document`.
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface UseDialogOptions {
  isOpen: boolean;
  onClose: () => void;
}

export function useDialog<T extends HTMLElement = HTMLDivElement>({
  isOpen,
  onClose,
}: UseDialogOptions) {
  const dialogRef = useRef<T | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const dialogId = useRef(Symbol("dialog"));

  // Capture the previously-focused element and move focus into the dialog on
  // open; restore focus to that element on close / unmount.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!isOpen) return;

    const id = dialogId.current;
    openDialogs.push(id);
    previousFocusRef.current = document.activeElement as HTMLElement | null;

    const container = dialogRef.current;
    if (container) {
      const first = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      if (first) {
        first.focus();
      } else {
        if (container.tabIndex < 0) container.tabIndex = -1;
        container.focus();
      }
    }

    return () => {
      const index = openDialogs.indexOf(id);
      if (index >= 0) openDialogs.splice(index, 1);
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      // Only restore if the element is still in the document and focusable.
      if (previous && typeof previous.focus === "function") {
        previous.focus();
      }
    };
  }, [isOpen]);

  // Escape closes the dialog; Tab / Shift+Tab cycle focus within it.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!isOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== dialogId.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key !== "Tab") return;

      const container = dialogRef.current;
      if (!container) return;

      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

      if (focusable.length === 0) {
        // Nothing focusable inside: keep focus pinned to the container.
        e.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  return { dialogRef, titleId };
}

export default useDialog;
