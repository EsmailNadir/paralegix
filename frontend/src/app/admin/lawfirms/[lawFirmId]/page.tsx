'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  ChevronDown,
  ChevronRight,
  Crown,
  HardDrive,
  Infinity,
  Mail,
  Pencil,
  RefreshCw,
  Shield,
  SlidersHorizontal,
  ToggleRight,
  UserCheck,
  UserPlus,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorNotification from '@/components/ErrorNotification';
import SuccessNotification from '@/components/SuccessNotification';
import ConfirmAction from "@/components/ui/ConfirmAction";
import Button from '@/components/ui/Button';
import Dropdown from '@/components/ui/Dropdown';
import Checkbox from '@/components/ui/Checkbox';
import StatusBadge from '@/components/ui/StatusBadge';
import Tooltip from '@/components/ui/Tooltip';
import { billingStatusMeta } from '@/constants/statusMeta';
import RoleEditor from '@/components/settingsComp/RoleEditor';
import { withImpliedViewPermissions } from '@/lib/constants/permissions';
import Modal from '@/components/ui/Modal';
import { useResetAfterClose } from '@/hooks/useMountTransition';
import userService from '@/services/users.service';
import adminService, {
  type AdminClient,
  type AdminLawFirm,
  type AdminMember,
  type AdminPendingClientInvite,
  type AdminPendingInvite,
  type AdminPlanData,
  type AdminRole,
  type LawFirmDetailResponse,
} from '@/services/admin.service';
import LimitsOverrideModal from '@/components/adminComp/LimitsOverrideModal';
import FeatureOverridesModal from '@/components/adminComp/FeatureOverridesModal';
import StorageOpsModal from '@/components/adminComp/StorageOpsModal';
import { toLocalDate } from '@/lib/utils/dateUtils';
import { formatCents } from '@/lib/utils/currency';
import { formatPlanPrice, intervalLabel, planLabel } from '@/lib/plans/planLabels';
import FieldLabel from '@/components/ui/FieldLabel';
import TextInput from '@/components/ui/TextInput';
import AdminAccessRequired from '@/components/adminComp/AdminAccessRequired';

function formatDate(value: unknown): string {
  if (!value) return '-';
  try {
    const date = toLocalDate(value as string | number | Date);
    if (!date || Number.isNaN(date.getTime())) return '-';
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return '-';
  }
}

