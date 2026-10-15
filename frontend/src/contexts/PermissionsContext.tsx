"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ALL_PERMISSIONS, resolveMemberPermissions } from "@/lib/constants/permissions";
import type { Member } from "@/types/member";
import lawfirmService from "@/services/lawfirm.service";
import { ApiError } from "@/lib/utils/apiErrors";

type PermissionValue = string;

type PermissionsContextValue = {
  loading: boolean;
  /**
   * True when the member/permission load actually FAILED (e.g. a network error),
   * as opposed to the user genuinely lacking a permission. Consumers use this to
   * show a "couldn't load, try again" state instead of a misleading "access
   * denied" screen on a transient failure.
   */
  loadError: boolean;
  lawFirmId?: string;
  member: Member | null;
  isOwner: boolean;
  permissions: PermissionValue[];
  hasPermission: (permission: PermissionValue) => boolean;
  hasAnyPermission: (permissions: PermissionValue[]) => boolean;
  hasAllPermissions: (permissions: PermissionValue[]) => boolean;
  refresh: () => Promise<void>;
};

const defaultValue: PermissionsContextValue = {
  loading: true,
  loadError: false,
  lawFirmId: undefined,
  member: null,
  isOwner: false,
  permissions: [],
  hasPermission: () => false,
  hasAnyPermission: () => false,
  hasAllPermissions: () => false,
  refresh: async () => {},
};

const PermissionsContext = createContext<PermissionsContextValue>(defaultValue);

/**
 * The member row out of whatever `GET /members/me` answered with.
 *
 * The route returns `{ member }`; the bare row is accepted too so the context
 * does not break if the envelope is ever unwrapped at the service.
 */
function normalizeMember(raw: unknown): Member | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = "member" in (raw as any) ? (raw as any).member : raw;
  if (!candidate || typeof candidate !== "object") return null;
  return candidate as Member;
}

/**
 * A 403 from the membership endpoint is an ANSWER, not a failure: this person is
 * not a member of this firm, so they hold nothing here. Flagging it as a load
 * error would put every gated page into a "couldn't load, try again" state for
 * someone whose access is simply absent, with no retry that could ever succeed.
 * Every other status, 401 included, stays a failure: an expired token is
 * transient and a refresh fixes it.
 */
function isNotAMember(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function normalizePermissionList(member: Member | null): PermissionValue[] {
  if (!member) return [];
  const explicit = [
    ...(Array.isArray(member.resolvedPermissions) ? member.resolvedPermissions : []),
    ...(Array.isArray(member.permissions) ? member.permissions : []),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  const inferred = resolveMemberPermissions(member);
  const all = member.isOwner ? ALL_PERMISSIONS : [...explicit, ...inferred];
  return Array.from(new Set(all));
}

export function PermissionsProvider({
  lawFirmId,
  userId,
  children,
}: {
  lawFirmId: string;
  userId?: string;
  children: React.ReactNode;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [member, setMember] = useState<Member | null>(null);
  const [permissions, setPermissions] = useState<PermissionValue[]>([]);
  // A workspace can change before its member lookup returns. Only the newest
  // lookup may update this long-lived provider; otherwise a response for firm A
  // can replace firm B's permissions after the user has already switched.
  const loadGeneration = useRef(0);
  const currentUserId = userId || "";

  const loadPermissions = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const isCurrentLoad = () => generation === loadGeneration.current;

    if (!lawFirmId || !currentUserId) {
      if (!isCurrentLoad()) return;
      setMember(null);
      setPermissions([]);
      setLoadError(false);
      setLoading(false);
      return;
    }

    setLoading(true);
    setLoadError(false);
    try {
      // One request, for one row. This used to read the whole firm roster and
      // find the viewer in it, so every workspace mount cost an identity lookup
      // and a signed avatar per member of the firm.
      const raw = await lawfirmService.getMyMembership(lawFirmId);
      if (!isCurrentLoad()) return;
      const currentMember = normalizeMember(raw);

      setMember(currentMember);
      setPermissions(normalizePermissionList(currentMember));
    } catch (error) {
      if (!isCurrentLoad()) return;
      if (isNotAMember(error)) {
        setMember(null);
        setPermissions([]);
        return;
      }
      // A load failure is NOT the same as "no permission": flag it so gated pages
      // can show a retry state rather than a wrong "access denied" screen.
      console.error("Failed to load member permissions:", error);
      setMember(null);
      setPermissions([]);
      setLoadError(true);
    } finally {
      if (isCurrentLoad()) setLoading(false);
    }
  }, [lawFirmId, currentUserId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadPermissions is an async data fetch that updates state on completion
    loadPermissions();
  }, [loadPermissions]);

  const permissionSet = useMemo(() => new Set(permissions), [permissions]);
  const isOwner = !!member?.isOwner;

  const hasPermission = useCallback(
    (permission: PermissionValue) => {
      if (!permission) return false;
      if (isOwner) return true;
      return permissionSet.has(permission);
    },
    [isOwner, permissionSet],
  );

  const hasAnyPermission = useCallback(
    (required: PermissionValue[]) => {
      if (!required?.length) return false;
      return required.some((permission) => hasPermission(permission));
    },
    [hasPermission],
  );

  const hasAllPermissions = useCallback(
    (required: PermissionValue[]) => {
      if (!required?.length) return false;
      return required.every((permission) => hasPermission(permission));
    },
    [hasPermission],
  );

  const value = useMemo<PermissionsContextValue>(
    () => ({
      loading,
      loadError,
      lawFirmId,
      member,
      isOwner,
      permissions,
      hasPermission,
      hasAnyPermission,
      hasAllPermissions,
      refresh: loadPermissions,
    }),
    [
      loading,
      loadError,
      lawFirmId,
      member,
      isOwner,
      permissions,
      hasPermission,
      hasAnyPermission,
      hasAllPermissions,
      loadPermissions,
    ],
  );

  return (
    <PermissionsContext value={value}>
      {children}
    </PermissionsContext>
  );
}

export function usePermissions() {
  return useContext(PermissionsContext);
}
