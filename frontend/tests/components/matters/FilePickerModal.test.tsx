import React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockListMatterTasks = jest.fn();
jest.mock("@/services/tasks.service", () => ({
  __esModule: true,
  default: {
    listMatterTasks: (...args: any[]) => mockListMatterTasks(...args),
  },
}));

jest.mock("@/services/files.service", () => ({
  __esModule: true,
  default: {
    listMatterFiles: jest.fn().mockResolvedValue({ files: [] }),
    listLawFirmFiles: jest.fn().mockResolvedValue({ files: [] }),
    listFolderFiles: jest.fn().mockResolvedValue({ files: [] }),
    searchFiles: jest.fn().mockResolvedValue({ files: [] }),
  },
}));

import FilePickerModal from "@/components/matterComp/FilePickerModal";
import filesService from "@/services/files.service";

function makeFile(name: string): any {
  return { name, objectPath: `path/${name}`, size: 100, contentType: "application/pdf", updated: "", signedUrl: "" };
}

const baseProps = {
  open: true,
  onClose: jest.fn(),
  onSelect: jest.fn(),
  lawFirmId: "law-firm-1",
  matterId: "matter-1",
};

const TASK_SEARCH_PLACEHOLDER = "Search tasks...";

function makeTask(id: string, title: string): any {
  return { id, title, status: "open", priority: "medium", attachments: [] };
}

/** Opens the modal and switches to the Task Files tab. */
async function openTaskList(user: ReturnType<typeof userEvent.setup>) {
  render(React.createElement(FilePickerModal, { ...baseProps }));
  await user.click(screen.getByText("Task Files"));
  return screen.findByPlaceholderText(TASK_SEARCH_PLACEHOLDER);
}

describe("FilePickerModal task list", () => {
  beforeEach(() => {
    mockListMatterTasks.mockReset();
  });

  it("shows file placeholders until the opening folder finishes loading", async () => {
    let releaseFiles: ((value: Awaited<ReturnType<typeof filesService.listMatterFiles>>) => void) | undefined;
    jest.spyOn(filesService, "listMatterFiles").mockImplementationOnce(
      () => new Promise((resolve) => { releaseFiles = resolve; }) as ReturnType<typeof filesService.listMatterFiles>,
    );

    render(React.createElement(FilePickerModal, { ...baseProps }));
    expect(screen.getByRole("status", { name: "Loading files" })).toBeInTheDocument();
    expect(screen.queryByText("No files found")).not.toBeInTheDocument();

    releaseFiles?.({ files: [], count: 0 });
    expect(await screen.findByText("No files found")).toBeInTheDocument();
  });

  it("filters the rendered task rows by title", async () => {
    mockListMatterTasks.mockResolvedValue([
      makeTask("t1", "Draft complaint"),
      makeTask("t2", "File motion"),
      makeTask("t3", "Review discovery"),
    ]);
    const user = userEvent.setup();

    const input = await openTaskList(user);
    expect(await screen.findByText("Draft complaint")).toBeInTheDocument();

    await user.type(input, "MOTION");

    expect(screen.getByText("File motion")).toBeInTheDocument();
    expect(screen.queryByText("Draft complaint")).not.toBeInTheDocument();
    expect(screen.queryByText("Review discovery")).not.toBeInTheDocument();
  });

  it("distinguishes an empty search result from a matter with no tasks", async () => {
    mockListMatterTasks.mockResolvedValue([
      makeTask("t1", "Draft complaint"),
      makeTask("t2", "File motion"),
    ]);
    const user = userEvent.setup();

    const input = await openTaskList(user);
    await user.type(input, "zzzz");

    expect(await screen.findByText("No tasks match your search")).toBeInTheDocument();
    expect(screen.queryByText("No tasks linked to this matter")).not.toBeInTheDocument();
  });

  it("shows the no-tasks message when the matter genuinely has none", async () => {
    mockListMatterTasks.mockResolvedValue([]);
    const user = userEvent.setup();

    await openTaskList(user);

    expect(await screen.findByText("No tasks linked to this matter")).toBeInTheDocument();
    expect(screen.queryByText("No tasks match your search")).not.toBeInTheDocument();
  });

  // Goes red if a failed task load is swallowed into an empty list, which
  // tells the user the matter has no tasks when it was never checked.
  it("reports a failed task load instead of claiming the matter has no tasks", async () => {
    mockListMatterTasks.mockRejectedValue(new Error("The task list could not be loaded"));
    const user = userEvent.setup();

    render(React.createElement(FilePickerModal, { ...baseProps }));
    await user.click(screen.getByText("Task Files"));

    expect(await screen.findByRole("alert")).toHaveTextContent("The task list could not be loaded");
    expect(mockListMatterTasks).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("No tasks linked to this matter")).not.toBeInTheDocument();
  });

  it("does not draw the pager when the tasks fit on one page", async () => {
    mockListMatterTasks.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => makeTask(`t${i}`, `Alpha ${String(i).padStart(2, "0")}`)),
    );
    const user = userEvent.setup();

    await openTaskList(user);
    expect(await screen.findByText("Alpha 00")).toBeInTheDocument();

    expect(screen.queryByText(/\d+–\d+ of \d+/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  it("pages the task list past ten tasks", async () => {
    mockListMatterTasks.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => makeTask(`t${i}`, `Alpha ${String(i).padStart(2, "0")}`)),
    );
    const user = userEvent.setup();

    await openTaskList(user);
    expect(await screen.findByText("Alpha 00")).toBeInTheDocument();

    expect(screen.getByText("1–10 of 25")).toBeInTheDocument();
    expect(screen.queryByText("Alpha 10")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText("11–20 of 25")).toBeInTheDocument();
    expect(screen.getByText("Alpha 10")).toBeInTheDocument();
    expect(screen.queryByText("Alpha 00")).not.toBeInTheDocument();
  });

  it("returns to page one when the task search changes", async () => {
    mockListMatterTasks.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => makeTask(`t${i}`, `Alpha ${String(i).padStart(2, "0")}`)),
    );
    const user = userEvent.setup();

    const input = await openTaskList(user);
    expect(await screen.findByText("Alpha 00")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("11–20 of 25")).toBeInTheDocument();

    // Still 25 matches, so the paging itself is what has to restart.
    await user.type(input, "Alpha");

    expect(screen.getByText("1–10 of 25")).toBeInTheDocument();
    expect(screen.getByText("Alpha 00")).toBeInTheDocument();
  });

  it("clears the task search when the user leaves and returns to the task list", async () => {
    mockListMatterTasks.mockResolvedValue([
      makeTask("t1", "Draft complaint"),
      makeTask("t2", "File motion"),
    ]);
    const user = userEvent.setup();

    const input = await openTaskList(user);
    await user.type(input, "motion");
    expect(screen.queryByText("Draft complaint")).not.toBeInTheDocument();

    await user.click(screen.getByText("File motion"));
    await user.click(await screen.findByText("Back to tasks"));

    expect(await screen.findByText("Draft complaint")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(TASK_SEARCH_PLACEHOLDER)).toHaveValue("");
  });

  it("clears the task search when the user switches tabs", async () => {
    mockListMatterTasks.mockResolvedValue([
      makeTask("t1", "Draft complaint"),
      makeTask("t2", "File motion"),
    ]);
    const user = userEvent.setup();

    const input = await openTaskList(user);
    await user.type(input, "motion");
    expect(screen.queryByText("Draft complaint")).not.toBeInTheDocument();

    await user.click(screen.getByText("Matter Files"));
    await user.click(screen.getByText("Task Files"));

    expect(await screen.findByText("Draft complaint")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(TASK_SEARCH_PLACEHOLDER)).toHaveValue("");
  });
});

