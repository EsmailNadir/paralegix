import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installApiMock, type ApiMock } from "../../support/apiMock";

jest.unmock("@/services/templates.service");
jest.unmock("@/services/requestDeduplicator");

// jsdom has no `URL.createObjectURL`/`revokeObjectURL`, which the HTML preview
// branch (`useTemplatePreview`'s `loadHtmlPreview`) needs to hand the iframe a
// blob URL. Scoped to this file only; it does not touch the real DOM API.
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = jest.fn(() => "blob:mock-url");
}
if (typeof URL.revokeObjectURL !== "function") {
  URL.revokeObjectURL = jest.fn();
}

const mockUseQuery = jest.fn();

// Mock react-query
jest.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useQueryClient: () => ({ invalidateQueries: jest.fn(), setQueryData: jest.fn() }),
}));

// Mock sub-components. `mockFillModal` records what it was rendered with, so a
// spec can prove the modal was (or was not) told to open, rather than only that
// a click handler was invoked.
const mockFillModal = jest.fn((_props: Record<string, unknown>) => null);
jest.mock("@/components/templatesComp/FillTemplateModal", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => mockFillModal(props),
}));

// Same idea for the preview modal: capture what it was told to show, so a
// spec can prove WHICH template's preview ended up on screen, not just that a
// click handler fired.
const mockPreviewModal = jest.fn((_props: Record<string, unknown>) => null);
jest.mock("@/components/templatesComp/TemplatePreviewModal", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => mockPreviewModal(props),
}));

import TemplatesWorkspace from "@/components/templatesComp/TemplatesWorkspace";

function mockLibrary(
  templates: Record<string, unknown>[],
  folders: Record<string, unknown>[] = []
) {
  mockUseQuery.mockImplementation(({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "templates") return { data: templates, isLoading: false };
    if (queryKey[0] === "templateFolders") return { data: folders, isLoading: false };
    return { data: [], isLoading: false };
  });
}

const FOLDER = {
  id: "folder-1",
  name: "Contracts",
  color: null,
  parentFolderId: null,
  order: 0,
  createdAt: "2026-04-01T00:00:00.000Z",
};

const TEMPLATE_IN_FOLDER = {
  id: "template-1",
  name: "Engagement Letter",
  fields: ["client_name"],
  folderId: "folder-1",
  createdAt: "2026-04-08T00:00:00.000Z",
};

const TEMPLATE_AT_ROOT = { ...TEMPLATE_IN_FOLDER, folderId: null };

const TEMPLATE_B = {
  id: "template-2",
  name: "Retainer Agreement",
  fields: [],
  folderId: null,
  createdAt: "2026-04-09T00:00:00.000Z",
};

describe("TemplatesWorkspace", () => {
  beforeEach(() => {
    mockLibrary([]);
  });

  const defaultProps = {
    lawFirmId: "test-law-firm-id",
    initialTab: "all" as const,
    onOverlayCreated: jest.fn(),
    onEditTemplate: jest.fn(),
  };

  it("leads with the create panel", () => {
    render(React.createElement(TemplatesWorkspace, defaultProps));
    expect(
      screen.getByRole("button", { name: "Create a template from a document" })
    ).toBeInTheDocument();
  });

  it("shows empty state when no templates", () => {
    render(React.createElement(TemplatesWorkspace, defaultProps));
    expect(screen.getByText("No templates yet")).toBeInTheDocument();
  });

  it("shows fill and per-row actions for every template, whatever folder it is in", () => {
    mockLibrary([TEMPLATE_IN_FOLDER], [FOLDER]);

    render(React.createElement(TemplatesWorkspace, defaultProps));

    expect(screen.getByText("Engagement Letter")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fill Engagement Letter" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Actions for Engagement Letter" })
    ).toBeInTheDocument();
  });

  it("keeps the folder filter out of the way until the firm has folders", () => {
    mockLibrary([TEMPLATE_AT_ROOT]);

    render(React.createElement(TemplatesWorkspace, defaultProps));

    expect(screen.queryByLabelText("Filter by folder")).not.toBeInTheDocument();
  });

  it("offers a folder filter once folders exist", () => {
    mockLibrary([TEMPLATE_IN_FOLDER], [FOLDER]);

    render(React.createElement(TemplatesWorkspace, defaultProps));

    expect(screen.getByLabelText("Filter by folder")).toBeInTheDocument();
  });

  it("browses folders as cards on the Folders tab", () => {
    mockLibrary([TEMPLATE_IN_FOLDER], [FOLDER]);

    render(React.createElement(TemplatesWorkspace, defaultProps));
    fireEvent.click(screen.getByRole("button", { name: /Folders/ }));

    const card = screen.getByRole("button", { name: /^Contracts:/ });
    expect(card).toBeInTheDocument();

    // Opening the folder shows what is filed in it.
    fireEvent.click(card);
    expect(screen.getByText("Filed in Contracts.")).toBeInTheDocument();
    expect(screen.getByText("Engagement Letter")).toBeInTheDocument();
  });

  // Folders are optional. A firm that has filed nothing still gets its library on
  // the Folders tab, rather than an empty box that hides every template it owns.
  it("lists the unfiled library on the Folders tab when there are no folders", () => {
    mockLibrary([TEMPLATE_AT_ROOT]);

    render(React.createElement(TemplatesWorkspace, defaultProps));
    fireEvent.click(screen.getByRole("button", { name: /Folders/ }));

    expect(screen.getByText(/None are in a folder yet/)).toBeInTheDocument();
    expect(screen.getByText("Engagement Letter")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New folder/ })).toBeInTheDocument();
  });
});

