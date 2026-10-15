const matterStagePipelinesRepo = require('./matterStagePipelines.repository');
const mattersRepo = require('../matters.repository');
const matterStagesRepo = require('../stages/matterStages.repository');
const { assertLawFirmMembership } = require('../../../shared/utils/membership');
const { NotFoundError, ValidationError } = require('../../../shared/errors/AppError');

async function assertValidPracticeArea(lawFirmId: string, practiceAreaId: any) {
  if (!practiceAreaId) return;
  const pa = await mattersRepo.validatePracticeArea(lawFirmId, practiceAreaId);
  if (!pa) throw new ValidationError('Invalid practiceAreaId for this law firm');
}

export async function listPipelines({ lawFirmId, userId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const [pipelines, stages] = await Promise.all([
    matterStagePipelinesRepo.listForFirm(lawFirmId),
    matterStagesRepo.listForFirm(lawFirmId),
  ]);
  const stagesByPipeline = new Map();
  for (const stage of stages) {
    const list = stagesByPipeline.get(stage.pipelineId) || [];
    list.push(stage);
    stagesByPipeline.set(stage.pipelineId, list);
  }
  return { pipelines: pipelines.map((pipeline: any) => ({
    ...pipeline,
    stages: stagesByPipeline.get(pipeline.id) || [],
  })) };
}

function orderStages(stages: any[]) {
  const byId = new Map(stages.map((stage) => [stage.clientId, stage]));
  if (byId.size !== stages.length) throw new ValidationError('Each stage must have a unique clientId');

  const children = new Map();
  for (const stage of stages) {
    if (stage.parentClientId && !byId.has(stage.parentClientId)) {
      throw new ValidationError(`Unknown parent stage for "${stage.name}"`);
    }
    if (stage.parentClientId === stage.clientId) {
      throw new ValidationError('A stage cannot be its own parent');
    }
    const siblings = children.get(stage.parentClientId || null) || [];
    siblings.push(stage);
    children.set(stage.parentClientId || null, siblings);
  }

  const ordered: any[] = [];
  const visiting = new Set();
  const visited = new Set();
  const walk = (stage: any) => {
    if (visiting.has(stage.clientId)) throw new ValidationError('Stage relationships cannot contain a cycle');
    if (visited.has(stage.clientId)) return;
    visiting.add(stage.clientId);
    ordered.push(stage);
    const next = [...(children.get(stage.clientId) || [])]
      .sort((a, b) => a.sortOrder - b.sortOrder);
    for (const child of next) walk(child);
    visiting.delete(stage.clientId);
    visited.add(stage.clientId);
  };
  const roots = [...(children.get(null) || [])].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const root of roots) walk(root);
  if (ordered.length !== stages.length) throw new ValidationError('Every stage must connect to a valid root');
  for (const stage of stages) {
    if (stage.isClosed && (children.get(stage.clientId) || []).length > 0) {
      throw new ValidationError('An ending stage cannot have later stages');
    }
  }
  return ordered;
}

export async function createPipeline({ lawFirmId, userId, body }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  await assertValidPracticeArea(lawFirmId, body.practiceAreaId);
  const orderedStages = orderStages(body.stages);
  const created = await matterStagePipelinesRepo.createWithStages(lawFirmId, body, orderedStages);
  return {
    message: 'Pipeline created successfully',
    pipelineId: created.pipeline.id,
    pipeline: { ...created.pipeline, stages: created.stages },
  };
}

export async function updatePipeline({ lawFirmId, userId, pipelineId, body }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  await assertValidPracticeArea(lawFirmId, body.practiceAreaId);
  const pipeline = await matterStagePipelinesRepo.update(lawFirmId, pipelineId, body);
  if (!pipeline) throw new NotFoundError('Pipeline');
  const stages = await matterStagesRepo.listForPipeline(lawFirmId, pipelineId);
  return { message: 'Pipeline updated successfully', pipeline: { ...pipeline, stages } };
}

export async function deletePipeline({ lawFirmId, userId, pipelineId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const ok = await matterStagePipelinesRepo.delete(lawFirmId, pipelineId);
  if (!ok) throw new NotFoundError('Pipeline');
  return { message: 'Pipeline deleted successfully', pipelineId };
}
