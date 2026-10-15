const mockInit = jest.fn();
const mockEnable = jest.fn();
const mockDisable = jest.fn();
jest.mock("@/lib/analytics/analytics", () => ({
  __esModule: true,
  initAnalytics: () => mockInit(),
  enableAnalytics: () => mockEnable(),
  disableAnalytics: () => mockDisable(),
}));

type ConsentModule = typeof import("@/lib/analytics/consent");

const CHOICE_KEY = "paralegix_analytics_consent";
const REGION_KEY = "paralegix_consent_region";

// The module caches the region request, so each test loads a fresh copy.
function loadConsent(): ConsentModule {
  let mod: ConsentModule | undefined;
  jest.isolateModules(() => {
    mod = require("@/lib/analytics/consent");
  });
  return mod!;
}

function answerRegion(region: "required" | "notice" | null) {
  (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ region }) });
}

function setTimeZone(timeZone: string) {
  jest.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone } as any);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

afterAll(() => {
  delete (global as any).fetch;
});

describe("startAnalyticsWithConsent", () => {
  it("starts analytics for a visitor whose region only needs the notice", async () => {
    answerRegion("notice");
    await loadConsent().startAnalyticsWithConsent();

    expect(global.fetch).toHaveBeenCalledWith("/api/consent-region", { cache: "no-store" });
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(REGION_KEY)).toBe("notice");
  });

  it("waits for a choice from a visitor whose region needs consent", async () => {
    answerRegion("required");
    await loadConsent().startAnalyticsWithConsent();

    expect(global.fetch).toHaveBeenCalled();
    expect(mockInit).not.toHaveBeenCalled();
  });

  it("starts at once for a visitor who already accepted, without asking where they are", async () => {
    answerRegion("required");
    localStorage.setItem(CHOICE_KEY, "granted");

    await loadConsent().startAnalyticsWithConsent();

    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("never starts for a visitor who declined, even where only the notice applies", async () => {
    answerRegion("notice");
    localStorage.setItem(CHOICE_KEY, "denied");

    await loadConsent().startAnalyticsWithConsent();

    expect(mockInit).not.toHaveBeenCalled();
  });

  it("falls back to a European time zone when the country is unknown", async () => {
    answerRegion(null);
    setTimeZone("Europe/Paris");

    await loadConsent().startAnalyticsWithConsent();

    expect(mockInit).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(REGION_KEY)).toBe("required");
  });

  it("falls back to the time zone when the lookup fails", async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error("offline"));
    setTimeZone("America/Chicago");

    await loadConsent().startAnalyticsWithConsent();

    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  it("asks where the visitor is once per session", async () => {
    answerRegion("notice");
    const consent = loadConsent();

    await consent.resolveConsentRegion();
    await consent.resolveConsentRegion();
    await loadConsent().resolveConsentRegion();

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not start behind a decline made while the lookup was in flight", async () => {
    let answer: (value: unknown) => void = () => {};
    (global as any).fetch = jest.fn(() => new Promise((resolve) => { answer = resolve; }));
    const consent = loadConsent();

    const starting = consent.startAnalyticsWithConsent();
    consent.declineAnalytics();
    answer({ ok: true, json: async () => ({ region: "notice" }) });
    await starting;

    expect(mockInit).not.toHaveBeenCalled();
  });
});

// Consent is asked for again after a year, as the EU regulators recommend.
describe("how long a choice lasts", () => {
  const AT_KEY = "paralegix_analytics_consent_at";
  const DAY = 24 * 60 * 60 * 1000;

  it("forgets a choice older than a year and waits for a new one", async () => {
    answerRegion("required");
    localStorage.setItem(CHOICE_KEY, "granted");
    localStorage.setItem(AT_KEY, String(Date.now() - 366 * DAY));
    const consent = loadConsent();

    await consent.startAnalyticsWithConsent();

    expect(mockInit).not.toHaveBeenCalled();
    expect(consent.getConsentChoice()).toBeNull();
    expect(localStorage.getItem(CHOICE_KEY)).toBeNull();
  });

  it("keeps a choice made within the year", async () => {
    localStorage.setItem(CHOICE_KEY, "granted");
    localStorage.setItem(AT_KEY, String(Date.now() - 300 * DAY));

    await loadConsent().startAnalyticsWithConsent();

    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  it("dates a choice saved before choices were dated, so it expires a year from now", () => {
    localStorage.setItem(CHOICE_KEY, "denied");

    expect(loadConsent().getConsentChoice()).toBe("denied");
    expect(Number(localStorage.getItem(AT_KEY))).toBeGreaterThan(Date.now() - DAY);
  });

  it("records when the visitor chose", () => {
    loadConsent().acceptAnalytics();

    expect(Number(localStorage.getItem(AT_KEY))).toBeGreaterThan(Date.now() - DAY);
  });
});

describe("the visitor's choice", () => {
  it("accepting records it and turns analytics on", () => {
    loadConsent().acceptAnalytics();

    expect(localStorage.getItem(CHOICE_KEY)).toBe("granted");
    expect(mockEnable).toHaveBeenCalledTimes(1);
  });

  it("declining records it and turns analytics off", () => {
    loadConsent().declineAnalytics();

    expect(localStorage.getItem(CHOICE_KEY)).toBe("denied");
    expect(mockDisable).toHaveBeenCalledTimes(1);
  });

  it("opening cookie settings tells the banner to show the choice", () => {
    const consent = loadConsent();
    const listener = jest.fn();
    window.addEventListener(consent.COOKIE_SETTINGS_EVENT, listener);

    consent.openCookieSettings();

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(consent.COOKIE_SETTINGS_EVENT, listener);
  });
});
