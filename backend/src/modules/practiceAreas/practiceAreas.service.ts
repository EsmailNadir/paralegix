import { createLookupService } from '../../shared/lookup/lookupService';

const practiceAreasRepo = require('./practiceAreas.repository');

/**
 * The firm's practice-area list. A reference table; see `courts.service` for the
 * same shape with more columns.
 */
const service = createLookupService({
  repository: practiceAreasRepo,
  label: 'Practice area',
  collectionKey: 'practiceAreas',
  idKey: 'practiceAreaId',
  fields: ['name'],
});

export const createPracticeArea = service.create;
export const listPracticeAreas = service.list;

export async function getPracticeArea({ lawFirmId, practiceAreaId }: any) {
  return service.get({ lawFirmId, id: practiceAreaId });
}

export async function updatePracticeArea({ lawFirmId, practiceAreaId, body }: any) {
  return service.update({ lawFirmId, id: practiceAreaId, body });
}

export async function deletePracticeArea({ lawFirmId, practiceAreaId }: any) {
  return service.delete({ lawFirmId, id: practiceAreaId });
}
