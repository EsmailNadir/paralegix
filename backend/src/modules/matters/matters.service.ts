const mattersRepo = require('./matters.repository');
const tasksRepo = require('../tasks/tasks.repository');
const matterEventsRepo = require('./matterEvents.repository');
const matterEventsService = require('./matterEvents.service');
const matterStagesRepo = require('./stages/matterStages.repository');
const matterStagePipelinesRepo = require('./pipelines/matterStagePipelines.repository');
const matterFieldsRepo = require('./fields/matterFields.repository');
const matterActivityService = require('./activity/matterActivity.service');
const eventBus = require('../../shared/events/eventBus');
const { MATTER_CREATED, MATTER_UPDATED, MATTER_DELETED } = require('../../shared/events/eventTypes');
const filesRepo = require('../files/files.repository');
const { removeCascadeObjects } = require('../files/cascadeSweep');
const { assertLawFirmMembership, assertMatterMembership, assertMatterReadAccess, assertMatterWriteAccess, isFirmOwnerOrAdmin } = require('../../shared/utils/membership');
const { formatForClient } = require('../../shared/utils/time');
const { ForbiddenError, ConflictError, ValidationError, NotFoundError } = require('../../shared/errors/AppError');
const { trustTxnRepo } = require('../trust/trust.repository');
const { resolveContext } = require('../billing/context');
const invoicesService = require('../billing/invoices/invoices.service');
const { enforceCountLimit } = require('../../shared/plans/planEnforcement');
const { isUuid } = require('../../shared/utils/isUuid');
const { resolveEffectiveClientIds } = require('../clients/clientCompanyLinks.util');
const { assertFirmPermission } = require('../lawfirms/roles/requirePermission');
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');
const { MAX_BULK_MATTER_IDS } = require('./matters.validation');

const toDate = (v: any) => (v ? new Date(v) : null);
const dollarsToCents = (d: any) => (d == null || d === '' ? null : Math.round(Number(d) * 100));
const emptyToNull = (v: any) => (v === '' || v === undefined ? null : v);

/**
 * Validate a matter's incoming custom-field values against the field definitions
 * that actually apply to the matter's practice area. Returns a cleaned object
 * that:
 *   - drops keys that don't map to a real, applicable (non-archived) def, so
 *     arbitrary keys can't be written into the jsonb column;
 *   - coerces each value to the def's field_type and enforces select/multiselect
 *     option membership, throwing a 400 on a genuinely invalid value;
 *   - drops empty values (a field the user cleared) rather than storing "".
 *
 * The stored jsonb replaces the column wholesale, so callers must send the full
 * set of applicable values (matching how the custom-fields UI submits them).
 */
// Field-def options are stored as [{ label, value }] (see matterFields.service
// normalizeOptions); tolerate a bare string too. Returns the allowed value list.
function optionValues(options: any) {
  if (!Array.isArray(options)) return [];
  return options.map((o) => (typeof o === 'string' ? o : o?.value)).filter((v) => v != null);
}

async function validateCustomFields(lawFirmId: string, practiceAreaId: any, raw: any) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const defs = await matterFieldsRepo.listApplicable(lawFirmId, practiceAreaId);
  const defById = new Map(defs.map((d: any) => [d.id, d]));

  const isEmpty = (v: any) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
    || (Array.isArray(v) && v.length === 0);

  const clean: Record<string, any> = {};
  for (const [defId, value] of Object.entries(raw)) {
    const def: any = defById.get(defId);
    if (!def) continue; // unknown / non-applicable / archived def: don't persist
    if (isEmpty(value)) continue; // cleared field

    switch (def.fieldType) {
      case 'number':
      case 'currency': {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new ValidationError(`"${def.label}" must be a number`);
        clean[defId] = n;
        break;
      }
      case 'checkbox':
        clean[defId] = value === true || value === 'true';
        break;
      case 'date': {
        const s = String(value).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ValidationError(`"${def.label}" must be a valid date`);
        clean[defId] = s;
        break;
      }
      case 'select': {
        const s = String(value);
        const allowed = optionValues(def.options);
        if (allowed.length && !allowed.includes(s)) {
          throw new ValidationError(`"${s}" is not a valid option for "${def.label}"`);
        }
        clean[defId] = s;
        break;
      }
      case 'multiselect': {
        const arr = (Array.isArray(value) ? value : [value]).map(String);
        const allowed = optionValues(def.options);
        const bad = allowed.length ? arr.find((v) => !allowed.includes(v)) : null;
        if (bad) throw new ValidationError(`"${bad}" is not a valid option for "${def.label}"`);
        clean[defId] = arr;
        break;
      }
      default: // text, textarea, url, email, phone
        clean[defId] = String(value);
    }
  }
  return clean;
}

/**
 * Normalize the shared matter attribute fields (stage, billing prefs, key dates,
 * custom-field values) from a request body into a repository patch. Only keys
 * actually present in the body are included, so this is safe for partial updates.
 * Validates the stage belongs to the matter's (effective) pipeline and
 * custom-field values against the matter's practice-area field defs. Budget
 * is entered in dollars and converted to integer cents.
 */
