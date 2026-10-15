const templatesRepo = require('./documentRequestTemplates.repository');
const { assertLawFirmMembership } = require('../../../shared/utils/membership');
const { NotFoundError, ValidationError } = require('../../../shared/errors/AppError');

function cleanItems(items: any): { label: string; description: string | null }[] {
  if (!Array.isArray(items)) return [];
  const out: { label: string; description: string | null }[] = [];
  for (const item of items) {
    const label = (item?.label || '').trim();
    if (!label) continue;
    out.push({ label, description: (item?.description || '').trim() || null });
  }
  return out;
}

export async function listTemplates({ lawFirmId, userId, includeArchived = false }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const templates = await templatesRepo.listForFirm(lawFirmId, { includeArchived });
  return { templates };
}

export async function createTemplate({ lawFirmId, userId, body }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const template = await templatesRepo.create(lawFirmId, {
    name: body.name.trim(),
    defaultTitle: body.defaultTitle.trim(),
    defaultNote: body.defaultNote?.trim() || null,
    items: cleanItems(body.items),
    createdBy: userId,
  });
  return { message: 'Template created successfully', templateId: template.id, template };
}

export async function updateTemplate({ lawFirmId, userId, templateId, body }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const existing = await templatesRepo.getById(lawFirmId, templateId);
  if (!existing) throw new NotFoundError('Document request template');

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) {
    if (!body.name.trim()) throw new ValidationError('Name is required');
    updates.name = body.name.trim();
  }
  if (body.defaultTitle !== undefined) {
    if (!body.defaultTitle.trim()) throw new ValidationError('Default title is required');
    updates.defaultTitle = body.defaultTitle.trim();
  }
  if (body.defaultNote !== undefined) updates.defaultNote = body.defaultNote?.trim() || null;
  if (body.items !== undefined) updates.items = cleanItems(body.items);
  if (body.archived !== undefined) updates.archived = body.archived;

  const template = await templatesRepo.update(lawFirmId, templateId, updates);
  return { message: 'Template updated successfully', template };
}

export async function archiveTemplate({ lawFirmId, userId, templateId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const existing = await templatesRepo.getById(lawFirmId, templateId);
  if (!existing) throw new NotFoundError('Document request template');
  await templatesRepo.update(lawFirmId, templateId, { archived: true });
  return { message: 'Template deleted successfully', templateId };
}
