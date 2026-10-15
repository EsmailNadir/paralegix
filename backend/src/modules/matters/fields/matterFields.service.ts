const matterFieldsRepo = require('./matterFields.repository');
const mattersRepo = require('../matters.repository');
const { assertLawFirmMembership } = require('../../../shared/utils/membership');
const { NotFoundError, ValidationError } = require('../../../shared/errors/AppError');

// Normalize a caller-supplied options list to a stable [{ label, value }] shape.
// Accepts plain strings or { label, value } objects; blanks are dropped.
export function normalizeOptions(options: any) {
  if (!Array.isArray(options)) return [];
  const seen = new Set();
  const out = [];
  for (const opt of options) {
    const label = (typeof opt === 'string' ? opt : opt?.label || '').trim();
    if (!label) continue;
    const value = (typeof opt === 'string' ? opt : (opt?.value || opt?.label || '')).trim() || label;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ label, value });
  }
  return out;
}

const CHOICE_TYPES = ['select', 'multiselect'];

export async function listFieldDefs({ lawFirmId, userId, includeArchived = false }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const fieldDefs = await matterFieldsRepo.listForFirm(lawFirmId, { includeArchived });
  return { fieldDefs };
}

export async function createFieldDef({ lawFirmId, userId, body }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const fieldType = body.fieldType || 'text';
  if (CHOICE_TYPES.includes(fieldType)) {
    const options = normalizeOptions(body.options);
    if (!options.length) throw new ValidationError('Select fields need at least one option');
    body = { ...body, options };
  }
  // Validate the practice area belongs to this firm (null = firm-wide field).
  if (body.practiceAreaId) {
    const pa = await mattersRepo.validatePracticeArea(lawFirmId, body.practiceAreaId);
    if (!pa) throw new ValidationError('Invalid practiceAreaId for this law firm');
  }
  const fieldDef = await matterFieldsRepo.create(lawFirmId, {
    ...body,
    options: normalizeOptions(body.options),
    createdBy: userId,
  });
  return { message: 'Custom field created successfully', fieldDefId: fieldDef.id, fieldDef };
}

export async function updateFieldDef({ lawFirmId, userId, defId, body }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const existing = await matterFieldsRepo.getById(lawFirmId, defId);
  if (!existing) throw new NotFoundError('Custom field');

  const updates = { ...body };
  const effectiveType = body.fieldType || existing.fieldType;
  if (body.options !== undefined || CHOICE_TYPES.includes(effectiveType)) {
    updates.options = normalizeOptions(body.options !== undefined ? body.options : existing.options);
    if (CHOICE_TYPES.includes(effectiveType) && !updates.options.length) {
      throw new ValidationError('Select fields need at least one option');
    }
  }
  if (body.practiceAreaId) {
    const pa = await mattersRepo.validatePracticeArea(lawFirmId, body.practiceAreaId);
    if (!pa) throw new ValidationError('Invalid practiceAreaId for this law firm');
  }
  const fieldDef = await matterFieldsRepo.update(lawFirmId, defId, updates);
  return { message: 'Custom field updated successfully', fieldDef };
}

export async function deleteFieldDef({ lawFirmId, userId, defId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const existing = await matterFieldsRepo.getById(lawFirmId, defId);
  if (!existing) throw new NotFoundError('Custom field');
  // Archive rather than hard-delete: matters still carry values keyed by this def
  // id in their custom_fields jsonb, so dropping the row would orphan that data and
  // lose the label/type needed to display it. Archived defs are excluded from the
  // applicable-fields list, so they stop collecting new values.
  await matterFieldsRepo.update(lawFirmId, defId, { archived: true });
  return { message: 'Custom field deleted successfully', fieldDefId: defId };
}
