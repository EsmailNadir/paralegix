import type {
  Matter,
  Client,
  ClientBillingEntryStatus,
  ClientBillingInvoiceMetadata,
  ClientBillingInvoiceRelation,
  ClientBillingRowMetadata,
  Invoice,
} from "@/types";

export type ClientScopedInvoice = Invoice &
  ClientBillingInvoiceMetadata & {
    _source: "matter" | "direct";
    _matterName?: string;
    _taskName?: string;
    _matterId?: string | null;
  };

type ClassificationInput = {
  invoice: Invoice;
  source: "matter" | "direct";
  matterRecord?: Matter | null;
  currentClient: Client;
};

export type MatterItemDraftRecipientMode = "single" | "multiple" | "unassigned";

export type MatterItemDraftRecipientTarget = {
  recipientMode: MatterItemDraftRecipientMode;
  recipientMatterClientId: string | null;
  recipientClientId: string | null;
  recipientName: string | null;
  preferredMatterClientIds: string[];
  isSharedMatter: boolean;
  otherClientCount: number;
};

/** A matter's client as the matter endpoints return it (id + name always, the rest when available). */
type MatterClientRef = NonNullable<Matter["clients"]>[number];

function findCurrentMatterClient(matterRecord: Matter | null | undefined, currentClient: Client): MatterClientRef | null {
  if (!matterRecord?.clients?.length) return null;

  const byUserId = currentClient.userId
    ? matterRecord.clients.find((matterClient) => matterClient.userId === currentClient.userId) || null
    : null;
  if (byUserId) return byUserId;

  return matterRecord.clients.find((matterClient) => matterClient.id === currentClient.id) || null;
}

function findRecipientMatterClient(matterRecord: Matter | null | undefined, invoice: Invoice): MatterClientRef | null {
  if (!matterRecord?.clients?.length) return null;

  if (invoice.matterClientId) {
    const byMatterClientId = matterRecord.clients.find((matterClient) => matterClient.id === invoice.matterClientId) || null;
    if (byMatterClientId) return byMatterClientId;
  }

  if (invoice.clientId) {
    // invoices.client_id is a clients.id, the same id these records carry. It was
    // being compared against the client's portal user id, which never matches.
    return matterRecord.clients.find((matterClient) => matterClient.id === invoice.clientId) || null;
  }

  return null;
}

function getMatterParticipantCount(matterRecord: Matter | null | undefined) {
  if (!matterRecord) return 1;

  if (Array.isArray(matterRecord.clients) && matterRecord.clients.length > 0) {
    return matterRecord.clients.length;
  }

  if (typeof matterRecord.clientCount === "number" && matterRecord.clientCount > 0) {
    return matterRecord.clientCount;
  }

  if (Array.isArray(matterRecord.clientUserIds) && matterRecord.clientUserIds.length > 0) {
    return matterRecord.clientUserIds.length;
  }

  return 1;
}

