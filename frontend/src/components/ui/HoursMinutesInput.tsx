"use client";

import { Plus, Minus } from "lucide-react";

interface HoursMinutesInputProps {
  hours: string;
  minutes: string;
  onHoursChange: (value: string) => void;
  onMinutesChange: (value: string) => void;
  /** Amount added/removed by the hours +/- buttons. Default 1. */
  hourStep?: number;
  /** Amount added/removed by the minutes +/- buttons. Default 5. */
  minuteStep?: number;
  /** Vertical padding on the inputs. "md" (default) matches most modals; "sm" is tighter for dense rows. */
  size?: "sm" | "md";
  /**
   * Render the 10m/15m/30m/1h chips under the inputs. Each chip *adds* to the
   * current duration, so tapping 15m twice reads 30m.
   */
  quickPicks?: boolean;
  className?: string;
}

/** The increments the quick-pick chips offer, in bar order. */
const QUICK_PICKS = [
  { label: "10m", h: 0, m: 10 },
  { label: "15m", h: 0, m: 15 },
  { label: "30m", h: 0, m: 30 },
  { label: "1h", h: 1, m: 0 },
] as const;

/**
 * Paired hours/minutes number inputs with custom plus/minus steppers.
 * The minutes stepper carries into hours: stepping past 59 rolls over (adds an hour) and
 * stepping below 0 borrows from hours, floored at 0h 0m overall. Hours are floored at 0.
 * A blank value is treated as 0, and stepping back down to 0 clears the field.
 * With `quickPicks`, chips below the inputs add fixed increments to the total.
 */
export default function HoursMinutesInput({
  hours,
  minutes,
  onHoursChange,
  onMinutesChange,
  hourStep = 1,
  minuteStep = 5,
  size = "md",
  quickPicks = false,
  className = "",
}: HoursMinutesInputProps) {
  const inputPadY = size === "sm" ? "py-1.5" : "py-2.5 md:py-2";

  const stepHours = (delta: number) => {
    const current = parseInt(hours, 10) || 0;
    const next = Math.max(0, current + delta);
    onHoursChange(next > 0 ? String(next) : "");
  };

  const stepMinutes = (delta: number) => {
    const h = parseInt(hours, 10) || 0;
    const m = parseInt(minutes, 10) || 0;
    const total = Math.max(0, h * 60 + m + delta);
    const nextH = Math.floor(total / 60);
    const nextM = total % 60;
    onHoursChange(nextH > 0 ? String(nextH) : "");
    onMinutesChange(nextM > 0 ? String(nextM) : "");
  };

  // Fold a typed-in minutes value of 60+ back into hours when the field is left.
  const normalizeMinutes = () => {
    const m = parseInt(minutes, 10) || 0;
    if (m < 60) return;
    const h = parseInt(hours, 10) || 0;
    const total = h * 60 + m;
    const nextH = Math.floor(total / 60);
    const nextM = total % 60;
    onHoursChange(nextH > 0 ? String(nextH) : "");
    onMinutesChange(nextM > 0 ? String(nextM) : "");
  };

  const stepperBtn =
    "flex w-8 shrink-0 items-center justify-center text-on-surface-muted hover:text-on-surface hover:bg-surface-hover active:scale-90 transition cursor-pointer";
  const groupCls =
    "fused-field-group flex flex-1 min-w-0 items-stretch rounded-md border border-input-border bg-input-bg overflow-hidden focus-within:ring-2 focus-within:ring-focus-ring transition-shadow";
  // The unit sits in normal flow rather than absolutely over the input, so a narrow
  // group (a half-width modal column) spends no width on padding reserved for it.
  const fieldCls = "flex flex-1 min-w-0 items-center pl-1 pr-1.5";
  const inputCls = `w-full min-w-0 border-0 bg-transparent ${inputPadY} text-center text-sm text-on-surface focus:outline-none focus-visible:ring-0`;
  const unitCls = "shrink-0 pl-0.5 text-xs text-on-surface-muted";

  const addQuickTime = (h: number, m: number) => {
    const currentH = parseInt(hours, 10) || 0;
    const currentM = parseInt(minutes, 10) || 0;
    const totalM = currentM + m;
    const nextH = currentH + h + Math.floor(totalM / 60);
    const nextM = totalM % 60;
    onHoursChange(nextH > 0 ? String(nextH) : "");
    onMinutesChange(nextM > 0 ? String(nextM) : "");
  };

  return (
    <div className={className}>
    <div className="flex items-center gap-2">
      <div className={groupCls}>
        <button type="button" onClick={() => stepHours(-hourStep)} aria-label="Decrease hours" className={stepperBtn}>
          <Minus size={15} strokeWidth={2.4} />
        </button>
        <div className={fieldCls}>
          <input
            type="number"
            min="0"
            step="1"
            value={hours}
            onChange={(e) => onHoursChange(e.target.value)}
            placeholder="0"
            className={inputCls}
          />
          <span className={unitCls}>h</span>
        </div>
        <button type="button" onClick={() => stepHours(hourStep)} aria-label="Increase hours" className={stepperBtn}>
          <Plus size={15} strokeWidth={2.4} />
        </button>
      </div>
      <div className={groupCls}>
        <button type="button" onClick={() => stepMinutes(-minuteStep)} aria-label="Decrease minutes" className={stepperBtn}>
          <Minus size={15} strokeWidth={2.4} />
        </button>
        <div className={fieldCls}>
          <input
            type="number"
            min="0"
            max="59"
            step="1"
            value={minutes}
            onChange={(e) => onMinutesChange(e.target.value)}
            onBlur={normalizeMinutes}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                normalizeMinutes();
              }
            }}
            placeholder="0"
            className={inputCls}
          />
          <span className={unitCls}>m</span>
        </div>
        <button type="button" onClick={() => stepMinutes(minuteStep)} aria-label="Increase minutes" className={stepperBtn}>
          <Plus size={15} strokeWidth={2.4} />
        </button>
      </div>
    </div>
    {quickPicks && (
      <div className="mt-2 flex flex-wrap gap-1.5">
        {QUICK_PICKS.map(({ label, h, m }) => (
          <button
            key={label}
            type="button"
            onClick={() => addQuickTime(h, m)}
            className="rounded-full border border-outline px-2.5 py-1 text-xs text-on-surface-secondary transition-[color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:text-on-surface cursor-pointer"
          >
            {label}
          </button>
        ))}
      </div>
    )}
    </div>
  );
}
