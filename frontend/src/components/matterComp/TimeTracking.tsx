"use client";

import { useMemo } from "react";
import dayjs from "dayjs";
import type { ListRow } from "@/components/ui/ListView";
import type { EnrichedTimeEntry } from "@/hooks/billingHooks/useFirmTimeEntries";
import EntityTimeEntriesTab, { type ChargeCodeLabels } from "@/components/billingComp/EntityTimeEntriesTab";
import type { BillingContext, Member, User } from "@/types";
import { formatHoursMinutes } from "@/lib/utils/format";
import { formatCurrency, isTimeEntryLocked, UNINVOICED_TIME_STATUSES } from "@/components/billingComp/utils";

type Props = {
  context: BillingContext;
  members: Member[];
  users: User[];
  matterName: string;
  onRefresh?: () => void;
  onGoToBilling?: () => void;
};

/** One matter time entry: member as the title, then date, name, charge code and source. */
function renderMatterTimeEntryRow(entry: EnrichedTimeEntry, chargeCodeMap: ChargeCodeLabels): ListRow {
  // Rate and amount come resolved from the server, through the same cascade
  // the invoice is built from, so the row can't disagree with what is billed.
  const rate = typeof entry.hourlyRate === "number" ? entry.hourlyRate : 0;
  const amount = typeof entry.amount === "number" ? entry.amount : 0;
  const chargeCode = entry.chargeCodeId ? chargeCodeMap[entry.chargeCodeId] : null;
  const sourceLabel = entry.sourceTaskTitle
    ? `Task: ${entry.sourceTaskTitle}`
    : entry.sourceEventTitle
    ? `Event: ${entry.sourceEventTitle}`
    : null;

  const metaParts = [
    entry.date ? dayjs(entry.date).format("MMM D, YYYY") : null,
    entry.name || null,
    chargeCode,
    sourceLabel,
  ].filter(Boolean);

  return {
    title: entry.userName || "Unknown",
    meta: metaParts.length ? metaParts.join("  ·  ") : null,
    right: (
      <>
        <p className="text-sm font-semibold text-on-surface tabular-nums">
          {formatHoursMinutes(entry.hours)}
        </p>
        <p className="text-xs tabular-nums text-on-surface-secondary">
          {rate > 0 ? formatCurrency(amount) : "-"}
        </p>
      </>
    ),
  };
}

export default function TimeTracking({ context, members, users, matterName, onRefresh, onGoToBilling }: Props) {
  // This panel is matter-only - a client's own time entries render through the
  // sibling `ClientBillingTimeEntriesSection`, which additionally unions in
  // matter-attributed work and shared/company attribution the client page needs
  // and this one does not.
  const entryScopeFilter = useMemo(
    () => ({ matterId: context.entityId }),
    [context.entityId]
  );

  return (
    <EntityTimeEntriesTab<EnrichedTimeEntry>
      lawFirmId={context.lawFirmId}
      onGoToBilling={onGoToBilling}
      target={{
        tableOptions: {
          initialFilters: entryScopeFilter,
          // Everything not yet on an invoice. The old client-side `!isBilled` filter
          // could only exclude what a full download had already fetched; asking the
          // server for the same set is what lets this list be a page at all.
          defaultBillingStatus: UNINVOICED_TIME_STATUSES,
          enabled: Boolean(context.lawFirmId && context.entityId),
        },
        renderRow: renderMatterTimeEntryRow,
        entryIdOf: (entry) => entry.id,
        // Invoiced time is read-only wherever it is listed, by the same rule as
        // `billingComp/BillingTimeEntriesView`.
        isLocked: isTimeEntryLocked,
        deleteContextOf: () => context,
        // An invoice covers the matter's outstanding work, so every row bills
        // through the matter.
        billContextOf: () => `${context.type}:${context.entityId}`,
        ownsTimer: (timer) => timer.matterId === context.entityId,
        timerStart: { matterId: context.entityId, targetLabel: matterName },
        showTimerNote: true,
        goToBillingLabel: "Go to Matter Billing",
        memberOptions: members
          .filter((m) => m && m.userId)
          .map((m) => ({ value: m.userId, label: m.name || "Unknown" })),
        normalizeMemberFilter: (value) =>
          value && members.some((m) => m.userId === value) ? value : "",
        modal: {
          defaultTarget: `matter:${context.entityId}`,
          scopeMatterId: context.entityId,
          users,
        },
        logTimePrefill: (userId) => ({ matterId: context.entityId, userId }),
        logTimeClearsError: true,
        onRefresh,
      }}
    />
  );
}
