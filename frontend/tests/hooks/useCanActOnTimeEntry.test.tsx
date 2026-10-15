import { renderHook } from "@testing-library/react";
import useCanActOnTimeEntry from "@/hooks/billingHooks/useCanActOnTimeEntry";
import { mockAuthValue } from "../setup";
import { grantPermissions, resetPermissions } from "../support/permissions";

const uid = mockAuthValue.user.uid;

afterEach(() => resetPermissions());

describe("useCanActOnTimeEntry", () => {
  it("lets a manager without the others code act on their own entry only", () => {
    grantPermissions(["billing.manageTimeEntries"]);
    const { result } = renderHook(() => useCanActOnTimeEntry());

    expect(result.current.canActOnEntry({ userId: uid })).toBe(true);
    expect(result.current.canActOnEntry({ userId: "someone-else" })).toBe(false);
    // Firm-level time has no timekeeper, so it is nobody's own.
    expect(result.current.canActOnEntry({ userId: null })).toBe(false);
    expect(result.current.canActOnEntry({})).toBe(false);
  });

  it("lets a holder of billing.manageOthersTimeEntries act on any entry", () => {
    grantPermissions(["billing.manageTimeEntries", "billing.manageOthersTimeEntries"]);
    const { result } = renderHook(() => useCanActOnTimeEntry());

    expect(result.current.canManageOthers).toBe(true);
    expect(result.current.canActOnEntry({ userId: "someone-else" })).toBe(true);
    expect(result.current.canActOnEntry({ userId: null })).toBe(true);
  });
});
