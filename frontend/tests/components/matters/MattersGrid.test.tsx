import { expectCompactListSection } from "../../support/listSectionSpacing";
import React from "react";
import { act, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../support/renderWithProviders";
import { holdResponse } from "../../support/deferred";

const mockGetMattersPaged = jest.fn();
const mockListMatterIds = jest.fn();
const mockBulkUpdateStatus = jest.fn();
const mockBulkUpdatePracticeArea = jest.fn();

jest.mock("@/services/matters.service", () => ({
  __esModule: true,
  default: {
    getMattersPaged: (...args: unknown[]) => mockGetMattersPaged(...args),
    listMatterIds: (...args: unknown[]) => mockListMatterIds(...args),
    bulkUpdateStatus: (...args: unknown[]) => mockBulkUpdateStatus(...args),
    bulkUpdatePracticeArea: (...args: unknown[]) => mockBulkUpdatePracticeArea(...args),
    getMatters: jest.fn().mockResolvedValue([]),
    lookupMatters: jest.fn().mockResolvedValue({ items: [], hasMore: false }),
  },
}));

// Mock hooks used by MattersGrid. The list reads a server page through
// `usePagedMatters`, which is stubbed here.
let mockMattersError: string | null = null;

const defaultPagedMatters = () => ({
  matters: [],
  total: 0,
  loading: false,
  error: mockMattersError,
  refresh: jest.fn(),
});
const mockUsePagedMatters = jest.fn(defaultPagedMatters);

jest.mock("@/hooks/matterHooks/useMatters", () => ({
  __esModule: true,
  // `matterListFilterParams` / `PAYMENT_ONGOING_FILTER` are plain helpers, not
  // hooks, and the CSV export calls the former to build its request. Keep the
  // real implementations; only the data hooks are stubbed.
  ...jest.requireActual("@/hooks/matterHooks/useMatters"),
  usePagedMatters: (...args: unknown[]) => mockUsePagedMatters(...(args as [])),
}));

jest.mock("@/hooks/practiceHooks/usePracticeAreas", () => ({
  __esModule: true,
  default: () => ({
    practiceAreas: [],
    loading: false,
    error: null,
  }),
}));

jest.mock("@/hooks/useUsers", () => ({
  useLawFirmUsers: () => ({
    users: [],
    loading: false,
    error: null,
  }),
}));

jest.mock("@/utils/csvExport", () => ({
  exportToCSV: jest.fn(),
}));

// Mock the custom UI components
jest.mock("@/components/ui/CategoryFilterDropdown", () => ({
  __esModule: true,
  default: () => React.createElement("select", { "data-testid": "category-filter" }),
}));

import MattersGrid from "@/components/matterComp/MattersGrid";

describe("MattersGrid", () => {
  beforeEach(() => {
    mockMattersError = null;
    mockUsePagedMatters.mockImplementation(defaultPagedMatters);
  });

  it("groups the matters heading and sort controls with 16px spacing", () => {
    mockUsePagedMatters.mockReturnValue({
      ...defaultPagedMatters(),
      matters: [{ id: 'matter-1', name: 'Current matter', status: 'active', leadUserIds: [], members: [] }],
      total: 1,
    } as any);
    renderWithProviders(<MattersGrid lawFirmId="test-law-firm-id" />);
    expect(screen.getByText('Current matter')).toBeInTheDocument();
    expectCompactListSection('Matters (1)', 'Name');
  });

  it('renders the current lead set instead of a stale primary lead label', () => {
    mockUsePagedMatters.mockReturnValue({
      ...defaultPagedMatters(),
      matters: [{ id: 'current-matter', name: 'Current matter', status: 'active',
        leadUserIds: [], leadUserName: 'Former Attorney', members: [] }],
      total: 1,
    } as any);
    renderWithProviders(<MattersGrid lawFirmId="test-law-firm-id" />);
    expect(screen.getByText('Current matter')).toBeInTheDocument();
    expect(screen.queryByText(/Former Attorney/)).not.toBeInTheDocument();
  });

  it("uses list placeholders while matters load", () => {
    mockUsePagedMatters.mockImplementation(() => ({
      matters: [], total: 0, loading: true, error: null, refresh: jest.fn(),
    }));

    renderWithProviders(<MattersGrid lawFirmId="test-law-firm-id" />);

    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.queryByText("No matters found")).not.toBeInTheDocument();
  });

  // The error banner mixes React Query state (which cannot be reset from here)
  // with a locally-set message. Dismissing it used to clear only the local one,
  // so a transient load failure pinned a banner to the page for the whole
  // session.
  describe("error banner", () => {
    it("dismisses a load error", async () => {
      mockMattersError = "Failed to load matters";
      renderWithProviders(React.createElement(MattersGrid, { lawFirmId: "test-law-firm-id" }));

      expect(screen.getByText("Failed to load matters")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.queryByText("Failed to load matters")).not.toBeInTheDocument();
    });

    it("still shows a different load error after one has been dismissed", async () => {
      mockMattersError = "Failed to load matters";
      // A fresh element each time: React skips re-rendering a subtree handed the
      // referentially identical element it already holds.
      const tree = () => React.createElement(MattersGrid, { lawFirmId: "test-law-firm-id" });
      const { rerender } = renderWithProviders(tree());

      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.queryByText("Failed to load matters")).not.toBeInTheDocument();

      mockMattersError = "Network request failed";
      rerender(tree());

      expect(screen.getByText("Network request failed")).toBeInTheDocument();
    });
  });

  it("requests the first server page with the default name-ascending sort", () => {
    mockUsePagedMatters.mockClear();
    renderWithProviders(React.createElement(MattersGrid, { lawFirmId: "test-law-firm-id" }));

    const [lawFirmId, params, enabled] = mockUsePagedMatters.mock.calls[0] as unknown as [
      string,
      { page: number; limit: number; sort: unknown; search: string; filters: Record<string, string> },
      boolean,
    ];
    expect(lawFirmId).toBe("test-law-firm-id");
    expect(params.page).toBe(1);
    expect(params.sort).toEqual([{ field: "name", sort: "asc" }]);
    expect(params.search).toBe("");
    // The list view is the default, so the paged query is the one that runs.
    expect(enabled).toBe(true);
  });
});

