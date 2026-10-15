import type { ReactNode } from "react";

type Props = {
  icon?: ReactNode;
  label: string;
  children: ReactNode;
  presentation?: "detail" | "dashboard";
  truncate?: boolean;
};

/** Common invoice context/date row; each quick look retains its existing value alignment. */
export default function InvoiceDetailRow({ icon, label, children, presentation = "detail", truncate }: Props) {
  const dashboard = presentation === "dashboard";
  return <div className={dashboard ? "flex items-center justify-between text-sm" : "flex items-start justify-between gap-4 text-sm"}>
    <dt className={dashboard ? "text-on-surface-secondary" : "flex items-center gap-2 text-on-surface-secondary shrink-0"}>
      {icon}{icon ? " " : null}{label}
    </dt>
    <dd className={dashboard
      ? truncate ? "text-on-surface font-medium text-right truncate ml-4" : "text-on-surface font-medium"
      : "text-right ml-4 min-w-0 text-on-surface font-medium"}>{children}</dd>
  </div>;
}
