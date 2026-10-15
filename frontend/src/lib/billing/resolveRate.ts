/**
 * The firm's billing rate ladder, for the browser.
 *
 * This mirrors `backend/src/modules/billing/shared/rateResolution.ts` tier for
 * tier. The backend is the authority: it is what actually prices an invoice
 * line. Anything the UI shows before saving is a preview of that decision, so a
 * preview built from a different order is simply wrong, and it was wrong in
 * three different ways before this file existed. When the backend ladder
 * changes, change this one in the same commit.
 *
 * Tiers, most specific first:
 *   1. explicit rate on the time entry (manual override)
 *   2. matter member rate       (this matter, this person)
 *   3. client member rate       (this client, this person)
 *   4. client default rate      (this client, anyone)
 *   5. charge code member rate  (this code, this person)
 *   6. charge code default rate (this code, anyone)
 *   7. member default rate      (firm-wide, this person)
 *   8. firm default rate
 *   9. none
 */

/** The wording each tier reports, shared with the backend's `source` strings. */
export type RateSource =
  | "time entry override"
  | "matter member rate"
  | "client member rate"
  | "client default rate"
  | "charge code member rate"
  | "charge code default"
  | "user default rate"
  | "firm default rate"
  | "none";

export interface RateLadderInputs {
  /** The entry being priced. Only `userId` and `hourlyRate` are read. */
  entry: { userId?: string | null; hourlyRate?: unknown };
  /** `matter.members`, each optionally carrying its own `hourlyRate`. */
  matterMembers?: { userId?: string | null; hourlyRate?: unknown }[] | null;
  /** `client.billingRates`. */
  clientBillingRates?: { defaultRate?: unknown; memberRates?: Record<string, unknown> } | null;
  /** The charge code selected on the entry, if any. */
  chargeCode?: { code?: string; defaultRate?: unknown; memberRates?: Record<string, unknown> } | null;
  /** userId to firm-wide default rate. */
  memberDefaultRates?: Record<string, unknown> | null;
  firmDefaultRate?: unknown;
}

export interface ResolvedRate {
  rate: number | null;
  source: RateSource | null;
}

/**
 * A configured rate, or null when the tier has none set.
 *
 * Numeric strings count: Postgres `numeric` columns arrive as strings, and a
 * plain `typeof === "number"` test silently skips that tier and prices the work
 * at a lower one. 0 is a real setting (pro bono) and is kept; null, undefined,
 * empty string, NaN and booleans all mean "not set".
 */
export function configuredRate(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Resolve the rate a time entry would bill at.
 *
 * Returns `{ rate: null, source: null }` when no tier applies, rather than the
 * backend's tier-9 zero. A form has to tell "bills at $0" apart from "no rate is
 * configured": the first is a deliberate write-off, the second needs a warning.
 */
export function resolveRate({
  entry,
  matterMembers,
  clientBillingRates,
  chargeCode,
  memberDefaultRates,
  firmDefaultRate,
}: RateLadderInputs): ResolvedRate {
  const userId = entry.userId || null;

  const entryRate = configuredRate(entry.hourlyRate);
  if (entryRate !== null) return { rate: entryRate, source: "time entry override" };

  if (Array.isArray(matterMembers) && userId) {
    const member = matterMembers.find((m) => m && m.userId === userId);
    const memberRate = configuredRate(member?.hourlyRate);
    if (memberRate !== null) return { rate: memberRate, source: "matter member rate" };
  }

  if (clientBillingRates && userId) {
    const clientMemberRate = configuredRate(clientBillingRates.memberRates?.[userId]);
    if (clientMemberRate !== null) return { rate: clientMemberRate, source: "client member rate" };
  }

  const clientDefault = configuredRate(clientBillingRates?.defaultRate);
  if (clientDefault !== null) return { rate: clientDefault, source: "client default rate" };

  if (chargeCode && userId) {
    const codeMemberRate = configuredRate(chargeCode.memberRates?.[userId]);
    if (codeMemberRate !== null) return { rate: codeMemberRate, source: "charge code member rate" };
  }

  const codeDefault = configuredRate(chargeCode?.defaultRate);
  if (codeDefault !== null) return { rate: codeDefault, source: "charge code default" };

  if (memberDefaultRates && userId) {
    const userDefault = configuredRate(memberDefaultRates[userId]);
    if (userDefault !== null) return { rate: userDefault, source: "user default rate" };
  }

  const firmDefault = configuredRate(firmDefaultRate);
  if (firmDefault !== null) return { rate: firmDefault, source: "firm default rate" };

  return { rate: null, source: null };
}

/** One row of the "Change rate" menu: a place a rate lives, and its value. */
export interface RateOption {
  label: string;
  rate: number;
}

/**
 * Every rate that applies to this entry, in ladder order.
 *
 * This is the ladder made browsable. It deliberately excludes tier 1: the
 * entry's own rate is what the field already holds, so offering it as a choice
 * would just echo the input back.
 */
export function buildRateOptions({
  entry,
  matterMembers,
  clientBillingRates,
  chargeCode,
  memberDefaultRates,
  firmDefaultRate,
}: RateLadderInputs): RateOption[] {
  const userId = entry.userId || null;
  const options: RateOption[] = [];
  const push = (label: string, value: unknown) => {
    const rate = configuredRate(value);
    if (rate !== null) options.push({ label, rate });
  };

  if (userId) {
    const member = (matterMembers || []).find((m) => m && m.userId === userId);
    push("Matter rate", member?.hourlyRate);
    push("Client rate", clientBillingRates?.memberRates?.[userId]);
  }
  if (!options.some((o) => o.label === "Client rate")) {
    push("Client rate", clientBillingRates?.defaultRate);
  }

  const codeLabel = chargeCode?.code ? `Charge code (${chargeCode.code})` : "Charge code";
  if (userId && configuredRate(chargeCode?.memberRates?.[userId]) !== null) {
    push(codeLabel, chargeCode?.memberRates?.[userId]);
  } else {
    push(codeLabel, chargeCode?.defaultRate);
  }

  if (userId) push("Member default", memberDefaultRates?.[userId]);
  push("Firm default", firmDefaultRate);

  return options;
}

/**
 * Maps a resolved rate's source onto the option label that produced it, so a
 * menu can mark the row the current rate came from. The vocabularies differ
 * because a source names the rule that won and an option names where the number
 * lives.
 */
export const RATE_SOURCE_OPTION_LABEL: Record<string, string> = {
  "matter member rate": "Matter rate",
  "client member rate": "Client rate",
  "client default rate": "Client rate",
  "charge code member rate": "Charge code",
  "charge code default": "Charge code",
  "user default rate": "Member default",
  "firm default rate": "Firm default",
};

/** Sentence-case wording for the source line under a rate field. */
export function rateSourceLabel(source: RateSource | null): string | null {
  if (!source || source === "none") return null;
  return source.charAt(0).toUpperCase() + source.slice(1);
}