async function buildMatterAttributePatch(lawFirmId: string, body: any, { practiceAreaId = null, pipelineId = null }: any = {}) {
  const patch: Record<string, any> = {};

  if (body.stageId !== undefined) {
    if (body.stageId === null || body.stageId === '') {
      patch.stageId = null;
    } else {
      const stage = await matterStagesRepo.getById(lawFirmId, body.stageId);
      if (!stage) {
        throw new ValidationError('Invalid stageId for this law firm');
      }
      if (stage.pipelineId !== pipelineId) {
        throw new ValidationError("That stage does not belong to this matter's pipeline");
      }
      patch.stageId = body.stageId;
    }
  }

  if (body.billingMethod !== undefined) patch.billingMethod = body.billingMethod;
  if (body.isBillable !== undefined) patch.isBillable = body.isBillable === true;
  if (body.budget !== undefined) patch.budgetCents = dollarsToCents(body.budget);
  if (body.budgetIncludesExpenses !== undefined) patch.budgetIncludesExpenses = body.budgetIncludesExpenses === true;
  if (body.contingencyPercent !== undefined) {
    patch.contingencyPercent = body.contingencyPercent == null ? null : Number(body.contingencyPercent);
  }
  if (body.openDate !== undefined) patch.openDate = emptyToNull(body.openDate);
  if (body.closeDate !== undefined) patch.closeDate = emptyToNull(body.closeDate);
  if (body.statuteOfLimitationsDate !== undefined) patch.statuteOfLimitationsDate = emptyToNull(body.statuteOfLimitationsDate);
  if (body.customFields !== undefined) {
    patch.customFields = await validateCustomFields(lawFirmId, practiceAreaId, body.customFields);
  }

  return patch;
}

/**
 * Remove external calendar rows for matter-scoped invoices and matter events before
 * the matter is deleted (so adapters can still resolve paths). Best-effort; the
 * Postgres delete cascades the relational children regardless.
 */
async function purgeExternalCalendarsBeforeMatterRemoval({ lawFirmId, matterId, actingUserId }: any) {
  try {
    const context = resolveContext({ lawFirmId, matterId, clientId: undefined });
    await invoicesService.emitCalendarDeletesForInvoicesInContext({ lawFirmId, context, actingUserId });
  } catch (err: any) {
    console.error('matters.service: invoice calendar purge before matter delete failed:', err?.message || err);
  }
  try {
    await matterEventsService.emitCalendarDeletesForAllMatterEvents({ lawFirmId, matterId, actingUserId });
  } catch (err: any) {
    console.error('matters.service: matter event calendar purge before matter delete failed:', err?.message || err);
  }
  try {
    await matterEventsRepo.deleteAllForMatter(lawFirmId, matterId);
  } catch (err: any) {
    console.error('matters.service: matterEvents subcollection delete failed:', err?.message || err);
  }
}

// Access to act on a matter is governed by matter membership plus the route's
// firm permission (matters.update / matters.delete). A matter's "lead" is an
// accountability attribute (the responsible attorney), NOT an access gate, so it
// is deliberately not checked here. This mirrors how Clio/PracticePanther treat
// the responsible/originating attorney: a reporting label, separate from who may
// view or edit the matter.

// A matter may have zero, one, or many leads. De-duplicated.
function normalizeLeadIds({ leadUserIds }: any) {
  const raw = Array.isArray(leadUserIds) ? leadUserIds : [];
  return [...new Set(raw.filter(Boolean))];
}

// Every lead must be a member of the firm (a client or arbitrary id can't be a lead).
async function assertLeadsAreFirmMembers(lawFirmId: string, leadIds: any) {
  if (!leadIds.length) return;
  const memberSet = await mattersRepo.filterFirmMemberIds(lawFirmId, leadIds);
  const missing = leadIds.filter((id: any) => !memberSet.has(id));
  if (missing.length) {
    throw new ValidationError('Each matter lead must be a member of this law firm');
  }
}

// On an EXISTING matter, a lead must already be a member of THAT matter. Adding
// someone to a matter is the members endpoint's job (gated by
// matters.manageMembers + the ethical wall); updateMatter (matters.update) must
// not become a side door that grants matter membership by naming a non-member
// as a lead.
async function assertLeadsAreMatterMembers(lawFirmId: string, matterId: string, leadIds: any) {
  if (!leadIds.length) return;
  const memberSet = await mattersRepo.filterMatterMemberIds(lawFirmId, matterId, leadIds);
  const missing = leadIds.filter((id: any) => !memberSet.has(id));
  if (missing.length) {
    throw new ValidationError('A matter lead must first be a member of this matter');
  }
}

/**
 * Run a conflict-of-interest check against a new matter's linked clients and
 * persist the result, so the firm can later demonstrate a check was performed.
 * Best-effort and advisory: it never blocks or fails matter creation. A failure
 * to run or record the check is logged and swallowed.
 */
async function recordConflictCheckForMatter({ lawFirmId, matterId, performedBy }: any) {
  try {
    const matterClients = await mattersRepo.listMatterClients(lawFirmId, matterId);
    const names = matterClients.map((c: any) => c.name).filter(Boolean);
    const emails = matterClients.map((c: any) => c.email).filter(Boolean);
    // An ORGANIZATION client keeps its legal name in `name` and leaves
    // `organization` null (that column describes a PERSON's employer), so
    // reading `organization` alone never put the organization into the
    // organization search set. `findConflicts` has the two clauses that answer
    // "who else is this organization" - matching a company client by name, and
    // matching the people linked to it through `client_company_links` - and both
    // read the organization set, so neither could ever fire on a matter opened
    // FOR an organization. Feed a company client's own name in as an
    // organization as well as a name, so opening a matter for one reports the
    // people at that organization the firm already acts for.
    const organizations = matterClients
      .map((c: any) => (c.clientType === 'company' ? c.name : c.organization))
      .filter(Boolean);
    const excludeClientIds = matterClients.map((c: any) => c.id).filter(Boolean);
    if (names.length + emails.length + organizations.length === 0) return;

    const results = await mattersRepo.findConflicts(lawFirmId, {
      names,
      emails,
      organizations,
      excludeClientIds,
    });
    await mattersRepo.recordConflictCheck(lawFirmId, {
      matterId,
      performedBy,
      names,
      emails,
      organizations,
      results,
    });
  } catch (err: any) {
    console.error('matters.service: conflict-check record for matter failed:', err?.message || err);
  }
}

