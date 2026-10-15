"use client";

import { useCallback, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";

/** How long a failed retry keeps counting against the same route. */
const RETRY_WINDOW_MS = 20_000;

function markerKey(pathname: string) {
  return `paralegix:error-retry:${pathname}`;
}

function readMarker(key: string): number {
  try {
    return Number(window.sessionStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

function writeMarker(key: string, value: number | null) {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, String(value));
  } catch {
    // Private-browsing modes can refuse sessionStorage; retrying still works,
    // it just never escalates to a hard reload.
  }
}

/**
 * Retry handler for a route `error.tsx`.
 *
 * Next's `reset()` only re-renders the failed segment, so on its own it does
 * nothing visible whenever the error is baked into state that survives that
 * re-render - a cached RSC payload, a stale router entry, a module that failed
 * to load. This pairs `reset()` with `router.refresh()` (which discards the
 * cached payload and refetches from the server), and escalates to a full
 * document reload if the same route errors again within a short window, so a
 * second click always changes something.
 *
 * Returns `retrying` for the button's spinner: the boundary either unmounts on
 * success or remounts fresh on failure, so the flag never has to be cleared.
 */
export function useErrorRetry(reset: () => void) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [retrying, setRetrying] = useState(false);

  const retry = useCallback(() => {
    const key = markerKey(pathname || "/");
    const now = Date.now();
    const lastAttempt = readMarker(key);

    setRetrying(true);

    if (lastAttempt && now - lastAttempt < RETRY_WINDOW_MS) {
      // A soft retry already failed here. Clear the marker first so the reloaded
      // page starts over with a soft retry rather than reloading on every click.
      writeMarker(key, null);
      window.location.reload();
      return;
    }

    writeMarker(key, now);
    startTransition(() => {
      router.refresh();
      reset();
    });
  }, [pathname, reset, router]);

  return { retry, retrying: retrying || isPending };
}

export default useErrorRetry;
