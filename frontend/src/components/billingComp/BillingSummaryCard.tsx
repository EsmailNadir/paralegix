interface BillingSummaryCardProps {
  label: string;
  value: string;
  highlight?: boolean;
  subtitle?: string;
  onClick?: () => void;
}

/** A single money stat tile used in billing summary rows (client tab, matter billing tab). */
export default function BillingSummaryCard({ label, value, highlight, subtitle, onClick }: BillingSummaryCardProps) {
  const className = "bg-surface rounded-xl border border-outline-subtle p-4";
  const content = (
    <>
      <p className="text-xs text-on-surface-muted font-medium mb-1">{label}</p>
      <p className={`text-lg font-bold ${highlight ? "text-rose-600 dark:text-rose-400" : "text-on-surface"}`}>
        {value}
      </p>
      {subtitle && (
        <p className="text-[11px] text-on-surface-secondary mt-1">{subtitle}</p>
      )}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${className} text-left cursor-pointer hover:bg-surface-hover transition-colors`}
      >
        {content}
      </button>
    );
  }

  return <div className={className}>{content}</div>;
}
