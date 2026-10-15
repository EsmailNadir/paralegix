import type { CaptureResult } from "posthog-js";
import { sanitizeUrl, scrubCapture, REDACTED_SEGMENT } from "@/lib/analytics/sanitize";

describe("sanitizeUrl", () => {
  it("drops the query string that carries invite and password-reset tokens", () => {
    expect(sanitizeUrl("https://app.paralegix.com/reset-password?oobCode=SECRET123&mode=resetPassword")).toBe(
      "https://app.paralegix.com/reset-password",
    );
    expect(sanitizeUrl("https://app.paralegix.com/accept-invite?token=SECRET123&email=jane%40example.com")).toBe(
      "https://app.paralegix.com/accept-invite",
    );
  });

  it("drops the hash", () => {
    expect(sanitizeUrl("https://app.paralegix.com/lawfirm/f1/matters#SECRET123")).toBe(
      "https://app.paralegix.com/lawfirm/f1/matters",
    );
  });

  it("redacts the bearer token segment of share and intake links", () => {
    expect(sanitizeUrl("https://app.paralegix.com/share/SECRET123")).toBe(
      `https://app.paralegix.com/share/${REDACTED_SEGMENT}`,
    );
    expect(sanitizeUrl("https://app.paralegix.com/intake/SECRET123/step-2")).toBe(
      `https://app.paralegix.com/intake/${REDACTED_SEGMENT}/step-2`,
    );
  });

  it("keeps ordinary record ids, which identify nothing on their own", () => {
    expect(sanitizeUrl("https://app.paralegix.com/lawfirm/f1/matters/m1?tab=notes")).toBe(
      "https://app.paralegix.com/lawfirm/f1/matters/m1",
    );
  });

  it.each([
    ["https://app.paralegix.com/pay/PAY_SECRET123", `https://app.paralegix.com/pay/${REDACTED_SEGMENT}`],
    ["/pay/PAY_SECRET123?payment=success", `/pay/${REDACTED_SEGMENT}`],
    ["/pay/PAY_SECRET123/checkout#return", `/pay/${REDACTED_SEGMENT}/checkout`],
  ])("redacts the payment bearer token from %s", (url, expected) => {
    expect(sanitizeUrl(url)).toBe(expected);
  });

  it("sanitizes a bare pathname without inventing an origin", () => {
    expect(sanitizeUrl("/share/SECRET123?x=1")).toBe(`/share/${REDACTED_SEGMENT}`);
  });
});

