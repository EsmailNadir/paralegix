"use client";

import { useId, useState, useCallback, useMemo } from "react";
import { ChevronRight, Plus, DollarSign, Search, User as UserIcon } from "lucide-react";
import StatusBadge from "@/components/ui/StatusBadge";
import ErrorNotification from "@/components/ErrorNotification";
import billingService from "@/services/billing.service";
import { apiFetch } from "@/lib/utils/fetchWithTokenRefresh";
import { getFirebaseToken } from "@/lib/utils/auth";
import { formatCurrency } from "./utils";
import type { ChargeCode } from "@/types/chargeCode";
import type { User } from "@/types";
import Button from "@/components/ui/Button";
import Spinner from "@/components/ui/Spinner";
import ShowMoreButton from "@/components/ui/ShowMoreButton";
import CollapsibleList from "@/components/ui/CollapsibleList";
import { highlightText } from "@/components/ui/HighlightText";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { usePermissions } from "@/contexts/PermissionsContext";

/**
 * Rows a rate list shows before the rest collapse behind "Show N more".
 *
 * Both lists here are unbounded server-side - the roster is every member of the
 * firm and the charge codes are every active code - so a large firm would
 * otherwise render hundreds of rate inputs on one settings pane.
 */
const LIST_PREVIEW_LIMIT = 5;

/** Whether a member matches a rate-list search box, on name or email. */
function memberMatches(user: User, query: string) {
  const term = query.trim().toLowerCase();
  if (!term) return true;
  return `${user.name || ""} ${user.email || ""}`.toLowerCase().includes(term);
}

/** The display name a member row shows, before any search highlighting. */
function memberLabel(user: User) {
  return user.name || user.email || "Unknown";
}

/**
 * Search box above a rate list.
 *
 * Only rendered once a list outgrows `LIST_PREVIEW_LIMIT`: a firm with three
 * members gains nothing from a field that can only ever filter three rows.
 */
function RateSearchInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <div className="relative mb-3">
      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted" />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted pl-9 pr-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      />
    </div>
  );
}

interface BillingRatesViewProps {
  lawFirmId: string;
  chargeCodes: ChargeCode[];
  users: User[];
  isLoading: boolean;
  onRefresh: () => void;
}

function RateInput({
  value,
  onSave,
  placeholder = "0.00",
  readOnly = false,
}: {
  value: number | null | undefined;
  onSave: (value: number | null) => Promise<void>;
  placeholder?: string;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(
    value != null ? String(value) : ""
  );
  const [saving, setSaving] = useState(false);

  if (readOnly) {
    return (
      <span className="text-sm px-2 py-1 min-w-[80px] inline-block text-left">
        {value != null ? (
          <span className="font-medium text-on-surface">
            {formatCurrency(value)}
            <span className="text-on-surface-muted font-normal">/hr</span>
          </span>
        ) : (
          <span className="text-on-surface-muted">Not set</span>
        )}
      </span>
    );
  }

  const handleSave = async () => {
    setEditing(false);
    const parsed = draft.trim() === "" ? null : parseFloat(draft);
    if (parsed !== null && (isNaN(parsed) || parsed < 0)) return;
    if (parsed === (value ?? null)) return;
    setSaving(true);
    try {
      await onSave(parsed);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-on-surface-muted text-sm">$</span>
        <input
          type="number"
          min="0"
          step="0.01"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") setEditing(false);
          }}
          autoFocus
          className="w-24 border border-blue-400 rounded px-2 py-1 text-sm bg-input-bg text-on-surface focus:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
          placeholder={placeholder}
        />
      </div>
    );
  }

  return (
    <button
      onClick={() => {
        setDraft(value != null ? String(value) : "");
        setEditing(true);
      }}
      disabled={saving}
      className="text-sm px-2 py-1 rounded hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer min-w-[80px] text-left"
    >
      {saving ? (
        <span className="text-on-surface-muted">Saving...</span>
      ) : value != null ? (
        <span className="font-medium text-on-surface">
          {formatCurrency(value)}
          <span className="text-on-surface-muted font-normal">/hr</span>
        </span>
      ) : (
        <span className="text-on-surface-muted">Set rate</span>
      )}
    </button>
  );
}

/**
 * The inline "new charge code" form. Its trigger sits in the section header, so
 * the caller owns whether the form is on screen and this only reports that it
 * is finished.
 */
