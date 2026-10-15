import React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";

const mockLookupMatters = jest.fn();
const mockLookupClients = jest.fn();
const mockLookupTasks = jest.fn();

jest.mock("@/services/matters.service", () => ({
  __esModule: true,
  default: { lookupMatters: (...args: any[]) => mockLookupMatters(...args) },
}));
jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: { lookupClients: (...args: any[]) => mockLookupClients(...args) },
}));
jest.mock("@/services/tasks.service", () => ({
  __esModule: true,
  default: { lookupTasks: (...args: any[]) => mockLookupTasks(...args) },
}));

import DestinationPickerModal from "@/components/signaturesComp/DestinationPickerModal";
import { scanAccessibility } from "../../support/accessibility";

const baseProps = {
  isOpen: true,
  onClose: jest.fn(),
  onSelect: jest.fn(),
  lawFirmId: "law-firm-1",
  currentPath: "",
};

const MATTER_ROWS = [
  { id: "m1", label: "Smith v. Jones" },
  { id: "m2", label: "Estate of Doe" },
];

describe("DestinationPickerModal source list", () => {
  beforeEach(() => {
    mockLookupMatters.mockReset();
    mockLookupClients.mockReset();
    mockLookupTasks.mockReset();
    mockLookupClients.mockResolvedValue({ items: [], hasMore: false });
    mockLookupTasks.mockResolvedValue({ items: [], hasMore: false });
  });

  it("notes that the matter list is capped when the lookup has more", async () => {
    mockLookupMatters.mockResolvedValue({ items: MATTER_ROWS, hasMore: true });
    const user = userEvent.setup();

    render(React.createElement(DestinationPickerModal, { ...baseProps }));
    await user.click(screen.getByText("Matter Files"));

    expect(await screen.findByText("More results available. Keep typing to narrow.")).toBeInTheDocument();
  });

  it("shows no note when the lookup returned the complete list", async () => {
    mockLookupMatters.mockResolvedValue({ items: MATTER_ROWS, hasMore: false });
    const user = userEvent.setup();

    render(React.createElement(DestinationPickerModal, { ...baseProps }));
    await user.click(screen.getByText("Matter Files"));

    expect(await screen.findByText("Smith v. Jones")).toBeInTheDocument();
    expect(screen.queryByText(/Keep typing to narrow/)).not.toBeInTheDocument();
  });

  it("clears the note when going back to the category menu", async () => {
    mockLookupMatters.mockResolvedValue({ items: MATTER_ROWS, hasMore: true });
    const user = userEvent.setup();

    render(React.createElement(DestinationPickerModal, { ...baseProps }));
    await user.click(screen.getByText("Matter Files"));
    expect(await screen.findByText("More results available. Keep typing to narrow.")).toBeInTheDocument();

    await user.click(screen.getByText("Back"));
    await user.click(screen.getByText("Client Files"));

    expect(await screen.findByText("No clients found")).toBeInTheDocument();
    expect(screen.queryByText(/Keep typing to narrow/)).not.toBeInTheDocument();
  });

  it("keeps the search box when a query matches nothing, so the query can be corrected", async () => {
    mockLookupMatters.mockImplementation(async (_firmId: string, opts: { search?: string }) =>
      opts.search ? { items: [], hasMore: false } : { items: MATTER_ROWS, hasMore: false }
    );
    const user = userEvent.setup();

    render(React.createElement(DestinationPickerModal, { ...baseProps }));
    await user.click(screen.getByText("Matter Files"));
    await screen.findByText("Smith v. Jones");

    await user.type(screen.getByPlaceholderText("Search matters..."), "zzz");
    await waitFor(() =>
      expect(mockLookupMatters).toHaveBeenLastCalledWith("law-firm-1", { search: "zzz", limit: 50 })
    );
    expect(await screen.findByText("No matching matters found")).toBeInTheDocument();

    const search = screen.getByPlaceholderText("Search matters...");
    expect(search).toHaveValue("zzz");
    await user.clear(search);
    expect(await screen.findByText("Smith v. Jones")).toBeInTheDocument();
  });

  it("keeps focus in the search box while a search is loading", async () => {
    let resolveSearch: (value: { items: typeof MATTER_ROWS; hasMore: boolean }) => void = () => {};
    mockLookupMatters.mockImplementation((_firmId: string, opts: { search?: string }) =>
      opts.search
        ? new Promise((resolve) => { resolveSearch = resolve; })
        : Promise.resolve({ items: MATTER_ROWS, hasMore: false })
    );
    const user = userEvent.setup();

    render(React.createElement(DestinationPickerModal, { ...baseProps }));
    await user.click(screen.getByText("Matter Files"));
    await screen.findByText("Smith v. Jones");

    await user.type(screen.getByPlaceholderText("Search matters..."), "Sm");
    await waitFor(() => expect(mockLookupMatters).toHaveBeenCalledTimes(2));

    const search = screen.getByPlaceholderText("Search matters...");
    expect(search).toHaveFocus();
    await user.type(search, "i");
    expect(search).toHaveValue("Smi");

    resolveSearch({ items: [MATTER_ROWS[0]], hasMore: false });
  });

  it("drops the note when the load fails", async () => {
    mockLookupMatters.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();

    render(React.createElement(DestinationPickerModal, { ...baseProps }));
    await user.click(screen.getByText("Matter Files"));

    expect(await screen.findByText("Failed to load items")).toBeInTheDocument();
    expect(screen.queryByText(/Keep typing to narrow/)).not.toBeInTheDocument();
  });
});

describe("DestinationPickerModal accessibility", () => {
  beforeEach(() => {
    mockLookupMatters.mockReset();
    mockLookupMatters.mockResolvedValue({ items: MATTER_ROWS, hasMore: false });
  });

  it("has no axe violations on the category menu or inside a category", async () => {
    const user = userEvent.setup();
    // The picker portals to the body, so the scan covers the body rather than
    // the render container.
    render(React.createElement(DestinationPickerModal, { ...baseProps }));
    expect((await scanAccessibility(document.body)).violations).toEqual([]);

    await user.click(screen.getByText("Matter Files"));
    await screen.findByText("Smith v. Jones");
    expect((await scanAccessibility(document.body)).violations).toEqual([]);
  });
});

describe("DestinationPickerModal stacking", () => {
  it("renders above the signing dialog it is opened from, portaled out of its host", () => {
    const { container } = render(React.createElement(DestinationPickerModal, { ...baseProps }));
    const dialog = screen.getByRole("dialog", { name: "Choose Destination" });

    expect(container).not.toContainElement(dialog);
    expect(dialog.closest(".fixed")).toHaveClass("z-[60]");
  });
});
