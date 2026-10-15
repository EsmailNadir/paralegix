const { NotFoundError, ForbiddenError } = require('../../../shared/errors/AppError');
const { resolveContext, authorizeContext, CONTEXT_TYPES, MODE_READ } = require('../context');
const flatFeesRepo = require('./flatFees.repository');
const invoicesRepo = require('../invoices/invoices.repository');
const billingReads = require('../shared/billingReads');
const { assertLawFirmMembership } = require('../../../shared/utils/membership');
const { resolvePage, parseIdList } = require('../../../shared/database/pagination');
const { MAX_PAGE_SIZE } = require('../shared/firmBillingWindow');
const { fromCents } = require('../shared/money');

function formatFlatFee(fee: any) {
  return {
    id: fee.id,
    description: fee.description || '',
    amount: fee.amount || 0,
    // The repository already returns timestamps as ISO strings; the old
    // `.toDate()` calls were a Firestore leftover that made every one null.
    date: fee.date || null,
    createdBy: fee.createdBy || null,
    contextType: fee.contextType || null,
    // Carried so the flat-fee response matches the expense and time-entry ones
    // field for field. All three derive it from the same matter/client pair.
    entityId: fee.entityId || null,
    matterId: fee.matterId || null,
    clientContextId: fee.clientContextId || null,
    clientId: fee.clientId || null,
    createdAt: fee.createdAt || null,
    updatedAt: fee.updatedAt || null,
  };
}

/**
 * List flat fees for a matter or client context.
 */
/**
 * Flat fees for one matter/client context.
 *
 * `unbilledOnly` is opt-in and filters on the derived `isBilled` for the same
 * reason `listTimeEntries` does: it means "appears on an invoice for this
 * context", computed from the invoices loaded here, so the filtered list and the
 * flag callers render share one definition.
 */
export async function listFlatFees({ lawFirmId, matterId, clientId, context, actingUserId, unbilledOnly = false }: any) {
  const resolvedContext = resolveContext({ lawFirmId, context, matterId, clientId });
  await authorizeContext(resolvedContext, actingUserId, MODE_READ);

  // One query against the line items instead of loading every invoice in the
  // context and walking its graph. Same definition — the graph's line items are
  // these rows. See `billedSourceIds`.
  const [fees, billedFlatFeeIds] = await Promise.all([
    flatFeesRepo.findByContext(resolvedContext),
    billingReads.billedSourceIds(resolvedContext, 'flat_fee'),
  ]);

  const flatFees = fees
    .map((fee: any) => ({
      ...formatFlatFee(fee),
      isBilled: billedFlatFeeIds.has(fee.id),
    }))
    .filter((fee: any) => !unbilledOnly || !fee.isBilled);

  return { flatFees };
}

/**
 * Every flat fee in the firm the caller may read, as ONE bounded page.
 *
 * Flat fees could previously only be read one context at a time, so the client
 * billing tab and the invoice composer each looped a request per matter. A
 * client with eighty matters fired eighty requests, each taking one of the
 * twelve connections the whole instance shares, to assemble a list and (on the
 * composer) a count. This answers the same question once, at a constant three
 * reads whatever the filter's size.
 *
 * ACCESS IS THE PER-CONTEXT RULE, NOT A NEW ONE. Matter fees are restricted to
 * `billingReads.listAccessibleMatters`, the helper the other firm-wide billing
 * reads use, which is owner-or-admin-sees-all plus matter membership - the same
 * audience `assertMatterReadAccess` grants on `GET /flat-fees/matter/:matterId`.
 * Client fees stay visible to any firm member because that is what
 * `GET /flat-fees/client/:clientId` already grants.
 *
 * THE WINDOW IS ALWAYS BOUNDED, which is where this deliberately parts company
 * with the older firm reads: an omitted `limit` is served at `MAX_PAGE_SIZE`
 * with `truncated` set, never as the firm's entire fee history. `totalItems` and
 * `summary` still describe the whole match set, so a caller that only needs the
 * count sends `countOnly=true` and receives it without a single row.
 *
 * `clientId` and `matterIds` are OR'd, not AND'd: see `findForFirm`.
 */
