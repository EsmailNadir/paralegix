/**
 * The Firebase uids linked to a company's clients that should receive a given
 * category of client-facing notification: every `client_company_links` row
 * for the company, joined to its linked Person `clients` row's portal user
 * (`user_id`), minus anyone who explicitly turned that category off in their
 * own settings.
 *
 * Extracted from trust.events.ts's original `eligibleCompanyPortalUserIds`
 * (organization-clients plan Phase 6) so every notification category that
 * needs to fan out to a company's linked people shares one query and one
 * opt-out rule, instead of each event handler re-deriving it (Phase 7).
 *
 * Preferences live on the linked person's own client record
 * (`clients.settings`), one shared blob per person - a company-linked person
 * is a real standalone client now, not a per-link preference row, so muting a
 * category applies everywhere they're linked, same as any other client
 * setting. Absent key means enabled (opt-out, not opt-in) - callers that pass
 * no `preferenceKey` get every linked, portal-enabled uid unfiltered, which
 * is the right default for a category with no toggle yet.
 *
 * `requireBillingAccess` narrows the fan-out to links whose `can_view_billing`
 * is on. Pass it for anything whose title or body states the company's money:
 * an invoice, a balance, a trust ledger figure. Those are exactly the values
 * `assertCanViewBilling` refuses to serve a link without the flag, so a
 * notification carrying one is the same disclosure through a different door,
 * and its action link lands the reader on a route that answers 403.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { clientCompanyLinks, clients } from '../../shared/database/drizzle/schema';
import { tenantQuery } from '../../shared/database/queryContext';

export async function eligibleCompanyPortalUserIds(
  lawFirmId: string,
  clientId: string,
  preferenceKey: string | null = null,
  { requireBillingAccess = false }: { requireBillingAccess?: boolean } = {},
): Promise<string[]> {
  if (!lawFirmId || !clientId) return [];
  const rows = await tenantQuery(clientCompanyLinks, lawFirmId, ({ executor, scope }) => executor
    .select({ userId: clients.userId, settings: clients.settings })
    .from(clientCompanyLinks)
    .innerJoin(clients, and(
      eq(clients.id, clientCompanyLinks.personClientId),
      eq(clients.lawFirmId, clientCompanyLinks.lawFirmId),
    ))
    .where(and(
      scope,
      eq(clientCompanyLinks.companyClientId, clientId),
      isNotNull(clients.userId),
      requireBillingAccess ? eq(clientCompanyLinks.canViewBilling, true) : undefined,
    )));

  const userIds = (rows as any[])
    .filter((row) => !preferenceKey || row.settings?.notifications?.[preferenceKey] !== false)
    .map((row) => row.userId)
    .filter(Boolean);
  return Array.from(new Set(userIds));
}
