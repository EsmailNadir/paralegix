/**
 * Typed calendar entity resolver (relational; replaces the legacy doc-ref shim).
 *
 * The Google/Outlook sync engines were written against Firestore doc refs whose
 * `.update(writeback)` stamped per-user calendar_sync state onto the synced
 * entity, and whose `.path` was stored in calendarMappings. This module gives
 * each synced entity a thin typed handle:
 *
 *   resolveEntity(entityType, ids) -> {
 *     entityType, ids,
 *     getState()              -> the calendar-relevant entity snapshot (or null)
 *     applyDescriptor(desc)   -> apply a normalized calendar-sync descriptor
 *     touch(provider)         -> stamp last_synced_to_<provider> = now()
 *   }
 *
 * Inbound webhooks resolve the entity from a calendar_mappings row's
 * entity_type/entity_id/scope_id (NOT a Firestore docPath) via resolveFromMapping.
 */

const tasksRepo = require('../../tasks/tasks.repository');
const matterEventsRepo = require('../../matters/matterEvents.repository');
const clientEventsRepo = require('../../clients/clientEvents.repository');
const calendarEventsRepo = require('../calendarEvents.repository');
const invoicesRepo = require('../../billing/invoices/invoices.repository');

// ── descriptor normalization ────────────────────────────────────────────────
// The externalEvent adapter emits a couple of compound descriptors; expand them
// into the primitive ops the per-table appliers understand.

function expandExternalDescriptors(descriptor: any) {
  if (!descriptor) return [];
  if (descriptor.op === 'setField') {
    const ops: any[] = [{ op: 'setField', field: descriptor.field, value: descriptor.value }];
    if (descriptor.touch && descriptor.provider) ops.push({ op: 'touch', provider: descriptor.provider });
    return ops;
  }
  if (descriptor.op === 'setFields') {
    const ops: any[] = Object.entries(descriptor.fields || {}).map(([field, value]) => ({ op: 'setField', field, value }));
    if (descriptor.touch && descriptor.provider) ops.push({ op: 'touch', provider: descriptor.provider });
    return ops;
  }
  return [descriptor];
}

export class TaskEntity {

  entityType: any;


  id: any;


  lawFirmId: string;

  constructor(lawFirmId: string, id: any) { this.entityType = 'task'; this.lawFirmId = lawFirmId; this.id = id; }
  getState() { return tasksRepo.getCalendarState(this.lawFirmId, this.id); }
  applyDescriptor(d: any) { return tasksRepo.applyCalendarSync(this.lawFirmId, this.id, d); }
  touch(provider: any) { return tasksRepo.touchProviderSync(this.lawFirmId, this.id, provider); }
}

export class MatterEventEntity {

  entityType: any;


  id: any;


  lawFirmId: string;


  matterId: string;

  constructor(lawFirmId: string, matterId: string, id: any) { this.entityType = 'matterEvent'; this.lawFirmId = lawFirmId; this.matterId = matterId; this.id = id; }
  getState() { return matterEventsRepo.findById(this.lawFirmId, this.matterId, this.id); }
  applyDescriptor(d: any) { return matterEventsRepo.applyCalendarSync(this.lawFirmId, this.matterId, this.id, d); }
  touch(provider: any) { return matterEventsRepo.touchProviderSync(this.lawFirmId, this.matterId, this.id, provider); }
}

export class ClientEventEntity {

  entityType: any;


  id: any;


  lawFirmId: string;


  clientId: string;

  constructor(lawFirmId: string, clientId: string, id: any) { this.entityType = 'clientEvent'; this.lawFirmId = lawFirmId; this.clientId = clientId; this.id = id; }
  getState() { return clientEventsRepo.findById(this.lawFirmId, this.clientId, this.id); }
  applyDescriptor(d: any) { return clientEventsRepo.applyCalendarSync(this.lawFirmId, this.clientId, this.id, d); }
  touch(provider: any) { return clientEventsRepo.touchProviderSync(this.lawFirmId, this.clientId, this.id, provider); }
}

export class ExternalEventEntity {

  entityType: any;


  id: any;


  lawFirmId: string;

  constructor(lawFirmId: string, id: any) { this.entityType = 'externalEvent'; this.lawFirmId = lawFirmId; this.id = id; }
  getState() { return calendarEventsRepo.findById(this.lawFirmId, this.id); }
  async applyDescriptor(descriptor: any) {
    for (const op of expandExternalDescriptors(descriptor)) {
      if (op.op === 'setField') await calendarEventsRepo.setProviderField(this.lawFirmId, this.id, op.field, op.value);
      else if (op.op === 'deleteField') await calendarEventsRepo.setProviderField(this.lawFirmId, this.id, op.field, null);
      else if (op.op === 'touch') await calendarEventsRepo.touchProviderSync(this.lawFirmId, this.id, op.provider);
    }
  }
  touch(provider: any) { return calendarEventsRepo.touchProviderSync(this.lawFirmId, this.id, provider); }
}

