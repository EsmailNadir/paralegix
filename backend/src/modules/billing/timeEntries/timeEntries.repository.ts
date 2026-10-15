const { financialRootSql, financialSql, withDrizzleTransaction } = require('../../../shared/database/financialQuery');
const { isUuid } = require('../../../shared/utils/isUuid');
// activities.rate_cents / amount are NULLABLE (an entry may have no rate yet),
// so this module needs the null-preserving variants, not the 0-for-empty ones.
const { toCentsOrNull: toCents, fromCentsOrNull: fromCents } = require('../shared/money');

function ctx(context: any) {
  return context.type === 'matter'
    ? { col: 'matter_id', value: context.entityId, matter_id: context.entityId, client_id: null }
    : { col: 'client_id', value: context.entityId, matter_id: null, client_id: context.entityId };
}
const dateOnly = (v: any) => {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (typeof v.toDate === 'function') return v.toDate().toISOString().slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return null;
};

function toEntity(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    timeEntryId: r.id,
    lawFirmId: r.law_firm_id,
    matterId: r.matter_id,
    clientId: r.client_id,
    clientContextId: r.client_id,
    contextType: r.matter_id ? 'matter' : 'client',
    entityId: r.matter_id || r.client_id,
    matterClientIds: r.matter_client_ids || [],
    userId: r.user_id,
    userName: r.user_name || null, // from JOIN
    hours: r.hours == null ? 0 : Number(r.hours),
    hourlyRate: fromCents(r.rate_cents),
    // The rate the entry was resolved at when written, and which source gave
    // it (migration 0233). `amount` is hours times this rate.
    resolvedRate: r.resolved_rate_cents == null ? null : fromCents(r.resolved_rate_cents),
    rateSource: r.rate_source || null,
    amount: fromCents(r.amount_cents),
    date: r.activity_date || null,
    name: r.name || '',
    description: r.description || '',
    chargeCodeId: r.billing_code_id,
    utbmsTaskCode: r.utbms_task_code,
    utbmsActivityCode: r.utbms_activity_code,
    source: r.source,
    linkedNoteId: r.linked_note_id || null,
    sourceTaskId: r.source_task_id || null,
    // Titles are joined at read time rather than snapshotted, so renaming a task
    // or event updates every entry that points at it.
    sourceTaskTitle: r.source_task_title || null,
    sourceEventId: r.source_event_id || null,
    sourceEventTitle: r.source_event_title || null,
    billable: r.billable !== false,
    createdBy: r.created_by,
    createdAt: r.created_at ? r.created_at.toISOString() : null,
    updatedAt: r.updated_at ? r.updated_at.toISOString() : null,
  };
}

// The two title joins carry the tenant predicate as well as the id. It is not
// redundant to the uuid match: without it the planner has no way to know the
// lookup stays inside one firm, so it builds its hash over every task and every
// matter event on the platform. Bounding it to the firm's own rows turned a
// full scan of a 109,000-row `tasks` table into an index scan of that firm's
// 15,800 (~40ms -> ~14ms, 4,560 -> 1,150 buffers on a 10,000-entry matter), and
// keeps the cost proportional to the tenant rather than to the install.
// Time entries are the `kind = 'time'` rows of `activities` (migration 0232).
// Every statement below carries that predicate; the kind is part of the row's
// identity here, not a filter a caller may drop.
const SELECT = `select te.*, u.name as user_name,
                       st.title as source_task_title,
                       se.title as source_event_title
                  from activities te
                  left join users u on u.id = te.user_id
                  left join tasks st on st.id = te.source_task_id
                                    and st.law_firm_id = te.law_firm_id
                  left join events se on se.id = te.source_event_id
                                            and se.law_firm_id = te.law_firm_id`;

class TimeEntriesRepository {
  async create(context: any, data: any) {
    const c = ctx(context);
    const { rows } = await financialRootSql(
      `insert into activities
         (kind, law_firm_id, matter_id, client_id, user_id, activity_date, hours, rate_cents, billing_code_id,
          name, description, matter_client_ids, utbms_task_code, utbms_activity_code,
          source, linked_note_id, source_task_id, source_event_id, billable, created_by,
          resolved_rate_cents, rate_source)
       values ('time',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) returning *`,
      [context.lawFirmId, c.matter_id, c.client_id, data.userId || null, dateOnly(data.date),
       data.hours ?? 0, toCents(data.hourlyRate), data.chargeCodeId || null,
       (data.name || '').trim() || null, (data.description || '').trim() || null,
       JSON.stringify(data.matterClientIds || []),
       data.utbmsTaskCode || null, data.utbmsActivityCode || null, data.source || null,
       data.linkedNoteId || null, data.sourceTaskId || null, data.sourceEventId || null,
       data.billable !== false, data.createdBy || data.userId || null,
       data.resolvedRateCents ?? null, data.rateSource ?? null]
    );
    // re-read with user join for userName
    return this.findById(context, rows[0].id);
  }

  async findById(context: any, id: any) {
    if (!isUuid(id)) return null;
    const c = ctx(context);
    const { rows } = await financialRootSql(
      `${SELECT} where te.kind = 'time' and te.law_firm_id = $1 and te.${c.col} = $2 and te.id = $3`,
      [context.lawFirmId, c.value, id]
    );
    return toEntity(rows[0]);
  }

