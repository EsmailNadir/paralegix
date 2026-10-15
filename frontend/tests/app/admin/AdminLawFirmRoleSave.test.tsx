/**
 * Saving a role from the admin console's firm detail page.
 *
 * WHAT BREAKS THIS: sending the ticked permissions as they are instead of through
 * `withImpliedViewPermissions`, or writing the raw ticked list into the page's
 * local role state, so the table shows a role that differs from what the server
 * stored.
 */
import React from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../../setup";
import { renderWithProviders } from "../../support/renderWithProviders";
import { PERMISSIONS } from "@/lib/constants/permissions";

// The page reloads its detail whenever the router identity changes, so the
// router must be one stable object as it is in the app.
const mockRouter = { push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() };
jest.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => "/admin/lawfirms/firm-1",
  useParams: () => ({ lawFirmId: "firm-1" }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("@/services/users.service", () => ({
  __esModule: true,
  default: { getProfile: jest.fn().mockResolvedValue({ isAdmin: true }) },
}));

const mockGetLawFirmDetail = jest.fn();
const mockUpdateLawFirmRole = jest.fn();
const mockRemoveMember = jest.fn();
const mockDeletePendingInvite = jest.fn();
const mockDeletePendingClientInvite = jest.fn();
jest.mock("@/services/admin.service", () => ({
  __esModule: true,
  default: {
    getLawFirmDetail: (...args: unknown[]) => mockGetLawFirmDetail(...args),
    updateLawFirmRole: (...args: unknown[]) => mockUpdateLawFirmRole(...args),
    removeMember: (...args: unknown[]) => mockRemoveMember(...args),
    deletePendingInvite: (...args: unknown[]) => mockDeletePendingInvite(...args),
    deletePendingClientInvite: (...args: unknown[]) => mockDeletePendingClientInvite(...args),
    quotaBytesToMb: (bytes: number) => bytes / (1024 * 1024),
  },
}));

import AdminLawFirmDetailPage from "@/app/admin/lawfirms/[lawFirmId]/page";

const checkboxFor = (code: keyof typeof PERMISSIONS) => {
  const label = screen.getByText(PERMISSIONS[code].name, { selector: "p" }).closest("label") as HTMLElement;
  return label.querySelector('input[type="checkbox"]') as HTMLInputElement;
};

describe("admin firm detail role save", () => {
  function serveRole(permissions: string[]) {
    mockGetLawFirmDetail.mockResolvedValue({
      lawFirm: { id: "firm-1", name: "Acme Law", email: "firm@example.com" },
      members: [],
      roles: [{ id: "role-1", name: "Biller", isBuiltIn: false, permissions }],
      pendingInvites: [],
      pendingClientInvites: [],
      clients: [],
    });
  }

  beforeEach(() => {
    mockGetLawFirmDetail.mockReset();
    mockUpdateLawFirmRole.mockReset();
    mockUpdateLawFirmRole.mockResolvedValue({ message: "ok" });
    mockGetLawFirmDetail.mockResolvedValue({
      lawFirm: { id: "firm-1", name: "Acme Law", email: "firm@example.com" },
      members: [],
      roles: [{ id: "role-1", name: "Biller", isBuiltIn: false, permissions: [] }],
      pendingInvites: [],
      pendingClientInvites: [],
      clients: [],
    });
  });

  it("sends the implied reads and shows the normalized role after saving manage invoices", async () => {
    renderWithProviders(<AdminLawFirmDetailPage />);

    await userEvent.click(await screen.findByRole("button", { name: /Roles/ }));
    expect(await screen.findByText("0 permissions")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Edit$/ }));

    await userEvent.click(await screen.findByText(PERMISSIONS["billing.manageInvoices"].name, { selector: "p" }));
    expect(checkboxFor("billing.manageInvoices")).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Save Role" }));

    await waitFor(() => expect(mockUpdateLawFirmRole).toHaveBeenCalled());
    const [firmId, roleId, payload] = mockUpdateLawFirmRole.mock.calls[0];
    expect(firmId).toBe("firm-1");
    expect(roleId).toBe("role-1");
    expect([...payload.permissions].sort()).toEqual(
      ["billing.manageInvoices", "billing.viewInvoices", "billing.viewRates"],
    );

    expect(await screen.findByText("3 permissions")).toBeInTheDocument();
    expect(screen.queryByText("0 permissions")).not.toBeInTheDocument();
  });

  // A role stored with a manage code and no reads has nothing for the editor's own
  // onChange to add, so only the page's save step can supply them.
  it("normalizes a stored manage-only role on save, in the payload and in the table", async () => {
    serveRole(["billing.manageInvoices"]);
    renderWithProviders(<AdminLawFirmDetailPage />);

    await userEvent.click(await screen.findByRole("button", { name: /Roles/ }));
    expect(await screen.findByText("1 permission")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Edit$/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Save Role" }));

    await waitFor(() => expect(mockUpdateLawFirmRole).toHaveBeenCalled());
    expect([...mockUpdateLawFirmRole.mock.calls[0][2].permissions].sort()).toEqual(
      ["billing.manageInvoices", "billing.viewInvoices", "billing.viewRates"],
    );
    expect(await screen.findByText("3 permissions")).toBeInTheDocument();
  });
});

describe("admin destructive actions", () => {
  it.each([
    ["Members", "Bob Member", "Remove", "Remove Member", "member-1", mockRemoveMember],
    ["Pending Member Invites", "member@example.test", "Delete", "Delete Invitation", "invite-1", mockDeletePendingInvite],
    ["Pending Client Invites", "client@example.test", "Delete", "Delete Invitation", "client-invite-1", mockDeletePendingClientInvite],
  ] as const)("confirms actions in %s and cancels without changing saved data", async (tab, label, action, title, id, mutation) => {
    mutation.mockReset().mockResolvedValue({});
    mockGetLawFirmDetail.mockResolvedValue({
      lawFirm: { id: "firm-1", name: "Acme Law", email: "firm@example.com" },
      members: [{ id: "member-1", name: "Bob Member", email: "bob@example.test", isOwner: false }],
      roles: [], clients: [],
      pendingInvites: [{ id: "invite-1", email: "member@example.test" }],
      pendingClientInvites: [{ id: "client-invite-1", email: "client@example.test" }],
    });
    renderWithProviders(<AdminLawFirmDetailPage />);
    const section = await screen.findByRole("button", { name: new RegExp(`^${tab}`) });
    if (tab !== "Members") await userEvent.click(section);
    const row = screen.getByText(label).closest("tr") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: action }));
    let dialog = await screen.findByRole("dialog", { name: title });
    expect(dialog).toHaveTextContent(label);
    expect(mutation).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: title })).not.toBeInTheDocument());
    expect(mutation).not.toHaveBeenCalled();
    await userEvent.click(within(row).getByRole("button", { name: action }));
    dialog = await screen.findByRole("dialog", { name: title });
    await userEvent.click(within(dialog).getByRole("button", { name: action }));
    await waitFor(() => expect(mutation).toHaveBeenCalledWith("firm-1", id));
  });
});
