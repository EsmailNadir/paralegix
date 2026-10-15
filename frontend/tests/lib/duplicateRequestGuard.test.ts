import {
  trackDuplicateRequest,
  __resetDuplicateRequestGuard,
} from "@/lib/utils/duplicateRequestGuard";

// The guard is active outside production (NODE_ENV is "test" under Jest), which
// mirrors its dev behavior.
describe("duplicateRequestGuard", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    __resetDuplicateRequestGuard();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN;
  });

  it("warns when the same GET is repeated within the window", () => {
    const url = "http://x/api/lawfirms/1/clients";
    trackDuplicateRequest(url, "GET");
    trackDuplicateRequest(url, "GET");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("/api/lawfirms/1/clients");
  });

  it("warns only once per endpoint even if repeated many times", () => {
    const url = "http://x/api/lawfirms/1/clients";
    trackDuplicateRequest(url, "GET");
    trackDuplicateRequest(url, "GET");
    trackDuplicateRequest(url, "GET");
    trackDuplicateRequest(url, "GET");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("does not warn for a single request", () => {
    trackDuplicateRequest("http://x/api/lawfirms/1/matters", "GET");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("treats different query params as distinct endpoints", () => {
    trackDuplicateRequest("http://x/api/lawfirms/1/billing/charge-codes?includeInactive=true", "GET");
    trackDuplicateRequest("http://x/api/lawfirms/1/billing/charge-codes?includeInactive=false", "GET");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("ignores non-GET methods (mutations legitimately repeat)", () => {
    const url = "http://x/api/lawfirms/1/messaging/send";
    trackDuplicateRequest(url, "POST");
    trackDuplicateRequest(url, "POST");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("can be silenced with NEXT_PUBLIC_DUP_FETCH_WARN=off", () => {
    process.env.NEXT_PUBLIC_DUP_FETCH_WARN = "off";
    const url = "http://x/api/lawfirms/1/clients";
    trackDuplicateRequest(url, "GET");
    trackDuplicateRequest(url, "GET");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