describe("TemplatesWorkspace - preview/fill race", () => {
  let api: ApiMock;

  beforeEach(() => {
    mockLibrary([TEMPLATE_AT_ROOT]);
    api = installApiMock();
    mockFillModal.mockClear();
    mockPreviewModal.mockClear();
  });

  afterEach(() => {
    api.restore();
  });

  const defaultProps = {
    lawFirmId: "test-law-firm-id",
    initialTab: "all" as const,
    onOverlayCreated: jest.fn(),
    onEditTemplate: jest.fn(),
  };

  it("disables Fill while this row's preview is still loading, so a fast second click can't open both", async () => {
    api.get(`/templates/${TEMPLATE_AT_ROOT.id}`, {
      body: { template: { ...TEMPLATE_AT_ROOT, html: "<p>Body</p>" } },
      delayMs: 50,
    });

    render(React.createElement(TemplatesWorkspace, defaultProps));

    fireEvent.click(screen.getByText("Engagement Letter"));

    const fillButton = screen.getByRole("button", { name: "Fill Engagement Letter" });
    expect(fillButton).toBeDisabled();

    fireEvent.click(fillButton);
    expect(mockFillModal).not.toHaveBeenCalledWith(expect.objectContaining({ open: true }));

    await waitFor(() => expect(fillButton).not.toBeDisabled());
  });

  it("keeps the most recently clicked template's preview, even when an earlier click's slower response arrives after it", async () => {
    mockLibrary([TEMPLATE_AT_ROOT, TEMPLATE_B]);
    // Template A is the SLOWER response: it is requested first but resolves last,
    // which is exactly the ordering that lets a stale response win without a guard.
    api.get(`/templates/${TEMPLATE_AT_ROOT.id}`, {
      body: { template: { ...TEMPLATE_AT_ROOT, html: "<p>A</p>" } },
      delayMs: 80,
    });
    api.get(`/templates/${TEMPLATE_B.id}`, {
      body: { template: { ...TEMPLATE_B, html: "<p>B</p>" } },
      delayMs: 10,
    });

    render(React.createElement(TemplatesWorkspace, defaultProps));

    fireEvent.click(screen.getByText("Engagement Letter"));
    fireEvent.click(screen.getByText("Retainer Agreement"));

    await waitFor(() =>
      expect(mockPreviewModal).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Retainer Agreement" })
      )
    );

    // Give template A's slower, now-stale response time to land too.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const lastCall = mockPreviewModal.mock.calls[mockPreviewModal.mock.calls.length - 1][0];
    expect(lastCall.name).toBe("Retainer Agreement");
  });
});

describe("TemplatesWorkspace - move", () => {
  let api: ApiMock;

  beforeEach(() => {
    mockLibrary([TEMPLATE_IN_FOLDER], [FOLDER]);
    api = installApiMock();
  });

  afterEach(() => {
    api.restore();
  });

  // Goes red if a refused move is reported on the page behind the dialog
  // instead of inside it, or if the refusal closes the dialog.
  it("shows a refused move inside the still-open move dialog", async () => {
    api.put(`/templates/${TEMPLATE_IN_FOLDER.id}`, {
      status: 409,
      body: { error: "A template with that name is already in that folder" },
    });

    render(
      React.createElement(TemplatesWorkspace, {
        lawFirmId: "test-law-firm-id",
        initialTab: "all" as const,
        onOverlayCreated: jest.fn(),
        onEditTemplate: jest.fn(),
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions for Engagement Letter" }));
    fireEvent.click(await screen.findByText("Move to folder"));
    const dialog = await screen.findByRole("dialog");
    // The template sits in Contracts; Root is somewhere else to move it to.
    fireEvent.click(within(dialog).getByRole("button", { name: "Root" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Move here" }));

    expect(
      await within(dialog).findByText("A template with that name is already in that folder")
    ).toBeInTheDocument();
    expect(api.callsTo(`/templates/${TEMPLATE_IN_FOLDER.id}`)).toHaveLength(1);
    expect(screen.getByRole("dialog")).toBe(dialog);
  });
});
