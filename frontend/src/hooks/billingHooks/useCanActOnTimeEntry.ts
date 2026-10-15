import { useCallback } from "react";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useAuth } from "@/hooks/useAuth";

/**
 * Whose time entries the viewer may edit, move, delete or log time for.
 *
 * `billing.manageTimeEntries` covers the viewer's own entries. An entry whose
 * timekeeper is someone else, or firm-level time with no timekeeper, also needs
 * `billing.manageOthersTimeEntries`; the API refuses it otherwise, so the row
 * action is not offered. Callers still gate on `billing.manageTimeEntries`
 * themselves.
 */
export default function useCanActOnTimeEntry() {
  const { hasPermission } = usePermissions();
  const { user } = useAuth();
  const canManageOthers = hasPermission("billing.manageOthersTimeEntries");
  const uid = user?.uid ?? null;

  const canActOnEntry = useCallback(
    (entry: { userId?: string | null }) => canManageOthers || (uid !== null && entry.userId === uid),
    [canManageOthers, uid],
  );

  return { canManageOthers, canActOnEntry, currentUserId: uid };
}
