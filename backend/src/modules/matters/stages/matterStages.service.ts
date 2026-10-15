const matterStagesRepo = require('./matterStages.repository');
const matterStagePipelinesRepo = require('../pipelines/matterStagePipelines.repository');
const { assertLawFirmMembership } = require('../../../shared/utils/membership');
const { NotFoundError, ValidationError } = require('../../../shared/errors/AppError');

/**
 * Enforce the tree invariants for a stage that will have `pipelineId` and,
 * optionally, `parentStageId`. `selfId` is the stage being updated (null on create)
 * so we can detect cycles. Throws ValidationError on any violation.
 */
async function assertValidParent(lawFirmId: string, { selfId, pipelineId, parentStageId }: any) {
  if (!parentStageId) return; // roots are always valid
  if (selfId && parentStageId === selfId) {
    throw new ValidationError('A stage cannot be its own parent');
  }
  const parent = await matterStagesRepo.getById(lawFirmId, parentStageId);
  if (!parent) throw new ValidationError('Invalid parentStageId for this law firm');

  if (parent.pipelineId !== pipelineId) {
    throw new ValidationError('A stage must share the same pipeline as its parent');
  }
  if (parent.isClosed) {
    throw new ValidationError('Cannot add a stage after a closed (ending) stage');
  }
  // Cycle check: walk up from the proposed parent; if we reach selfId it's a cycle.
  if (selfId) {
    let cursor = parent;
    const seen = new Set();
    while (cursor && cursor.parentStageId) {
      if (seen.has(cursor.id)) break; // defensive against pre-existing bad data
      seen.add(cursor.id);
      if (cursor.parentStageId === selfId) {
        throw new ValidationError('That parent would create a cycle');
      }
      cursor = await matterStagesRepo.getById(lawFirmId, cursor.parentStageId);
    }
  }
}

export async function createStage({ lawFirmId, userId, body }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const pipeline = await matterStagePipelinesRepo.getById(lawFirmId, body.pipelineId);
  if (!pipeline) throw new ValidationError('Invalid pipelineId for this law firm');
  await assertValidParent(lawFirmId, {
    selfId: null,
    pipelineId: body.pipelineId,
    parentStageId: body.parentStageId || null,
  });
  const siblings = (await matterStagesRepo.listForPipeline(lawFirmId, body.pipelineId))
    .filter((stage: any) => (stage.parentStageId || null) === (body.parentStageId || null));
  const sortOrder = body.sortOrder ?? siblings.reduce(
    (highest: number, stage: any) => Math.max(highest, stage.sortOrder),
    -1,
  ) + 1;
  const stage = await matterStagesRepo.create(lawFirmId, { ...body, sortOrder });
  return { message: 'Stage created successfully', stageId: stage.id, stage };
}

export async function updateStage({ lawFirmId, userId, stageId, body }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const existing = await matterStagesRepo.getById(lawFirmId, stageId);
  if (!existing) throw new NotFoundError('Stage');

  // A stage with children can't be an ending point.
  if (body.isClosed === true) {
    const hasKids = await matterStagesRepo.hasChildren(lawFirmId, stageId);
    if (hasKids) {
      throw new ValidationError('A stage with later steps cannot be marked as an ending');
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'parentStageId')) {
    await assertValidParent(lawFirmId, {
      selfId: stageId,
      pipelineId: existing.pipelineId,
      parentStageId: body.parentStageId || null,
    });
  }

  const stage = await matterStagesRepo.update(lawFirmId, stageId, body);
  return { message: 'Stage updated successfully', stage };
}

export async function deleteStage({ lawFirmId, userId, stageId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const ok = await matterStagesRepo.deleteWithReparent(lawFirmId, stageId);
  if (!ok) throw new NotFoundError('Stage');
  return { message: 'Stage deleted successfully', stageId };
}