describe("MattersGrid CSV export", () => {
  beforeEach(() => {
    mockGetMattersPaged.mockReset();
  });

  it("says so when the page cap cuts the export short", async () => {
    // Always a full window with far more still to come, so the loop runs every
    // one of its 40 pages and still has rows left over.
    mockGetMattersPaged.mockImplementation(() =>
      Promise.resolve({
        matters: Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, name: `Matter ${i}` })),
        totalItems: 100000,
      })
    );

    renderWithProviders(React.createElement(MattersGrid, { lawFirmId: "test-law-firm-id" }));
    fireEvent.click(screen.getByText("Export CSV"));

    expect(
      await screen.findByText(
        "Export stopped at the first 20000 matters. Narrow the filters or search to export the rest.",
        undefined,
        // 40 sequential request windows before the notice can appear.
        { timeout: 10000 }
      )
    ).toBeInTheDocument();
  });

  it("stays quiet when the whole filtered set fits", async () => {
    mockGetMattersPaged.mockResolvedValue({
      matters: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, name: `Matter ${i}` })),
      totalItems: 12,
    });

    renderWithProviders(React.createElement(MattersGrid, { lawFirmId: "test-law-firm-id" }));
    fireEvent.click(screen.getByText("Export CSV"));

    // The button returns from its disabled state once the export settles.
    await screen.findByText("Export CSV");
    expect(screen.queryByText(/Export stopped at the first/)).not.toBeInTheDocument();
  });
});

