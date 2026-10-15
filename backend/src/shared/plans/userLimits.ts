export const MAX_LAW_FIRMS_PER_USER = parseInt(process.env.MAX_LAW_FIRMS_PER_USER || '', 10) || 1;

/**
 * Check whether a user can join more law firms.
 * Only applies to firm_member users. Clients are not limited.
 *
 */
export function canUserJoinMoreFirms(userData: { lawFirmIds?: unknown[] }): boolean {
  const currentFirmCount = (userData.lawFirmIds || []).length;
  return currentFirmCount < MAX_LAW_FIRMS_PER_USER;
}
