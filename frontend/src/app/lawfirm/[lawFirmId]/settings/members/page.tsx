'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import lawfirmService from '@/services/lawfirm.service';
import clientsService from '@/services/clients.service';
import { SEARCH_DEBOUNCE_MS } from '@/lib/constants/search';
import Button from '@/components/ui/Button';
import Checkbox from '@/components/ui/Checkbox';
import ListPager from '@/components/ui/ListPager';
import TabBar from '@/components/ui/TabBar';
import ErrorNotification from '@/components/ErrorNotification';
import { validateRequiredFields, ValidationField } from '@/utils/formValidation';
import { useRoles } from '@/hooks/useRoles';
import { usePermissions } from '@/contexts/PermissionsContext';
import ConfirmModal from '@/components/ui/ConfirmModal';
import Modal from '@/components/ui/Modal';
import RoleSelector from '@/components/settingsComp/RoleSelector';
import Dropdown from '@/components/ui/Dropdown';
import type { Member } from '@/types/member';
import type { Role } from '@/types/role';
import UpgradePrompt, { parsePlanLimitError } from '@/components/subscriptionComp/UpgradePrompt';
import type { PlanLimitErrorDetails } from '@/types/subscription';
import StatusBadge from "@/components/ui/StatusBadge";
import { Avatar } from "@/components/ui/Avatar";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import PanelLoadingSpinner from '@/components/ui/PanelLoadingSpinner';
import DuplicateNameWarning from '@/components/ui/DuplicateNameWarning';
import { useDuplicateNameCheck } from '@/hooks/useEntityLookup';
import { describeRole } from '@/lib/constants/roleDescriptions';
import { resolveMemberRoleName } from '@/lib/utils/resolveMemberRoleName';
import { track } from "@/lib/analytics/analytics";
import ClientOrganizationAutocomplete from '@/components/clientComp/ClientOrganizationAutocomplete';

type NewClientForm = {
  name: string;
  email: string;
  phone: string;
  organization: string;
  address: string;
  preferredContactMethod: string;
  inviteToPortal: boolean;
};

const EMPTY_CLIENT_FORM: NewClientForm = {
  name: '',
  email: '',
  phone: '',
  organization: '',
  address: '',
  preferredContactMethod: 'none',
  inviteToPortal: false,
};

type ClientRow = {
  id: string;
  name: string;
  email: string;
  membershipStatus: 'active' | 'pending';
  userId?: string | null;
  invitationFailed?: boolean;
  invitationResendCount?: number;
  invitationSentAt?: string;
};

type MemberRow = Member & {
  id: string;
  displayName: string;
  displayRole: string;
};

type PendingMemberRow = {
  id: string;
  email: string;
  invitationFailed?: boolean;
  invitationResendCount?: number;
  invitationSentAt?: string;
};

const PAGE_SIZE = 10;

function PaginationFooter({
  page,
  pageCount,
  total,
  onPageChange,
  busy,
  serverPaged,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Set by the client list, whose pages come from the server one at a time. */
  busy?: boolean;
  serverPaged?: boolean;
}) {
  // The shared pager is 1-based; these lists page from 0.
  return (
    <div className="px-4 py-3 bg-surface-alt border-t border-outline">
      <ListPager
        page={page + 1}
        totalPages={pageCount}
        total={total}
        rowsPerPage={PAGE_SIZE}
        onPageChange={(next) => onPageChange(next - 1)}
        busy={busy}
        serverPaged={serverPaged}
      />
    </div>
  );
}

