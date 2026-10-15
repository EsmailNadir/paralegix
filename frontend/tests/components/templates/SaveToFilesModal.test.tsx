import React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";

const mockLookupMatters = jest.fn();
const mockLookupClients = jest.fn();
const mockLookupTasks = jest.fn();

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
    listMatterFiles: jest.fn().mockResolvedValue({ files: [] }),
    listLawFirmFiles: jest.fn().mockResolvedValue({ files: [] }),
    listFolderFiles: jest.fn().mockResolvedValue({ files: [] }),
    createFolder: jest.fn().mockResolvedValue({}),
  },
}));

import SaveToFilesModal from "@/components/templatesComp/SaveToFilesModal";

const baseProps = {
  open: true,
  onClose: jest.fn(),
  onConfirm: jest.fn(),
  lawFirmId: "law-firm-1",
  defaultFileName: "Engagement Letter",
};

const NOTE = "More results available. Keep typing to narrow.";

describe("SaveToFilesModal entity lists", () => {
  beforeEach(() => {
    mockLookupMatters.mockReset();
    mockLookupClients.mockReset();
    mockLookupTasks.mockReset();
    mockLookupMatters.mockResolvedValue({ items: [{ id: "m1", label: "Smith v. Jones", name: "Smith v. Jones" }], hasMore: false });
    mockLookupClients.mockResolvedValue({ items: [{ id: "c1", label: "Alice Smith", name: "Alice Smith" }], hasMore: false });
    mockLookupTasks.mockResolvedValue({ items: [{ id: "t1", label: "File motion", status: "open" }], hasMore: false });
  });

  it("shows matter placeholders until the initial lookup resolves", async () => {
    let releaseMatters: ((value: unknown) => void) | undefined;
    mockLookupMatters.mockImplementationOnce(() => new Promise((resolve) => { releaseMatters = resolve; }));

    render(React.createElement(SaveToFilesModal, { ...baseProps }));
    expect(screen.getByRole("status", { name: "Loading matters" })).toBeInTheDocument();
    expect(screen.queryByText("No matters found")).not.toBeInTheDocument();

    releaseMatters?.({ items: [{ id: "m1", name: "Smith v. Jones" }], hasMore: false });
    expect(await screen.findByText("Smith v. Jones")).toBeInTheDocument();
  });

  it("notes that the matter list is capped when the lookup has more", async () => {
    mockLookupMatters.mockResolvedValue({
      items: [{ id: "m1", label: "Smith v. Jones", name: "Smith v. Jones" }],
      hasMore: true,
    });

    render(React.createElement(SaveToFilesModal, { ...baseProps }));

    expect(await screen.findByText(NOTE)).toBeInTheDocument();
  });

  it("notes truncation on the tasks list too", async () => {
    mockLookupTasks.mockResolvedValue({ items: [{ id: "t1", label: "File motion", status: "open" }], hasMore: true });
    const user = userEvent.setup();

    render(React.createElement(SaveToFilesModal, { ...baseProps }));
    await screen.findByText("Smith v. Jones");
    await user.click(screen.getByRole("button", { name: "Tasks" }));

    expect(await screen.findByText(NOTE)).toBeInTheDocument();
  });

  it("notes truncation on the clients list too", async () => {
    mockLookupClients.mockResolvedValue({ items: [{ id: "c1", label: "Alice Smith", name: "Alice Smith" }], hasMore: true });
    const user = userEvent.setup();

    render(React.createElement(SaveToFilesModal, { ...baseProps }));
    await screen.findByText("Smith v. Jones");
    await user.click(screen.getByRole("button", { name: "Clients" }));

    expect(await screen.findByText(NOTE)).toBeInTheDocument();
  });

  it("renders exactly one note, not one per lookup", async () => {
    mockLookupMatters.mockResolvedValue({
      items: [{ id: "m1", label: "Smith v. Jones", name: "Smith v. Jones" }],
      hasMore: true,
    });
    mockLookupTasks.mockResolvedValue({ items: [{ id: "t1", label: "File motion", status: "open" }], hasMore: true });
    mockLookupClients.mockResolvedValue({ items: [{ id: "c1", label: "Alice Smith", name: "Alice Smith" }], hasMore: true });

    render(React.createElement(SaveToFilesModal, { ...baseProps }));

    await screen.findByText(NOTE);
    expect(screen.getAllByText(NOTE)).toHaveLength(1);
  });

  it("does not carry a truncated tab's note onto the next tab", async () => {
    mockLookupMatters.mockResolvedValue({
      items: [{ id: "m1", label: "Smith v. Jones", name: "Smith v. Jones" }],
      hasMore: true,
    });
    const user = userEvent.setup();

    render(React.createElement(SaveToFilesModal, { ...baseProps }));
    expect(await screen.findByText(NOTE)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clients" }));

    expect(await screen.findByText("Alice Smith")).toBeInTheDocument();
    expect(screen.queryByText(/Keep typing to narrow/)).not.toBeInTheDocument();
  });

  it("shows no note when the lookup returned the complete list", async () => {
    render(React.createElement(SaveToFilesModal, { ...baseProps }));

    expect(await screen.findByText("Smith v. Jones")).toBeInTheDocument();
    expect(screen.queryByText(/Keep typing to narrow/)).not.toBeInTheDocument();
  });
});
