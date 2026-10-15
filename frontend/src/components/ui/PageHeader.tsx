import React from "react";
import SectionLabel from "@/components/ui/SectionLabel";

interface PageHeaderProps {
  /** Small uppercase label shown above the title (e.g. "Matter Management"). */
  eyebrow?: string;
  /** The page title. */
  title: React.ReactNode;
  /** One-line description / subtitle shown under the title. */
  description?: React.ReactNode;
  /** Right-aligned action buttons (primary CTA, menus, etc.). */
  actions?: React.ReactNode;
  /** Optional element rendered to the left of the text block (e.g. an avatar). */
  leading?: React.ReactNode;
  /** Optional extra content rendered on its own row below the title block. */
  children?: React.ReactNode;
  className?: string;
  /**
   * Set to `false` when a `TabBar` sits immediately below - its own border
   * already separates the header from the page body, and stacking this one on
   * top of it draws two rules where a detail page (matter, task) only ever
   * draws one.
   */
  bordered?: boolean;
}

/**
 * Compact page header: a single title row with an optional subtitle on the
 * left and actions on the right, separated from the page body by a bottom
 * border. Replaces the former full-width gradient hero banner so the actual
 * page content sits near the top of the viewport.
 */
export default function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  leading,
  children,
  className = "",
  bordered = true,
}: PageHeaderProps) {
  return (
    <div className={`${bordered ? "pb-4 border-b border-outline-subtle" : ""} ${className}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex items-start gap-3 min-w-0 sm:gap-4">
          {leading}
          <div className="min-w-0">
            {eyebrow && (
              <SectionLabel gap="1.5">
                {eyebrow}
              </SectionLabel>
            )}
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight leading-snug text-on-surface">
              {title}
            </h1>
            {description && (
              <p className="mt-1.5 text-sm leading-relaxed text-on-surface-secondary">
                {description}
              </p>
            )}
          </div>
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">{actions}</div>
        )}
      </div>
      {children}
    </div>
  );
}
