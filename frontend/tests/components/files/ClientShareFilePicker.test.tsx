import React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockLookupMatters = jest.fn();
const mockLookupTasks = jest.fn();
const mockListFolderFiles = jest.fn();
const mockSearchFiles = jest.fn();

jest.mock("@/services/matters.service", () => ({
  __esModule: true,
  default: { lookupMatters: (...args: any[]) => mockLookupMatters(...args) },
}));
jest.mock("@/services/tasks.service", () => ({
  __esModule: true,
  default: { lookupTasks: (...args: any[]) => mockLookupTasks(...args) },
}));
jest.mock("@/services/files.service", () => ({
  __esModule: true,
  default: {
    listFolder: (...args: any[]) => mockListFolderFiles(...args),
    search: (...args: any[]) => mockSearchFiles(...args),
    setClientVisibility: jest.fn().mockResolvedValue({}),
  },
}));

import ClientShareFilePicker from "@/components/filesComp/ClientShareFilePicker";

const CLIENT_ID = "client-1";

const baseProps = {
  open: true,
  onClose: jest.fn(),
  lawFirmId: "law-firm-1",
  clientId: CLIENT_ID,
  onShared: jest.fn(),
};

const NOTE = "More results available. Keep typing to narrow.";
const TRUNCATION_NOTE = /this list is incomplete/i;

