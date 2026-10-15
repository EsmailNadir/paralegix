"use client";

import { Briefcase, Users } from "lucide-react";
import SegmentedToggle from "@/components/ui/SegmentedToggle";
import BillingByMatterView from "./BillingByMatterView";
import BillingByClientView from "./BillingByClientView";

export type ReportGroup = "matter" | "client";

interface BillingReportsViewProps {
  lawFirmId: string;
  group: ReportGroup;
  onGroupChange: (group: ReportGroup) => void;
}

/**
 * The billing roll-ups, grouped by matter or by client.
 *
 * Neither view is handed any data. Each reads a server-side aggregate of its
 * own: every figure on a card is a lifetime total, and building those here would
 * mean downloading the firm's complete time-entry and invoice history to add up
 * in the browser - a read that grows for as long as the firm does.
 */
export default function BillingReportsView({
  lawFirmId,
  group,
  onGroupChange,
}: BillingReportsViewProps) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-on-surface-secondary">Group by:</span>
        <SegmentedToggle
          size="md"
          ariaLabel="Group by"
          options={[
            { value: "matter", label: "Matter", icon: Briefcase },
            { value: "client", label: "Client", icon: Users },
          ]}
          value={group}
          onChange={onGroupChange}
        />
      </div>

      {/* Only the visible grouping fetches: `active` holds the other one back. */}
      {group === "client" ? (
        <BillingByClientView lawFirmId={lawFirmId} active />
      ) : (
        <BillingByMatterView lawFirmId={lawFirmId} active />
      )}
    </div>
  );
}
