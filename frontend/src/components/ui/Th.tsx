export type ThAlign = "left" | "right";

/**
 * The class string a header cell renders. Exported so `SortableTh` can build on
 * the same metrics instead of restating them: a sortable column and a plain one
 * sitting in the same header row must line up to the pixel.
 */
export function thClass(align: ThAlign = "left", className = ""): string {
  // Spelled out rather than interpolated: Tailwind v4 scans source text, so a
  // `text-${align}` template would never reach the stylesheet.
  const base =
    align === "right"
      ? "text-right px-5 py-3 font-medium text-on-surface-secondary text-xs uppercase tracking-wide"
      : "text-left px-5 py-3 font-medium text-on-surface-secondary text-xs uppercase tracking-wide";
  return className ? `${base} ${className}` : base;
}

interface ThProps extends Omit<React.ComponentPropsWithRef<"th">, "className"> {
  /** `right` for a numeric column, so figures align on their last digit. */
  align?: ThAlign;
  className?: string;
  children: React.ReactNode;
}

/**
 * A non-sortable table header cell.
 *
 * The missing half of a pair: `SortableTh` already existed for columns a reader
 * can order by, while the plain ones were written out at 26 call sites. A header
 * row usually mixes both, so the two have to agree on padding, weight and case.
 */
export default function Th({ align = "left", className = "", children, ...rest }: ThProps) {
  return (
    <th {...rest} className={thClass(align, className)}>
      {children}
    </th>
  );
}
