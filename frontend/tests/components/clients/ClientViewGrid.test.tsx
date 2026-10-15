import React from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "../../support/renderWithProviders";

// The list now reads one SERVER page through `usePagedClients`. Stub the paged
// service so the real hooks run and return a deterministic empty page, rather
// than the generic `{}` proxy from tests/setup.ts.
const mockListClientsPaged = jest.fn().mockResolvedValue({ clients: [], totalItems: 0 });
jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: {
    listClientsPaged: (...args: unknown[]) => mockListClientsPaged(...args),
    createClient: jest.fn(),
    deleteClient: jest.fn(),
    resendClientInvitation: jest.fn(),
  },
}));

import ClientViewGrid from "@/components/clientComp/ClientViewGrid";

const defaultProps = {
  lawFirmId: "test-law-firm-id",
};

describe("ClientViewGrid", () => {

  it("groups the client heading and sort controls with 16px spacing", async () => {
    mockListClientsPaged.mockResolvedValue({
      clients: [{ id: "client-1", name: "Alpha", email: "alpha@example.com" }],
      totalItems: 1,
    });

    renderWithProviders(<ClientViewGrid {...defaultProps} />);
    await screen.findByText("Alpha");

    const heading = screen.getByRole("heading", { name: "Clients (1)" });
    const section = heading.parentElement!;
    expect(section).toHaveClass("space-y-4");
    expect(section).toContainElement(screen.getByRole("button", { name: "Email" }));
    expect(section.parentElement).toHaveClass("space-y-6");
  });

  it("uses list placeholders while clients load", async () => {
    let finish!: (value: { clients: []; totalItems: number }) => void;
    mockListClientsPaged.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));

    renderWithProviders(<ClientViewGrid {...defaultProps} />);

    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.queryByText("No clients yet")).not.toBeInTheDocument();
    await act(async () => { finish({ clients: [], totalItems: 0 }); });
  });

  it("requests the first server page with the default name-ascending sort", async () => {
    mockListClientsPaged.mockClear();
    renderWithProviders(React.createElement(ClientViewGrid, defaultProps));
    await screen.findByPlaceholderText("Search by client name or email...");

    expect(mockListClientsPaged).toHaveBeenCalledWith(
      "test-law-firm-id",
      expect.objectContaining({
        page: 1,
        limit: 10,
        search: "",
        sort: [{ field: "name", sort: "asc" }],
      }),
    );
  });

  it("shows loading on the clicked pagination button while the next page loads", async () => {
    let resolveNextPage!: (value: { clients: Array<{ id: string; name: string }>; totalItems: number }) => void;
    const firstPage = Array.from({ length: 10 }, (_, index) => ({
      id: `client-${index + 1}`,
      name: `Client ${index + 1}`,
    }));

    mockListClientsPaged.mockImplementation(
      (_lawFirmId: string, params: { page?: number }) =>
        params.page === 1
          ? Promise.resolve({ clients: firstPage, totalItems: 11 })
          : new Promise((resolve) => {
              resolveNextPage = resolve;
            }),
    );

    renderWithProviders(React.createElement(ClientViewGrid, defaultProps));
    await screen.findByText("Client 1");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
    // The rows already on screen stay put while the next page loads: the clicked
    // button carries the wait, so paging doesn't blank the list.
    expect(screen.getByText("Client 1")).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
    expect(mockListClientsPaged).toHaveBeenLastCalledWith(
      "test-law-firm-id",
      expect.objectContaining({ page: 2 }),
    );

    await act(async () => {
      resolveNextPage({
        clients: [{ id: "client-11", name: "Client 11" }],
        totalItems: 11,
      });
      await Promise.resolve();
    });
  });

  it("never lets a slow response for the old firm land as the new firm's client list", async () => {
    const FIRM_A = "firm-a";
    const FIRM_B = "firm-b";
    let resolveFirmB!: (value: { clients: Array<{ id: string; name: string }>; totalItems: number }) => void;

    mockListClientsPaged.mockImplementation((lawFirmId: string) =>
      lawFirmId === FIRM_A
        ? Promise.resolve({ clients: [{ id: "client-a", name: "Firm A Client" }], totalItems: 1 })
        : new Promise((resolve) => {
            resolveFirmB = resolve;
          }),
    );

    const { rerender } = renderWithProviders(React.createElement(ClientViewGrid, { lawFirmId: FIRM_A }));
    await screen.findByText("Firm A Client");

    // Firm B's read is still pending (the promise above is never resolved yet)
    // when the viewer switches firms.
    rerender(React.createElement(ClientViewGrid, { lawFirmId: FIRM_B }));

    // Firm A's client must not keep rendering, full-opacity and clickable, as
    // though it belonged to firm B just because `usePagedClients`'s bare
    // `placeholderData: (prev) => prev` hands over the last successful result
    // on ANY query-key change, not just a page/filter change within the same
    // firm - firm B's own clients read is still unresolved.
    expect(screen.queryByText("Firm A Client")).not.toBeInTheDocument();

    await act(async () => {
      resolveFirmB({ clients: [{ id: "client-b", name: "Firm B Client" }], totalItems: 1 });
      await Promise.resolve();
    });

    expect(await screen.findByText("Firm B Client")).toBeInTheDocument();
    expect(screen.queryByText("Firm A Client")).not.toBeInTheDocument();
  });

  it("renders sort options and triggers server query when a sort column is clicked", async () => {
    mockListClientsPaged.mockResolvedValue({
      clients: [{ id: "client-1", name: "Alpha", email: "alpha@example.com" }],
      totalItems: 1,
    });

    renderWithProviders(React.createElement(ClientViewGrid, defaultProps));
    await screen.findByText("Alpha");

    const emailSortBtn = screen.getByRole("button", { name: "Email" });
    expect(emailSortBtn).toBeInTheDocument();
    expect(emailSortBtn).toHaveAttribute("title", "Sort by Email");

    await act(async () => {
      fireEvent.click(emailSortBtn);
    });

    expect(mockListClientsPaged).toHaveBeenLastCalledWith(
      "test-law-firm-id",
      expect.objectContaining({
        page: 1,
        sort: [{ field: "email", sort: "asc" }],
      }),
    );
  });
});
