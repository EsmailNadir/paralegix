import { Fragment, type ReactNode } from "react";

type Amount = { label: string; value: string | number; valueClass?: string };
type Props = { items: Amount[] } & (
  | { presentation: "tiles"; className: string; renderTile: (item: Amount) => ReactNode }
  | { presentation: "rows" | "client"; className?: never; renderTile?: never }
);

/** Callers supply already resolved amounts, preserving cents and legacy dollar models. */
export default function InvoiceMoneySummary({ items, presentation, className, renderTile }: Props) {
  if (presentation === "tiles") return <div className={className}>{items.map((item) => <Fragment key={item.label}>{renderTile(item)}</Fragment>)}</div>;
  if (presentation === "client") return <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
    {items.map((item) => <div key={item.label} className="bg-surface-alt rounded-lg p-3 text-center">
      <p className="text-[10px] text-on-surface-muted font-medium">{item.label}</p>
      <p className="text-sm font-bold text-on-surface">{item.value}</p>
    </div>)}
  </div>;
  return <div className="rounded-xl border border-outline-subtle bg-surface-alt px-4 py-3 space-y-2">
    {items.map((item, index) => index === items.length - 1
      ? <div key={item.label} className="flex items-center justify-between pt-2 border-t border-outline-subtle">
        <span className="text-sm font-semibold text-on-surface">{item.label}</span>
        <span className="text-base font-semibold text-on-surface">{item.value}</span>
      </div>
      : <div key={item.label} className="flex items-center justify-between text-sm">
        <span className="text-on-surface-secondary">{item.label}</span>
        <span className="text-on-surface font-medium">{item.value}</span>
      </div>)}
  </div>;
}
