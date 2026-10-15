/**
 * `SigningPreviewModal` while it animates closed.
 *
 * Closing drops the loaded document and puts the loading flags and zoom back to
 * their opening state, and the caller clears the session it was showing in the
 * same update. The dialog stays on screen for its exit animation, so this reads
 * it while it carries the exit class: the document must still be there at the
 * zoom the reader left it, with no "Loading..." cover over it.
 *
 * The PDF viewer is a stub that reports the url and zoom it was handed, since
 * pdf.js cannot run under jsdom.
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/components/filesComp/PdfPreview", () => {
  const ReactActual = jest.requireActual("react");
  return {
    __esModule: true,
    default: function PdfPreviewStub({ url, zoom, onLoaded }: { url?: string; zoom: number; onLoaded?: () => void }) {
      ReactActual.useEffect(() => {
        onLoaded?.();
      }, [url]);
      return ReactActual.createElement(
        "div",
        { "data-testid": "pdf-preview", "data-url": url, "data-zoom": String(zoom) },
        "Rendered document",
      );
    },
  };
});

const mockGetSignedDocumentUrl = jest.fn();

jest.mock("@/services/signatures.service", () => ({
  __esModule: true,
  default: {
    getSignedDocumentUrl: (...args: unknown[]) => mockGetSignedDocumentUrl(...args),
    getCertificateUrl: jest.fn(),
  },
}));

import SigningPreviewModal from "@/components/signaturesComp/SigningPreviewModal";

/** Mirrors `SigningSessionList`: one target opens the preview, and closing clears it. */
function Harness() {
  const [target, setTarget] = React.useState<{ token: string; fileName: string } | null>({
    token: "session-token",
    fileName: "Engagement.pdf",
  });
  return (
    <SigningPreviewModal
      isOpen={!!target}
      kind="document"
      token={target?.token ?? null}
      fileName={target?.fileName ?? null}
      onClose={() => setTarget(null)}
      onDownload={() => {}}
    />
  );
}

describe("SigningPreviewModal closing", () => {
  beforeEach(() => {
    mockGetSignedDocumentUrl.mockReset().mockResolvedValue({ url: "https://storage.example/signed.pdf" });
  });

  it("keeps the loaded document at its zoom, with no loading cover, while the dialog animates out", async () => {
    render(<Harness />);

    const preview = await screen.findByTestId("pdf-preview");
    await waitFor(() => expect(screen.queryByText("Loading signed document...")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const zoomBeforeClose = screen.getByTestId("pdf-preview").getAttribute("data-zoom");
    expect(zoomBeforeClose).not.toBe("100");

    const dialog = screen.getByRole("dialog", { name: "Engagement.pdf" });
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));

    await waitFor(() => expect(dialog).toHaveClass("overlay-card-exit"));
    expect(screen.getByTestId("pdf-preview")).toBe(preview);
    expect(preview).toHaveAttribute("data-url", "https://storage.example/signed.pdf");
    expect(preview).toHaveAttribute("data-zoom", zoomBeforeClose);
    expect(screen.queryByText("Loading signed document...")).not.toBeInTheDocument();
  });
});
