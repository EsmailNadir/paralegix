/**
 * `SignActionModal`: sending a document out for signature.
 *
 * Rules that produce a wrong disclosure (the wrong artifact, or the wrong
 * recipient) if they slip:
 *
 *   A NON-PDF FILE MUST BE SIGNED AS ITS CONVERTED PDF, never as the
 *   original. Every send path (copy link, portal, email) must carry the
 *   `objectPath`/`fileName` `prepareForSigning` returns, not the props the
 *   modal was opened with.
 *
 *   THE PORTAL RECIPIENT IS THE PICKED CLIENT'S PORTAL UID, never the
 *   `clients` record id the picker's own `value` carries - the component's
 *   own comment says a signing request is addressed to the PERSON. Sending
 *   the wrong id either reaches nobody or reaches the wrong identity.
 *
 *   AN ACCESS CODE SHORTER THAN 4 CHARACTERS MUST BLOCK EVERY SEND PATH,
 *   not just show a hint - a code too weak to matter must never be silently
 *   accepted as if it protects anything.
 */
const mockPrepareForSigning = jest.fn();
const mockGenerateLink = jest.fn();
const mockSendSigningEmail = jest.fn();
const mockLookupClients = jest.fn();
const mockSendSigningRequest = jest.fn();
const mockGetDownloadUrl = jest.fn();
const mockUploadForSigning = jest.fn();
const mockFlattenPdf = jest.fn();

jest.mock("@/services/signatures.service", () => ({
  __esModule: true,
  default: {
    prepareForSigning: (...args: unknown[]) => mockPrepareForSigning(...args),
    uploadForSigning: (...args: unknown[]) => mockUploadForSigning(...args),
    generateLink: (...args: unknown[]) => mockGenerateLink(...args),
    sendSigningEmail: (...args: unknown[]) => mockSendSigningEmail(...args),
    sendSigningRequest: (...args: unknown[]) => mockSendSigningRequest(...args),
    listSigningTemplates: jest.fn().mockResolvedValue({ templates: [] }),
  },
}));

jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: {
    lookupClients: (...args: unknown[]) => mockLookupClients(...args),
  },
}));

jest.mock("@/services/files.service", () => ({
  __esModule: true,
  default: {
    getDownloadUrl: (...args: unknown[]) => mockGetDownloadUrl(...args),
  },
}));

jest.mock("@/lib/pdfFlatten", () => ({
  flattenPdf: (...args: unknown[]) => mockFlattenPdf(...args),
}));

// A minimal stand-in that lets a test trigger a real selection without
// driving EntityPicker's own typeahead (that component has its own specs).
jest.mock("@/components/ui/EntityPicker", () => ({
  __esModule: true,
  default: (props: any) => (
    <button
      type="button"
      onClick={() => {
        props.onChange("picked-client-record-id");
        props.onSelectItem?.({
          id: "picked-client-record-id",
          label: "Jane Client",
          userId: "portal-uid-1",
          name: "Jane Client",
          email: "jane@example.test",
        });
      }}
    >
      {props.placeholder}
    </button>
  ),
}));

jest.mock("@/components/signaturesComp/DestinationPickerModal", () => ({
  __esModule: true,
  default: () => null,
}));

