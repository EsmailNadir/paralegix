import { expectCompactListSection } from "../../support/listSectionSpacing";
import React from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../support/renderWithProviders";

// Rows the mocked tasks hook hands back. Mutable so a single test can populate
// the grid without changing what the others render.
let mockTaskRows: any[] = [];

// The grid's load error, as React Query would surface it. Mutable so a test can
// drive the banner without reaching into the component.
let mockTasksError: string | null = null;

// Size of the full filtered set the server reports. Mutable so a test can put
// more tasks behind the filters than the page on screen holds.
let mockTaskTotal: number | null = null;

// What the bulk hook reports. Mutable so a test can make a bulk request resolve
// with a result, resolve with nothing (the whole request was refused), or carry
// a message about rows the server refused.
const mockBulk = {
  busy: false,
  error: null as string | null,
  setError: jest.fn(),
  bulkStatus: jest.fn(),
  bulkMatter: jest.fn(),
  bulkDelete: jest.fn(),
};

// Ids the "select all" read returns: every task matching the current filters.
const mockListTaskIds = jest.fn();

// Whether the create-task modal is open, as the create hook reports it, and the
// arguments the courts and charge-code hooks were last called with.
let mockCreateOpen = false;
const mockUseCourts = jest.fn<{ courts: never[] }, unknown[]>(() => ({ courts: [] }));
const mockUseChargeCodes = jest.fn<{ chargeCodes: never[] }, unknown[]>(() => ({ chargeCodes: [] }));

// Mock hooks used by TasksGrid
jest.mock("@/hooks/useUsers", () => ({
  useLawFirmUsers: () => ({
    users: [],
    loading: false,
    error: null,
    setError: jest.fn(),
  }),
}));

jest.mock("@/hooks/taskHooks/useTasks", () => ({
  useLawfirmTasks: () => ({
    tasks: mockTaskRows,
    total: mockTaskTotal ?? mockTaskRows.length,
    loading: false,
    error: mockTasksError,
    refresh: jest.fn(),
    setError: jest.fn(),
  }),
  useCreateTask: () => ({
    open: mockCreateOpen,
    title: "",
    setTitle: jest.fn(),
    description: "",
    setDescription: jest.fn(),
    location: "",
    setLocation: jest.fn(),
    dueDate: null,
    setDueDate: jest.fn(),
    assignedTo: [],
    setAssignedTo: jest.fn(),
    matterId: "",
    setMatterId: jest.fn(),
    courtId: "",
    setCourtId: jest.fn(),
    clientIds: [],
    setClientIds: jest.fn(),
    reminderRecipientIds: [],
    setReminderRecipientIds: jest.fn(),
    status: "open",
    setStatus: jest.fn(),
    submitting: false,
    submit: jest.fn(),
    reset: jest.fn(),
  }),
  useEditTask: () => ({
    open: false,
    task: null,
    title: "",
    setTitle: jest.fn(),
    description: "",
    setDescription: jest.fn(),
    location: "",
    setLocation: jest.fn(),
    dueDate: null,
    setDueDate: jest.fn(),
    assignedTo: [],
    setAssignedTo: jest.fn(),
    matterId: "",
    setMatterId: jest.fn(),
    courtId: "",
    setCourtId: jest.fn(),
    clientIds: [],
    setClientIds: jest.fn(),
    reminderRecipientIds: [],
    setReminderRecipientIds: jest.fn(),
    status: "open",
    setStatus: jest.fn(),
    submitting: false,
    save: jest.fn(),
    reset: jest.fn(),
    loadTask: jest.fn(),
  }),
  useBulkTasks: () => mockBulk,
}));

jest.mock("@/hooks/courtHooks/useCourts", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseCourts(...args),
}));

jest.mock("@/hooks/chargeCodeHooks/useChargeCodes", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseChargeCodes(...args),
}));

jest.mock("@/contexts/BillingTimerContext", () => ({
  useBillingTimer: () => ({
    running: false,
    start: jest.fn(),
    stop: jest.fn(),
    elapsed: 0,
    context: null,
  }),
}));

jest.mock("@/utils/csvExport", () => ({
  exportToCSV: jest.fn(),
}));

