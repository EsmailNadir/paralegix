"use client";

// Presentational pieces for the template library. No data fetching and no
// side effects: TemplateList owns state and passes everything in.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown } from "lucide-react";
import {
  FIELD_GROUPS,
  type FieldGroupKey,
  type FieldSummary,
} from "./template-field-summary";

const gc = (key: FieldGroupKey) => `var(--g-${key})`;

/** True once the element has been on screen; drives the bar and ring fill-in. */
export function useSeen<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- no observer to subscribe to (older browsers, tests), so the card counts as seen at once
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.2 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

/** A tiny stylized page; placeholder lines are tinted by the template's field groups. */
export function PaperThumb({ summary, back = false }: { summary: FieldSummary; back?: boolean }) {
  // 9 lines; the first few that carry fields take the group colors in order.
  const colors = summary.groups.flatMap((g) => Array(Math.min(g.count, 2)).fill(g.key) as FieldGroupKey[]);
  const widths = [92, 70, 84, 100, 64, 88, 76, 96, 58];
  const fieldSlots = new Set([1, 3, 4, 6, 7]);
  let c = 0;
  return (
    <div className={`tp-sheet ${back ? "is-back" : ""}`} aria-hidden>
      <div className="tp-sheet-title" />
      {widths.map((w, i) => {
        const isField = !back && fieldSlots.has(i) && c < colors.length;
        const key = isField ? colors[c++] : null;
        return (
          <div
            key={i}
            className={`tp-line ${isField ? "is-field" : ""}`}
            style={{ width: `${w}%`, ...(key ? ({ "--fc": gc(key) } as CSSProperties) : {}) }}
          />
        );
      })}
    </div>
  );
}

/** One segmented bar: a segment per field group, sized by count. Replaces the tag wall. */
export function FieldStrip({ summary, label }: { summary: FieldSummary; label?: string }) {
  if (summary.total === 0) return null;
  return (
    <div
      className="tp-strip"
      role="img"
      aria-label={
        label ??
        summary.groups.map((g) => `${g.count} ${FIELD_GROUPS[g.key].label}`).join(", ")
      }
    >
      {summary.groups.map((g, i) => (
        <i
          key={g.key}
          className={g.key === "custom" ? "is-custom" : undefined}
          title={`${FIELD_GROUPS[g.key].label}: ${g.count}`}
          style={{ "--n": g.count, "--gc": gc(g.key), "--d": `${i * 0.06}s` } as CSSProperties}
        />
      ))}
    </div>
  );
}

export function FieldLegend({ summary }: { summary: FieldSummary }) {
  return (
    <div className="tp-legend">
      {summary.groups.map((g) => (
        <span
          key={g.key}
          className={g.key === "custom" ? "is-custom" : undefined}
          style={{ "--gc": gc(g.key) } as CSSProperties}
          title={FIELD_GROUPS[g.key].hint}
        >
          <i aria-hidden />
          {FIELD_GROUPS[g.key].label} <b>{g.count}</b>
        </span>
      ))}
    </div>
  );
}

/** Ring showing how many fields fill themselves once a case is picked. */
export function AutofillRing({ summary }: { summary: FieldSummary }) {
  if (summary.total === 0) return null;
  const C = 113.1; // 2πr, r = 18
  const pct = summary.autoCount / summary.total;
  return (
    <div className="tp-ring" title={`${summary.autoCount} of ${summary.total} fields fill in automatically`}>
      <div className="tp-ring-label">
        <b>
          {summary.autoCount}/{summary.total}
        </b>
        <span>auto-fill</span>
      </div>
      <svg viewBox="0 0 46 46" aria-hidden>
        <circle className="bg" cx="23" cy="23" r="18" />
        <circle className="fg" cx="23" cy="23" r="18" style={{ "--off": `${C * (1 - pct)}` } as CSSProperties} />
      </svg>
    </div>
  );
}

/** The plain-language line under the strip. */
export function TypeNote({ summary }: { summary: FieldSummary }) {
  if (summary.total === 0) {
    return <p className="tp-type-note">No fields yet. Add placeholders in the editor.</p>;
  }
  if (summary.typeCount === 0) {
    return (
      <p className="tp-type-note is-zero">
        <b>Nothing to type.</b> Pick a case and every field fills in.
      </p>
    );
  }
  const custom = summary.fields.filter((f) => !f.auto);
  const names = custom.slice(0, 2).map((f) => f.label);
  const rest = custom.length - names.length;
  return (
    <p className="tp-type-note">
      You&apos;ll type <b>{summary.typeCount}</b>: {names.join(", ")}
      {rest > 0 ? ` +${rest} more` : ""}.
    </p>
  );
}

/** Collapsible, grouped field list: each field's readable name, with the tags it stands for shown small. */
export function FieldList({
  summary,
  open,
  onToggle,
  highlight,
  id,
}: {
  summary: FieldSummary;
  open: boolean;
  onToggle: () => void;
  highlight?: string;
  id: string;
}) {
  if (summary.total === 0) return null;
  const q = highlight?.toLowerCase() ?? "";
  return (
    <>
      <button type="button" className="tp-more" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        {open ? "Hide fields" : `See all ${summary.total} fields`}
        <ChevronDown aria-hidden />
      </button>
      <div className="tp-fields" id={id} data-open={open} inert={!open} aria-hidden={!open}>
        <div>
          <div className="tp-fields-inner">
            {summary.groups.map((g) => (
              <div key={g.key} style={{ "--gc": gc(g.key) } as CSSProperties}>
                <div className="tp-fgroup-head">
                  <i aria-hidden />
                  {FIELD_GROUPS[g.key].label}
                  <span>· {FIELD_GROUPS[g.key].hint}</span>
                </div>
                {g.fields.map((f) => {
                  const hit = q && [f.label, ...f.tags].some((v) => v.toLowerCase().includes(q));
                  return (
                    <div key={f.label} className={`tp-frow ${hit ? "is-hit" : ""}`}>
                      <span>{f.label}</span>
                      <code title={f.tags.join(", ")}>{f.tags.join(", ")}</code>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
