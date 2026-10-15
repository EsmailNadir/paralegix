"use client";

import type { ReactNode } from "react";

export interface AdminStat {
  label: string;
  value: ReactNode;
  /** Secondary line under the number, e.g. a share of the total. */
  hint?: string;
  /** Draws attention to a growth figure. Plain by default. */
  accent?: boolean;
}

interface AdminStatCardsProps {
  stats: AdminStat[];
  /** Cards per row at the widest breakpoint. */
  columns?: 3 | 4 | 5 | 6;
}

/**
 * The row of headline numbers above an admin console table.
 *
 * Every one of these is computed server-side over the whole platform and stays
 * fixed while the table below is searched or filtered, which is the point: the
 * cards answer "how big is the platform", the table answers "which rows".
 */
const COLUMN_CLS: Record<3 | 4 | 5 | 6, string> = {
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-3 lg:grid-cols-5",
  6: "sm:grid-cols-3 lg:grid-cols-6",
};

export default function AdminStatCards({ stats, columns = 4 }: AdminStatCardsProps) {
  return (
    <div className={`grid grid-cols-2 gap-3 ${COLUMN_CLS[columns]}`}>
      {stats.map((stat) => (
        <div key={stat.label} className="bg-surface rounded-xl border border-outline-subtle p-4">
          <p className="text-xs text-on-surface-muted uppercase tracking-[0.1em]">{stat.label}</p>
          <p
            className={`text-2xl font-bold mt-1 ${
              stat.accent ? "text-accent-emphasis" : "text-on-surface"
            }`}
          >
            {stat.value}
          </p>
          {stat.hint && <p className="text-xs text-on-surface-muted mt-1">{stat.hint}</p>}
        </div>
      ))}
    </div>
  );
}
