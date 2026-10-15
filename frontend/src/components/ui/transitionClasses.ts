/**
 * Enter/exit animation class helpers for overlays driven by
 * `useMountTransition`. The classes are defined in `global.css` (the
 * `overlay-*` keyframes) and pair with the `exiting` flag the hook returns:
 *
 *   const { mounted, exiting } = useMountTransition(open, 100);
 *   if (!mounted) return null;
 *   <div className={`absolute inset-0 bg-black/40 ${backdropAnim(exiting)}`} />
 *   <div className={`... ${cardAnim(exiting)}`} />
 *
 * Keep the `useMountTransition` duration in sync with the EXIT animation
 * declared for each class in global.css: 100ms cards and backdrops (they enter
 * over 120ms and leave over 100ms), 150ms menus. The duration delays the
 * unmount, so it is the exit that has to match, not the enter.
 */

export const backdropAnim = (exiting: boolean) =>
  exiting ? "overlay-backdrop-exit" : "overlay-backdrop-enter";

export const cardAnim = (exiting: boolean) =>
  exiting ? "overlay-card-exit" : "overlay-card-enter";

export const menuAnim = (exiting: boolean) =>
  exiting ? "overlay-menu-exit" : "overlay-menu-enter";

/** Select-style dropdown menus (Dropdown.tsx) - a slight grow instead of a plain fade. */
export const selectMenuAnim = (exiting: boolean) =>
  exiting ? "overlay-select-menu-exit" : "overlay-select-menu-enter";

/** The cookie banner: rises in, drops out of view. Its exit runs 0.2s. */
export const bannerAnim = (exiting: boolean) =>
  exiting ? "cookie-banner-exit" : "cookie-banner-enter";

/**
 * The overflow rows of a capped list (`CollapsibleList`) - a grid-row
 * reveal rather than a fade, so the rows push the content below them down
 * instead of appearing on top of it. 300ms, matching the collapse duration the
 * expandable sections use.
 */
export const listOverflowAnim = (exiting: boolean) =>
  exiting ? "list-overflow-exit" : "list-overflow-enter";