export function resolveMatterItemDraftRecipientTarget({
  matterRecord,
  currentClient,
  matterClientId,
  matterClientIds,
}: {
  matterRecord?: Matter | null;
  currentClient: Client;
  matterClientId?: string | null;
  matterClientIds?: string[] | null;
}): MatterItemDraftRecipientTarget {
  const participantCount = getMatterParticipantCount(matterRecord);
  const isSharedMatter = participantCount > 1;
  const otherClientCount = Math.max(participantCount - 1, 0);
  const matterClients = matterRecord?.clients || [];
  const currentMatterClient = findCurrentMatterClient(matterRecord, currentClient);

  const rawPreferredIds = Array.from(
    new Set(
      (
        Array.isArray(matterClientIds) && matterClientIds.length > 0
          ? matterClientIds
          : matterClientId
            ? [matterClientId]
            : []
      ).filter(Boolean),
    ),
  );

  const preferredMatterClientIds = matterClients.length > 0
    ? rawPreferredIds.filter((preferredId) => matterClients.some((matterClient) => matterClient.id === preferredId))
    : rawPreferredIds;

  if (preferredMatterClientIds.length > 1) {
    return {
      recipientMode: "multiple",
      recipientMatterClientId: null,
      recipientClientId: null,
      recipientName: null,
      preferredMatterClientIds,
      isSharedMatter,
      otherClientCount,
    };
  }

  if (preferredMatterClientIds.length === 1) {
    const preferredMatterClient = matterClients.find((matterClient) => matterClient.id === preferredMatterClientIds[0]) || null;
    return {
      recipientMode: "single",
      recipientMatterClientId: preferredMatterClientIds[0],
      recipientClientId: preferredMatterClient?.userId || null,
      recipientName: preferredMatterClient?.name || preferredMatterClient?.email || null,
      preferredMatterClientIds,
      isSharedMatter,
      otherClientCount,
    };
  }

  if (!isSharedMatter) {
    const fallbackMatterClient = matterClients[0] || currentMatterClient || null;
    return {
      recipientMode: "single",
      recipientMatterClientId: fallbackMatterClient?.id || null,
      recipientClientId: fallbackMatterClient?.userId || currentClient.id || null,
      recipientName:
        fallbackMatterClient?.name ||
        fallbackMatterClient?.email ||
        currentClient.name ||
        currentClient.email ||
        "This client",
      preferredMatterClientIds: fallbackMatterClient?.id ? [fallbackMatterClient.id] : [],
      isSharedMatter,
      otherClientCount,
    };
  }

  return {
    recipientMode: "unassigned",
    recipientMatterClientId: null,
    recipientClientId: null,
    recipientName: null,
    preferredMatterClientIds: [],
    isSharedMatter,
    otherClientCount,
  };
}

export function getMatterItemRecipientStatusLabel(target: MatterItemDraftRecipientTarget) {
  if (target.recipientMode === "single") {
    return target.recipientName ? `Bills to ${target.recipientName}` : "Bills to selected client";
  }

  if (target.recipientMode === "multiple") {
    return "Multiple preferred clients";
  }

  return "Recipient not chosen";
}

export function getMatterItemDraftActionLabel(target: MatterItemDraftRecipientTarget) {
  if (target.recipientMode === "single") {
    return "Bill from Matter";
  }

  if (target.recipientMode === "multiple") {
    return "Split Bill";
  }

  return "Choose Recipient";
}

export function buildMatterBillingDraftHref({
  lawFirmId,
  matterId,
  draftType,
  draftId,
  target,
}: {
  lawFirmId: string;
  matterId: string;
  draftType: "time_entry" | "flat_fee";
  draftId: string;
  target: MatterItemDraftRecipientTarget;
}) {
  const params = new URLSearchParams({
    draftType,
    draftId,
  });

  if (target.recipientMode === "single" && target.recipientMatterClientId) {
    params.set("billToMatterClientId", target.recipientMatterClientId);
  } else if (target.recipientMode === "multiple") {
    params.set("mode", "split");
    if (target.preferredMatterClientIds.length > 0) {
      params.set("preferredMatterClientIds", target.preferredMatterClientIds.join(","));
    }
  }

  return `/lawfirm/${lawFirmId}/matters/${matterId}/generate-invoice?${params.toString()}`;
}

