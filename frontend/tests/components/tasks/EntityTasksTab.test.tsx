/**
 * The Tasks tab a matter and a client share: each row's due line, which shows
 * a task's end the same way every other task list does.
 */
jest.mock("@/contexts/NavigationContext", () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: jest.fn(), isNavigating: false }),
}));

import React from "react";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EntityTasksTab from "@/components/taskComp/EntityTasksTab";
import type { Task } from "@/types";
import { renderWithProviders } from "../../support/renderWithProviders";

function task(overrides: Partial<Task>): Task {
  return { id: "t1", taskId: "t1", title: "Prep session", status: "open", priority: "medium", ...overrides } as Task;
}

describe("EntityTasksTab due line", () => {
  it("shows a timed task's start time and end", () => {
    renderWithProviders(<EntityTasksTab lawFirmId="firm-1" tasks={[task({
      dueDate: "2026-05-10T17:00:00.000Z", dueDateLocalDisplay: "May 10, 2026, 1:00 PM", dueDateLocalInput: "2026-05-10T13:00",
      endsAt: "2026-05-10T19:30:00.000Z", endsAtLocalInput: "2026-05-10T15:30",
    })]} />);

    expect(screen.getByText(/Due May 10, 2026, 1:00 PM – 3:30 PM/)).toBeInTheDocument();
  });

  it("shows a multi-day all-day task's first and last day", () => {
    renderWithProviders(<EntityTasksTab lawFirmId="firm-1" tasks={[task({
      allDay: true, dueDate: "2026-05-10T12:00:00.000Z", endsAt: "2026-05-13T12:00:00.000Z",
    })]} />);

    expect(screen.getByText(/Due May 10, 2026 – May 12, 2026/)).toBeInTheDocument();
  });

  it("keeps the plain due day for a task without an end", () => {
    renderWithProviders(<EntityTasksTab lawFirmId="firm-1" tasks={[task({ dueDate: "2026-05-10T12:00:00.000Z" })]} />);

    expect(screen.getByText(/^Due 5\/10\/2026$/)).toBeInTheDocument();
  });
});

describe("EntityTasksTab on a server-paged parent", () => {
  const rows = [task({ id: "t1", taskId: "t1", title: "Open one", status: "open" }), task({ id: "t2", taskId: "t2", title: "Blocked one", status: "blocked" })];

  // Red if: the "All" option counts the rows on this page instead of the server's total.
  it("counts the server total in the All option, not the rows on the page", () => {
    renderWithProviders(
      <EntityTasksTab lawFirmId="firm-1" tasks={rows} total={42} status={{ value: "all", onChange: jest.fn() }} />,
    );

    expect(screen.getByRole("button", { name: /All Tasks \(42\)/ })).toBeInTheDocument();
  });

  // Red if: the chosen status filters the page in the browser instead of going to the parent.
  it("hands the chosen status to the parent and leaves the rows it was given alone", async () => {
    const onChange = jest.fn();
    renderWithProviders(
      <EntityTasksTab lawFirmId="firm-1" tasks={rows} total={2} status={{ value: "blocked", onChange }} />,
    );

    // The parent's server already answered for "blocked"; a browser filter on top would hide "Open one".
    expect(screen.getByText("Open one")).toBeInTheDocument();
    expect(screen.getByText("Blocked one")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Blocked/ }));
    await userEvent.click(within(await screen.findByRole("listbox")).getByRole("option", { name: "In Progress" }));
    expect(onChange).toHaveBeenCalledWith("in_progress");
  });
});

describe("EntityTasksTab row actions", () => {
  // Each action is gated by the parent on its own permission (tasks.update, tasks.delete).
  // Red if: the row actions stay behind the create permission, hiding an edit the server allows.
  it("offers edit and delete from their handlers even when the viewer cannot create tasks", () => {
    renderWithProviders(
      <EntityTasksTab
        lawFirmId="firm-1"
        tasks={[task({ title: "Prep session" })]}
        canManageTasks={false}
        onEditTask={jest.fn()}
        onDeleteTask={jest.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Edit Prep session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Prep session" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New Task" })).not.toBeInTheDocument();
  });
});

describe("EntityTasksTab Open filter on a full list", () => {
  // Red if: "Open Tasks" in the browser filter means anything not blocked, so a
  // completed task shows under Open on the matter tab while the client tab's
  // server filter returns only status = open for the same chip.
  it("shows only open tasks, not completed ones", async () => {
    renderWithProviders(
      <EntityTasksTab
        lawFirmId="firm-1"
        tasks={[
          task({ id: "a", taskId: "a", title: "Still open", status: "open" }),
          task({ id: "b", taskId: "b", title: "Already done", status: "completed" }),
        ]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /All Tasks/ }));
    await userEvent.click(within(await screen.findByRole("listbox")).getByRole("option", { name: "Open Tasks" }));

    expect(screen.getByText("Still open")).toBeInTheDocument();
    expect(screen.queryByText("Already done")).not.toBeInTheDocument();
  });
});
