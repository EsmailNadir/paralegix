import userService from '@/services/users.service';
import subscriptionService from '@/services/subscription.service';
import { isBillingIncomplete } from '@/lib/plans/billingAccess';

/**
 * Resolve the current user's `userType` from the authoritative backend
 * (`GET /api/users/profile`, Postgres-backed). Auth identity still comes from
 * Firebase; this only reads the profile/type.
 */
export async function getUserTypeFromProfile(): Promise<{
  userType: 'client' | 'firm_member' | 'pending' | null;
  uid: string | null;
}> {
  // Only run on client side
  if (typeof window === 'undefined') {
    return { userType: null, uid: null };
  }

  // Dynamic import to avoid SSR issues
  const { auth } = await import('@/lib/firebase/config');

  if (!auth) {
    return { userType: null, uid: null };
  }

  const currentUser = auth.currentUser;

  if (!currentUser) {
    return { userType: null, uid: null };
  }

  const uid = currentUser.uid;

  try {
    const profile = await userService.getProfile();
    const userType = profile?.userType || 'pending';
    return { userType, uid };
  } catch (error) {
    console.error('❌ getUserTypeFromProfile - Error:', error);
    return { userType: null, uid };
  }
}

/**
 * Get the correct redirect path based on user type.
 * Resolves the user's type/firms from the Postgres-backed profile API.
 */
export async function getRedirectPath(): Promise<string> {
  try {
    // Only run on client side
    if (typeof window === 'undefined') {
      return '/login';
    }

    // Dynamic import to avoid SSR issues
    const { auth: firebaseAuth } = await import('@/lib/firebase/config');
    if (!firebaseAuth) {
      return '/login';
    }
    const currentUser = firebaseAuth.currentUser;

    if (!currentUser) {
      return '/login';
    }

    // Resolve userType from the authoritative profile API.
    const { userType } = await getUserTypeFromProfile();

    // Determine redirect path
    if (!userType || userType === 'pending') {
      return '/complete-registration';
    }

    if (userType === 'client') {
      return '/client/dashboard';
    }

    // A transient failure of the firms lookup must NOT silently mis-route a
    // single-firm member to the multi-firm dashboard. Retry once before
    // falling back, so a single network blip doesn't change the destination.
    let lawFirmIds: string[] = [];
    try {
      ({ lawFirmIds = [] } = await userService.getMyLawFirms());
    } catch (error) {
      console.error('❌ getRedirectPath - Failed to load law firms (retrying once):', error);
      try {
        ({ lawFirmIds = [] } = await userService.getMyLawFirms());
      } catch (retryError) {
        console.error('❌ getRedirectPath - Law firms lookup failed after retry:', retryError);
        // Could not determine firm membership; /dashboard is the safe fallback.
        return '/dashboard';
      }
    }

    if (lawFirmIds.length === 1 && lawFirmIds[0]) {
      const firmId = lawFirmIds[0];
      // A firm that never completed checkout must land on plan selection, not
      // the (locked) workspace. The subscription status endpoint is exempt from
      // the billing gate, so it answers even while the firm is locked. Any
      // failure here falls back to the normal workspace route.
      try {
        const status = await subscriptionService.getStatus(firmId);
        if (isBillingIncomplete(status.billingStatus)) {
          return '/onboarding/plan';
        }
      } catch (error) {
        console.error('❌ getRedirectPath - Failed to resolve billing status:', error);
      }
      return `/lawfirm/${firmId}`;
    }

    return '/dashboard';

  } catch (error) {
    console.error('❌ getRedirectPath - Error:', error);
    return '/dashboard';
  }
}

/**
 * The firm id in a `/lawfirm/<id>/...` path, or null for any other route.
 */
function firmIdFromNextPath(nextPath: string): string | null {
  const [, section, firmId] = nextPath.split(/[?#]/)[0].split('/');
  if (section !== 'lawfirm' || !firmId) return null;
  try {
    return decodeURIComponent(firmId);
  } catch {
    // Malformed percent-encoding. Returned raw, it matches no membership, so the
    // caller sends the user to their own destination instead of throwing after
    // sign-in has already succeeded.
    return firmId;
  }
}

/**
 * Where to send a user who has just signed in, given the `next` deep link.
 *
 * A `next` that points into a firm workspace is not automatically this user's
 * to open. Signing out of `/lawfirm/<id>` leaves that path in the login URL:
 * the firm layout redirects with it so an emailed deep link survives the login
 * round-trip, and on a deliberate logout that means the browser is now sitting
 * on `/login?next=/lawfirm/<previous firm>`. The next sign-in, often a
 * different account on the same browser, then lands on the previous session's
 * firm, where the membership check answers 403 and the workspace shell renders
 * a full-page "your account is not a member of this workspace".
 *
 * So a firm-scoped target is checked against this account's memberships before
 * it is honored, and falls back to the account's own destination when it does
 * not belong to them. Every other `next` is taken as-is, and so is a
 * firm-scoped one whose membership lookup failed: the backend still refuses a
 * firm the user cannot open, and discarding the deep link on a network blip
 * would defeat the parameter it exists to preserve.
 */
export async function resolveLoginDestination(nextPath: string | null): Promise<string> {
  if (!nextPath) return getRedirectPath();

  const firmId = firmIdFromNextPath(nextPath);
  if (!firmId) return nextPath;

  try {
    const { lawFirmIds = [] } = await userService.getMyLawFirms();
    if (lawFirmIds.includes(firmId)) return nextPath;
  } catch (error) {
    console.error('resolveLoginDestination - membership lookup failed:', error);
    return nextPath;
  }

  return getRedirectPath();
}