/**
 * Remove the matter's own linked clients from conflict-check results. New checks
 * already exclude them at query time; this also cleans the read model for audit
 * records written before self-exclusion was introduced without rewriting the
 * stored evidence.
 */
async function withoutLinkedClientSelfMatches(lawFirmId: string, matterId: string, checks: any[]) {
  const matterClients = await mattersRepo.listMatterClients(lawFirmId, matterId);
  const linkedClientIds = new Set(matterClients.map((client: any) => client.id).filter(Boolean));
  if (linkedClientIds.size === 0) return checks;

  return checks.map((check: any) => {
    const results = Array.isArray(check.results)
      ? check.results.filter((result: any) => !(
        result?.clientId && linkedClientIds.has(result.clientId)
      ))
      : [];
    return { ...check, resultCount: results.length, results };
  });
}

/** Attach ISO + timezone-local display fields to an enriched matter entity. */
function withTimeFields(c: any, timezone: any) {
  const createdAt = toDate(c.createdAt);
  const updatedAt = toDate(c.updatedAt);
  const { display: createdDisplay, input: createdInput } = formatForClient(createdAt, timezone);
  const { display: updatedDisplay, input: updatedInput } = formatForClient(updatedAt, timezone);
  return {
    ...c,
    createdAt: createdAt ? createdAt.toISOString() : null,
    createdAtLocalDisplay: createdDisplay,
    createdAtLocalInput: createdInput,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    updatedAtLocalDisplay: updatedDisplay,
    updatedAtLocalInput: updatedInput,
  };
}

/**
 * Create a new matter within a law firm.
 */
