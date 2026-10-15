"use client";

import { useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import RoleBadge from "@/components/ui/RoleBadge";
import Tooltip from "@/components/ui/Tooltip";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import SuccessNotification from "@/components/SuccessNotification";
import userService, { type FirmMembership } from "@/services/users.service";
import lawFirmService from "@/services/lawfirm.service";

/** What the owner has to do before this membership can be given up. */
const OWNER_BLOCKED_REASON =
  "You own this firm. Transfer ownership to another member, or delete the firm, before you can leave.";

/**
 * The firms the signed-in user belongs to, each with a way out. Membership is a
 * property of the person rather than of any one firm, so it belongs on the
 * account page next to the other things that follow the user everywhere - and
 * it stays reachable when the firm's own settings are not.
 *
 * The owner cannot leave: the firm would be left with nobody able to administer
 * it. Their button is disabled rather than hidden, so the reason is discoverable
 * instead of the option just being missing.
 */
export default function FirmMembershipSection() {
  const [memberships, setMemberships] = useState<FirmMembership[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [leaving, setLeaving] = useState<FirmMembership | null>(null);
  const [leavingId, setLeavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    userService
      .getMyMemberships()
      .then((rows) => { if (active) setMemberships(rows); })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Failed to load your firm memberships");
      })
      .finally(() => { if (active) setLoaded(true); });

    return () => { active = false; };
  }, []);

  const handleLeave = async () => {
    if (!leaving) return;
    const { lawFirmId, lawFirmName } = leaving;

    try {
      setLeavingId(lawFirmId);
      setError(null);
      setSuccess(null);
      await lawFirmService.leaveLawFirm(lawFirmId, {});
      setMemberships((rows) => rows.filter((r) => r.lawFirmId !== lawFirmId));
      setLeaving(null);
      setSuccess(`You have left ${lawFirmName || "the firm"}.`);
    } catch (e) {
      setLeaving(null);
      setError(e instanceof Error ? e.message : "Failed to leave the firm");
    } finally {
      setLeavingId(null);
    }
  };

  // A client portal user is a member of no firm, so there is nothing to show
  // them. Leaving the last firm keeps the card up while the confirmation reads,
  // rather than having the whole section vanish under the user's pointer.
  if (!loaded) return null;
  if (!memberships.length && !error && !success) return null;

  return (
    <div className="bg-surface rounded-2xl border border-outline-subtle p-5">
      <p className="text-sm font-medium text-on-surface">Firm Membership</p>
      <p className="text-xs text-on-surface-muted mt-1">
        The law firms you belong to. Leaving revokes your access to that firm&apos;s matters and files.
      </p>

      <div className="mt-3">
        <ErrorNotification error={error} onClose={() => setError(null)} compact />
      </div>

      <SuccessNotification message={success} className="mt-3" />

      {memberships.map((membership) => (
        <div
          key={membership.lawFirmId}
          className="mt-4 flex flex-col gap-4 md:flex-row md:items-center md:justify-between"
        >
          <div className="min-w-0">
            <div className="text-sm font-medium text-on-surface truncate">
              {membership.lawFirmName || "Unnamed Law Firm"}
            </div>
            <div className="mt-1.5">
              <RoleBadge roleName={membership.roleName} isOwner={membership.isOwner} />
            </div>
          </div>
          {/* A disabled button fires no pointer events, so the span is what the
              tooltip listens on. */}
          <Tooltip title={membership.isOwner ? OWNER_BLOCKED_REASON : ""} enterDelay={300} arrow>
            <span className="w-full md:w-auto shrink-0">
              <Button
                type="danger"
                size="small"
                className="w-full md:w-auto"
                disabled={membership.isOwner || leavingId !== null}
                loading={leavingId === membership.lawFirmId}
                onClick={() => {
                  setError(null);
                  setSuccess(null);
                  setLeaving(membership);
                }}
              >
                Leave Firm
              </Button>
            </span>
          </Tooltip>
        </div>
      ))}

      <ConfirmModal
        isOpen={!!leaving}
        onClose={() => setLeaving(null)}
        onConfirm={handleLeave}
        loading={leavingId !== null}
        title="Leave Firm"
        message={`You will lose access to ${leaving?.lawFirmName || "this firm"} and everything in it. An administrator has to invite you back to rejoin.`}
        confirmText="Leave Firm"
      />
    </div>
  );
}
