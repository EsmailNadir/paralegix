"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import userService from "@/services/users.service";
import SkipLink from "@/components/ui/SkipLink";
import LoadingSpinner from "@/components/LoadingSpinner";
import { isEmailVerified } from "@/lib/utils/emailVerification";
import { ProfileContext } from "@/contexts/ProfileContext";
import type { User } from "@/types";

/**
 * Account settings are per-user, not per-firm: every endpoint behind this route
 * is authenticated by token alone. So this layout gates on a verified sign-in and
 * nothing else - no firm id, no membership, no permissions - which is what makes
 * the route reachable for a client whose firm removed them and for a firm member
 * who has not created a firm yet. Neither can open a firm-scoped settings page.
 *
 * userType is deliberately not checked either: a user still stuck at 'pending'
 * must be able to export or erase their account.
 */
export default function AccountLayoutClient({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<User | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);

  useEffect(() => {
    if (loading) return;

    // Both redirects are resolved through one branch so there is a single place
    // that clears `profileLoading`. Neither path reaches the profile fetch, so
    // nothing else would clear the flag and the render below would hold the
    // full-page spinner for as long as this layout stays mounted, instead of
    // falling through to `return null` while the redirect runs. `replace`, not
    // `push`, so the back button returns the user where they came from rather
    // than bouncing them off this gate again.
    const redirectTo = !user ? '/login' : !isEmailVerified(user) ? '/verify-email' : null;
    if (redirectTo) {
      router.replace(redirectTo);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the profile-fetch loading flag on a path that never fetches a profile
      setProfileLoading(false);
      return;
    }

    let active = true;
    userService
      .getProfile()
      .then((p) => { if (active) setProfile(p); })
      // The cards fall back to the Firebase user for name/email, so a failed
      // profile fetch degrades rather than blocking access to account deletion.
      .catch(() => { if (active) setProfile(null); })
      .finally(() => { if (active) setProfileLoading(false); });

    return () => { active = false; };
  }, [user, loading, router]);

  if (loading || profileLoading) {
    return <LoadingSpinner fullPage />;
  }

  if (!user || !isEmailVerified(user)) return null;

  return (
    <ProfileContext value={{ profile }}>
      <div className="min-h-screen bg-page">
        <SkipLink />
        <main id="main-content" tabIndex={-1}>{children}</main>
      </div>
    </ProfileContext>
  );
}
