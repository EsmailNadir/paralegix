import { sanitizeNextPath } from "@/lib/utils/safeNext";

describe("sanitizeNextPath", () => {
  it("passes through a same-origin path unchanged", () => {
    expect(sanitizeNextPath("/lawfirm/abc/tasks/123")).toBe("/lawfirm/abc/tasks/123");
  });

  it("preserves the query string on a same-origin path", () => {
    expect(sanitizeNextPath("/lawfirm/abc/matters/1?tab=events")).toBe(
      "/lawfirm/abc/matters/1?tab=events"
    );
  });

  it.each([
    ["a protocol-relative path", "//evil.com/phish"],
    ["a backslash-smuggled path", "/\\evil.com"],
    ["an absolute https URL", "https://evil.com"],
    ["an absolute http URL", "http://evil.com"],
    ["a javascript: URI", "javascript:alert(1)"],
    ["a path missing the leading slash", "lawfirm/abc"],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["a path over the length cap", "/" + "a".repeat(2100)],
  ])("rejects %s", (_label, input) => {
    expect(sanitizeNextPath(input)).toBeNull();
  });

  // The following cases are not in the required table above; each is called
  // out because it surfaces a real judgment call in the implementation.

  it("preserves the fragment on an otherwise-valid path", () => {
    // A hash is never sent to the server and cannot redirect anywhere, so it
    // carries through rather than being dropped - a link that targeted an
    // in-page anchor still lands on it after the login round-trip.
    expect(sanitizeNextPath("/lawfirm/abc#section")).toBe("/lawfirm/abc#section");
  });

  it("does not decode a percent-encoded slash into a path separator", () => {
    // %2F stays literal in URL#pathname, so this resolves same-origin and
    // is accepted (not decoded into `//evil.com`, which would need the
    // rejection above).
    expect(sanitizeNextPath("/%2F%2Fevil.com")).toBe("/%2F%2Fevil.com");
  });

  it("does not decode percent-encoded traversal sequences", () => {
    // Same reasoning: %2f is not decoded to `/` by URL#pathname, so this
    // stays a same-origin literal path segment rather than escaping via
    // traversal.
    expect(sanitizeNextPath("/..%2f..%2fetc")).toBe("/..%2f..%2fetc");
  });

  it("accepts a path that merely starts with the characters 'login'", () => {
    // The redirect-loop guard matches a path segment, not a string prefix, so
    // a future route like `/login-history` still round-trips instead of being
    // mistaken for the login page and silently dropped.
    expect(sanitizeNextPath("/loginsomething")).toBe("/loginsomething");
    expect(sanitizeNextPath("/login-history")).toBe("/login-history");
  });

  it.each(["/login", "/login?next=/x", "/login/reset"])(
    "rejects the login page, with a query string or beneath it, to avoid a redirect loop: %s",
    (input) => {
      expect(sanitizeNextPath(input)).toBeNull();
    },
  );
});
