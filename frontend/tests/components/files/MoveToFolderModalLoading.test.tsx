import React from "react";
import { render, screen, waitFor } from "@testing-library/react";

const mockListFolder = jest.fn();
jest.mock("@/services/files.service", () => ({
  __esModule: true,
  default: { listFolder: (...args: unknown[]) => mockListFolder(...args) },
}));

import MoveToFolderModal from "@/components/filesComp/MoveToFolderModal";
import { FIRM_SCOPE } from "@/lib/files/fileScope";

it("waits for destination folders before showing an empty folder", async () => {
  let release: ((value: unknown) => void) | undefined;
  mockListFolder.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));

  render(<MoveToFolderModal
    isOpen
    onClose={jest.fn()}
    onMove={jest.fn()}
    itemName="document.pdf"
    excludeIds={["file-1"]}
    currentFolderId={null}
    lawFirmId="firm-1"
    scope={FIRM_SCOPE}
  />);

  expect(screen.getByRole("status", { name: "Loading folders" })).toBeInTheDocument();
  expect(screen.queryByText("No subfolders here")).not.toBeInTheDocument();
  await waitFor(() => expect(release).toBeDefined());
  release?.({ files: [] });
  expect(await screen.findByText("No subfolders here")).toBeInTheDocument();
});
