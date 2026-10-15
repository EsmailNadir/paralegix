import React from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../support/renderWithProviders";
import { grantBaselineMember, grantPermissions, resetPermissions } from "../../support/permissions";

const mockLookupMatters = jest.fn();
const mockLookupClients = jest.fn();

// The target picker is a server-backed typeahead, so the modal reaches the
// matters and clients lookups rather than a preloaded list.
jest.mock("@/services/matters.service", () => ({
  __esModule: true,
  default: {
    lookupMatters: (...args: unknown[]) => mockLookupMatters(...args),
    listClients: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: {
    lookupClients: (...args: unknown[]) => mockLookupClients(...args),
    getClientBillingRates: jest.fn().mockResolvedValue({}),
  },
}));

import TimeEntryModal from "@/components/billingComp/TimeEntryModal";

const defaultProps = {
  open: true,
  onClose: jest.fn(),
  lawFirmId: "test-law-firm-id",
  users: [
    { uid: "user-1", name: "Alice Smith", email: "alice@example.com" },
  ] as any[],
  chargeCodes: [] as any[],
  defaultUserId: "user-1",
  onSuccess: jest.fn(),
};

// The modal uses React Query (target lookups, charge-code quick-create), so it
// needs a provider.
function renderModal(props: Record<string, unknown> = {}) {
  return renderWithProviders(<TimeEntryModal {...defaultProps} {...(props as any)} />);
}

describe("TimeEntryModal", () => {
  afterEach(() => resetPermissions());

  beforeEach(() => {
    mockLookupMatters.mockReset();
    mockLookupMatters.mockResolvedValue({ items: [], hasMore: false });
    mockLookupClients.mockReset();
    mockLookupClients.mockResolvedValue({ items: [], hasMore: false });
  });

  it("defaults a new time entry to one hour", () => {
    renderModal();
    // Hours/minutes are entered via the stepper-based HoursMinutesInput.
    expect(screen.getByLabelText("Increase hours")).toBeInTheDocument();
    expect(screen.getAllByRole("spinbutton")[0]).toHaveValue(1);
  });

  it("does not show a missing-rate warning before a billing target is selected", () => {
    renderModal();

    expect(
      screen.queryByText(/No billing rate found for this member/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Choose a billing target and team member to preview the amount."),
    ).toBeInTheDocument();
  });

  describe("target picker", () => {
    it("does not load any matters or clients until the picker is opened", () => {
      renderModal();

      expect(mockLookupMatters).not.toHaveBeenCalled();
      expect(mockLookupClients).not.toHaveBeenCalled();
    });

    it("searches matters from the server when the picker opens", async () => {
      mockLookupMatters.mockResolvedValue({
        items: [{ id: "matter-1", label: "Smith v. Jones" }],
        hasMore: false,
      });

      renderModal();
      await userEvent.click(screen.getByRole("button", { name: /Select a matter/ }));

      await waitFor(() => expect(mockLookupMatters).toHaveBeenCalled());
      expect(await screen.findByText("Smith v. Jones")).toBeInTheDocument();
      expect(mockLookupClients).not.toHaveBeenCalled();
    });

    it("switches the picker to the clients lookup when Bill To is set to Client", async () => {
      mockLookupClients.mockResolvedValue({
        items: [{ id: "client-1", label: "Jane Doe" }],
        hasMore: false,
      });

      renderModal();
      await userEvent.click(screen.getByRole("button", { name: /^Matter/ }));
      await userEvent.click(await screen.findByRole("option", { name: "Client" }));

      await userEvent.click(screen.getByRole("button", { name: /Select a client/ }));

      await waitFor(() => expect(mockLookupClients).toHaveBeenCalled());
      expect(await screen.findByText("Jane Doe")).toBeInTheDocument();
    });

    // A picker that cannot label what is already selected sends the user back to
    // the grid to remember which matter the entry was for.
    it("labels a target supplied by defaultTarget without opening the menu", async () => {
      mockLookupMatters.mockResolvedValue({
        items: [{ id: "matter-1", label: "Smith v. Jones", members: [] }],
        hasMore: false,
      });

      renderModal({ defaultTarget: "matter:matter-1" });

      expect(await screen.findByText("Smith v. Jones")).toBeInTheDocument();
      expect(mockLookupMatters).toHaveBeenCalledWith(
        "test-law-firm-id",
        expect.objectContaining({ ids: ["matter-1"], full: true }),
      );
    });

    // The matter's own members are the only people an entry can be billed under,
    // and they ride along on the enriched lookup row.
    it("offers the selected matter's members as team members", async () => {
      mockLookupMatters.mockResolvedValue({
        items: [
          {
            id: "matter-1",
            label: "Smith v. Jones",
            members: [{ userId: "user-1", name: "Alice Smith" }],
          },
        ],
        hasMore: false,
      });

      renderModal({ defaultTarget: "matter:matter-1" });

      await screen.findByText("Smith v. Jones");
      await userEvent.click(screen.getByRole("button", { name: /Alice Smith/ }));
      expect(await screen.findByRole("option", { name: "Alice Smith" })).toBeInTheDocument();
    });
  });

  describe("team member choices", () => {
    const matterWithTwoMembers = {
      items: [
        {
          id: "matter-1",
          label: "Smith v. Jones",
          members: [
            { userId: "test-uid", name: "Test User" },
            { userId: "user-2", name: "Bob Jones" },
          ],
        },
      ],
      hasMore: false,
    };

    it("offers only the viewer without billing.manageOthersTimeEntries", async () => {
      grantPermissions(["billing.manageTimeEntries"]);
      mockLookupMatters.mockResolvedValue(matterWithTwoMembers);

      renderModal({ defaultTarget: "matter:matter-1", defaultUserId: "test-uid" });

      await screen.findByText("Smith v. Jones");
      await userEvent.click(screen.getByRole("button", { name: /Test User/ }));
      expect(await screen.findByRole("option", { name: "Test User" })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: "Bob Jones" })).not.toBeInTheDocument();
    });

    it("offers every matter member with billing.manageOthersTimeEntries", async () => {
      grantPermissions(["billing.manageTimeEntries", "billing.manageOthersTimeEntries"]);
      mockLookupMatters.mockResolvedValue(matterWithTwoMembers);

      renderModal({ defaultTarget: "matter:matter-1", defaultUserId: "test-uid" });

      await screen.findByText("Smith v. Jones");
      await userEvent.click(screen.getByRole("button", { name: /Test User/ }));
      expect(await screen.findByRole("option", { name: "Bob Jones" })).toBeInTheDocument();
    });
  });

  // Callers clear the entry they were editing in the same handler that closes
  // the modal. The dialog must still read as an edit while it animates out.
  it("stays an edit dialog while it animates closed after the caller clears the entry", () => {
    const entry = {
      id: "te-1",
      matterId: "",
      clientId: "client-1",
      userId: "user-1",
      hours: 1.5,
      date: "2026-03-02",
      name: "Draft letter",
      description: "",
      billable: true,
    };

    const { rerender } = renderModal({ entry });
    expect(screen.getByRole("dialog", { name: "Edit Time Entry" })).toBeInTheDocument();

    rerender(<TimeEntryModal {...defaultProps} {...({ open: false, entry: null } as any)} />);

    const dialog = screen.getByRole("dialog", { name: "Edit Time Entry" });
    expect(dialog).toHaveClass("overlay-card-exit");
    expect(screen.queryByRole("heading", { name: "Log Billable Hours" })).not.toBeInTheDocument();
  });

  describe("bill now", () => {
    // "Bill this now" saves the entry and then opens the invoice composer, which
    // a member without billing.manageInvoices cannot use. Red if the checkbox is
    // rendered without that permission.
    it("offers Bill this now to a member who can manage invoices", () => {
      grantBaselineMember(["billing.manageTimeEntries", "billing.manageInvoices"]);
      renderModal();
      expect(screen.getByRole("checkbox", { name: "Bill this now" })).toBeInTheDocument();
    });

    it("does not offer Bill this now to a member who can only log time", () => {
      grantBaselineMember(["billing.manageTimeEntries"]);
      renderModal();
      // Billable is in the same footer row, so the footer rendered.
      expect(screen.getByRole("checkbox", { name: "Billable" })).toBeInTheDocument();
      expect(screen.queryByRole("checkbox", { name: "Bill this now" })).not.toBeInTheDocument();
    });
  });

  describe("charge code picker", () => {
    // The charge-code list is read with billing.viewRates, so for a member without it the picker
    // could only ever offer "No charge code" and its quick-create would 403. Red if the picker is
    // drawn without that permission.
    it("is hidden from a member who can log time but not view rates", () => {
      grantBaselineMember(["billing.manageTimeEntries"]);
      renderModal();

      // The Assignment section is on screen, so the absence is the permission and not a closed modal.
      expect(screen.getByText("Team Member")).toBeInTheDocument();
      expect(screen.queryByText("Charge Code")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Quick-create a charge code" })).not.toBeInTheDocument();
    });

    it("is offered to a member who can view rates", () => {
      grantBaselineMember(["billing.manageTimeEntries", "billing.viewRates"]);
      renderModal();

      expect(screen.getByText("Charge Code")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Quick-create a charge code" })).toBeInTheDocument();
    });
  });
});
