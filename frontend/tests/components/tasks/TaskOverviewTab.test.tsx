/**
 * `TaskOverviewTab`: the task detail page's Overview tab, including its
 * "Quick Add Files" attachment control for a standalone task (no matter).
 *
 * PERMISSION GATING. For a task with no matter, the quick-add control renders
 * `TaskAttachments` with `compactUpload`, whose upload button calls
 * `FilesService.uploadTaskAttachments` (backend: `files.upload`) and whose
 * per-row delete button calls `FilesService.deleteTaskAttachment` (backend:
 * `files.delete`); either way, persisting the result onto the task via
 * `onAttachmentsChange` calls `TasksService.updateTask` (backend:
 * `tasks.update`). All three permissions are required for the control to
 * actually work, so `readOnly` must require all three - a viewer missing any
 * one of them must not see an enabled upload/delete control that would 403.
 */
jest.mock("@/components/taskComp/TaskSubtasks", () => ({
  __esModule: true,
  default: () => null,
}));

import React from "react";
import { screen } from "@testing-library/react";
import TaskOverviewTab from "@/components/taskComp/TaskOverviewTab";
import type { Task } from "@/types";
import { renderWithProviders } from "../../support/renderWithProviders";
import { grantPermissions, resetPermissions } from "../../support/permissions";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    taskId: "task-1",
    title: "Draft response",
    status: "open",
    priority: "medium",
    matterId: null,
    attachments: [],
    loggedHours: 0,
    billableLoggedHours: 0,
    timeEntryCount: 0,
    totalNotes: 0,
    clientNames: [],
    ...overrides,
  } as unknown as Task;
}

const baseProps = {
  lawFirmId: "firm-1",
  taskId: "task-1",
  matterData: null,
  assignedUserNames: [],
  dependencyTasks: [],
  dependentTasks: [],
  onError: jest.fn(),
  onViewFiles: jest.fn(),
  onViewNotes: jest.fn(),
  onTaskChange: jest.fn(),
};

afterEach(() => {
  resetPermissions();
});

describe("permission gating: standalone-task Quick Add Files", () => {
  it("hides upload and shows no attachment rows as editable when missing files.delete (tasks.update + files.upload only)", () => {
    grantPermissions(["tasks.view", "tasks.update", "files.upload"]);
    renderWithProviders(
      <TaskOverviewTab {...baseProps} task={task()} canUpdateTask />,
    );

    expect(screen.queryByText(/Upload files/i)).not.toBeInTheDocument();
  });

  it("hides upload when missing files.upload (tasks.update + files.delete only)", () => {
    grantPermissions(["tasks.view", "tasks.update", "files.delete"]);
    renderWithProviders(
      <TaskOverviewTab {...baseProps} task={task()} canUpdateTask />,
    );

    expect(screen.queryByText(/Upload files/i)).not.toBeInTheDocument();
  });

  it("hides upload when missing tasks.update (files.upload + files.delete only)", () => {
    grantPermissions(["tasks.view", "files.upload", "files.delete"]);
    renderWithProviders(
      <TaskOverviewTab {...baseProps} task={task()} canUpdateTask={false} />,
    );

    expect(screen.queryByText(/Upload files/i)).not.toBeInTheDocument();
  });

  it("shows the upload control once the viewer holds tasks.update, files.upload and files.delete", () => {
    grantPermissions(["tasks.view", "tasks.update", "files.upload", "files.delete"]);
    renderWithProviders(
      <TaskOverviewTab {...baseProps} task={task()} canUpdateTask />,
    );

    expect(screen.getByText(/Upload files/i)).toBeInTheDocument();
  });
});

describe("the task's time", () => {
  it("shows a timed task's span: the server's start display, then its end", () => {
    renderWithProviders(
      <TaskOverviewTab
        {...baseProps}
        canUpdateTask={false}
        task={task({
          dueDate: "2026-05-10T17:00:00.000Z",
          dueDateLocalDisplay: "May 10, 2026, 1:00 PM",
          dueDateLocalInput: "2026-05-10T13:00",
          endsAt: "2026-05-10T19:30:00.000Z",
          endsAtLocalInput: "2026-05-10T15:30",
        })}
      />,
    );

    expect(screen.getByText("May 10, 2026, 1:00 PM – 3:30 PM")).toBeInTheDocument();
  });

  it("shows only the start for a task without an end", () => {
    renderWithProviders(
      <TaskOverviewTab
        {...baseProps}
        canUpdateTask={false}
        task={task({ dueDate: "2026-05-10T17:00:00.000Z", dueDateLocalDisplay: "May 10, 2026, 1:00 PM" })}
      />,
    );

    expect(screen.getByText("May 10, 2026, 1:00 PM")).toBeInTheDocument();
  });
});