describe("ClientShareFilePicker source lists", () => {
  beforeEach(() => {
    mockLookupMatters.mockReset();
    mockLookupTasks.mockReset();
    mockListFolderFiles.mockReset();
    mockSearchFiles.mockReset();
    mockListFolderFiles.mockResolvedValue({ files: [] });
    mockSearchFiles.mockResolvedValue({ files: [] });
    mockLookupMatters.mockResolvedValue({ items: [{ id: "m1", label: "Smith v. Jones" }], hasMore: false });
    mockLookupTasks.mockResolvedValue({ items: [{ id: "t1", label: "File motion" }], hasMore: false });
  });

  it("keeps the initial source list in a loading state until it resolves", async () => {
    let releaseMatters: ((value: unknown) => void) | undefined;
    mockLookupMatters.mockImplementationOnce(() => new Promise((resolve) => { releaseMatters = resolve; }));

    render(React.createElement(ClientShareFilePicker, { ...baseProps }));
    expect(screen.getByRole("status", { name: "Loading matters" })).toBeInTheDocument();
    expect(screen.queryByText("This client isn't on any matters.")).not.toBeInTheDocument();

    await waitFor(() => expect(releaseMatters).toBeDefined());
    releaseMatters?.({ items: [], hasMore: false });
    expect(await screen.findByText("This client isn't on any matters.")).toBeInTheDocument();
  });

  // The scope is the ethical wall: an unscoped lookup here would offer another
  // client's matters as a place to share this client's files from.
  it("scopes the matters lookup to the client whose portal is being filled", async () => {
    render(React.createElement(ClientShareFilePicker, { ...baseProps }));

    await waitFor(() => expect(mockLookupMatters).toHaveBeenCalled());
    expect(mockLookupMatters).toHaveBeenCalledWith(
      "law-firm-1",
      expect.objectContaining({ clientId: CLIENT_ID }),
    );
  });

  it("scopes the tasks lookup the same way, and only once its tab is opened", async () => {
    const user = userEvent.setup();
    render(React.createElement(ClientShareFilePicker, { ...baseProps }));

    await waitFor(() => expect(mockLookupMatters).toHaveBeenCalled());
    // The tasks list is lazy: nothing is fetched for a tab the user never opens.
    expect(mockLookupTasks).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Tasks/ }));

    await waitFor(() => expect(mockLookupTasks).toHaveBeenCalled());
    expect(mockLookupTasks).toHaveBeenCalledWith(
      "law-firm-1",
      expect.objectContaining({ clientId: CLIENT_ID }),
    );
  });

  it("does not fetch the same list twice when the picker opens", async () => {
    render(React.createElement(ClientShareFilePicker, { ...baseProps }));

    await waitFor(() => expect(mockLookupMatters).toHaveBeenCalled());
    // The load-on-open and the debounced search used to be separate effects, so
    // opening fired two identical requests.
    await new Promise((r) => setTimeout(r, 500));
    expect(mockLookupMatters).toHaveBeenCalledTimes(1);
  });

  it("says so when the lookup had more rows than it returned", async () => {
    mockLookupMatters.mockResolvedValue({ items: [{ id: "m1", label: "Smith v. Jones" }], hasMore: true });

    render(React.createElement(ClientShareFilePicker, { ...baseProps }));

    expect(await screen.findByText(NOTE)).toBeInTheDocument();
  });

  it("shows no note when the lookup returned the complete list", async () => {
    render(React.createElement(ClientShareFilePicker, { ...baseProps }));

    expect(await screen.findByText("Smith v. Jones")).toBeInTheDocument();
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });

  it("re-queries the server as the user types instead of filtering in place", async () => {
    const user = userEvent.setup();
    render(React.createElement(ClientShareFilePicker, { ...baseProps }));
    await waitFor(() => expect(mockLookupMatters).toHaveBeenCalledTimes(1));

    await user.type(screen.getByPlaceholderText(/Search matters/i), "jones");

    await waitFor(() =>
      expect(mockLookupMatters).toHaveBeenLastCalledWith(
        "law-firm-1",
        expect.objectContaining({ search: "jones", clientId: CLIENT_ID }),
      ),
    );
  });

  // Typing "sm", pausing past the debounce so it fires, then typing more to
  // "smith" starts a second search while the first is still in flight. A
  // slower response for "sm" landing after "smith"'s used to silently replace
  // the newer results, with the input still showing "smith".
  it("keeps the newest search's results, even when an earlier search's slower response arrives after it", async () => {
    mockLookupMatters.mockImplementation((_lawFirmId: string, opts: { search?: string }) => {
      if (opts.search === "sm") {
        return new Promise((resolve) =>
          setTimeout(() => resolve({ items: [{ id: "m1", label: "Smith Old" }], hasMore: false }), 500)
        );
      }
      if (opts.search === "smith") {
        return new Promise((resolve) =>
          setTimeout(() => resolve({ items: [{ id: "m2", label: "Smith New" }], hasMore: false }), 50)
        );
      }
      return Promise.resolve({ items: [], hasMore: false });
    });
    const user = userEvent.setup();

    render(React.createElement(ClientShareFilePicker, { ...baseProps }));
    await waitFor(() => expect(mockLookupMatters).toHaveBeenCalledTimes(1));

    const input = screen.getByPlaceholderText(/Search matters/i);
    await user.type(input, "sm");
    await waitFor(() =>
      expect(mockLookupMatters).toHaveBeenLastCalledWith("law-firm-1", expect.objectContaining({ search: "sm" }))
    );

    await user.type(input, "ith");
    await waitFor(() =>
      expect(mockLookupMatters).toHaveBeenLastCalledWith("law-firm-1", expect.objectContaining({ search: "smith" }))
    );

    await screen.findByText("Smith New");

    // Give the "sm" search's slower, now-stale response time to land too. The
    // debounce effect's own dependency-driven re-run means an unguarded stale
    // write self-corrects a moment later (it notices the input no longer
    // matches what got stored and re-fetches "smith" again) - a genuinely
    // wrong intermediate state and an extra network call, even though the
    // FINAL state looks fine either way. The call count catches it where the
    // final DOM state alone would not.
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(screen.getByText("Smith New")).toBeInTheDocument();
    expect(screen.queryByText("Smith Old")).not.toBeInTheDocument();
    expect(mockLookupMatters).toHaveBeenCalledTimes(3);
  }, 10000);
});

describe("ClientShareFilePicker file listing", () => {
  beforeEach(() => {
    mockLookupMatters.mockReset();
    mockLookupTasks.mockReset();
    mockListFolderFiles.mockReset();
    mockSearchFiles.mockReset();
    mockSearchFiles.mockResolvedValue({ files: [] });
    mockLookupMatters.mockResolvedValue({ items: [{ id: "m1", label: "Smith v. Jones" }], hasMore: false });
    mockLookupTasks.mockResolvedValue({ items: [], hasMore: false });
  });

  // A file browser that quietly drops rows is how a firm concludes a document
  // was never uploaded, so a short scan has to be visible.
  it("warns when the server reports the folder listing was cut short", async () => {
    mockListFolderFiles.mockResolvedValue({
      files: [{ objectPath: "p/report.pdf", name: "report.pdf", isFolder: false, size: 10 }],
      truncated: true,
    });
    const user = userEvent.setup();

    render(React.createElement(ClientShareFilePicker, { ...baseProps }));
    await user.click(await screen.findByText("Smith v. Jones"));

    expect(await screen.findByText(TRUNCATION_NOTE)).toBeInTheDocument();
  });

  it("stays quiet when the folder listing was complete", async () => {
    mockListFolderFiles.mockResolvedValue({
      files: [{ objectPath: "p/report.pdf", name: "report.pdf", isFolder: false, size: 10 }],
      truncated: false,
    });
    const user = userEvent.setup();

    render(React.createElement(ClientShareFilePicker, { ...baseProps }));
    await user.click(await screen.findByText("Smith v. Jones"));

    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    expect(screen.queryByText(TRUNCATION_NOTE)).not.toBeInTheDocument();
  });
});

