import { regionForCountry } from "@/lib/analytics/consentRegion";

export const dynamic = "force-dynamic";

// Vercel sets x-vercel-ip-country on every request from the visitor's IP. It is
// absent in local dev, where the answer is null and the browser falls back to
// its time zone. Never cached: a shared cache would give one visitor's country
// to the next.
export function GET(request: Request) {
  const region = regionForCountry(request.headers.get("x-vercel-ip-country"));
  return Response.json({ region }, { headers: { "Cache-Control": "private, no-store" } });
}
