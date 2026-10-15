export type SectionLabelTone = "muted" | "secondary" | "inherit";
export type SectionLabelGap = "0" | "1" | "1.5" | "2" | "3" | "4";
export type SectionLabelAs = "p" | "span" | "h4";

/**
 * The class string a section eyebrow renders.
 *
 * The three axes below are not invented: they are what the 101 hand-written
 * copies already varied by. Sixteen of the twenty spellings found were the same
 * classes in a different order (`text-on-surface-muted uppercase tracking-[0.1em]`
 * against `uppercase tracking-[0.1em] text-on-surface-muted`), which renders
 * identically and reads as four different house styles to whoever copies next.
 */
export function sectionLabelClass({
  tone = "muted",
  gap = "0",
  className = "",
}: {
  tone?: SectionLabelTone;
  gap?: SectionLabelGap;
  className?: string;
} = {}): string {
  // Spelled out per branch: Tailwind v4 scans source text, so an interpolated
  // class name never reaches the stylesheet.
  const base =
    tone === "muted"
      ? "text-[10px] font-semibold text-on-surface-muted uppercase tracking-[0.1em]"
      : tone === "secondary"
        ? "text-[10px] font-semibold text-on-surface-secondary uppercase tracking-[0.1em]"
        : "text-[10px] font-semibold uppercase tracking-[0.1em]";

  const margin =
    gap === "1" ? " mb-1"
      : gap === "1.5" ? " mb-1.5"
        : gap === "2" ? " mb-2"
          : gap === "3" ? " mb-3"
            : gap === "4" ? " mb-4"
              : "";

  return className ? `${base}${margin} ${className}` : `${base}${margin}`;
}

interface SectionLabelProps {
  /**
   * `p` by default, which is what 93 of the 101 sites used. `h4` where the label
   * genuinely heads a section for a screen reader; `span` where it sits inline.
   * The element is a prop rather than fixed because changing it would alter the
   * document outline, not just the look.
   */
  as?: SectionLabelAs;
  /** `inherit` takes the surrounding colour, for a label on a coloured surface. */
  tone?: SectionLabelTone;
  /** Gap beneath the label. `0` for one whose parent already spaces it. */
  gap?: SectionLabelGap;
  /** Extra classes, appended. Layout only: padding, `flex items-center gap-1.5`, `shrink-0`. */
  className?: string;
  children: React.ReactNode;
}

/**
 * The small uppercase label above a group of fields or a panel section.
 *
 * Not a form field label: that is `FieldLabel`, which is larger, sentence case,
 * and points at one control. This one names a region and points at nothing.
 */
export default function SectionLabel({
  as: Tag = "p",
  tone = "muted",
  gap = "0",
  className = "",
  children,
}: SectionLabelProps) {
  return <Tag className={sectionLabelClass({ tone, gap, className })}>{children}</Tag>;
}
