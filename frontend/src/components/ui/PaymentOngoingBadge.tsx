"use client";

import { Coins } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";

/**
 * Amber "Payment ongoing" pill. Signals that a functionally-done matter still has
 * money outstanding (a payment plan, or a balance expected but not yet collected).
 *
 * Intentionally styled as a filled amber chip - distinct from the neutral status
 * dot-badges - so it reads as a separate financial signal rather than a status.
 * Only render it when a matter's effective `paymentOngoing` flag is true.
 */
export default function PaymentOngoingBadge({ className = "" }: { className?: string }) {
  return (
    <Tooltip title="This matter is closed but still has an outstanding balance." enterDelay={300}>
      <span
        className={[
          "inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700",
          "dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400",
          className,
        ].join(" ")}
      >
        <Coins size={11} strokeWidth={2.2} />
        Payment ongoing
      </span>
    </Tooltip>
  );
}
