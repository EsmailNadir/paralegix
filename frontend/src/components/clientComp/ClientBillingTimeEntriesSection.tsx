"use client";

import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import type { ListRow } from "@/components/ui/ListView";
import { useFirmMembers } from "@/hooks/useFirmMembers";
import StatusBadge from "@/components/ui/StatusBadge";
import TagChip from "@/components/ui/TagChip";
import { findLinkedCompanyName } from "@/hooks/clientHooks/useClients";
import EntityTimeEntriesTab, { type ChargeCodeLabels } from "@/components/billingComp/EntityTimeEntriesTab";
import type { EnrichedTimeEntry } from "@/hooks/billingHooks/useFirmTimeEntries";
import type { BillingContext, Matter, Client, ClientBillingRowMetadata, TimeEntry } from "@/types";
import { formatHoursMinutes } from "@/lib/utils/format";
import { formatCurrency, isTimeEntryLocked, UNINVOICED_TIME_STATUSES } from "@/components/billingComp/utils";

type ClientBillingTimeEntriesSectionProps = {
  lawFirmId: string;
  client: Client;
  clientMatters: Matter[];
  onGoToBilling?: () => void;
  /** Linked-company id -> name, for the "why is this here" badge on an entry
   *  pulled in from a company this client is linked to. */
  companyNames: Map<string, string>;
};

type ClientBillingTimeEntryRow = Omit<EnrichedTimeEntry, "billingStatus"> &
  ClientBillingRowMetadata & {
    billingInvoiceHref?: string | null;
    billingInvoiceScope?: "matter" | "client" | null;
    entryBillingState?: TimeEntry["billingStatus"] | null;
    isReadOnly: boolean;
    isSharedMatter?: boolean;
    sharedMatterOtherClientCount?: number;
    /** The linked company this entry belongs to, when it isn't this client's own. */
    _companyName?: string;
  };

function buildBillingContext(contextType: "matter" | "client", lawFirmId: string, entityId: string): BillingContext {
  return { type: contextType, lawFirmId, entityId };
}

function getSharedMatterInfo(matterRecord: Matter | undefined, currentClient: Client) {
  if (!matterRecord) return { isSharedMatter: false, otherClientCount: 0 };

  if (matterRecord.clients?.length) {
    const currentMatterClient = matterRecord.clients.find(
      (matterClient) => matterClient.id === currentClient.id || (currentClient.userId ? matterClient.userId === currentClient.userId : false),
    );
    const otherClientCount = currentMatterClient
      ? matterRecord.clients.filter((matterClient) => matterClient.id !== currentMatterClient.id).length
      : Math.max(matterRecord.clients.length - 1, 0);

    return {
      isSharedMatter: otherClientCount > 0,
      otherClientCount,
    };
  }

  const totalClients =
    typeof matterRecord.clientCount === "number"
      ? matterRecord.clientCount
      : Array.isArray(matterRecord.clientUserIds)
        ? matterRecord.clientUserIds.length
        : 0;
  const otherClientCount = Math.max(totalClients - 1, 0);

  return {
    isSharedMatter: otherClientCount > 0,
    otherClientCount,
  };
}

function getSharedMatterLabel(otherClientCount: number) {
  if (otherClientCount <= 0) return "Shared matter";
  return `Shared with ${otherClientCount} other ${otherClientCount === 1 ? "client" : "clients"}`;
}

