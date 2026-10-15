import React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockLookupMatters = jest.fn();
const mockLookupClients = jest.fn();
const mockLookupTasks = jest.fn();
const mockListFolderFiles = jest.fn();

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
jest.mock("@/services/files.service", () => ({
  __esModule: true,
  default: {
    listFolder: (...args: any[]) => mockListFolderFiles(...args),
    search: jest.fn().mockResolvedValue({ files: [] }),
  },
}));

import MessageFilePicker from "@/components/messagesComp/MessageFilePicker";

const baseProps = {
  open: true,
  onClose: jest.fn(),
  lawFirmId: "law-firm-1",
  maxSelectable: 5,
  onConfirm: jest.fn(),
};

const NOTE = "More results available. Keep typing to narrow.";
const SEARCH_NOTE = "More matches than shown. Keep typing to narrow.";

const FIRM_FILES = [
  { objectPath: "p/report.pdf", name: "report.pdf", isFolder: false, size: 1024 },
];

describe("MessageFilePicker source lists", () => {
  beforeEach(() => {
    mockLookupMatters.mockReset();
    mockLookupClients.mockReset();
    mockLookupTasks.mockReset();
    mockListFolderFiles.mockReset();
    mockListFolderFiles.mockResolvedValue({ files: FIRM_FILES });
    mockLookupMatters.mockResolvedValue({ items: [{ id: "m1", label: "Smith v. Jones" }], hasMore: false });
    mockLookupClients.mockResolvedValue({ items: [{ id: "c1", label: "Alice Smith" }], hasMore: false });
    mockLookupTasks.mockResolvedValue({ items: [{ id: "t1", label: "File motion" }], hasMore: false });
  });

  it("notes that a scope's picker list is capped when the lookup has more", async () => {
    mockLookupMatters.mockResolvedValue({ items: [{ id: "m1", label: "Smith v. Jones" }], hasMore: true });
    const user = userEvent.setup();

    render(React.createElement(MessageFilePicker, { ...baseProps }));
    await user.click(screen.getByRole("button", { name: /Matters/ }));

    expect(await screen.findByText(NOTE)).toBeInTheDocument();
  });

  it("shows no note when the lookup returned the complete list", async () => {
    const user = userEvent.setup();

    render(React.createElement(MessageFilePicker, { ...baseProps }));
    await user.click(screen.getByRole("button", { name: /Matters/ }));

    expect(await screen.findByText("Smith v. Jones")).toBeInTheDocument();
    expect(screen.queryByText(/Keep typing to narrow/)).not.toBeInTheDocument();
  });

  it("keeps the note off the file listing, which is a separate read", async () => {
    mockLookupMatters.mockResolvedValue({ items: [{ id: "m1", label: "Smith v. Jones" }], hasMore: true });
    const user = userEvent.setup();

    render(React.createElement(MessageFilePicker, { ...baseProps }));
    await user.click(screen.getByRole("button", { name: /Matters/ }));
    await screen.findByText(NOTE);

    // Drilling into the matter swaps the picker list for that matter's files.
    await user.click(screen.getByText("Smith v. Jones"));

    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    expect(screen.queryByText(/Keep typing to narrow/)).not.toBeInTheDocument();
  });

  it("keeps each scope's note with its own list", async () => {
    mockLookupMatters.mockResolvedValue({ items: [{ id: "m1", label: "Smith v. Jones" }], hasMore: true });
    const user = userEvent.setup();

    render(React.createElement(MessageFilePicker, { ...baseProps }));
    await user.click(screen.getByRole("button", { name: /Matters/ }));
    await screen.findByText(NOTE);

    await user.click(screen.getByRole("button", { name: /Clients/ }));

    expect(await screen.findByText("Alice Smith")).toBeInTheDocument();
    expect(screen.queryByText(/Keep typing to narrow/)).not.toBeInTheDocument();
  });

  it("re-queries the matters list as the user types, with no Enter or button needed", async () => {
    mockLookupMatters.mockResolvedValue({ items: [{ id: "m1", label: "Smith v. Jones" }], hasMore: true });
    const user = userEvent.setup();

    render(React.createElement(MessageFilePicker, { ...baseProps }));
    await user.click(screen.getByRole("button", { name: /Matters/ }));
    expect(await screen.findByText(NOTE)).toBeInTheDocument();
    expect(mockLookupMatters).toHaveBeenCalledTimes(1);

    // Typing alone (debounced, no Enter or button) re-queries the server -
    // matching every other lookup box in the app, unlike the file-content
    // search below it, which stays submit-only.
    await user.type(screen.getByPlaceholderText("Search matters..."), "smith");

    await waitFor(() =>
      expect(mockLookupMatters).toHaveBeenLastCalledWith(
        "law-firm-1",
        expect.objectContaining({ search: "smith" }),
      )
    );
    expect(await screen.findByText(SEARCH_NOTE)).toBeInTheDocument();
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
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

    render(React.createElement(MessageFilePicker, { ...baseProps }));
    await user.click(screen.getByRole("button", { name: /Matters/ }));
    await waitFor(() => expect(mockLookupMatters).toHaveBeenCalledTimes(1));

    const input = screen.getByPlaceholderText("Search matters...");
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

  it("drops the note when the lookup fails", async () => {
    mockLookupMatters.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();

    render(React.createElement(MessageFilePicker, { ...baseProps }));
    await user.click(screen.getByRole("button", { name: /Matters/ }));

    expect(await screen.findByText("No matters available.")).toBeInTheDocument();
    expect(screen.queryByText(/Keep typing to narrow/)).not.toBeInTheDocument();
  });
});

describe("MessageFilePicker tab-switch race", () => {
  beforeEach(() => {
    mockListFolderFiles.mockReset();
    mockLookupMatters.mockReset();
    mockLookupMatters.mockResolvedValue({ items: [{ id: "m1", label: "Smith v. Jones" }], hasMore: false });
  });

  // Opening the modal starts loading the Firm files tab. The tab buttons and
  // matter list stay clickable during that fetch (only the file/folder area
  // itself shows a spinner), so switching to Matters and opening one before
  // the firm-root fetch resolves used to race: a slow firm-root response
  // landing after the matter's files could silently replace them.
  it("keeps the matter's files on screen, even when the firm tab's slower response arrives after it", async () => {
    let call = 0;
    mockListFolderFiles.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return new Promise((resolve) =>
          setTimeout(() => resolve({ files: [{ objectPath: "p/firm-file.pdf", name: "Firm-File.pdf", isFolder: false, size: 10 }] }), 80)
        );
      }
      return new Promise((resolve) =>
        setTimeout(() => resolve({ files: [{ objectPath: "p/matter-file.pdf", name: "Matter-File.pdf", isFolder: false, size: 10 }] }), 10)
      );
    });

    render(React.createElement(MessageFilePicker, { ...baseProps }));

    fireEvent.click(screen.getByRole("button", { name: /Matters/ }));
    fireEvent.click(await screen.findByText("Smith v. Jones"));

    await waitFor(() => expect(screen.getByText("Matter-File.pdf")).toBeInTheDocument());

    // Give the firm tab's slower, now-stale response time to land too.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.getByText("Matter-File.pdf")).toBeInTheDocument();
    expect(screen.queryByText("Firm-File.pdf")).not.toBeInTheDocument();
  });
});
