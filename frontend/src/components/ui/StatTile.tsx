import type { LucideIcon } from "lucide-react";

interface StatTileProps {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  /** When set, the tile becomes a button that jumps to the tab the stat counts. */
  onClick?: () => void;
  /** Accessible label for the click action. Defaults to "View <label>". */
  actionLabel?: string;
}

const TILE_CLASS = "bg-surface rounded-2xl border border-outline-subtle p-4";

/** One quick-stat card: a big number with a label and icon, used in detail-page sidebars. */
export default function StatTile({ label, value, icon: Icon, onClick, actionLabel }: StatTileProps) {
  const body = (
    <>
      <p className="text-xs text-on-surface-muted uppercase tracking-[0.08em] mb-2">{label}</p>
      <div className="flex items-center justify-between">
        <p className="text-xl font-semibold text-on-surface">{value}</p>
        {Icon && <Icon size={18} className="text-on-surface-muted" />}
      </div>
    </>
  );

  if (!onClick) {
    return <div className={TILE_CLASS}>{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={actionLabel || `View ${label}`}
      className={`${TILE_CLASS} w-full text-left cursor-pointer transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring`}
    >
      {body}
    </button>
  );
}
