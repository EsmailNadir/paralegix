/**
 * The billing rate ladder, browser side.
 *
 * This module prices what a user sees before they save. It mirrors
 * `backend/src/modules/billing/shared/rateResolution.ts` tier for tier, and the
 * backend is the authority: a preview built from a different order is not a
 * cosmetic difference, it is a number the user agreed to that the invoice will
 * not carry. `resolveRate.ts`'s own header records that this went wrong three
 * separate ways before the module existed, and nothing has pinned it since.
 *
 * What has to break for these to go red:
 *
 *  - Reorder any two tiers, or drop one. Each tier below is proved by seeding
 *    it TOGETHER WITH every lower tier, so a case can only pass by preferring
 *    the right one. A test that seeded a tier alone would pass against a ladder
 *    that had lost every rung above it.
 *  - Make `configuredRate` reject 0, or stop reading numeric strings. Both are
 *    real shapes: 0 is pro bono work, and Postgres `numeric` arrives over JSON
 *    as a string. Either regression silently prices the work at a LOWER tier,
 *    which is a wrong invoice with nothing on screen to say so.
 *  - Return 0 instead of null when nothing is configured. A form has to tell
 *    "bills at $0" from "no rate set"; collapsing them hides the second.
 *  - Add a source to `resolveRate` without a matching entry in
 *    `RATE_SOURCE_OPTION_LABEL`, which leaves the rate menu unable to mark the
 *    row the current rate came from.
 */
import {
  RATE_SOURCE_OPTION_LABEL,
  buildRateOptions,
  configuredRate,
  rateSourceLabel,
  resolveRate,
  type RateLadderInputs,
} from "@/lib/billing/resolveRate";

const USER = "user-1";
const OTHER = "user-2";

/**
 * Every tier populated with a distinct, recognisable number, so a resolved rate
 * names which rung answered without needing the `source` string to agree.
 *
 * Descending on purpose: the ladder runs most specific first, so if the order
 * ever inverts the resolved number goes DOWN rather than landing on a value
 * that could plausibly be either.
 */
const fullLadder = (): RateLadderInputs => ({
  entry: { userId: USER, hourlyRate: 800 },
  matterMembers: [{ userId: USER, hourlyRate: 700 }, { userId: OTHER, hourlyRate: 999 }],
  clientBillingRates: { defaultRate: 500, memberRates: { [USER]: 600, [OTHER]: 999 } },
  chargeCode: { code: "L100", defaultRate: 300, memberRates: { [USER]: 400, [OTHER]: 999 } },
  memberDefaultRates: { [USER]: 200, [OTHER]: 999 },
  firmDefaultRate: 100,
});

/** The full ladder with the `count` most specific tiers removed. */
function ladderBelow(count: number): RateLadderInputs {
  const l = fullLadder();
  const strip: (() => void)[] = [
    () => { l.entry = { userId: USER }; },
    () => { l.matterMembers = [{ userId: OTHER, hourlyRate: 999 }]; },
    () => { l.clientBillingRates = { defaultRate: 500, memberRates: { [OTHER]: 999 } }; },
    () => { l.clientBillingRates = { memberRates: { [OTHER]: 999 } }; },
    () => { l.chargeCode = { code: "L100", defaultRate: 300, memberRates: { [OTHER]: 999 } }; },
    () => { l.chargeCode = { code: "L100", memberRates: { [OTHER]: 999 } }; },
    () => { l.memberDefaultRates = { [OTHER]: 999 }; },
    () => { l.firmDefaultRate = null; },
  ];
  for (let i = 0; i < count; i += 1) strip[i]();
  return l;
}

