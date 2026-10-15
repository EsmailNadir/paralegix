/**
 * The aggregates behind the client detail header, counted and summed in SQL.
 *
 * Both reads reproduce a list the client page used to fetch whole and reduce in
 * the browser, so each predicate below names the rule it mirrors. Visibility is
 * the matter wall every matter and billing list applies: `seeAll` (a firm owner
 * or admin) reads every matter, anyone else only the matters they are a member
 * of (`buildMatterListWhere` in matters.repository.ts).
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';

import {
  clientCompanyLinks,
  clients,
  invoices,
  matterClients,
  matterMembers,
  matters,
} from '../../shared/database/drizzle/schema';
import { tenantQuery } from '../../shared/database/queryContext';
import { resolveBillingEffectiveClientIds } from './clientCompanyLinks.util';

interface ScopeInput {
  lawFirmId: string;
  userId: string;
  clientId: string;
  seeAll: boolean;
}

/** The matter wall, as a predicate over `matters`. Undefined when the caller sees every matter. */
function visibleMatter(userId: string, seeAll: boolean): SQL | undefined {
  if (seeAll) return undefined;
  return sql`exists (select 1 from ${matterMembers}
                      where ${matterMembers.matterId} = ${matters.id}
                        and ${matterMembers.userId} = ${userId})`;
}

/**
 * How many visible matters the client is on, directly or through a company the
 * client is linked to as a person.
 *
 * Mirrors the Matters list the page read (`GET /matters?clientId=`, which widens
 * the client to its linked companies via `resolveEffectiveClientIds`) narrowed
 * by the page's `deriveClientMatters`: a matter the client is on, or one carrying
 * a linked company. A company client has no person links, so it counts only its
 * own matters. No status filter: every status counts.
 */
export async function countClientMatters({ lawFirmId, userId, clientId, seeAll }: ScopeInput): Promise<number> {
  const rows = await tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor
    .select({ count: sql<number>`count(*)::int` })
    .from(matters)
    .where(and(
      scope,
      visibleMatter(userId, seeAll),
      sql`${matters.id} in (
        select ${matterClients.matterId} from ${matterClients}
         where ${matterClients.lawFirmId} = ${lawFirmId}
           and (${matterClients.clientId} = ${clientId}
                or ${matterClients.clientId} in (
                  select ${clientCompanyLinks.companyClientId}
                    from ${clientCompanyLinks}
                    join ${clients} on ${clients.id} = ${clientCompanyLinks.companyClientId}
                                   and ${clients.lawFirmId} = ${clientCompanyLinks.lawFirmId}
                   where ${clientCompanyLinks.lawFirmId} = ${lawFirmId}
                     and ${clientCompanyLinks.personClientId} = ${clientId}
                     and ${clients.clientType} = 'company'))
      )`,
    )));
  return Number(rows[0]?.count ?? 0);
}

/**
 * Invoice count and owned money totals, in integer cents.
 *
 * The invoice set is the one the client's Billing tab lists (`clientScope`): the
 * client's own direct invoices and those of every company the client is linked
 * to with billing access (`resolveBillingEffectiveClientIds`), plus every
 * invoice on a visible matter any of them is on.
 *
 * "Owned" mirrors `classifyInvoiceForClient`: a direct invoice belongs to the
 * client whose context it is (a linked company's own invoices are shown for
 * context, not owned), and a matter invoice belongs to the client it is billed
 * to (`client_id`, falling back to `matter_client_id`). The billed amount is the
 * invoice's stored total, the same canonical figure `invoiceTotalCents` bills
 * from: a zero total stays zero even when flat fees are recorded. Outstanding is each owned invoice's own balance (total
 * less paid less written off, floored at zero), summed, so credit on one
 * over-settled invoice never offsets another. A voided invoice is still counted in
 * `invoiceCount` (the list shows the row) but carries no money: it was cancelled,
 * so it is neither billed nor owed, which is what the client's billing tab states
 * too.
 */
export async function sumClientInvoices({ lawFirmId, userId, clientId, seeAll }: ScopeInput) {
  const scopeIds = (await resolveBillingEffectiveClientIds(lawFirmId, clientId)).clientIds;
  const scopeIdList = sql.join(scopeIds.map((id) => sql`${id}`), sql`, `);
  const owned = sql`(${invoices.status} <> 'voided'
    and ((${invoices.matterId} is null and ${invoices.clientContextId} = ${clientId})
      or (${invoices.matterId} is not null
        and coalesce(${invoices.clientId}, ${invoices.matterClientId}) = ${clientId})))`;
  const effectiveTotal = sql`${invoices.totalCents}`;
  const wall = seeAll
    ? sql`true`
    : sql`exists (select 1 from ${matterMembers}
                   where ${matterMembers.matterId} = ${invoices.matterId}
                     and ${matterMembers.userId} = ${userId})`;

  const rows = await tenantQuery(invoices, lawFirmId, ({ executor, scope }) => executor
    .select({
      invoiceCount: sql<number>`count(*)::int`,
      totalBilledCents: sql<string>`coalesce(sum(case when ${owned} then ${effectiveTotal} else 0 end), 0)::bigint`,
      totalPaidCents: sql<string>`coalesce(sum(case when ${owned} then ${invoices.amountPaidCents} else 0 end), 0)::bigint`,
      outstandingCents: sql<string>`coalesce(sum(case when ${owned}
        then greatest(0, ${effectiveTotal} - ${invoices.amountPaidCents} - ${invoices.totalWrittenOffCents})
        else 0 end), 0)::bigint`,
    })
    .from(invoices)
    .where(and(
      scope,
      sql`(
        (${invoices.matterId} is null and ${invoices.clientContextId} in (${scopeIdList}))
        or (${invoices.matterId} is not null
            and ${wall}
            and exists (select 1 from ${matterClients}
                         where ${matterClients.lawFirmId} = ${lawFirmId}
                           and ${matterClients.matterId} = ${invoices.matterId}
                           and ${matterClients.clientId} in (${scopeIdList})))
      )`,
    )));

  const row = rows[0];
  return {
    invoiceCount: Number(row?.invoiceCount ?? 0),
    totalBilledCents: Number(row?.totalBilledCents ?? 0),
    totalPaidCents: Number(row?.totalPaidCents ?? 0),
    outstandingCents: Number(row?.outstandingCents ?? 0),
  };
}

/** Whether the client exists in this firm. */
export async function clientExists(lawFirmId: string, clientId: string): Promise<boolean> {
  const rows = await tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor
    .select({ id: clients.id })
    .from(clients)
    .where(and(scope, eq(clients.id, clientId)))
    .limit(1));
  return rows.length > 0;
}
