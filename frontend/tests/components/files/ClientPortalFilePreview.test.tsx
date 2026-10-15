/**
 * `ClientPortalFilePreview`: shows a firm member EXACTLY what a client sees
 * in their portal. The panel's own copy makes the promise explicit ("Exactly
 * what this client sees"), so every rule here is a disclosure rule - showing
 * the wrong thing here means a firm member believes the client can or
 * cannot see something they actually cannot or can.
 *
 * Rules that break that promise if they slip:
 *
 *   GROUPING MUST MIRROR THE REAL PORTAL. A file with no matterId (the
 *   client's own file area, or a standalone task's share) must collapse into
 *   the SAME "Client files" bucket the portal uses - never its own group,
 *   which the real portal never shows.
 *
 *   "VIA FOLDER" VS. DIRECTLY SHARED. A file visible only because its
 *   containing folder is shared must show "Via folder" with no individual
 *   unshare control - unsharing it directly would do nothing (the file
 *   carries no clientVisible flag of its own to clear).
 *
 *   UN-SHARING ROUTES BY THE ITEM'S OWN contextType/entityId, never a fixed
 *   scope - unsharing a task-sourced file under the matter scope (or vice
 *   versa) would either fail silently or unshare the wrong parent.
 *
 *   ACTIONS ARE PERMISSION-GATED. Without `files.upload`, no unshare control
 *   and no "add files" action should render at all.
 */
const mockListClientVisibleDocuments = jest.fn();
const mockSetClientVisibility = jest.fn();
const mockGetMattersPaged = jest.fn();
let mockHasPermission: (perm: string) => boolean = () => true;

jest.mock("@/services/files.service", () => ({
  __esModule: true,
  default: {
    listClientVisibleDocuments: (...args: unknown[]) => mockListClientVisibleDocuments(...args),
    setClientVisibility: (...args: unknown[]) => mockSetClientVisibility(...args),
  },
}));

jest.mock("@/services/matters.service", () => ({
  __esModule: true,
  default: {
    getMattersPaged: (...args: unknown[]) => mockGetMattersPaged(...args),
  },
}));

jest.mock("@/contexts/PermissionsContext", () => ({
  __esModule: true,
  usePermissions: () => ({ hasPermission: (perm: string) => mockHasPermission(perm) }),
}));

jest.mock("@/components/filesComp/FilePreviewModal", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/filesComp/FileUpload", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/filesComp/ClientShareFilePicker", () => ({ __esModule: true, default: () => null }));

import React from "react";
import { screen, fireEvent, waitFor, waitForElementToBeRemoved } from "@testing-library/react";
import ClientPortalFilePreview from "@/components/filesComp/ClientPortalFilePreview";
import { renderWithProviders } from "../../support/renderWithProviders";
import type { ClientVisibleDocument } from "@/services/files.service";

function doc(overrides: Partial<ClientVisibleDocument>): ClientVisibleDocument {
  return {
    id: "doc-1",
    contextType: "client",
    entityId: "client-1",
    matterId: null,
    name: "file.pdf",
    objectPath: "lawfirmids/firm-1/clients/client-1/file.pdf",
    type: "application/pdf",
    size: 1024,
    uploadedAt: "2026-09-01T00:00:00.000Z",
    downloadUrl: "https://example.test/file.pdf",
    sourceLabel: "Client files",
    directlyShared: true,
    ...overrides,
  } as ClientVisibleDocument;
}

async function renderPreview(documents: ClientVisibleDocument[], sharedFolders: any[] = []) {
  mockListClientVisibleDocuments.mockResolvedValue({ documents, sharedFolders, truncated: false });
  mockGetMattersPaged.mockResolvedValue({ matters: [{ id: "matter-1", name: "Estate of Rivera" }] });
  const result = renderWithProviders(
    <ClientPortalFilePreview lawFirmId="firm-1" clientId="client-1" />,
  );
  await waitForElementToBeRemoved(() => screen.queryByRole("status", { name: "Loading" }));
  return result;
}

beforeEach(() => {
  mockListClientVisibleDocuments.mockReset();
  mockSetClientVisibility.mockReset().mockResolvedValue({ message: "ok", objectPath: "", clientVisible: false });
  mockGetMattersPaged.mockReset();
  mockHasPermission = () => true;
});

