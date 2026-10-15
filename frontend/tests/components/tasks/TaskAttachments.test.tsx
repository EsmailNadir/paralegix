import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

// Captures what FilePreviewModal was told to show, so a spec can prove WHEN it
// opened (synchronously on click, vs. only after an awaited fetch resolves)
// rather than only that a click handler fired.
const mockPreviewModal = jest.fn((_props: Record<string, unknown>) => null);
jest.mock("@/components/filesComp/FilePreviewModal", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => mockPreviewModal(props),
}));

import TaskAttachments from "@/components/taskComp/TaskAttachments";
import type { TaskAttachment } from "@/types";

// The record's id IS the file row's, which is what lets the preview mint a
// fresh signed url from it.
const ATTACHMENT: TaskAttachment = {
  id: "8d4f2a10-0000-4000-8000-000000000001",
  name: "Contract.pdf",
  size: 2048,
  type: "application/pdf",
};

const defaultProps = {
  lawFirmId: "firm-1",
  taskId: "task-1",
  attachments: [ATTACHMENT],
  onAttachmentsChange: jest.fn(),
  showFileList: true,
};

describe("TaskAttachments preview", () => {
  beforeEach(() => {
    mockPreviewModal.mockClear();
  });

  // Clicking two different attachments quickly used to race: `handleView` awaited
  // a signed-url fetch and only opened the modal after it resolved, leaving the
  // attachment list clickable the whole time. Whichever fetch resolved last won,
  // so a slower first click's file could silently replace a faster second click's
  // file under the wrong name. Opening synchronously, before any fetch, removes
  // the window where that race could happen.
  it("opens the preview modal immediately on click, before any network fetch resolves", () => {
    render(React.createElement(TaskAttachments, defaultProps));

    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));

    expect(mockPreviewModal).toHaveBeenCalledWith(
      expect.objectContaining({
        isOpen: true,
        file: expect.objectContaining({
          name: "Contract.pdf",
          id: ATTACHMENT.id,
        }),
      })
    );
  });

  it("passes lawFirmId through so the modal can resolve the signed url itself", () => {
    render(React.createElement(TaskAttachments, defaultProps));

    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));

    expect(mockPreviewModal).toHaveBeenCalledWith(
      expect.objectContaining({ lawFirmId: "firm-1" })
    );
  });

  // An attachment with no file row behind it, only the url it was saved with.
  // It used to fall through to `window.open`. It must still show the popup,
  // using the url already on hand, rather than navigating away.
  it("opens the preview modal for an attachment with no file record, instead of a new tab", () => {
    const openSpy = jest.spyOn(window, "open").mockImplementation(() => null);
    const legacyAttachment: TaskAttachment = {
      id: "",
      name: "old-file.pdf",
      size: 512,
      type: "application/pdf",
      url: "https://example.test/old-file.pdf",
    };

    render(
      React.createElement(TaskAttachments, {
        ...defaultProps,
        attachments: [legacyAttachment],
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));

    expect(mockPreviewModal).toHaveBeenCalledWith(
      expect.objectContaining({
        isOpen: true,
        file: expect.objectContaining({
          name: "old-file.pdf",
          signedUrl: "https://example.test/old-file.pdf",
        }),
      })
    );
    expect(openSpy).not.toHaveBeenCalled();

    openSpy.mockRestore();
  });
});
