"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import PageHeader from "@/components/ui/PageHeader";
import ProfilePhotoSection from "@/components/settingsComp/ProfilePhotoSection";
import ProfileNameSection from "@/components/settingsComp/ProfileNameSection";
import FirmMembershipSection from "@/components/settingsComp/FirmMembershipSection";
import AccountPrivacySection from "@/components/settingsComp/AccountPrivacySection";
import { useProfile } from "@/contexts/ProfileContext";

/**
 * The account-level settings that belong to the person rather than to any firm.
 * Firm-scoped preferences (notifications, communication method, portal default
 * view, calendar sync) stay on the per-firm settings pages.
 *
 * This route sits outside both portals - the surrounding layout deliberately does
 * not mount NavigationContext, so it uses a plain `<Link>` rather than the
 * `useNavigation()` convention used inside the firm/client layouts - and offers
 * its own way back, chosen by account type.
 */
export default function AccountPage() {
  const { profile } = useProfile();
  // Anything that is not a portal client - including a user still at 'pending' - 
  // belongs on the firm picker, which is also the safe fallback when the profile
  // fetch failed.
  const backHref = profile?.userType === "client" ? "/client/dashboard" : "/dashboard";

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-on-surface-secondary hover:text-on-surface transition-colors mb-4"
      >
        <ArrowLeft size={14} strokeWidth={2} />
        Back
      </Link>

      <PageHeader
        className="mb-6"
        title="Account"
        description="Your profile and personal data. These settings apply everywhere you use Paralegix."
      />

      <div className="space-y-6">
        <ProfilePhotoSection />
        <ProfileNameSection />
        <FirmMembershipSection />
        <AccountPrivacySection />
      </div>
    </div>
  );
}