describe("grouping mirrors the real portal", () => {
  it("collapses a client-owned file and a standalone-task file into one 'Client files' bucket", async () => {
    await renderPreview([
      doc({ id: "d1", contextType: "client", entityId: "client-1", matterId: null, name: "own-file.pdf" }),
      doc({ id: "d2", contextType: "task", entityId: "task-1", matterId: null, name: "task-file.pdf" }),
      doc({ id: "d3", contextType: "matter", entityId: "matter-1", matterId: "matter-1", name: "matter-file.pdf" }),
    ]);

    await waitFor(() => expect(screen.getByText("Client files")).toBeInTheDocument());
    expect(screen.getByText("2 files")).toBeInTheDocument(); // client + task doc together
    expect(screen.getByText("Estate of Rivera")).toBeInTheDocument();
    expect(screen.getByText("1 file")).toBeInTheDocument(); // the matter doc alone
  });
});

describe("folder depth", () => {
  it("shows only the immediate child at the current level, not deeper nested files", async () => {
    await renderPreview([
      doc({ id: "d1", contextType: "client", entityId: "client-1", matterId: null, name: "contracts/nda.pdf" }),
      doc({ id: "d2", contextType: "client", entityId: "client-1", matterId: null, name: "contracts/2024/deep.pdf" }),
    ]);

    fireEvent.click(screen.getByText("Client files"));
    await waitFor(() => expect(screen.getByText("contracts")).toBeInTheDocument());
    // At the root of "Client files": one folder ("contracts"), no bare files yet.
    expect(screen.queryByText("nda.pdf")).not.toBeInTheDocument();
    expect(screen.queryByText("deep.pdf")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("contracts"));
    await waitFor(() => expect(screen.getByText("nda.pdf")).toBeInTheDocument());
    // One level down: the direct file shows, the doubly-nested one is still
    // folded into its own subfolder, not surfaced as a bare file here.
    expect(screen.queryByText("deep.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("2024")).toBeInTheDocument();
  });
});

describe("directly shared vs. via-folder disclosure", () => {
  it("offers an unshare control for a directly-shared file, and none for one visible only via a shared folder", async () => {
    await renderPreview([
      doc({ id: "d1", contextType: "client", entityId: "client-1", matterId: null, name: "solo.pdf", directlyShared: true }),
      doc({
        id: "d2", contextType: "client", entityId: "client-1", matterId: null,
        name: "shared-folder/inside.pdf", directlyShared: false, viaFolderPath: "shared-folder/",
      } as Partial<ClientVisibleDocument>),
    ]);

    fireEvent.click(screen.getByText("Client files"));
    await waitFor(() => expect(screen.getByText("solo.pdf")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Visible" })).toBeInTheDocument();

    fireEvent.click(screen.getByText("shared-folder"));
    await waitFor(() => expect(screen.getByText("inside.pdf")).toBeInTheDocument());
    expect(screen.getByText("Via folder")).toBeInTheDocument();
    // Exactly one unshare control exists in this whole view: the one for
    // "solo.pdf" from the root level, none for the via-folder file.
    expect(screen.queryAllByRole("button", { name: "Visible" })).toHaveLength(0);
  });
});

describe("un-sharing routes by the item's own scope", () => {
  it("unshares a TASK-sourced file under a task scope, not a matter or client scope", async () => {
    await renderPreview([
      doc({ id: "d1", contextType: "task", entityId: "task-1", matterId: null, name: "task-file.pdf", directlyShared: true }),
    ]);

    fireEvent.click(screen.getByText("Client files"));
    await waitFor(() => expect(screen.getByText("task-file.pdf")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Visible" }));

    await waitFor(() => expect(mockSetClientVisibility).toHaveBeenCalledTimes(1));
    const [{ scope, clientVisible }] = mockSetClientVisibility.mock.calls[0];
    expect(scope).toEqual({ type: "task", taskId: "task-1" });
    expect(clientVisible).toBe(false);
  });
});

describe("permission gating", () => {
  it("hides every sharing action when the caller lacks files.upload", async () => {
    mockHasPermission = () => false;
    await renderPreview([
      doc({ id: "d1", contextType: "client", entityId: "client-1", matterId: null, name: "solo.pdf", directlyShared: true }),
    ]);

    expect(screen.queryByRole("button", { name: /Upload for client/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Share existing files/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Client files"));
    await waitFor(() => expect(screen.getByText("solo.pdf")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Visible" })).not.toBeInTheDocument();
  });
});
