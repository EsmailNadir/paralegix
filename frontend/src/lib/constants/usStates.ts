/**
 * The 50 US states and the District of Columbia, by full name in alphabetical
 * order. A firm's state is stored as free text and the backend reads either a
 * name or a two-letter code, so a picker saves the full name.
 */
export const US_STATE_NAMES: readonly string[] = [
  "Alabama",
  "Alaska",
  "Arizona",
  "Arkansas",
  "California",
  "Colorado",
  "Connecticut",
  "Delaware",
  "District of Columbia",
  "Florida",
  "Georgia",
  "Hawaii",
  "Idaho",
  "Illinois",
  "Indiana",
  "Iowa",
  "Kansas",
  "Kentucky",
  "Louisiana",
  "Maine",
  "Maryland",
  "Massachusetts",
  "Michigan",
  "Minnesota",
  "Mississippi",
  "Missouri",
  "Montana",
  "Nebraska",
  "Nevada",
  "New Hampshire",
  "New Jersey",
  "New Mexico",
  "New York",
  "North Carolina",
  "North Dakota",
  "Ohio",
  "Oklahoma",
  "Oregon",
  "Pennsylvania",
  "Rhode Island",
  "South Carolina",
  "South Dakota",
  "Tennessee",
  "Texas",
  "Utah",
  "Vermont",
  "Virginia",
  "Washington",
  "West Virginia",
  "Wisconsin",
  "Wyoming",
];

/** USPS two-letter code for each entry in `US_STATE_NAMES`, by full name. */
const US_STATE_CODES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/** Lowercased, punctuation dropped, whitespace collapsed: "Washington, D.C." becomes "washington dc". */
function stateKey(value: string): string {
  return value.toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
}

const STATE_NAME_BY_KEY = new Map<string, string>([
  ...US_STATE_NAMES.map((name) => [stateKey(name), name] as const),
  ...Object.entries(US_STATE_CODES).map(([code, name]) => [stateKey(code), name] as const),
  ["washington dc", "District of Columbia"],
]);

/**
 * The full name in `US_STATE_NAMES` for a state stored as free text, such as
 * "TX", "tx", "Texas" or "D.C.", or null when the value is empty or is not a
 * recognisable US state. Lets a picker preselect a value typed before the
 * firm's state was chosen from a list.
 */
export function normalizeUsStateName(value: string | null | undefined): string | null {
  if (!value) return null;
  return STATE_NAME_BY_KEY.get(stateKey(value)) ?? null;
}

/**
 * USPS three-digit ZIP prefixes, as inclusive [first, last, state] runs. Only
 * the 50 states and the District of Columbia are listed, so a territory (PR,
 * VI, GU, MP), a military APO/FPO prefix (090-099, 340, 962-966) or an
 * unassigned prefix has no entry. Prefixes that USPS assigns inside another
 * state's run (005, 055, 201, 569, 733, 885, 398-399) are their own entries.
 */
const ZIP_PREFIX_RANGES: ReadonlyArray<readonly [number, number, string]> = [
  [5, 5, "New York"],
  [10, 27, "Massachusetts"],
  [28, 29, "Rhode Island"],
  [30, 38, "New Hampshire"],
  [39, 49, "Maine"],
  [50, 54, "Vermont"],
  [55, 55, "Massachusetts"],
  [56, 59, "Vermont"],
  [60, 69, "Connecticut"],
  [70, 89, "New Jersey"],
  [100, 149, "New York"],
  [150, 196, "Pennsylvania"],
  [197, 199, "Delaware"],
  [200, 200, "District of Columbia"],
  [201, 201, "Virginia"],
  [202, 205, "District of Columbia"],
  [206, 219, "Maryland"],
  [220, 246, "Virginia"],
  [247, 268, "West Virginia"],
  [270, 289, "North Carolina"],
  [290, 299, "South Carolina"],
  [300, 319, "Georgia"],
  [320, 339, "Florida"],
  [341, 349, "Florida"],
  [350, 369, "Alabama"],
  [370, 385, "Tennessee"],
  [386, 397, "Mississippi"],
  [398, 399, "Georgia"],
  [400, 427, "Kentucky"],
  [430, 459, "Ohio"],
  [460, 479, "Indiana"],
  [480, 499, "Michigan"],
  [500, 528, "Iowa"],
  [530, 549, "Wisconsin"],
  [550, 567, "Minnesota"],
  [569, 569, "District of Columbia"],
  [570, 577, "South Dakota"],
  [580, 588, "North Dakota"],
  [590, 599, "Montana"],
  [600, 629, "Illinois"],
  [630, 658, "Missouri"],
  [660, 679, "Kansas"],
  [680, 693, "Nebraska"],
  [700, 714, "Louisiana"],
  [716, 729, "Arkansas"],
  [730, 732, "Oklahoma"],
  [733, 733, "Texas"],
  [734, 749, "Oklahoma"],
  [750, 799, "Texas"],
  [800, 816, "Colorado"],
  [820, 831, "Wyoming"],
  [832, 838, "Idaho"],
  [840, 847, "Utah"],
  [850, 865, "Arizona"],
  [870, 884, "New Mexico"],
  [885, 885, "Texas"],
  [889, 898, "Nevada"],
  [900, 961, "California"],
  [967, 968, "Hawaii"],
  [970, 979, "Oregon"],
  [980, 994, "Washington"],
  [995, 999, "Alaska"],
];

/** Single ZIPs that USPS assigns to a different state from the rest of their prefix. */
const ZIP_EXCEPTIONS: Record<string, string> = {
  // Fishers Island is in New York but is served through New London, Connecticut.
  "06390": "New York",
};

/**
 * The state a complete US ZIP (five digits, or ZIP+4) belongs to, by its USPS
 * three-digit prefix, as a name in `US_STATE_NAMES`. Null for an incomplete
 * ZIP, a territory, a military APO/FPO ZIP or an unassigned prefix. Offline,
 * so a few ZIPs that straddle a state line read as the state of their prefix.
 */
export function stateFromZip(zip: string): string | null {
  const match = /^(\d{5})(?:-\d{4})?$/.exec(zip.trim());
  if (!match) return null;
  const five = match[1];
  if (ZIP_EXCEPTIONS[five]) return ZIP_EXCEPTIONS[five];
  const prefix = Number(five.slice(0, 3));
  const range = ZIP_PREFIX_RANGES.find(([first, last]) => prefix >= first && prefix <= last);
  return range ? range[2] : null;
}
