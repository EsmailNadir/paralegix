/**
 * `FlattenPdfModal` with a PDF too large to flatten in the browser.
 *
 * Flattening loads the whole file with pdf-lib and writes a second copy, both
 * in the tab. Past the ceiling the dialog says so before the person tries, and
 * offers the manual route, rather than letting a click freeze the browser.
 */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

const mockFlattenPdf = jest.fn();

// The real ceiling; only the engine is replaced.
jest.mock("@/lib/pdfFlatten", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/pdfFlatten"),
  flattenPdf: (...args: unknown[]) => mockFlattenPdf(...args),
}));

import FlattenPdfModal from "@/components/signaturesComp/FlattenPdfModal";

const MB = 1024 * 1024;

function pdfOfSize(bytes: number) {
  const file = new File(["%PDF-1.7"], "Intake form.pdf", { type: "application/pdf" });
  Object.defineProperty(file, "size", { value: bytes });
  return file;
}

const renderModal = (file: File) => render(
  <FlattenPdfModal file={file} isOpen onClose={jest.fn()} onSuccess={jest.fn()} />,
);

describe("FlattenPdfModal with a large PDF", () => {
  beforeEach(() => {
    mockFlattenPdf.mockReset();
  });

  it("explains the limit and the manual route up front, and will not start", () => {
    renderModal(pdfOfSize(80 * MB));

    expect(screen.getByText(
      "This PDF is 80 MB. Forms can be flattened in your browser up to 50 MB. "
      + "Open it in your PDF viewer and choose File > Print > Save as PDF to flatten it, then upload that copy.",
    )).toBeInTheDocument();
    const flatten = screen.getByRole("button", { name: "Flatten and Upload" });
    expect(flatten).toBeDisabled();

    fireEvent.click(flatten);
    expect(mockFlattenPdf).not.toHaveBeenCalled();
  });

  it("offers flattening as before under the limit", () => {
    renderModal(pdfOfSize(10 * MB));

    expect(screen.queryByText(/can be flattened in your browser up to/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Flatten and Upload" })).toBeEnabled();
  });
});