describe("scrubCapture", () => {
  const capture = (overrides: Partial<CaptureResult>): CaptureResult =>
    ({ uuid: "u1", event: "$pageview", properties: {}, ...overrides }) as CaptureResult;

  it("scrubs every URL-bearing event property and leaves the rest alone", () => {
    const result = scrubCapture(
      capture({
        properties: {
          $current_url: "https://app.paralegix.com/share/SECRET123?a=1",
          $pathname: "/share/SECRET123",
          $referrer: "https://app.paralegix.com/reset-password?oobCode=SECRET123",
          $session_entry_url: "https://app.paralegix.com/accept-invite?token=SECRET123",
          $referring_domain: "$direct",
          law_firm_id: "f1",
          attachment_count: 2,
        },
      }),
    );

    expect(JSON.stringify(result)).not.toContain("SECRET123");
    expect(result?.properties).toMatchObject({
      $current_url: `https://app.paralegix.com/share/${REDACTED_SEGMENT}`,
      $pathname: `/share/${REDACTED_SEGMENT}`,
      $referrer: "https://app.paralegix.com/reset-password",
      $referring_domain: "$direct",
      law_firm_id: "f1",
      attachment_count: 2,
    });
  });

  it("scrubs the initial-URL person properties set once on first visit", () => {
    const result = scrubCapture(
      capture({
        $set_once: { $initial_current_url: "https://app.paralegix.com/intake/SECRET123" },
        $set: { $current_url: "https://app.paralegix.com/share/SECRET123" },
      }),
    );

    expect(JSON.stringify(result)).not.toContain("SECRET123");
    expect(result?.$set_once?.$initial_current_url).toBe(`https://app.paralegix.com/intake/${REDACTED_SEGMENT}`);
  });

  it("redacts payment tokens from pageviews and person URL properties", () => {
    const url = "https://app.paralegix.com/pay/PAY_SECRET123?payment=success";
    const redactedUrl = `https://app.paralegix.com/pay/${REDACTED_SEGMENT}`;
    const result = scrubCapture(
      capture({
        properties: { $current_url: url, $pathname: "/pay/PAY_SECRET123", $referrer: url },
        $set_once: { $initial_current_url: url },
        $set: { $current_url: url },
      }),
    );

    expect(result?.properties).toEqual({
      $current_url: redactedUrl,
      $pathname: `/pay/${REDACTED_SEGMENT}`,
      $referrer: redactedUrl,
    });
    expect(result?.$set_once?.$initial_current_url).toBe(redactedUrl);
    expect(result?.$set?.$current_url).toBe(redactedUrl);
  });

  // A page title can name a matter or client ("Smith v. Jones | Paralegix"), and
  // the path already says which page it was.
  it("drops the page title PostHog attaches to a pageview", () => {
    const result = scrubCapture(
      capture({ properties: { title: "Smith v. Jones | Paralegix", $pathname: "/lawfirm/f1/matters/m1" } }),
    );

    expect(JSON.stringify(result)).not.toContain("Smith");
    expect(result?.properties).not.toHaveProperty("title");
    expect(result?.properties.$pathname).toBe("/lawfirm/f1/matters/m1");
  });

  it("passes a dropped event through as dropped", () => {
    expect(scrubCapture(null)).toBeNull();
  });

  // An error message can quote whatever the user typed or the server echoed back,
  // so an exception keeps its type and code location and nothing else.
  describe("exceptions", () => {
    const PRIVILEGED = "Smith v. Jones settlement floor 40k";
    const exception = () =>
      capture({
        event: "$exception",
        properties: {
          $exception_list: [
            {
              type: "ApiError",
              value: `Could not save note "${PRIVILEGED}"`,
              mechanism: { handled: false, type: "onunhandledrejection", synthetic: false },
              stacktrace: {
                type: "raw",
                frames: [
                  {
                    platform: "web:javascript",
                    filename: "https://app.paralegix.com/_next/static/chunks/app.js",
                    function: "saveNote",
                    lineno: 12,
                    colno: 34,
                    in_app: true,
                    chunk_id: "chunk-1",
                    context_line: `const title = "${PRIVILEGED}"`,
                    pre_context: [PRIVILEGED],
                    post_context: [PRIVILEGED],
                    vars: { title: PRIVILEGED },
                  },
                ],
              },
            },
          ],
          $exception_message: PRIVILEGED,
          $exception_values: [PRIVILEGED],
          $exception_level: "error",
          $current_url: "https://app.paralegix.com/lawfirm/f1/matters?q=Smith",
          law_firm_id: "f1",
        },
      });

    it("drops every trace of the message while keeping what locates the bug", () => {
      const result = scrubCapture(exception());

      expect(JSON.stringify(result)).not.toContain("Smith");
      const [entry] = result?.properties.$exception_list as any[];
      expect(entry.type).toBe("ApiError");
      expect(entry.mechanism).toEqual({ handled: false, type: "onunhandledrejection", synthetic: false });
      expect(entry.stacktrace.frames[0]).toEqual({
        platform: "web:javascript",
        filename: "https://app.paralegix.com/_next/static/chunks/app.js",
        function: "saveNote",
        lineno: 12,
        colno: 34,
        in_app: true,
        chunk_id: "chunk-1",
      });
      expect(result?.properties).toMatchObject({
        $exception_level: "error",
        $current_url: "https://app.paralegix.com/lawfirm/f1/matters",
        law_firm_id: "f1",
      });
    });

    it("leaves the same-named properties alone on an ordinary event", () => {
      const result = scrubCapture(capture({ properties: { $exception_message: "kept" } }));
      expect(result?.properties.$exception_message).toBe("kept");
    });
  });
});
