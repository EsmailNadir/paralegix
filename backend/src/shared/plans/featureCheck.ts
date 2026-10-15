const { getEffectiveFeatures } = require('./planDefinitions');

/**
 * Check if a feature is enabled for a law firm.
 * Combines plan features with firm-level settings overrides.
 * A feature is enabled only if the plan allows it AND the firm settings haven't disabled it.
 *
 * @param {object} lawFirmData - the full law firm document data
 * @param {string} featureName - e.g. 'calendarSync', 'analytics'
 * @returns {boolean}
 */
export function isFeatureEnabled(lawFirmData: any, featureName: string) {
  const planFeatures = getEffectiveFeatures(lawFirmData);

  if (!planFeatures[featureName]) {
    return false;
  }

  // Check firm-level settings overrides (a firm can disable a feature even if the plan allows it)
  const firmFeatureSettings = lawFirmData?.settings?.features;
  if (firmFeatureSettings && firmFeatureSettings[featureName] === false) {
    return false;
  }

  return true;
}

/**
 * Every feature flag for a firm, resolved through `isFeatureEnabled`.
 *
 * The same answer the API gates give, in the shape a client needs to decide what
 * to render. Built for surfaces that hand a feature map to a UI (the portal's
 * firm list, firm settings) so the nav a user sees and the routes they can call
 * are decided by one rule instead of two that drift.
 */
export function getEnabledFeatures(lawFirmData: any): Record<string, boolean> {
  const planFeatures = getEffectiveFeatures(lawFirmData);
  const resolved: Record<string, boolean> = {};
  Object.keys(planFeatures).forEach((feature) => {
    resolved[feature] = isFeatureEnabled(lawFirmData, feature);
  });
  return resolved;
}