describe("configuredRate", () => {
  it("keeps zero, which is a deliberate pro bono rate", () => {
    // The bug this guards: a truthiness check reads 0 as "not set" and falls
    // through to the next tier, so work the firm chose to write off gets billed.
    expect(configuredRate(0)).toBe(0);
    expect(configuredRate("0")).toBe(0);
  });

  it("reads a numeric string, which is how Postgres numeric arrives", () => {
    expect(configuredRate("250")).toBe(250);
    expect(configuredRate("250.50")).toBe(250.5);
    expect(configuredRate(" 250 ")).toBe(250);
  });

  it("treats every not-set shape as absent", () => {
    // Asserted as a set rather than one at a time: each of these has reached
    // this function from a real payload, and any one of them slipping through
    // as a number prices the entry at whatever it coerces to.
    for (const value of [null, undefined, "", "   ", "abc", NaN, Infinity, true, false, {}, []]) {
      expect(configuredRate(value)).toBeNull();
    }
  });
});

describe("resolveRate walks the ladder most specific first", () => {
  // Each row seeds the named tier plus EVERY tier below it. Passing therefore
  // requires preferring this rung over all the lower ones, not merely finding it.
  it.each([
    [0, 800, "time entry override"],
    [1, 700, "matter member rate"],
    [2, 600, "client member rate"],
    [3, 500, "client default rate"],
    [4, 400, "charge code member rate"],
    [5, 300, "charge code default"],
    [6, 200, "user default rate"],
    [7, 100, "firm default rate"],
  ])("tier %i resolves to %i (%s)", (stripped, rate, source) => {
    expect(resolveRate(ladderBelow(stripped as number))).toEqual({ rate, source });
  });

  it("reports no rate at all rather than zero when nothing is configured", () => {
    expect(resolveRate(ladderBelow(8))).toEqual({ rate: null, source: null });
  });

  it("never reads another person's rate at any tier", () => {
    // Every per-person tier in `fullLadder` also carries a 999 for OTHER. A user
    // with nothing of their own must skip all three and land on the most
    // specific tier that is not keyed by person, never on a colleague's number.
    const l = fullLadder();
    l.entry = { userId: "user-with-nothing" };

    expect(resolveRate(l)).toEqual({ rate: 500, source: "client default rate" });

    // Stripping the non-person tiers too leaves nothing but the 999s, and the
    // answer must still be "no rate", not somebody else's.
    const onlyOthers: RateLadderInputs = {
      entry: { userId: "user-with-nothing" },
      matterMembers: [{ userId: OTHER, hourlyRate: 999 }],
      clientBillingRates: { memberRates: { [OTHER]: 999 } },
      chargeCode: { code: "L100", memberRates: { [OTHER]: 999 } },
      memberDefaultRates: { [OTHER]: 999 },
    };
    expect(resolveRate(onlyOthers)).toEqual({ rate: null, source: null });
  });

  it("skips the per-person tiers when the entry names no user", () => {
    const l = fullLadder();
    l.entry = { userId: null };

    // With no user the three member tiers cannot apply, so the client default
    // is the most specific rung left. Landing on 600 or 400 would mean a rate
    // was read from a map with no key to read it by.
    expect(resolveRate(l)).toEqual({ rate: 500, source: "client default rate" });
  });

  it("prices a zero rate at the tier that set it instead of falling through", () => {
    const l = ladderBelow(1);
    l.matterMembers = [{ userId: USER, hourlyRate: 0 }];

    // The whole point of `configuredRate` keeping 0. A fall-through here bills
    // 600 for work the matter says is free.
    expect(resolveRate(l)).toEqual({ rate: 0, source: "matter member rate" });
  });

  it("tolerates a missing ladder entirely", () => {
    expect(resolveRate({ entry: {} })).toEqual({ rate: null, source: null });
  });
});

