'use client';

import { useCallback, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Tooltip from "@/components/ui/Tooltip";
import SuccessNotification from "@/components/SuccessNotification";
import { Pencil, Trash2, ShieldCheck, Search } from 'lucide-react';
import Button from '@/components/ui/Button';
import ListView, { ListRow } from '@/components/ui/ListView';
import StatusBadge from '@/components/ui/StatusBadge';
import ConfirmModal from '@/components/ui/ConfirmModal';
import ErrorNotification from '@/components/ErrorNotification';
import RoleEditor from '@/components/settingsComp/RoleEditor';
import { withImpliedViewPermissions } from '@/lib/constants/permissions';
import RoleBadge from '@/components/ui/RoleBadge';
import useRoles from '@/hooks/useRoles';
import { usePermissions } from '@/contexts/PermissionsContext';
import type { Role } from '@/types/role';
import { useResetAfterClose } from '@/hooks/useMountTransition';
import { resolveMemberRoleName } from '@/lib/utils/resolveMemberRoleName';
import FieldLabel from '@/components/ui/FieldLabel';
import SectionLabel from '@/components/ui/SectionLabel';

type RoleRow = Role & {
  permissionCount: number;
  roleType: string;
};

export default function RolesSettingsPage() {
  const params = useParams();
  const lawFirmId = Array.isArray(params?.lawFirmId)
    ? params.lawFirmId[0]
    : (params?.lawFirmId as string);

  const { roles, loading, error, createRole, updateRole, deleteRole, refetch } = useRoles(lawFirmId);
  const { hasPermission, member, isOwner } = usePermissions();
  const canManageRoles = hasPermission('firm.manageRoles');
  // The Owner role carries every permission, and the server refuses a role
  // save that grants more than the caller holds, so only the owner can save it.
  // The owner resolves to every permission whatever the role says.
  const canEditRole = (role: Role) => canManageRoles && (role.name !== 'Owner' || isOwner);
  const editTooltip = (role: Role) => {
    if (!canManageRoles) return 'You cannot manage roles';
    if (!canEditRole(role)) return 'Only the firm owner can edit the Owner role';
    return 'Edit';
  };

  const currentRoleName = useMemo(() => {
    if (!member) return null;
    const roleMap = new Map(roles.map((role) => [role.id, role]));
    return resolveMemberRoleName(member, roleMap);
  }, [member, roles]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formPermissions, setFormPermissions] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [roleToDelete, setRoleToDelete] = useState<Role | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState('');

  const rows = useMemo<RoleRow[]>(
    () =>
      roles
        .map((role) => ({
          ...role,
          permissionCount: Array.isArray(role.permissions) ? role.permissions.length : 0,
          roleType: role.isBuiltIn ? 'Built-in' : 'Custom',
        }))
        // Most-privileged roles first; fall back to name for equal counts.
        .sort(
          (a, b) =>
            b.permissionCount - a.permissionCount ||
            (a.name || '').localeCompare(b.name || ''),
        ),
    [roles],
  );

  // The search bar and pagination only appear once the firm has more than a page
  // of roles; below that the full list fits without either control.
  const showSearch = rows.length > 10;

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (role) =>
        (role.name || '').toLowerCase().includes(q) ||
        role.roleType.toLowerCase().includes(q),
    );
  }, [rows, search]);

  const editingRole = useMemo(
    () => roles.find((role) => role.id === editingRoleId) || null,
    [roles, editingRoleId],
  );

  const closeEditor = () => setEditorOpen(false);

  useResetAfterClose(editorOpen, () => {
    setEditingRoleId(null);
    setFormName('');
    setFormPermissions([]);
    setSubmitting(false);
    setEditorError(null);
  });

  const openCreateEditor = () => {
    setPageError(null);
    setEditorError(null);
    setSuccessMessage(null);
    setEditingRoleId(null);
    setFormName('');
    setFormPermissions([]);
    setEditorOpen(true);
  };

  const openEditEditor = (role: Role) => {
    setPageError(null);
    setEditorError(null);
    setSuccessMessage(null);
    setEditingRoleId(role.id);
    setFormName(role.name || '');
    setFormPermissions(Array.isArray(role.permissions) ? role.permissions : []);
    setEditorOpen(true);
  };

  const [deleteError, setDeleteError] = useState<string | null>(null);

  const confirmDeleteRole = useCallback(async () => {
    if (!roleToDelete) return;
    const role = roleToDelete;
    if (!canManageRoles || role.name === 'Owner') return;

    try {
      setDeleting(true);
      setPageError(null);
      setDeleteError(null);
      setSuccessMessage(null);
      await deleteRole(role.id);
      setSuccessMessage(`Deleted role "${role.name}"`);
      if (editingRoleId === role.id) {
        setEditorOpen(false);
        setEditingRoleId(null);
        setFormName('');
        setFormPermissions([]);
        setSubmitting(false);
      }
      setRoleToDelete(null);
    } catch (err: any) {
      // The dialog stays open on a refusal, so the reason is shown inside it.
      setDeleteError(err?.message || 'Failed to delete role');
    } finally {
      setDeleting(false);
    }
  }, [roleToDelete, canManageRoles, deleteRole, editingRoleId]);

  const handleSubmit = async () => {
    if (!canManageRoles) return;

    const trimmedName = formName.trim();
    // Save errors show inside the editor, beside the button that caused them;
    // the banner at the top of the page is out of view below a long role list.
    if (!editingRole && !trimmedName) {
      setEditorError('Role name is required');
      return;
    }

    try {
      setSubmitting(true);
      setEditorError(null);
      setPageError(null);
      setSuccessMessage(null);

      if (editingRole) {
        await updateRole(editingRole.id, {
          name: editingRole.isBuiltIn ? undefined : trimmedName,
          permissions: withImpliedViewPermissions(formPermissions),
        });
        setSuccessMessage(`Updated role "${editingRole.name}"`);
      } else {
        await createRole({
          name: trimmedName,
          permissions: withImpliedViewPermissions(formPermissions),
        });
        setSuccessMessage(`Created role "${trimmedName}"`);
      }

      closeEditor();
    } catch (err: any) {
      setEditorError(err?.message || 'Failed to save role');
    } finally {
      setSubmitting(false);
    }
  };

  const renderRow = useCallback((role: RoleRow): ListRow => {
    const metaParts = [
      `${role.permissionCount} permission${role.permissionCount === 1 ? '' : 's'}`,
    ];

    return {
      title: <RoleBadge roleName={role.name} isOwner={role.name === 'Owner'} />,
      badges: (
        <>
          <StatusBadge variant={role.isBuiltIn ? 'info' : 'neutral'}>
            {role.roleType}
          </StatusBadge>
          {role.name === currentRoleName && (
            <StatusBadge variant="success">Your role</StatusBadge>
          )}
        </>
      ),
      meta: metaParts.join('  ·  '),
    };
  }, [currentRoleName]);

  if (!lawFirmId) return null;

  return (
    <div className="p-4 pl-5 md:p-6 pb-8 md:pb-6 min-w-0">
      <div className="mb-5 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <SectionLabel gap="1">
            Role Management
          </SectionLabel>
          <p className="text-sm text-on-surface-secondary">
            Manage built-in and custom law firm roles with granular permissions.
          </p>
        </div>
        <Button type="primary" onClick={openCreateEditor} disabled={!canManageRoles} className="w-full sm:w-auto">
          New Role
        </Button>
      </div>

      {!canManageRoles && (
        <div className="mb-4 rounded-xl border border-amber-200 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 px-4 py-3">
          <p className="text-xs text-amber-700 dark:text-amber-400">
            You can view role permissions, but only members with <code>firm.manageRoles</code> can edit roles.
          </p>
        </div>
      )}

      <ErrorNotification error={error || pageError} onRetry={error ? () => void refetch() : undefined} onClose={() => setPageError(null)} className="mb-4" />

      <SuccessNotification message={successMessage} className="mb-4" compact />

      {showSearch && (
        <div className="relative mb-4">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search roles by name"
            className="w-full rounded-lg border border-input-border bg-input-bg pl-9 pr-3 py-2 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
        </div>
      )}

      <ListView<RoleRow>
        rows={filteredRows}
        loading={loading}
        getRowId={(row) => row.id}
        renderRow={renderRow}
        onRowClick={(role) => {
          if (!canEditRole(role)) return;
          openEditEditor(role);
        }}
        rowActions={(role) => (
          <>
            <Tooltip title={editTooltip(role)} enterDelay={300}>
              <span>
                <button
                  type="button"
                  aria-label={`Edit ${role.name}`}
                  onClick={() => openEditEditor(role)}
                  disabled={!canEditRole(role)}
                  className="rounded-md p-1.5 text-on-surface-secondary transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:bg-surface-hover hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Pencil size={15} />
                </button>
              </span>
            </Tooltip>
            {role.name !== 'Owner' && (
              <Tooltip
                title={canManageRoles ? 'Delete' : 'You cannot manage roles'}
                enterDelay={300}
              >
                <span>
                  <button
                    type="button"
                    onClick={() => setRoleToDelete(role)}
                    disabled={!canManageRoles}
                    className="rounded-md p-1.5 text-red-600 transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40 dark:text-red-400"
                  >
                    <Trash2 size={15} />
                  </button>
                </span>
              </Tooltip>
            )}
          </>
        )}
        paginationMode="client"
        defaultPageSize={10}
        pageSizeOptions={[10, 25, 50]}
        emptyIcon={<ShieldCheck size={40} />}
        emptyTitle={search.trim() ? 'No matching roles' : 'No roles found'}
        emptyMessage={search.trim() ? 'No roles match your search.' : 'Create a role to get started.'}
      />

      {editorOpen && (
        <section
          aria-label={editingRole ? 'Edit Role' : 'Create Role'}
          className="mt-6 rounded-2xl border border-outline p-4 bg-surface-alt"
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-muted">
                {editingRole ? 'Edit Role' : 'Create Role'}
              </p>
              <p className="text-sm text-on-surface-secondary mt-1">
                {editingRole?.isBuiltIn
                  ? 'Built-in role names are fixed. You can still customize permissions.'
                  : 'Set a role name and choose its permissions.'}
              </p>
            </div>
            <Button type="secondary" size="small" onClick={closeEditor} disabled={submitting}>
              Cancel
            </Button>
          </div>

          <div className="space-y-4">
            <div>
              <FieldLabel htmlFor="roleName">
                Role Name *
              </FieldLabel>
              <input
                id="roleName"
                type="text"
                value={formName}
                onChange={(event) => setFormName(event.target.value)}
                disabled={!!editingRole?.isBuiltIn || submitting || !canManageRoles}
                className="w-full rounded-lg border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                placeholder="Enter role name"
              />
            </div>

            <RoleEditor
              permissions={formPermissions}
              onChange={setFormPermissions}
              disabled={submitting || !canManageRoles}
            />

            <ErrorNotification error={editorError} onClose={() => setEditorError(null)} compact />

            <div className="flex justify-end">
              <Button type="primary" onClick={handleSubmit} disabled={submitting || !canManageRoles}>
                {submitting ? 'Saving...' : 'Save Role'}
              </Button>
            </div>
          </div>
        </section>
      )}

      <ConfirmModal
        isOpen={!!roleToDelete}
        onClose={() => { setRoleToDelete(null); setDeleteError(null); }}
        onConfirm={confirmDeleteRole}
        title="Delete role"
        message={`Are you sure you want to delete the role "${roleToDelete?.name ?? ''}"? Any members assigned to it will lose the role and fall back to the baseline permissions. This cannot be undone.`}
        confirmText="Delete"
        confirmType="danger"
        loading={deleting}
        error={deleteError}
      />
    </div>
  );
}
