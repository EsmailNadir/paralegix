/**
 * The reads behind a matter's document context (GET .../document-context).
 * Each is scoped to the caller's firm through an audited tenant context, keyed
 * by ids the service has already confirmed belong to that firm, and bounded.
 *
 * Exported one function per source so the service can mark the context
 * incomplete when one billing read fails without losing the rest.
 */
import { and, asc, desc, eq, inArray, isNotNull, or } from 'drizzle-orm';
import {
  activities,
  billingPlans,
  clients,
  contacts,
  courts,
  events,
  invoiceExpectedPayments,
  invoiceLineItems,
  invoicePayments,
  invoices,
  lawFirms,
  matterClients,
  matterContacts,
  matterFieldDefs,
  matters,
  practiceAreas,
  users,
} from '../../shared/database/drizzle/schema';
import { firmQuery, tenantQuery } from '../../shared/database/queryContext';
import { isUuid } from '../../shared/utils/isUuid';

// A matter's own rows: far past any one matter, and still a bound.
const ROW_CAP = 2000;

export async function loadFirm(lawFirmId: string) {
  const rows = await firmQuery(lawFirms, lawFirmId, ({ executor, scope }) => executor
    .select({
      name: lawFirms.name,
      address: lawFirms.address,
      city: lawFirms.city,
      state: lawFirms.state,
      zip: lawFirms.zip,
      phone: lawFirms.phone,
      email: lawFirms.email,
      settings: lawFirms.settings,
    })
    .from(lawFirms).where(scope).limit(1));
  return rows[0] ?? null;
}

/** The matter with its court, practice area and lead attorney, or null. */
export async function loadMatter(lawFirmId: string, matterId: string) {
  if (!isUuid(matterId)) return null;
  const rows = await tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor
    .select({
      id: matters.id,
      name: matters.name,
      matterNumber: matters.matterNumber,
      matterReferenceId: matters.matterReferenceId,
      description: matters.description,
      status: matters.status,
      category: matters.category,
      openDate: matters.openDate,
      createdAt: matters.createdAt,
      statuteOfLimitationsDate: matters.statuteOfLimitationsDate,
      customFields: matters.customFields,
      leadUserId: matters.leadUserId,
      leadUserName: users.name,
      leadUserEmail: users.email,
      practiceAreaName: practiceAreas.name,
      courtName: courts.name,
      courtAddress: courts.address,
      courtCity: courts.city,
      courtState: courts.state,
    })
    .from(matters)
    .leftJoin(users, eq(users.id, matters.leadUserId))
    .leftJoin(practiceAreas, and(eq(practiceAreas.lawFirmId, matters.lawFirmId), eq(practiceAreas.id, matters.practiceAreaId)))
    .leftJoin(courts, and(eq(courts.lawFirmId, matters.lawFirmId), eq(courts.id, matters.courtId)))
    .where(and(scope, eq(matters.id, matterId)))
    .limit(1));
  return rows[0] ?? null;
}

const clientColumns = {
  id: clients.id,
  name: clients.name,
  email: clients.email,
  phone: clients.phone,
  address: clients.address,
  organization: clients.organization,
  preferredContactMethod: clients.preferredContactMethod,
};

/** The matter's clients, first linked first. */
export async function listMatterClients(lawFirmId: string, matterId: string) {
  return tenantQuery(matterClients, lawFirmId, ({ executor, scope }) => executor
    .select(clientColumns)
    .from(matterClients)
    .innerJoin(clients, and(eq(clients.lawFirmId, matterClients.lawFirmId), eq(clients.id, matterClients.clientId)))
    .where(and(scope, eq(matterClients.matterId, matterId)))
    .orderBy(asc(matterClients.createdAt), asc(clients.name))
    .limit(ROW_CAP));
}

export async function loadClient(lawFirmId: string, clientId: string) {
  if (!isUuid(clientId)) return null;
  const rows = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor
    .select(clientColumns).from(clients).where(and(scope, eq(clients.id, clientId))).limit(1));
  return rows[0] ?? null;
}

/** The firm's live custom matter field definitions. */
export async function listCustomFieldDefs(lawFirmId: string) {
  return tenantQuery(matterFieldDefs, lawFirmId, ({ executor, scope }) => executor
    .select({ id: matterFieldDefs.id, label: matterFieldDefs.label, field_type: matterFieldDefs.fieldType })
    .from(matterFieldDefs)
    .where(and(scope, eq(matterFieldDefs.archived, false)))
    .orderBy(asc(matterFieldDefs.sortOrder), asc(matterFieldDefs.id))
    .limit(ROW_CAP));
}

/** Directory contacts on the matter in the roles a document names. */
export async function listMatterParties(lawFirmId: string, matterId: string) {
  return tenantQuery(matterContacts, lawFirmId, ({ executor, scope }) => executor
    .select({ role: matterContacts.role, name: contacts.name, email: contacts.email })
    .from(matterContacts)
    .innerJoin(contacts, and(eq(contacts.lawFirmId, matterContacts.lawFirmId), eq(contacts.id, matterContacts.contactId)))
    .where(and(scope, eq(matterContacts.matterId, matterId),
      inArray(matterContacts.role, ['judge', 'opposing_party', 'opposing_counsel'])))
    .orderBy(asc(matterContacts.sortOrder), asc(matterContacts.createdAt))
    .limit(ROW_CAP));
}

/** The matter's dated events, soonest first. */
export async function listMatterEvents(lawFirmId: string, matterId: string) {
  return tenantQuery(events, lawFirmId, ({ executor, scope }) => executor
    .select({
      type: events.type,
      title: events.title,
      status: events.status,
      date: events.date,
      location: events.location,
      locationName: events.locationName,
    })
    .from(events)
    .where(and(scope, eq(events.matterId, matterId), isNotNull(events.date)))
    .orderBy(asc(events.date))
    .limit(ROW_CAP));
}