// Card row mapping for the table view's ListView (title=member/name, badges=charge
// code + shared-matter chip, meta=date · task/event, right=hours + amount).
function renderClientTimeEntryRow(entry: ClientBillingTimeEntryRow, chargeCodeMap: ChargeCodeLabels): ListRow {
  const chargeCode = entry.chargeCodeId ? chargeCodeMap[entry.chargeCodeId] : null;
  const sharedLabel = entry.isSharedMatter ? getSharedMatterLabel(entry.sharedMatterOtherClientCount || 0) : null;
  const sourceLabel = entry.sourceTaskTitle
    ? `Task: ${entry.sourceTaskTitle}`
    : entry.sourceEventTitle
      ? `Event: ${entry.sourceEventTitle}`
      : null;

  const metaParts = [
    entry.date ? dayjs(entry.date).format("MMM D, YYYY") : null,
    entry.memberName || "Unknown",
    chargeCode,
    sourceLabel,
  ].filter(Boolean);

  const hasAmount = typeof entry.amount === "number" && entry.amount > 0;

  return {
    title: (
      <>
        {entry.memberName || "Unknown"}
        {entry.name ? <span className="ml-1.5 font-normal text-on-surface-secondary">{entry.name}</span> : null}
      </>
    ),
    badges: (
      <>
        <StatusBadge variant={entry.contextType === "matter" ? "info" : "success"}>
          {entry.contextType === "matter" ? "Linked matter" : "Direct client"}
        </StatusBadge>
        {sharedLabel ? <StatusBadge variant="warning">{sharedLabel}</StatusBadge> : null}
        {entry._companyName ? <TagChip label={entry._companyName} /> : null}
      </>
    ),
    meta: metaParts.length ? metaParts.join("  ·  ") : null,
    right: (
      <>
        <p className="text-sm font-semibold text-on-surface tabular-nums">{formatHoursMinutes(entry.hours)}</p>
        <p className="text-xs text-on-surface-secondary tabular-nums">
          {hasAmount ? formatCurrency(entry.amount as number) : "-"}
        </p>
      </>
    ),
  };
}

/**
 * The composite row id is `context:entity:entryId` because one entry can appear
 * under more than one attribution on this page. The routes want the entry id.
 */
function clientEntryIdOf(entry: ClientBillingTimeEntryRow): string {
  return entry.timeEntryId || entry.id.split(":").pop()!;
}

