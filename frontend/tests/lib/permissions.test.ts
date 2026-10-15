import {
  ALL_PERMISSIONS,
  BUILT_IN_ROLES,
  DEFAULT_PERMISSIONS,
  PERMISSIONS,
  resolveMemberPermissions,
  type Permission,
} from "@/lib/constants/permissions";

describe("frontend permission fallbacks", () => {
  it('does not grant financial reads to a member with an empty custom role', () => {
    const resolved = resolveMemberPermissions({ permissions: [], role: 'Custom' });
    expect(resolved.filter((code) => code.startsWith('billing.view') || code === 'trust.view')).toEqual([]);
  });
  it('honors an empty explicit permission list even when the role label contains admin', () => {
    expect(sorted(resolveMemberPermissions({ resolvedPermissions: [], role: 'Billing Admin' })))
      .toEqual(sorted(DEFAULT_PERMISSIONS));
  });
  it("keeps paralegal billing visibility aligned with backend defaults", () => {
    expect(BUILT_IN_ROLES.paralegal.permissions).toContain("billing.viewInvoices");

    const resolved = resolveMemberPermissions({
      role: "Paralegal",
      isOwner: false,
    });

    expect(resolved).toContain("billing.viewInvoices");
  });
});

/**
 * `resolveMemberPermissions` is the frontend's own answer to "what can this
 * member do", used by PermissionsContext to decide what to show. The backend is
 * the real boundary, but a wrong answer here hides a page a member may open or
 * shows actions they will be refused. Order of precedence: owner, then explicit
 * permission lists, then a built-in role inferred from roleId/role, then the
 * baseline alone.
 */
const sorted = (list: readonly string[]) => [...list].sort();
const union = (...lists: readonly string[][]) => sorted(Array.from(new Set(lists.flat())));

describe("resolveMemberPermissions precedence", () => {
  it("returns nothing for no member", () => {
    expect(resolveMemberPermissions(null)).toEqual([]);
    expect(resolveMemberPermissions(undefined)).toEqual([]);
  });

  it("gives the owner every permission, whatever role or list it also carries", () => {
    const resolved = resolveMemberPermissions({ isOwner: true, role: "staff", permissions: ["tasks.view"] });
    expect(sorted(resolved)).toEqual(sorted(ALL_PERMISSIONS));
  });

  it("returns the owner a copy, so a caller mutating it cannot change ALL_PERMISSIONS", () => {
    const resolved = resolveMemberPermissions({ isOwner: true });
    resolved.pop();
    expect(ALL_PERMISSIONS).toHaveLength(Object.keys(PERMISSIONS).length);
  });

  it("unions explicit resolvedPermissions and permissions with the baseline, deduplicated", () => {
    const resolved = resolveMemberPermissions({
      resolvedPermissions: ["trust.manage", "matters.view"],
      permissions: ["trust.manage", "billing.manageInvoices"],
      role: "admin",
    });
    // The role is ignored once an explicit list exists: an admin role string
    // must not widen a member whose explicit permissions say otherwise.
    expect(sorted(resolved)).toEqual(
      union(DEFAULT_PERMISSIONS, ["trust.manage", "billing.manageInvoices"]),
    );
    expect(resolved).toHaveLength(new Set(resolved).size);
  });

  it("drops permission codes the frontend does not know", () => {
    const resolved = resolveMemberPermissions({ permissions: ["trust.manage", "not.a.permission"] });
    expect(resolved).not.toContain("not.a.permission");
    expect(sorted(resolved)).toEqual(union(DEFAULT_PERMISSIONS, ["trust.manage"]));
  });

  it("does not widen unknown explicit codes through a role label", () => {
    const resolved = resolveMemberPermissions({ permissions: ["bogus"], role: "staff" });
    expect(sorted(resolved)).toEqual(sorted(DEFAULT_PERMISSIONS));
  });

  it("ignores a non-array permissions field instead of throwing", () => {
    const resolved = resolveMemberPermissions({
      permissions: "trust.manage" as unknown as string[],
      resolvedPermissions: null as unknown as string[],
    });
    expect(sorted(resolved)).toEqual(sorted(DEFAULT_PERMISSIONS));
  });

  it("prefers a built-in roleId over the role string", () => {
    const resolved = resolveMemberPermissions({ roleId: "STAFF", role: "attorney" });
    expect(sorted(resolved)).toEqual(union(DEFAULT_PERMISSIONS, BUILT_IN_ROLES.staff.permissions));
  });

  it("gives an unrecognised role exactly the baseline", () => {
    const resolved = resolveMemberPermissions({ roleId: "8a1c-custom", role: "Bookkeeper" });
    expect(sorted(resolved)).toEqual(sorted(DEFAULT_PERMISSIONS));
  });
});