export class InvoiceBillingEntity {

  entityType: any;


  id: any;


  context: any;

  constructor(context: any, id: any) { this.entityType = 'invoiceBilling'; this.context = context; this.id = id; }
  getState() { return invoicesRepo.getCalendarState(this.context, this.id); }
  applyDescriptor(d: any) { return invoicesRepo.applyCalendarSync(this.context, this.id, d); }
  touch(provider: any) { return invoicesRepo.applyCalendarSync(this.context, this.id, { op: 'touch', provider }); }
}

function invoiceContextFromData(data: any) {
  const type = data.contextType === 'matter' ? 'matter' : 'client';
  const entityId = type === 'matter'
    ? (data.entityId || data.matterId)
    : (data.entityId || data.clientContextId || data.clientId);
  return { lawFirmId: data.lawFirmId, type, entityId };
}

/** Resolve a typed entity handle from an adapter entityType + the entity data. */
export function resolveEntity(entityType: any, data: any) {
  switch (entityType) {
    case 'task':
      return new TaskEntity(data.lawFirmId, data.taskId || data.id);
    case 'matterEvent':
      return new MatterEventEntity(data.lawFirmId, data.matterId, data.id || data.eventId);
    case 'clientEvent':
      return new ClientEventEntity(data.lawFirmId, data.clientId, data.id || data.eventId);
    case 'externalEvent':
      return new ExternalEventEntity(data.lawFirmId, data.id || data.eventId);
    case 'invoiceBilling':
      return new InvoiceBillingEntity(invoiceContextFromData(data), data.id || data.invoiceId);
    default:
      throw new Error(`No calendar entity resolver for type: ${entityType}`);
  }
}

/**
 * Resolve a typed entity handle from a calendar_mappings row (inbound webhook
 * path; replaces the old path-router). scope_id carries matterId/clientId for nested
 * entities; for invoiceBilling it carries the context entityId (matter/client id).
 */
export function resolveFromMapping(mapping: any) {
  if (!mapping || !mapping.entityType) return null;
  const lawFirmId: string = mapping.lawFirmId;
  switch (mapping.entityType) {
    case 'task':
      return new TaskEntity(lawFirmId, mapping.entityId);
    case 'matterEvent':
      return new MatterEventEntity(lawFirmId, mapping.scopeId, mapping.entityId);
    case 'clientEvent':
      return new ClientEventEntity(lawFirmId, mapping.scopeId, mapping.entityId);
    case 'externalEvent':
      return new ExternalEventEntity(lawFirmId, mapping.entityId);
    case 'invoiceBilling': {
      // scope_id encodes "matter:<id>" / "client:<id>".
      const [type, entityId] = String(mapping.scopeId || '').split(':');
      const context: any = { lawFirmId, type: type === 'matter' ? 'matter' : 'client', entityId };
      return new InvoiceBillingEntity(context, mapping.entityId);
    }
    default:
      return null;
  }
}

/** Mapping persistence fields for an outbound-synced entity (entity_type/id/scope). */
export function mappingRefForEntity(entityType: any, data: any) {
  switch (entityType) {
    case 'task':
      return { entityType, entityId: data.taskId || data.id, scopeId: null };
    case 'matterEvent':
      return { entityType, entityId: data.id || data.eventId, scopeId: data.matterId };
    case 'clientEvent':
      return { entityType, entityId: data.id || data.eventId, scopeId: data.clientId };
    case 'externalEvent':
      return { entityType, entityId: data.id || data.eventId, scopeId: null };
    case 'invoiceBilling': {
      const ctx = invoiceContextFromData(data);
      return { entityType, entityId: data.id || data.invoiceId, scopeId: `${ctx.type}:${ctx.entityId}` };
    }
    default:
      return { entityType, entityId: data.id, scopeId: null };
  }
}

/**
 * The row behind one item of a batch "sync existing events" request, and the
 * adapter type that pushes it. An item names a matter event by `matterId` or a
 * client event by `clientId`. Both reads are scoped to the item's firm, so an
 * id from another firm resolves to nothing.
 */
export async function loadBatchEvent(item: any) {
  if (item.matterId) {
    const state = await matterEventsRepo.findById(item.lawFirmId, item.matterId, item.eventId);
    return state
      ? { entityType: 'matterEvent', state: { ...state, lawFirmId: item.lawFirmId, matterId: item.matterId } }
      : null;
  }
  if (item.clientId) {
    const state = await clientEventsRepo.findById(item.lawFirmId, item.clientId, item.eventId);
    return state
      ? { entityType: 'clientEvent', state: { ...state, lawFirmId: item.lawFirmId, clientId: item.clientId } }
      : null;
  }
  return null;
}
