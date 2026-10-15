"use client";

import { useState, type ReactNode } from "react";
import { useMountTransition } from "@/hooks/useMountTransition";
import { menuAnim } from "@/components/ui/transitionClasses";
import { FIELD_LABEL_BLOCK_CLS } from "@/components/ui/inputClasses";
import { formatCurrency } from "@/lib/utils/currency";
import {
  RATE_SOURCE_OPTION_LABEL,
  rateSourceLabel,
  type RateOption,
  type RateSource,
} from "@/lib/billing/resolveRate";

export type { RateOption };

interface RateFieldProps {
  /** The rate the user sees, as typed. Empty means "use the resolved default". */
  value: string;
  /** Fired when the field is typed into. The caller marks the rate manual. */
  onChange: (value: string) => void;
  /** Fired when a row in the picker is chosen, with the option's label. */
  onPick: (rate: number, label: string) => void;
  /** Rate the rate ladder resolves to, shown as the placeholder. */
  resolvedRate: number | null;
  /** The ladder tier that produced `resolvedRate`, verbatim from `resolveRate`. */
  rateSource: RateSource | null;
  /** True once the user has typed or picked a rate, which overrides the ladder. */
  hasManualRate: boolean;
  /** Every rate available for this member, offered by the picker. */
  availableRates: RateOption[];
  /** Draw the amber treatment: no rate is resolvable and the entry needs one. */
  warn?: boolean;
  /** Extra block inside the field box, under a divider (used for a rate preview). */
  footer?: ReactNode;
  label?: string;
}

/**
 * The hourly-rate control for a time entry: a currency input, the name of the
 * rate rule behind it, and a menu of every other rate that applies.
 *
 * The input stays authoritative. The picker only writes a number into it, so
 * "which rate is this" is always answerable by reading the field.
 */
export default function RateField({
  value,
  onChange,
  onPick,
  resolvedRate,
  rateSource,
  hasManualRate,
  availableRates,
  warn = false,
  footer,
  label = "Rate",
}: RateFieldProps) {
  const [open, setOpen] = useState(false);
  const [pickedLabel, setPickedLabel] = useState<string | null>(null);
  const { mounted, exiting } = useMountTransition(open, 150);

  // Which menu row reads as current. An explicit pick wins; otherwise the
  // resolved source names it; otherwise fall back to matching on the number,
  // and only when exactly one option carries it (two rates can be equal).
  function isActiveOption(option: RateOption): boolean {
    if (pickedLabel) return option.label === pickedLabel;
    if (!hasManualRate && rateSource) {
      const target = RATE_SOURCE_OPTION_LABEL[rateSource];
      if (target === "Charge code") return option.label.startsWith("Charge code");
      return option.label === target;
    }
    const current = parseFloat(value);
    if (!Number.isFinite(current)) return false;
    const matches = availableRates.filter((o) => Math.abs(o.rate - current) < 0.01);
    return matches.length === 1 && matches[0].label === option.label;
  }

  return (
    <div>
      <label className={FIELD_LABEL_BLOCK_CLS}>{label}</label>
      <div
        className={`space-y-2 rounded-lg border px-3 py-2 ${
          warn
            ? "border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20"
            : "border-outline"
        }`}
      >
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-muted pointer-events-none">
            $
          </span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              setPickedLabel(null);
            }}
            placeholder={typeof resolvedRate === "number" ? resolvedRate.toFixed(2) : "No rate"}
            className="w-full rounded-md border border-input-border bg-input-bg pl-7 pr-3 py-2 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
        </div>

        <div className="relative flex items-center gap-2">
          <p className="text-xs text-on-surface-muted">
            {hasManualRate ? "Custom rate" : rateSourceLabel(rateSource) || "No default rate found"}
          </p>
          {availableRates.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                className="text-xs font-medium text-accent-emphasis hover:underline cursor-pointer"
              >
                Change rate
              </button>
              {mounted && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
                  <div
                    className={`absolute top-6 left-0 z-50 w-72 overflow-hidden rounded-lg border border-outline bg-surface shadow-lg origin-top ${menuAnim(exiting)}`}
                  >
                    <div className="border-b border-outline px-3 py-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-on-surface-secondary">
                        Available rates
                      </p>
                    </div>
                    <div className="divide-y divide-outline-subtle">
                      {availableRates.map((option) => {
                        const active = isActiveOption(option);
                        return (
                          <button
                            key={option.label}
                            type="button"
                            onClick={() => {
                              onPick(option.rate, option.label);
                              setPickedLabel(option.label);
                              setOpen(false);
                            }}
                            className={`flex w-full items-center justify-between px-3 py-2.5 text-sm transition-colors hover:bg-surface-hover cursor-pointer ${
                              active ? "bg-blue-50 dark:bg-blue-900/20" : ""
                            }`}
                          >
                            <span
                              className={`font-medium ${active ? "text-accent-emphasis" : "text-on-surface"}`}
                            >
                              {option.label}
                            </span>
                            <span
                              className={`font-mono text-sm ${active ? "text-accent-emphasis" : "text-on-surface-secondary"}`}
                            >
                              {formatCurrency(option.rate)}/hr
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {footer ? <div className="border-t border-outline pt-2">{footer}</div> : null}
      </div>
    </div>
  );
}
