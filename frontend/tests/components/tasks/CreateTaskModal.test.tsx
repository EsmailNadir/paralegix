import React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../../support/renderWithProviders";

const mockLookupMatters = jest.fn();
const mockLookupClients = jest.fn();
const mockLookupTasks = jest.fn();

jest.mock("@/services/matters.service", () => ({
  __esModule: true,
  default: {
    lookupMatters: (...args: unknown[]) => mockLookupMatters(...args),
  },
}));

// The client and dependency pickers are server-backed typeaheads, so the modal
// reaches the clients and tasks lookups as soon as it renders.
jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: {
    lookupClients: (...args: unknown[]) => mockLookupClients(...args),
  },
}));

jest.mock("@/services/tasks.service", () => ({
  __esModule: true,
  default: {
    lookupTasks: (...args: unknown[]) => mockLookupTasks(...args),
  },
}));

import CreateTaskModal from "@/components/taskComp/CreateTaskModal";

const mockUsers = [
  { id: "user-1", name: "Alice Smith", email: "alice@example.com" },
  { id: "user-2", name: "Bob Jones", email: "bob@example.com" },
];

const setCourtId = jest.fn();

const defaultProps = {
  open: true,
  onClose: jest.fn(),
  lawFirmId: "test-law-firm-id",
  users: mockUsers,
  courts: [],
  create: {
    title: "",
    setTitle: jest.fn(),
    description: "",
    setDescription: jest.fn(),
    location: "",
    setLocation: jest.fn(),
    dueDate: null,
    setDueDate: jest.fn(),
    endsAt: "",
    setEndsAt: jest.fn(),
    allDay: false,
    setAllDay: jest.fn(),
    assignedTo: [] as string[],
    setAssignedTo: jest.fn(),
    matterId: "",
    setMatterId: jest.fn(),
    courtId: "",
    setCourtId,
    clientIds: [] as string[],
    setClientIds: jest.fn(),
    reminderRecipientIds: [] as string[],
    setReminderRecipientIds: jest.fn(),
    status: "open" as const,
    setStatus: jest.fn(),
    priority: "medium" as const,
    setPriority: jest.fn(),
    // Recurrence is off for every case here, but the modal's contract requires
    // the whole group, so it is stubbed out rather than partially supplied.
    recurrenceEnabled: false,
    setRecurrenceEnabled: jest.fn(),
    recurrencePattern: "weekly" as const,
    setRecurrencePattern: jest.fn(),
    recurrenceInterval: 1,
    setRecurrenceInterval: jest.fn(),
    recurrenceDaysOfWeek: null,
    setRecurrenceDaysOfWeek: jest.fn(),
    recurrenceDayOfMonth: null,
    setRecurrenceDayOfMonth: jest.fn(),
    recurrenceEndDate: null,
    setRecurrenceEndDate: jest.fn(),
    recurrenceMaxOccurrences: null,
    setRecurrenceMaxOccurrences: jest.fn(),
    dependencies: [] as string[],
    setDependencies: jest.fn(),
    submitting: false,
    submit: jest.fn(),
  },
  setError: jest.fn(),
};

function renderModal(overrides: Record<string, unknown> = {}) {
  const props = {
    ...defaultProps,
    ...overrides,
    create: { ...defaultProps.create, ...((overrides.create as object) || {}) },
  };
  return renderWithProviders(<CreateTaskModal {...props} />);
}

/**
 * The modal is a three-step wizard: details, then clients, then dependencies.
 * Step 1 refuses to advance without a title, so render with one and click
 * through to the step the assertion is about.
 */
async function renderAtStep(step: number, overrides: Record<string, unknown> = {}) {
  const user = userEvent.setup();
  const create = { title: "Draft the brief", ...((overrides.create as object) || {}) };
  const result = renderModal({ ...overrides, create });
  for (let i = 1; i < step; i++) {
    await user.click(screen.getByRole("button", { name: "Continue" }));
  }
  return { user, ...result };
}

