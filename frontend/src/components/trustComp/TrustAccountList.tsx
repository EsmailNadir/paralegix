"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Plus, MoreHorizontal, Eye, Edit, Power, Lock, Landmark, X } from "lucide-react";
import { type TrustAccount } from "@/types/trust";
import TrustAccountForm from "./TrustAccountForm";
import TrustAccountCard from "./TrustAccountCard";
import trustService from "@/services/trust.service";
import DatePicker from "@/components/ui/DatePicker";
import ErrorToast from "@/components/ui/ErrorToast";
import ItemActionMenu, { menuPositionFromEvent } from "@/components/ui/ItemActionMenu";
import ListEmptyState from "@/components/ui/ListEmptyState";
import Modal from "@/components/ui/Modal";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { usePermissions } from "@/contexts/PermissionsContext";
import ErrorNotification from "@/components/ErrorNotification";
import FieldLabel from "@/components/ui/FieldLabel";
import Button from "@/components/ui/Button";

interface TrustAccountListProps {
  accounts: TrustAccount[];
  loading?: boolean;
  lawFirmId: string;
  onRefresh: () => void;
  onViewSummary?: (accountId: string) => void;
}

export default function TrustAccountList({
  accounts,
  loading,
  lawFirmId,
  onRefresh,
  onViewSummary,
}: TrustAccountListProps) {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("trust.manage");
  const [showForm, setShowForm] = useState(false);
  const [editingAccount, setEditingAccount] = useState<TrustAccount | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ anchorTop: number; anchorBottom: number; right: number } | null>(null);
  const [statusLoading, setStatusLoading] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // Book-close (period lock) modal state.
  const [bookCloseAccount, setBookCloseAccount] = useState<TrustAccount | null>(null);
  const [bookCloseOpen, setBookCloseOpen] = useState(false);
  const menuAccount = accounts.find((a) => a.id === menuOpen) ?? null;

  const handleToggleStatus = async (account: TrustAccount) => {
    const newStatus = account.status === "active" ? "inactive" : "active";
    setStatusLoading(account.id);
    setMenuOpen(null);
    try {
      await trustService.updateAccountStatus(lawFirmId, account.id, newStatus);
      onRefresh();
    } catch (err: any) {
      setStatusError(getErrorMessage(err, "Failed to update account status"));
    } finally {
      setStatusLoading(null);
    }
  };

  return (
    <div className="space-y-4">
      {statusError && (
        <ErrorToast message={statusError} onDismiss={() => setStatusError(null)} />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-on-surface">Trust Accounts</h3>
          <p className="text-xs text-on-surface-muted mt-0.5">
            The bank accounts your firm holds client funds in.
          </p>
        </div>
        {canManage && (
          <Button
            size="compact"
            onClick={() => { setEditingAccount(null); setShowForm(true); }}
            icon={<Plus size={14} strokeWidth={2.2} />}
          >
            Add Account
          </Button>
        )}
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-surface rounded-xl border border-outline p-4 sm:p-5">
              <div className="h-9 w-9 rounded-lg bg-surface-alt animate-pulse mb-3" />
              <div className="h-8 w-32 rounded bg-surface-alt animate-pulse" />
              <div className="mt-2 h-3 w-24 rounded bg-surface-alt animate-pulse" />
            </div>
          ))}
        </div>
      ) : accounts.length === 0 ? (
        <ListEmptyState
          compact
          icon={<Landmark size={36} />}
          title="No trust accounts yet"
          message="Add an IOLTA or client trust account to start recording deposits and disbursements."
          action={canManage ? (
            <Button
              size="compact"
              onClick={() => { setEditingAccount(null); setShowForm(true); }}
              icon={<Plus size={14} strokeWidth={2.2} />}
            >
              Add Account
            </Button>
          ) : undefined}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {accounts.map((account) => (
            <TrustAccountCard
              key={account.id}
              account={account}
              actions={
                <button
                  data-item-menu-trigger
                  onClick={(e) => {
                    if (menuOpen === account.id) { setMenuOpen(null); return; }
                    setMenuPos(menuPositionFromEvent(e));
                    setMenuOpen(account.id);
                  }}
                  aria-label="Trust account actions"
                  className="p-1.5 rounded-lg text-on-surface-muted border border-outline hover:bg-surface-alt hover:border-outline hover:text-on-surface transition-[background-color,border-color,color] cursor-pointer"
                >
                  <MoreHorizontal size={15} />
                </button>
              }
            />
          ))}
        </div>
      )}

      <ItemActionMenu
        open={menuOpen !== null}
        anchorTop={menuPos?.anchorTop ?? 0}
        anchorBottom={menuPos?.anchorBottom ?? 0}
        right={menuPos?.right ?? 0}
        onClose={() => setMenuOpen(null)}
        actions={!menuAccount ? [] : [
          !!onViewSummary && {
            key: "view-summary",
            label: "View Summary",
            icon: <Eye size={15} />,
            onClick: () => onViewSummary(menuAccount.id),
          },
          canManage && {
            key: "edit",
            label: "Edit",
            icon: <Edit size={15} />,
            onClick: () => { setEditingAccount(menuAccount); setShowForm(true); },
          },
          canManage && {
            key: "book-close",
            label: "Set book-close date",
            icon: <Lock size={15} />,
            onClick: () => { setBookCloseAccount(menuAccount); setBookCloseOpen(true); },
          },
          canManage && {
            key: "toggle-status",
            label: statusLoading === menuAccount.id
              ? "Updating..."
              : menuAccount.status === "active"
                ? "Deactivate"
                : "Activate",
            icon: <Power size={15} />,
            // Deactivating takes the account out of service, so it reads as the
            // destructive action; re-activating is an ordinary one.
            danger: menuAccount.status === "active",
            disabled: statusLoading === menuAccount.id,
            onClick: () => handleToggleStatus(menuAccount),
          },
        ]}
      />

      <TrustAccountForm
        open={showForm}
        lawFirmId={lawFirmId}
        account={editingAccount}
        onClose={() => setShowForm(false)}
        onSaved={() => { setShowForm(false); onRefresh(); }}
      />

      <BookCloseModal
        open={bookCloseOpen}
        lawFirmId={lawFirmId}
        account={bookCloseAccount}
        onClose={() => setBookCloseOpen(false)}
        onSaved={() => { setBookCloseOpen(false); onRefresh(); }}
      />
    </div>
  );
}

