"use client";

import type { ReactNode } from "react";
import dayjs from "dayjs";
import { Trash2 } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import ConfirmAction from "@/components/ui/ConfirmAction";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import DatePicker from "@/components/ui/DatePicker";
import Dropdown, { type DropdownOption } from "@/components/ui/Dropdown";
import Spinner from "@/components/ui/Spinner";
import StatusBadge from "@/components/ui/StatusBadge";
import { formatCurrency } from "@/components/billingComp/utils";

export interface FlatFeeDraft {
  id: string;
  description: string;
  amount: number;
  date?: string | null;
}

interface FlatFeeEditorRowProps {
  fee: FlatFeeDraft;
  onChange: (fee: FlatFeeDraft) => void;
  onSave: () => void;
  onDiscard: () => void;
  saving?: boolean;
  /** "Save" for an in-place edit of an already-saved fee, "Done" for a new one. */
  saveLabel?: string;
  /** "button" renders a Cancel button (editing a saved fee); "trash" renders a
   *  trash icon (discarding a not-yet-saved fee). */
  discardAs?: "button" | "trash";
  /** True while a discard is in flight. Only a saved fee round trips to the
   *  server, so a row for a fee that exists only in the browser never sets it. */
  deleting?: boolean;
  /** Renders a leading checkbox. The generate-invoice surfaces pick which fees
   *  go on the invoice they are building; the billing tabs just list them. */
  select?: {
    checked: boolean;
    onChange: (checked: boolean) => void;
  };
  /** Optional matter picker under the inputs. A fee belongs to either a matter or a
   *  client, never both, so choosing a matter records the fee on that matter instead;
   *  an empty value keeps it a direct client fee. */
  matterLink?: {
    value: string;
    options: DropdownOption[];
    onChange: (matterId: string) => void;
    placeholder?: string;
    note?: string;
  };
}

/** The fused description | $amount | date input cluster, shared by the "new flat fee"
 *  row and the "edit saved flat fee" row on every billing surface. */
export function FlatFeeEditorRow({
  fee,
  onChange,
  onSave,
  onDiscard,
  saving,
  saveLabel = "Save",
  discardAs = "button",
  deleting,
  select,
  matterLink,
}: FlatFeeEditorRowProps) {
  const canSave = fee.description.trim().length > 0 && fee.amount > 0 && !saving;

  return (
    <div className="p-3 border border-outline rounded-lg bg-surface min-w-0">
      <div className="flex gap-3 items-center min-w-0">
        {select && (
          <Checkbox checked={select.checked} onChange={select.onChange} />
        )}
        <div className="fused-field-group flex-1 flex flex-col overflow-hidden rounded-md border border-input-border bg-input-bg divide-y divide-outline-subtle transition-shadow duration-150 focus-within:ring-2 focus-within:ring-focus-ring sm:flex-row sm:items-stretch sm:divide-x sm:divide-y-0">
          <input
            type="text"
            value={fee.description}
            onChange={(e) => onChange({ ...fee, description: e.target.value })}
            placeholder="Description (e.g. Filing Fee)"
            className="flex-1 min-w-0 px-4 py-3 text-sm bg-transparent text-on-surface placeholder:text-on-surface-muted focus:outline-none"
          />
          <div className="relative flex items-center w-full sm:w-36 sm:shrink-0">
            <span className="absolute left-3.5 text-xs font-bold text-on-surface-muted select-none">$</span>
            <input
              type="number"
              value={fee.amount || ""}
              onChange={(e) => onChange({ ...fee, amount: parseFloat(e.target.value) || 0 })}
              placeholder="0.00"
              min="0"
              step="0.01"
              className="w-full pl-7 pr-3 py-3 text-sm bg-transparent text-on-surface placeholder:text-on-surface-muted focus:outline-none"
            />
          </div>
          <DatePicker
            value={fee.date || ""}
            onChange={(value) => onChange({ ...fee, date: value })}
            className="w-full sm:w-40 sm:shrink-0"
            aria-label="Flat fee date"
            bare
          />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button type="primary" size="small" onClick={onSave} loading={saving} disabled={!canSave}>
            {saveLabel}
          </Button>
          {discardAs === "button" ? (
            <Button type="secondary" size="small" onClick={onDiscard} disabled={saving}>
              Cancel
            </Button>
          ) : (
            <Tooltip title="Remove flat fee" enterDelay={300}>
              <span>
                <button
                  aria-label="Remove flat fee"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onDiscard();
                  }}
                  disabled={deleting}
                  className="cursor-pointer p-2 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {deleting ? <Spinner size={16} /> : <Trash2 className="w-4 h-4" />}
                </button>
              </span>
            </Tooltip>
          )}
        </div>
      </div>
      {matterLink && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-on-surface-muted">Matter</span>
          <Dropdown
            value={matterLink.value}
            onChange={matterLink.onChange}
            options={matterLink.options}
            placeholder={matterLink.placeholder || "No matter (direct client fee)"}
            ariaLabel="Link flat fee to a matter"
            className="w-72"
          />
          {matterLink.note && (
            <span className="text-xs text-on-surface-muted">{matterLink.note}</span>
          )}
        </div>
      )}
    </div>
  );
}

interface FlatFeeSavedRowProps {
  fee: FlatFeeDraft;
  onEdit?: () => void;
  onDelete?: () => void | Promise<void>;
  deleting?: boolean;
  /** True while another row on the list is mid-edit. */
  disabled?: boolean;
  /** Extra context chip(s), e.g. the client tab's matter-linkage badge. */
  badge?: ReactNode;
}

/** The read-only saved flat fee row: description · Unbilled badge · amount · date · Edit/Delete. */
export function FlatFeeSavedRow({ fee, onEdit, onDelete, deleting, disabled, badge }: FlatFeeSavedRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 p-3 border border-outline rounded-lg bg-surface min-w-0">
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm font-medium text-on-surface break-words">{fee.description}</span>
          <StatusBadge variant="success">Unbilled</StatusBadge>
          {badge}
          <span className="text-sm text-on-surface-secondary shrink-0">{formatCurrency(fee.amount)}</span>
          {fee.date && (
            <span className="text-xs text-on-surface-muted shrink-0">
              {dayjs(fee.date).format("MMM DD, YYYY")}
            </span>
          )}
        </div>
      </div>
      {(onEdit || onDelete) && (
        <div className="flex items-center gap-1 shrink-0">
          {onEdit && (
            <Button onClick={onEdit} type="secondary" size="small" disabled={disabled}>
              Edit
            </Button>
          )}
          {onDelete && (
            <ConfirmAction title="Remove Flat Fee" message={`Remove "${fee.description}" (${formatCurrency(fee.amount)})? This deletes the saved flat fee.`} onConfirm={onDelete} stacked>
              {(request, busy) => (
                <Tooltip title="Remove flat fee" enterDelay={300}>
                  <span>
                    <button
                      aria-label="Remove flat fee"
                      onClick={request}
                      disabled={deleting || busy}
                      className="p-2 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {deleting ? <Spinner size={16} /> : <Trash2 className="w-4 h-4" />}
                    </button>
                  </span>
                </Tooltip>
              )}
            </ConfirmAction>
          )}
        </div>
      )}
    </div>
  );
}