import React from "react";
import { act, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SignActionModal from "@/components/signaturesComp/SignActionModal";
import { renderWithProviders } from "../../support/renderWithProviders";
import { deferred } from "../../support/deferred";

function renderModal(
  fileName: string,
  objectPath = "lawfirmids/firm-1/matter-1/file",
  fileId?: string,
) {
  return renderWithProviders(
    <SignActionModal
      isOpen
      onClose={jest.fn()}
      fileName={fileName}
      objectPath={objectPath}
      lawFirmId="firm-1"
      fileId={fileId}
    />,
  );
}

beforeEach(() => {
  mockPrepareForSigning.mockReset().mockResolvedValue({
    objectPath: "signing-uploads/firm-1/frozen/Agreement.pdf",
    fileName: "Agreement.pdf",
  });
  mockGenerateLink.mockReset().mockResolvedValue({ token: "tok-1" });
  mockSendSigningEmail.mockReset().mockResolvedValue({});
  mockLookupClients.mockReset().mockResolvedValue({ items: [{ id: "c1" }] });
  mockSendSigningRequest.mockReset().mockResolvedValue({ sent: true, sessionToken: "sess-1" });
  mockGetDownloadUrl.mockReset().mockResolvedValue("https://storage.test/interactive.pdf");
  mockUploadForSigning.mockReset().mockResolvedValue({
    objectPath: "signing-uploads/firm-1/flattened/Interactive_Intake.pdf",
    fileName: "Interactive Intake.pdf",
  });
  mockFlattenPdf.mockReset().mockImplementation(async (file: File) => ({ file, fieldsCount: 1 }));
});

describe("PDF vs. non-PDF source file", () => {
  it("opens the existing flatten modal when a file-manager PDF needs browser flattening", async () => {
    mockPrepareForSigning.mockRejectedValue(Object.assign(
      new Error("This PDF contains interactive form fields and must be flattened before signing."),
      { code: "PDF_REQUIRES_FLATTENING" },
    ));
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(new Blob(["pdf-bytes"], { type: "application/pdf" }), { status: 200 }),
    );
    renderModal(
      "Interactive Intake.pdf",
      "lawfirmids/firm-1/matter-1/interactive-object",
      "file-123",
    );

    fireEvent.click(screen.getByRole("button", { name: /Guided signing/ }));

    expect(await screen.findByRole("dialog", { name: "Flatten Document for Signing" })).toBeInTheDocument();
    expect(mockPrepareForSigning).toHaveBeenCalledWith(
      "firm-1",
      "lawfirmids/firm-1/matter-1/interactive-object",
      "Interactive Intake.pdf",
      true,
    );
    expect(mockGetDownloadUrl).toHaveBeenCalledWith("firm-1", "file-123");
    expect(screen.queryByText("Interactive PDF fields are flattened automatically when present.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Flatten and Upload" }));
    await waitFor(() => expect(mockUploadForSigning).toHaveBeenCalledTimes(1));
    expect(mockUploadForSigning.mock.calls[0][0]).toBeInstanceOf(File);
    expect(mockUploadForSigning.mock.calls[0][1]).toBe("firm-1");
    expect(await screen.findByRole("dialog", { name: "Document Signing" })).toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  it("prepares a .pdf before guided field placement so interactive fields are flattened first", async () => {
    mockPrepareForSigning.mockResolvedValue({
      objectPath: "signing-uploads/firm-1/frozen/Agreement.pdf",
      fileName: "Agreement.pdf",
    });
    renderModal("Agreement.pdf", "lawfirmids/firm-1/matter-1/Agreement.pdf");

    fireEvent.click(screen.getByRole("button", { name: /Guided signing/ }));

    await waitFor(() => expect(mockPrepareForSigning).toHaveBeenCalledTimes(1));
    expect(mockPrepareForSigning).toHaveBeenCalledWith(
      "firm-1",
      "lawfirmids/firm-1/matter-1/Agreement.pdf",
      "Agreement.pdf",
      false,
    );
  });

  it("sends the CONVERTED path/name for a non-PDF, never the original", async () => {
    mockPrepareForSigning.mockResolvedValue({
      objectPath: "lawfirmids/firm-1/matter-1/converted/Agreement.pdf",
      fileName: "Agreement.pdf",
    });
    renderModal("Agreement.docx", "lawfirmids/firm-1/matter-1/Agreement.docx");

    fireEvent.click(screen.getByRole("button", { name: /Open signing/ }));
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));

    await waitFor(() => expect(mockGenerateLink).toHaveBeenCalledTimes(1));
    expect(mockPrepareForSigning).toHaveBeenCalledWith(
      "firm-1",
      "lawfirmids/firm-1/matter-1/Agreement.docx",
      "Agreement.docx",
      false,
    );
    expect(mockGenerateLink.mock.calls[0][1]).toBe("lawfirmids/firm-1/matter-1/converted/Agreement.pdf");
    expect(mockGenerateLink.mock.calls[0][2]).toBe("Agreement.pdf");
  });

  it("converts only once even when two send actions are used in the same session", async () => {
    mockPrepareForSigning.mockResolvedValue({
      objectPath: "lawfirmids/firm-1/matter-1/converted/Agreement.pdf",
      fileName: "Agreement.pdf",
    });
    renderModal("Agreement.docx");

    fireEvent.click(screen.getByRole("button", { name: /Open signing/ }));
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));
    await waitFor(() => expect(mockGenerateLink).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /Send to client portal/ }));
    await waitFor(() => expect(screen.getByText("Select a client...")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Select a client..."));
    fireEvent.click(screen.getByRole("button", { name: "Send to Portal" }));

    await waitFor(() => expect(mockSendSigningRequest).toHaveBeenCalledTimes(1));
    expect(mockPrepareForSigning).toHaveBeenCalledTimes(1);
  });
});

describe("reopening on another file", () => {
  it("never signs the next file with a conversion that was still running for the last one", async () => {
    let finishFirst: (value: { objectPath: string; fileName: string }) => void = () => {};
    mockPrepareForSigning
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce({
        objectPath: "lawfirmids/firm-1/matter-1/converted/Second.pdf",
        fileName: "Second.pdf",
      });
    const modalFor = (isOpen: boolean, fileName: string, objectPath: string) => (
      <SignActionModal
        isOpen={isOpen}
        onClose={jest.fn()}
        fileName={fileName}
        objectPath={objectPath}
        lawFirmId="firm-1"
      />
    );
    const { rerender } = renderWithProviders(
      modalFor(true, "First.docx", "lawfirmids/firm-1/matter-1/First.docx"),
    );

    fireEvent.click(screen.getByRole("button", { name: /Open signing/ }));
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));
    await waitFor(() => expect(mockPrepareForSigning).toHaveBeenCalledTimes(1));

    // Closed while the first conversion runs, then opened on another file.
    rerender(modalFor(false, "First.docx", "lawfirmids/firm-1/matter-1/First.docx"));
    rerender(modalFor(true, "Second.docx", "lawfirmids/firm-1/matter-1/Second.docx"));
    finishFirst({ objectPath: "lawfirmids/firm-1/matter-1/converted/First.pdf", fileName: "First.pdf" });
    await waitFor(() => expect(mockGenerateLink).toHaveBeenCalledTimes(1));

    if (!screen.queryByRole("button", { name: /Copy link/ })) {
      fireEvent.click(screen.getByRole("button", { name: /Open signing/ }));
    }
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));

    await waitFor(() => expect(mockGenerateLink).toHaveBeenCalledTimes(2));
    expect(mockGenerateLink.mock.calls[1][1]).toBe("lawfirmids/firm-1/matter-1/converted/Second.pdf");
    expect(mockGenerateLink.mock.calls[1][2]).toBe("Second.pdf");
  });
});