export async function createMatter({ lawFirmId, userId, body, timezone }: any) {
  await enforceCountLimit(lawFirmId, 'maxMatters', () => mattersRepo.countMatters(lawFirmId));

  const {
    name,
    matterNumber,
    description = '',
    practiceAreaId,
    stagePipelineId,
    category,
    courtId,
    leadUserIds,
    clients = [],
  } = body;

  // Resolve the lead set. Any supplied lead (other than the creator, who is
  // definitionally a member) must be a real firm member. Defaults to the creator.
  let leadIds = normalizeLeadIds({ leadUserIds });
  // Seeding another person as a lead writes their matter_members row, which is
  // the ethical-wall access boundary. Creating a matter must not be a side door
  // around the permission required to add that same person later.
  if (leadIds.some((id) => id !== userId)) {
    await assertFirmPermission(lawFirmId, userId, 'matters.manageMembers');
  }
  // A client supplied at creation is linked through the same matter_clients
  // billing relationship the dedicated clients routes mutate. Keep that
  // capability behind matters.manageClients regardless of whether the client
  // already exists or is created inline.
  if (Array.isArray(clients) && clients.length > 0) {
    await assertFirmPermission(lawFirmId, userId, 'matters.manageClients');
  }
  await assertLeadsAreFirmMembers(lawFirmId, leadIds.filter((id) => id !== userId));
  if (leadIds.length === 0) leadIds = [userId];
  const primaryLeadId = leadIds[0];

  // Validate optional FKs.
  let validPracticeAreaId = null;
  if (practiceAreaId) {
    const pa = await mattersRepo.validatePracticeArea(lawFirmId, practiceAreaId);
    if (!pa) throw new ValidationError('Invalid practiceAreaId for this law firm');
    validPracticeAreaId = practiceAreaId;
  }
  let validCourtId = null;
  if (courtId) {
    const court = await mattersRepo.validateCourt(lawFirmId, courtId);
    if (!court) throw new ValidationError('Invalid courtId for this law firm');
    validCourtId = courtId;
  }

  // Resolve the matter's stage pipeline: an explicit choice, or the same
  // "practice area's default, else the firm-wide default" fallback the app
  // used to compute implicitly at read time.
  let resolvedPipelineId = null;
  if (typeof stagePipelineId === 'string') {
    const pipeline = await matterStagePipelinesRepo.getById(lawFirmId, stagePipelineId);
    if (!pipeline) throw new ValidationError('Invalid stagePipelineId for this law firm');
    resolvedPipelineId = stagePipelineId;
  } else {
    const defaultPipeline = await matterStagePipelinesRepo.resolveDefault(lawFirmId, validPracticeAreaId);
    resolvedPipelineId = defaultPipeline?.id || null;
  }

  const matterReferenceId = await mattersRepo.generateUniqueMatterReferenceId(lawFirmId);

  // Optional matter attributes (stage, billing prefs, key dates, custom fields).
  // Custom fields are validated against the matter's (validated) practice area;
  // the stage against the resolved pipeline.
  const attributePatch = await buildMatterAttributePatch(lawFirmId, body, {
    practiceAreaId: validPracticeAreaId,
    pipelineId: resolvedPipelineId,
  });

  // De-dup explicitly selected client rows and portal-linked client identities
  // up-front. Clients without either identity are always kept because separate
  // people can legitimately share the same name and contact information.
  let dedupedClients = [];
  if (Array.isArray(clients) && clients.length > 0) {
    const seen = new Set();
    dedupedClients = clients.filter((c) => {
      const identity = c.clientId
        ? `client:${c.clientId}`
        : c.userId
          ? `user:${c.userId}`
          : null;
      if (!identity) return true;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  }

  // The matter row, its member rows (every lead + the acting user as a plain
  // member), and the find-or-create + link of any clients all run in ONE
  // transaction. A failure at any step rolls the whole create back, so it can
  // never leave a matter with zero members or orphan (unlinked) client rows.
  const fullMatter = await mattersRepo.createMatterWithMembersTx(
    lawFirmId,
    {
      name,
      matterNumber: matterNumber || null,
      description,
      status: 'active',
      matterReferenceId,
      createdBy: userId,
      leadUserId: primaryLeadId,
      practiceAreaId: validPracticeAreaId,
      stagePipelineId: resolvedPipelineId,
      category: category || null,
      courtId: validCourtId,
      ...attributePatch,
    },
    {
      leadIds,
      actingUserId: userId,
      clients: dedupedClients,
      // The authoritative maxMatters check: the early one above is a cheap
      // fast-fail before doing all the validation work, but it is NOT
      // locked and cannot by itself stop two concurrent creates from both
      // landing on the same final open slot. This one runs on the same
      // transaction executor as the insert that follows it, right after
      // locking the firm row, so a second concurrent create blocks here
      // until the first commits and then re-counts against the true total.
      beforeInsert: async (conn: any) => {
        await mattersRepo.lockFirmForMatterCountCheck(lawFirmId, conn);
        await enforceCountLimit(lawFirmId, 'maxMatters', () => mattersRepo.countMatters(lawFirmId, conn));
      },
    },
  );
  const matterId = fullMatter.id;
  const memberUserIds = fullMatter?.memberUserIds || [primaryLeadId];

  // Persist an evidentiary conflict-of-interest check against the matter's linked
  // clients. Best-effort: never blocks or alters the creation result.
  await recordConflictCheckForMatter({ lawFirmId, matterId, performedBy: userId });

  eventBus.emit(MATTER_CREATED, { lawFirmId, matterId, memberUserIds, matterData: fullMatter, userId, timeZone: timezone });

  await matterActivityService.recordActivity({
    lawFirmId,
    matterId,
    activityType: 'matter.created',
    actorUserId: userId,
    summary: `Matter "${name}" was created`,
  });

  return { message: 'Matter created successfully', matterId };
}

/**
 * Firm owners and firm-level admins may view every matter in the firm; regular
 * members stay scoped to matters they belong to (the ethical wall). Mirrors
 * isFirmOwnerOrAdmin in matterMembers.service: the owner flag, or the
 * `members.changeRole` permission, which is held only by owner/admin roles.
 */
async function canViewAllMatters(lawFirmId: string, userId: string) {
  return isFirmOwnerOrAdmin(lawFirmId, userId);
}

/**
 * List the matters of a firm visible to the current user, with filtering, free-text
 * search, sorting and windowing all resolved server-side.
 *
 * Owners/admins see every matter in the firm; regular members see only matters they
 * are a member of (the ethical wall, carried into SQL by the repository's `seeAll`
 * flag). Filters (`status`, `practiceAreaId`, `leadUserId`, `category`), `search`,
 * and the sort model (`sort`, or `sortBy`/`order`) are applied to the whole visible
 * set before the page is cut, so a page reflects the full filtered result rather
 * than a filtered page.
 *
 * Windowing is opt-in. Omit `limit` and the response is `{ matters }` carrying every
 * visible matter, exactly as the unpaginated list contract has always behaved.
 * Supply `limit` and the response gains `totalItems`: the size of the full filtered
 * result, so a client can render page controls without fetching every row.
 */
export async function listLawFirmMatters({
  lawFirmId, userId, timezone,
  limit, offset, page, status, paymentOngoing, practiceAreaId, leadUserId, clientId, category, search, sort, sortBy, order,
}: any) {
  // Owners/admins are trusted to see the whole firm's matters (they can already
  // manage any matter's members); everyone else remains membership-scoped so the
  // ethical wall holds.
  const seeAll = await canViewAllMatters(lawFirmId, userId);

  // The client-detail Matters tab (and the firm-side file-preview widget that
  // scopes itself to one client) are the only callers of this single-`clientId`
  // filter, so widening it here to also include every company that client is
  // linked to via `client_company_links` is safe. Documents rides on this
  // same widened read too, since it derives its file list from `clientMatters`.
  const effectiveClientIds = isUuid(clientId)
    ? (await resolveEffectiveClientIds(lawFirmId, clientId)).clientIds
    : clientId;

  const { matters: docs, totalItems } = await mattersRepo.listMattersPaged(lawFirmId, userId, {
    seeAll,
    page,
    limit: limit ?? null,
    offset: offset ?? null,
    status,
    paymentOngoing,
    practiceAreaId,
    leadUserId,
    clientId: effectiveClientIds,
    category,
    search,
    sort,
    sortBy,
    order,
  });

  const matters = docs.map((c: any) => withTimeFields(c, timezone));
  // `totalItems` is additive: present only when windowing. The default
  // `{ matters }` response shape (consumed by the full-list grid + ~15 callers) is
  // unchanged.
  return limit != null ? { matters, totalItems } : { matters };
}

/**
 * Ceiling on a single "select all" answer. Well above any realistic firm-wide
 * selection, low enough that the response and the bulk request built from it stay
 * a sane size. Past it the caller is told the selection was capped rather than
 * being handed a silent subset.
 *
 * Taken from the bulk schemas rather than restated, because the grid hands this
 * answer straight to the bulk routes: a ceiling above their cap would turn a full
 * selection into a 400, and one below it would leave the routes accepting more
 * than the grid can ever legitimately select.
 */
const MAX_SELECTABLE_IDS = MAX_BULK_MATTER_IDS;

/**
 * The ids of every matter the user can see under the given filters, with no
 * pagination. Backs "select all" in the matters grid: the user means every matter
 * the current filters match, not the page on screen, and a bulk action needs the
 * ids to act on.
 *
 * Visibility and filtering are the same ones `listLawFirmMatters` applies, so the
 * selection can never reach a matter the list wouldn't have shown.
 */
export async function listMatterIds({
  lawFirmId, userId, status, paymentOngoing, practiceAreaId, leadUserId, clientId, category, search,
}: any) {
  const seeAll = await canViewAllMatters(lawFirmId, userId);
  // Widened exactly as `listLawFirmMatters` widens it (a person also matches the
  // organizations they are linked to), so the selection equals the listed set.
  const effectiveClientIds = isUuid(clientId)
    ? (await resolveEffectiveClientIds(lawFirmId, clientId)).clientIds
    : clientId;
  const { ids, truncated } = await mattersRepo.listMatterIds(lawFirmId, userId, {
    seeAll, status, paymentOngoing, practiceAreaId, leadUserId, clientId: effectiveClientIds, category, search,
    max: MAX_SELECTABLE_IDS,
  });
  return { ids, totalItems: ids.length, truncated, limit: MAX_SELECTABLE_IDS };
}

/**
 * Typeahead source for matter pickers. Applies the same owner/admin vs
 * member-scoped visibility as the full list, so a picker can never surface a
 * matter the user isn't allowed to see.
 *
 * `clientId` restricts the result to that client's matters (for pickers whose
 * choice must stay within one client, such as trust transactions and invoices);
 * `full` returns the complete enriched matter instead of the slim picker row.
 * Both are optional and additive, so existing callers are unaffected.
 */
export async function lookupMatters({ lawFirmId, userId, search, exactName, ids, clientId, limit, full }: any) {
  const seeAll = await canViewAllMatters(lawFirmId, userId);
  return mattersRepo.lookupMatters(lawFirmId, { userId, seeAll, search, exactName, ids, clientId, limit, full });
}

/**
 * Get a single matter by ID.
 *
 * Read access follows the same rule as the list and lookup reads: owners/admins
 * may open any matter in the firm, everyone else must be a member of it. Without
 * that, an owner could see a matter listed and then get a 403 opening it.
 */
export async function getMatter({ lawFirmId, matterId, userId, timezone }: any) {
  await assertMatterReadAccess(lawFirmId, matterId, userId);

  // Matter row + note count are independent reads. Issue them in parallel to save
  // a round-trip on the hottest read path.
  //
  // The notes THEMSELVES no longer travel with the matter. A matter accumulates
  // notes for its whole life, and this payload is paid for by every tab of the
  // matter detail, not just the notes tab — so only the count comes along, for the
  // tab badge, and the notes tab reads its own page from the notes list endpoint.
  const [matterData, totalNotes] = await Promise.all([
    mattersRepo.findByIdRaw(lawFirmId, matterId),
    mattersRepo.countMatterNotes(lawFirmId, matterId),
  ]);
  if (!matterData) {
    throw new NotFoundError('Matter');
  }

  return { ...withTimeFields(matterData, timezone), totalNotes };
}

/**
 * Update a matter (supports lead change and metadata updates).
 */
export async function updateMatter({ lawFirmId, matterId, userId, body, timezone }: any) {
  const {
    name, matterNumber, description, status, paymentOngoing,
    practiceAreaId, stagePipelineId, category, courtId, leadUserIds,
  } = body;

  await assertMatterWriteAccess(lawFirmId, matterId, userId);

  // Snapshot the current status/stage so we can log meaningful transitions.
  const before = await mattersRepo.findByIdRaw(lawFirmId, matterId);

  const updates: Record<string, any> = {};
  if (typeof name === 'string') updates.name = name;
  // An emptied matter number is stored as null, matching create, so a cleared
  // number reads back as "no number" rather than a blank string.
  if (typeof matterNumber === 'string') updates.matterNumber = matterNumber.trim() || null;
  if (typeof description === 'string') updates.description = description;
  if (typeof status === 'string') updates.status = status;
  if (typeof paymentOngoing === 'boolean') updates.paymentOngoing = paymentOngoing;

  // Pipeline change, resolved up front so the stage patch below can validate
  // `stageId` against the *effective* (possibly just-changed) pipeline.
  let effectivePipelineId = before?.stagePipelineId || null;
  if (typeof stagePipelineId === 'string') {
    const pipeline = await matterStagePipelinesRepo.getById(lawFirmId, stagePipelineId);
    if (!pipeline) {
      throw new ValidationError('Invalid stagePipelineId for this law firm');
    }
    updates.stagePipelineId = stagePipelineId;
    effectivePipelineId = stagePipelineId;
  } else if (stagePipelineId === null) {
    updates.stagePipelineId = null;
    effectivePipelineId = null;
  }

  // Stage, billing prefs, key dates, and custom-field values. Custom fields are
  // validated against the matter's effective practice area (the incoming change if
  // present, otherwise the matter's current one); the stage against the effective
  // pipeline above.
  const effectivePracticeAreaId = typeof practiceAreaId === 'string'
    ? practiceAreaId
    : (practiceAreaId === null ? null : (before?.practiceAreaId || null));
  const attributePatch = await buildMatterAttributePatch(lawFirmId, body, {
    practiceAreaId: effectivePracticeAreaId,
    pipelineId: effectivePipelineId,
  });
  Object.assign(updates, attributePatch);

  if (typeof practiceAreaId === 'string') {
    const pa = await mattersRepo.validatePracticeArea(lawFirmId, practiceAreaId);
    if (!pa) {
      throw new ValidationError('Invalid practiceAreaId for this law firm');
    }
    updates.practiceAreaId = practiceAreaId;
  } else if (practiceAreaId === null) {
    updates.practiceAreaId = null;
  }

  if (typeof category === 'string') updates.category = category;
  else if (category === null) updates.category = null;

  if (typeof courtId === 'string' && courtId) {
    const court = await mattersRepo.validateCourt(lawFirmId, courtId);
    if (!court) throw new ValidationError('Invalid courtId for this law firm');
    updates.courtId = courtId;
  } else if (courtId === null || courtId === '') {
    updates.courtId = null;
  }

  // Lead-set change: only when leadUserIds is present in the body. Every lead
  // must already be a member of this matter (updateMatter can't grant
  // membership); the primary (first) lead is mirrored to matters.lead_user_id. An
  // empty array clears all leads.
  const leadsProvided = Array.isArray(leadUserIds);
  let newLeadIds = null;
  if (leadsProvided) {
    // Replacing the lead set promotes and demotes `matter_members.role` rows.
    // Keep that membership-role authority behind the same permission as the
    // dedicated member-management route rather than letting a metadata edit
    // change colleagues' responsibilities through a second path.
    await assertFirmPermission(lawFirmId, userId, 'matters.manageMembers');
    newLeadIds = normalizeLeadIds({ leadUserIds });
    await assertLeadsAreMatterMembers(lawFirmId, matterId, newLeadIds);
    updates.leadUserId = newLeadIds[0] || null;
  }

  const updated = await mattersRepo.updateMatter(lawFirmId, matterId, updates, { propagatePracticeAreaToTasks: true });

  if (newLeadIds) {
    // Replace the lead set: promote each to `lead`, demote any prior lead not in
    // the set. Keeps matter_members roles consistent with matters.lead_user_id.
    await mattersRepo.syncMatterLeads(lawFirmId, matterId, newLeadIds);
  }

  eventBus.emit(MATTER_UPDATED, { lawFirmId, matterId, matterData: updated, userId, timeZone: timezone });

  // Log notable transitions to the activity feed (status + stage changes).
  if (updates.status && before && updates.status !== before.status) {
    await matterActivityService.recordActivity({
      lawFirmId, matterId, activityType: 'status.changed', actorUserId: userId,
      summary: `Status changed from ${before.status} to ${updates.status}`,
      metadata: { from: before.status, to: updates.status },
    });
  }
  if (updates.stageId !== undefined && before && updates.stageId !== before.stageId) {
    await matterActivityService.recordActivity({
      lawFirmId, matterId, activityType: 'stage.changed', actorUserId: userId,
      summary: updated?.stageName ? `Moved to stage "${updated.stageName}"` : 'Stage cleared',
      metadata: { fromStageId: before.stageId, toStageId: updates.stageId },
    });
  }

  return { message: 'Matter updated successfully' };
}

/**
 * Refuse deletion of a matter whose removal would destroy records that must
 * survive it: a litigation hold, trust ledger entries, or billing history.
 *
 * Deleting the row cascades away its invoices (with their recorded payments),
 * time entries, flat fees, and expenses, so this runs on every delete path —
 * single and bulk alike — before anything is removed. The matter should be
 * closed or archived instead. Mirrors the client-deletion guard
 * (clients.service.removeClient).
 */
async function assertMatterIsDeletable(lawFirmId: string, matterId: string, matterData: any) {
  if (matterData?.legalHold) {
    throw new ForbiddenError('This matter is under legal hold and cannot be deleted.');
  }
  if (await trustTxnRepo.countByMatterId(lawFirmId, matterId) > 0) {
    throw new ConflictError('This matter has trust account activity and cannot be deleted. Trust ledger entries are permanent; close or archive the matter instead.');
  }
  if (await mattersRepo.countBillingRecords(lawFirmId, matterId) > 0) {
    throw new ConflictError('This matter has billing records (invoices, time entries, or expenses) and cannot be deleted. Close or archive the matter instead.');
  }
}

/**
 * Delete a matter and emit MATTER_DELETED for downstream cleanup.
 */
export async function deleteMatter({ lawFirmId, matterId, userId }: any) {
  await assertMatterMembership(lawFirmId, matterId, userId);
  const matterData = await mattersRepo.findByIdRaw(lawFirmId, matterId);
  await assertMatterIsDeletable(lawFirmId, matterId, matterData);

  await purgeExternalCalendarsBeforeMatterRemoval({ lawFirmId, matterId, actingUserId: userId });
  // Snapshot the matter's tasks and its documents before the delete cascades
  // both away, so the MATTER_DELETED handlers have something to clean up with.
  // The file rows go with the matter, but the stored objects have no foreign key
  // to anything and the firm's storage figure has to come down by what they held.
  const matterTasks = await tasksRepo.findByMatter(lawFirmId, matterId);
  const files = await filesRepo.scopeSnapshot(lawFirmId, { matterId });
  await mattersRepo.deleteMatter(lawFirmId, matterId);
  // Inside the request: after the response Cloud Run gives this process no
  // CPU, and a sweep left to an event listener did not finish.
  await removeCascadeObjects('MATTER_DELETED', lawFirmId, files);

  await eventBus.emitAsync(MATTER_DELETED, { lawFirmId, matterId, matterData, userId, tasks: matterTasks, files });
  return { message: 'Matter and associated resources deleted successfully' };
}

/**
 * Place or lift a litigation hold on a matter. While held, the matter cannot be
 * deleted. Gated (like every matter edit) on matter membership plus the route's
 * matters.update permission.
 */
export async function setLegalHold({ lawFirmId, matterId, userId, legalHold, reason, timezone }: any) {
  await assertMatterWriteAccess(lawFirmId, matterId, userId);

  const updated = await mattersRepo.setLegalHold(lawFirmId, matterId, {
    legalHold: legalHold === true,
    reason,
    actingUserId: userId,
  });
  if (!updated) {
    throw new NotFoundError('Matter');
  }

  eventBus.emit(MATTER_UPDATED, { lawFirmId, matterId, matterData: updated, userId, timeZone: timezone });

  await matterActivityService.recordActivity({
    lawFirmId, matterId, activityType: 'legal_hold.changed', actorUserId: userId,
    summary: legalHold === true
      ? `Legal hold placed${reason ? `: ${reason}` : ''}`
      : 'Legal hold lifted',
    metadata: { legalHold: legalHold === true },
  });

  return { message: 'Matter updated successfully', matter: withTimeFields(updated, timezone) };
}

/**
 * List the conflict-of-interest checks recorded against a matter (surfaces the
 * evidentiary record for the matter detail page). Requires matter membership.
 */
export async function listConflictChecks({ lawFirmId, matterId, userId }: any) {
  await assertMatterReadAccess(lawFirmId, matterId, userId);
  const checks = await mattersRepo.listConflictChecks(lawFirmId, matterId);
  return {
    conflictChecks: await withoutLinkedClientSelfMatches(lawFirmId, matterId, checks),
  };
}

/**
 * Re-run a conflict-of-interest check for an existing matter against its current
 * linked clients and persist the result. Requires matter membership. Returns the
 * refreshed list of recorded checks.
 */
export async function rerunConflictCheck({ lawFirmId, matterId, userId }: any) {
  await assertMatterMembership(lawFirmId, matterId, userId);
  await recordConflictCheckForMatter({ lawFirmId, matterId, performedBy: userId });
  await matterActivityService.recordActivity({
    lawFirmId, matterId, activityType: 'conflict_check.run', actorUserId: userId,
    summary: 'Conflict check re-run against linked clients',
  });
  const checks = await mattersRepo.listConflictChecks(lawFirmId, matterId);
  return {
    message: 'Conflict check completed',
    conflictChecks: await withoutLinkedClientSelfMatches(lawFirmId, matterId, checks),
  };
}

/**
 * Run a per-item bulk operation sequentially, collecting per-item failures into
 * an `errors` map so a mid-batch failure is predictable (no fail-fast / partial
 * 403 for the whole batch). Returns a `succeeded` count + the errors map.
 */
/**
 * The most event-listener chains one bulk matter request may have running at once.
 *
 * `eventBus.emit` invokes its listeners and returns the moment they yield; it does
 * not await them. Emitting inside the per-item loop therefore left one detached
 * listener chain per matter in flight at the same time, each issuing its own
 * queries, and "select all" can put thousands of matters in one request against an
 * instance whose pool holds twelve connections. Three is the width the rest of this
 * codebase uses for pool-bound fan-out.
 */
const BULK_EVENT_CONCURRENCY = 3;

/**
 * Deliver one event per item once the batch has finished writing, with at most
 * `BULK_EVENT_CONCURRENCY` listener chains running at a time.
 *
 * Awaited rather than left running past the response: Cloud Run gives the process
 * no CPU once a response is sent, so a detached chain may simply never finish (the
 * same reason `deleteMatter` sweeps its objects inside the request). The added
 * latency is bounded by the listener work divided by three, while the per-item
 * loop this follows is fully sequential, so the fan-out pass costs a fraction of
 * the loop it comes after and cannot be what pushes a batch past the write budget.
 *
 * `emitAsync` settles every listener and `runWithConcurrency` never rejects, so a
 * failing listener still cannot change the route's result, exactly as when the
 * chain ran detached.
 */
async function emitBulkEvents(eventName: string, payloads: any[]) {
  if (!payloads.length) return;
  await runWithConcurrency(
    payloads.map((payload: any) => () => eventBus.emitAsync(eventName, payload)),
    BULK_EVENT_CONCURRENCY,
  );
}

async function runBulk(matterIds: string[], perItem: any) {
  const uniqueIds = [...new Set(matterIds)];
  const errors = {};
  let succeeded = 0;
  for (const matterId of uniqueIds) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await perItem(matterId);
      succeeded++;
    } catch (err: any) {
      (errors as Record<string, string>)[String(matterId)] = err?.message || 'Operation failed';
    }
  }
  return { requested: uniqueIds.length, succeeded, errors };
}

