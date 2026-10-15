'use client';

import { createContext, useContext } from 'react';

/**
 * True for anything rendered inside a sidebar shell (the firm workspace or the
 * client portal), false on standalone routes such as /login or /auth/action.
 *
 * Status screens (403, 404, offline, unexpected error, ...) are whole-viewport
 * pages. When one renders inside a shell - a route `error.tsx`, a permission
 * gate, a page-level offline fallback - normal layout would place it in the
 * content pane beside the sidebar, where it reads as a card in a half-broken
 * workspace. Shell layouts set this to true so `StatusPage` pins itself over
 * the viewport instead, covering the sidebar the way a standalone status route
 * would.
 */
export const AppShellContext = createContext(false);

export function useInAppShell() {
  return useContext(AppShellContext);
}