describe("MattersGrid bulk changes", () => {
  beforeEach(() => {
    mockMattersError = null;
    mockListMatterIds.mockReset();
    mockBulkUpdateStatus.mockReset();
    mockBulkUpdatePracticeArea.mockReset();
    mockListMatterIds.mockResolvedValue({ ids: ["m1", "m2"], truncated: false, limit: 5000 });
    mockUsePagedMatters.mockImplementation(() => ({
      matters: [
        { id: "m1", name: "Acme v. Roe", status: "active" },
        { id: "m2", name: "Doe estate", status: "active" },
      ] as never[],
      total: 2,
      loading: false,
      error: null,
      refresh: jest.fn(),
    }));
  });

  async function openBulkDialog(item: string) {
    renderWithProviders(<MattersGrid lawFirmId="test-law-firm-id" />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Select all 2" }));
    const menus = await screen.findAllByRole("button", { name: /2 selected/ }, { timeout: 5000 });
    await userEvent.click(menus[0]);
    await userEvent.click(await screen.findByRole("button", { name: item }));
    return screen.findByRole("dialog", { name: item });
  }

  // The bulk status route answers 200 with the rows it refused (a matter the
  // user cannot write, a legal hold). Reading only the call's success closed the
  // dialog as if every matter had changed.
  it("reports the matters a bulk status change refused", async () => {
    mockBulkUpdateStatus.mockResolvedValue({
      requested: 2, updated: 1, failed: ["m2"], errors: { m2: "You do not have write access to this matter" },
    });
    const dialog = await openBulkDialog("Change Status");

    await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(await screen.findByText(/1 of 2 matters updated\. 1 could not be updated: You do not have write access to this matter/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Change Status" })).not.toBeInTheDocument());
  });

  it("shows the error and closes the dialog when a bulk status change is refused outright", async () => {
    mockBulkUpdateStatus.mockRejectedValue(new Error("Permission denied"));
    const dialog = await openBulkDialog("Change Status");

    await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

    // Before the catch existed the rejection escaped the handler: no message, and
    // the dialog stayed open over a spinner that never cleared.
    expect(await screen.findByText("Permission denied")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Change Status" })).not.toBeInTheDocument());
  });

  it("reports the matters a bulk practice area change refused", async () => {
    mockBulkUpdatePracticeArea.mockResolvedValue({
      requested: 2, updated: 0, failed: ["m1", "m2"], errors: {},
    });
    const dialog = await openBulkDialog("Change Practice Area");

    await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(await screen.findByText("0 of 2 matters updated. 2 could not be updated.")).toBeInTheDocument();
  });

  it("shows the error when a bulk practice area change is refused outright", async () => {
    mockBulkUpdatePracticeArea.mockRejectedValue(new Error("Invalid practiceAreaId for this law firm"));
    const dialog = await openBulkDialog("Change Practice Area");

    await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(await screen.findByText("Invalid practiceAreaId for this law firm")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Change Practice Area" })).not.toBeInTheDocument());
  });
  // The grid owns each dialog's open flag, so a close shows as the dialog
  // unmounting once its 100ms exit animation finishes. Each spec waits past it.
  const pastExitAnimation = () =>
    act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });

  // Red if: the Change Status dialog stays dismissible while the bulk update
  // runs (no `dismissible={!busy}`) or its Cancel stays enabled, so Escape
  // closes it mid-save and the selection can change under a running request.
  it("keeps the status dialog open until the bulk status change settles", async () => {
    const held = holdResponse();
    mockBulkUpdateStatus.mockImplementation(held.handler);
    const dialog = await openBulkDialog("Change Status");

    await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await held.untilRequested();
    fireEvent.keyDown(document, { key: "Escape" });
    await pastExitAnimation();
    expect(screen.getByRole("dialog", { name: "Change Status" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();

    await act(async () => held.release({ requested: 2, updated: 2, failed: [], errors: {} }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Change Status" })).not.toBeInTheDocument());
  });

  // Red if: the Change Practice Area dialog stays dismissible while the bulk
  // update runs (no `dismissible={!busy}`) or its Cancel stays enabled.
  it("keeps the practice area dialog open until the bulk change settles", async () => {
    const held = holdResponse();
    mockBulkUpdatePracticeArea.mockImplementation(held.handler);
    const dialog = await openBulkDialog("Change Practice Area");

    await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await held.untilRequested();
    fireEvent.keyDown(document, { key: "Escape" });
    await pastExitAnimation();
    expect(screen.getByRole("dialog", { name: "Change Practice Area" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();

    await act(async () => held.release({ requested: 2, updated: 2, failed: [], errors: {} }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Change Practice Area" })).not.toBeInTheDocument());
  });
});

describe("MattersGrid header", () => {
  it('labels the create action "New Matter"', () => {
    mockMattersError = null;
    mockUsePagedMatters.mockImplementation(defaultPagedMatters);
    renderWithProviders(<MattersGrid lawFirmId="test-law-firm-id" />);

    expect(screen.getByRole("button", { name: "New Matter" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create New Matter" })).not.toBeInTheDocument();
  });
});
