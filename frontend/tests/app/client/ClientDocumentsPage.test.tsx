import React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import "../../setup";
import { setupApiMock } from "../../support/apiMock";
import { renderWithProviders } from "../../support/renderWithProviders";

jest.unmock("@/services/client-portal.service");
jest.unmock("@/services/requestDeduplicator");

jest.mock("@/contexts/ClientPortalContext", () => ({
  __esModule: true,
  useClientPortal: () => ({
    associations: [],
    associationsLoading: false,
    activeAssociation: { clientRecordId: "record-1" },
    selectionRequired: false,
    setActiveClientRecordId: jest.fn(),
  }),
}));

// Captures what FilePreviewModal was told to show, so a spec can prove WHICH
// document ended up previewed, not just that a click handler fired.
const mockPreviewModal = jest.fn((_props: Record<string, unknown>) => null);
jest.mock("@/components/filesComp/FilePreviewModal", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => mockPreviewModal(props),
}));

import ClientDocumentsPage from "@/app/client/lawfirm/[lawFirmId]/documents/page";

describe("ClientDocumentsPage preview race", () => {
  const api = setupApiMock();

  beforeEach(() => {
    mockPreviewModal.mockClear();

    api.get("/documents", {
      documents: [
        {
          id: "doc-a",
          name: "Report-A.pdf",
          type: "application/pdf",
          size: 111,
          uploadedAt: "2026-04-01T00:00:00.000Z",
          downloadUrl: "",
          objectPath: "docs/a.pdf",
        },
        {
          id: "doc-b",
          name: "Report-B.pdf",
          type: "application/pdf",
          size: 222,
          uploadedAt: "2026-04-02T00:00:00.000Z",
          downloadUrl: "",
          objectPath: "docs/b.pdf",
        },
      ],
      folders: [],
      truncated: false,
    });
    api.get("/matters", { matters: [] });
    // RequestedDocumentsPanel renders alongside the document list; give it an
    // empty set so it renders nothing and stays out of this spec's way.
    api.get("/document-requests", { requests: [] });
  });

  it("keeps the most recently clicked document's preview, even when an earlier click's slower response arrives after it", async () => {
    // Document A is the SLOWER response: requested first, resolves last -
    // exactly the ordering that lets a stale response win without a guard.
    api.post("/documents/refresh-url", async (call) => {
      const objectPath = (call.body as { objectPath?: string } | null)?.objectPath;
      if (objectPath === "docs/a.pdf") {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { downloadUrl: "https://example.test/a.pdf" };
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { downloadUrl: "https://example.test/b.pdf" };
    });

    renderWithProviders(React.createElement(ClientDocumentsPage));

    await screen.findByPlaceholderText("Search documents…");
    fireEvent.change(screen.getByPlaceholderText("Search documents…"), { target: { value: "Report" } });

    await screen.findByText("Report-A.pdf");
    fireEvent.click(screen.getByText("Report-A.pdf"));
    fireEvent.click(screen.getByText("Report-B.pdf"));

    await waitFor(() =>
      expect(mockPreviewModal).toHaveBeenCalledWith(
        expect.objectContaining({ file: expect.objectContaining({ name: "Report-B.pdf" }) })
      )
    );

    // Give document A's slower, now-stale response time to land too.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const lastCall = mockPreviewModal.mock.calls[mockPreviewModal.mock.calls.length - 1][0] as {
      file: { name: string } | null;
    };
    expect(lastCall.file?.name).toBe("Report-B.pdf");
  });
});
