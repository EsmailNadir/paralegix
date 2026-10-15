/**
 * @jest-environment node
 */
import { GET } from "@/app/api/consent-region/route";

const request = (country?: string) =>
  new Request("https://app.paralegix.com/api/consent-region", {
    headers: country ? { "x-vercel-ip-country": country } : {},
  });

describe("GET /api/consent-region", () => {
  it("asks for consent when Vercel places the visitor in the EU", async () => {
    const res = await GET(request("DE"));
    expect(await res.json()).toEqual({ region: "required" });
  });

  it("shows the notice only for a US visitor", async () => {
    const res = await GET(request("US"));
    expect(await res.json()).toEqual({ region: "notice" });
  });

  it("answers null without the header, so the browser falls back to its time zone", async () => {
    const res = await GET(request());
    expect(await res.json()).toEqual({ region: null });
  });

  // A shared cache would hand one visitor's country to the next.
  it("is never cached", async () => {
    const res = await GET(request("DE"));
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("cache-control")).toContain("private");
  });
});
