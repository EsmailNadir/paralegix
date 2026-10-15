const leadStagesRepo = require('./leadStages.repository');
const mattersRepo = require('../../matters/matters.repository');
const { assertLawFirmMembership } = require('../../../shared/utils/membership');
const { NotFoundError, ValidationError } = require('../../../shared/errors/AppError');

/**
 * Enforce the tree invariants for a stage that will have `practiceAreaId` and,
 * optionally, `parentStageId`. `selfId` is the stage being updated (null on create)
 * so we can detect cycles. Throws ValidationError on any violation.
 */
async function assertValidParent(lawFirmId: string, { selfId, practiceAreaId, parentStageId }: any) {
  if (!parentStageId) return;
  if (selfId && parentStageId === selfId) {
    throw new ValidationError('A stage cannot be its own parent');
  }
  const parent = await leadStagesRepo.getById(lawFirmId, parentStageId);
  if (!parent) throw new ValidationError('Invalid parentStageId for this law firm');

  const sameScope = (parent.practiceAreaId || null) === (practiceAreaId || null);
  if (!sameScope) {
    throw new ValidationError('A stage must share the same pipeline as its parent');
  }
  if (parent.isClosed) {
    throw new ValidationError('Cannot add a stage after a closed (ending) stage');
  }
  if (selfId) {
    let cursor = parent;
    const seen = new Set();
    while (cursor && cursor.parentStageId) {
      if (seen.has(cursor.id)) break;
      seen.add(cursor.id);
      if (cursor.parentStageId === selfId) {
        throw new ValidationError('That parent would create a cycle');
      }
      cursor = await leadStagesRepo.getById(lawFirmId, cursor.parentStageId);
    }
  }
}

export async function listStages({ lawFirmId, userId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  let stages = await leadStagesRepo.listForFirm(lawFirmId);
  // Firms created before default lead-stage seeding existed start with none;
  // seed the default pipeline lazily so it's never empty.
  if (!stages.length) {
    stages = await leadStagesRepo.seedDefaultPipeline(lawFirmId);
  }
  return { stages };
}

export async function createStage({ lawFirmId, userId, body }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  if (body.practiceAreaId) {
    const pa = await mattersRepo.validatePracticeArea(lawFirmId, body.practiceAreaId);
    if (!pa) throw new ValidationError('Invalid practiceAreaId for this law firm');
  }
  await assertValidParent(lawFirmId, {
    selfId: null,
    practiceAreaId: body.practiceAreaId || null,
    parentStageId: body.parentStageId || null,
  });
  const stage = await leadStagesRepo.create(lawFirmId, body);
  return { message: 'Stage created successfully', stageId: stage.id, stage };
}

export async function updateStage({ lawFirmId, userId, stageId, body }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const existing = await leadStagesRepo.getById(lawFirmId, stageId);
  if (!existing) throw new NotFoundError('Stage');

  if (body.isClosed === true) {
    const hasKids = await leadStagesRepo.hasChildren(lawFirmId, stageId);
    if (hasKids) {
      throw new ValidationError('A stage with later steps cannot be marked as an ending');
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'parentStageId')) {
    await assertValidParent(lawFirmId, {
      selfId: stageId,
      practiceAreaId: existing.practiceAreaId || null,
      parentStageId: body.parentStageId || null,
    });
  }

  const stage = await leadStagesRepo.update(lawFirmId, stageId, body);
  return { message: 'Stage updated successfully', stage };
}

export async function deleteStage({ lawFirmId, userId, stageId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const ok = await leadStagesRepo.deleteWithReparent(lawFirmId, stageId);
  if (!ok) throw new NotFoundError('Stage');
  return { message: 'Stage deleted successfully', stageId };
}

export async function reorderStages({ lawFirmId, userId, stageIds }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  await leadStagesRepo.reorder(lawFirmId, stageIds);
  const stages = await leadStagesRepo.listForFirm(lawFirmId);
  return { message: 'Stages reordered successfully', stages };
}
