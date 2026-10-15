import { and, asc, eq, inArray } from 'drizzle-orm';
import { createBoundedCache } from '../../../shared/utils/boundedCache';
import { clientCompanyLinks, clients } from '../../../shared/database/drizzle/schema';
import { systemQuery, tenantQuery } from '../../../shared/database/queryContext';

const { AppError, ForbiddenError } = require('../../../shared/errors/AppError');

/**
 * One Firebase user's relationship to one legal client record within one firm.
 *
 * A person client is authenticated by `clients.user_id`. A company client's
 * people are their own standalone Person `clients` rows (also authenticated
 * by `clients.user_id`), linked to the company via `client_company_links`
 * (migration 0174, replacing the old `contact_clients` roster model).
 * `userId` never changes what the association means: it is always the
 * Firebase uid, never `clients.id`/`client_company_links.id`.
 */
export type ClientAssociation = {
  clientRecordId: string;
  clientType: 'person' | 'company';
  clientName: string;
  userId: string;
  companyLinkId: string | null;
  canViewBilling: boolean;
  portalSettings: Record<string, unknown>;
};

export const CLIENT_SELECTION_REQUIRED_CODE = 'CLIENT_SELECTION_REQUIRED';

function uniq(values: any[]): any[] {
  return Array.from(new Set((values || []).filter(Boolean)));
}

// Person clients have no `can_view_billing` flag of their own: the person IS
// the billing principal, so their portal access to their own invoices is
// unconditional. Only a company association's billing view is gated by an
// explicit flag (client_company_links.can_view_billing).
const PERSON_CAN_VIEW_BILLING = true;

/**
 * Person arm: `clients.user_id = userId`, `client_type = 'person'` by
 * construction (the `clients_company_no_user_id_check` DB trigger guarantees
 * a row carrying `user_id` is a person row).
 *
 * `clients.user_id` carries no unique constraint, so this takes every match
 * rather than assuming exactly one; in practice the existing create/link
 * flows (`clientIdentityLinking.service.ts`) only ever produce at most one.
 * This is also the seed for the company arm below: every company a uid is
 * linked to is reached by walking `client_company_links.person_client_id`
 * off THESE rows' ids, since a company-linked person is now a genuine Person
 * client rather than a directory contact.
 */
async function fetchPersonRows(lawFirmId: string, userId: string): Promise<any[]> {
  return tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor
    .select({
      id: clients.id,
      name: clients.name,
      settings: clients.settings,
      createdAt: clients.createdAt,
    })
    .from(clients)
    .where(and(scope, eq(clients.userId, userId)))
    .orderBy(asc(clients.createdAt), asc(clients.id)));
}

function buildPersonAssociations(personRows: any[], userId: string): ClientAssociation[] {
  return personRows.map((row) => ({
    clientRecordId: row.id,
    clientType: 'person' as const,
    clientName: row.name,
    userId,
    companyLinkId: null,
    canViewBilling: PERSON_CAN_VIEW_BILLING,
    portalSettings: (row.settings || {}) as Record<string, unknown>,
  }));
}

/**
 * Company arm: `client_company_links.person_client_id in (<this uid's person
 * client ids>)`, joined to the linked company's `clients` row. Deliberately
 * keyed off the uid's own Person client id (never off email), so a portal
 * login can never pick up company access it was not explicitly linked to
 * (the plan's "Email matching never grants company access" rule carries
 * over unchanged from the `contact_clients` model).
 *
 * `portalSettings` is no longer a per-link column: it is read once from the
 * person's own `clients.settings` and reused for every company association
 * below. A person linked to N companies now shares one settings blob - an
 * intentional simplification of the old per-roster-link storage, since the
 * person themselves is the one authenticating, not the link.
 *
 * Ordered by the company's `clients.created_at`/`id` so multiple company
 * associations for the same uid come back in a stable order.
 */
async function fetchCompanyAssociations(lawFirmId: string, userId: string, personRows: any[]): Promise<ClientAssociation[]> {
  const personIds = personRows.map((row) => row.id);
  if (!personIds.length) return [];
  const portalSettings = (personRows[0].settings || {}) as Record<string, unknown>;

  const rows = await tenantQuery(clientCompanyLinks, lawFirmId, ({ executor, scope }) => executor
    .select({
      linkId: clientCompanyLinks.id,
      companyClientId: clients.id,
      companyName: clients.name,
      canViewBilling: clientCompanyLinks.canViewBilling,
      companyCreatedAt: clients.createdAt,
    })
    .from(clientCompanyLinks)
    .innerJoin(clients, and(
      eq(clients.id, clientCompanyLinks.companyClientId),
      eq(clients.lawFirmId, clientCompanyLinks.lawFirmId),
    ))
    .where(and(scope, inArray(clientCompanyLinks.personClientId, personIds), eq(clients.clientType, 'company')))
    .orderBy(asc(clients.createdAt), asc(clients.id)));

  return rows.map((row: any) => ({
    clientRecordId: row.companyClientId,
    clientType: 'company' as const,
    clientName: row.companyName,
    userId,
    companyLinkId: row.linkId,
    canViewBilling: Boolean(row.canViewBilling),
    portalSettings,
  }));
}