describe("FilePickerModal tab-switch race", () => {
  beforeEach(() => {
    (filesService.listMatterFiles as jest.Mock).mockReset();
    (filesService.listLawFirmFiles as jest.Mock).mockReset();
  });

  // Opening the modal starts loading the Matter Files tab. Switching to Firm
  // Files before that resolves used to race: whichever response landed last
  // won, so a slow Matter Files response could silently replace the Firm
  // Files list the user had already switched to.
  it("keeps the tab the user switched to, even when the previous tab's slower response arrives after it", async () => {
    (filesService.listMatterFiles as jest.Mock).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ files: [makeFile("Matter-File.pdf")] }), 80))
    );
    (filesService.listLawFirmFiles as jest.Mock).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ files: [makeFile("Firm-File.pdf")] }), 10))
    );

    render(React.createElement(FilePickerModal, { ...baseProps }));

    fireEvent.click(screen.getByText("Firm Files"));

    await waitFor(() => expect(screen.getByText("Firm-File.pdf")).toBeInTheDocument());

    // Give the Matter Files tab's slower, now-stale response time to land too.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.getByText("Firm-File.pdf")).toBeInTheDocument();
    expect(screen.queryByText("Matter-File.pdf")).not.toBeInTheDocument();
  });
});

/**
 * File search runs over what the tab is browsing. A plain matter scope makes
 * the server leave out every task-owned file, so searching a task's files with
 * one can never find them.
 *
 * WHAT BREAKS THESE: searching the Task Files tab without the open task's id
 * (a task's own files never match), or narrowing the Matter Files tab to a task.
 */
describe("FilePickerModal file search scope", () => {
  const mockSearch = jest.fn();
  const mockListFolder = jest.fn();

  beforeEach(() => {
    mockListMatterTasks.mockReset();
    mockSearch.mockReset().mockResolvedValue({ files: [] });
    mockListFolder.mockReset().mockResolvedValue({ files: [] });
    (filesService.listMatterFiles as jest.Mock).mockReset().mockResolvedValue({ files: [] });
    // The shared mock above predates these two methods.
    Object.assign(filesService, { search: mockSearch, listFolder: mockListFolder });
  });

  async function searchFor(user: ReturnType<typeof userEvent.setup>, term: string) {
    await user.type(await screen.findByPlaceholderText("Search files..."), `${term}{Enter}`);
    await waitFor(() => expect(mockSearch).toHaveBeenCalled());
  }

  it("searches the open task's own files on the Task Files tab", async () => {
    mockListMatterTasks.mockResolvedValue([makeTask("t1", "File motion")]);
    const user = userEvent.setup();

    await openTaskList(user);
    await user.click(await screen.findByText("File motion"));
    await searchFor(user, "brief");

    // The same scope the task's listing is read with.
    expect(mockListFolder).toHaveBeenCalledWith("law-firm-1", { type: "matter", matterId: "matter-1", taskId: "t1" }, undefined);
    expect(mockSearch).toHaveBeenCalledWith("law-firm-1", { type: "matter", matterId: "matter-1", taskId: "t1" }, "brief");
  });

  it("searches the whole matter on the Matter Files tab", async () => {
    const user = userEvent.setup();
    render(React.createElement(FilePickerModal, { ...baseProps }));

    await searchFor(user, "brief");

    expect(mockSearch).toHaveBeenCalledWith("law-firm-1", { type: "matter", matterId: "matter-1", taskId: null }, "brief");
  });
});