jest.mock("@/services/tasks.service", () => ({
  __esModule: true,
  default: {
    listTaskIds: (...args: any[]) => mockListTaskIds(...args),
    listLawFirmTasksPaged: jest.fn().mockResolvedValue({ tasks: [], totalTasks: 0 }),
  },
}));

jest.mock("@/components/billingComp/TimeEntryModal", () => ({
  __esModule: true,
  default: () => null,
}));

import TasksGrid from "@/components/taskComp/TasksGrid";

function renderGrid() {
  return renderWithProviders(<TasksGrid lawFirmId="test-law-firm-id" />);
}

describe("TasksGrid", () => {
  beforeEach(() => {
    mockTaskRows = [];
    mockTasksError = null;
    mockTaskTotal = null;
    mockCreateOpen = false;
    mockUseCourts.mockClear();
    mockUseChargeCodes.mockClear();
    mockListTaskIds.mockReset();
    mockBulk.busy = false;
    mockBulk.error = null;
    mockBulk.setError.mockReset();
    mockBulk.bulkStatus.mockReset();
    mockBulk.bulkMatter.mockReset();
    mockBulk.bulkDelete.mockReset();
  });

  // Courts and charge codes feed only the create/edit and time-entry modals, so
  // a plain visit to the grid must not load them.
  it("groups the tasks heading and sort controls with 16px spacing", () => {
    mockTaskRows = [{ id: "t1", taskId: "t1", title: "Draft motion", status: "open" }];
    renderGrid();
    expect(screen.getByText("Draft motion")).toBeInTheDocument();
    expectCompactListSection('Tasks (1)', 'Title');
  });

  describe("modal picker data", () => {
    it("holds courts and charge codes back while every modal is closed", () => {
      renderGrid();

      expect(mockUseCourts).toHaveBeenCalled();
      expect(mockUseCourts.mock.calls.every((call) => call[1] === false)).toBe(true);
      expect(mockUseChargeCodes).toHaveBeenCalled();
      expect(mockUseChargeCodes.mock.calls.every((call) => call[2] === false)).toBe(true);
    });

    it("loads courts once the create-task modal is open", () => {
      mockCreateOpen = true;
      renderGrid();

      expect(mockUseCourts).toHaveBeenLastCalledWith("test-law-firm-id", true);
    });
  });

  // The error banner mixes React Query state (which cannot be reset from here)
  // with a locally-set message. Dismissing it used to be a no-op, so a transient
  // load failure pinned a banner to the top of the page for the whole session.
  describe("error banner", () => {
    it("dismisses a load error", async () => {
      mockTasksError = "Failed to load tasks";
      renderGrid();

      expect(screen.getByText("Failed to load tasks")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.queryByText("Failed to load tasks")).not.toBeInTheDocument();
    });

    it("still shows a different load error after one has been dismissed", async () => {
      mockTasksError = "Failed to load tasks";
      const { rerender } = renderGrid();

      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.queryByText("Failed to load tasks")).not.toBeInTheDocument();

      mockTasksError = "Network request failed";
      rerender(<TasksGrid lawFirmId="test-law-firm-id" />);

      expect(screen.getByText("Network request failed")).toBeInTheDocument();
    });
  });

  // The tasks page is list-only. The Kanban board and its Grid/Kanban toggle
  // were removed, so a toggle coming back would offer a view that no longer
  // exists.
  it("renders the task list with no view toggle", () => {
    mockTaskRows = [{ id: "t1", taskId: "t1", title: "Draft motion", status: "open" }];
    renderGrid();

    // The list rendered, so the absence below is not a page that never drew.
    expect(screen.getAllByText("Draft motion").length).toBeGreaterThan(0);
    expect(screen.queryByRole("group", { name: "View mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Kanban" })).toBeNull();
  });

  // The control selects everything the current filters match, across every page,
  // so a bulk action covers the filtered set rather than the rows on screen.
  describe("select all", () => {
    beforeEach(() => {
      mockTaskRows = [
        { id: "t1", taskId: "t1", title: "Draft motion", status: "open" },
        { id: "t2", taskId: "t2", title: "File brief", status: "open" },
      ];
      // Two rows on screen, five behind the filters.
      mockTaskTotal = 5;
      mockListTaskIds.mockResolvedValue({
        ids: ["t1", "t2", "t3", "t4", "t5"],
        truncated: false,
        limit: 5000,
      });
    });

    it("names the whole matching set, not the visible page", () => {
      renderGrid();
      expect(screen.getByText("Select all 5")).toBeInTheDocument();
    });

    // ListView renders its `trailing` slot twice, once in the mobile control
    // strip and once in the desktop one, each hidden at the other breakpoint.
    // jsdom applies no CSS, so both copies sit in the tree and the bulk actions
    // menu has to be counted rather than matched as a single node.
    const bulkActionsMenus = () => screen.queryAllByRole("button", { name: /5 selected/ });

    it("selects every matching task and reveals the bulk actions menu", async () => {
      renderGrid();

      expect(bulkActionsMenus()).toHaveLength(0);

      await userEvent.click(screen.getByRole("checkbox", { name: "Select all 5" }));

      // The bulk actions menu counts the whole matching set, not the two rows shown.
      // Select-all resolves an async id fetch before the count appears, so this
      // waits past the default one second: under parallel jest workers the
      // default budget is tight enough to fail on machine load alone.
      await waitFor(() => expect(bulkActionsMenus().length).toBeGreaterThan(0), { timeout: 5000 });
      expect(mockListTaskIds).toHaveBeenCalledTimes(1);
    });

    it("clears the selection when the control is toggled off", async () => {
      renderGrid();

      await userEvent.click(screen.getByRole("checkbox", { name: "Select all 5" }));
      await waitFor(() => expect(bulkActionsMenus().length).toBeGreaterThan(0), { timeout: 5000 });

      await userEvent.click(screen.getByRole("checkbox", { name: "5 selected" }));
      expect(bulkActionsMenus()).toHaveLength(0);
    });
  });

  describe("bulk action feedback", () => {
    beforeEach(() => {
      mockTaskRows = [
        { id: "t1", taskId: "t1", title: "Draft motion", status: "open" },
        { id: "t2", taskId: "t2", title: "File brief", status: "open" },
      ];
      mockTaskTotal = 2;
      mockListTaskIds.mockResolvedValue({ ids: ["t1", "t2"], truncated: false, limit: 5000 });
    });

    async function selectAllAndOpenChangeStatus() {
      renderGrid();
      await userEvent.click(screen.getByRole("checkbox", { name: "Select all 2" }));
      const menus = await screen.findAllByRole("button", { name: /2 selected/ }, { timeout: 5000 });
      await userEvent.click(menus[0]);
      await userEvent.click(await screen.findByRole("button", { name: "Change Status" }));
      return screen.findByRole("dialog", { name: "Change Status" });
    }

    // The hook parks a refusal in `error` and the grid never drew it, so a
    // partly refused bulk change looked like a complete one.
    it("shows what the server refused and lets the user dismiss it", async () => {
      mockBulk.error = "1 of 2 tasks updated. 1 could not be updated: Task is under legal hold";
      renderGrid();

      expect(screen.getByText(/1 could not be updated: Task is under legal hold/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(mockBulk.setError).toHaveBeenCalledWith(null);
    });

    it("closes the dialog and keeps the selection when the whole request was refused", async () => {
      mockBulk.bulkStatus.mockResolvedValue(null);
      const dialog = await selectAllAndOpenChangeStatus();

      await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Change Status" })).not.toBeInTheDocument());
      expect(mockBulk.bulkStatus).toHaveBeenCalledWith(["t1", "t2"], "open");
      // The selection survives, so the user can retry the same set.
      expect(screen.getAllByRole("button", { name: /2 selected/ }).length).toBeGreaterThan(0);
    });

    it("clears the selection once the request went through", async () => {
      mockBulk.bulkStatus.mockResolvedValue({ requested: 2, updated: 2, failed: [], errors: {} });
      const dialog = await selectAllAndOpenChangeStatus();

      await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

      await waitFor(() => expect(screen.queryByRole("button", { name: /2 selected/ })).not.toBeInTheDocument());
    });
  });

  it("labels the create action \"New Task\"", () => {
    renderGrid();

    expect(screen.getByRole("button", { name: "New Task" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create New Task" })).not.toBeInTheDocument();
  });

});
