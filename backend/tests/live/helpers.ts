/**
 * Shared test helpers for the integration suite.
 *
 * The seeded test account (see tests/README or memory) is a member of more than
 * one law firm: a legacy imported firm whose roles predate several newer
 * permission codes, and a clean firm ("Test3 Test Firm") whose owner role has
 * the full permission set and comped billing. Picking `lawFirmIds[0]` blindly
 * lands on the legacy firm and yields spurious 403s, so every suite should
 * resolve its working firm through `getPrimaryLawFirmId()` instead.
 */

const { api } = require('./setup');

const PREFERRED_FIRM_NAME = 'Test3 Test Firm';
const ACTIVE_BILLING = new Set(['comped', 'active', 'trialing']);

let cachedFirmId: any = null;

/**
 * Resolve the law firm the suite should operate against: the clean, fully
 * permissioned, comped firm. Falls back gracefully so the helper still returns
 * *a* firm on any seed.
 *
 * @param {string} token
 * @returns {Promise<string>} lawFirmId
 */
export async function getPrimaryLawFirmId(token: any) {
  if (cachedFirmId) return cachedFirmId;

  const res = await api.get('/api/users/my-lawfirms', { token });
  if (res.status !== 200 || !Array.isArray(res.body.lawFirmIds) || res.body.lawFirmIds.length === 0) {
    throw new Error(`Could not resolve test law firms (status ${res.status})`);
  }
  const ids = res.body.lawFirmIds;

  const firms = [];
  for (const id of ids) {
    const detail = await api.get(`/api/lawfirms/${id}`, { token });
    if (detail.status === 200 && detail.body) {
      firms.push({ id, name: detail.body.name, billingStatus: detail.body.billingStatus });
    }
  }

  const byName = firms.find((f) => f.name === PREFERRED_FIRM_NAME);
  if (byName) {
    cachedFirmId = byName.id;
    return cachedFirmId;
  }

  // Both seeded firms can be comped, so billing status alone does not
  // distinguish the fully permissioned firm from the legacy one. Probe a
  // permission-gated read to find the firm whose role actually has the modern
  // permission set; this is deterministic and immune to a concurrent rename of
  // the preferred firm elsewhere in the suite.
  for (const f of firms) {
    const probe = await api.get(`/api/lawfirms/${f.id}/billing/charge-codes`, { token });
    if (probe.status === 200) {
      cachedFirmId = f.id;
      return cachedFirmId;
    }
  }

  const byBilling = firms.find((f) => ACTIVE_BILLING.has(f.billingStatus));
  cachedFirmId = (byBilling || firms[0] || { id: ids[0] }).id;
  return cachedFirmId;
}

/**
 * Convenience bootstrap used in most `beforeAll` blocks.
 * @returns {Promise<{ token: string, userId: string, lawFirmId: string }>}
 */
export async function bootstrapFirm() {
  const { getTestToken } = require('./auth-helper');
  const { token, userId } = await getTestToken();
  const lawFirmId = await getPrimaryLawFirmId(token);
  return { token, userId, lawFirmId };
}