describe("CreateTaskModal", () => {
  beforeEach(() => {
    setCourtId.mockReset();
    mockLookupMatters.mockReset();
    mockLookupClients.mockReset();
    mockLookupTasks.mockReset();
    mockLookupMatters.mockResolvedValue({ items: [], hasMore: false });
    mockLookupClients.mockResolvedValue({ items: [], hasMore: false });
    mockLookupTasks.mockResolvedValue({ items: [], hasMore: false });
  });

  it("offers an end only once the task has a due date to come after", () => {
    const { unmount } = renderModal({ create: { title: "Draft the brief", dueDate: null } });
    expect(screen.queryByRole("button", { name: /^End (?!time)/ })).not.toBeInTheDocument();
    unmount();

    renderModal({ create: { title: "Draft the brief", dueDate: "2026-05-10T13:00" } });
    expect(screen.getByRole("button", { name: /^End (?!time)/ })).toHaveTextContent("No end");
  });

  it("withholds Continue while the end is not after the due time, and says why", () => {
    renderModal({ create: { title: "Draft the brief", dueDate: "2026-05-10T13:00", endsAt: "2026-05-10T12:00" } });

    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByText("The end must be after the start.")).toBeInTheDocument();
  });

  it("clears the end along with the due date", async () => {
    const setEndsAt = jest.fn();
    const user = userEvent.setup();
    renderModal({ create: { title: "Draft the brief", allDay: true, dueDate: "2026-05-10T00:00", endsAt: "2026-05-12", setEndsAt } });

    await user.click(screen.getByRole("button", { name: /^Due May 10, 2026/ }));
    await user.click(within(await screen.findByRole("dialog", { name: "Choose a date" })).getByRole("button", { name: "Clear" }));

    expect(setEndsAt).toHaveBeenLastCalledWith("");
  });

  it("keeps the panel the same size on every step, so the footer buttons stay put", async () => {
    const { user } = await renderAtStep(1, { create: { title: "Draft the brief" } });
    const dialog = screen.getByRole("dialog");
    // A fixed height, not a cap: a cap still lets a short step shrink the panel.
    // The `max-sm:` cap is the phone bottom sheet and is expected to be there.
    expect(dialog).toHaveClass("h-[min(720px,90vh)]");
    expect(dialog.className.split(" ").filter((c) => /^(max-)?h-/.test(c))).toEqual([
      "h-[min(720px,90vh)]",
    ]);

    const step1 = dialog.className;
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.getByRole("dialog").className).toBe(step1);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("dialog").className).toBe(step1);
  });

  it("prefills the court from a matter that was selected before it opened", async () => {
    mockLookupMatters.mockResolvedValue({
      items: [{ id: "matter-1", label: "Smith v Jones", courtId: "court-9" }],
      hasMore: false,
    });

    renderModal({ create: { matterId: "matter-1" } });

    await waitFor(() => expect(setCourtId).toHaveBeenCalledWith("court-9"));
  });

  // Courts now load when the modal opens rather than with the page, so they can
  // arrive after the matter lookup. A matter linked to its court only by name
  // must still get that court once the list is in.
  it("prefills the court by name once the firm's courts finish loading", async () => {
    mockLookupMatters.mockResolvedValue({
      items: [{ id: "matter-1", label: "Smith v Jones", courtName: "Superior Court" }],
      hasMore: false,
    });
    const props = { ...defaultProps, create: { ...defaultProps.create, matterId: "matter-1" } };

    const { rerender } = renderWithProviders(<CreateTaskModal {...props} courts={[]} courtsLoading />);
    await waitFor(() => expect(mockLookupMatters).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));

    rerender(
      <CreateTaskModal {...props} courts={[{ id: "court-3", name: "Superior Court" }]} courtsLoading={false} />
    );

    await waitFor(() => expect(setCourtId).toHaveBeenCalledWith("court-3"));
  });

  it("sources its client options from the server lookup", async () => {
    mockLookupClients.mockResolvedValue({
      items: [{ id: "client-1", label: "Ada Lovelace", sublabel: "ada@example.com" }],
      hasMore: false,
    });

    await renderAtStep(2);

    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("sources its dependency options from the server lookup", async () => {
    mockLookupTasks.mockResolvedValue({
      items: [{ id: "task-9", label: "File the motion", status: "open" }],
      hasMore: false,
    });

    await renderAtStep(3);

    expect(await screen.findByText("File the motion")).toBeInTheDocument();
  });

  it("replaces the client picker with an inherited-clients note once a matter is chosen", async () => {
    await renderAtStep(2, { create: { matterId: "matter-1" } });

    expect(
      await screen.findByText(/Inherited from the selected matter/i)
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search clients...")).not.toBeInTheDocument();
  });

  // Opened from a client's page, the modal was given the client only to narrow
  // the matter picker. A task made with no matter was then filed against nobody,
  // and the client's own Tasks tab never listed it.
  describe("when opened from a single client's page", () => {
    it("links the client to the task when no matter is chosen", () => {
      const setClientIds = jest.fn();
      renderModal({ clientId: "client-9", create: { setClientIds } });

      expect(setClientIds).toHaveBeenCalledWith(["client-9"]);
    });

    it("keeps any clients already picked and adds this one beside them", () => {
      const setClientIds = jest.fn();
      renderModal({ clientId: "client-9", create: { setClientIds, clientIds: ["client-2"] } });

      expect(setClientIds).toHaveBeenCalledWith(["client-2", "client-9"]);
    });

    it("does not add the client a second time", () => {
      const setClientIds = jest.fn();
      renderModal({ clientId: "client-9", create: { setClientIds, clientIds: ["client-9"] } });

      expect(setClientIds).not.toHaveBeenCalled();
    });

    it("leaves the clients alone when the task already belongs to a matter", () => {
      const setClientIds = jest.fn();
      renderModal({ clientId: "client-9", create: { setClientIds, matterId: "matter-1" } });

      // A matter task carries its matter's clients; a second link would be noise.
      expect(setClientIds).not.toHaveBeenCalled();
    });

    it("does nothing while the modal is closed", () => {
      const setClientIds = jest.fn();
      renderModal({ open: false, clientId: "client-9", create: { setClientIds } });

      expect(setClientIds).not.toHaveBeenCalled();
    });
  });

  it("is not tied to any client on the plain tasks page", () => {
    const setClientIds = jest.fn();
    renderModal({ create: { setClientIds } });

    expect(setClientIds).not.toHaveBeenCalled();
  });

  // Red if Back or the reached steps stay live once the create is in flight.
  it("holds Back and the reached steps shut while the create is in flight", async () => {
    const { rerender } = await renderAtStep(3);
    rerender(<CreateTaskModal {...defaultProps} create={{ ...defaultProps.create, title: "Draft the brief", submitting: true }} />);

    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /, step 1 of 3, completed/ })).toBeDisabled();
  });

  // Red if Escape can close the modal while the create is in flight.
  it("cannot be dismissed while the create is in flight", () => {
    const onClose = jest.fn();
    renderModal({ onClose, create: { title: "Draft the brief", submitting: true } });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
