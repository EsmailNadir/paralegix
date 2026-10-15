const intakeFormsRepo = require('./intakeForms.repository');
const mattersRepo = require('../matters/matters.repository');
const { assertLawFirmMembership } = require('../../shared/utils/membership');
const { NotFoundError, ValidationError } = require('../../shared/errors/AppError');

function slugifyKey(label: string, index: number) {
  const base = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
  return base || `field_${index + 1}`;
}

function normalizeFields(fields: any) {
  if (!Array.isArray(fields)) return [];
  const seen = new Set();
  return fields.map((f: any, index: number) => {
    let key = String(f.key || '').trim() || slugifyKey(f.label, index);
    if (seen.has(key)) key = `${key}_${index + 1}`;
    seen.add(key);
    return {
      key,
      label: String(f.label || '').trim(),
      type: f.type || 'text',
      required: f.required === true,
      options: Array.isArray(f.options) ? f.options.map((o: any) => String(o)) : undefined,
    };
  });
}

export async function listIntakeForms({ lawFirmId, userId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  let templates = await intakeFormsRepo.listTemplates(lawFirmId);
  // Firms created before default intake-form seeding existed start with none;
  // seed the default form lazily so it's never empty.
  if (!templates.length) {
    await intakeFormsRepo.createDefaultTemplate(lawFirmId, { createdBy: userId });
    templates = await intakeFormsRepo.listTemplates(lawFirmId);
  }
  return { templates };
}

export async function getIntakeForm({ lawFirmId, userId, templateId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const template = await intakeFormsRepo.getTemplateById(lawFirmId, templateId);
  if (!template) throw new NotFoundError('Intake form');
  return { template };
}

export async function createIntakeForm({ lawFirmId, userId, body }: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  const name = (body.name || '').trim();
  if (!name) throw new ValidationError({ name: ['Form name is required'] });

  if (body.practiceAreaId) {
    const pa = await mattersRepo.validatePracticeArea(lawFirmId, body.practiceAreaId);
    if (!pa) throw new ValidationError({ practiceAreaId: ['Invalid practiceAreaId for this law firm'] });
  }

  let accessCodeHash = null;
  if (body.accessCode != null && String(body.accessCode).trim()) {
    accessCodeHash = intakeFormsRepo.hashAccessCode(String(body.accessCode).trim());
  }

  const template = await intakeFormsRepo.createTemplate(lawFirmId, {
    name,
    practiceAreaId: body.practiceAreaId || null,
    fields: normalizeFields(body.fields),
    accessCodeHash,
    isActive: body.isActive !== false,
    createdBy: userId,
  });

  return { message: 'Intake form created successfully', templateId: template.id, template };
}

export async function updateIntakeForm({ lawFirmId, userId, templateId, body }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const existing = await intakeFormsRepo.getTemplateById(lawFirmId, templateId);
  if (!existing) throw new NotFoundError('Intake form');

  if (body.practiceAreaId) {
    const pa = await mattersRepo.validatePracticeArea(lawFirmId, body.practiceAreaId);
    if (!pa) throw new ValidationError({ practiceAreaId: ['Invalid practiceAreaId for this law firm'] });
  }

  const updates: Record<string, any> = {};
  if (body.name !== undefined) {
    const name = (body.name || '').trim();
    if (!name) throw new ValidationError({ name: ['Form name is required'] });
    updates.name = name;
  }
  if (body.practiceAreaId !== undefined) updates.practiceAreaId = body.practiceAreaId || null;
  if (body.fields !== undefined) updates.fields = normalizeFields(body.fields);
  if (body.isActive !== undefined) updates.isActive = body.isActive === true;
  if (Object.prototype.hasOwnProperty.call(body, 'accessCode')) {
    if (body.accessCode == null || String(body.accessCode).trim() === '') {
      updates.accessCodeHash = null;
    } else {
      updates.accessCodeHash = intakeFormsRepo.hashAccessCode(String(body.accessCode).trim());
    }
  }

  const template = await intakeFormsRepo.updateTemplate(lawFirmId, templateId, updates);
  if (!template) throw new NotFoundError('Intake form');
  return { message: 'Intake form updated successfully', template };
}

export async function deleteIntakeForm({ lawFirmId, userId, templateId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const ok = await intakeFormsRepo.deleteTemplate(lawFirmId, templateId);
  if (!ok) throw new NotFoundError('Intake form');
  return { message: 'Intake form deleted successfully', templateId };
}

export async function regenerateIntakeFormToken({ lawFirmId, userId, templateId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const existing = await intakeFormsRepo.getTemplateById(lawFirmId, templateId);
  if (!existing) throw new NotFoundError('Intake form');
  const template = await intakeFormsRepo.regeneratePublicToken(lawFirmId, templateId);
  return { message: 'Public token regenerated', template };
}
