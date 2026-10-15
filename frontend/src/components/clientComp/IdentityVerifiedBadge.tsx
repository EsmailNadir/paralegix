"use client";

import StatusBadge from "@/components/ui/StatusBadge";
import Tooltip from "@/components/ui/Tooltip";
import { useClientIdentityVerification } from "@/hooks/useIdentityVerification";
import { formatDate } from "@/lib/utils/dateUtils";
import { identityCheckLabel } from "@/constants/identityChecks";

function checkValue(value: boolean | string): string {
  if (value === true) return "passed";
  if (value === false) return "failed";
  return value;
}

/**
 * The client detail header's identity badge: green "ID verified <date> · <state>"
 * once the client has verified in the portal, amber "Verified, name differs"
 * when the name on the ID does not match the record, and nothing at all for a
 * client who has never verified (a failed attempt included) or while the read
 * is pending or refused. The tooltip lists the checks Credence ran.
 */
export default function IdentityVerifiedBadge({ lawFirmId, clientId }: { lawFirmId: string; clientId: string }) {
  const { data } = useClientIdentityVerification(lawFirmId, clientId);
  const verified = data?.verified;
  if (!verified || verified.status !== "verified") return null;

  const nameDiffers = verified.nameMatchesRecord === false;
  const label = nameDiffers
    ? "Verified, name differs"
    : ["ID verified", formatDate(verified.completedAt ?? verified.createdAt, "")].filter(Boolean).join(" ") +
      (verified.issuer ? ` · ${verified.issuer}` : "");
  const checks = Object.entries(verified.checks ?? {});

  return (
    <Tooltip
      enterDelay={300}
      title={
        checks.length > 0 ? (
          <span className="block">
            {checks.map(([key, value]) => (
              <span key={key} className="block">
                {identityCheckLabel(key)}: {checkValue(value)}
              </span>
            ))}
          </span>
        ) : (
          ""
        )
      }
    >
      <span tabIndex={0} className="inline-flex rounded-full">
        <StatusBadge variant={nameDiffers ? "warning" : "success"}>{label}</StatusBadge>
      </span>
    </Tooltip>
  );
}