export default function ClientBillingTimeEntriesSection({
  lawFirmId,
  client,
  clientMatters,
  onGoToBilling,
  companyNames,
}: ClientBillingTimeEntriesSectionProps) {
  const clientName = client.name || client.email || "Client";

  const matterMap = useMemo(() => new Map(clientMatters.map((c) => [c.id, c])), [clientMatters]);
  const clientMatterIds = useMemo(() => new Set(clientMatters.map((c) => c.id)), [clientMatters]);

  // Every member of the firm, not just the ones on the rows currently loaded.
  // Deriving these from the entries on screen would shrink the filter to whoever
  // happens to appear on the current page, so the control could no longer reach
  // the person you wanted to filter to.
  const firmMembers = useFirmMembers(lawFirmId);
  const memberOptions = useMemo(
    () => firmMembers.map((member) => ({ value: member.id, label: member.name })),
    [firmMembers],
  );

  /**
   * Shapes one server row into the row this panel renders.
   *
   * Everything here is derivable from the entry plus props the panel already
   * holds. The per-entry invoice linkage the old client-side build computed is
   * deliberately gone: this list only ever shows uninvoiced work, so an entry that
   * reached the screen was on no invoice, which made `primaryInvoice` null and
   * every invoice-derived field a constant. The fan-out that produced it - one
   * invoice request per linked matter - existed only to decide what to exclude,
   * and the server's `billingStatus` filter now decides that over the whole set.
   */
  const toPanelRow = useCallback(
    (entry: EnrichedTimeEntry, chargeCodeMap: ChargeCodeLabels): ClientBillingTimeEntryRow => {
      const isMatterEntry = entry.contextType === "matter";
      const entityId = isMatterEntry ? entry.matterId : client.id;
      const sharedMatterInfo = isMatterEntry
        ? getSharedMatterInfo(matterMap.get(entry.matterId), client)
        : { isSharedMatter: false, otherClientCount: 0 };
      // Read off the RAW entry, before the fields below overwrite `entityId`/
      // `clientId` to this panel's own client (this list is scoped to one
      // client's relationship, not one row's actual owner). For a direct entry
      // the raw `entityId` IS the owning client id (person or company); for a
      // matter entry, attribution lives in `clientId`/`matterClientId`/
      // `matterClientIds` instead.
      const companyName = findLinkedCompanyName(
        companyNames,
        entry.clientId,
        entry.matterClientId,
        entry.matterClientIds,
        isMatterEntry ? undefined : entry.entityId,
      );

      return {
        ...entry,
        // Namespaced by context so a client-direct and a matter entry can never
        // collide in the selection model.
        id: `${entry.contextType}:${entityId}:${entry.id}`,
        timeEntryId: entry.id,
        contextType: entry.contextType,
        entityId,
        _companyName: companyName,
        matterId: isMatterEntry ? entry.matterId : "",
        matterName: isMatterEntry ? matterMap.get(entry.matterId)?.name || entry.matterName || "" : "",
        clientId: client.id,
        clientName,
        clientNames: [clientName],
        memberName: entry.userName || "Unknown",
        // Rate and amount are the server's, resolved through the same cascade the
        // invoice is built from.
        hourlyRate: entry.hourlyRate,
        amount: entry.amount ?? null,
        context: entry.contextType,
        sourceLabel: entry.sourceTaskTitle || entry.sourceEventTitle || "",
        chargeCodeLabel: entry.chargeCodeId ? chargeCodeMap[entry.chargeCodeId] || null : null,
        // Invoiced-ness, as the server resolved it over the whole set. The two
        // reads include unbilled, queued and retainer-covered work. The lock
        // check still protects billed rows if a filter includes them.
        entryBillingState: entry.billingStatus || null,
        isBilled: entry.billingStatus === "billed",
        // Billed entries are read-only for the reason above; a company-sourced
        // entry (companyName set) is read-only because edit/delete are scoped
        // server-side to this panel's own client id, not the entry's actual
        // owner, so a mutation attempt on it would 404.
        isReadOnly: isTimeEntryLocked(entry) || Boolean(companyName),
        // Attribution, not invoiced-ness: the row type's `billingStatus` is the
        // ClientBillingEntryStatus vocabulary (owned / other_client / …), which
        // this panel does not render. The two fields are unrelated despite both
        // spelling one of their values "unbilled".
        billingStatus: "unbilled",
        billingInvoiceHref: isMatterEntry ? `/lawfirm/${lawFirmId}/matters/${entry.matterId}/invoices` : null,
        billingInvoiceScope: null,
        isSharedMatter: sharedMatterInfo.isSharedMatter,
        sharedMatterOtherClientCount: sharedMatterInfo.otherClientCount,
      } as ClientBillingTimeEntryRow;
    },
    [client, clientName, lawFirmId, matterMap, companyNames],
  );

  const queryClient = useQueryClient();

  // Invalidates every firm time-entry page rather than refetching just this
  // query: other views of the same work (e.g. the matter's own Time Tracking
  // tab) hold it under a different key, and leaving it cached would show an
  // entry that was just deleted here.
  const loadTimeEntries = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["billing", "firmTimeEntriesPage", lawFirmId] });
  }, [queryClient, lawFirmId]);

  return (
    <EntityTimeEntriesTab<ClientBillingTimeEntryRow>
      lawFirmId={lawFirmId}
      onGoToBilling={onGoToBilling}
      target={{
        // One flat, server-paged query over every entry this client is party to - 
        // `clientScope` with no `context` matches a direct entry on its own client
        // and a matter entry on the matter's clients, so it's the union of both.
        tableOptions: {
          initialFilters: { clientScope: client.id },
          defaultBillingStatus: UNINVOICED_TIME_STATUSES,
        },
        toRow: toPanelRow,
        renderRow: renderClientTimeEntryRow,
        entryIdOf: clientEntryIdOf,
        isLocked: (entry) => entry.isReadOnly,
        deleteContextOf: (entry) =>
          buildBillingContext(entry.contextType as "matter" | "client", lawFirmId, entry.entityId),
        // An entry logged against one of this client's matters bills through that
        // matter, which is where its invoice has to come from.
        billContextOf: (entry) =>
          entry.contextType === "matter" && entry.entityId
            ? `matter:${entry.entityId}`
            : `client:${client.id}`,
        ownsTimer: (timer) =>
          timer.clientId === client.id || (timer.matterId ? clientMatterIds.has(timer.matterId) : false),
        timerStart: { clientId: client.id, targetLabel: clientName },
        showTimerNote: false,
        goToBillingLabel: "Go to Billing",
        memberOptions,
        modal: {
          defaultTarget: `client:${client.id}`,
          scopeClientId: client.id,
        },
        reload: loadTimeEntries,
      }}
    />
  );
}
