import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  clients,
  contacts,
  courts,
  matterContacts,
  matters,
} from '../../shared/database/drizzle/schema';
import {
  tenantQuery,
  type DrizzleExecutor,
} from '../../shared/database/queryContext';
import { scopedDelete, scopedInsert, scopedUpdate } from '../../shared/database/scopedWrite';
import { toIlikeTerm } from '../../shared/database/searchTerm';
import { clampLimit, resolvePage } from '../../shared/database/pagination';
const { isUuid } = require('../../shared/utils/isUuid');

const iso = (value: unknown) => value instanceof Date ? value.toISOString() : value;

/** Shape a Drizzle row into the contact the API returns. */
function formatContact(row: any) {
  if (!row) return null;
  const contact: any = {
    id: row.id,
    contactType: row.contactType || 'person',
    name: row.name || '',
    category: row.category || 'other',
    organization: row.organization || null,
    title: row.title || null,
    barNumber: row.barNumber || null,
    email: row.email || null,
    phone: row.phone || null,
    phoneAlt: row.phoneAlt || null,
    fax: row.fax || null,
    website: row.website || null,
    address: row.address || null,
    courtId: row.courtId || null,
    notes: row.notes || null,
    tags: row.tags || [],
    isArchived: Boolean(row.isArchived),
    oneTime: Boolean(row.oneTime),
    createdBy: row.createdBy || null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
  const matterCount = row.matterCount;
  const courtName = row.courtName;
  if (matterCount !== undefined) contact.matterCount = Number(matterCount) || 0;
  if (courtName !== undefined) contact.courtName = courtName || null;
  return contact;
}

const SORT_COLUMNS: Record<string, any> = {
  name: contacts.name,
  category: contacts.category,
  organization: contacts.organization,
  email: contacts.email,
  createdAt: contacts.createdAt,
};

function contactOrder(sort: any, sortBy: string, order: string): SQL[] {
  const model = Array.isArray(sort) && sort.length ? sort : [{ field: sortBy, dir: order }];
  const expressions: SQL[] = [];
  for (const item of model) {
    const column = SORT_COLUMNS[item?.field];
    if (!column) continue;
    const direction = String(item?.dir).toLowerCase() === 'desc' ? sql.raw('desc') : sql.raw('asc');
    expressions.push(sql`${column} ${direction} nulls last`);
  }
  if (!expressions.length) expressions.push(sql`${contacts.name} asc nulls last`);
  expressions.push(sql`${contacts.id} asc`);
  return expressions;
}

function searchUnion(lawFirmId: string, term: string, includeTitleAndPhone: boolean) {
  const extra = includeTitleAndPhone
    ? sql`union select id from contacts where law_firm_id = ${lawFirmId} and title ilike ${term} escape '\\'
          union select id from contacts where law_firm_id = ${lawFirmId} and phone ilike ${term} escape '\\'`
    : sql``;
  return sql`${contacts.id} in (
    select id from contacts where law_firm_id = ${lawFirmId} and name ilike ${term} escape '\\'
    union select id from contacts where law_firm_id = ${lawFirmId} and organization ilike ${term} escape '\\'
    union select id from contacts where law_firm_id = ${lawFirmId} and email::text ilike ${term} escape '\\'
    ${extra}
  )`;
}

class ContactsRepository {
  async listContactsPaged(lawFirmId: string, options: any = {}) {
    const {
      search,
      category,
      matterId,
      courtId,
      hasCourt,
      tags,
      archived = 'false',
      oneTime = 'false',
      page = 1,
      limit = null,
      offset = null,
      sort,
      sortBy = 'name',
      order = 'asc',
    } = options;

    if (matterId != null && matterId !== '' && !isUuid(matterId)) return { contacts: [], totalItems: 0 };
    if (courtId != null && courtId !== '' && !isUuid(courtId)) return { contacts: [], totalItems: 0 };

    const filters: SQL[] = [];
    if (archived === 'true') filters.push(eq(contacts.isArchived, true));
    else if (archived !== 'all') filters.push(eq(contacts.isArchived, false));
    if (oneTime === 'true') filters.push(eq(contacts.oneTime, true));
    else if (oneTime !== 'all') filters.push(eq(contacts.oneTime, false));
    if (category) filters.push(eq(contacts.category, category));
    if (matterId) {
      filters.push(sql`exists (select 1 from ${matterContacts}
        where ${matterContacts.lawFirmId} = ${contacts.lawFirmId}
          and ${matterContacts.contactId} = ${contacts.id}
          and ${matterContacts.matterId} = ${matterId})`);
    }
    if (courtId) filters.push(eq(contacts.courtId, courtId));
    if (hasCourt === 'true') filters.push(isNotNull(contacts.courtId));
    if (Array.isArray(tags) && tags.length) filters.push(sql`${contacts.tags} && ${sql.param(tags)}::text[]`);
    const term = toIlikeTerm(search);
    if (term) filters.push(searchUnion(lawFirmId, term, true));

    const paging = limit == null ? null : resolvePage({ limit, offset, page, max: 500 });
    const ordering = contactOrder(sort, sortBy, order);
    const rows = await tenantQuery<any[]>(
      contacts,
      lawFirmId,
      ({ executor, scope }) => {
        let pageQuery: any = executor
          .select({ id: contacts.id, totalCount: sql<number>`count(*) over()`.as('total_count') })
          .from(contacts)
          .where(and(scope, ...filters))
          .orderBy(...ordering);
        if (paging) pageQuery = pageQuery.limit(paging.limit).offset(paging.offset);
        const contactPage = executor.$with('contact_page').as(pageQuery);
        return executor
          .with(contactPage)
          .select({
            ...getTableColumns(contacts),
            courtName: courts.name,
            matterCount: sql<number>`(
              select count(*)::int from ${matterContacts}
              where ${matterContacts.lawFirmId} = ${contacts.lawFirmId}
                and ${matterContacts.contactId} = ${contacts.id}
            )`,
            totalCount: contactPage.totalCount,
          })
          .from(contactPage)
          .innerJoin(contacts, eq(contacts.id, contactPage.id))
          .leftJoin(courts, and(eq(courts.id, contacts.courtId), eq(courts.lawFirmId, contacts.lawFirmId)))
          .orderBy(...ordering);
      },
    );

    let totalItems = rows.length ? Number(rows[0].totalCount) : 0;
    if (!rows.length && paging?.offset) {
      const totals = await tenantQuery(
        contacts,
        lawFirmId,
        ({ executor, scope }) => executor
          .select({ total: count() })
          .from(contacts)
          .where(and(scope, ...filters)),
      );
      totalItems = totals[0]?.total || 0;
    }
    return { contacts: rows.map(formatContact), totalItems };
  }

  async getContact(lawFirmId: string, contactId: string, executor?: DrizzleExecutor) {
    if (!isUuid(contactId)) return null;
    const rows = await tenantQuery(
      contacts,
      lawFirmId,
      ({ executor: queryExecutor, scope }) => queryExecutor
        .select({
          ...getTableColumns(contacts),
          courtName: courts.name,
          matterCount: sql<number>`(
            select count(*)::int from ${matterContacts}
            where ${matterContacts.lawFirmId} = ${contacts.lawFirmId}
              and ${matterContacts.contactId} = ${contacts.id}
          )`,
        })
        .from(contacts)
        .leftJoin(courts, and(eq(courts.id, contacts.courtId), eq(courts.lawFirmId, contacts.lawFirmId)))
        .where(and(scope, eq(contacts.id, contactId)))
        .limit(1),
      executor,
    );
    return formatContact(rows[0]);
  }

  async listLinkedMatters(lawFirmId: string, contactId: string) {
    if (!isUuid(contactId)) return [];
    const rows = await tenantQuery(
      matterContacts,
      lawFirmId,
      ({ executor, scope }) => executor
        .select({
          linkId: matterContacts.id,
          role: matterContacts.role,
          notes: matterContacts.notes,
          linkedAt: matterContacts.createdAt,
          matterId: matters.id,
          matterName: matters.name,
          matterNumber: matters.matterNumber,
          matterStatus: matters.status,
        })
        .from(matterContacts)
        .innerJoin(matters, and(eq(matters.id, matterContacts.matterId), eq(matters.lawFirmId, matterContacts.lawFirmId)))
        .where(and(scope, eq(matterContacts.contactId, contactId)))
        .orderBy(asc(matters.name)),
    );
    return rows.map((row) => ({
      ...row,
      matterName: row.matterName || '',
      matterNumber: row.matterNumber || null,
      matterStatus: row.matterStatus || null,
      role: row.role || 'other',
      notes: row.notes || null,
      linkedAt: iso(row.linkedAt),
    }));
  }

  async findPossibleDuplicatesBatch(lawFirmId: string, candidates: any[]) {
    const names = [...new Set((candidates || []).map((candidate) =>
      (candidate.name || '').trim().toLowerCase()).filter(Boolean))] as string[];
    const emails = [...new Set((candidates || []).map((candidate) =>
      (candidate.email || '').trim().toLowerCase()).filter(Boolean))] as string[];
    const byName = new Map();
    const byEmail = new Map();
    if (!names.length && !emails.length) return { byName, byEmail };
    const matches: SQL[] = [];
    if (names.length) matches.push(inArray(sql`lower(${contacts.name})`, names));
    if (emails.length) matches.push(inArray(sql`lower(${contacts.email}::text)`, emails));
    const rows = await tenantQuery(
      contacts,
      lawFirmId,
      ({ executor, scope }) => executor.select().from(contacts)
        .where(and(scope, eq(contacts.isArchived, false), eq(contacts.oneTime, false), or(...matches)))
        .orderBy(asc(contacts.name)),
    );
    for (const row of rows) {
      const formatted = formatContact(row);
      const lowerName = (row.name || '').trim().toLowerCase();
      const lowerEmail = (row.email || '').toString().trim().toLowerCase();
      if (lowerName) {
        if (!byName.has(lowerName)) byName.set(lowerName, []);
        byName.get(lowerName).push(formatted);
      }
      if (lowerEmail) {
        if (!byEmail.has(lowerEmail)) byEmail.set(lowerEmail, []);
        byEmail.get(lowerEmail).push(formatted);
      }
    }
    return { byName, byEmail };
  }

  async findPossibleDuplicates(lawFirmId: string, { name, email }: any) {
    const matches: SQL[] = [];
    const trimmedName = (name || '').trim();
    if (trimmedName) matches.push(eq(sql`lower(${contacts.name})`, trimmedName.toLowerCase()));
    const trimmedEmail = (email || '').trim();
    if (trimmedEmail) matches.push(eq(sql`lower(${contacts.email}::text)`, trimmedEmail.toLowerCase()));
    if (!matches.length) return [];
    const rows = await tenantQuery(
      contacts,
      lawFirmId,
      ({ executor, scope }) => executor.select().from(contacts)
        .where(and(scope, eq(contacts.isArchived, false), eq(contacts.oneTime, false), or(...matches)))
        .orderBy(asc(contacts.name))
        .limit(5),
    );
    return rows.map(formatContact);
  }

  async lookupContacts(lawFirmId: string, options: any = {}) {
    const { search, ids, category, excludeMatterId, limit = 20, full = false } = options;
    const filters: SQL[] = [];
    const wantsIdResolution = Array.isArray(ids) && ids.length > 0;
    if (wantsIdResolution) {
      const idList = ids.filter(isUuid);
      if (!idList.length) return { items: [], hasMore: false };
      filters.push(inArray(contacts.id, idList));
    } else {
      filters.push(eq(contacts.isArchived, false));
      filters.push(eq(contacts.oneTime, false));
      if (category) filters.push(eq(contacts.category, category));
      if (excludeMatterId && isUuid(excludeMatterId)) {
        filters.push(sql`not exists (select 1 from ${matterContacts}
          where ${matterContacts.lawFirmId} = ${contacts.lawFirmId}
            and ${matterContacts.contactId} = ${contacts.id}
            and ${matterContacts.matterId} = ${excludeMatterId})`);
      }
      const term = toIlikeTerm(search);
      if (term) filters.push(searchUnion(lawFirmId, term, false));
    }
    const pageSize = clampLimit(limit, { fallback: 20, max: 200 });
    const rows = await tenantQuery(
      contacts,
      lawFirmId,
      ({ executor, scope }) => executor.select().from(contacts)
        .where(and(scope, ...filters))
        .orderBy(asc(contacts.name), desc(contacts.createdAt))
        .limit(pageSize + 1),
    );
    const hasMore = rows.length > pageSize;
    return {
      items: rows.slice(0, pageSize).map((row) => {
        const labels = {
          label: row.name || row.email || 'Contact',
          sublabel: row.organization || row.email || null,
        };
        if (full) return { ...formatContact(row), ...labels };
        return {
          id: row.id,
          ...labels,
          category: row.category || 'other',
          isArchived: Boolean(row.isArchived),
        };
      }),
      hasMore,
    };
  }

  async createContact(lawFirmId: string, data: any, executor?: DrizzleExecutor) {
    const rows = await scopedInsert(contacts, lawFirmId, {
      contactType: data.contactType || 'person',
      name: data.name,
      category: data.category || 'other',
      organization: data.organization ?? null,
      title: data.title ?? null,
      barNumber: data.barNumber ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      phoneAlt: data.phoneAlt ?? null,
      fax: data.fax ?? null,
      website: data.website ?? null,
      address: data.address ?? null,
      courtId: data.courtId ?? null,
      notes: data.notes ?? null,
      tags: data.tags ?? [],
      oneTime: data.oneTime === true,
      createdBy: data.createdBy || null,
    }, executor);
    return formatContact(rows[0]);
  }

  async updateContact(lawFirmId: string, contactId: string, patch: any, executor?: DrizzleExecutor) {
    if (!isUuid(contactId)) return null;
    const allowed = [
      'contactType', 'name', 'category', 'organization', 'title', 'barNumber', 'email',
      'phone', 'phoneAlt', 'fax', 'website', 'address', 'courtId', 'notes', 'tags', 'isArchived', 'oneTime',
    ];
    const values = Object.fromEntries(allowed
      .filter((key) => patch[key] !== undefined)
      .map((key) => [key, patch[key]]));
    if (!Object.keys(values).length) return this.getContact(lawFirmId, contactId, executor);
    const rows = await scopedUpdate(contacts, lawFirmId, eq(contacts.id, contactId), values, executor);
    return formatContact(rows[0]);
  }

  async deleteContact(lawFirmId: string, contactId: string, executor?: DrizzleExecutor) {
    if (!isUuid(contactId)) return;
    await scopedDelete(contacts, lawFirmId, eq(contacts.id, contactId), executor);
  }

  async countLinkedMatters(lawFirmId: string, contactId: string) {
    if (!isUuid(contactId)) return 0;
    const rows = await tenantQuery(
      matterContacts,
      lawFirmId,
      ({ executor, scope }) => executor.select({ total: count() }).from(matterContacts)
        .where(and(scope, eq(matterContacts.contactId, contactId))),
    );
    return rows[0]?.total || 0;
  }

  async listTags(lawFirmId: string) {
    const tag = sql<string>`unnest(${contacts.tags})`;
    const rows = await tenantQuery(
      contacts,
      lawFirmId,
      ({ executor, scope }) => executor.selectDistinct({ tag }).from(contacts)
        .where(scope)
        .orderBy(asc(tag)),
    );
    return rows.map((row) => row.tag).filter(Boolean);
  }

  async courtExists(lawFirmId: string, courtId: string) {
    if (!isUuid(courtId)) return false;
    const rows = await tenantQuery(
      courts,
      lawFirmId,
      ({ executor, scope }) => executor.select({ id: courts.id }).from(courts)
        .where(and(scope, eq(courts.id, courtId))).limit(1),
    );
    return rows.length > 0;
  }

  async clientExists(lawFirmId: string, clientId: string) {
    if (!isUuid(clientId)) return false;
    const rows = await tenantQuery(
      clients,
      lawFirmId,
      ({ executor, scope }) => executor.select({ id: clients.id }).from(clients)
        .where(and(scope, eq(clients.id, clientId))).limit(1),
    );
    return rows.length > 0;
  }
}

export = Object.assign(new ContactsRepository(), { formatContact });
