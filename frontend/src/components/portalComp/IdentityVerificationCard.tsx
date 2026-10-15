"use client";

import { ChevronRight } from "lucide-react";
import Card from "@/components/ui/Card";
import NavigationLink from "@/components/ui/NavigationLink";
import { useIdentityStatus } from "@/hooks/useIdentityVerification";

interface IdentityVerificationCardProps {
  lawFirmId: string;
  clientRecordId?: string | null;
  /** False for an organization link, which has no personal ID to verify. */
  enabled: boolean;
}

/**
 * The portal firm home's prompt to verify identity. Shown only while the firm
 * has verification configured and this client has not verified yet; it reads
 * the same cached status as the identity page, so it disappears as soon as a
 * verification there succeeds.
 */
export default function IdentityVerificationCard({ lawFirmId, clientRecordId, enabled }: IdentityVerificationCardProps) {
  const { data } = useIdentityStatus(lawFirmId, clientRecordId, enabled);
  if (!enabled || !data?.configured || data.latest?.status === "verified") return null;

  return (
    <Card className="mb-8 p-5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <h2 className="text-sm font-medium text-on-surface">Verify your identity</h2>
        <p className="text-xs text-on-surface-muted mt-1">
          Your attorney asks you to confirm your identity once, using the ID in your phone&apos;s wallet.
        </p>
      </div>
      <NavigationLink
        href={`/client/lawfirm/${lawFirmId}/identity`}
        className="inline-flex items-center justify-center font-medium transition-[background-color,border-color,color,transform] duration-100 active:scale-[0.985] motion-reduce:active:scale-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--surface)] bg-surface text-on-surface border border-control-border hover:bg-surface-hover focus-visible:ring-focus-ring shrink-0 gap-1.5 px-3.5 py-2 text-xs rounded-xl cursor-pointer"
      >
        Verify now
        <ChevronRight size={14} strokeWidth={2} />
      </NavigationLink>
    </Card>
  );
}
