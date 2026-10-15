/**
 * Centralised rate resolution for billing.
 *
 * 9-tier hierarchy (matches Clio priority):
 *  1. Time entry explicit hourlyRate       (manual override)
 *  2. Matter member hourlyRate               (per-matter, per-user)
 *  3. Client billingRates.memberRates[uid] (per-client, per-user)
 *  4. Client billingRates.defaultRate      (per-client, all users)
 *  5. Charge code memberRates[uid]         (per-code, per-user)
 *  6. Charge code defaultRate              (per-code)
 *  7. User default hourly rate             (per-user firm-wide fallback)
 *  8. Firm settings billing.defaultRate    (firm-wide fallback)
 *  9. Fallback: 0
 */

/**
 * A configured rate, or null when the tier has none set.
 *
 * Accepts numeric strings as well as numbers: rates that live in Postgres
 * `numeric` columns (billing_codes.default_rate) come back from node-pg as
 * strings, and a plain `typeof === 'number'` test silently skipped that tier and
 * billed the work at a lower tier's rate (or $0). 0 is a real setting (pro bono)
 * and is preserved; null/undefined/''/NaN/booleans all mean "not set".
 */
export function configuredRate(value: any) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Resolve the billing rate for a time entry.
 *
 * @param {Object} params
 * @param {Object} params.entry            - Time entry document (must have userId, may have hourlyRate/chargeCodeId)
 * @param {Array}  [params.matterMembers]    - matter.members array (objects with userId, hourlyRate)
 * @param {Object} [params.clientBillingRates] - client.billingRates { defaultRate, memberRates }
 * @param {Object} [params.chargeCode]     - Charge code document { defaultRate, memberRates }
 * @param {Object} [params.memberDefaultRates] - Map of userId → defaultHourlyRate from firm members
 * @param {number} [params.firmDefaultRate] - Firm-level billing.defaultRate
 * @returns {{ rate: number, source: string }}
 */
export function resolveRate({ entry, matterMembers, clientBillingRates, chargeCode, memberDefaultRates, firmDefaultRate }: any) {
  const userId = entry.userId || null;

  // Tier 1: Time entry explicit hourlyRate
  const entryRate = configuredRate(entry.hourlyRate);
  if (entryRate !== null) {
    return { rate: entryRate, source: 'time entry override' };
  }

  // Tier 2: Matter member hourlyRate
  if (Array.isArray(matterMembers) && userId) {
    const member = matterMembers.find((m: any) => m && m.userId === userId);
    const memberRate = configuredRate(member?.hourlyRate);
    if (memberRate !== null) {
      return { rate: memberRate, source: 'matter member rate' };
    }
  }

  // Tier 3: Client per-member rate
  if (clientBillingRates && userId) {
    const clientMemberRate = configuredRate(clientBillingRates.memberRates?.[userId]);
    if (clientMemberRate !== null) {
      return { rate: clientMemberRate, source: 'client member rate' };
    }
  }

  // Tier 4: Client default rate
  const clientDefault = configuredRate(clientBillingRates?.defaultRate);
  if (clientDefault !== null) {
    return { rate: clientDefault, source: 'client default rate' };
  }

  // Tier 5: Charge code per-member rate
  if (chargeCode && userId) {
    const codeMemberRate = configuredRate(chargeCode.memberRates?.[userId]);
    if (codeMemberRate !== null) {
      return { rate: codeMemberRate, source: 'charge code member rate' };
    }
  }

  // Tier 6: Charge code default rate
  const codeDefault = configuredRate(chargeCode?.defaultRate);
  if (codeDefault !== null) {
    return { rate: codeDefault, source: 'charge code default' };
  }

  // Tier 7: User default hourly rate (firm-wide per-user fallback)
  if (memberDefaultRates && userId) {
    const userDefault = configuredRate(memberDefaultRates[userId]);
    if (userDefault !== null) {
      return { rate: userDefault, source: 'user default rate' };
    }
  }

  // Tier 8: Firm default rate
  const firmDefault = configuredRate(firmDefaultRate);
  if (firmDefault !== null) {
    return { rate: firmDefault, source: 'firm default rate' };
  }

  // Tier 9: Fallback
  return { rate: 0, source: 'none' };
}