function formatBytes(bytes: number | undefined): string {
  if (!Number.isFinite(bytes) || !bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

type SectionKey = 'members' | 'roles' | 'pendingInvites' | 'pendingClientInvites' | 'clients';

function StatCard({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="bg-surface rounded-xl border border-outline-subtle p-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
          {icon}
        </div>
        <div>
          <p className="text-xs text-on-surface-muted uppercase tracking-[0.1em]">{label}</p>
          <p className="text-xl font-bold text-on-surface">{value}</p>
        </div>
      </div>
    </div>
  );
}

function CollapsibleSection({
  title,
  count,
  icon,
  sectionKey,
  openSections,
  toggle,
  children,
}: {
  title: string;
  count: number;
  icon: React.ReactNode;
  sectionKey: SectionKey;
  openSections: Record<SectionKey, boolean>;
  toggle: (key: SectionKey) => void;
  children: React.ReactNode;
}) {
  const isOpen = openSections[sectionKey];

  return (
    <div className="bg-surface rounded-2xl border border-outline-subtle shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => toggle(sectionKey)}
        className="w-full px-5 py-4 flex items-center justify-between hover:bg-surface-hover transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center">
            {icon}
          </div>
          <h2 className="text-lg font-semibold text-on-surface">{title}</h2>
          <span className="text-xs font-medium text-on-surface-muted bg-surface-alt rounded-full px-2.5 py-0.5">
            {count}
          </span>
        </div>
        {isOpen ? (
          <ChevronDown className="w-5 h-5 text-on-surface-muted" />
        ) : (
          <ChevronRight className="w-5 h-5 text-on-surface-muted" />
        )}
      </button>
      {isOpen && <div className="border-t border-outline-subtle">{children}</div>}
    </div>
  );
}

function MembersTable({
  members,
  roles,
  changingRoleFor,
  removingMemberId,
  onChangeRole,
  onRemove,
}: {
  members: AdminMember[];
  roles: AdminRole[];
  changingRoleFor: string | null;
  removingMemberId: string | null;
  onChangeRole: (memberId: string, roleId: string) => void;
  onRemove: (memberId: string) => Promise<void>;
}) {
  if (members.length === 0) {
    return <p className="px-5 py-6 text-sm text-on-surface-secondary text-center">No members found.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-surface-alt text-on-surface-secondary">
          <tr>
            <th className="px-4 py-3 text-left font-semibold">Name</th>
            <th className="px-4 py-3 text-left font-semibold">Email</th>
            <th className="px-4 py-3 text-left font-semibold">Role</th>
            <th className="px-4 py-3 text-left font-semibold">Joined</th>
            <th className="px-4 py-3 text-left font-semibold">Action</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id} className="border-t border-outline-subtle">
              <td className="px-4 py-3 font-medium text-on-surface">
                {m.name || '-'}
                {m.isOwner && (
                  <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 rounded">
                    Owner
                  </span>
                )}
              </td>
              <td className="px-4 py-3 text-on-surface-secondary">{m.email || '-'}</td>
              <td className="px-4 py-3 text-on-surface-secondary">
                {m.isOwner ? (
                  m.roleName || 'Owner'
                ) : (
                  <Dropdown
                    value={m.roleId || ''}
                    disabled={changingRoleFor === m.id}
                    onChange={(roleId) => onChangeRole(m.id, roleId)}
                    options={[
                      ...(!m.roleId ? [{ value: '', label: '-' }] : []),
                      ...roles.map((role) => ({
                        value: role.id,
                        label: role.name,
                      })),
                    ]}
                    className="w-[180px]"
                    buttonClassName="px-2 py-1 bg-input-bg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    portal
                  />
                )}
                {changingRoleFor === m.id && (
                  <span className="ml-2 text-xs text-on-surface-muted">Saving...</span>
                )}
              </td>
              <td className="px-4 py-3 text-on-surface-secondary">{formatDate(m.joinedAt)}</td>
              <td className="px-4 py-3">
                {!m.isOwner && (
                  <ConfirmAction title="Remove Member" message={`Remove "${m.name || m.email}" from this law firm? They will lose access to the firm.`} confirmText="Remove" onConfirm={() => onRemove(m.id)}>
                    {(request) => (
                      <Button
                        type="secondary"
                        size="small"
                        onClick={request}
                        disabled={removingMemberId === m.id}
                        loading={removingMemberId === m.id}
                        icon={<Trash2 className="w-3.5 h-3.5" />}
                      >
                        Remove
                      </Button>
                    )}
                  </ConfirmAction>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RolesTable({ roles, onEdit }: { roles: AdminRole[]; onEdit: (role: AdminRole) => void }) {
  if (roles.length === 0) {
    return <p className="px-5 py-6 text-sm text-on-surface-secondary text-center">No roles found.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-surface-alt text-on-surface-secondary">
          <tr>
            <th className="px-4 py-3 text-left font-semibold">Name</th>
            <th className="px-4 py-3 text-left font-semibold">Type</th>
            <th className="px-4 py-3 text-left font-semibold">Permissions</th>
            <th className="px-4 py-3 text-left font-semibold">Action</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r.id} className="border-t border-outline-subtle">
              <td className="px-4 py-3 font-medium text-on-surface">{r.name}</td>
              <td className="px-4 py-3 text-on-surface-secondary">
                <span
                  className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                    r.isBuiltIn
                      ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30'
                      : 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/30'
                  }`}
                >
                  {r.isBuiltIn ? 'Built-in' : 'Custom'}
                </span>
              </td>
              <td className="px-4 py-3 text-on-surface-secondary">
                <span className="text-xs">{r.permissions.length} permission{r.permissions.length !== 1 ? 's' : ''}</span>
              </td>
              <td className="px-4 py-3">
                <Button
                  type="secondary"
                  size="small"
                  onClick={() => onEdit(r)}
                  icon={<Pencil className="w-3.5 h-3.5" />}
                >
                  Edit
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PendingInvitesTable({
  invites,
  deletingId,
  onDelete,
}: {
  invites: AdminPendingInvite[];
  deletingId: string | null;
  onDelete: (inviteId: string) => Promise<void>;
}) {
  if (invites.length === 0) {
    return <p className="px-5 py-6 text-sm text-on-surface-secondary text-center">No pending member invites.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-surface-alt text-on-surface-secondary">
          <tr>
            <th className="px-4 py-3 text-left font-semibold">Email</th>
            <th className="px-4 py-3 text-left font-semibold">Role</th>
            <th className="px-4 py-3 text-left font-semibold">Invited At</th>
            <th className="px-4 py-3 text-left font-semibold">Action</th>
          </tr>
        </thead>
        <tbody>
          {invites.map((inv) => (
            <tr key={inv.id} className="border-t border-outline-subtle">
              <td className="px-4 py-3 font-medium text-on-surface">{inv.email}</td>
              <td className="px-4 py-3 text-on-surface-secondary">{inv.roleName || '-'}</td>
              <td className="px-4 py-3 text-on-surface-secondary">{formatDate(inv.invitedAt)}</td>
              <td className="px-4 py-3">
                <ConfirmAction title="Delete Invitation" message={`Delete the pending invitation for "${inv.email}"? They will no longer be able to accept this invitation.`} confirmText="Delete" onConfirm={() => onDelete(inv.id)}>
                    {(request) => (
                      <Button
                        type="secondary"
                        size="small"
                        onClick={request}
                        disabled={deletingId === inv.id}
                        loading={deletingId === inv.id}
                        icon={<Trash2 className="w-3.5 h-3.5" />}
                      >
                        Delete
                      </Button>
                    )}
                  </ConfirmAction>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PendingClientInvitesTable({
  invites,
  deletingId,
  onDelete,
}: {
  invites: AdminPendingClientInvite[];
  deletingId: string | null;
  onDelete: (inviteId: string) => Promise<void>;
}) {
  if (invites.length === 0) {
    return <p className="px-5 py-6 text-sm text-on-surface-secondary text-center">No pending client invites.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-surface-alt text-on-surface-secondary">
          <tr>
            <th className="px-4 py-3 text-left font-semibold">Email</th>
            <th className="px-4 py-3 text-left font-semibold">Invited At</th>
            <th className="px-4 py-3 text-left font-semibold">Action</th>
          </tr>
        </thead>
        <tbody>
          {invites.map((inv) => (
            <tr key={inv.id} className="border-t border-outline-subtle">
              <td className="px-4 py-3 font-medium text-on-surface">{inv.email}</td>
              <td className="px-4 py-3 text-on-surface-secondary">{formatDate(inv.invitedAt)}</td>
              <td className="px-4 py-3">
                <ConfirmAction title="Delete Invitation" message={`Delete the pending invitation for "${inv.email}"? They will no longer be able to accept this invitation.`} confirmText="Delete" onConfirm={() => onDelete(inv.id)}>
                    {(request) => (
                      <Button
                        type="secondary"
                        size="small"
                        onClick={request}
                        disabled={deletingId === inv.id}
                        loading={deletingId === inv.id}
                        icon={<Trash2 className="w-3.5 h-3.5" />}
                      >
                        Delete
                      </Button>
                    )}
                  </ConfirmAction>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClientsTable({ clients }: { clients: AdminClient[] }) {
  if (clients.length === 0) {
    return <p className="px-5 py-6 text-sm text-on-surface-secondary text-center">No clients found.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-surface-alt text-on-surface-secondary">
          <tr>
            <th className="px-4 py-3 text-left font-semibold">Name</th>
            <th className="px-4 py-3 text-left font-semibold">Email</th>
            <th className="px-4 py-3 text-left font-semibold">Portal</th>
            <th className="px-4 py-3 text-left font-semibold">Matters</th>
            <th className="px-4 py-3 text-left font-semibold">Joined</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr key={c.id} className="border-t border-outline-subtle">
              <td className="px-4 py-3 font-medium text-on-surface">
                <div className="flex items-center gap-1.5">
                  {c.clientType === 'company' && (
                    <Tooltip title="Organization client" enterDelay={300}>
                      <Building2 size={14} className="text-accent-emphasis shrink-0" />
                    </Tooltip>
                  )}
                  {c.name || '-'}
                </div>
              </td>
              <td className="px-4 py-3 text-on-surface-secondary">{c.email || '-'}</td>
              <td className="px-4 py-3 text-on-surface-secondary">
                {c.clientType === 'company' ? (
                  <div className="flex items-center gap-1.5">
                    <Users size={14} className="text-on-surface-muted shrink-0" />
                    <span>
                      {c.rosterPortalCount} roster {c.rosterPortalCount === 1 ? 'user' : 'users'}
                    </span>
                  </div>
                ) : (
                  c.userId ? 'Linked' : 'Never invited'
                )}
              </td>
              <td className="px-4 py-3 text-on-surface-secondary">{c.matterIds.length}</td>
              <td className="px-4 py-3 text-on-surface-secondary">{formatDate(c.joinedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlanSection({
  plan,
  editing,
  planForm,
  setPlanForm,
  saving,
  onStartEdit,
  onCancelEdit,
  onSave,
  onComp,
  onCancelSubscription,
  onOpenOverrides,
  onOpenFeatures,
  onOpenStorage,
}: {
  plan: AdminPlanData | undefined;
  editing: boolean;
  planForm: { planId: string; unlimitedOverride: boolean; comped: boolean; compedReason: string };
  setPlanForm: (fn: (prev: typeof planForm) => typeof planForm) => void;
  saving: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onComp: () => void;
  onCancelSubscription: () => void;
  onOpenOverrides: () => void;
  onOpenFeatures: () => void;
  onOpenStorage: () => void;
}) {
  const p = plan || { planId: 'starter', billingStatus: 'comped', comped: true } as AdminPlanData;
  const billingStatus = billingStatusMeta(p.billingStatus);

  return (
    <div className="bg-surface rounded-2xl border border-outline-subtle shadow-sm p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-amber-50 dark:bg-amber-900/30 flex items-center justify-center">
            <Crown className="w-4 h-4 text-amber-600 dark:text-amber-400" />
          </div>
          <h2 className="text-base font-semibold text-on-surface">Plan & Subscription</h2>
        </div>
        {!editing && (
          <Button type="secondary" size="small" onClick={onStartEdit} icon={<Pencil className="w-3.5 h-3.5" />}>
            Edit Plan
          </Button>
        )}
      </div>

      {!editing ? (
        <>
          {/* Read-only display */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-3 text-sm">
            <div>
              <span className="text-on-surface-muted">Plan</span>
              <p className="text-on-surface font-medium flex items-center gap-2">
                {planLabel(p.planId)}
                {p.unlimitedOverride && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wider text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-900/30 px-1.5 py-0.5 rounded">
                    <Infinity className="w-3 h-3" /> Unlimited
                  </span>
                )}
              </p>
            </div>
            <div>
              <span className="text-on-surface-muted">Billing Status</span>
              <p className="text-on-surface font-medium">
                <StatusBadge variant={billingStatus.variant}>{billingStatus.label}</StatusBadge>
                {p.cancelAtPeriodEnd && (
                  <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 rounded">
                    Cancels at period end
                  </span>
                )}
              </p>
            </div>
            <div>
              <span className="text-on-surface-muted">Billing Interval</span>
              <p className="text-on-surface font-medium">
                {intervalLabel(p.billingInterval) || 'N/A'}
              </p>
            </div>
            <div>
              <span className="text-on-surface-muted">Plan Price</span>
              <p className="text-on-surface font-medium">
                {p.comped ? 'Free (comped)' : formatPlanPrice(p) || 'N/A'}
              </p>
            </div>
            {p.comped && (
              <div>
                <span className="text-on-surface-muted">Comped</span>
                <p className="text-on-surface font-medium">{p.compedReason || 'Yes'}</p>
              </div>
            )}
            {p.stripeSubscriptionId && (
              <div>
                <span className="text-on-surface-muted">Stripe Subscription</span>
                <p className="text-on-surface font-medium text-xs font-mono">{p.stripeSubscriptionId}</p>
              </div>
            )}
            {p.stripeCustomerId && (
              <div>
                <span className="text-on-surface-muted">Stripe Customer</span>
                <p className="text-on-surface font-medium text-xs font-mono">{p.stripeCustomerId}</p>
              </div>
            )}
            {p.currentPeriodEnd && (
              <div>
                <span className="text-on-surface-muted">Period End</span>
                <p className="text-on-surface font-medium">{formatDate(p.currentPeriodEnd)}</p>
              </div>
            )}
            {p.trialEndsAt && (
              <div>
                <span className="text-on-surface-muted">Trial Ends</span>
                <p className="text-on-surface font-medium">{formatDate(p.trialEndsAt)}</p>
              </div>
            )}
            {p.lastPaymentAt && (
              <div>
                <span className="text-on-surface-muted">Last Payment</span>
                <p className="text-on-surface font-medium">
                  {p.lastPaymentAmount != null ? formatCents(p.lastPaymentAmount) : ''} on {formatDate(p.lastPaymentAt)}
                </p>
              </div>
            )}
            {p.assignedAt && (
              <div>
                <span className="text-on-surface-muted">Plan Assigned</span>
                <p className="text-on-surface font-medium">{formatDate(p.assignedAt)}</p>
              </div>
            )}
          </div>

          {/* Quick actions */}
          <div className="mt-4 pt-4 border-t border-outline-subtle flex flex-wrap gap-2">
            <Button type="secondary" size="small" onClick={onComp} icon={<Crown className="w-3.5 h-3.5" />}>
              Give Free Access
            </Button>
            <Button type="secondary" size="small" onClick={onOpenOverrides} icon={<SlidersHorizontal className="w-3.5 h-3.5" />}>
              Limit Overrides
            </Button>
            <Button type="secondary" size="small" onClick={onOpenFeatures} icon={<ToggleRight className="w-3.5 h-3.5" />}>
              Features
            </Button>
            <Button type="secondary" size="small" onClick={onOpenStorage} icon={<HardDrive className="w-3.5 h-3.5" />}>
              Storage
            </Button>
            {p.stripeSubscriptionId && !p.cancelAtPeriodEnd && (
              <Button type="secondary" size="small" onClick={onCancelSubscription} icon={<X className="w-3.5 h-3.5" />}>
                Cancel Subscription
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          {/* Edit form */}
          <div className="space-y-4">
            <div>
              <FieldLabel>Plan Tier</FieldLabel>
              <Dropdown
                value={planForm.planId}
                onChange={(v) => setPlanForm((prev) => ({ ...prev, planId: v }))}
                options={[
                  { value: 'starter', label: 'Starter' },
                  { value: 'basic', label: 'Basic' },
                  { value: 'professional', label: 'Professional' },
                  { value: 'enterprise', label: 'Enterprise' },
                ]}
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-on-surface cursor-pointer">
              <Checkbox
                checked={planForm.unlimitedOverride}
                onChange={(checked) => setPlanForm((prev) => ({ ...prev, unlimitedOverride: checked }))}
              />
              Unlimited override (bypass all plan limits)
            </label>

            <label className="flex items-center gap-2 text-sm text-on-surface cursor-pointer">
              <Checkbox
                checked={planForm.comped}
                onChange={(checked) => setPlanForm((prev) => ({ ...prev, comped: checked }))}
              />
              Comped (free access)
            </label>

            {planForm.comped && (
              <div>
                <FieldLabel>Comp Reason</FieldLabel>
                <TextInput
                  type="text"
                  value={planForm.compedReason}
                  onChange={(e) => setPlanForm((prev) => ({ ...prev, compedReason: e.target.value }))}
                  placeholder="e.g. Beta tester"
                />
              </div>
            )}
          </div>

          <div className="mt-4 pt-4 border-t border-outline-subtle flex items-center justify-end gap-2">
            <Button type="secondary" size="small" onClick={onCancelEdit} disabled={saving}>Cancel</Button>
            <Button type="primary" size="small" onClick={onSave} loading={saving}>Save Plan</Button>
          </div>
        </>
      )}
    </div>
  );
}

export default function AdminLawFirmDetailPage() {
  const router = useRouter();
  const params = useParams();
  const lawFirmId = params.lawFirmId as string;
  const { user, loading: authLoading } = useAuth();

  const [checkingAccess, setCheckingAccess] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<LawFirmDetailResponse | null>(null);

  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>({
    members: true,
    roles: false,
    pendingInvites: false,
    pendingClientInvites: false,
    clients: false,
  });

  const [changingRoleFor, setChangingRoleFor] = useState<string | null>(null);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [deletingInviteId, setDeletingInviteId] = useState<string | null>(null);
  const [deletingClientInviteId, setDeletingClientInviteId] = useState<string | null>(null);

  const [editingRole, setEditingRole] = useState<AdminRole | null>(null);
  const [editRoleName, setEditRoleName] = useState('');
  const [editRolePermissions, setEditRolePermissions] = useState<string[]>([]);
  const [savingRole, setSavingRole] = useState(false);
  const [roleModalError, setRoleModalError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Plan editing state
  const [editingPlan, setEditingPlan] = useState(false);
  const [planForm, setPlanForm] = useState({
    planId: 'starter',
    unlimitedOverride: false,
    comped: false,
    compedReason: '',
  });
  const [savingPlan, setSavingPlan] = useState(false);
  const [compModalOpen, setCompModalOpen] = useState(false);
  const [compReason, setCompReason] = useState('');
  const [compPlanId, setCompPlanId] = useState('professional');
  const [compingFirm, setCompingFirm] = useState(false);
  const [cancelSubModalOpen, setCancelSubModalOpen] = useState(false);
  const [cancelImmediate, setCancelImmediate] = useState(false);
  const [cancellingSubscription, setCancellingSubscription] = useState(false);

  // Per-firm override modals (kept out of the main view to avoid clutter).
  const [overridesModalOpen, setOverridesModalOpen] = useState(false);
  const [featuresModalOpen, setFeaturesModalOpen] = useState(false);
  const [storageModalOpen, setStorageModalOpen] = useState(false);

  // Merge a freshly-saved law-firm record back into the loaded detail.
  const applyLawFirmUpdate = useCallback((lawFirm: AdminLawFirm) => {
    setData((prev) => (prev ? { ...prev, lawFirm } : prev));
  }, []);

  // Keep the role rendered through the exit animation, after it is cleared on close.
  const lastEditingRoleRef = useRef<AdminRole | null>(null);
  if (editingRole) lastEditingRoleRef.current = editingRole;
  const activeEditingRole = editingRole ?? lastEditingRoleRef.current;

  const toggleSection = useCallback((key: SectionKey) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const openRoleEditor = useCallback((role: AdminRole) => {
    setEditingRole(role);
    setEditRoleName(role.name);
    setEditRolePermissions([...role.permissions]);
    setRoleModalError(null);
  }, []);

  const closeRoleEditor = useCallback(() => setEditingRole(null), []);

  useResetAfterClose(!!editingRole, () => setRoleModalError(null));

  const requestCloseComp = useCallback(() => {
    if (compingFirm) return;
    setCompModalOpen(false);
  }, [compingFirm]);

  const requestCloseCancelSub = useCallback(() => {
    if (cancellingSubscription) return;
    setCancelSubModalOpen(false);
  }, [cancellingSubscription]);

  const requestCloseRoleEditor = useCallback(() => {
    if (savingRole) return;
    closeRoleEditor();
  }, [savingRole, closeRoleEditor]);

  const handleSaveRole = useCallback(async () => {
    if (!editingRole) return;

    if (!editRoleName.trim()) {
      setRoleModalError('Role name is required.');
      return;
    }

    setSavingRole(true);
    setRoleModalError(null);

    try {
      const permissions = withImpliedViewPermissions(editRolePermissions);
      await adminService.updateLawFirmRole(lawFirmId, editingRole.id, {
        name: editingRole.isBuiltIn ? undefined : editRoleName.trim(),
        permissions,
      });

      // Update local data
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          roles: prev.roles.map((r) =>
            r.id === editingRole.id
              ? { ...r, name: editingRole.isBuiltIn ? r.name : editRoleName.trim(), permissions }
              : r,
          ),
        };
      });

      setSuccessMessage(`Saved changes to "${editingRole.isBuiltIn ? editingRole.name : editRoleName.trim()}" role.`);
      closeRoleEditor();
    } catch (err) {
      setRoleModalError(getErrorMessage(err));
    } finally {
      setSavingRole(false);
    }
  }, [editingRole, editRoleName, editRolePermissions, lawFirmId, closeRoleEditor]);

  const handleChangeMemberRole = useCallback(async (memberId: string, roleId: string) => {
    if (!roleId) return;

    setChangingRoleFor(memberId);
    setError(null);

    try {
      const result = await adminService.updateMemberRole(lawFirmId, memberId, roleId);

      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          members: prev.members.map((m) =>
            m.id === memberId
              ? { ...m, roleId, roleName: result.roleName }
              : m,
          ),
        };
      });

      setSuccessMessage(`Updated member role to "${result.roleName}".`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setChangingRoleFor(null);
    }
  }, [lawFirmId]);

  const handleRemoveMember = useCallback(async (memberId: string) => {
    setRemovingMemberId(memberId);
    setError(null);

    try {
      await adminService.removeMember(lawFirmId, memberId);

      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          members: prev.members.filter((m) => m.id !== memberId),
        };
      });

      setSuccessMessage('Member removed from law firm.');
    } finally {
      setRemovingMemberId(null);
    }
  }, [lawFirmId]);

  const handleDeletePendingInvite = useCallback(async (inviteId: string) => {
    setDeletingInviteId(inviteId);
    setError(null);

    try {
      await adminService.deletePendingInvite(lawFirmId, inviteId);

      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          pendingInvites: prev.pendingInvites.filter((inv) => inv.id !== inviteId),
        };
      });

      setSuccessMessage('Pending member invite deleted.');
    } finally {
      setDeletingInviteId(null);
    }
  }, [lawFirmId]);

  const handleDeletePendingClientInvite = useCallback(async (inviteId: string) => {
    setDeletingClientInviteId(inviteId);
    setError(null);

    try {
      await adminService.deletePendingClientInvite(lawFirmId, inviteId);

      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          pendingClientInvites: prev.pendingClientInvites.filter((inv) => inv.id !== inviteId),
        };
      });

      setSuccessMessage('Pending client invite deleted.');
    } finally {
      setDeletingClientInviteId(null);
    }
  }, [lawFirmId]);

  const startEditingPlan = useCallback(() => {
    const plan = data?.lawFirm?.plan;
    setPlanForm({
      planId: plan?.planId || 'starter',
      unlimitedOverride: plan?.unlimitedOverride || false,
      comped: plan?.comped || false,
      compedReason: plan?.compedReason || '',
    });
    setEditingPlan(true);
  }, [data]);

  const handleSavePlan = useCallback(async () => {
    setSavingPlan(true);
    setError(null);
    try {
      const result = await adminService.updateLawFirmPlan(lawFirmId, {
        planId: planForm.planId,
        unlimitedOverride: planForm.unlimitedOverride,
        comped: planForm.comped,
        compedReason: planForm.comped ? planForm.compedReason : undefined,
      });
      setData((prev) => {
        if (!prev) return prev;
        return { ...prev, lawFirm: result.lawFirm };
      });
      setEditingPlan(false);
      setSuccessMessage('Plan updated successfully.');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSavingPlan(false);
    }
  }, [lawFirmId, planForm]);

  const handleCompFirm = useCallback(async () => {
    if (!compReason.trim()) return;
    setCompingFirm(true);
    setError(null);
    try {
      await adminService.compFirm(lawFirmId, {
        planId: compPlanId,
        reason: compReason.trim(),
      });
      setCompModalOpen(false);
      setCompReason('');
      setSuccessMessage('Firm comped successfully.');
      // Reload to get updated plan data
      const result = await adminService.getLawFirmDetail(lawFirmId);
      setData(result);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setCompingFirm(false);
    }
  }, [lawFirmId, compPlanId, compReason]);

  const handleCancelSubscription = useCallback(async () => {
    setCancellingSubscription(true);
    setError(null);
    try {
      await adminService.adminCancelSubscription(lawFirmId, {
        immediate: cancelImmediate,
      });
      setCancelSubModalOpen(false);
      setSuccessMessage('Subscription cancelled.');
      const result = await adminService.getLawFirmDetail(lawFirmId);
      setData(result);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setCancellingSubscription(false);
    }
  }, [lawFirmId, cancelImmediate]);

  const loadDetail = useCallback(async () => {
    if (!lawFirmId) return;
    setLoadingData(true);
    setError(null);
    try {
      const result = await adminService.getLawFirmDetail(lawFirmId);
      setData(result);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoadingData(false);
    }
  }, [lawFirmId]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace('/login');
      return;
    }

    let active = true;

    const checkAccess = async () => {
      setCheckingAccess(true);
      setError(null);
      try {
        const profile = await userService.getProfile();
        const hasAdminAccess = (profile as { isAdmin?: boolean })?.isAdmin === true;
        if (!active) return;
        setIsAdmin(hasAdminAccess);
        if (hasAdminAccess) {
          await loadDetail();
        }
      } catch (err) {
        if (!active) return;
        setError(getErrorMessage(err));
      } finally {
        if (active) setCheckingAccess(false);
      }
    };

    checkAccess();
    return () => { active = false; };
  }, [authLoading, user, router, loadDetail]);

  useEffect(() => {
    if (!successMessage) return;
    const timeout = setTimeout(() => setSuccessMessage(null), 4000);
    return () => clearTimeout(timeout);
  }, [successMessage]);

  if (authLoading || checkingAccess) {
    return <LoadingSpinner fullPage />;
  }

  if (!user) return null;

  if (!isAdmin) {
    return (
      <AdminAccessRequired
        description="Your account does not have admin access."
        onBack={() => router.push('/dashboard')}
      />
    );
  }

  const lawFirm = data?.lawFirm;
  const storage = lawFirm?.storage;

  return (
    <div className="min-h-screen bg-page p-4 md:p-8">
      <div className="max-w-[1600px] mx-auto space-y-6">
        {/* Header */}
        <div className="bg-surface rounded-2xl border border-outline-subtle p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
                <Building2 className="w-6 h-6 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.12em] text-on-surface-muted font-semibold">Law Firm Detail</p>
                <h1 className="text-2xl font-bold text-on-surface mt-1">
                  {loadingData && !data ? 'Loading...' : (lawFirm?.name || lawFirmId)}
                </h1>
                {lawFirm?.email && (
                  <p className="text-sm text-on-surface-secondary mt-0.5">{lawFirm.email}</p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button type="secondary" onClick={() => router.push('/admin/lawfirms')} icon={<ArrowLeft className="w-4 h-4" />}>
                Back
              </Button>
              <Button
                type="primary"
                onClick={loadDetail}
                disabled={loadingData}
                icon={<RefreshCw className={`w-4 h-4 ${loadingData ? 'animate-spin' : ''}`} />}
              >
                Refresh
              </Button>
            </div>
          </div>
        </div>

        <ErrorNotification error={error} onClose={() => setError(null)} />

        <SuccessNotification message={successMessage} onClose={() => setSuccessMessage(null)} />

        {loadingData && !data && <LoadingSpinner fullPage={false} />}

        {data && (
          <>
            {/* Profile info + stats */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
              <StatCard
                label="Members"
                value={data.members.length}
                icon={<Users className="w-4.5 h-4.5 text-blue-600 dark:text-blue-400" />}
              />
              <StatCard
                label="Roles"
                value={data.roles.length}
                icon={<Shield className="w-4.5 h-4.5 text-blue-600 dark:text-blue-400" />}
              />
              <StatCard
                label="Pending Invites"
                value={data.pendingInvites.length}
                icon={<UserPlus className="w-4.5 h-4.5 text-blue-600 dark:text-blue-400" />}
              />
              <StatCard
                label="Client Invites"
                value={data.pendingClientInvites.length}
                icon={<Mail className="w-4.5 h-4.5 text-blue-600 dark:text-blue-400" />}
              />
              <StatCard
                label="Clients"
                value={data.clients.length}
                icon={<UserCheck className="w-4.5 h-4.5 text-blue-600 dark:text-blue-400" />}
              />
            </div>

            {/* Firm profile card */}
            <div className="bg-surface rounded-2xl border border-outline-subtle shadow-sm p-5">
              <h2 className="text-base font-semibold text-on-surface mb-4">Firm Profile</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-3 text-sm">
                <div>
                  <span className="text-on-surface-muted">Name</span>
                  <p className="text-on-surface font-medium">{lawFirm?.name || '-'}</p>
                </div>
                <div>
                  <span className="text-on-surface-muted">Email</span>
                  <p className="text-on-surface font-medium">{lawFirm?.email || '-'}</p>
                </div>
                <div>
                  <span className="text-on-surface-muted">Phone</span>
                  <p className="text-on-surface font-medium">{lawFirm?.phone || '-'}</p>
                </div>
                <div>
                  <span className="text-on-surface-muted">Address</span>
                  <p className="text-on-surface font-medium">
                    {[lawFirm?.address, lawFirm?.city, lawFirm?.state, lawFirm?.zip].filter(Boolean).join(', ') || '-'}
                  </p>
                </div>
                <div>
                  <span className="text-on-surface-muted">Storage</span>
                  <p className="text-on-surface font-medium">
                    {formatBytes(storage?.usedBytes)} / {formatBytes(storage?.quotaBytes)}
                  </p>
                </div>
                <div>
                  <span className="text-on-surface-muted">Created</span>
                  <p className="text-on-surface font-medium">{formatDate(lawFirm?.createdAt)}</p>
                </div>
                {lawFirm?.description && (
                  <div className="md:col-span-2 lg:col-span-3">
                    <span className="text-on-surface-muted">Description</span>
                    <p className="text-on-surface font-medium">{lawFirm.description}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Plan & Subscription */}
            <PlanSection
              plan={lawFirm?.plan}
              editing={editingPlan}
              planForm={planForm}
              setPlanForm={setPlanForm}
              saving={savingPlan}
              onStartEdit={startEditingPlan}
              onCancelEdit={() => setEditingPlan(false)}
              onSave={handleSavePlan}
              onComp={() => {
                setCompPlanId(lawFirm?.plan?.planId || 'professional');
                setCompReason('');
                setCompModalOpen(true);
              }}
              onCancelSubscription={() => {
                setCancelImmediate(false);
                setCancelSubModalOpen(true);
              }}
              onOpenOverrides={() => setOverridesModalOpen(true)}
              onOpenFeatures={() => setFeaturesModalOpen(true)}
              onOpenStorage={() => setStorageModalOpen(true)}
            />

            {/* Collapsible sections */}
            <CollapsibleSection
              title="Members"
              count={data.members.length}
              icon={<Users className="w-4 h-4 text-blue-600 dark:text-blue-400" />}
              sectionKey="members"
              openSections={openSections}
              toggle={toggleSection}
            >
              <MembersTable
                members={data.members}
                roles={data.roles}
                changingRoleFor={changingRoleFor}
                removingMemberId={removingMemberId}
                onChangeRole={handleChangeMemberRole}
                onRemove={handleRemoveMember}
              />
            </CollapsibleSection>

            <CollapsibleSection
              title="Roles"
              count={data.roles.length}
              icon={<Shield className="w-4 h-4 text-blue-600 dark:text-blue-400" />}
              sectionKey="roles"
              openSections={openSections}
              toggle={toggleSection}
            >
              <RolesTable roles={data.roles} onEdit={openRoleEditor} />
            </CollapsibleSection>

            <CollapsibleSection
              title="Pending Member Invites"
              count={data.pendingInvites.length}
              icon={<UserPlus className="w-4 h-4 text-blue-600 dark:text-blue-400" />}
              sectionKey="pendingInvites"
              openSections={openSections}
              toggle={toggleSection}
            >
              <PendingInvitesTable
                invites={data.pendingInvites}
                deletingId={deletingInviteId}
                onDelete={handleDeletePendingInvite}
              />
            </CollapsibleSection>

            <CollapsibleSection
              title="Pending Client Invites"
              count={data.pendingClientInvites.length}
              icon={<Mail className="w-4 h-4 text-blue-600 dark:text-blue-400" />}
              sectionKey="pendingClientInvites"
              openSections={openSections}
              toggle={toggleSection}
            >
              <PendingClientInvitesTable
                invites={data.pendingClientInvites}
                deletingId={deletingClientInviteId}
                onDelete={handleDeletePendingClientInvite}
              />
            </CollapsibleSection>

            <CollapsibleSection
              title="Clients"
              count={data.clients.length}
              icon={<UserCheck className="w-4 h-4 text-blue-600 dark:text-blue-400" />}
              sectionKey="clients"
              openSections={openSections}
              toggle={toggleSection}
            >
              <ClientsTable clients={data.clients} />
            </CollapsibleSection>
          </>
        )}
      </div>

      {/* Per-firm override modals */}
      <LimitsOverrideModal
        open={overridesModalOpen}
        onClose={() => setOverridesModalOpen(false)}
        lawFirmId={lawFirmId}
        plan={lawFirm?.plan}
        onSaved={applyLawFirmUpdate}
      />
      <FeatureOverridesModal
        open={featuresModalOpen}
        onClose={() => setFeaturesModalOpen(false)}
        lawFirmId={lawFirmId}
        plan={lawFirm?.plan}
        onSaved={applyLawFirmUpdate}
      />
      <StorageOpsModal
        open={storageModalOpen}
        onClose={() => setStorageModalOpen(false)}
        lawFirmId={lawFirmId}
        storage={storage}
        onSaved={applyLawFirmUpdate}
      />

      {/* Give Free Access Modal */}
      <Modal
        isOpen={compModalOpen}
        onClose={requestCloseComp}
        title="Give Free Access"
        showClose={false}
        dismissible={!compingFirm}
        footer={
          <>
            <Button type="secondary" onClick={() => setCompModalOpen(false)} disabled={compingFirm}>Cancel</Button>
            <Button type="primary" onClick={handleCompFirm} loading={compingFirm} disabled={!compReason.trim()}>Give Free Access</Button>
          </>
        }
      >
        <p className="text-sm text-on-surface-secondary">
          This will cancel any active Stripe subscription and give the firm free access to the selected plan.
        </p>
        <div>
          <FieldLabel>Plan</FieldLabel>
          <Dropdown
            value={compPlanId}
            onChange={setCompPlanId}
            options={[
              { value: 'starter', label: 'Starter' },
              { value: 'professional', label: 'Professional' },
              { value: 'enterprise', label: 'Enterprise' },
            ]}
            portal
          />
        </div>
        <div>
          <FieldLabel>Reason *</FieldLabel>
          <TextInput
            type="text"
            value={compReason}
            onChange={(e) => setCompReason(e.target.value)}
            placeholder="e.g. Beta tester, partnership deal"
          />
        </div>
      </Modal>

      {/* Cancel Subscription Modal */}
      <Modal
        isOpen={cancelSubModalOpen}
        onClose={requestCloseCancelSub}
        title="Cancel Subscription"
        showClose={false}
        dismissible={!cancellingSubscription}
        footer={
          <>
            <Button type="secondary" onClick={() => setCancelSubModalOpen(false)} disabled={cancellingSubscription}>Cancel</Button>
            <Button type="danger" onClick={handleCancelSubscription} loading={cancellingSubscription}>Confirm Cancellation</Button>
          </>
        }
      >
        <p className="text-sm text-on-surface-secondary">
          This will cancel the firm&apos;s Stripe subscription. They will be downgraded to the Starter plan.
        </p>
        <label className="flex items-center gap-2 text-sm text-on-surface cursor-pointer">
          <Checkbox
            checked={cancelImmediate}
            onChange={setCancelImmediate}
          />
          Cancel immediately (instead of at period end)
        </label>
      </Modal>

      {/* Role Editor Modal */}
      <Modal
        isOpen={!!editingRole}
        onClose={requestCloseRoleEditor}
        title="Edit Role"
        subtitle={
          <>
            {activeEditingRole?.name}
            {activeEditingRole?.isBuiltIn && (
              <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 px-1.5 py-0.5 rounded">
                Built-in
              </span>
            )}
          </>
        }
        closeIcon={<X className="w-5 h-5" />}
        dismissible={!savingRole}
        size="4xl"
        className="rounded-2xl border border-outline-subtle"
        footer={
          <>
            <Button type="secondary" size="small" onClick={closeRoleEditor} disabled={savingRole}>
              Cancel
            </Button>
            <Button
              type="primary"
              size="small"
              onClick={handleSaveRole}
              loading={savingRole}
              disabled={savingRole || (!activeEditingRole?.isBuiltIn && !editRoleName.trim())}
            >
              Save Role
            </Button>
          </>
        }
      >
        <ErrorNotification error={roleModalError} onClose={() => setRoleModalError(null)} />

        {activeEditingRole && !activeEditingRole.isBuiltIn && (
          <label className="block text-sm text-on-surface-secondary">
            Role Name *
            <input
              type="text"
              value={editRoleName}
              onChange={(e) => setEditRoleName(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-input-border bg-input-bg text-on-surface"
              maxLength={100}
            />
          </label>
        )}

        <RoleEditor
          permissions={editRolePermissions}
          onChange={setEditRolePermissions}
        />
      </Modal>
    </div>
  );
}