describe("ClientShareFilePicker tab-switch race", () => {
  beforeEach(() => {
    mockLookupMatters.mockReset();
    mockLookupTasks.mockReset();
    mockListFolderFiles.mockReset();
    mockLookupMatters.mockResolvedValue({ items: [{ id: "m1", label: "Smith v. Jones" }], hasMore: false });
    mockLookupTasks.mockResolvedValue({ items: [{ id: "t1", label: "File motion" }], hasMore: false });
  });

  // Opening a matter's files stays clickable-elsewhere while it loads: the tab
  // buttons and the other scope's source list are outside the loading spinner.
  // Switching to Tasks and opening one before the matter's fetch resolves used
  // to race: a slow matter response landing after the task's files could
  // silently replace them.
  it("keeps the task's files on screen, even when the matter tab's slower response arrives after it", async () => {
    let call = 0;
    mockListFolderFiles.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return new Promise((resolve) =>
          setTimeout(() => resolve({ files: [{ objectPath: "p/matter-file.pdf", name: "Matter-File.pdf", isFolder: false, size: 10 }] }), 80)
        );
      }
      return new Promise((resolve) =>
        setTimeout(() => resolve({ files: [{ objectPath: "p/task-file.pdf", name: "Task-File.pdf", isFolder: false, size: 10 }] }), 10)
      );
    });

    render(React.createElement(ClientShareFilePicker, { ...baseProps }));

    fireEvent.click(await screen.findByText("Smith v. Jones"));
    fireEvent.click(screen.getByText("Tasks"));
    fireEvent.click(await screen.findByText("File motion"));

    await waitFor(() => expect(screen.getByText("Task-File.pdf")).toBeInTheDocument());

    // Give the matter's slower, now-stale response time to land too.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.getByText("Task-File.pdf")).toBeInTheDocument();
    expect(screen.queryByText("Matter-File.pdf")).not.toBeInTheDocument();
  });
});

/**
 * Folder navigation. The server lists a folder by its row id (a uuid) and
 * answers an empty listing for anything else, so the id is the whole request.
 *
 * WHAT BREAKS THESE: sending the folder's NAME, or a "/"-joined chain of names,
 * as `folderId` (every folder then opens onto "No files here."); resolving a
 * breadcrumb click to anything but that crumb's own id; keying rows by
 * `objectPath`, which is null for every folder, so two folders collide.
 */
