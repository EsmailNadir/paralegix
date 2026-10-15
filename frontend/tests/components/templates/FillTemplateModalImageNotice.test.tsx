/**
 * The fill dialog tells the person when their PDF is missing a template image.
 *
 * The export still produces a PDF when an image cannot be included (it is too
 * large, not an image, or no longer in storage), which is the right call for a
 * letter that is otherwise complete. What was wrong is that nothing said so:
 * the person found out by reading the document. The dialog closes once the
 * download starts, so the notice is a toast that outlives it.
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "../../setup";

const mockUseQuery = jest.fn();
jest.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useQueries: () => [],
}));
jest.mock("@/components/templatesComp/SaveToFilesModal", () => ({ __esModule: true, default: () => null }));
jest.mock("@/lib/utils/sanitizeHtml", () => ({
  __esModule: true,
  sanitizeRichHtml: (html?: string | null) => html ?? "",
}));

const mockRenderPdf = jest.fn();
jest.mock("@/services/templates.service", () => ({
  __esModule: true,
  ...jest.requireActual("@/services/templates.service"),
  templatesService: {
    getById: jest.fn(),
    renderPdf: (...args: unknown[]) => mockRenderPdf(...args),
  },
}));

import FillTemplateModal from "@/components/templatesComp/FillTemplateModal";

const template = {
  id: "template-1",
  name: "Engagement Letter",
  type: "html" as const,
  fields: [],
  repeaters: [],
  folderId: null,
  createdAt: "2026-04-09T00:00:00.000Z",
};

beforeEach(() => {
  mockRenderPdf.mockReset();
  mockUseQuery.mockImplementation(({ queryKey }: { queryKey: string[] }) => (
    queryKey[0] === "template-fill-detail"
      ? { data: { ...template, html: '<html><body><div class="pdf-page"></div></body></html>', assets: [] }, isLoading: false }
      : { data: undefined, isLoading: false }
  ));
  global.URL.createObjectURL = jest.fn(() => "blob:pdf");
  global.URL.revokeObjectURL = jest.fn();
});

const downloadPdf = async (skippedImages: number) => {
  mockRenderPdf.mockResolvedValue({ blob: new Blob(["%PDF-1.7"], { type: "application/pdf" }), skippedImages });
  const onClose = jest.fn();
  const { rerender } = render(<FillTemplateModal open template={template} lawFirmId="firm-1" onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  // What the parent does with that: the dialog closes, and stays mounted.
  rerender(<FillTemplateModal open={false} template={template} lawFirmId="firm-1" onClose={onClose} />);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
};

it("warns, after the download, that an image could not be included", async () => {
  await downloadPdf(1);

  expect(screen.getByRole("status")).toHaveTextContent(
    "The PDF was created, but 1 image couldn't be included. It may be too large or no longer available.",
  );
});

it("says nothing when every image made it in", async () => {
  await downloadPdf(0);

  expect(screen.queryByText(/couldn't be included/)).not.toBeInTheDocument();
});
