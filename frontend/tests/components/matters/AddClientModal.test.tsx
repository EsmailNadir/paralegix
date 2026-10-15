import React from "react";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../support/renderWithProviders";

const mockLookupClients = jest.fn();
jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: {
    lookupClients: (...args: any[]) => mockLookupClients(...args),
    inviteClientToLawFirm: jest.fn().mockResolvedValue({}),
  },
}));

import AddClientModal from "@/components/matterComp/AddClientModal";

const baseProps = {
  open: true,
  onClose: jest.fn(),
  lawFirmId: "law-firm-1",
  matterId: "matter-1",
};

// The client search reads through React Query, so every render needs a client.
// A fresh one per render keeps one test's cached lookup out of the next.
function renderModal(props: Record<string, unknown> = {}) {
  return renderWithProviders(React.createElement(AddClientModal, { ...baseProps, ...props } as any));
}

const CLIENT_ROWS = [
  { id: "c1", label: "Alice Smith", email: "alice@example.com" },
  { id: "c2", label: "Bob Doe", email: "bob@example.com" },
];

const SEARCH_PLACEHOLDER = "Search by name or email...";

describe("AddClientModal existing-client search", () => {
  beforeEach(() => {
    mockLookupClients.mockReset();
  });

  it("tells the user the browse list is capped when the lookup has more", async () => {
    mockLookupClients.mockResolvedValue({ items: CLIENT_ROWS, hasMore: true });
    const user = userEvent.setup();

    renderModal();
    await user.click(screen.getByPlaceholderText(SEARCH_PLACEHOLDER));

    expect(await screen.findByText("More results available. Keep typing to narrow.")).toBeInTheDocument();
  });

  it("switches to the truncated-matches wording once a search term is typed", async () => {
    mockLookupClients.mockResolvedValue({ items: CLIENT_ROWS, hasMore: true });
    const user = userEvent.setup();

    renderModal();
    await user.type(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), "smith");

    expect(await screen.findByText("More matches than shown. Keep typing to narrow.")).toBeInTheDocument();
  });

  it("shows no note when the lookup returned the complete list", async () => {
    mockLookupClients.mockResolvedValue({ items: CLIENT_ROWS, hasMore: false });
    const user = userEvent.setup();

    renderModal();
    await user.click(screen.getByPlaceholderText(SEARCH_PLACEHOLDER));

    expect(await screen.findByText("Alice Smith")).toBeInTheDocument();
    expect(screen.queryByText(/Keep typing to narrow/)).not.toBeInTheDocument();
  });

  it("keeps the note visible when every returned client is already on the matter", async () => {
    mockLookupClients.mockResolvedValue({ items: CLIENT_ROWS, hasMore: true });
    const user = userEvent.setup();

    renderModal({ existingMatterClientIds: ["c1", "c2"] });
    await user.click(screen.getByPlaceholderText(SEARCH_PLACEHOLDER));

    // Nothing was typed, so the empty state is the browse-list wording rather
    // than the no-search-match one.
    expect(await screen.findByText(/No clients left to add to this/)).toBeInTheDocument();
    expect(screen.getByText("More results available. Keep typing to narrow.")).toBeInTheDocument();
  });

  it("drops the note when a later load fails", async () => {
    mockLookupClients.mockResolvedValueOnce({ items: CLIENT_ROWS, hasMore: true });
    const user = userEvent.setup();

    renderModal();
    await user.click(screen.getByPlaceholderText(SEARCH_PLACEHOLDER));
    expect(await screen.findByText("More results available. Keep typing to narrow.")).toBeInTheDocument();

    mockLookupClients.mockRejectedValue(new Error("network down"));
    await user.type(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), "zzz");

    expect(await screen.findByText(/No matching clients found/)).toBeInTheDocument();
    expect(screen.queryByText(/Keep typing to narrow/)).not.toBeInTheDocument();
  });
});
