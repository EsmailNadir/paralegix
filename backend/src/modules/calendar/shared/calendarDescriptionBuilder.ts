const { privilegedParameterizedQuery } = require('../../../shared/database/queryContext');
const { isUuid } = require('../../../shared/utils/isUuid');

const calendarSql = (text: string, params: unknown[] = []) => privilegedParameterizedQuery(
  'calendar descriptions read tenant-owned matter and client context', text, params,
);

export const EVENT_TYPE_LABELS = {
  court_date: 'Court Date',
  hearing: 'Hearing',
  deposition: 'Deposition',
  filing_deadline: 'Filing Deadline',
  discovery_cutoff: 'Discovery Cutoff',
  mediation: 'Mediation',
  arbitration: 'Arbitration',
  trial: 'Trial',
  appeal_deadline: 'Appeal Deadline',
  statute_of_limitations: 'Statute of Limitations',
  meeting: 'Meeting',
  other: 'Event',
};

function isNonEmptyStr(value: any) {
  return typeof value === 'string' && value.trim().length > 0;
}

function joinDescriptionParts(parts: any) {
  return parts
    .filter((part: any) => isNonEmptyStr(part))
    .map((part: any) => part.trim())
    .join('\n\n');
}

function normalizeClientContacts(clients: any) {
  const seen = new Set();
  const normalized: any[] = [];

  (clients || []).forEach((client: any) => {
    const name = isNonEmptyStr(client?.name) ? client.name.trim() : null;
    const phone = isNonEmptyStr(client?.phone) ? client.phone.trim() : null;
    if (!name) return;

    const dedupeKey = `${name.toLowerCase()}::${(phone || '').toLowerCase()}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    normalized.push({ name, phone });
  });

  return normalized;
}

function buildClientContactSection(clients: any) {
  const normalized = normalizeClientContacts(clients);
  if (normalized.length === 0) return null;

  if (normalized.length === 1) {
    const client = normalized[0];
    return client.phone
      ? `Client: ${client.name} - ${client.phone}`
      : `Client: ${client.name}`;
  }

  const lines = normalized.map((client) => (
    client.phone ? `${client.name} - ${client.phone}` : client.name
  ));

  return `Clients:\n${lines.join('\n')}`;
}

async function getMatterClientContacts(lawFirmId: string, matterId: string) {
  if (!isNonEmptyStr(lawFirmId) || !isNonEmptyStr(matterId)) return [];

  if (!isUuid(matterId)) return [];
  try {
    const { rows } = await calendarSql(
      `select cl.id, cl.name, cl.phone
         from matter_clients cc
         join clients cl on cl.id = cc.client_id
        where cc.matter_id = $1 and cl.law_firm_id = $2`,
      [matterId, lawFirmId]
    );
    return rows.map((r: any) => ({ id: r.id, name: r.name || null, phone: r.phone || null }));
  } catch (err) {
    console.error('calendarDescriptionBuilder: failed to load matter clients:', err);
    return [];
  }
}

async function getFirmClientContacts(lawFirmId: string, clientIds: string[], fallbackNames: any[] = []) {
  if (!isNonEmptyStr(lawFirmId) || !Array.isArray(clientIds) || clientIds.length === 0) return [];

  try {
    const ids = clientIds.filter((id) => isUuid(id));
    const { rows } = ids.length
      ? await calendarSql(`select id, name, phone from clients where law_firm_id = $1 and id = any($2)`, [lawFirmId, ids])
      : { rows: [] };
    const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]));

    return clientIds
      .map((clientId, index) => {
        if (!isNonEmptyStr(clientId)) return null;
        const data = byId[clientId] || {};
        return {
          id: clientId,
          name: data.name || fallbackNames[index] || null,
          phone: data.phone || null,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error('calendarDescriptionBuilder: failed to load firm clients:', err);
    return [];
  }
}

async function getTaskClientContacts(entityData: any) {
  if (isNonEmptyStr(entityData?.matterId)) {
    return getMatterClientContacts(entityData.lawFirmId, entityData.matterId);
  }

  return getFirmClientContacts(
    entityData?.lawFirmId,
    Array.isArray(entityData?.clientIds) ? entityData.clientIds : [],
    Array.isArray(entityData?.clientNames) ? entityData.clientNames : []
  );
}

async function getMatterEventClientContacts(entityData: any) {
  return getMatterClientContacts(entityData?.lawFirmId, entityData?.matterId);
}

async function getClientEventContacts(entityData: any) {
  if (!isNonEmptyStr(entityData?.clientId)) return [];
  return getFirmClientContacts(entityData.lawFirmId, [entityData.clientId]);
}

/** The frontend origin of this deployment, read per call so each environment links to itself. */
function appBase() {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/**
 * The closing part of a pushed description: the link back to the entity's page
 * in Paralegix, then the source marker. Only written with a marker, because the
 * marker is what tells the inbound strip that the block is Paralegix's own.
 */
function buildFooter(path: string | null, sourceMarker: any) {
  if (!isNonEmptyStr(sourceMarker)) return null;
  return [path ? `Open in Paralegix: ${appBase()}${path}` : null, sourceMarker.trim()]
    .filter(Boolean)
    .join('\n');
}

function taskPath(entityData: any) {
  if (!isUuid(entityData?.lawFirmId) || !isUuid(entityData?.id)) return null;
  return `/lawfirm/${entityData.lawFirmId}/tasks/${entityData.id}`;
}

function matterEventPath(entityData: any) {
  if (!isUuid(entityData?.lawFirmId) || !isUuid(entityData?.matterId)) return null;
  return `/lawfirm/${entityData.lawFirmId}/matters/${entityData.matterId}?tab=events`;
}

function clientEventPath(entityData: any) {
  if (!isUuid(entityData?.lawFirmId) || !isUuid(entityData?.clientId)) return null;
  return `/lawfirm/${entityData.lawFirmId}/clients/${entityData.clientId}?tab=events`;
}

/** An invoice's page, under its matter or its client. The invoice shape carries no firm id, so it is read. */
async function invoicePath(invoice: any) {
  if (!isUuid(invoice?.id)) return null;
  let lawFirmId = isUuid(invoice?.lawFirmId) ? invoice.lawFirmId : null;
  if (!lawFirmId) {
    try {
      const result = await calendarSql('select law_firm_id from invoices where id = $1 limit 1', [invoice.id]);
      lawFirmId = result?.rows?.[0]?.law_firm_id || null;
    } catch (err) {
      console.error('calendarDescriptionBuilder: failed to load invoice firm:', err);
    }
  }
  if (!lawFirmId) return null;
  if (isUuid(invoice.matterId)) return `/lawfirm/${lawFirmId}/matters/${invoice.matterId}/invoices/${invoice.id}`;
  if (isUuid(invoice.clientContextId)) return `/lawfirm/${lawFirmId}/clients/${invoice.clientContextId}/invoices/${invoice.id}`;
  return null;
}

export async function buildTaskCalendarDescription(entityData: any, sourceMarker: any) {
  const clientSection = buildClientContactSection(await getTaskClientContacts(entityData));

  return joinDescriptionParts([
    clientSection,
    entityData?.description,
    buildFooter(taskPath(entityData), sourceMarker),
  ]);
}

export async function buildMatterEventCalendarDescription(entityData: any, sourceMarker: any) {
  const clientSection = buildClientContactSection(await getMatterEventClientContacts(entityData));
  const typeLabel = (EVENT_TYPE_LABELS as Record<string, any>)[entityData?.type] || 'Event';
  const title = isNonEmptyStr(entityData?.title) ? entityData.title.trim() : 'Untitled event';

  return joinDescriptionParts([
    clientSection,
    `${typeLabel}: ${title}`,
    isNonEmptyStr(entityData?.locationName) ? `Location: ${entityData.locationName}` : null,
    entityData?.notes,
    buildFooter(matterEventPath(entityData), sourceMarker),
  ]);
}

export async function buildClientEventCalendarDescription(entityData: any, sourceMarker: any) {
  const clientSection = buildClientContactSection(await getClientEventContacts(entityData));
  const typeLabel = (EVENT_TYPE_LABELS as Record<string, any>)[entityData?.type] || 'Event';
  const title = isNonEmptyStr(entityData?.title) ? entityData.title.trim() : 'Untitled event';

  return joinDescriptionParts([
    clientSection,
    `${typeLabel}: ${title}`,
    entityData?.notes,
    buildFooter(clientEventPath(entityData), sourceMarker),
  ]);
}

export async function buildExternalEventCalendarDescription(entityData: any, sourceMarker: any) {
  const title = isNonEmptyStr(entityData?.title) ? entityData.title.trim() : 'Untitled event';

  return joinDescriptionParts([
    `External event: ${title}`,
    isNonEmptyStr(entityData?.notes) ? entityData.notes : entityData?.description,
    sourceMarker,
  ]);
}

export async function buildBillingCalendarDescription(entityData: any, item: any, sourceMarker: any) {
  const amount = typeof item?.scheduledAmount === 'number'
    ? `$${item.scheduledAmount.toFixed(2)}`
    : null;
  const dateLabel = item?.scheduledDate || null;
  const itemLabel = item?.billingItemType === 'installment' ? 'Payment plan installment' : 'Invoice due date';

  return joinDescriptionParts([
    entityData?.clientName ? `Client: ${entityData.clientName}` : null,
    entityData?.matterName ? `Matter: ${entityData.matterName}` : null,
    entityData?.invoiceName ? `Invoice: ${entityData.invoiceName}` : null,
    entityData?.invoiceNumber ? `Invoice number: ${entityData.invoiceNumber}` : null,
    itemLabel,
    amount ? `Amount due: ${amount}` : null,
    dateLabel ? `Date: ${dateLabel}` : null,
    isNonEmptyStr(sourceMarker) ? buildFooter(await invoicePath(entityData), sourceMarker) : null,
  ]);
}
