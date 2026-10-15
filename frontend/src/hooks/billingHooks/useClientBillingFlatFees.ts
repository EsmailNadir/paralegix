"use client";

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import billingService from "@/services/billing.service";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import {
  getMatterItemDraftActionLabel,
  getMatterItemRecipientStatusLabel,
  resolveMatterItemDraftRecipientTarget,
} from "@/components/clientComp/billingAwareness";
import type { Client, FlatFee } from "@/types";
import type { Matter } from "@/types/matter";

/**
 * A flat fee as the client Billing tab renders it: the stored record plus the
 * matter-side facts the row needs (which matter owns it, who it would be billed
 * to, whether that matter has other clients on it). The underscore-prefixed
 * fields are view state derived here, never sent back to the server.
 */
export type ClientBillingFlatFee = FlatFee & {
  _source: "direct" | "matter";
  _matterId?: string | null;
  _matterName?: string;
  _isSharedMatter?: boolean;
  _otherClientCount?: number;
  _recipientMode?: "single" | "multiple" | "unassigned";
  _recipientName?: string | null;
  _recipientMatterClientId?: string | null;
  _preferredMatterClientIds?: string[];
  _recipientStatusLabel?: string;
  _billingActionLabel?: string;
};

/** A direct client fee being composed in the tab, before it has been saved. */
export type DraftClientBillingFlatFee = ClientBillingFlatFee & {
  id: string;
  description: string;
  amount: number;
  date?: string | null;
};

export function getClientMatterParticipantCount(clientMatter: Matter): number {
  return Math.max(
    clientMatter.clients?.length || clientMatter.clientCount || clientMatter.clientUserIds?.length || 0,
    1,
  );
}

export interface ClientBillingFlatFeesResult {
  loading: boolean;
  /**
   * The server had more unbilled fees than one page could carry, so the two
   * lists below are a window rather than everything this client owes on.
   */
  truncated: boolean;
  /**
   * Why the last read failed, or null. Shown in place of the lists, which a
   * failed read leaves empty: an empty list would read as "nothing to bill".
   */
  error: string | null;
  directFlatFees: DraftClientBillingFlatFee[];
  setDirectFlatFees: Dispatch<SetStateAction<DraftClientBillingFlatFee[]>>;
  linkedMatterFlatFees: ClientBillingFlatFee[];
  reload: () => Promise<void>;
}

/**
 * The unbilled flat fees the client Billing tab shows: the client's own fees and
 * the fees sitting on the matters this client is on.
 *
 * Both halves come from ONE firm-wide read. The tab used to ask per matter, so a
 * corporate client with eighty matters fired eighty requests from a single tab
 * click, each holding one of the API instance's shared Postgres connections. The
 * firm route ORs `clientId` with `matterIds`, which is this tab's question
 * exactly, so the count of requests no longer tracks the size of the client.
 */
export default function useClientBillingFlatFees({
  lawFirmId,
  clientId,
  client,
  clientMatters,
}: {
  lawFirmId: string;
  clientId: string;
  client: Client | null;
  clientMatters: Matter[];
}): ClientBillingFlatFeesResult {
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [directFlatFees, setDirectFlatFees] = useState<DraftClientBillingFlatFee[]>([]);
  const [linkedMatterFlatFees, setLinkedMatterFlatFees] = useState<ClientBillingFlatFee[]>([]);

  const matterById = useMemo(
    () => new Map(clientMatters.map((clientMatter) => [clientMatter.id, clientMatter])),
    [clientMatters],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const page = await billingService
        .listClientScopeFlatFees(lawFirmId, {
          clientId,
          matterIds: clientMatters.map((clientMatter) => clientMatter.id),
          // The tab only ever renders unbilled fees. Filtering server-side keeps
          // a long-running client's billed history off the wire entirely, and
          // keeps the page ceiling spent on rows that will be shown.
          billingStatus: "unbilled",
        })
        .then(
          (result) => {
            setError(null);
            return result;
          },
          (err: unknown) => {
            setError(getErrorMessage(err, "Failed to load flat fees"));
            return null;
          },
        );

      const direct: DraftClientBillingFlatFee[] = [];
      // Keyed by matter so a fee lands next to the matter record that decorates
      // it, and so the section stays grouped by matter the way it read when each
      // matter was fetched in turn.
      const linkedByMatter = new Map<string, ClientBillingFlatFee[]>();
      for (const clientMatter of clientMatters) linkedByMatter.set(clientMatter.id, []);

      for (const fee of page?.flatFees || []) {
        if (!fee.matterId) {
          direct.push({ ...fee, _source: "direct" } as DraftClientBillingFlatFee);
          continue;
        }
        const clientMatter = matterById.get(fee.matterId);
        // A fee on a matter this client is not on cannot appear under this
        // client, however the firm-wide read came by it.
        if (!clientMatter) continue;

        const participantCount = getClientMatterParticipantCount(clientMatter);
        const billingTarget = resolveMatterItemDraftRecipientTarget({
          matterRecord: clientMatter,
          currentClient: client || ({ id: clientId } as Client),
        });
        linkedByMatter.get(clientMatter.id)?.push({
          ...fee,
          _source: "matter",
          _matterId: clientMatter.id,
          _matterName: clientMatter.name,
          _isSharedMatter: participantCount > 1,
          _otherClientCount: Math.max(participantCount - 1, 0),
          _recipientMode: billingTarget.recipientMode,
          _recipientName: billingTarget.recipientName,
          _recipientMatterClientId: billingTarget.recipientMatterClientId,
          _preferredMatterClientIds: billingTarget.preferredMatterClientIds,
          _recipientStatusLabel: getMatterItemRecipientStatusLabel(billingTarget),
          _billingActionLabel: getMatterItemDraftActionLabel(billingTarget),
        } satisfies ClientBillingFlatFee);
      }

      setDirectFlatFees(direct);
      setLinkedMatterFlatFees(Array.from(linkedByMatter.values()).flat());
      setTruncated(page?.truncated === true);
    } finally {
      setLoading(false);
    }
  }, [client, clientId, clientMatters, lawFirmId, matterById]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- triggers an async data fetch when inputs change
    void reload();
  }, [reload]);

  return { loading, truncated, error, directFlatFees, setDirectFlatFees, linkedMatterFlatFees, reload };
}
