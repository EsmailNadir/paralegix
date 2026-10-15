import { regionForCountry, regionForTimeZone } from "@/lib/analytics/consentRegion";

describe("regionForCountry", () => {
  it.each(["DE", "FR", "IE", "NL", "NO", "IS", "LI", "GB", "CH", "CA", "de"])(
    "asks for consent in %s",
    (country) => {
      expect(regionForCountry(country)).toBe("required");
    },
  );

  // EU territories with their own ISO codes (French overseas departments, Saint
  // Martin, Aland), plus Gibraltar and the Crown Dependencies, which follow UK rules.
  it.each(["GF", "GP", "MQ", "RE", "YT", "MF", "AX", "GI", "JE", "GG", "IM"])(
    "asks for consent in the territory %s",
    (country) => {
      expect(regionForCountry(country)).toBe("required");
    },
  );

  it.each(["US", "MX", "AU", "IN"])("shows the notice only in %s", (country) => {
    expect(regionForCountry(country)).toBe("notice");
  });

  it("does not guess when the country is unknown", () => {
    expect(regionForCountry(null)).toBeNull();
    expect(regionForCountry("")).toBeNull();
  });
});

describe("regionForTimeZone", () => {
  it("treats any European time zone as needing consent", () => {
    expect(regionForTimeZone("Europe/Berlin")).toBe("required");
    expect(regionForTimeZone("Europe/London")).toBe("required");
  });

  // Quebec is the reason: it requires tracking to be off by default, and a
  // province cannot be told apart reliably, so all of Canada is asked.
  it("treats any Canadian time zone as needing consent", () => {
    expect(regionForTimeZone("America/Toronto")).toBe("required");
    expect(regionForTimeZone("America/Montreal")).toBe("required");
    expect(regionForTimeZone("America/Vancouver")).toBe("required");
    expect(regionForTimeZone("America/St_Johns")).toBe("required");
    expect(regionForTimeZone("Canada/Eastern")).toBe("required");
  });

  it("treats everything else as notice only", () => {
    expect(regionForTimeZone("America/New_York")).toBe("notice");
    expect(regionForTimeZone(undefined)).toBe("notice");
  });
});
