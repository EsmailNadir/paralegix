// Per-firm billing settings. Stored under `law_firms.settings -> 'billing'` (a
// jsonb sub-object) so no dedicated table is needed for a small, firm-wide config
// blob. Mirrors the trust-settings read-modify-write pattern in trust.repository.
const { financialRootSql, financialSql, withDrizzleTransaction } = require('../../../shared/database/financialQuery');
const { NotFoundError } = require('../../../shared/errors/AppError');
import { DEFAULT_CARD_FEE_SETTINGS } from '../../stripe/cardFeeRules';

// Defaults merged on top of any stored overrides.
// clientPaymentEmails: send client-facing payment receipts and refund/reversal
// notices. Defaults ON so firms opt out rather than in.
// timeRounding: round time-entry hours up to a fixed billing increment on save.
// Defaults OFF so existing firms' hours are never silently altered; firms opt in.
// lateFee: a one-time late fee (NOT interest) added to an overdue invoice once it
// is past due beyond the grace period. Off by default. `flatAmount` and `percent`
// stack: fee = flatAmount + (percent% of the remaining balance). `autoApply` lets
// the daily cron add the fee automatically; otherwise firms apply it per invoice.
export const BILLING_SETTINGS_DEFAULTS = {
  clientPaymentEmails: true,
  timeRounding: {
    enabled: false,
    incrementMinutes: 6,
  },
  lateFee: {
    enabled: false,
    flatAmount: 0,
    percent: 0,
    graceDays: 0,
    autoApply: false,
  },
  // tax: optional sales/gross-receipts tax. `defaultRate` (percent) prefills new
  // invoices; each invoice can still override. Off by default.
  tax: {
    enabled: false,
    defaultRate: 0,
    label: 'Tax',
  },
  // processingFees: who pays the online processing fee, per payment method.
  // 'firm' absorbs it (the default); 'client' adds it on top of the invoice at
  // checkout, grossed up so the firm still receives the full invoice amount.
  processingFees: {
    card: 'firm' as 'firm' | 'client',
    bank: 'firm' as 'firm' | 'client',
  },
  // cardFees: what the firm decided about debit and non-US cards, its Stripe
  // rate (the ceiling on any card fee), and its confirmation that it told
  // Stripe and its clients. Written only by PUT /billing/card-fees.
  cardFees: { ...DEFAULT_CARD_FEE_SETTINGS },
};

/** The settings groups that are objects of their own, merged a level deeper. */
const NESTED_GROUPS = ['timeRounding', 'lateFee', 'tax', 'processingFees', 'cardFees'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Stored billing settings over the defaults. The nested groups merge field by
 * field, because the firm-settings PUT stores only the fields it was sent: a
 * stored `lateFee: { enabled: true }` must still read back with its amounts,
 * grace period and `autoApply: false`, not as a group missing them.
 */
export function withBillingDefaults(stored: unknown) {
  const billing = isPlainObject(stored) ? stored : {};
  const merged: Record<string, any> = { ...BILLING_SETTINGS_DEFAULTS, ...billing };
  for (const group of NESTED_GROUPS) {
    merged[group] = {
      ...BILLING_SETTINGS_DEFAULTS[group],
      ...(isPlainObject(billing[group]) ? billing[group] : {}),
    };
  }
  return merged;
}

export async function getFirmBillingSettings(lawFirmId: string) {
  const { rows } = await financialRootSql('select settings from law_firms where id = $1', [lawFirmId]);
  const settings = (rows[0] && rows[0].settings) || {};
  return withBillingDefaults(settings.billing);
}

export async function setFirmBillingSettings(lawFirmId: string, billing: any) {
  // Read-modify-write the settings blob, merging the billing sub-object so other
  // settings keys are preserved. Only the patch's own keys are written; the
  // defaults are applied to the response, never stored.
  const { rows } = await financialRootSql('select settings from law_firms where id = $1', [lawFirmId]);
  if (!rows[0]) throw new NotFoundError('LawFirm');
  const settings = rows[0].settings || {};
  const merged = { ...settings, billing: { ...(settings.billing || {}), ...billing } };
  await financialRootSql('update law_firms set settings = $2::jsonb where id = $1', [lawFirmId, JSON.stringify(merged)]);
  return withBillingDefaults(merged.billing);
}