describe("resolveMemberPermissions role inference", () => {
  it.each([
    ["Senior Attorney", "attorney"],
    ["office_paralegal", "paralegal"],
    ["Firm Member", "staff"],
    ["  ADMIN  ", "admin"],
  ] as const)("reads %p as the built-in %p role", (role, key) => {
    const resolved = resolveMemberPermissions({ role });
    expect(sorted(resolved)).toEqual(union(DEFAULT_PERMISSIONS, BUILT_IN_ROLES[key].permissions));
  });

  it("matches whole words only, so Administrator is not read as admin", () => {
    const resolved = resolveMemberPermissions({ role: "Administrator" });
    expect(sorted(resolved)).toEqual(sorted(DEFAULT_PERMISSIONS));
  });

  it("checks owner before admin, so a role naming both resolves to owner", () => {
    const resolved = resolveMemberPermissions({ role: "owner admin" });
    expect(resolved).toContain("firm.transferOwnership");
  });

  it("CHARACTERISATION: a custom role with no permissions whose name contains 'admin' gets the admin UI", () => {
    // Token matching means "Admin Assistant" with an empty permission list is
    // shown every admin action client-side. The backend still refuses them;
    // recorded as shipped and reported.
    const resolved = resolveMemberPermissions({ role: "Admin Assistant" });
    expect(resolved).toContain("trust.manage");
    expect(resolved).not.toContain("firm.transferOwnership");
  });

  it("treats a role named after an Object.prototype key as an unknown role", () => {
    // An inherited-key lookup (`"constructor" in BUILT_IN_ROLES`) once returned a
    // function with no `permissions`, and the spread threw inside
    // PermissionsContext for a firm role literally named "Constructor".
    expect(resolveMemberPermissions({ role: "Constructor" })).toEqual(resolveMemberPermissions({ role: "no-such-role" }));
    expect(resolveMemberPermissions({ roleId: "__proto__" })).toEqual(resolveMemberPermissions({ role: "no-such-role" }));
    expect(resolveMemberPermissions({ roleId: "toString" })).toEqual(resolveMemberPermissions({ role: "no-such-role" }));
  });
});

describe("built-in role and baseline tables", () => {
  const known = new Set<string>(Object.keys(PERMISSIONS));

  it("lists only real permission codes in every built-in role and in the baseline", () => {
    for (const role of Object.values(BUILT_IN_ROLES)) {
      expect(role.permissions.filter((p) => !known.has(p))).toEqual([]);
    }
    expect(DEFAULT_PERMISSIONS.filter((p) => !known.has(p))).toEqual([]);
  });

  it("gives admin everything except transferring ownership", () => {
    expect(sorted(BUILT_IN_ROLES.admin.permissions)).toEqual(
      sorted(ALL_PERMISSIONS.filter((p: Permission) => p !== "firm.transferOwnership")),
    );
  });

  it("keeps trust management and firm administration out of the baseline", () => {
    for (const p of ["trust.manage", "trust.reconcile", "firm.transferOwnership"] as const) {
      expect(DEFAULT_PERMISSIONS).not.toContain(p);
    }
  });
});
