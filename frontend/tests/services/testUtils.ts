import { apiBase, resolveTestFirmId } from "./_firm";

export function requireTestToken(): string {
  const token = process.env.__TEST_TOKEN__ || process.env.TEST_TOKEN;
  if (!token) {
    throw new Error("Set TEST_TOKEN (or __TEST_TOKEN__) before running frontend tests.");
  }
  return token;
}

export { apiBase };

/**
 * Returns the id of the firm the service tests run against ("Test3 Test Firm").
 * See `_firm.ts` for why the first firm from `/users/my-lawfirms` is the wrong one.
 */
export async function getLawFirmId(): Promise<string> {
  return resolveTestFirmId();
}

export async function getAnyMatterId(lawFirmId: string): Promise<string | null> {
  const token = requireTestToken();
  const res = await fetch(`${apiBase()}/lawfirms/${encodeURIComponent(lawFirmId)}/matters`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-timezone": "America/New_York",
    },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { matters?: Array<{ id?: string }> };
  const first = Array.isArray(body.matters) ? body.matters.find((c) => typeof c.id === "string") : undefined;
  return first?.id || null;
}