export default function MembersPage() {
  const params = useParams();
  const lawFirmId = Array.isArray(params?.lawFirmId)
    ? params.lawFirmId[0]
    : (params?.lawFirmId as string);

  const { roles, loading: rolesLoading, error: rolesError, refetch: refetchRoles } = useRoles(lawFirmId);
  const { hasPermission, isOwner } = usePermissions();
  const queryClient = useQueryClient();

  const canInviteMembers = hasPermission('members.invite');
  const canRemoveMembers = hasPermission('members.remove');
  const canChangeRole = hasPermission('members.changeRole');
  const canInviteClients = hasPermission('clients.invite');

  const [showInviteForm, setShowInviteForm] = useState(false);
  const [showAddClientForm, setShowAddClientForm] = useState(false);
  const [email, setEmail] = useState('');
  const [newClientForm, setNewClientForm] = useState<NewClientForm>(EMPTY_CLIENT_FORM);
  const { duplicate: duplicateClient } = useDuplicateNameCheck('clients', lawFirmId, newClientForm.name, {
    enabled: showAddClientForm,
  });
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [pendingMembers, setPendingMembers] = useState<PendingMemberRow[]>([]);
  const [pendingClients, setPendingClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviting, setInviting] = useState(false);
  const [addingClient, setAddingClient] = useState(false);
  const [updatingMemberId, setUpdatingMemberId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [resendingMemberId, setResendingMemberId] = useState<string | null>(null);
  const [revokingMemberId, setRevokingMemberId] = useState<string | null>(null);
  const [revokingClientInviteId, setRevokingClientInviteId] = useState<string | null>(null);
  const [removingClientId, setRemovingClientId] = useState<string | null>(null);
  const [invitingToPortalId, setInvitingToPortalId] = useState<string | null>(null);
  const [portalInvitedIds, setPortalInvitedIds] = useState<Set<string>>(new Set());
  const [recentlySentIds, setRecentlySentIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [addClientError, setAddClientError] = useState<string | null>(null);
  // Why the open confirm dialog's action failed. Shown inside the dialog, since
  // the page banner sits behind its backdrop; one at a time is ever open.
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [planLimitDetails, setPlanLimitDetails] = useState<PlanLimitErrorDetails | null>(null);
  const [memberPage, setMemberPage] = useState(0);
  const [clientPage, setClientPage] = useState(0);
  const [subTab, setSubTab] = useState<'team' | 'clients'>('team');
  const [memberSearch, setMemberSearch] = useState('');
  const [clientSearch, setClientSearch] = useState('');

  // Pending confirmation targets for destructive actions
  const [memberToRemove, setMemberToRemove] = useState<string | null>(null);
  const [clientToRemove, setClientToRemove] = useState<{ id: string; name: string } | null>(null);
  const [inviteToCancel, setInviteToCancel] = useState<
    { id: string; type: 'member' | 'client'; email: string } | null
  >(null);

  const roleMap = useMemo(() => {
    const map = new Map<string, Role>();
    roles.forEach((role) => map.set(role.id, role));
    return map;
  }, [roles]);

  // Non-owners cannot assign the Owner role
  const assignableRoles = useMemo(
    () => (isOwner ? roles : roles.filter((role) => role.name !== 'Owner')),
    [roles, isOwner],
  );

  // Shown under the invite form's role picker so whoever is inviting sees what
  // the selected role actually grants before sending, instead of guessing from
  // the name alone.
  const selectedRoleDescription = useMemo(() => {
    const role = assignableRoles.find((r) => r.id === selectedRoleId);
    return role ? describeRole(role) : null;
  }, [assignableRoles, selectedRoleId]);

  useEffect(() => {
    if (!selectedRoleId && roles.length > 0) {
      const preferred =
        roles.find((role) => role.name.toLowerCase() === 'staff') ||
        roles.find((role) => !role.isBuiltIn) ||
        roles[0];
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initializes the default invite role into user-editable selection state once roles load
      setSelectedRoleId(preferred.id);
    }
  }, [roles, selectedRoleId]);

  // Guards against a stale response landing after a newer one. This page keeps
  // members/pending-invite state in plain `useState` rather than React Query,
  // so nothing else stops a slow `load` call for the OLD firm from overwriting
  // state after the viewer has already switched to a different law firm
  // (browser back/forward can reuse this same page instance rather than
  // remounting it). Every call claims the next id; a call whose id no longer
  // matches the ref by the time it resolves lost the race and skips applying
  // its result.
  const loadRequestIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!lawFirmId) return;
    const requestId = ++loadRequestIdRef.current;
    const isCurrentRequest = () => loadRequestIdRef.current === requestId;

    setLoading(true);
    setError(null);
    try {
      const [membersRes, pendingRes, pendingMembersRes] = await Promise.all([
        lawfirmService.getLawFirmMembers(lawFirmId),
        clientsService.listPendingClientInvites(lawFirmId).catch(() => []),
        lawfirmService.listPendingMemberInvites(lawFirmId).catch(() => []),
      ]);
      if (!isCurrentRequest()) return;
      setMembers((membersRes || []) as Member[]);

      setPendingMembers((pendingMembersRes || []).map((invite) => ({
        id: invite.id,
        email: invite.email,
        invitationFailed: invite.invitationFailed,
        invitationResendCount: invite.invitationResendCount,
        invitationSentAt: invite.invitationSentAt,
      })));

      // Active clients are derived from the shared clients cache in the effect
      // below; here we only track the pending client invites.
      setPendingClients((pendingRes || []).map((invite) => ({
        id: invite.id,
        name: invite.email,
        email: invite.email,
        membershipStatus: 'pending' as const,
        invitationFailed: invite.invitationFailed,
        invitationResendCount: invite.invitationResendCount,
        invitationSentAt: invite.invitationSentAt,
      })));
    } catch (err: any) {
      if (isCurrentRequest()) setError(err?.message || 'Failed to load members');
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }, [lawFirmId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: members/pending-invite lists and loading/error state set as requests resolve
    load();
  }, [load]);

  // Active clients are read one PAGE at a time (see `activeClientsWindow` below),
  // so the rendered list is assembled per page rather than held whole.

  const onInviteMember = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!lawFirmId) return;
    if (!canInviteMembers) return;

    const validationFields: ValidationField[] = [
      { name: 'email', value: email, required: true, label: 'Email' },
      { name: 'role', value: selectedRoleId, required: true, label: 'Role' },
    ];

    const validationError = validateRequiredFields(validationFields);
    if (validationError) {
      setError(validationError);
      return;
    }

    const selectedRole = roles.find((role) => role.id === selectedRoleId);
    if (!selectedRole) {
      setError('Please select a valid role');
      return;
    }

    setInviting(true);
    setError(null);
    setSuccessMessage(null);
    try {
      await lawfirmService.inviteUserToLawFirm(
        email.trim(),
        lawFirmId,
        selectedRoleId,
      );
      track("member_invited", { built_in_role: Boolean(selectedRole.isBuiltIn) });
      setEmail('');
      setSuccessMessage(`Invitation sent to ${email.trim()} as ${selectedRole.name}.`);
      await load();
    } catch (err: any) {
      const limitDetails = parsePlanLimitError(err);
      if (limitDetails) {
        setPlanLimitDetails(limitDetails);
      } else {
        setError(err?.message || 'Failed to invite user');
      }
    } finally {
      setInviting(false);
    }
  };

  const onAddClient = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!lawFirmId || !canInviteClients) return;

    if (!newClientForm.name.trim()) {
      setAddClientError('Name is required.');
      return;
    }
    const hasEmail = !!newClientForm.email.trim();
    if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newClientForm.email.trim())) {
      setAddClientError('Enter a valid email address.');
      return;
    }

    setAddingClient(true);
    setAddClientError(null);
    setSuccessMessage(null);
    try {
      const result = await clientsService.createClient(lawFirmId, {
        name: newClientForm.name.trim(),
        email: hasEmail ? newClientForm.email.trim() : undefined,
        phone: newClientForm.phone.trim() || undefined,
        organization: newClientForm.organization.trim() || undefined,
        address: newClientForm.address.trim() || undefined,
        // "None" is a UI-only sentinel the backend enum lacks. It goes out as
        // null, a chosen "no preference"; an omitted field defaults to email.
        preferredContactMethod:
          newClientForm.preferredContactMethod && newClientForm.preferredContactMethod !== 'none'
            ? (newClientForm.preferredContactMethod as 'email' | 'phone' | 'sms' | 'portal')
            : null,
        portalInvitePending: newClientForm.inviteToPortal && hasEmail,
      });
      setNewClientForm(EMPTY_CLIENT_FORM);
      setShowAddClientForm(false);
      const portalNote = result.portalStatus === 'invited' ? ' Portal invite sent.' : result.portalStatus === 'added' ? ' Portal access granted.' : '';
      setSuccessMessage(`${newClientForm.name.trim()} added.${portalNote}`);
      queryClient.invalidateQueries({ queryKey: ['clients', lawFirmId] });
      await load();
    } catch (err: any) {
      setAddClientError(err?.message || 'Failed to add client');
    } finally {
      setAddingClient(false);
    }
  };

  const onRemoveMember = useCallback(
    (memberId: string) => {
      if (!lawFirmId || !canRemoveMembers) return;
      setConfirmError(null);
      setMemberToRemove(memberId);
    },
    [lawFirmId, canRemoveMembers],
  );

  const confirmRemoveMember = useCallback(async () => {
    if (!lawFirmId || !canRemoveMembers || !memberToRemove) return;
    const memberId = memberToRemove;

    setRemovingId(memberId);
    setConfirmError(null);
    setSuccessMessage(null);
    try {
      await lawfirmService.removeMemberFromLawFirm(lawFirmId, memberId);
      setSuccessMessage('Member removed successfully.');
      setMemberToRemove(null);
      await load();
    } catch (err: any) {
      setConfirmError(err?.message || 'Failed to remove member');
    } finally {
      setRemovingId(null);
    }
  }, [lawFirmId, canRemoveMembers, memberToRemove, load]);

  const onChangeMemberRole = useCallback(
    async (memberId: string, roleId: string) => {
      if (!lawFirmId || !canChangeRole) return;

      setUpdatingMemberId(memberId);
      setError(null);
      setSuccessMessage(null);
      try {
        const result = await lawfirmService.changeMemberRole(lawFirmId, memberId, roleId);
        setSuccessMessage(result.roleName ? `Updated role to ${result.roleName}.` : 'Role updated.');
        await load();
      } catch (err: any) {
        setError(err?.message || 'Failed to change member role');
      } finally {
        setUpdatingMemberId(null);
      }
    },
    [lawFirmId, canChangeRole, load],
  );

  const canManageClients = hasPermission('clients.manage');

  const onRemoveClient = useCallback(
    (clientId: string, clientName: string) => {
      if (!lawFirmId || !canManageClients) return;
      setConfirmError(null);
      setClientToRemove({ id: clientId, name: clientName });
    },
    [lawFirmId, canManageClients],
  );

  const confirmRemoveClient = useCallback(async () => {
    if (!lawFirmId || !canManageClients || !clientToRemove) return;
    const clientId = clientToRemove.id;

    setRemovingClientId(clientId);
    setConfirmError(null);
    setSuccessMessage(null);
    try {
      await clientsService.deleteClient(lawFirmId, clientId);
      setSuccessMessage('Client removed successfully.');
      setClientToRemove(null);
      queryClient.invalidateQueries({ queryKey: ['clients', lawFirmId] });
      await load();
    } catch (err: any) {
      setConfirmError(err?.message || 'Failed to remove client');
    } finally {
      setRemovingClientId(null);
    }
  }, [lawFirmId, canManageClients, clientToRemove, load, queryClient]);

  const onResendInvite = useCallback(
    async (clientId: string) => {
      if (!lawFirmId || !canInviteClients) return;
      setResendingId(clientId);
      setError(null);
      setSuccessMessage(null);
      try {
        const result = await clientsService.resendClientInvitation(lawFirmId, clientId);
        if (result.sent) {
          setSuccessMessage('Invitation email resent successfully.');
          setRecentlySentIds((prev) => new Set(prev).add(clientId));
          // Clear the cooldown indicator after 60s
          setTimeout(() => {
            setRecentlySentIds((prev) => {
              const next = new Set(prev);
              next.delete(clientId);
              return next;
            });
          }, 60000);
        } else {
          setError(result.message || 'Email could not be sent.');
        }
        await load();
      } catch (err: any) {
        setError(err?.message || 'Failed to resend invitation');
      } finally {
        setResendingId(null);
      }
    },
    [lawFirmId, canInviteClients, load],
  );

  const onResendMemberInvite = useCallback(
    async (inviteId: string) => {
      if (!lawFirmId || !canInviteMembers) return;
      setResendingMemberId(inviteId);
      setError(null);
      setSuccessMessage(null);
      try {
        const result = await lawfirmService.resendMemberInvitation(lawFirmId, inviteId);
        if (result.sent) {
          setSuccessMessage('Member invitation email resent successfully.');
        } else {
          setError(result.message || 'Email could not be sent.');
        }
        await load();
      } catch (err: any) {
        setError(err?.message || 'Failed to resend invitation');
      } finally {
        setResendingMemberId(null);
      }
    },
    [lawFirmId, canInviteMembers, load],
  );

  const onRevokeMemberInvite = useCallback(
    (inviteId: string, inviteEmail: string) => {
      if (!lawFirmId || !canInviteMembers) return;
      setConfirmError(null);
      setInviteToCancel({ id: inviteId, type: 'member', email: inviteEmail });
    },
    [lawFirmId, canInviteMembers],
  );

  const onRevokeClientInvite = useCallback(
    (inviteId: string, inviteEmail: string) => {
      if (!lawFirmId || !canInviteClients) return;
      setConfirmError(null);
      setInviteToCancel({ id: inviteId, type: 'client', email: inviteEmail });
    },
    [lawFirmId, canInviteClients],
  );

  const onInviteToPortal = useCallback(
    async (clientId: string, clientEmail: string) => {
      if (!lawFirmId || !canInviteClients || !clientEmail) return;
      setInvitingToPortalId(clientId);
      setError(null);
      try {
        await clientsService.inviteClientToLawFirm(clientEmail, lawFirmId);
        setPortalInvitedIds((prev) => new Set([...prev, clientId]));
        queryClient.invalidateQueries({ queryKey: ['clients', lawFirmId] });
        await load();
      } catch (err: any) {
        setError(err?.message || 'Failed to send portal invitation');
      } finally {
        setInvitingToPortalId(null);
      }
    },
    [lawFirmId, canInviteClients, load, queryClient],
  );

  const confirmCancelInvite = useCallback(async () => {
    if (!lawFirmId || !inviteToCancel) return;
    const { id: inviteId, type } = inviteToCancel;
    if (type === 'member' && !canInviteMembers) return;
    if (type === 'client' && !canInviteClients) return;

    if (type === 'member') {
      setRevokingMemberId(inviteId);
    } else {
      setRevokingClientInviteId(inviteId);
    }
    setConfirmError(null);
    setSuccessMessage(null);
    try {
      if (type === 'member') {
        await lawfirmService.revokeMemberInvitation(lawFirmId, inviteId);
      } else {
        await clientsService.revokeClientInvitation(lawFirmId, inviteId);
      }
      setSuccessMessage('Invitation cancelled.');
      setInviteToCancel(null);
      await load();
    } catch (err: any) {
      setConfirmError(err?.message || 'Failed to cancel invitation');
    } finally {
      setRevokingMemberId(null);
      setRevokingClientInviteId(null);
    }
  }, [lawFirmId, inviteToCancel, canInviteMembers, canInviteClients, load]);

  const memberRows = useMemo<MemberRow[]>(
    () =>
      members.map((member) => {
        const rowId = member.userId || member.id || '';
        return {
          ...member,
          id: rowId,
          displayName: member.name || member.email || 'Unknown',
          displayRole: resolveMemberRoleName(member, roleMap),
        };
      }),
    [members, roleMap],
  );

  // Pending invites and active members share one paginated list (pending first).
  const memberItems = useMemo(() => {
    const items = [
      ...pendingMembers.map((invite) => ({ kind: 'pending' as const, invite })),
      ...memberRows.map((row) => ({ kind: 'active' as const, row })),
    ];
    const q = memberSearch.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) =>
      item.kind === 'pending'
        ? item.invite.email.toLowerCase().includes(q)
        : `${item.row.displayName} ${item.row.email || ''}`.toLowerCase().includes(q),
    );
  }, [pendingMembers, memberRows, memberSearch]);

  const memberPageCount = Math.max(1, Math.ceil(memberItems.length / PAGE_SIZE));
  const safeMemberPage = Math.min(memberPage, memberPageCount - 1);
  const pagedMemberItems = memberItems.slice(
    safeMemberPage * PAGE_SIZE,
    safeMemberPage * PAGE_SIZE + PAGE_SIZE,
  );

  // The rendered list is "pending invites first, then active clients", and the
  // two halves come from different places. Pending invites are a small, already
  // loaded set filtered here; active clients are a SERVER page. This page used to
  // download the firm's entire client table to fill a ten-row pager.
  //
  // The pager still walks one continuous list, so each page is cut out of the
  // concatenation: the pending rows that fall in the page window, then however
  // many active rows are needed to fill it, requested at the matching offset.
  const filteredPendingClients = useMemo(() => {
    const q = clientSearch.trim().toLowerCase();
    if (!q) return pendingClients;
    return pendingClients.filter((client) =>
      `${client.name || ''} ${client.email || ''}`.toLowerCase().includes(q),
    );
  }, [pendingClients, clientSearch]);

  // Only the debounced term reaches the network; the input stays responsive.
  const [debouncedClientSearch, setDebouncedClientSearch] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebouncedClientSearch(clientSearch.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [clientSearch]);

  const pendingClientCount = filteredPendingClients.length;
  const clientWindowStart = clientPage * PAGE_SIZE;
  const pendingSlice = filteredPendingClients.slice(clientWindowStart, clientWindowStart + PAGE_SIZE);
  // Active rows pick up where the pending ones stop, so the offset is how far
  // past the pending block this page reaches.
  const activeOffset = Math.max(0, clientWindowStart - pendingClientCount);
  const activeLimit = PAGE_SIZE - pendingSlice.length;

  const {
    data: activeClientsWindow,
    isLoading: activeClientsLoading,
    isFetching: activeClientsFetching,
  } = useQuery({
    queryKey: ['clients', lawFirmId, 'paged', {
      offset: activeOffset,
      limit: activeLimit,
      search: debouncedClientSearch,
    }],
    // `limit` can be 0 on a page filled entirely by pending invites, which is not
    // a meaningful request - ask for one row and drop it, so `totalItems` (which
    // the pager needs on every page) still comes back.
    queryFn: () => clientsService.listClientsPaged(lawFirmId!, {
      offset: activeOffset,
      limit: Math.max(1, activeLimit),
      search: debouncedClientSearch || undefined,
      // Explicit, stable ordering. Paging over an unordered read is what silently
      // repeats a row on one page and skips it on the next.
      sortBy: 'name',
      order: 'asc',
    }),
    enabled: !!lawFirmId,
    // Guarded on the firm the placeholder came from: `lawFirmId` sits at
    // index 1 of both this key and the previous query's key. An unconditional
    // `(prev) => prev` (TanStack's `keepPreviousData`, spelled out) would hand
    // the instant a viewer switches firms the OLD firm's client page, rendered
    // under the new firm's tab while the real request is still in flight -
    // the same cross-tenant UI leak already fixed on the calendar, matters,
    // tasks, and clients hooks this session.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined),
  });

  // The firm's client count, independent of the search and the current page, so
  // the tab and section-header badges keep reporting the firm rather than
  // shrinking to whatever is being searched for. One row is fetched purely to
  // carry `totalItems`.
  const { data: clientTotalProbe } = useQuery({
    queryKey: ['clients', lawFirmId, 'paged', 'total'],
    queryFn: () => clientsService.listClientsPaged(lawFirmId!, { offset: 0, limit: 1 }),
    enabled: !!lawFirmId,
    // Same firm-key guard as `activeClientsWindow` above - this total drives
    // the "Clients" tab badge, so an unguarded placeholder would report the
    // PREVIOUS firm's client count under the new firm's tab.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined),
  });
  const unfilteredClientTotal = clientTotalProbe?.totalItems ?? 0;

  const activeClientTotal = activeClientsWindow?.totalItems ?? 0;
  const pagedClients: ClientRow[] = useMemo(() => [
    ...pendingSlice,
    ...(activeClientsWindow?.clients ?? []).slice(0, activeLimit).map((client) => ({
      id: client.id,
      name: client.name || 'Unnamed Client',
      email: client.email || '',
      membershipStatus: 'active' as const,
      userId: (client as any).userId || null,
    })),
  ], [pendingSlice, activeClientsWindow, activeLimit]);

  const filteredClientCount = pendingClientCount + activeClientTotal;
  const clientPageCount = Math.max(1, Math.ceil(filteredClientCount / PAGE_SIZE));
  const safeClientPage = Math.min(clientPage, clientPageCount - 1);

  // The page window is cut from `clientPage`, so a page past the end of a newly
  // narrowed result set would render empty instead of snapping back. `totalItems`
  // is independent of the offset, so the clamp always has a real count to work
  // from. Adjusting state during render (not in an effect) lets React restart
  // with the corrected page before committing, as `recoverOutOfRangePage` does
  // for the shared server tables.
  if (!activeClientsLoading && clientPage > clientPageCount - 1) {
    setClientPage(clientPageCount - 1);
  }

  const closeAddClientForm = useCallback(() => setShowAddClientForm(false), []);

  useResetAfterClose(showAddClientForm, () => setNewClientForm(EMPTY_CLIENT_FORM));

  if (!lawFirmId) return null;

  const totalMemberCount = memberRows.length + pendingMembers.length;
  const totalClientCount = pendingClients.length + unfilteredClientTotal;

  return (
    <div className="p-4 pl-5 md:p-6 pb-8 md:pb-6 min-w-0 space-y-6">

      <ErrorNotification
        error={error || rolesError}
        onRetry={() => { void load(); void refetchRoles(); }}
        onClose={() => setError(null)}
      />

      {successMessage && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
          <p className="text-sm text-emerald-600 dark:text-emerald-400">{successMessage}</p>
        </div>
      )}

      {/* Sub-tabs */}
      <TabBar
        tabs={[
          { value: 'team', label: 'Team Members', count: totalMemberCount },
          { value: 'clients', label: 'Clients', count: totalClientCount },
        ]}
        value={subTab}
        onChange={setSubTab}
        density="compact"
      />

      {/* ── Team Members ── */}
      {subTab === 'team' && (
      <>
      <div className="relative">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-muted pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
        </svg>
        <input
          type="text"
          value={memberSearch}
          onChange={(e) => { setMemberSearch(e.target.value); setMemberPage(0); }}
          placeholder="Search team members by name or email"
          className="w-full rounded-lg border border-input-border bg-input-bg pl-9 pr-3 py-2 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        />
      </div>
      <section className="rounded-xl border border-outline overflow-hidden">
        {/* Section header */}
        <div className="flex items-center justify-between px-4 py-3 bg-surface-alt border-b border-outline">
          <div className="flex items-center gap-2.5">
            <span className="text-sm font-semibold text-on-surface">Team Members</span>
            {totalMemberCount > 0 && (
              <span className="text-xs font-medium text-on-surface-muted bg-surface border border-outline-subtle rounded-full px-2 py-0.5 tabular-nums">
                {totalMemberCount}
              </span>
            )}
          </div>
          {canInviteMembers && (
            <button
              onClick={() => setShowInviteForm(v => !v)}
              className="flex items-center gap-1.5 text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover transition-colors cursor-pointer"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={showInviteForm ? "M5 12h14" : "M12 4v16m8-8H4"} />
              </svg>
              {showInviteForm ? 'Cancel' : 'Invite Member'}
            </button>
          )}
        </div>

        {/* Inline invite form */}
        {showInviteForm && (
          <div className="px-4 py-4 bg-surface border-b border-outline">
            <form onSubmit={onInviteMember} className="flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="flex-1 min-w-0">
                <label className="block text-xs font-medium text-on-surface-muted mb-1">Email *</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="team@example.com"
                  autoFocus
                  className="w-full rounded-lg border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
              </div>
              <div className="w-full sm:w-[160px] shrink-0">
                <label className="block text-xs font-medium text-on-surface-muted mb-1">Role *</label>
                <RoleSelector
                  roles={assignableRoles}
                  value={selectedRoleId}
                  onChange={setSelectedRoleId}
                  disabled={rolesLoading}
                />
              </div>
              <Button
                type="primary"
                htmlType="submit"
                disabled={inviting || !email.trim() || !selectedRoleId}
                loading={inviting}
                className="shrink-0"
              >
                Send Invite
              </Button>
            </form>
            {selectedRoleDescription && (
              <p className="mt-2 text-xs text-on-surface-muted">{selectedRoleDescription}</p>
            )}
          </div>
        )}

        {/* Pending invitations + active members in one list */}
        {loading ? (
          <PanelLoadingSpinner label="Loading members" />
        ) : totalMemberCount === 0 ? (
          <div className="px-4 py-6 text-sm text-on-surface-muted">No members yet.</div>
        ) : memberItems.length === 0 ? (
          <div className="px-4 py-6 text-sm text-on-surface-muted">No members match your search.</div>
        ) : (
          <>
          <ul className="divide-y divide-outline-subtle bg-surface">
            {pagedMemberItems.map((item) => {
              if (item.kind === 'pending') {
              const invite = item.invite;
              const isFailed = invite.invitationFailed === true;
              const isResending = resendingMemberId === invite.id;
              const isRevoking = revokingMemberId === invite.id;
              const maxResends = (invite.invitationResendCount || 0) >= 10;
              return (
                <li key={invite.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-8 h-8 rounded-full bg-surface-alt border border-outline-subtle flex items-center justify-center shrink-0">
                    <svg className="w-4 h-4 text-on-surface-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-on-surface truncate">{invite.email}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <StatusBadge variant="warning">Awaiting signup</StatusBadge>
                      {isFailed && <StatusBadge variant="danger">Email Failed</StatusBadge>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {canInviteMembers && !maxResends && (
                      <Button type="secondary" size="small" disabled={isResending || isRevoking} loading={isResending} onClick={() => onResendMemberInvite(invite.id)}>
                        Resend
                      </Button>
                    )}
                    {maxResends && <span className="text-xs text-on-surface-muted">Max resends</span>}
                    {canInviteMembers && (
                      <Button type="danger" size="small" disabled={isResending || isRevoking} loading={isRevoking} onClick={() => onRevokeMemberInvite(invite.id, invite.email)}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </li>
              );
              }

              const row = item.row;
              const isBusy = updatingMemberId === row.id || removingId === row.id;
              return (
                <li key={row.id} className="flex items-center gap-3 px-4 py-3">
                  <Avatar size="sm" photoUrl={row.photoUrl} name={row.displayName} email={row.email} />

                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-on-surface truncate">{row.displayName}</div>
                    <div className="text-xs text-on-surface-muted truncate">{row.email || 'No email'}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {canChangeRole && !row.isOwner && (
                      <div className="w-[140px]">
                        <Dropdown
                          value={row.roleId || ''}
                          onChange={(value) => onChangeMemberRole(row.id, value)}
                          disabled={isBusy || rolesLoading}
                          options={assignableRoles.map((role) => ({ label: role.name, value: role.id }))}
                          ariaLabel="Change member role"
                          portal
                        />
                      </div>
                    )}
                    {canRemoveMembers && (
                      <Button type="danger" size="small" disabled={row.isOwner || isBusy} loading={removingId === row.id} onClick={() => onRemoveMember(row.id)}>
                        Remove
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {memberPageCount > 1 && (
            <PaginationFooter
              page={safeMemberPage}
              pageCount={memberPageCount}
              total={memberItems.length}
              onPageChange={setMemberPage}
            />
          )}
          </>
        )}
      </section>
      </>
      )}

      {/* ── Associated Clients ── */}
      {subTab === 'clients' && (
      <>
      <div className="relative">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-muted pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
        </svg>
        <input
          type="text"
          value={clientSearch}
          onChange={(e) => { setClientSearch(e.target.value); setClientPage(0); }}
          placeholder="Search clients by name or email"
          className="w-full rounded-lg border border-input-border bg-input-bg pl-9 pr-3 py-2 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        />
      </div>
      <section className="rounded-xl border border-outline overflow-hidden">
        {/* Section header */}
        <div className="flex items-center justify-between px-4 py-3 bg-surface-alt border-b border-outline">
          <div className="flex items-center gap-2.5">
            <span className="text-sm font-semibold text-on-surface">Clients</span>
            {totalClientCount > 0 && (
              <span className="text-xs font-medium text-on-surface-muted bg-surface border border-outline-subtle rounded-full px-2 py-0.5 tabular-nums">
                {totalClientCount}
              </span>
            )}
          </div>
          {/* Adding a client POSTs /clients (clients.manage); the portal invite
              it can send is clients.invite. */}
          {canInviteClients && canManageClients && (
            <button
              onClick={() => {
                setAddClientError(null);
                setShowAddClientForm(true);
              }}
              className="flex items-center gap-1.5 text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover transition-colors cursor-pointer"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Client
            </button>
          )}
        </div>

        {loading || activeClientsLoading ? (
          <PanelLoadingSpinner label="Loading clients" />
        ) : totalClientCount === 0 ? (
          <div className="px-4 py-6 text-sm text-on-surface-muted">No clients associated yet.</div>
        ) : filteredClientCount === 0 ? (
          <div className="px-4 py-6 text-sm text-on-surface-muted">No clients match your search.</div>
        ) : (
          <>
          <ul className="divide-y divide-outline-subtle bg-surface">
            {pagedClients.map((client) => {
              const isPending = client.membershipStatus === 'pending';
              const isFailed = client.invitationFailed === true;
              const hasPortal = !isPending && !!client.userId;
              const isResending = resendingId === client.id;
              const recentlySent = recentlySentIds.has(client.id);
              const maxResends = (client.invitationResendCount || 0) >= 10;
              const canResend = canInviteClients && (isPending || isFailed) && !recentlySent && !maxResends;
              const justInvitedToPortal = portalInvitedIds.has(client.id);
              return (
                <li key={client.id} className="flex items-center gap-3 px-4 py-3">
                  {isPending ? (
                    <div className="w-8 h-8 rounded-full bg-surface-alt border border-outline-subtle flex items-center justify-center shrink-0">
                      <svg className="w-4 h-4 text-on-surface-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                      </svg>
                    </div>
                  ) : (
                    <Avatar size="sm" photoUrl={(client as any).photoUrl} name={client.name} email={client.email} />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-on-surface truncate">{client.name || client.email || 'Unknown'}</div>
                    <div className="text-xs text-on-surface-muted truncate">{client.email || 'No email'}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {isPending || justInvitedToPortal ? (
                        <StatusBadge variant="warning">Invite sent</StatusBadge>
                      ) : hasPortal ? (
                        <StatusBadge variant="success">Portal access</StatusBadge>
                      ) : (
                        <StatusBadge variant="neutral">No portal</StatusBadge>
                      )}
                      {isFailed && <StatusBadge variant="danger">Email failed</StatusBadge>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {recentlySent && <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">Sent</span>}
                    {canResend && (
                      <Button type="secondary" size="small" disabled={isResending} loading={isResending} onClick={() => onResendInvite(client.id)}>
                        Resend
                      </Button>
                    )}
                    {maxResends && <span className="text-xs text-on-surface-muted">Max resends</span>}
                    {canInviteClients && !isPending && !hasPortal && !justInvitedToPortal && client.email && (
                      <Button
                        type="secondary"
                        size="small"
                        disabled={invitingToPortalId === client.id}
                        loading={invitingToPortalId === client.id}
                        onClick={() => onInviteToPortal(client.id, client.email)}
                      >
                        Invite to portal
                      </Button>
                    )}
                    {canInviteClients && isPending && (
                      <Button type="danger" size="small" disabled={isResending || revokingClientInviteId === client.id} loading={revokingClientInviteId === client.id} onClick={() => onRevokeClientInvite(client.id, client.email || client.name)}>
                        Cancel
                      </Button>
                    )}
                    {canManageClients && !isPending && (
                      <Button type="danger" size="small" disabled={removingClientId === client.id} loading={removingClientId === client.id} onClick={() => onRemoveClient(client.id, client.name || client.email)}>
                        Remove
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {clientPageCount > 1 && (
            <PaginationFooter
              page={safeClientPage}
              pageCount={clientPageCount}
              total={filteredClientCount}
              onPageChange={setClientPage}
              busy={activeClientsFetching}
              serverPaged
            />
          )}
          </>
        )}
      </section>
      </>
      )}

      <ConfirmModal
        isOpen={!!memberToRemove}
        onClose={() => setMemberToRemove(null)}
        onConfirm={confirmRemoveMember}
        title="Remove member"
        message="Remove this member? They will lose access to all matters and tasks. Their assignments will be unassigned."
        confirmText="Remove"
        confirmType="danger"
        loading={!!memberToRemove && removingId === memberToRemove}
        error={confirmError}
      />

      <ConfirmModal
        isOpen={!!clientToRemove}
        onClose={() => setClientToRemove(null)}
        onConfirm={confirmRemoveClient}
        title="Remove client"
        message={`Remove ${clientToRemove?.name ?? 'this client'} from your law firm? This will also remove them from all matters.`}
        confirmText="Remove"
        confirmType="danger"
        loading={!!clientToRemove && removingClientId === clientToRemove.id}
        error={confirmError}
      />

      <ConfirmModal
        isOpen={!!inviteToCancel}
        onClose={() => setInviteToCancel(null)}
        onConfirm={confirmCancelInvite}
        title="Cancel invitation"
        message={`Cancel the pending invitation for ${inviteToCancel?.email ?? 'this email'}? The invite link will stop working.`}
        confirmText="Cancel invitation"
        cancelText="Keep invitation"
        confirmType="danger"
        loading={
          !!inviteToCancel &&
          (inviteToCancel.type === 'member'
            ? revokingMemberId === inviteToCancel.id
            : revokingClientInviteId === inviteToCancel.id)
        }
        error={confirmError}
      />
      {/* Add Client modal */}
      <Modal
        isOpen={showAddClientForm}
        onClose={closeAddClientForm}
        dismissible={!addingClient}
        title="Add Client"
        closeIcon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>}
        size="lg"
        className="relative rounded-xl"
        bodyClassName={null}
      >
              <form onSubmit={onAddClient} className="px-5 py-5 space-y-4 overflow-y-auto styled-scrollbar max-h-[75vh]">
                <ErrorNotification error={addClientError} onClose={() => setAddClientError(null)} />

                <div>
                  <label className="block text-sm font-medium text-on-surface mb-1.5">Name *</label>
                  <input
                    type="text"
                    value={newClientForm.name}
                    onChange={(e) => setNewClientForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="Full name"
                    autoFocus
                    className="w-full rounded-lg border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                  <DuplicateNameWarning duplicateName={duplicateClient?.label} entityLabel="client" />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-on-surface mb-1.5">Email</label>
                    <input
                      type="email"
                      value={newClientForm.email}
                      onChange={(e) => setNewClientForm(f => ({ ...f, email: e.target.value }))}
                      placeholder="email@example.com"
                      className="w-full rounded-lg border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-on-surface mb-1.5">Phone</label>
                    <input
                      type="tel"
                      value={newClientForm.phone}
                      onChange={(e) => setNewClientForm(f => ({ ...f, phone: e.target.value }))}
                      placeholder="(555) 123-4567"
                      className="w-full rounded-lg border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-on-surface mb-1.5">Organization</label>
                  <ClientOrganizationAutocomplete
                    lawFirmId={lawFirmId}
                    value={newClientForm.organization}
                    onChange={(organization) => setNewClientForm(f => ({ ...f, organization }))}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-on-surface mb-1.5">Address</label>
                  <input
                    type="text"
                    value={newClientForm.address}
                    onChange={(e) => setNewClientForm(f => ({ ...f, address: e.target.value }))}
                    placeholder="Street, City, State ZIP"
                    className="w-full rounded-lg border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-on-surface mb-1.5">Preferred Contact</label>
                  <Dropdown
                    value={newClientForm.preferredContactMethod}
                    onChange={(v) => setNewClientForm(f => ({ ...f, preferredContactMethod: v }))}
                    options={[
                      { label: "None", value: "none" },
                      { label: "Email", value: "email" },
                      { label: "Phone", value: "phone" },
                      { label: "SMS", value: "sms" },
                    ]}
                    portal
                  />
                </div>

                {newClientForm.email.trim() && (
                  <Checkbox
                    checked={newClientForm.inviteToPortal}
                    onChange={(checked) => setNewClientForm(f => ({ ...f, inviteToPortal: checked }))}
                    label="Invite to client portal"
                  />
                )}

                <div className="flex items-center justify-end gap-2 pt-1 border-t border-outline-subtle">
                  <Button type="secondary" onClick={closeAddClientForm} disabled={addingClient}>Cancel</Button>
                  <Button type="primary" htmlType="submit" disabled={addingClient || !newClientForm.name.trim()} loading={addingClient}>
                    Add Client
                  </Button>
                </div>
              </form>
      </Modal>

      <UpgradePrompt
        open={!!planLimitDetails}
        onClose={() => setPlanLimitDetails(null)}
        details={planLimitDetails}
        lawFirmId={lawFirmId}
      />
    </div>
  );
}
