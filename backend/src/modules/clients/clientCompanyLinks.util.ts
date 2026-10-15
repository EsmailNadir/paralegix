/**
 * Resolve which client ids a person client's items should be widened across:
 * their own id plus every company they're linked to via
 * `client_company_links` (migration `0174_client_company_links.sql`).
 *
 * Lives outside `clients.service.ts` (rather than being defined there and
 * imported by tasks/matters/billing) so those modules, which are not
 * siblings of clients and don't otherwise depend on it, can use the
 * resolver without risking a circular require back into the clients module.
 * `clients.service.ts` itself re-exports these next to
 * `listClientCompanyRelationships`, since the two read the same table.
 */

import { and, asc, eq, type SQL } from 'drizzle-orm';
import { clientCompanyLinks, clients } from '../../shared/database/drizzle/schema';
import { tenantQuery } from '../../shared/database/queryContext';

const { isUuid } = require('../../shared/utils/isUuid');

export interface EffectiveClientIds {
  /** `[clientId, ...linkedCompanyIds]`. Just `[clientId]` when there are no links. */
  clientIds: string[];
  /** companyClientId -> company name, for badging widened items in the UI. */
  companyNames: Map<string, string>;
}

async function resolveLinkedCompanies(
  lawFirmId: string,
  clientId: string,
  extra: SQL | undefined,
): Promise<EffectiveClientIds> {
  // `client_company_links.person_client_id` is a uuid column, so a malformed
  // client id reaches Postgres as a cast error. This resolver runs BEFORE the
  // caller's own existence check on several read paths (the client notes list
  // among them), so an unguarded value surfaced as a 500 rather than the 404
  // that check would have produced. A non-uuid can never be linked to anything,
  // so widen across nothing and let the caller answer.
  if (!isUuid(clientId)) return { clientIds: [clientId], companyNames: new Map() };
  const rows = await tenantQuery(clientCompanyLinks, lawFirmId, ({ executor, scope }) => executor
    .select({
      companyClientId: clientCompanyLinks.companyClientId,
      companyName: clients.name,
    })
    .from(clientCompanyLinks)
    .innerJoin(clients, and(
      eq(clients.id, clientCompanyLinks.companyClientId),
      eq(clients.lawFirmId, clientCompanyLinks.lawFirmId),
    ))
    .where(and(
      scope,
      eq(clientCompanyLinks.personClientId, clientId),
      eq(clients.clientType, 'company'),
      extra,
    ))
    .orderBy(asc(clients.name)));

  const clientIds = [clientId];
  const companyNames = new Map<string, string>();
  for (const row of rows as { companyClientId: string; companyName: string | null }[]) {
    clientIds.push(row.companyClientId);
    companyNames.set(row.companyClientId, row.companyName || '');
  }
  return { clientIds, companyNames };
}

/**
 * Every client id a person client's items should be widened across: their own
 * id plus all linked companies, primary or not. A company id (or a person with
 * no links) naturally resolves to just `[clientId]`, since a company id can never
 * appear as someone's `person_client_id` (`client_company_links_not_self` plus
 * the service-layer type check on insert already guarantee that), so no
 * special-casing is needed for "is this actually a person."
 */
export async function resolveEffectiveClientIds(
  lawFirmId: string,
  clientId: string,
): Promise<EffectiveClientIds> {
  return resolveLinkedCompanies(lawFirmId, clientId, undefined);
}

/**
 * Same as `resolveEffectiveClientIds`, narrowed to companies where THIS
 * person's own link grants `can_view_billing`. Used for billing-sensitive
 * widening (invoices); Time Tracking widens unconditionally via
 * `resolveEffectiveClientIds` instead, since it isn't billing-sensitive.
 */
export async function resolveBillingEffectiveClientIds(
  lawFirmId: string,
  clientId: string,
): Promise<EffectiveClientIds> {
  return resolveLinkedCompanies(lawFirmId, clientId, eq(clientCompanyLinks.canViewBilling, true));
}