describe("ClientShareFilePicker folder navigation", () => {
  const PLEADINGS = { id: "folder-pleadings", objectPath: null, name: "Pleadings", isFolder: true, size: 0 };
  const EXHIBITS = { id: "folder-exhibits", objectPath: null, name: "Exhibits", isFolder: true, size: 0 };
  const DRAFTS = { id: "folder-drafts", objectPath: null, name: "Drafts", isFolder: true, size: 0 };
  const MOTION = { id: "file-motion", objectPath: "p/motion.pdf", name: "motion.pdf", isFolder: false, size: 10 };

  beforeEach(() => {
    mockLookupMatters.mockReset();
    mockLookupTasks.mockReset();
    mockListFolderFiles.mockReset();
    mockSearchFiles.mockReset();
    mockLookupMatters.mockResolvedValue({ items: [], hasMore: false });
    mockLookupTasks.mockResolvedValue({ items: [], hasMore: false });
    mockListFolderFiles.mockImplementation((_firm: string, _scope: unknown, folderId?: string) => {
      if (folderId === PLEADINGS.id) return Promise.resolve({ files: [DRAFTS] });
      if (folderId === DRAFTS.id) return Promise.resolve({ files: [MOTION] });
      if (folderId === undefined) return Promise.resolve({ files: [PLEADINGS, EXHIBITS] });
      // Anything that is not a folder's row id is what the server answers empty for.
      return Promise.resolve({ files: [] });
    });
  });

  const lastFolderId = () => mockListFolderFiles.mock.calls[mockListFolderFiles.mock.calls.length - 1][2];

  it("opens nested folders by their row ids and shows what is inside", async () => {
    const user = userEvent.setup();
    render(React.createElement(ClientShareFilePicker, { ...baseProps }));

    await user.click(await screen.findByRole("button", { name: /Client files/ }));
    await user.click(await screen.findByText("Pleadings"));

    expect(await screen.findByText("Drafts")).toBeInTheDocument();
    expect(lastFolderId()).toBe(PLEADINGS.id);

    await user.click(screen.getByText("Drafts"));

    expect(await screen.findByText("motion.pdf")).toBeInTheDocument();
    expect(lastFolderId()).toBe(DRAFTS.id);
    expect(screen.queryByText("No files here.")).not.toBeInTheDocument();
  });

  it("returns to a breadcrumb's folder by its id, and to the root with none", async () => {
    const user = userEvent.setup();
    render(React.createElement(ClientShareFilePicker, { ...baseProps }));

    await user.click(await screen.findByRole("button", { name: /Client files/ }));
    await user.click(await screen.findByText("Pleadings"));
    await user.click(await screen.findByText("Drafts"));
    await screen.findByText("motion.pdf");

    // The breadcrumb still names the folders; only the address behind it changed.
    await user.click(screen.getByRole("button", { name: "Pleadings" }));
    expect(await screen.findByText("Drafts")).toBeInTheDocument();
    expect(lastFolderId()).toBe(PLEADINGS.id);

    await user.click(screen.getByRole("button", { name: "Root" }));
    expect(await screen.findByText("Exhibits")).toBeInTheDocument();
    expect(lastFolderId()).toBeUndefined();
  });

  it("keys folder rows by id, so two folders never collide", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const user = userEvent.setup();
      render(React.createElement(ClientShareFilePicker, { ...baseProps }));

      await user.click(await screen.findByRole("button", { name: /Client files/ }));
      expect(await screen.findByText("Exhibits")).toBeInTheDocument();

      const keyWarnings = errorSpy.mock.calls.filter((args) => /same key|unique "key"/.test(args.map(String).join(" ")));
      expect(keyWarnings).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

/**
 * File search runs in the area the user is browsing. Without a scope the
 * server searches the firm's General Files, so a hit picked from there would
 * be recorded under the task or client and fail to share.
 *
 * WHAT BREAKS THESE: searching with only the matter id (a task or the client
 * tab then searches General Files), or with a scope for a tab other than the
 * one on screen.
 */
describe("ClientShareFilePicker file search scope", () => {
  beforeEach(() => {
    mockLookupMatters.mockReset();
    mockLookupTasks.mockReset();
    mockListFolderFiles.mockReset();
    mockSearchFiles.mockReset();
    mockListFolderFiles.mockResolvedValue({ files: [] });
    mockSearchFiles.mockResolvedValue({ files: [] });
    mockLookupMatters.mockResolvedValue({ items: [{ id: "m1", label: "Smith v. Jones" }], hasMore: false });
    mockLookupTasks.mockResolvedValue({ items: [{ id: "t1", label: "File motion" }], hasMore: false });
  });

  async function searchFor(user: ReturnType<typeof userEvent.setup>, term: string) {
    await user.type(await screen.findByPlaceholderText("Search files..."), `${term}{Enter}`);
    await waitFor(() => expect(mockSearchFiles).toHaveBeenCalled());
  }

  it("searches the open task's files on the Tasks tab", async () => {
    const user = userEvent.setup();
    render(React.createElement(ClientShareFilePicker, { ...baseProps }));

    await user.click(await screen.findByRole("button", { name: /Tasks/ }));
    await user.click(await screen.findByText("File motion"));
    await searchFor(user, "brief");

    expect(mockSearchFiles).toHaveBeenCalledWith("law-firm-1", { type: "task", taskId: "t1" }, "brief");
  });

  it("searches the client's own files on the Client files tab", async () => {
    const user = userEvent.setup();
    render(React.createElement(ClientShareFilePicker, { ...baseProps }));

    await user.click(await screen.findByRole("button", { name: /Client files/ }));
    await searchFor(user, "brief");

    expect(mockSearchFiles).toHaveBeenCalledWith("law-firm-1", { type: "client", clientId: CLIENT_ID }, "brief");
  });

  it("searches the open matter's files on the Matters tab", async () => {
    const user = userEvent.setup();
    render(React.createElement(ClientShareFilePicker, { ...baseProps }));

    await user.click(await screen.findByText("Smith v. Jones"));
    await searchFor(user, "brief");

    expect(mockSearchFiles).toHaveBeenCalledWith(
      "law-firm-1",
      { type: "matter", matterId: "m1", taskId: null },
      "brief",
    );
  });
});
