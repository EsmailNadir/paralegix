/**
 * Where "Create share link" is offered in the file browser's menus.
 *
 * A link can name a folder or a whole selection, so the entry sits in the
 * per-row menu for folders as well as files, and in the "N selected" menu.
 */

import { bulkActionsFor, rowActionsFor, type FileActionCapabilities } from "@/components/filesComp/fileActionMenus";
import type { FileInfo } from "@/services/files.service";

const file = (overrides: Partial<FileInfo>): FileInfo =>
  ({ id: "f1", name: "Brief.pdf", isFolder: false, clientVisible: false, ...overrides }) as FileInfo;

const caps = (overrides: Partial<FileActionCapabilities> = {}): FileActionCapabilities => ({
  canManageFolders: true,
  canDeleteFiles: true,
  canShareFiles: true,
  canShareWithClient: false,
  inheritedShared: false,
  pendingShareIds: new Set(),
  onCreateShareLink: jest.fn(),
  ...overrides,
});

const rowHandlers = {
  onOpen: jest.fn(), onDownload: jest.fn(), onToggleClientVisibility: jest.fn(),
  onRename: jest.fn(), onMove: jest.fn(), onChangeColor: jest.fn(), onDelete: jest.fn(),
};

const bulkHandlers = () => ({
  onSetClientVisibility: jest.fn(), onDownload: jest.fn(), onSendForSignature: jest.fn(),
  onMove: jest.fn(), onDelete: jest.fn(), onCreateShareLink: jest.fn(),
});

const keys = (actions: Array<{ key: string } | false | null | undefined>) =>
  actions.filter(Boolean).map((a) => (a as { key: string }).key);

describe("the selection menu", () => {
  it("offers a share link for the selection and hands it to the handler", () => {
    const handlers = bulkHandlers();
    const selected = [file({ id: "a", isFolder: true, name: "Discovery" }), file({ id: "b" })];

    const actions = bulkActionsFor(selected, caps(), handlers);
    const share = actions.find((a) => a && a.key === "share-link");

    expect(share).toBeTruthy();
    (share as { onClick: () => void }).onClick();
    expect(handlers.onCreateShareLink).toHaveBeenCalledTimes(1);
  });

  it("leaves it out for a member who cannot share files", () => {
    const actions = bulkActionsFor([file({})], caps({ canShareFiles: false }), bulkHandlers());

    expect(keys(actions)).not.toContain("share-link");
    // The menu itself still renders the rest, so the absence is the permission.
    expect(keys(actions)).toContain("download");
  });

  it("leaves it out on a surface without external links", () => {
    const actions = bulkActionsFor([file({})], caps({ onCreateShareLink: undefined }), bulkHandlers());

    expect(keys(actions)).not.toContain("share-link");
  });
});

describe("the row menu", () => {
  it("offers a share link on a folder", () => {
    const capabilities = caps();
    const folder = file({ id: "d1", isFolder: true, name: "Discovery" });

    const actions = rowActionsFor(folder, capabilities, rowHandlers);
    const share = actions.find((a) => a && a.key === "share-link");

    expect(share).toBeTruthy();
    (share as { onClick: () => void }).onClick();
    expect(capabilities.onCreateShareLink).toHaveBeenCalledWith(folder);
  });
});
