import { createLookupService } from '../../shared/lookup/lookupService';

const courtsRepo = require('./courts.repository');

/**
 * The firm's court list. A reference table, so the five operations come from the
 * shared lookup service; only the noun and the column list are this module's.
 *
 * `courts.id` is referenced by `matters.court_id`, which is why the delete path
 * is worth caring about: an unscoped one would blank the court on another firm's
 * matters with nothing on either firm's screen looking wrong.
 *
 * Each export keeps this module's own `courtId` argument name rather than the
 * factory's generic `id`. Callers name it that way, and renaming a service
 * argument would be an interface change riding along on a refactor.
 */
const service = createLookupService({
  repository: courtsRepo,
  label: 'Court',
  collectionKey: 'courts',
  idKey: 'courtId',
  fields: ['name', 'abbreviation', 'city', 'state', 'address', 'courtType'],
});

export const createCourt = service.create;
export const listCourts = service.list;

export async function getCourt({ lawFirmId, courtId }: any) {
  return service.get({ lawFirmId, id: courtId });
}

export async function updateCourt({ lawFirmId, courtId, body }: any) {
  return service.update({ lawFirmId, id: courtId, body });
}

export async function deleteCourt({ lawFirmId, courtId }: any) {
  return service.delete({ lawFirmId, id: courtId });
}
