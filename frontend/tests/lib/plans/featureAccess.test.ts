import { getPlanFeatures, resolveFirmFeatures } from "@/lib/plans/featureAccess";

/**
 * `resolveFirmFeatures` is the client-side mirror of the backend's
 * `featureCheck.isFeatureEnabled`. The whole firm-side UI decides what to render
 * from its answer, so a disagreement with the server shows up as a sidebar entry
 * whose page answers 403.
 *
 * The cases below are the four the two gates can produce between them, plus the
 * shapes that must NOT subtract. Deleting the opt-out loop makes the second
 * describe go red; widening the `=== false` check to a falsy test makes the
 * "values that are not an opt-out" cases go red.
 */
describe("resolveFirmFeatures", () => {
  const professional = { planId: "professional" as const };
  const starter = { planId: "starter" as const };

  describe("the plan is the ceiling", () => {
    it("leaves a plan-allowed feature on when the firm has no opt-out", () => {
      expect(resolveFirmFeatures(professional, {}).trustAccounting).toBe(true);
    });

    it("keeps a feature the plan lacks off, whatever the firm stored", () => {
      // The firm cannot grant itself a feature it is not paying for. A stored
      // `true` must not read as an upgrade.
      expect(
        resolveFirmFeatures(starter, { features: { trustAccounting: true } }).trustAccounting,
      ).toBe(false);
    });
  });

  describe("the firm opt-out subtracts", () => {
    it("turns a plan-allowed feature off", () => {
      expect(
        resolveFirmFeatures(professional, { features: { trustAccounting: false } })
          .trustAccounting,
      ).toBe(false);
    });

    it("leaves every other feature on the same plan alone", () => {
      const resolved = resolveFirmFeatures(professional, {
        features: { trustAccounting: false },
      });

      // An opt-out is per feature. A loop that reassigned the whole map, or one
      // that read the wrong key, would take these down with it.
      expect(resolved.documentSigning).toBe(true);
      expect(resolved.templates).toBe(true);
      expect(resolved.messaging).toBe(true);
    });

    it("does not mutate the shared plan feature table", () => {
      resolveFirmFeatures(professional, { features: { trustAccounting: false } });

      // The plan tables are module-level constants. Subtracting in place would
      // switch trust accounting off for every firm in the tab until reload.
      expect(getPlanFeatures(professional).trustAccounting).toBe(true);
    });
  });

  describe("values that are not an opt-out", () => {
    it.each([
      ["undefined", undefined],
      ["null", null],
      ["true", true],
      ["the string 'false'", "false"],
      ["zero", 0],
    ])("leaves the plan answer alone for %s", (_label, stored) => {
      // Only an explicit boolean `false` subtracts, matching the backend's
      // `=== false`. A falsy check here would turn trust off for a firm whose
      // jsonb happened to hold 0 or an empty string.
      const resolved = resolveFirmFeatures(professional, {
        features: { trustAccounting: stored as never },
      });
      expect(resolved.trustAccounting).toBe(true);
    });

    it("handles settings with no features object at all", () => {
      expect(resolveFirmFeatures(professional, {}).trustAccounting).toBe(true);
      expect(resolveFirmFeatures(professional, null).trustAccounting).toBe(true);
      expect(resolveFirmFeatures(professional).trustAccounting).toBe(true);
    });
  });

  describe("alongside the admin overrides", () => {
    it("lets a firm opt out of a feature an admin override granted it", () => {
      // The override lifts the plan ceiling; the opt-out is the firm's own
      // choice underneath it. The firm's choice still applies.
      const resolved = resolveFirmFeatures(
        { planId: "starter", featureOverrides: { trustAccounting: true } },
        { features: { trustAccounting: false } },
      );
      expect(resolved.trustAccounting).toBe(false);
    });

    it("lets a firm opt out under unlimitedOverride too", () => {
      const resolved = resolveFirmFeatures(
        { planId: "starter", unlimitedOverride: true },
        { features: { trustAccounting: false } },
      );
      expect(resolved.trustAccounting).toBe(false);
    });
  });
});
