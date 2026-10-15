/**
 * Which of a client's relationships an invoice belongs to, from that client's
 * point of view.
 *
 * A matter can carry several clients, so an invoice sitting on a shared matter is
 * not automatically this client's. The three outcomes are:
 *
 *   owned             this client is the payer
 *   other_client      a different client on the same matter is the payer
 *   shared_unassigned on a shared matter with no payer named yet
 *
 * This is a direct port of the browser's `classifyInvoiceForClient`
 * (frontend/src/components/clientComp/billingAwareness.ts). The precedence order
 * matters: `clientId` (a clients.id the invoice was billed to) wins over
 * `matterClientId`, and an explicit mismatch beats the unassigned fallback.
 * Keep the two in step — this decides whose money a firm sees on a client page.
 */

/** The matter-client row for the client whose page we are rendering. */
function findCurrentMatterClient(matterClients: any, currentClient: any) {
  if (!matterClients || !matterClients.length) return null;
  if (currentClient.userId) {
    const byUserId = matterClients.find((mc: any) => mc.userId === currentClient.userId);
    if (byUserId) return byUserId;
  }
  return matterClients.find((mc: any) => mc.id === currentClient.id) || null;
}

/** The matter-client row the invoice was actually billed to. */
function findRecipientMatterClient(matterClients: any, invoice: any) {
  if (!matterClients || !matterClients.length) return null;
  if (invoice.matterClientId) {
    const byMatterClientId = matterClients.find((mc: any) => mc.id === invoice.matterClientId);
    if (byMatterClientId) return byMatterClientId;
  }
  if (invoice.clientId) {
    // invoices.client_id is a clients.id, the same id these rows carry.
    return matterClients.find((mc: any) => mc.id === invoice.clientId) || null;
  }
  return null;
}

export function classifyInvoiceForClient({ invoice, source, matterClients, currentClient }: any) {
  if (source === 'direct') {
    // A direct invoice's `entityId` is the clients.id it was actually billed
    // to. Before company-linked-client widening this was always the scope
    // client by construction (the caller only ever built this list for one
    // client's own invoices), so this branch could return 'owned'
    // unconditionally. Now a scope can include a linked company's own direct
    // invoices too, so an explicit mismatch has to fall through to
    // 'other_client' the same way the matter-invoice branches below do.
    if (invoice.entityId && invoice.entityId !== currentClient.id) {
      return {
        billingRelation: 'other_client',
        billingRecipientName: invoice.clientName || 'Another client',
        billingRecipientClientId: invoice.entityId,
      };
    }
    return {
      billingRelation: 'owned',
      billingRecipientName:
        currentClient.name || currentClient.email || invoice.clientName || 'This client',
      billingRecipientClientId: currentClient.id,
    };
  }

  const currentMatterClient = findCurrentMatterClient(matterClients, currentClient);
  const recipientMatterClient = findRecipientMatterClient(matterClients, invoice);
  const billingRecipientName =
    invoice.clientName
    || (recipientMatterClient && (recipientMatterClient.name || recipientMatterClient.email))
    || null;
  // billingRecipientClientId is always a clients.id, matching invoice.clientId's
  // id space. This used to fall back to recipientMatterClient.userId (a
  // Firebase UID) instead of recipientMatterClient.id, mixing id spaces under
  // a name that promises a clients.id.
  const billingRecipientClientId =
    invoice.clientId || (recipientMatterClient && recipientMatterClient.id) || null;

  if (invoice.clientId && invoice.clientId === currentClient.id) {
    return {
      billingRelation: 'owned',
      billingRecipientName:
        billingRecipientName || currentClient.name || currentClient.email || 'This client',
      billingRecipientClientId: currentClient.id,
    };
  }

  if (
    !invoice.clientId
    && currentMatterClient
    && invoice.matterClientId
    && invoice.matterClientId === currentMatterClient.id
  ) {
    return {
      billingRelation: 'owned',
      billingRecipientName:
        billingRecipientName || currentClient.name || currentClient.email || 'This client',
      billingRecipientClientId: currentClient.id,
    };
  }

  if (invoice.clientId && invoice.clientId !== currentClient.id) {
    return {
      billingRelation: 'other_client',
      billingRecipientName: billingRecipientName || 'Another client',
      billingRecipientClientId,
    };
  }

  if (
    invoice.matterClientId
    && currentMatterClient
    && invoice.matterClientId !== currentMatterClient.id
  ) {
    return {
      billingRelation: 'other_client',
      billingRecipientName: billingRecipientName || 'Another client',
      billingRecipientClientId,
    };
  }

  return {
    billingRelation: 'shared_unassigned',
    billingRecipientName,
    billingRecipientClientId,
  };
}

export const BILLING_RELATIONS = ['owned', 'other_client', 'shared_unassigned'];