function AddChargeCodeForm({
  lawFirmId,
  onRefresh,
  onClose,
  className = "",
}: {
  lawFirmId: string;
  onRefresh: () => void;
  onClose: () => void;
  className?: string;
}) {
  const fieldIds = useId();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [defaultRate, setDefaultRate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!code.trim() || !name.trim()) {
      setError("Code and name are required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const rate = defaultRate.trim() ? parseFloat(defaultRate) : null;
      if (rate !== null && (isNaN(rate) || rate < 0)) {
        setError("Invalid rate");
        setSaving(false);
        return;
      }
      await billingService.createChargeCode(lawFirmId, {
        code: code.trim().toUpperCase(),
        name: name.trim(),
        defaultRate: rate,
      });
      setCode("");
      setName("");
      setDefaultRate("");
      onClose();
      onRefresh();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to create"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`border border-outline rounded-lg p-4 bg-surface ${className}`}>
      <ErrorNotification error={error} onClose={() => setError(null)} compact className="mb-3" />
      <div className="flex items-end gap-3">
        <div className="flex-shrink-0">
          <label htmlFor={`${fieldIds}-code`} className="block text-xs font-medium text-on-surface-muted mb-1">
            Code *
          </label>
          <input
            id={`${fieldIds}-code`}
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="DRV"
            maxLength={10}
                  className="w-24 rounded-md border border-input-border bg-input-bg px-2 py-1.5 text-sm text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
        </div>
        <div className="flex-1">
          <label htmlFor={`${fieldIds}-name`} className="block text-xs font-medium text-on-surface-muted mb-1">
            Name *
          </label>
          <input
            id={`${fieldIds}-name`}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Driving"
                  className="w-full rounded-md border border-input-border bg-input-bg px-2 py-1.5 text-sm text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
        </div>
        <div className="flex-shrink-0">
          <label className="block text-xs font-medium text-on-surface-muted mb-1">
            Default Rate
          </label>
          <div className="flex items-center gap-1">
            <span className="text-on-surface-muted text-sm">$</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={defaultRate}
              onChange={(e) => setDefaultRate(e.target.value)}
              placeholder="0.00"
                  className="w-24 rounded-md border border-input-border bg-input-bg px-2 py-1.5 text-sm text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          </div>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-sm font-medium rounded bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 cursor-pointer"
          >
            {saving ? "Saving..." : "Add"}
          </button>
          <button
            onClick={() => {
              onClose();
              setError(null);
            }}
            className="px-3 py-1.5 text-sm font-medium rounded text-on-surface-secondary hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BillingRatesView({
  lawFirmId,
  chargeCodes,
  users,
  isLoading,
  onRefresh,
}: BillingRatesViewProps) {
  const { hasPermission } = usePermissions();
  const canManageRates = hasPermission("billing.manageRates");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [memberQuery, setMemberQuery] = useState("");
  const [showAllMembers, setShowAllMembers] = useState(false);
  const [chargeCodeQuery, setChargeCodeQuery] = useState("");
  const [addingChargeCode, setAddingChargeCode] = useState(false);
  const [showAllChargeCodes, setShowAllChargeCodes] = useState(false);
  // Keyed by charge code: each expanded code caps its own override list, so
  // opening one does not un-cap the others.
  const [expandedOverrideIds, setExpandedOverrideIds] = useState<Set<string>>(new Set());

  const toggleOverrides = useCallback((id: string) => {
    setExpandedOverrideIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleUpdateDefaultRate = useCallback(
    async (chargeCodeId: string, rate: number | null) => {
      await billingService.updateChargeCode(lawFirmId, chargeCodeId, {
        defaultRate: rate,
      });
      onRefresh();
    },
    [lawFirmId, onRefresh]
  );

  const handleUpdateMemberRate = useCallback(
    async (
      chargeCode: ChargeCode,
      userId: string,
      rate: number | null
    ) => {
      const currentRates = { ...(chargeCode.memberRates || {}) };
      if (rate === null) {
        delete currentRates[userId];
      } else {
        currentRates[userId] = rate;
      }
      await billingService.updateChargeCode(lawFirmId, chargeCode.id, {
        memberRates: currentRates,
      });
      onRefresh();
    },
    [lawFirmId, onRefresh]
  );

  const activeChargeCodes = useMemo(
    () => chargeCodes.filter((cc) => cc.isActive),
    [chargeCodes]
  );

  const filteredUsers = useMemo(
    () => users.filter((user) => memberMatches(user, memberQuery)),
    [users, memberQuery]
  );
  const renderMemberRateRow = (user: User) => (
    <div key={user.uid} className="flex items-center justify-between px-4 py-2.5 hover:bg-surface-hover transition-colors">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-xs font-semibold text-blue-700 dark:text-blue-300">
          {memberLabel(user).charAt(0).toUpperCase()}
        </div>
        <span className="text-base text-on-surface">
          {highlightText(memberLabel(user), memberQuery)}
        </span>
      </div>
      <RateInput
        value={user.defaultHourlyRate ?? null}
        onSave={(rate) => handleUpdateMemberDefaultRate(user.uid, rate)}
        placeholder="Not set"
        readOnly={!canManageRates}
      />
    </div>
  );

  const filteredChargeCodes = useMemo(() => {
    const term = chargeCodeQuery.trim().toLowerCase();
    if (!term) return activeChargeCodes;
    return activeChargeCodes.filter((cc) =>
      `${cc.code} ${cc.name}`.toLowerCase().includes(term)
    );
  }, [activeChargeCodes, chargeCodeQuery]);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5001/api";

  const handleUpdateMemberDefaultRate = useCallback(
    async (userId: string, rate: number | null) => {
      const token = await getFirebaseToken();
      await apiFetch(`${API_URL}/lawfirms/${lawFirmId}/members/${userId}/default-hourly-rate`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ defaultHourlyRate: rate }),
      });
      onRefresh();
    },
    [lawFirmId, onRefresh, API_URL]
  );

  const renderChargeCodeRow = (cc: ChargeCode) => {
    const isExpanded = expandedIds.has(cc.id);
    const overridesExpanded = expandedOverrideIds.has(cc.id);
    const renderOverrideRow = (user: User) => {
      const memberRate =
        cc.memberRates?.[user.uid] ?? null;
      return (
        <div
          key={user.uid}
          className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-surface-hover"
        >
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-xs font-semibold text-blue-700 dark:text-blue-300">
              {memberLabel(user).charAt(0).toUpperCase()}
            </div>
            <span className="text-sm text-on-surface">
              {memberLabel(user)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {memberRate === null &&
              cc.defaultRate != null && (
                <span className="text-xs text-on-surface-muted">
                  Using default:{" "}
                  {formatCurrency(cc.defaultRate)}/hr
                </span>
              )}
            <RateInput
              value={memberRate}
              onSave={(rate) =>
                handleUpdateMemberRate(
                  cc,
                  user.uid,
                  rate
                )
              }
              placeholder="Use default"
              readOnly={!canManageRates}
            />
          </div>
        </div>
      );
    };
    const memberOverrideCount = Object.keys(
      cc.memberRates || {}
    ).length;

    return (
      <div
        key={cc.id}
        className="border border-outline rounded-lg bg-surface overflow-hidden"
      >
        {/* Main row */}
        <div className="flex items-center gap-4 px-4 py-3">
          <button
            onClick={() => toggleExpand(cc.id)}
            className="flex-shrink-0 text-on-surface-muted hover:text-on-surface cursor-pointer"
          >
            <ChevronRight
              className="w-4 h-4 transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
              style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
            />
          </button>

          <StatusBadge variant="info">
            <span className="font-mono font-semibold">
              {highlightText(cc.code, chargeCodeQuery)}
            </span>
          </StatusBadge>

          <span className="flex-1 text-base font-medium text-on-surface">
            {highlightText(cc.name, chargeCodeQuery)}
          </span>

          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-on-surface-muted">
              Default:
            </span>
            <RateInput
              value={cc.defaultRate}
              onSave={(rate) =>
                handleUpdateDefaultRate(cc.id, rate)
              }
              readOnly={!canManageRates}
            />
          </div>

          {memberOverrideCount > 0 && (
            <span className="flex-shrink-0 text-xs text-on-surface-muted">
              {memberOverrideCount} member{" "}
              {memberOverrideCount === 1
                ? "override"
                : "overrides"}
            </span>
          )}
        </div>

        {/* Expanded member rates */}
        <div
          className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
          style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}
        >
        <div className="overflow-hidden">
          <div className="border-t border-outline bg-surface-alt px-4 py-3">
            <p className="text-xs font-medium text-on-surface-muted mb-3 uppercase tracking-wide">
              Member Rate Overrides
            </p>
            <CollapsibleList
              items={users}
              previewLimit={LIST_PREVIEW_LIMIT}
              expanded={overridesExpanded}
              renderItem={renderOverrideRow}
              className="space-y-1"
              trailing={
                users.length === 0 ? (
                  <p className="text-sm text-on-surface-muted py-2">
                    No firm members found.
                  </p>
                ) : null
              }
            />
            <ShowMoreButton
              expanded={overridesExpanded}
              hiddenCount={users.length - LIST_PREVIEW_LIMIT}
              onToggle={() => toggleOverrides(cc.id)}
            />
          </div>
        </div>
        </div>
      </div>
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner size={24} className="text-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* ── Member Default Rates ─────────────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <UserIcon className="w-4 h-4 text-on-surface-muted" />
          <h3 className="text-sm font-semibold text-on-surface">Member Default Rates</h3>
        </div>
        <p className="text-sm text-on-surface-secondary mb-4">
          Firm-wide default hourly rate per team member. Used when no matter, client, or charge code rate applies.
        </p>
        {users.length > LIST_PREVIEW_LIMIT && (
          <RateSearchInput
            value={memberQuery}
            onChange={(next) => {
              setMemberQuery(next);
              setShowAllMembers(false);
            }}
            placeholder="Search members by name or email"
            label="Search firm members"
          />
        )}
        <div className="border border-outline rounded-lg bg-surface overflow-hidden">
          <CollapsibleList
            items={filteredUsers}
            previewLimit={LIST_PREVIEW_LIMIT}
            expanded={showAllMembers}
            renderItem={renderMemberRateRow}
            className="space-y-0 divide-y divide-outline-subtle"
            trailing={
              filteredUsers.length === 0 ? (
                <p className="text-sm text-on-surface-muted px-4 py-4">
                  {users.length === 0
                    ? "No firm members found."
                    : "No members match this search."}
                </p>
              ) : null
            }
          />
        </div>
        <ShowMoreButton
          expanded={showAllMembers}
          hiddenCount={filteredUsers.length - LIST_PREVIEW_LIMIT}
          onToggle={() => setShowAllMembers((prev) => !prev)}
        />
      </div>

      {/* ── Charge Codes ─────────────────────────────────────────────────── */}
      <div>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <DollarSign className="w-4 h-4 text-on-surface-muted" />
            <h3 className="text-sm font-semibold text-on-surface">Charge Code Rates</h3>
          </div>
          <p className="text-sm text-on-surface-secondary">
            {activeChargeCodes.length} charge{" "}
            {activeChargeCodes.length === 1 ? "code" : "codes"} with rate
            configuration
          </p>
        </div>
        {canManageRates && (
          <Button
            type="secondary"
            size="small"
            onClick={() => setAddingChargeCode(true)}
            disabled={addingChargeCode}
            icon={<Plus className="w-4 h-4" />}
            className="flex-shrink-0"
          >
            Add Charge Code
          </Button>
        )}
      </div>

      {activeChargeCodes.length > LIST_PREVIEW_LIMIT && (
        <RateSearchInput
          value={chargeCodeQuery}
          onChange={(next) => {
            setChargeCodeQuery(next);
            setShowAllChargeCodes(false);
          }}
          placeholder="Search charge codes by code or name"
          label="Search charge codes"
        />
      )}

      {addingChargeCode && (
        <AddChargeCodeForm
          lawFirmId={lawFirmId}
          onRefresh={onRefresh}
          onClose={() => setAddingChargeCode(false)}
          className="mb-3"
        />
      )}

      {activeChargeCodes.length === 0 ? (
        <div className="text-center py-12 text-on-surface-secondary">
          <DollarSign className="w-10 h-10 mx-auto mb-3 text-on-surface-muted" />
          <p className="mb-1">No charge codes configured yet.</p>
          <p className="text-sm">
            Add charge codes to configure billing rates per activity type.
          </p>
        </div>
      ) : filteredChargeCodes.length === 0 ? (
        <p className="text-sm text-on-surface-muted py-4">
          No charge codes match this search.
        </p>
      ) : (
        <CollapsibleList
          items={filteredChargeCodes}
          previewLimit={LIST_PREVIEW_LIMIT}
          expanded={showAllChargeCodes}
          renderItem={renderChargeCodeRow}
          className="space-y-2"
        />
      )}

      <ShowMoreButton
        expanded={showAllChargeCodes}
        hiddenCount={filteredChargeCodes.length - LIST_PREVIEW_LIMIT}
        onToggle={() => setShowAllChargeCodes((prev) => !prev)}
      />

      </div>
    </div>
  );
}