// Short-TTL memoization, mirroring portal.service.ts's accessContextCache: a
// single portal page load fans out to several endpoints that each
// independently resolve the same association set. Keyed by (lawFirmId,
// userId) - the coarsest key that is still exact, since every association a
// resolve call could return is already scoped to that pair and each entry in
// the cached array carries its own clientRecordId for any narrower,
// scoped-to-one-client lookup a caller makes in memory.
const ASSOCIATION_CACHE_TTL_MS = 5000;

/**
 * Entries held per cache.
 *
 * The keys are a firm and a user, so both maps grow with the customer base.
 * The short TTL did not bound them: expiry was lazy, and the sweep it relied on
 * only ran once the map had already passed 500 and only removed entries that
 * had already expired, so a burst of distinct portal users inside one TTL
 * window grew it without limit. The ceiling evicts the least recently used
 * entry instead, which costs one association resolve.
 */
const ASSOCIATION_CACHE_MAX_ENTRIES = Number(process.env.ASSOCIATION_CACHE_MAX_ENTRIES) || 2000;

const associationCache = createBoundedCache<ClientAssociation[]>({
  name: 'clientAssociations',
  maxEntries: ASSOCIATION_CACHE_MAX_ENTRIES,
  ttlMs: ASSOCIATION_CACHE_TTL_MS,
});

// Batch cache for the cross-firm resolve used by /my-lawfirms-style aggregate
// reads. Keyed by userId alone (it spans every firm), value is keyed by
// lawFirmId.
const crossFirmAssociationCache = createBoundedCache<Map<string, ClientAssociation[]>>({
  name: 'crossFirmClientAssociations',
  maxEntries: ASSOCIATION_CACHE_MAX_ENTRIES,
  ttlMs: ASSOCIATION_CACHE_TTL_MS,
});

/**
 * Resolve every association the given Firebase uid has to client records in
 * one firm, across both arms. Ordering is deterministic: the (at most one, in
 * practice) person association first, then company associations ordered by
 * the company client's `created_at`/`id`.
 */
export async function resolveClientAssociations({ lawFirmId, userId }: any): Promise<ClientAssociation[]> {
  if (!lawFirmId || !userId) return [];
  const cacheKey = `${lawFirmId}::${userId}`;
  const cached = associationCache.get(cacheKey);
  if (cached) return cached;

  const personRows = await fetchPersonRows(lawFirmId, userId);
  const personAssociations = buildPersonAssociations(personRows, userId);
  const companyAssociations = await fetchCompanyAssociations(lawFirmId, userId, personRows);
  const associations = [...personAssociations, ...companyAssociations];

  associationCache.set(cacheKey, associations);
  return associations;
}

/**
 * Batch equivalent of `resolveClientAssociations` for every firm one uid
 * belongs to, for `/my-lawfirms`-style aggregate reads. Two unscoped queries
 * total (one per arm) instead of one query pair per firm, so a client on many
 * firms doesn't turn discovery into an N+1 fan-out.
 *
 * The company-arm query filters by `person_client_id in (...)` with no
 * additional firm predicate: those ids came from the uid's own person rows
 * (each globally unique), and the join back to `clients` already re-asserts
 * `law_firm_id` agreement between the link and its company - the same safety
 * property the old `contact_clients.user_id` unscoped query had.
 */