/** Every invoice on the matter, newest first. */
export async function listMatterInvoices(lawFirmId: string, matterId: string) {
  return tenantQuery(invoices, lawFirmId, ({ executor, scope }) => executor
    .select({
      id: invoices.id,
      status: invoices.status,
      totalCents: invoices.totalCents,
      amountPaidCents: invoices.amountPaidCents,
      balanceDueCents: invoices.balanceDueCents,
      totalHours: invoices.totalHours,
      isPaid: invoices.isPaid,
      dueDate: invoices.dueDate,
      planDownPaymentCents: invoices.planDownPaymentCents,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .where(and(scope, eq(invoices.matterId, matterId)))
    .orderBy(desc(invoices.createdAt), desc(invoices.id))
    .limit(ROW_CAP));
}

/** Scheduled payments of these invoices, in plan order. */
export async function listExpectedPayments(lawFirmId: string, invoiceIds: string[]) {
  if (invoiceIds.length === 0) return [];
  return tenantQuery(invoiceExpectedPayments, lawFirmId, ({ executor, scope }) => executor
    .select({
      invoiceId: invoiceExpectedPayments.invoiceId,
      amountCents: invoiceExpectedPayments.amountCents,
      dueDate: invoiceExpectedPayments.dueDate,
      status: invoiceExpectedPayments.status,
    })
    .from(invoiceExpectedPayments)
    .where(and(scope, inArray(invoiceExpectedPayments.invoiceId, invoiceIds)))
    .orderBy(asc(invoiceExpectedPayments.invoiceId), asc(invoiceExpectedPayments.sortOrder), asc(invoiceExpectedPayments.dueDate))
    .limit(ROW_CAP));
}

/** Payments received against these invoices, oldest first. */
export async function listInvoicePayments(lawFirmId: string, invoiceIds: string[]) {
  if (invoiceIds.length === 0) return [];
  return tenantQuery(invoicePayments, lawFirmId, ({ executor, scope }) => executor
    .select({
      amountCents: invoicePayments.amountCents,
      paymentDate: invoicePayments.paymentDate,
      paymentSource: invoicePayments.paymentSource,
    })
    .from(invoicePayments)
    .where(and(scope, inArray(invoicePayments.invoiceId, invoiceIds), isNotNull(invoicePayments.paymentDate)))
    .orderBy(asc(invoicePayments.paymentDate), asc(invoicePayments.sortOrder))
    .limit(ROW_CAP));
}

/** The matter's billable activities of one kind. */
export async function listBillableActivities(lawFirmId: string, matterId: string, kind: 'time' | 'expense' | 'flat_fee') {
  return tenantQuery(activities, lawFirmId, ({ executor, scope }) => executor
    .select({
      id: activities.id,
      amountCents: activities.amountCents,
      description: activities.description,
      activityDate: activities.activityDate,
    })
    .from(activities)
    .where(and(scope, eq(activities.matterId, matterId), eq(activities.kind, kind), eq(activities.billable, true)))
    .orderBy(asc(activities.activityDate), asc(activities.id))
    .limit(ROW_CAP));
}

/** The invoices each of these activities is billed on (a line item's source). */
export async function invoiceIdsForActivities(lawFirmId: string, activityIds: string[]) {
  if (activityIds.length === 0) return new Map<string, string>();
  const rows = await tenantQuery(invoiceLineItems, lawFirmId, ({ executor, scope }) => executor
    .select({ sourceId: invoiceLineItems.sourceId, invoiceId: invoiceLineItems.invoiceId })
    .from(invoiceLineItems)
    .where(and(scope, inArray(invoiceLineItems.sourceId, activityIds)))
    .limit(ROW_CAP));
  return new Map(rows.filter((r) => r.sourceId).map((r) => [r.sourceId as string, r.invoiceId]));
}

/** A client's trust balance across the firm's accounts; null with no ledger. */
export async function clientTrustBalanceCents(lawFirmId: string, clientId: string): Promise<number | null> {
  const { trustTxnRepo } = require('../trust/trust.repository');
  const byAccount: Map<string, number> = await trustTxnRepo.computeClientBalancesByAccount(lawFirmId, clientId);
  if (byAccount.size === 0) return null;
  let total = 0;
  for (const cents of byAccount.values()) total += cents;
  return total;
}

/** Amounts of the active retainer plans on the matter, and on the client. */
export async function listActiveRetainers(lawFirmId: string, matterId: string | null, clientId: string | null) {
  const owners = [
    matterId ? eq(billingPlans.matterId, matterId) : null,
    clientId ? eq(billingPlans.clientId, clientId) : null,
  ].filter((o): o is NonNullable<typeof o> => o !== null);
  if (owners.length === 0) return [];
  return tenantQuery(billingPlans, lawFirmId, ({ executor, scope }) => executor
    .select({ matterId: billingPlans.matterId, clientId: billingPlans.clientId, amountCents: billingPlans.amountCents })
    .from(billingPlans)
    .where(and(scope, eq(billingPlans.planType, 'retainer'), eq(billingPlans.status, 'active'),
      or(...owners)))
    .limit(ROW_CAP));
}

/** The lead attorney's effective hourly rate on the matter, in cents. */
export async function leadHourlyRateCents(lawFirmId: string, matterId: string, userId: string | null): Promise<number | null> {
  if (!userId) return null;
  const { resolveEntryRate } = require('../billing/shared/billingReads');
  const { resolvedRateCents } = await resolveEntryRate(lawFirmId, {
    contextType: 'matter', entityId: matterId, userId, chargeCodeId: null, hourlyRate: null,
  });
  return resolvedRateCents ?? null;
}