/**
 * Delete multiple matters and emit MATTER_DELETED for each.
 */
export async function bulkDelete({ lawFirmId, userId, matterIds }: any) {
  // Collected during the loop and delivered afterwards at a bounded width, rather
  // than emitted per item, so the batch cannot start one detached listener chain
  // per matter. The payload is captured here because the rows it describes are
  // gone by the time the event is delivered.
  const deletedEvents: any[] = [];
  const { requested, succeeded, errors } = await runBulk(matterIds, async (matterId: string) => {
    await assertMatterMembership(lawFirmId, matterId, userId);
    const matterData = await mattersRepo.findByIdRaw(lawFirmId, matterId);
    // Same deletability guard as the single-matter path: a held, trust-active or
    // billed matter is rejected into this batch's `errors` map rather than
    // cascading its financial history away.
    await assertMatterIsDeletable(lawFirmId, matterId, matterData);
    // The calendar purge is an idempotent best-effort external side effect; the
    // DB row delete runs in its own transaction so a failure can't leave a
    // half-deleted matter behind. The per-item errors map records any failure.
    await purgeExternalCalendarsBeforeMatterRemoval({ lawFirmId, matterId, actingUserId: userId });
    // Snapshot tasks and documents before the cascade takes both, so
    // MATTER_DELETED can clean their attachments and free their bytes.
    const matterTasks = await tasksRepo.findByMatter(lawFirmId, matterId);
    const files = await filesRepo.scopeSnapshot(lawFirmId, { matterId });
    await mattersRepo.deleteMatterTx(lawFirmId, matterId);
    await removeCascadeObjects('MATTER_DELETED', lawFirmId, files);
    deletedEvents.push({ lawFirmId, matterId, matterData, userId, tasks: matterTasks, files });
  });
  await emitBulkEvents(MATTER_DELETED, deletedEvents);
  return {
    message: 'Matters and associated resources deleted successfully',
    requested,
    deleted: succeeded,
    failed: Object.keys(errors),
    errors,
  };
}