describe("buildRateOptions", () => {
  it("lists every applicable rate in ladder order and omits the entry's own", () => {
    const options = buildRateOptions(fullLadder());

    // Tier 1 is excluded deliberately: it is the value the field already holds,
    // so offering it back is not a choice. The ORDER is asserted, not just
    // membership, because this list is a menu and its first row reads as the
    // recommended one.
    expect(options).toEqual([
      { label: "Matter rate", rate: 700 },
      { label: "Client rate", rate: 600 },
      { label: "Charge code (L100)", rate: 400 },
      { label: "Member default", rate: 200 },
      { label: "Firm default", rate: 100 },
    ]);
    expect(options.map((o) => o.rate)).not.toContain(800);
  });

  it("offers the client DEFAULT only when this person has no client rate", () => {
    const l = fullLadder();
    l.clientBillingRates = { defaultRate: 500, memberRates: {} };

    const options = buildRateOptions(l);

    // One "Client rate" row either way. Two rows both labelled "Client rate"
    // with different numbers is a menu the user cannot choose between.
    expect(options.filter((o) => o.label === "Client rate")).toEqual([
      { label: "Client rate", rate: 500 },
    ]);
  });

  it("prefers this person's charge-code rate over the code's default", () => {
    const withMemberRate = buildRateOptions(fullLadder());
    const l = fullLadder();
    l.chargeCode = { code: "L100", defaultRate: 300, memberRates: {} };
    const withoutMemberRate = buildRateOptions(l);

    // Both halves: the same label must carry the member's number when there is
    // one and the code's default when there is not.
    expect(withMemberRate.find((o) => o.label === "Charge code (L100)")?.rate).toBe(400);
    expect(withoutMemberRate.find((o) => o.label === "Charge code (L100)")?.rate).toBe(300);
  });

  it("names the charge code in the label so two codes are distinguishable", () => {
    const l = fullLadder();
    l.chargeCode = { code: "E101", defaultRate: 300, memberRates: {} };

    expect(buildRateOptions(l).map((o) => o.label)).toContain("Charge code (E101)");
  });

  it("omits a tier that is not configured rather than listing it at zero", () => {
    const options = buildRateOptions({ entry: { userId: USER }, firmDefaultRate: 100 });

    // A menu row reading "$0" for an unset tier is indistinguishable from a
    // deliberate write-off the firm actually configured.
    expect(options).toEqual([{ label: "Firm default", rate: 100 }]);
  });

  it("returns nothing when no tier is configured", () => {
    expect(buildRateOptions({ entry: { userId: USER } })).toEqual([]);
  });
});

describe("the menu can always mark the row a resolved rate came from", () => {
  it("maps every source resolveRate can return to an option label", () => {
    // Derived from the ladder itself rather than from a hand-written list, so
    // adding a tier to `resolveRate` without adding its label fails here instead
    // of silently leaving the menu with nothing highlighted.
    const sources = Array.from({ length: 8 }, (unused, i) => resolveRate(ladderBelow(i)).source!);

    // Tier 1 has no option row by design; every other source must map.
    for (const source of sources.slice(1)) {
      expect(RATE_SOURCE_OPTION_LABEL[source]).toBeDefined();
    }
  });

  it("maps each source onto a label the option list actually produces", () => {
    const labels = new Set(
      buildRateOptions(fullLadder()).map((o) => o.label.replace(/ \(.*\)$/, "")),
    );

    // The two vocabularies differ on purpose (a source names the rule, an option
    // names the place), so a mapping that pointed at a label no option ever
    // carries would highlight nothing and look like a rendering bug.
    for (const label of Object.values(RATE_SOURCE_OPTION_LABEL)) {
      expect(labels).toContain(label);
    }
  });
});

describe("rateSourceLabel", () => {
  it("sentence-cases a source for the line under the rate field", () => {
    expect(rateSourceLabel("matter member rate")).toBe("Matter member rate");
    expect(rateSourceLabel("firm default rate")).toBe("Firm default rate");
  });

  it("says nothing when there is no source", () => {
    // "None" under a rate field reads as a configured value called none.
    expect(rateSourceLabel(null)).toBeNull();
    expect(rateSourceLabel("none")).toBeNull();
  });
});