export function classifyInvoiceForClient({
  invoice,
  source,
  matterRecord,
  currentClient,
}: ClassificationInput): ClientBillingInvoiceMetadata {
  if (source === "direct") {
    // A direct invoice's `entityId` is the clients.id it was actually billed
    // to. Before company-linked-client widening this was always the current
    // client by construction, so this branch could return "owned"
    // unconditionally. Now the invoice list can include a linked company's
    // own direct invoices too, so an explicit mismatch has to fall through
    // to "other_client" the same way the matter-invoice branches below do.
    if (invoice.entityId && invoice.entityId !== currentClient.id) {
      return {
        billingRelation: "other_client",
        billingRecipientName: invoice.clientName || "Another client",
        billingRecipientClientId: invoice.entityId,
      };
    }
    return {
      billingRelation: "owned",
      billingRecipientName: currentClient.name || currentClient.email || invoice.clientName || "This client",
      billingRecipientClientId: currentClient.id,
    };
  }

  const currentMatterClient = findCurrentMatterClient(matterRecord, currentClient);
  const recipientMatterClient = findRecipientMatterClient(matterRecord, invoice);
  const billingRecipientName =
    invoice.clientName ||
    recipientMatterClient?.name ||
    recipientMatterClient?.email ||
    null;
  const billingRecipientClientId = invoice.clientId || recipientMatterClient?.userId || null;

  if (invoice.clientId && invoice.clientId === currentClient.id) {
    return {
      billingRelation: "owned",
      billingRecipientName: billingRecipientName || currentClient.name || currentClient.email || "This client",
      billingRecipientClientId: currentClient.id,
    };
  }

  if (!invoice.clientId && currentMatterClient && invoice.matterClientId && invoice.matterClientId === currentMatterClient.id) {
    return {
      billingRelation: "owned",
      billingRecipientName: billingRecipientName || currentClient.name || currentClient.email || "This client",
      billingRecipientClientId: currentClient.id,
    };
  }

  if (invoice.clientId && invoice.clientId !== currentClient.id) {
    return {
      billingRelation: "other_client",
      billingRecipientName: billingRecipientName || "Another client",
      billingRecipientClientId,
    };
  }

  if (invoice.matterClientId && currentMatterClient && invoice.matterClientId !== currentMatterClient.id) {
    return {
      billingRelation: "other_client",
      billingRecipientName: billingRecipientName || "Another client",
      billingRecipientClientId,
    };
  }

  return {
    billingRelation: "shared_unassigned",
    billingRecipientName: billingRecipientName,
    billingRecipientClientId,
  };
}

export function buildClientScopedInvoices(params: {
  matterInvoices: Invoice[];
  directInvoices: Invoice[];
  clientMatters: Matter[];
  currentClient: Client;
  taskNames?: Map<string, string>;
}): ClientScopedInvoice[] {
  const { matterInvoices, directInvoices, clientMatters, currentClient, taskNames } = params;
  const matterMap = new Map(clientMatters.map((matterRecord) => [matterRecord.id, matterRecord]));

  const matterItems = matterInvoices.map((invoice) => {
    const matterId = invoice.matterId || null;
    const matterRecord = matterId ? matterMap.get(matterId) || null : null;
    return {
      ...invoice,
      ...classifyInvoiceForClient({
        invoice,
        source: "matter",
        matterRecord,
        currentClient,
      }),
      _source: "matter" as const,
      _matterName: matterRecord?.name || undefined,
      _matterId: matterId,
    };
  });

  const directItems = directInvoices.map((invoice) => ({
    ...invoice,
    ...classifyInvoiceForClient({
      invoice,
      source: "direct",
      currentClient,
    }),
    _source: "direct" as const,
    _matterName: invoice.matterId ? matterMap.get(invoice.matterId)?.name || undefined : undefined,
    _taskName: invoice.taskId ? taskNames?.get(invoice.taskId) : undefined,
    _matterId: invoice.matterId || null,
  }));

  return [...matterItems, ...directItems].sort((a, b) => {
    const aDate = a.createdAt ? new Date(a.createdAt).getTime() : (a.invoiceDate ? new Date(a.invoiceDate).getTime() : 0);
    const bDate = b.createdAt ? new Date(b.createdAt).getTime() : (b.invoiceDate ? new Date(b.invoiceDate).getTime() : 0);
    return bDate - aDate;
  });
}

export function getBillingRelationLabel(relation: ClientBillingInvoiceRelation, recipientName?: string | null) {
  switch (relation) {
    case "owned":
      return "This client";
    case "other_client":
      return recipientName ? `Billed to ${recipientName}` : "Billed to another client";
    default:
      return "Shared matter invoice";
  }
}