/**
 * Bulk update status on multiple matters.
 *
 * Only the matter row changes. Task status is its own vocabulary
 * (open/in_progress/completed/blocked) tracking each task's progress, so it is
 * left alone exactly as the single-matter `updateMatter` path leaves it.
 */
export async function bulkUpdateStatus({ lawFirmId, userId, matterIds, status }: any) {
  // See emitBulkEvents: collected here, delivered at a bounded width after the loop.
  const updatedEvents: any[] = [];
  const { requested, succeeded, errors } = await runBulk(matterIds, async (matterId: string) => {
    await assertMatterWriteAccess(lawFirmId, matterId, userId);
    // Snapshot the prior status so only a real transition reaches the activity feed.
    const before = await mattersRepo.findByIdRaw(lawFirmId, matterId);
    const updated = await mattersRepo.updateMatter(lawFirmId, matterId, { status });

    // Same downstream contract as the single-matter path in updateMatter: closing a
    // matter here must still end the retainer plans that end on matter close, and
    // must still leave a status.changed entry on the matter's activity feed.
    updatedEvents.push({ lawFirmId, matterId, matterData: updated, userId });

    if (before && before.status !== status) {
      await matterActivityService.recordActivity({
        lawFirmId, matterId, activityType: 'status.changed', actorUserId: userId,
        summary: `Status changed from ${before.status} to ${status}`,
        metadata: { from: before.status, to: status },
      });
    }
  });
  await emitBulkEvents(MATTER_UPDATED, updatedEvents);
  return {
    message: 'Status updated for matters',
    requested,
    updated: succeeded,
    failed: Object.keys(errors),
    errors,
  };
}