/**
 * Convenience: resolve rate and return just the numeric value.
 * Matches the old resolveRate() signature that returned a number.
 */
export function resolveRateValue(params: any) {
  return resolveRate(params).rate;
}

/**
 * Resolve rate given rows from `billing_rates` table for the context.
 *
 * Precedence matches the 9-tier hierarchy:
 *  1. Time entry explicit rate (cents)
 *  2. Matter member rate: scope_kind = 'matter', matter_id, user_id
 *  3. Client member rate: scope_kind = 'client', client_id, user_id
 *  4. Client default rate: scope_kind = 'client', client_id, user_id is null
 *  5. Billing code member rate: scope_kind = 'billing_code', billing_code_id, user_id
 *  6. Billing code default: scope_kind = 'billing_code', billing_code_id, user_id is null
 *  7. User default rate: scope_kind = 'member', user_id
 *  8. Firm default rate: scope_kind = 'firm'
 *  9. None (0)
 */
export function resolveRateFromRatesTable({
  entryRateCents,
  userId,
  matterId,
  clientId,
  billingCodeId,
  rates = [],
}: {
  entryRateCents?: number | null;
  userId?: string | null;
  matterId?: string | null;
  clientId?: string | null;
  billingCodeId?: string | null;
  rates?: Array<{
    scopeKind: string;
    clientId?: string | null;
    matterId?: string | null;
    billingCodeId?: string | null;
    userId?: string | null;
    rateCents: number | bigint;
  }>;
}) {
  if (entryRateCents != null && Number.isFinite(Number(entryRateCents))) {
    return { rateCents: Number(entryRateCents), source: 'time entry override' };
  }

  // Tier 2: Matter member rate
  if (matterId && userId) {
    const r = rates.find(
      (x) => x.scopeKind === 'matter' && x.matterId === matterId && x.userId === userId,
    );
    if (r) return { rateCents: Number(r.rateCents), source: 'matter member rate' };
  }

  // Tier 3: Client member rate
  if (clientId && userId) {
    const r = rates.find(
      (x) => x.scopeKind === 'client' && x.clientId === clientId && x.userId === userId,
    );
    if (r) return { rateCents: Number(r.rateCents), source: 'client member rate' };
  }

  // Tier 4: Client default rate
  if (clientId) {
    const r = rates.find(
      (x) => x.scopeKind === 'client' && x.clientId === clientId && !x.userId,
    );
    if (r) return { rateCents: Number(r.rateCents), source: 'client default rate' };
  }

  // Tier 5: Billing code member rate
  if (billingCodeId && userId) {
    const r = rates.find(
      (x) => x.scopeKind === 'billing_code' && x.billingCodeId === billingCodeId && x.userId === userId,
    );
    if (r) return { rateCents: Number(r.rateCents), source: 'charge code member rate' };
  }

  // Tier 6: Billing code default rate
  if (billingCodeId) {
    const r = rates.find(
      (x) => x.scopeKind === 'billing_code' && x.billingCodeId === billingCodeId && !x.userId,
    );
    if (r) return { rateCents: Number(r.rateCents), source: 'charge code default' };
  }

  // Tier 7: User default rate
  if (userId) {
    const r = rates.find(
      (x) => x.scopeKind === 'member' && x.userId === userId,
    );
    if (r) return { rateCents: Number(r.rateCents), source: 'user default rate' };
  }

  // Tier 8: Firm default rate
  const firmRate = rates.find((x) => x.scopeKind === 'firm');
  if (firmRate) return { rateCents: Number(firmRate.rateCents), source: 'firm default rate' };

  return { rateCents: 0, source: 'none' };
}
