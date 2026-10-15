/**
 * `TemplateEditor`'s two uploads, and what happens when the user walks away
 * from one mid-transfer.
 *
 * Importing a DOCX creates a template row at finalize, and "Save to Files"
 * files a document. Both used to run to completion however the user left: the
 * editor closed with Back, or the Save to Files dialog dismissed with Cancel.
 * The first left an orphan template in the list; the second filed a document
 * the user had just cancelled.
 *
 * What has to break for these to go red: the editor not handing a signal to
 * the upload, not aborting it on unmount or on the dialog's Cancel, carrying
 * on to the next step after an abort, or reporting a cancel as an error.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "../../setup";
import { UploadCancelledError } from "@/lib/files/resumableUpload";

jest.mock("@/components/templatesComp/PlaceholderModal", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/lib/pdfToHtml", () => ({
  convertPdfToHtml: jest.fn().mockResolvedValue({ html: "", warnings: [] }),
}));
jest.mock("@/types/signature", () => ({
  FONT_FAMILIES: [
    { label: "Helvetica", value: "Helvetica", css: "Helvetica, Arial, sans-serif" },
  ],
  FONT_SIZES: [12, 14, 16, 18],
}));
jest.mock("@/components/signaturesComp/textFormatting", () => ({
  foreColorToHex: jest.fn(),
  mapCssToFontValue: jest.fn(() => "Helvetica"),
}));
jest.mock("@/services/templates.service", () => ({
  templatesService: {
    getById: jest.fn(),
    convertToPdf: jest.fn(),
    convertToFormat: jest.fn(),
    renderPdf: jest.fn(),
    uploadDocxTemplate: jest.fn(),
  },
}));

const mockUpload = jest.fn();
jest.mock("@/services/files.service", () => ({
  __esModule: true,
  default: { upload: (...args: unknown[]) => mockUpload(...args) },
}));

// Stands in for the destination picker. Its own Cancel is the control under
// test, so the stub renders it while the save is running, as the real one does.
jest.mock("@/components/templatesComp/SaveToFilesModal", () => ({
  __esModule: true,
  default: ({ open, onConfirm, onClose }: {
    open: boolean;
    onConfirm: (destination: unknown) => void;
    onClose: () => void;
  }) =>
    open ? (
      <div>
        <button type="button" onClick={() => onConfirm({ scope: "general", fileName: "Filled.pdf" })}>
          Confirm destination
        </button>
        <button type="button" onClick={onClose}>Cancel save</button>
      </div>
    ) : null,
}));

import TemplateEditor from "@/components/templatesComp/TemplateEditor";
import { templatesService } from "@/services/templates.service";
import { convertPdfToHtml } from "@/lib/pdfToHtml";

const mocked = templatesService as jest.Mocked<typeof templatesService>;
const mockedConvertPdfToHtml = convertPdfToHtml as jest.Mock;

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** A promise the spec settles by hand, to hold a step in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Like the real services: settles when the test says so, or rejects with
 * `UploadCancelledError` the moment its signal aborts.
 */
function abortable<T>(signal: AbortSignal | undefined, held: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new UploadCancelledError()), { once: true });
    held.then(resolve);
  });
}

const docxTemplate = {
  id: "template-docx",
  name: "agreement",
  type: "docx",
  fields: [],
  repeaters: [],
  html: undefined,
  assets: [],
  folderId: null,
  createdAt: "2026-04-09T00:00:00.000Z",
} as any;

