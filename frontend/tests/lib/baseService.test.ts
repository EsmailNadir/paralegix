/**
 * `BaseApiService`: the one place in the frontend that turns "the current
 * user" into a credential, used by roughly 30 domain services. `tests/services/`
 * exercises it live against a real backend but is excluded from `test:unit`
 * (needs a running server and a real Firebase token), so the wiring rules
 * below had no offline coverage at all.
 *
 * `apiFetch`, `getFirebaseToken` and `toApiError` are mocked: this is a unit
 * test of what base.service.ts itself decides to send, not of the transport
 * or error-parsing modules underneath it, which have their own specs.
 */
const mockApiFetch = jest.fn();
const mockGetFirebaseToken = jest.fn();
const mockToApiError = jest.fn();

jest.mock("@/lib/utils/fetchWithTokenRefresh", () => ({
  __esModule: true,
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

jest.mock("@/lib/utils/auth", () => ({
  __esModule: true,
  getFirebaseToken: (...args: unknown[]) => mockGetFirebaseToken(...args),
}));

jest.mock("@/lib/utils/apiErrors", () => ({
  __esModule: true,
  toApiError: (...args: unknown[]) => mockToApiError(...args),
}));

jest.mock("@/lib/utils/timezone", () => ({
  __esModule: true,
  getUserTimeZone: () => "America/New_York",
}));

import { BaseApiService, authenticatedHeaders, type ApiRequestOptions } from "@/services/base.service";

/** Exposes the protected transport methods so the test can call them directly. */
class TestService extends BaseApiService {
  constructor() {
    super("widgets");
  }
  callRequest<T>(url: string, options?: ApiRequestOptions) {
    return this.request<T>(url, options);
  }
  callRequestRaw(url: string, options?: ApiRequestOptions) {
    return this.requestRaw(url, options);
  }
  callDedupedGet<T>(url: string, options?: ApiRequestOptions) {
    return this.dedupedGet<T>(url, options);
  }
  callUrl(...segments: (string | number)[]) {
    return this.url(...segments);
  }
}

function okResponse(body: unknown, status = 200): Response {
  return {
    ok: true,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockGetFirebaseToken.mockReset();
  mockToApiError.mockReset();
  mockGetFirebaseToken.mockResolvedValue("real-firebase-token");
  mockApiFetch.mockResolvedValue(okResponse({}));
});

describe("authentication header", () => {
  it("attaches a bearer token when Firebase has one", async () => {
    const service = new TestService();
    await service.callRequest("http://x/api/widgets");

    const [, init] = mockApiFetch.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer real-firebase-token");
  });

  it("omits Authorization entirely when there is no token, rather than sending 'Bearer null'", async () => {
    mockGetFirebaseToken.mockResolvedValue(null);
    const service = new TestService();

    await service.callRequest("http://x/api/widgets");

    const [, init] = mockApiFetch.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.stringify(init.headers)).not.toContain("Bearer null");
    expect(JSON.stringify(init.headers)).not.toContain("Bearer undefined");
  });

  it("sends X-Timezone by default", async () => {
    const service = new TestService();

    await service.callRequest("http://x/api/widgets");

    const [, init] = mockApiFetch.mock.calls[0];
    expect(init.headers["X-Timezone"]).toBe("America/New_York");
  });

  it("omits X-Timezone when the caller opts out", async () => {
    const service = new TestService();

    await service.callRequest("http://x/api/widgets", { timezone: false });

    const [, init] = mockApiFetch.mock.calls[0];
    expect(init.headers["X-Timezone"]).toBeUndefined();
  });
});

describe("body encoding", () => {
  it("JSON-serializes a plain object body and sets the JSON content type", async () => {
    const service = new TestService();

    await service.callRequest("http://x/api/widgets", { method: "POST", body: { name: "A widget" } });

    const [, init] = mockApiFetch.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "A widget" }));
  });

  it("passes FormData through untouched, with no Content-Type override", async () => {
    // FormData must carry no explicit Content-Type, or the browser cannot add
    // the multipart boundary and the upload silently fails to parse server-side.
    const service = new TestService();
    const form = new FormData();
    form.append("file", "contents");

    await service.callRequest("http://x/api/widgets", { method: "POST", body: form });

    const [, init] = mockApiFetch.mock.calls[0];
    expect(init.body).toBe(form);
    expect(init.headers["Content-Type"]).toBeUndefined();
  });

  it("passes a raw string body through untouched", async () => {
    const service = new TestService();

    await service.callRequest("http://x/api/widgets", { method: "POST", body: "raw-text" });

    const [, init] = mockApiFetch.mock.calls[0];
    expect(init.body).toBe("raw-text");
    expect(init.headers["Content-Type"]).toBeUndefined();
  });

  it("sends no body at all when none is given", async () => {
    const service = new TestService();

    await service.callRequest("http://x/api/widgets");

    const [, init] = mockApiFetch.mock.calls[0];
    expect(init.body).toBeUndefined();
  });
});

describe("response handling", () => {
  it("returns undefined for a 204 rather than attempting to parse an empty body", async () => {
    mockApiFetch.mockResolvedValue(okResponse(null, 204));
    const service = new TestService();

    const result = await service.callRequest("http://x/api/widgets");

    expect(result).toBeUndefined();
  });

  it("returns the parsed JSON body for an ordinary success", async () => {
    mockApiFetch.mockResolvedValue(okResponse({ id: "w1" }));
    const service = new TestService();

    const result = await service.callRequest<{ id: string }>("http://x/api/widgets");

    expect(result).toEqual({ id: "w1" });
  });

  it("throws through toApiError on a non-2xx response, and never returns it", async () => {
    const failure = { ok: false, status: 403, json: async () => ({ error: "Forbidden" }) } as unknown as Response;
    mockApiFetch.mockResolvedValue(failure);
    const thrown = new Error("Forbidden");
    mockToApiError.mockResolvedValue(thrown);
    const service = new TestService();

    await expect(service.callRequest("http://x/api/widgets")).rejects.toBe(thrown);
  });
});

describe("url()", () => {
  it("joins segments onto the base url, encoding each one", () => {
    const service = new TestService();

    expect(service.callUrl("a matter/id", "sub")).toBe(
      `${service["baseUrl"]}/${encodeURIComponent("a matter/id")}/sub`,
    );
  });

  it("returns the bare base url with no segments", () => {
    const service = new TestService();

    expect(service.callUrl()).toBe(service["baseUrl"]);
  });
});

describe("authenticatedHeaders (the standalone helper for non-class call sites)", () => {
  it("throws when a token is required but Firebase has none", async () => {
    mockGetFirebaseToken.mockResolvedValue(null);

    await expect(authenticatedHeaders({}, { requireToken: true })).rejects.toThrow(/session has expired/i);
  });

  it("does not throw when no token is required", async () => {
    mockGetFirebaseToken.mockResolvedValue(null);

    await expect(authenticatedHeaders()).resolves.toBeDefined();
  });
});
