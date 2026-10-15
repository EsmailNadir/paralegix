import React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../support/renderWithProviders";

const mockLookupMatters = jest.fn();
jest.mock("@/services/matters.service", () => ({
  __esModule: true,
  default: { lookupMatters: (...args: unknown[]) => mockLookupMatters(...args) },
}));

const mockLookupClients = jest.fn();
const mockLookupTasks = jest.fn();

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

import EditTaskModal from "@/components/taskComp/EditTaskModal";

const mockUsers = [
  { id: "user-1", name: "Alice Smith", email: "alice@example.com" },
];

const defaultProps = {
  open: true,
  onClose: jest.fn(),
  lawFirmId: "test-law-firm-id",
  users: mockUsers,
  courts: [],
  edit: {
    task: {
      id: "task-1",
      title: "Existing Task",
      description: "Task desc",
      status: "open" as const,
      matterId: "matter-1",
      matterName: "Test Matter",
      dueDate: null,
      dueDateLocalInput: "",
      dueDateLocalDisplay: "",
    } as any,
    title: "Existing Task",
    setTitle: jest.fn(),
    description: "Task desc",
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
    matterId: "matter-1",
    setMatterId: jest.fn(),
    courtId: "",
    setCourtId: jest.fn(),
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
    save: jest.fn(),
  },
  setError: jest.fn(),
};

function renderModal() {
  return renderWithProviders(<EditTaskModal {...defaultProps} />);
}

/**
 * The modal is a three-step wizard: details, then clients, then dependencies.
 * Click through to the step the assertion is about.
 */
async function renderAtStep(step: number) {
  const result = renderModal();
  const user = userEvent.setup();
  for (let i = 1; i < step; i++) {
    await user.click(screen.getByRole("button", { name: "Continue" }));
  }
  return { user, ...result };
}

describe("EditTaskModal", () => {
  beforeEach(() => {
    mockLookupMatters.mockReset();
    mockLookupMatters.mockResolvedValue({ items: [], hasMore: false });
    mockLookupClients.mockReset();
    mockLookupTasks.mockReset();
    mockLookupClients.mockResolvedValue({ items: [], hasMore: false });
    mockLookupTasks.mockResolvedValue({ items: [], hasMore: false });
  });

  // Red if sharing the create body starts replacing the edit form's court.
  it("keeps the edited court when selecting a new matter while clearing manual clients", async () => {
    mockLookupMatters.mockResolvedValue({ items: [{ id: "matter-2", label: "New matter", courtId: "court-new" }], hasMore: false });
    const setMatterId = jest.fn(), setCourtId = jest.fn(), setClientIds = jest.fn();
    const user = userEvent.setup();
    renderWithProviders(<EditTaskModal {...defaultProps}
      courts={[{ id: "court-existing", name: "Existing court" }, { id: "court-new", name: "New court" }]}
      edit={{ ...defaultProps.edit, courtId: "court-existing", clientIds: ["client-1"], setMatterId, setCourtId, setClientIds }} />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: /^Select Matter/ }));
    await user.click(await screen.findByRole("option", { name: "New matter" }));
    expect(setMatterId).toHaveBeenCalledWith("matter-2");
    expect(setClientIds).toHaveBeenCalledWith([]);
    expect(setCourtId).not.toHaveBeenCalled();
  });

  it("renders the task's matter name from the task record", () => {
    renderModal();
    expect(screen.getByText("Test Matter")).toBeInTheDocument();
  });

  // Clearing the picker sets the form's due date to "". The modal used to treat
  // that as "untouched" and draw the task's old date again, so the clear looked
  // like it had not worked and the old date was what the user then saved.
  it("shows no due date once the user has cleared it", () => {
    renderWithProviders(
      <EditTaskModal
        {...defaultProps}
        edit={{
          ...defaultProps.edit,
          dueDate: "",
          task: { ...defaultProps.edit.task, dueDateLocalInput: "2026-05-01T09:00", dueDateLocalDisplay: "May 1, 2026" },
        }}
      />,
    );

    // The due date and time are two pickers; both read empty.
    expect(screen.getByRole("button", { name: /^Due Select date/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Due time" })).toHaveTextContent("Time");
    expect(screen.queryByRole("button", { name: /^Due May 1, 2026/ })).not.toBeInTheDocument();
  });

  it("shows the task's own due date until the form has a value of its own", () => {
    renderWithProviders(
      <EditTaskModal
        {...defaultProps}
        edit={{
          ...defaultProps.edit,
          dueDate: null,
          task: { ...defaultProps.edit.task, dueDateLocalInput: "2026-05-01T09:00" },
        }}
      />,
    );

    expect(screen.getByRole("button", { name: /^Due May 1, 2026/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Due time" })).toHaveTextContent("9:00 AM");
  });

  it("sources its dependency options from the server lookup", async () => {
    mockLookupTasks.mockResolvedValue({
      items: [{ id: "task-9", label: "File the motion", status: "open" }],
      hasMore: false,
    });

    await renderAtStep(3);

    expect(await screen.findByText("File the motion")).toBeInTheDocument();
    await waitFor(() => expect(mockLookupTasks).toHaveBeenCalled());
  });

  // A task must never be offered as its own dependency, whatever the search returns.
  it("keeps the edited task out of its own dependency list", async () => {
    mockLookupTasks.mockResolvedValue({
      items: [
        { id: "task-1", label: "Existing Task", status: "open" },
        { id: "task-2", label: "Another Task", status: "open" },
      ],
      hasMore: false,
    });

    await renderAtStep(3);

    expect(await screen.findByText("Another Task")).toBeInTheDocument();
    // "Existing Task" is also the modal's title field value, so assert on the
    // dependency rows rather than on the document as a whole.
    const rows = screen.getAllByRole("button").map((b) => b.textContent || "");
    expect(rows.some((r) => r.includes("Another Task"))).toBe(true);
    expect(rows.some((r) => r.includes("Existing Task"))).toBe(false);
  });
});

describe("EditTaskModal: where a failed save is reported", () => {
  beforeEach(() => {
    mockLookupClients.mockReset().mockResolvedValue({ items: [], hasMore: false });
    mockLookupTasks.mockReset().mockResolvedValue({ items: [], hasMore: false });
  });

  // The create wizard reads its error directly above its buttons; the edit
  // wizard must match it, or the message sits at the top of a scrolled body.
  // Red if: the banner renders in the scrolling body rather than the footer.
  it("shows the error in the footer, beside Save Changes", async () => {
    const save = (setError: (e: string | null) => void) => setError("You cannot edit this task");
    renderWithProviders(<EditTaskModal {...defaultProps} edit={{ ...defaultProps.edit, save }} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You cannot edit this task");
    expect(screen.getByRole("button", { name: "Save Changes" }).closest(".border-t")).toContainElement(alert);
  });

  // Red if the footer or the step indicator stops honouring the in-flight save:
  // an edit opens with every step reachable, so both are live paths to Cancel.
  it("holds Cancel and the step indicator shut while the save is in flight", () => {
    const onClose = jest.fn();
    renderWithProviders(<EditTaskModal {...defaultProps} onClose={onClose} edit={{ ...defaultProps.edit, submitting: true }} />);

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toBeDisabled();
    expect(screen.getByRole("button", { name: /, step 3 of 3, completed/ })).toBeDisabled();
  });

  // Red if Escape can close the modal while the save is in flight.
  it("cannot be dismissed while the save is in flight", () => {
    const onClose = jest.fn();
    renderWithProviders(<EditTaskModal {...defaultProps} onClose={onClose} edit={{ ...defaultProps.edit, submitting: true }} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