describe("sending to the client portal", () => {
  it("binds the signer to the picked client's portal uid, not the record id", async () => {
    renderModal("Agreement.pdf");

    fireEvent.click(screen.getByRole("button", { name: /Open signing/ }));
    fireEvent.click(screen.getByRole("button", { name: /Send to client portal/ }));
    await waitFor(() => expect(screen.getByText("Select a client...")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Select a client..."));
    fireEvent.click(screen.getByRole("button", { name: "Send to Portal" }));

    await waitFor(() => expect(mockSendSigningRequest).toHaveBeenCalledTimes(1));
    const { signers } = mockSendSigningRequest.mock.calls[0][1];
    expect(signers).toHaveLength(1);
    expect(signers[0]).toMatchObject({ deliveryMethod: "portal", clientUserId: "portal-uid-1" });
    expect(signers[0].clientUserId).not.toBe("picked-client-record-id");
  });
});

describe("the access-code gate", () => {
  it("blocks every send path when the code is 1-3 characters", async () => {
    renderModal("Agreement.pdf");

    fireEvent.click(screen.getByRole("button", { name: /Open signing/ }));
    await userEvent.type(screen.getByPlaceholderText("e.g. meeting2024"), "abc");
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));

    // Shown both as a live hint under the input and as the submit-time error;
    // either is fine, but at least one must be there.
    expect(screen.getAllByText(/Access code must be at least 4 characters/).length).toBeGreaterThan(0);
    // `handleCopyLink` is async: a synchronous check here would pass whether
    // or not the gate actually blocked it, since generateLink is awaited
    // behind ensureSigningPdf either way. Flush the microtask queue first so
    // a broken gate that let the call proceed has had the chance to fire it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockGenerateLink).not.toHaveBeenCalled();
  });

  it("allows a code of 4 or more characters through", async () => {
    renderModal("Agreement.pdf");

    fireEvent.click(screen.getByRole("button", { name: /Open signing/ }));
    await userEvent.type(screen.getByPlaceholderText("e.g. meeting2024"), "abcd");
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));

    await waitFor(() => expect(mockGenerateLink).toHaveBeenCalledTimes(1));
  });
});

describe("Escape while a send is in flight", () => {
  function renderWithClose() {
    const onClose = jest.fn();
    renderWithProviders(
      <SignActionModal
        isOpen
        onClose={onClose}
        fileName="Agreement.pdf"
        objectPath="lawfirmids/firm-1/matter-1/Agreement.pdf"
        lawFirmId="firm-1"
      />,
    );
    return onClose;
  }

  async function sendToPortal() {
    fireEvent.click(screen.getByRole("button", { name: /Send to client portal/ }));
    fireEvent.click(await screen.findByText("Select a client..."));
    // The send's own awaits settle inside act, so their state updates do too.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send to Portal" }));
    });
  }

  // Red if: the dialog stays dismissible while a signing link is being
  // generated, so Escape closes it and a failure reports into a closed dialog.
  it("does not close while a signing link is being generated", async () => {
    const pending = deferred<{ token: string }>();
    mockGenerateLink.mockReturnValueOnce(pending.promise);
    const onClose = renderWithClose();

    fireEvent.click(screen.getByRole("button", { name: /Open signing/ }));
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));
    await waitFor(() => expect(mockGenerateLink).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => pending.resolve({ token: "tok-1" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Copy link|Link copied/ })).toBeEnabled());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Red if: the dialog stays dismissible, or its Done button stays live, while
  // a portal send is in flight, so the dialog can be closed mid-send.
  it("does not close while a portal send is in flight", async () => {
    const onClose = renderWithClose();
    fireEvent.click(screen.getByRole("button", { name: /Open signing/ }));

    // A first send completes, which puts Done on screen.
    await sendToPortal();
    expect(await screen.findByRole("button", { name: "Done" })).toBeEnabled();

    const pending = deferred<unknown>();
    mockSendSigningRequest.mockReturnValueOnce(pending.promise);
    await sendToPortal();
    await waitFor(() => expect(mockSendSigningRequest).toHaveBeenCalledTimes(2));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();

    await act(async () => pending.resolve({}));
    await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toBeEnabled());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
