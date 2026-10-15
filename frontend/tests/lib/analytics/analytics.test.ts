const mockPosthog = {
  init: jest.fn(),
  capture: jest.fn(),
  identify: jest.fn(),
  get_distinct_id: jest.fn(() => "anonymous-device-id"),
  register: jest.fn(),
  setPersonProperties: jest.fn(),
  group: jest.fn(),
  reset: jest.fn(),
  captureException: jest.fn(),
  opt_in_capturing: jest.fn(),
  opt_out_capturing: jest.fn(),
};

jest.mock("posthog-js", () => ({ __esModule: true, default: mockPosthog }));

type AnalyticsModule = typeof import("@/lib/analytics/analytics");

const ORIGINAL_TOKEN = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;

// The module keeps whether it initialised in module state, so each test loads
// a fresh copy with the token it needs.
function loadAnalytics(token: string | undefined): AnalyticsModule {
  if (token === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  else process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = token;
  let mod: AnalyticsModule | undefined;
  jest.isolateModules(() => {
    mod = require("@/lib/analytics/analytics");
  });
  return mod!;
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterAll(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  else process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = ORIGINAL_TOKEN;
});

describe("without a project token", () => {
  it("never starts PostHog and every call is a no-op", () => {
    const analytics = loadAnalytics(undefined);

    analytics.initAnalytics();
    analytics.track("matter_created", { client_count: 1 });
    analytics.identifyUser("uid-1");
    analytics.setAnalyticsContext("firm_member", "firm-1");
    analytics.resetAnalytics();
    analytics.captureAnalyticsException(new Error("boom"));

    expect(mockPosthog.init).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
    expect(mockPosthog.identify).not.toHaveBeenCalled();
    expect(mockPosthog.register).not.toHaveBeenCalled();
    expect(mockPosthog.reset).not.toHaveBeenCalled();
    expect(mockPosthog.captureException).not.toHaveBeenCalled();
  });
});

describe("with a project token", () => {
  it("starts PostHog through the same-origin proxy with capture that could record client data turned off", () => {
    const analytics = loadAnalytics("phc_test");

    analytics.initAnalytics();

    expect(mockPosthog.init).toHaveBeenCalledTimes(1);
    const [token, config] = mockPosthog.init.mock.calls[0];
    expect(token).toBe("phc_test");
    expect(config).toMatchObject({
      api_host: "/ingest",
      autocapture: false,
      disable_session_recording: true,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      person_profiles: "identified_only",
    });
    const scrubbed = config.before_send({
      uuid: "u1",
      event: "$pageview",
      properties: { $current_url: "https://app.paralegix.com/share/SECRET123?token=SECRET123" },
    });
    expect(JSON.stringify(scrubbed)).not.toContain("SECRET123");
  });

  // After a decline in the same page, PostHog must not write its id back.
  it("keeps nothing in the browser while opted out", () => {
    const analytics = loadAnalytics("phc_test");

    analytics.initAnalytics();

    expect(mockPosthog.init.mock.calls[0][1]).toMatchObject({ opt_out_persistence_by_default: true });
  });

  it("initialises once however many times it is called", () => {
    const analytics = loadAnalytics("phc_test");
    analytics.initAnalytics();
    analytics.initAnalytics();
    expect(mockPosthog.init).toHaveBeenCalledTimes(1);
  });

  it("sends a tracked event with its properties", () => {
    const analytics = loadAnalytics("phc_test");
    analytics.initAnalytics();

    analytics.track("invoice_sent", { channel: "email", context_type: "matter" });

    expect(mockPosthog.capture).toHaveBeenCalledWith("invoice_sent", { channel: "email", context_type: "matter" });
  });

  it("identifies a user by id alone, with no email or name", () => {
    const analytics = loadAnalytics("phc_test");
    analytics.initAnalytics();

    analytics.identifyUser("uid-1");

    expect(mockPosthog.identify).toHaveBeenCalledTimes(1);
    expect(mockPosthog.identify.mock.calls[0]).toEqual(["uid-1"]);
  });

  it("does not re-identify a user PostHog already knows", () => {
    const analytics = loadAnalytics("phc_test");
    analytics.initAnalytics();
    mockPosthog.get_distinct_id.mockReturnValueOnce("uid-1");

    analytics.identifyUser("uid-1");

    expect(mockPosthog.identify).not.toHaveBeenCalled();
  });

  it("tags later events with the portal and firm, and joins the firm group", () => {
    const analytics = loadAnalytics("phc_test");
    analytics.initAnalytics();

    analytics.setAnalyticsContext("client", "firm-1");

    expect(mockPosthog.register).toHaveBeenCalledWith({ user_type: "client", law_firm_id: "firm-1" });
    expect(mockPosthog.group).toHaveBeenCalledWith("law_firm", "firm-1");
  });

  it("skips the firm group when no firm is known yet", () => {
    const analytics = loadAnalytics("phc_test");
    analytics.initAnalytics();

    analytics.setAnalyticsContext("client", null);

    expect(mockPosthog.register).toHaveBeenCalledWith({ user_type: "client", law_firm_id: null });
    expect(mockPosthog.group).not.toHaveBeenCalled();
  });
});

// Where the visitor must choose first, PostHog starts late or not at all, so the
// identity and context the app set in the meantime have to survive until then.
describe("starting after the app has already set who the user is", () => {
  it("applies the signed-in user and their firm once analytics starts", () => {
    const analytics = loadAnalytics("phc_test");

    analytics.identifyUser("uid-1");
    analytics.setAnalyticsContext("firm_member", "firm-1");
    expect(mockPosthog.identify).not.toHaveBeenCalled();

    analytics.initAnalytics();

    expect(mockPosthog.identify).toHaveBeenCalledWith("uid-1");
    expect(mockPosthog.register).toHaveBeenCalledWith({ user_type: "firm_member", law_firm_id: "firm-1" });
    expect(mockPosthog.group).toHaveBeenCalledWith("law_firm", "firm-1");
  });

  it("forgets a user who signed out before analytics started", () => {
    const analytics = loadAnalytics("phc_test");

    analytics.identifyUser("uid-1");
    analytics.resetAnalytics();
    analytics.initAnalytics();

    expect(mockPosthog.identify).not.toHaveBeenCalled();
  });
});

describe("turning analytics off and on", () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = "ph_phc_test_posthog=abc; path=/";
    localStorage.setItem("ph_phc_test_posthog", "{}");
    localStorage.setItem("paralegix-theme", "dark");
  });

  it("stops capture, sends nothing further and removes PostHog's stored id", () => {
    const analytics = loadAnalytics("phc_test");
    analytics.initAnalytics();

    analytics.disableAnalytics();
    analytics.track("matter_created", { client_count: 1 });
    analytics.captureAnalyticsException(new Error("boom"));

    expect(mockPosthog.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(mockPosthog.capture).not.toHaveBeenCalled();
    expect(mockPosthog.captureException).not.toHaveBeenCalled();
    expect(localStorage.getItem("ph_phc_test_posthog")).toBeNull();
    expect(document.cookie).not.toContain("ph_phc_test_posthog");
    expect(localStorage.getItem("paralegix-theme")).toBe("dark");
  });

  it("opts back in without starting PostHog twice", () => {
    const analytics = loadAnalytics("phc_test");
    analytics.initAnalytics();
    analytics.disableAnalytics();

    analytics.enableAnalytics();
    analytics.track("matter_created", { client_count: 1 });

    expect(mockPosthog.init).toHaveBeenCalledTimes(1);
    expect(mockPosthog.opt_in_capturing).toHaveBeenCalledTimes(1);
    expect(mockPosthog.capture).toHaveBeenCalledWith("matter_created", { client_count: 1 });
  });

  it("starts PostHog when turned on for the first time", () => {
    const analytics = loadAnalytics("phc_test");

    analytics.enableAnalytics();

    expect(mockPosthog.init).toHaveBeenCalledTimes(1);
    expect(mockPosthog.opt_in_capturing).not.toHaveBeenCalled();
  });

  it("does not start PostHog on a later init once turned off", () => {
    const analytics = loadAnalytics("phc_test");

    analytics.disableAnalytics();
    analytics.initAnalytics();

    expect(mockPosthog.init).not.toHaveBeenCalled();
  });
});