interface BookCloseModalProps {
  open: boolean;
  lawFirmId: string;
  account: TrustAccount | null;
  onClose: () => void;
  onSaved: () => void;
}

// Sets or clears an account's book-close date. Transactions dated on or before
// this date are locked (the backend enforces the period lock); clearing it
// (passing null) reopens the period.
function BookCloseModal({ open, lawFirmId, account, onClose, onSaved }: BookCloseModalProps) {
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  // Keep the modal content stable through the exit animation.
  const stableAccount = useRef<TrustAccount | null>(account);
  if (account) stableAccount.current = account;
  const target = stableAccount.current;

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-syncs the date field from the target account each time the modal opens
    setDate(account?.bookCloseDate || "");
    setError(null);
  }, [open, account]);

  const save = async (value: string | null) => {
    if (!target) return;
    setSaving(true);
    setError(null);
    try {
      await trustService.updateBookCloseDate(lawFirmId, target.id, value);
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to update book-close date"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      size="sm"
      dismissible={!saving}
      className="rounded-xl border border-outline"
      showClose={false}
      labelledBy={titleId}
      bodyClassName={null}
    >
        <div className="flex items-center justify-between px-5 py-4 border-b border-outline-subtle shrink-0">
          <h3 id={titleId} className="text-sm font-semibold text-on-surface">Set Book-Close Date</h3>
          <button onClick={onClose} disabled={saving} aria-label="Close" className="p-1 rounded-lg text-on-surface-muted hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto overflow-x-hidden styled-scrollbar">
          <ErrorNotification error={error} compact />

          <p className="text-xs text-on-surface-muted">
            Transactions dated on or before this date for{" "}
            <span className="font-medium text-on-surface">{target?.name}</span> will be locked from edits.
          </p>

          <div>
            <FieldLabel size="xs" tone="secondary">Book-close date</FieldLabel>
            <DatePicker value={date} onChange={setDate} className="w-full" />
          </div>

          <div className="flex justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={() => save(null)}
              disabled={saving || !target?.bookCloseDate}
              className="px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              Clear lock
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="px-3 py-1.5 text-xs font-medium text-on-surface-secondary hover:bg-surface-hover rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => save(date || null)}
                disabled={saving || !date}
                className="px-4 py-1.5 text-xs font-medium text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
    </Modal>
  );
}
