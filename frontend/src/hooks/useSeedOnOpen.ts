"use client";

import { useState } from "react";

/**
 * Seed a modal's form state at the moment it opens, DURING RENDER rather than in
 * an effect.
 *
 * An effect runs after the opening render has already committed, so the modal
 * paints one frame holding the previous session's values before the reset lands
 * - visible as a flash of the last-edited record's data. Updating state during
 * render instead makes React throw that pass away and re-render before it ever
 * commits, so the first painted frame is already correct. This is the pattern
 * React documents for "adjusting state when a prop changes", and it is what
 * `react-hooks/set-state-in-effect` is steering callers toward.
 *
 * `seed` runs when `open` goes false -> true, and again while the modal is open
 * whenever `seedKey` changes (the parent swapping which record is being edited
 * without closing in between).
 *
 * `seedKey` MUST be a primitive - pass `editing?.id`, never `editing`. Comparing
 * object identity here would reseed on every parent render, and because this
 * runs during render that is an infinite loop rather than a wasted effect.
 *
 * Usage:
 *   useSeedOnOpen(open, () => {
 *     setName(editing?.name ?? "");
 *     setError(null);
 *   }, editing?.id ?? null);
 */
export default function useSeedOnOpen(open: boolean, seed: () => void, seedKey: string | number | boolean | null = null) {
  // Starts closed so a component that mounts already-open still seeds, matching
  // the mount-time run of the effect this replaces.
  const [prev, setPrev] = useState<{ open: boolean; key: typeof seedKey }>({ open: false, key: seedKey });

  if (open !== prev.open || (open && !Object.is(seedKey, prev.key))) {
    setPrev({ open, key: seedKey });
    if (open) seed();
  }
}
