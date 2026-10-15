"use client";

import { createContext, useContext } from "react";

type NavigationContextType = {
  navigate: (href: string) => void;
};

/**
 * Used only by a component rendered outside every provider. A no-op here made a
 * click look handled while going nowhere, so fall back to a full page load and
 * say which layout forgot to wrap the component.
 */
function navigateWithoutProvider(href: string) {
  if (process.env.NODE_ENV !== "production") {
    console.warn(`useNavigation() called outside a NavigationContext provider; loading ${href} with a full page navigation.`);
  }
  if (typeof window !== "undefined") window.location.assign(href);
}

export const NavigationContext = createContext<NavigationContextType>({
  navigate: navigateWithoutProvider,
});

export function useNavigation() {
  return useContext(NavigationContext);
}

/**
 * Fired by the sidebar when a nav item is clicked while already at its own
 * root route -- Link won't navigate (same pathname), so pages whose "current
 * view" is in-page state rather than a route (e.g. Files) need this signal to
 * reset themselves back to their own root view. `detail.href` is the clicked
 * item's root path; listeners should ignore events for other items.
 */
export const SIDEBAR_RESELECT_EVENT = "paralegix:sidebar-reselect";