/**
 * Bulk update practice area on multiple matters and their associated tasks.
 */
export async function bulkUpdatePracticeArea({ lawFirmId, userId, matterIds, practiceAreaId }: any) {
  // Resolved ONCE, above the loop, and before anything is written.
  //
  // `assertMatterWriteAccess` below authorizes the MATTER; it says nothing about
  // the practice area being written into it. `matters.practice_area_id` is a
  // single-column FK (composite would break ON DELETE SET NULL, see migration
  // 0184), so the database will not reject another firm's id either, and the
  // repository's only filter is an `isUuid` syntax check. Without this, a member
  // holding `matters.update` in their own firm could stamp another firm's
  // practice area onto their matters: the name reads back through four joins
  // that carry no firm predicate, and worse, the victim firm deleting their own
  // practice area would then null a column on a different tenant's matters.
  //
  // Above the loop rather than inside it because the practice area is one
  // loop-invariant value: checked per matter it would issue N identical queries
  // and could half-apply the batch before failing. `updatePracticeArea` below
  // carries the same guard for the single-matter case.
  if (practiceAreaId) {
    const pa = await mattersRepo.validatePracticeArea(lawFirmId, practiceAreaId);
    if (!pa) {
      throw new ValidationError('Invalid practiceAreaId for this law firm');
    }
  }

  const { requested, succeeded, errors } = await runBulk(matterIds, async (matterId: string) => {
    await assertMatterWriteAccess(lawFirmId, matterId, userId);
    // Matter-row update + task propagation run in one transaction so a mid-item
    // failure rolls back atomically (no half-applied matter/task state).
    await mattersRepo.updateMatterAndTasksTx(lawFirmId, matterId, { practiceAreaId });
  });
  return {
    message: 'Practice area updated for matters and associated tasks',
    requested,
    updated: succeeded,
    failed: Object.keys(errors),
    errors,
  };
}

