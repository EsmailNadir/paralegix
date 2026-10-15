"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import LoadingSpinner from "@/components/LoadingSpinner";
import { getRedirectPath } from "@/lib/utils/redirect";

/**
 * Sends an already-signed-in visitor from the public landing page to wherever
 * they belong (firm shell, client portal, or dashboard).
 *
 * This is deliberately a leaf island rather than a guard wrapped around the
 * page: the landing page is the primary search-engine surface, so its copy has
 * to be in the prerendered HTML unconditionally. Gating the whole page on auth
 * state would put a spinner in that HTML instead, because `useAuth` starts out
 * loading and prerendering captures exactly that first render.
 *
 * Consequently the marketing page is what renders while auth resolves, and the
 * blocking overlay goes up only once a signed-in user is confirmed and a
 * redirect is genuinely in flight.
 */
export default function SignedInRedirect() {
  const router = useRouter();
  const { user, loading } = useAuth();

  // Derived, not stored: a redirect is in flight exactly when auth has resolved
  // and produced a user. Keeping it out of state also keeps the overlay and the
  // effect below from disagreeing on a re-render.
  const redirecting = !loading && !!user;

  useEffect(() => {
    if (!redirecting) return;

    let cancelled = false;
    // Backstop: if resolving the destination hangs, still get the user off the
    // marketing page rather than stranding them under the overlay.
    const timeout = setTimeout(() => {
      if (!cancelled) router.push("/dashboard");
    }, 8000);

    getRedirectPath()
      .then((path) => {
        if (cancelled) return;
        clearTimeout(timeout);
        router.push(path);
      })
      .catch(() => {
        if (cancelled) return;
        clearTimeout(timeout);
        router.push("/dashboard");
      });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [redirecting, router]);

  if (!redirecting) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-mkt-paper">
      <LoadingSpinner fullPage />
    </div>
  );
}