  async findByContext(context: any, userId: string) {
    const c = ctx(context);
    const params: unknown[] = [context.lawFirmId, c.value];
    let sql = `${SELECT} where te.kind = 'time' and te.law_firm_id = $1 and te.${c.col} = $2`;
    if (userId) { params.push(userId); sql += ` and te.user_id = $3`; }
    sql += ` order by te.activity_date desc nulls last, te.created_at desc, te.id desc`;
    const { rows } = await financialRootSql(sql, params);
    return rows.map(toEntity);
  }

  async update(context: any, id: any, data: any) {
    if (!isUuid(id)) return null;
    const set: any[] = [];
    const params: unknown[] = [context.lawFirmId, id];
    const add = (col: any, val: any) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (data.hours !== undefined) add('hours', data.hours);
    if (data.hourlyRate !== undefined) add('rate_cents', toCents(data.hourlyRate));
    if (data.date !== undefined) add('activity_date', dateOnly(data.date));
    if (data.name !== undefined) add('name', (data.name || '').trim() || null);
    if (data.description !== undefined) add('description', (data.description || '').trim() || null);
    if (data.chargeCodeId !== undefined) add('billing_code_id', data.chargeCodeId || null);
    // Re-homing client work onto a matter. The table's XOR check means an entry
    // belongs to a matter or a client, never both, so the caller sends the
    // matching client_id: null alongside; who the work was for survives on
    // matter_client_ids.
    if (data.matterId !== undefined) add('matter_id', data.matterId || null);
    if (data.clientId !== undefined) add('client_id', data.clientId || null);
    if (data.matterClientIds !== undefined) add('matter_client_ids', JSON.stringify(data.matterClientIds || []));
    if (data.utbmsTaskCode !== undefined) add('utbms_task_code', data.utbmsTaskCode || null);
    if (data.utbmsActivityCode !== undefined) add('utbms_activity_code', data.utbmsActivityCode || null);
    // The single-source check constraint means these two move together; the
    // service always sends both so one can never be left stale behind the other.
    if (data.sourceTaskId !== undefined) add('source_task_id', data.sourceTaskId || null);
    if (data.sourceEventId !== undefined) add('source_event_id', data.sourceEventId || null);
    if (data.billable !== undefined) add('billable', data.billable !== false);
    if (data.resolvedRateCents !== undefined) add('resolved_rate_cents', data.resolvedRateCents);
    if (data.rateSource !== undefined) add('rate_source', data.rateSource);
    if (!set.length) return this.findById(context, id);
    await financialRootSql(`update activities set ${set.join(', ')} where kind = 'time' and law_firm_id = $1 and id = $2`, params);
    return this.findById(context, id);
  }

  async delete(context: any, id: any) {
    if (!isUuid(id)) return;
    await financialRootSql(`delete from activities where kind = 'time' and law_firm_id = $1 and id = $2`, [context.lawFirmId, id]);
  }

  /**
   * The billing context and timekeeper of many entries at once, for a caller
   * that holds a set of ids and does not yet know which matter or client each
   * one belongs to.
   *
   * Firm-scoped rather than context-scoped, unlike every read above, because a
   * bulk selection is assembled from the FIRM list and spans matters and
   * clients. That is why it returns the context instead of taking one: the
   * caller decides per entry whether the acting user may reach it, which is the
   * check `authorizeContext` performs one entry at a time.
   *
   * Deliberately narrow. This is the input to an authorization decision and a
   * delete, so it selects the four columns those need rather than running
   * `SELECT` with its three joins over a thousand rows to build display fields
   * nothing here reads.
   */
  async findManyForFirm(lawFirmId: string, ids: string[]) {
    const valid = (ids || []).filter(isUuid);
    if (!valid.length) return [];
    const { rows } = await financialRootSql(
      `select id, matter_id, client_id, user_id
         from activities
        where kind = 'time' and law_firm_id = $1 and id = any($2)`,
      [lawFirmId, valid],
    );
    return rows.map((r: any) => ({
      id: r.id,
      matterId: r.matter_id,
      clientId: r.client_id,
      contextType: r.matter_id ? 'matter' : 'client',
      entityId: r.matter_id || r.client_id,
      userId: r.user_id,
    }));
  }

  /**
   * Delete many entries in ONE statement, so a selection of a thousand costs one
   * round trip instead of a thousand.
   *
   * The caller has already decided which ids belong here: an entry the user may
   * not reach, or one an invoice carries, must never appear in this list.
   * `activities_billed_immutable` is still the backstop, and it aborts the whole
   * statement, which is exactly why the billed ones are filtered out first.
   */
  async deleteManyForFirm(lawFirmId: string, ids: string[]) {
    const valid = (ids || []).filter(isUuid);
    if (!valid.length) return 0;
    const { rowCount } = await financialRootSql(
      `delete from activities where kind = 'time' and law_firm_id = $1 and id = any($2)`,
      [lawFirmId, valid],
    );
    return rowCount || 0;
  }
}

export = new TimeEntriesRepository();
