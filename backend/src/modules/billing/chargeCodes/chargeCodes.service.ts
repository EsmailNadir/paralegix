const { assertLawFirmMembership } = require('../../../shared/utils/membership');
const { NotFoundError, ValidationError } = require('../../../shared/errors/AppError');
const chargeCodesRepo = require('./chargeCodes.repository');

/**
 * List charge codes for a law firm.
 * Optionally include inactive codes.
 */
export async function listChargeCodes({ lawFirmId, actingUserId, includeInactive }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  let codes = await chargeCodesRepo.findAll(lawFirmId);

  if (!includeInactive) {
    codes = codes.filter((cc: any) => cc.isActive === true);
  }

  // Sort by order, then by code
  codes.sort((a: any, b: any) => {
    if (a.order !== b.order) return a.order - b.order;
    return (a.code || '').localeCompare(b.code || '');
  });

  return { chargeCodes: codes };
}

/**
 * Get a single charge code by ID.
 */
export async function getChargeCode({ lawFirmId, chargeCodeId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const code = await chargeCodesRepo.findById(lawFirmId, chargeCodeId);
  if (!code) {
    throw new NotFoundError('Charge code');
  }

  return code;
}

/**
 * Create a charge code.
 */
export async function createChargeCode({ lawFirmId, actingUserId, body }: any) {
  const { code, name, defaultRate, memberRates } = body;

  await assertLawFirmMembership(lawFirmId, actingUserId);

  // Check uniqueness
  const existing = await chargeCodesRepo.findByCode(lawFirmId, code);
  if (existing.length > 0) {
    throw new ValidationError('Charge code already exists');
  }

  const nextOrder = (await chargeCodesRepo.getMaxOrder(lawFirmId)) + 1;

  const chargeCode = await chargeCodesRepo.create(lawFirmId, {
    lawFirmId,
    code: code.toUpperCase(),
    name: name.trim(),
    isActive: true,
    order: nextOrder,
    defaultRate: defaultRate !== undefined ? defaultRate : null,
    memberRates: memberRates || {},
    createdBy: actingUserId,
  });

  return { message: 'Charge code created successfully', chargeCodeId: chargeCode.id };
}

/**
 * Update a charge code.
 */
export async function updateChargeCode({ lawFirmId, chargeCodeId, actingUserId, body }: any) {
  const { code, name, isActive, defaultRate, memberRates } = body;

  await assertLawFirmMembership(lawFirmId, actingUserId);

  const existing = await chargeCodesRepo.findById(lawFirmId, chargeCodeId);
  if (!existing) {
    throw new NotFoundError('Charge code');
  }

  const updateData: Record<string, any> = {};

  if (code !== undefined) {
    const upperCode = code.toUpperCase();
    // Check uniqueness excluding this document
    const dupes = await chargeCodesRepo.findByCode(lawFirmId, upperCode);
    const conflicts = dupes.filter((d: any) => d.id !== chargeCodeId);
    if (conflicts.length > 0) {
      throw new ValidationError('Charge code already exists');
    }
    updateData.code = upperCode;
  }

  if (name !== undefined) updateData.name = name.trim();
  if (isActive !== undefined) updateData.isActive = isActive;
  if (defaultRate !== undefined) updateData.defaultRate = defaultRate;
  if (memberRates !== undefined) updateData.memberRates = memberRates;

  await chargeCodesRepo.update(lawFirmId, chargeCodeId, updateData);
  return { message: 'Charge code updated successfully' };
}

/**
 * Delete a charge code.
 * Fails if the code is referenced by any time entry.
 */
export async function deleteChargeCode({ lawFirmId, chargeCodeId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const existing = await chargeCodesRepo.findById(lawFirmId, chargeCodeId);
  if (!existing) {
    throw new NotFoundError('Charge code');
  }

  const isUsed = await chargeCodesRepo.isUsedByTimeEntries(lawFirmId, chargeCodeId);
  if (isUsed) {
    throw new ValidationError('Cannot delete charge code. It is being used in time entries. Please deactivate it instead.');
  }

  await chargeCodesRepo.delete(lawFirmId, chargeCodeId);
  return { message: 'Charge code deleted successfully' };
}

/**
 * Reorder charge codes.
 */
export async function reorderChargeCodes({ lawFirmId, actingUserId, body }: any) {
  const { chargeCodeIds } = body;

  await assertLawFirmMembership(lawFirmId, actingUserId);
  await chargeCodesRepo.reorder(lawFirmId, chargeCodeIds);
  return { message: 'Charge codes reordered successfully' };
}
