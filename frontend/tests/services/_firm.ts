/**
 * Shared helper for the live service integration tests.
 *
 * The test account belongs to more than one law firm. The first id returned by
 * `/users/my-lawfirms` is a legacy firm whose role is missing newer permissions,
 * so hitting billing/charge-code endpoints with it yields spurious 403s. The
 * correct firm for these tests is "Test3 Test Firm" (full permissions, comped).
 *
 * `resolveTestFirmId()` picks that firm by name, falling back to the first firm
 * whose `GET /lawfirms/:id/billing/charge-codes` returns 200 (i.e. the firm whose
 * role actually carries the billing permissions the tests exercise).
 */

const TEST_FIRM_NAME = "Test3 Test Firm";

function token(): string {
  const t = process.env.__TEST_TOKEN__ || process.env.TEST_TOKEN;
  if (!t) {
    throw new Error("Set __TEST_TOKEN__ (or TEST_TOKEN) before running frontend service tests.");
  }
  return t;
}

export function apiBase(): string {
  return (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5001/api").replace(/\/$/, "");
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${token()}`,
    "x-timezone": "America/New_York",
  };
}

async function listLawFirmIds(): Promise<string[]> {
  const res = await fetch(`${apiBase()}/users/my-lawfirms`, {
    method: "GET",
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Failed to load law firms for tests (${res.status}).`);
  }
  const body = (await res.json()) as { lawFirmIds?: string[]; lawFirms?: Array<{ id?: string }> };
  const ids = Array.isArray(body.lawFirmIds)
    ? body.lawFirmIds
    : Array.isArray(body.lawFirms)
      ? body.lawFirms.map((f) => f?.id).filter((x): x is string => typeof x === "string")
      : [];
  if (ids.length === 0) {
    throw new Error("No lawFirmIds available for test user.");
  }
  return ids;
}

async function firmName(lawFirmId: string): Promise<string | null> {
  const res = await fetch(`${apiBase()}/lawfirms/${encodeURIComponent(lawFirmId)}`, {
    method: "GET",
    headers: authHeaders(),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { name?: string; lawFirm?: { name?: string } };
  return body?.name ?? body?.lawFirm?.name ?? null;
}

async function hasBillingAccess(lawFirmId: string): Promise<boolean> {
  const res = await fetch(`${apiBase()}/lawfirms/${encodeURIComponent(lawFirmId)}/billing/charge-codes`, {
    method: "GET",
    headers: authHeaders(),
  });
  return res.status === 200;
}

let cachedFirmId: string | null = null;

/**
 * Resolve the id of the firm the service tests should run against.
 * Prefers the firm literally named "Test3 Test Firm"; falls back to the first
 * firm whose billing charge-codes endpoint returns 200.
 */
export async function resolveTestFirmId(): Promise<string> {
  if (cachedFirmId) return cachedFirmId;

  const ids = await listLawFirmIds();

  for (const id of ids) {
    const name = await firmName(id);
    if (name === TEST_FIRM_NAME) {
      cachedFirmId = id;
      return id;
    }
  }

  for (const id of ids) {
    if (await hasBillingAccess(id)) {
      cachedFirmId = id;
      return id;
    }
  }

  // Last resort: the first firm (preserves prior behaviour when nothing matches).
  cachedFirmId = ids[0];
  return ids[0];
}