export async function listFirmFlatFees({
  lawFirmId,
  actingUserId,
  page,
  limit,
  offset,
  matterIds,
  clientId,
  context,
  billingStatus,
  dateFrom,
  dateTo,
  countOnly = false,
}: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const accessibleMatters = await billingReads.listAccessibleMatters(lawFirmId, actingUserId);

  // `limit` omitted resolves to the ceiling rather than to "no window at all".
  // The route schema has already refused anything above it, so this only fills
  // the default in and turns `page` into an offset.
  const { limit: pageLimit, offset: pageOffset } = resolvePage({
    limit, offset, page, fallbackLimit: MAX_PAGE_SIZE, max: MAX_PAGE_SIZE,
  });

  const result = await flatFeesRepo.findForFirm(lawFirmId, {
    accessibleMatterIds: accessibleMatters.map((matter: any) => matter.id),
    // undefined means "no filter"; an array (even an empty one) means the caller
    // named matters, so a list of ids that match nothing must return nothing.
    matterIds: matterIds === undefined ? undefined : (parseIdList(matterIds) || []),
    clientId,
    context,
    billingStatuses: billingStatus
      ? [...new Set(String(billingStatus).split(',').map((s) => s.trim()).filter(Boolean))]
      : null,
    dateFrom,
    dateTo,
    limit: pageLimit,
    offset: pageOffset,
    countOnly,
  });

  return {
    flatFees: result.flatFees.map((fee: any) => ({
      ...formatFlatFee(fee),
      isBilled: fee.isBilled,
    })),
    totalItems: result.totalItems,
    // Whether the window withheld rows this caller asked for. A `countOnly`
    // caller asked for none, so nothing was withheld from it and the flag stays
    // false; `totalItems` is the answer it came for.
    truncated: !countOnly && result.totalItems > pageOffset + result.flatFees.length,
    summary: { totalAmount: fromCents(result.totalCents) },
  };
}

/**
 * Create a flat fee on a matter or client context.
 */
export async function createFlatFee({ lawFirmId, matterId, clientId, context, actingUserId, body }: any) {
  const resolvedContext = resolveContext({
    lawFirmId,
    context: context || body.context,
    matterId: matterId || body.matterId,
    clientId: clientId || body.clientId,
  });
  await authorizeContext(resolvedContext, actingUserId);

  const feeData = {
    lawFirmId,
    contextType: resolvedContext.type,
    entityId: resolvedContext.entityId,
    matterId: resolvedContext.type === CONTEXT_TYPES.matter ? resolvedContext.entityId : null,
    clientContextId: resolvedContext.type === CONTEXT_TYPES.client ? resolvedContext.entityId : null,
    clientId: resolvedContext.type === CONTEXT_TYPES.client ? resolvedContext.entityId : null,
    description: (body.description || '').trim(),
    amount: parseFloat(body.amount) || 0,
    // Keep the day-only value as-is; the repo stores it in a `date` column. Wrapping
    // it in new Date() would reintroduce the UTC-midnight shift the day-only model avoids.
    date: body.date || null,
    createdBy: actingUserId,
  };

  const fee = await flatFeesRepo.create(resolvedContext, feeData);
  return { message: 'Flat fee added successfully', flatFee: formatFlatFee(fee) };
}

/**
 * Update a flat fee.
 */
export async function updateFlatFee({ lawFirmId, matterId, clientId, context, flatFeeId, actingUserId, body }: any) {
  const resolvedContext = resolveContext({ lawFirmId, context, matterId, clientId });
  await authorizeContext(resolvedContext, actingUserId);

  const existing = await flatFeesRepo.findById(resolvedContext, flatFeeId);
  if (!existing) {
    throw new NotFoundError('Flat fee');
  }

  // An invoiced flat fee exists on the invoice as a line-item snapshot, so the
  // fields that snapshot was built from are frozen once billed, matching the
  // delete guard below and the same rule on time entries and expenses. The
  // description stays editable: it does not change what was charged.
  const FROZEN_ONCE_BILLED = ['amount', 'date'];
  const attemptedFrozenEdits = FROZEN_ONCE_BILLED.filter((field) => body[field] !== undefined);
  if (attemptedFrozenEdits.length > 0
      && await billingReads.isSourceBilled(resolvedContext, 'flat_fee', [existing.id])) {
    throw new ForbiddenError('Cannot change the amount or date of a flat fee that has been billed on an invoice');
  }

  const updateData: Record<string, any> = {};
  if (body.description !== undefined) updateData.description = body.description.trim();
  if (body.amount !== undefined) updateData.amount = parseFloat(body.amount) || 0;
  if (body.date !== undefined) {
    updateData.date = body.date || null;
  }

  const updated = await flatFeesRepo.update(resolvedContext, flatFeeId, updateData);
  return { message: 'Flat fee updated successfully', flatFee: formatFlatFee(updated) };
}

/**
 * Delete a flat fee.
 */
export async function deleteFlatFee({ lawFirmId, matterId, clientId, context, flatFeeId, actingUserId }: any) {
  const resolvedContext = resolveContext({ lawFirmId, context, matterId, clientId });
  await authorizeContext(resolvedContext, actingUserId);

  const existing = await flatFeesRepo.findById(resolvedContext, flatFeeId);
  if (!existing) {
    throw new NotFoundError('Flat fee');
  }

  // Block deletion of a flat fee already billed on an invoice (it exists there as
  // a line item), matching the expense delete guard. The authoritative signal is
  // an invoice line item pointing back at this fee, not the unmaintained `billed`
  // column.
  if (await billingReads.isSourceBilled(resolvedContext, 'flat_fee', [existing.id])) {
    throw new ForbiddenError('Cannot delete a billed flat fee');
  }

  await flatFeesRepo.delete(resolvedContext, flatFeeId);
  return { message: 'Flat fee removed successfully' };
}