const baseProps = {
  lawFirmId: "firm-1",
  onSaved: jest.fn(),
  onBack: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("importing a document, then leaving the editor", () => {
  it("aborts the DOCX upload on unmount and goes no further", async () => {
    const held = deferred<typeof docxTemplate>();
    let signal: AbortSignal | undefined;
    mocked.uploadDocxTemplate.mockImplementation((_firm, _file, _name, options) => {
      signal = (options as { signal?: AbortSignal } | undefined)?.signal;
      return abortable(signal, held.promise);
    });
    mocked.convertToPdf.mockResolvedValue(new File(["pdf"], "agreement.pdf", { type: "application/pdf" }));
    const docx = new File(["docx"], "agreement.docx", { type: DOCX_TYPE });

    const { unmount } = render(<TemplateEditor {...baseProps} initialFile={docx} />);
    await waitFor(() => expect(mocked.uploadDocxTemplate).toHaveBeenCalledTimes(1));

    unmount();
    // Were the abort not wired, this is the upload finishing after the editor
    // closed: the template row now exists and the import carries on.
    await act(async () => { held.resolve(docxTemplate); });

    expect(signal?.aborted).toBe(true);
    expect(mocked.convertToPdf).not.toHaveBeenCalled();
  });

  // Development mounts, unmounts and remounts every component once. The abort
  // on unmount must not cost the user the document they picked: goes red if the
  // initial import is consumed by the first mount and not restarted.
  it("still imports the picked document under Strict Mode's remount", async () => {
    mocked.uploadDocxTemplate.mockResolvedValue(docxTemplate);
    mocked.convertToPdf.mockResolvedValue(new File(["pdf"], "agreement.pdf", { type: "application/pdf" }));
    const docx = new File(["docx"], "agreement.docx", { type: DOCX_TYPE });

    render(
      <React.StrictMode>
        <TemplateEditor {...baseProps} initialFile={docx} />
      </React.StrictMode>,
    );

    await waitFor(() => expect(mocked.convertToPdf).toHaveBeenCalledTimes(1));
    // The first mount may reach the service before its abort lands; the real
    // service then stops before init. What matters is one upload still live.
    const live = mocked.uploadDocxTemplate.mock.calls.filter(
      (call) => !(call[3] as { signal?: AbortSignal }).signal?.aborted,
    );
    expect(live).toHaveLength(1);
  });

  // Under Strict Mode the first mount's import is already converting the PDF
  // when its abort lands, and the remounted editor is the SAME instance, so a
  // first pass that carried on after the abort would write its result over the
  // live import's. Goes red if the aborted pass applies its conversion.
  it("does not apply an aborted import's PDF conversion over the live one", async () => {
    type Conversion = Awaited<ReturnType<typeof convertPdfToHtml>>;
    const abortedPass = deferred<Conversion>();
    const livePass = deferred<Conversion>();
    mockedConvertPdfToHtml
      .mockImplementationOnce(() => abortedPass.promise)
      .mockImplementationOnce(() => livePass.promise);
    const pdf = new File(["%PDF-1.7"], "agreement.pdf", { type: "application/pdf" });
    // Settles on the microtask queue, so the step after it runs inside `act`.
    const readBytes = jest.fn(() => Promise.resolve(new ArrayBuffer(8)));
    Object.defineProperty(pdf, "arrayBuffer", { value: readBytes });

    render(
      <React.StrictMode>
        <TemplateEditor {...baseProps} initialFile={pdf} />
      </React.StrictMode>,
    );
    await waitFor(() => expect(mockedConvertPdfToHtml).toHaveBeenCalledTimes(2));

    await act(async () => {
      livePass.resolve({ html: "", warnings: ["Warning from the live import"] });
    });
    expect(await screen.findByText("Warning from the live import")).toBeInTheDocument();

    await act(async () => {
      abortedPass.resolve({ html: "", warnings: ["Warning from the aborted import"] });
    });

    // Both passes read the PDF's bytes, so the aborted one got as far as the
    // last step before it would apply anything.
    expect(readBytes).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Warning from the aborted import")).not.toBeInTheDocument();
    expect(screen.getByText("Warning from the live import")).toBeInTheDocument();
  });

  it("does not start the DOCX upload when the editor closes while a .doc is converting", async () => {
    const converting = deferred<File>();
    mocked.convertToFormat.mockImplementation(() => converting.promise);
    mocked.uploadDocxTemplate.mockResolvedValue(docxTemplate);
    const doc = new File(["doc"], "agreement.doc", { type: "application/msword" });

    const { unmount } = render(<TemplateEditor {...baseProps} initialFile={doc} />);
    await waitFor(() => expect(mocked.convertToFormat).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => {
      converting.resolve(new File(["docx"], "agreement.docx", { type: DOCX_TYPE }));
    });

    // The upload's finalize is what creates the template row.
    expect(mocked.uploadDocxTemplate).not.toHaveBeenCalled();
  });
});

describe("saving a filled document to Files, then cancelling", () => {
  beforeEach(() => {
    mocked.getById.mockResolvedValue({
      id: "template-1",
      name: "Engagement",
      type: "html",
      fields: [],
      repeaters: [],
      html: '<html><body><div class="pdf-page"><p>Hello</p></div></body></html>',
      assets: [],
      folderId: null,
      createdAt: "2026-04-09T00:00:00.000Z",
    } as any);
    mocked.renderPdf.mockResolvedValue({ blob: new Blob(["%PDF-1.7"], { type: "application/pdf" }), skippedImages: 0 });
  });

  async function startSave() {
    render(
      <TemplateEditor
        {...baseProps}
        templateId="template-1"
        initialFillValues={{ client_name: "Pat" }}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Save to Files/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm destination" }));
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
  }

  it("aborts the upload when the dialog is cancelled, without an error", async () => {
    const held = deferred<unknown>();
    let signal: AbortSignal | undefined;
    mockUpload.mockImplementation((...args: unknown[]) => {
      signal = args[5] as AbortSignal | undefined;
      return abortable(signal, held.promise);
    });

    await startSave();
    fireEvent.click(screen.getByRole("button", { name: "Cancel save" }));
    await act(async () => { held.resolve({ files: [] }); });

    expect(signal?.aborted).toBe(true);
    expect(screen.queryByText(/The upload was cancelled/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Failed to save to files/i)).not.toBeInTheDocument();
    // Back to where it was before the save: the button is usable again.
    await waitFor(() => expect(screen.getByRole("button", { name: /Save to Files/ })).toBeEnabled());
  });
});