/**
 * Update practice area on a single matter.
 */
export async function updatePracticeArea({ lawFirmId, matterId, userId, practiceAreaId }: any) {
  await assertMatterWriteAccess(lawFirmId, matterId, userId);

  if (practiceAreaId) {
    const pa = await mattersRepo.validatePracticeArea(lawFirmId, practiceAreaId);
    if (!pa) {
      throw new ValidationError('Invalid practiceAreaId for this law firm');
    }
  }
  // Propagate the practice area to the matter's tasks atomically, consistent with
  // the bulk practice-area op (otherwise task.practice_area_id goes stale).
  await mattersRepo.updateMatterAndTasksTx(lawFirmId, matterId, { practiceAreaId: practiceAreaId || null });
  return { message: 'Practice area updated successfully' };
}

/**
 * Conflict-of-interest check. Given prospective party names / emails / orgs,
 * report any existing firm client that matches (and the matter they're on, if any).
 * Read-only: used by the matter-creation UI to warn about potential conflicts.
 */
export async function checkConflicts({
  lawFirmId,
  userId,
  names = [],
  emails = [],
  organizations = [],
  excludeClientIds = [],
}: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  const conflicts = await mattersRepo.findConflicts(lawFirmId, {
    names,
    emails,
    organizations,
    excludeClientIds,
  });

  return { hasConflicts: conflicts.length > 0, conflicts };
}