async function resolveClientAssociationsAcrossFirms(userId: string): Promise<Map<string, ClientAssociation[]>> {
  if (!userId) return new Map();
  const cached = crossFirmAssociationCache.get(userId);
  if (cached) return cached;

  const personRows = await systemQuery('auth_identity', (executor) => executor
    .select({
      lawFirmId: clients.lawFirmId,
      id: clients.id,
      name: clients.name,
      settings: clients.settings,
      createdAt: clients.createdAt,
    })
    .from(clients)
    .where(eq(clients.userId, userId))
    .orderBy(asc(clients.createdAt), asc(clients.id)));

  const personIds = (personRows as any[]).map((row) => row.id);
  const companyRows = personIds.length
    ? await systemQuery('auth_identity', (executor) => executor
      .select({
        lawFirmId: clientCompanyLinks.lawFirmId,
        linkId: clientCompanyLinks.id,
        personClientId: clientCompanyLinks.personClientId,
        companyClientId: clients.id,
        companyName: clients.name,
        canViewBilling: clientCompanyLinks.canViewBilling,
        companyCreatedAt: clients.createdAt,
      })
      .from(clientCompanyLinks)
      .innerJoin(clients, and(
        eq(clients.id, clientCompanyLinks.companyClientId),
        eq(clients.lawFirmId, clientCompanyLinks.lawFirmId),
      ))
      .where(and(inArray(clientCompanyLinks.personClientId, personIds), eq(clients.clientType, 'company')))
      .orderBy(asc(clients.createdAt), asc(clients.id)))
    : [];

  // A company association reuses the SAME person's portalSettings it's
  // linked from (see fetchCompanyAssociations' doc), keyed here by
  // personClientId so each company row can look its own person back up.
  const settingsByPersonId = new Map<string, Record<string, unknown>>();
  for (const row of personRows as any[]) settingsByPersonId.set(row.id, (row.settings || {}) as Record<string, unknown>);

  const byFirm = new Map<string, ClientAssociation[]>();

  // Person rows first, across every firm, so within each firm's list the
  // person association (if any) sorts before its company associations -
  // matching resolveClientAssociations' per-firm ordering.
  for (const row of personRows as any[]) {
    const list = byFirm.get(row.lawFirmId) || [];
    list.push({
      clientRecordId: row.id,
      clientType: 'person',
      clientName: row.name,
      userId,
      companyLinkId: null,
      canViewBilling: PERSON_CAN_VIEW_BILLING,
      portalSettings: (row.settings || {}) as Record<string, unknown>,
    });
    byFirm.set(row.lawFirmId, list);
  }
  for (const row of companyRows as any[]) {
    const list = byFirm.get(row.lawFirmId) || [];
    list.push({
      clientRecordId: row.companyClientId,
      clientType: 'company',
      clientName: row.companyName,
      userId,
      companyLinkId: row.linkId,
      canViewBilling: Boolean(row.canViewBilling),
      portalSettings: settingsByPersonId.get(row.personClientId) || {},
    });
    byFirm.set(row.lawFirmId, list);
  }

  crossFirmAssociationCache.set(userId, byFirm);
  return byFirm;
}

/**
 * Every lawFirmId this uid holds a person or company association in. A thin
 * projection of `resolveClientAssociationsAcrossFirms` for discovery-only
 * callers (e.g. `/my-lawfirms`) that don't need the association payload
 * itself.
 */
export async function findLawFirmIdsForUserAssociations(userId: string): Promise<string[]> {
  const byFirm = await resolveClientAssociationsAcrossFirms(userId);
  return uniq(Array.from(byFirm.keys()));
}

/**
 * Invalidate the memoized associations for one (firm, uid) pair, and the
 * cross-firm batch entry for that uid (it would otherwise keep serving this
 * firm's now-stale associations for the remainder of its own TTL). Call this
 * from firm-side mutations that change a client's or a company link's
 * association state: portal access revoke/grant, company link create/update/
 * remove, and client deletion. No-op when `userId` is empty (placeholder /
 * not-yet-portal-linked rows have nothing cached).
 */
export function invalidateClientAssociations({ lawFirmId, userId }: any) {
  if (!userId) return;
  if (lawFirmId) associationCache.delete(`${lawFirmId}::${userId}`);
  crossFirmAssociationCache.delete(userId);
}

/**
 * Apply the plan's "Portal selection contract" resolution rules to an already
 * -resolved association list:
 *
 * 1. `clientRecordId` provided -> require an exact match among the resolved
 *    associations, else 403.
 * 2. `clientRecordId` omitted, exactly one association -> use it.
 * 3. `clientRecordId` omitted, multiple associations -> 400
 *    `CLIENT_SELECTION_REQUIRED`.
 * 4. Never fall back to an arbitrary first association.
 */
export function selectActiveClientAssociation(
  associations: ClientAssociation[],
  clientRecordId?: string | null,
): ClientAssociation {
  if (clientRecordId) {
    const match = associations.find((association) => association.clientRecordId === clientRecordId);
    if (!match) {
      throw new ForbiddenError('Access denied: You are not associated with this client record');
    }
    return match;
  }

  if (associations.length === 1) return associations[0];

  if (associations.length === 0) {
    throw new ForbiddenError('Access denied: You are not associated with this law firm');
  }

  throw new AppError(
    'You are associated with more than one client record in this law firm. Select which one to use.',
    400,
    CLIENT_SELECTION_REQUIRED_CODE,
  );
}



/**
 * Drop every memoized association.
 *
 * Exported for the in-process test suite, which changes roster membership far
 * faster than ASSOCIATION_CACHE_TTL_MS and would otherwise read a set resolved
 * before the change. That is worse than a slow test: a stale hit makes an
 * assertion pass against data the change should have invalidated.
 *
 * Production has no caller. Invalidation there is the TTL, deliberately.
 */
export function __resetAssociationCaches(): void {
  associationCache.clear();
  crossFirmAssociationCache.clear();
}
