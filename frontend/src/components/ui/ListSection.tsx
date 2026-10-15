import type { ReactNode } from "react";

/** Keeps a list heading and its controls together within the page section stack. */
export default function ListSection({ children }: { children: ReactNode }) {
  return <div className="space-y-4">{children}</div>;
}
