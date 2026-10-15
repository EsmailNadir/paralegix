/**
 * `FlattenPdfModal` while it animates closed.
 *
 * A successful flatten closes the dialog, and the busy flag is cleared in the
 * same update. The dialog stays on screen for its exit animation, so this reads
 * it while it carries the exit class: the action must still read as in flight,
 * not flip back to an enabled "Flatten and Upload" for a document already sent.
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFlattenPdf = jest.fn();

// pdf-lib is the flattening engine and is not what is under test here.
jest.mock("@/lib/pdfFlatten", () => ({
  __esModule: true,
  flattenPdf: (...args: unknown[]) => mockFlattenPdf(...args),
}));

import FlattenPdfModal from "@/components/signaturesComp/FlattenPdfModal";

const SOURCE = new File(["%PDF-1.7"], "Intake form.pdf", { type: "application/pdf" });

/** Mirrors `SignaturesWorkspace`: closing clears the file along with the flag. */
function Harness({ onSuccess }: { onSuccess: (file: File) => Promise<void> }) {
  const [file, setFile] = React.useState<File | null>(SOURCE);
  return (
    <FlattenPdfModal
      file={file}
      isOpen={!!file}
      onClose={() => setFile(null)}
      onSuccess={onSuccess}
    />
  );
}

describe("FlattenPdfModal closing", () => {
  beforeEach(() => {
    mockFlattenPdf.mockReset();
  });

  it("still reads as flattening while the dialog animates out after a successful upload", async () => {
    const flattened = new File(["%PDF-1.7"], "Intake form.pdf", { type: "application/pdf" });
    mockFlattenPdf.mockResolvedValue({ file: flattened });
    const onSuccess = jest.fn().mockResolvedValue(undefined);

    render(<Harness onSuccess={onSuccess} />);

    const dialog = screen.getByRole("dialog", { name: "Flatten Document for Signing" });
    fireEvent.click(screen.getByRole("button", { name: "Flatten and Upload" }));

    await waitFor(() => expect(dialog).toHaveClass("overlay-card-exit"));
    expect(onSuccess).toHaveBeenCalledWith(flattened);
    expect(screen.getByRole("button", { name: /Flattening document/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Flatten and Upload" })).not.toBeInTheDocument();
    expect(screen.getByText("Intake form.pdf")).toBeInTheDocument();
  });

  it("clears the busy state and shows the reason when flattening fails", async () => {
    mockFlattenPdf.mockRejectedValue(new Error("This PDF is encrypted."));

    render(<Harness onSuccess={jest.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Flatten and Upload" }));

    expect(await screen.findByText("This PDF is encrypted.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Flatten and Upload" })).toBeEnabled();
    expect(screen.getByRole("dialog", { name: "Flatten Document for Signing" })).not.toHaveClass("overlay-card-exit");
  });
});
