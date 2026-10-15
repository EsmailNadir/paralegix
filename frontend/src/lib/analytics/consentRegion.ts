export type ConsentRegion = "required" | "notice";

// EU member states, the rest of the EEA, the UK, Switzerland and Canada. Their
// rules (the ePrivacy Directive, UK PECR, the Swiss FADP, and Quebec's Law 25,
// which requires tracking to be off by default) expect a visitor to choose
// before an analytics cookie is set; everywhere else a notice suffices. All of
// Canada is included because an IP address cannot reliably tell Quebec apart
// from the other provinces.
const CONSENT_REQUIRED_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "LI", "NO",
  "GB",
  "CH",
  "CA",
  // EU territories with their own ISO codes: French overseas departments, Saint
  // Martin and Aland.
  "GF", "GP", "MQ", "RE", "YT", "MF", "AX",
  // Gibraltar and the Crown Dependencies, which follow UK rules.
  "GI", "JE", "GG", "IM",
]);

// Canadian IANA zones, for the time-zone fallback. `Canada/*` covers the legacy
// aliases; the rest are the canonical zones Canadian browsers report.
const CANADIAN_TIME_ZONES = new Set([
  "America/Toronto", "America/Montreal", "America/Vancouver", "America/Edmonton",
  "America/Winnipeg", "America/Halifax", "America/St_Johns", "America/Regina",
  "America/Moncton", "America/Glace_Bay", "America/Goose_Bay", "America/Swift_Current",
  "America/Whitehorse", "America/Dawson", "America/Dawson_Creek", "America/Fort_Nelson",
  "America/Creston", "America/Yellowknife", "America/Inuvik", "America/Cambridge_Bay",
  "America/Iqaluit", "America/Rankin_Inlet", "America/Resolute", "America/Atikokan",
  "America/Blanc-Sablon", "America/Nipigon", "America/Thunder_Bay", "America/Rainy_River",
  "America/Pangnirtung",
]);

/** The region for an ISO country code, or null when the country is unknown. */
export function regionForCountry(country: string | null | undefined): ConsentRegion | null {
  if (!country) return null;
  return CONSENT_REQUIRED_COUNTRIES.has(country.toUpperCase()) ? "required" : "notice";
}

/**
 * The fallback when no country is known (local dev, or the lookup failed). Any
 * European or Canadian time zone asks for consent: over-asking elsewhere costs
 * a click, under-asking where consent is required does not meet the rules.
 */
export function regionForTimeZone(timeZone: string | undefined): ConsentRegion {
  if (!timeZone) return "notice";
  if (timeZone.startsWith("Europe/") || timeZone.startsWith("Canada/")) return "required";
  return CANADIAN_TIME_ZONES.has(timeZone) ? "required" : "notice";
}
