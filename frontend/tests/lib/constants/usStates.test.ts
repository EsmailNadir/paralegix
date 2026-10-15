/**
 * Mapping a firm's free-text state onto a name in the state picker.
 *
 * A firm's state was typed by hand before it was picked from a list, so a
 * stored value may be a two-letter code, a different case, or a punctuated
 * abbreviation. Red if one of those stops resolving to the full name the
 * picker saves, or if something that is not a US state is forced onto one.
 *
 * `stateFromZip` reads the state from a ZIP's USPS three-digit prefix, offline.
 * Red if a state's prefix range drifts, if a USPS exception (a prefix that sits
 * inside another state's run) is read as its neighbour, or if a territory, a
 * military prefix or an incomplete ZIP is given a state.
 */
import { normalizeUsStateName, stateFromZip, US_STATE_NAMES } from "@/lib/constants/usStates";

describe("normalizeUsStateName", () => {
  it.each([
    ["TX", "Texas"],
    ["tx", "Texas"],
    ["Texas", "Texas"],
    ["  texas  ", "Texas"],
    ["NEW YORK", "New York"],
    ["new  york", "New York"],
    ["ny", "New York"],
    ["D.C.", "District of Columbia"],
    ["DC", "District of Columbia"],
    ["Washington, D.C.", "District of Columbia"],
    ["district of columbia", "District of Columbia"],
    ["WA", "Washington"],
    ["Wy.", "Wyoming"],
  ])("reads %p as %p", (stored, expected) => {
    expect(normalizeUsStateName(stored)).toBe(expected);
  });

  it.each([[""], ["   "], ["Ontario"], ["T"], ["XX"], [null], [undefined]])(
    "does not force %p onto a state",
    (stored) => {
      expect(normalizeUsStateName(stored)).toBeNull();
    },
  );

  it("resolves every full name in the list, whatever its case", () => {
    for (const name of US_STATE_NAMES) {
      expect(normalizeUsStateName(name.toUpperCase())).toBe(name);
    }
  });
});

describe("stateFromZip", () => {
  it.each([
    ["35203", "Alabama"], ["99501", "Alaska"], ["85001", "Arizona"], ["72201", "Arkansas"],
    ["90001", "California"], ["80202", "Colorado"], ["06103", "Connecticut"], ["19901", "Delaware"],
    ["20001", "District of Columbia"], ["33101", "Florida"], ["30303", "Georgia"], ["96813", "Hawaii"],
    ["83702", "Idaho"], ["60601", "Illinois"], ["46204", "Indiana"], ["50309", "Iowa"],
    ["66603", "Kansas"], ["40202", "Kentucky"], ["70112", "Louisiana"], ["04101", "Maine"],
    ["21201", "Maryland"], ["02108", "Massachusetts"], ["48226", "Michigan"], ["55401", "Minnesota"],
    ["39201", "Mississippi"], ["63101", "Missouri"], ["59601", "Montana"], ["68102", "Nebraska"],
    ["89101", "Nevada"], ["03301", "New Hampshire"], ["07102", "New Jersey"], ["87501", "New Mexico"],
    ["10001", "New York"], ["27601", "North Carolina"], ["58501", "North Dakota"], ["43215", "Ohio"],
    ["73102", "Oklahoma"], ["97201", "Oregon"], ["19103", "Pennsylvania"], ["02903", "Rhode Island"],
    ["29201", "South Carolina"], ["57501", "South Dakota"], ["37203", "Tennessee"], ["78701", "Texas"],
    ["84101", "Utah"], ["05601", "Vermont"], ["23219", "Virginia"], ["98101", "Washington"],
    ["25301", "West Virginia"], ["53703", "Wisconsin"], ["82001", "Wyoming"],
  ])("reads %p as %p", (zip, state) => {
    expect(stateFromZip(zip)).toBe(state);
  });

  it("covers every state in the list", () => {
    const representative = [
      "35203", "99501", "85001", "72201", "90001", "80202", "06103", "19901", "20001", "33101",
      "30303", "96813", "83702", "60601", "46204", "50309", "66603", "40202", "70112", "04101",
      "21201", "02108", "48226", "55401", "39201", "63101", "59601", "68102", "89101", "03301",
      "07102", "87501", "10001", "27601", "58501", "43215", "73102", "97201", "19103", "02903",
      "29201", "57501", "37203", "78701", "84101", "05601", "23219", "98101", "25301", "53703", "82001",
    ];
    expect(new Set(representative.map(stateFromZip))).toEqual(new Set(US_STATE_NAMES));
  });

  it.each([
    ["00501", "New York"],
    ["05501", "Massachusetts"],
    ["05544", "Massachusetts"],
    ["06320", "Connecticut"],
    ["06390", "New York"],
    ["20101", "Virginia"],
    ["20201", "District of Columbia"],
    ["56901", "District of Columbia"],
    ["73301", "Texas"],
    ["73344", "Texas"],
    ["88510", "Texas"],
    ["39813", "Georgia"],
    ["39901", "Georgia"],
    ["34101", "Florida"],
    ["96701", "Hawaii"],
  ])("reads the USPS exception %p as %p", (zip, state) => {
    expect(stateFromZip(zip)).toBe(state);
  });

  it("reads a ZIP+4 by its first five digits", () => {
    expect(stateFromZip("78701-1234")).toBe("Texas");
    expect(stateFromZip(" 02108 ")).toBe("Massachusetts");
  });

  it.each([
    ["00601", "Puerto Rico"],
    ["00901", "Puerto Rico"],
    ["00801", "US Virgin Islands"],
    ["96910", "Guam"],
    ["96950", "Northern Mariana Islands"],
    ["09001", "military APO/FPO (AE)"],
    ["09901", "military APO/FPO (AE)"],
    ["34001", "military APO/FPO (AA)"],
    ["96201", "military APO/FPO (AP)"],
    ["96601", "military APO/FPO (AP)"],
    ["00001", "an unassigned prefix"],
    ["1234", "fewer than five digits"],
    ["7870", "fewer than five digits"],
    ["787011", "six digits"],
    ["78701-12", "a partial ZIP+4"],
    ["abcde", "letters"],
    ["", "empty"],
  ])("gives %p (%s) no state", (zip) => {
    expect(stateFromZip(zip)).toBeNull();
  });
});
