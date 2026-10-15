/**
 * The client portal's "Upload a document" dialog, against a fake transport.
 *
 * The whole service layer runs for real, so what these specs pin is what a
 * client actually gets: whether a cancel reaches storage, whether anything is
 * filed from an upload they stopped or walked away from, and whether a file the
 * server refused is reported or quietly called "complete".
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installApiMock, type ApiMock } from "../../support/apiMock";
import { installXhrMock, type XhrMock } from "../../support/xhrMock";

jest.unmock("@/services/client-portal.service");
jest.unmock("@/services/requestDeduplicator");

import UploadDocumentModal from "@/components/portalComp/UploadDocumentModal";

const DOCS = "/lawfirm/firm-1/matters/matter-1/documents";
const SESSION_A = "https://storage.googleapis.com/upload/doc-a";
const SESSION_B = "https://storage.googleapis.com/upload/doc-b";
const MATTERS = [{ id: "matter-1", title: "Estate" }];

let api: ApiMock;
let xhr: XhrMock;

/** A promise the spec releases by hand, to hold a PUT while the bytes "move". */
function deferred() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const fileNamed = (name: string) => new File(["x"], name, { type: "application/pdf" });

function arrangeInit(names: string[]) {
  const sessions = [SESSION_A, SESSION_B];
  api.post(`${DOCS}/upload-init`, {
    uploads: names.map((name, i) => ({
      uploadUrl: sessions[i], objectPath: `docs/${i}`, fileId: `file-${i}`, fileName: name,
    })),
  });
  // A cancel gives back what init opened.
  api.post(`${DOCS}/upload-cancel`, { cancelled: names.length });
}

function renderModal(props: Partial<React.ComponentProps<typeof UploadDocumentModal>> = {}) {
  const onClose = jest.fn();
  const onUploaded = jest.fn();
  const all = { open: true, onClose, lawFirmId: "firm-1", matters: MATTERS, onUploaded, ...props };
  const view = render(<UploadDocumentModal {...all} />);
  return { ...view, onClose, onUploaded, props: all };
}

function pick(files: File[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

const uploadButton = () => screen.getByRole("button", { name: /^Upload$/ });

beforeEach(() => {
  api = installApiMock();
  xhr = installXhrMock();
});

afterEach(() => {
  api.restore();
  xhr.restore();
});

describe("UploadDocumentModal cancelling", () => {
  it("offers a cancel while the bytes move, and a cancel keeps the picked files with nothing filed and no error", async () => {
    const hold = deferred();
    arrangeInit(["a.pdf"]);
    xhr.onExact("PUT", SESSION_A, { status: 200, until: hold.promise });
    // Registered so an upload that ignored the cancel would reach it and be seen.
    api.post(`${DOCS}/upload-finalize`, { documents: [{ fileId: "file-0", name: "a.pdf" }] });
    const { onUploaded } = renderModal();

    pick([fileNamed("a.pdf")]);
    fireEvent.click(uploadButton());
    await waitFor(() => expect(xhr.calls("PUT")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));

    await waitFor(() => expect(uploadButton()).toBeEnabled());
    hold.release();
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    // Back to how it was before Upload: the file still picked, no banner.
    expect(screen.getByText("a.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Upload complete")).not.toBeInTheDocument();
    expect(api.callsTo(`${DOCS}/upload-finalize`)).toEqual([]);
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("stops the upload when the dialog closes mid-transfer, so nothing is filed behind it", async () => {
    const hold = deferred();
    arrangeInit(["a.pdf"]);
    xhr.onExact("PUT", SESSION_A, { status: 200, until: hold.promise });
    api.post(`${DOCS}/upload-finalize`, { documents: [{ fileId: "file-0", name: "a.pdf" }] });
    const { onUploaded, rerender, props } = renderModal();

    pick([fileNamed("a.pdf")]);
    fireEvent.click(uploadButton());
    await waitFor(() => expect(xhr.calls("PUT")).toHaveLength(1));

    // The parent's answer to onClose.
    rerender(<UploadDocumentModal {...props} open={false} />);
    hold.release();
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    // The old dialog let the upload finish unseen, then filed it and called
    // onUploaded for a dialog the client had already dismissed.
    expect(api.callsTo(`${DOCS}/upload-finalize`)).toEqual([]);
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("does not let a stray backdrop click abandon an upload in flight", async () => {
    const hold = deferred();
    arrangeInit(["a.pdf"]);
    xhr.onExact("PUT", SESSION_A, { status: 200, until: hold.promise });
    api.post(`${DOCS}/upload-finalize`, { documents: [{ fileId: "file-0", name: "a.pdf" }] });
    const { onClose } = renderModal();

    pick([fileNamed("a.pdf")]);
    fireEvent.click(uploadButton());
    await waitFor(() => expect(xhr.calls("PUT")).toHaveLength(1));

    const backdrop = document.querySelector(".fixed.inset-0 > div") as HTMLElement;
    fireEvent.click(backdrop);

    expect(onClose).not.toHaveBeenCalled();
    hold.release();
    await screen.findByText("Upload complete");
  });

  it("drops the cancel once the server is filing, since it would stop nothing", async () => {
    arrangeInit(["a.pdf"]);
    xhr.onExact("PUT", SESSION_A, { status: 200 });
    const filing = deferred();
    api.post(`${DOCS}/upload-finalize`, async () => {
      await filing.promise;
      return { documents: [{ fileId: "file-0", name: "a.pdf" }] };
    });
    renderModal();

    pick([fileNamed("a.pdf")]);
    fireEvent.click(uploadButton());
    await waitFor(() => expect(api.callsTo(`${DOCS}/upload-finalize`)).toHaveLength(1));

    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel upload" })).not.toBeInTheDocument();
    filing.release();
    await screen.findByText("Upload complete");
  });
});

describe("UploadDocumentModal refused files", () => {
  it("names the files the server refused instead of reporting the upload complete", async () => {
    arrangeInit(["a.pdf", "b.exe.pdf"]);
    xhr.onExact("PUT", SESSION_A, { status: 200 });
    xhr.onExact("PUT", SESSION_B, { status: 200 });
    api.post(`${DOCS}/upload-finalize`, {
      documents: [{ fileId: "file-0", name: "a.pdf" }],
      failures: [{ objectPath: "docs/1", fileName: "b.exe.pdf", error: "That file type is not allowed." }],
    });
    const { onUploaded } = renderModal();

    pick([fileNamed("a.pdf"), fileNamed("b.exe.pdf")]);
    fireEvent.click(uploadButton());

    await screen.findByText(/b\.exe\.pdf: That file type is not allowed\./);
    expect(screen.queryByText("Upload complete")).not.toBeInTheDocument();
    // a.pdf WAS filed, so the list behind the dialog still refreshes, and only
    // the refused file stays picked for another try.
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("a.pdf")).not.toBeInTheDocument();
  });

  it("shows an error when the server filed nothing", async () => {
    arrangeInit(["a.pdf"]);
    xhr.onExact("PUT", SESSION_A, { status: 200 });
    api.post(`${DOCS}/upload-finalize`, {
      documents: [],
      failures: [{ objectPath: "docs/0", fileName: "a.pdf", error: "That file type is not allowed." }],
    });
    const { onUploaded } = renderModal();

    pick([fileNamed("a.pdf")]);
    fireEvent.click(uploadButton());

    await screen.findByText("That file type is not allowed.");
    expect(screen.getByRole('alert').parentElement).toHaveFocus();
    expect(screen.queryByText("Upload complete")).not.toBeInTheDocument();
    expect(onUploaded).not.toHaveBeenCalled();
  });
});

describe("UploadDocumentModal file limit", () => {
  const LIMIT_WARNING = /Only 50 files can be uploaded at once/;
  const named = (count: number, prefix = "doc") =>
    Array.from({ length: count }, (_, i) => fileNamed(`${prefix}-${i + 1}.pdf`));

  it("keeps the first 50 of a larger pick and says how many were left out", () => {
    renderModal();

    pick(named(53));

    // Red on the old dialog, which dropped the files past its limit without a word.
    expect(screen.getByRole("status")).toHaveTextContent(
      "Only 50 files can be uploaded at once. 3 files were not added.",
    );
    expect(screen.getByText("doc-50.pdf")).toBeInTheDocument();
    expect(screen.queryByText("doc-51.pdf")).not.toBeInTheDocument();
  });

  it("counts the files already picked toward the limit", () => {
    renderModal();

    pick(named(48, "first"));
    pick(named(3, "second"));

    // Red if the check looks at one pick alone: three fit on their own.
    expect(screen.getByRole("status")).toHaveTextContent(
      "Only 50 files can be uploaded at once. 1 file was not added.",
    );
    expect(screen.getByText("second-2.pdf")).toBeInTheDocument();
    expect(screen.queryByText("second-3.pdf")).not.toBeInTheDocument();
  });

  it("says nothing when the pick fits exactly", () => {
    renderModal();

    pick(named(50));

    // Red if the warning keys off reaching the limit rather than going past it.
    expect(screen.getByText("doc-50.pdf")).toBeInTheDocument();
    expect(screen.queryByText(LIMIT_WARNING)).not.toBeInTheDocument();
  });

  it("clears the warning once the selection is back under the limit", () => {
    renderModal();

    pick(named(52));
    expect(screen.getByText(LIMIT_WARNING)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove doc-1.pdf" }));

    // Red if the warning outlives the overflow it describes.
    expect(screen.queryByText(LIMIT_WARNING)).not.toBeInTheDocument();
  });

  it("does not carry the warning into the next time the dialog opens", () => {
    const { rerender, props } = renderModal();

    pick(named(52));
    expect(screen.getByText(LIMIT_WARNING)).toBeInTheDocument();
    rerender(<UploadDocumentModal {...props} open={false} />);
    rerender(<UploadDocumentModal {...props} open />);

    expect(screen.queryByText(LIMIT_WARNING)).not.toBeInTheDocument();
  });
});

it('focuses the upload refusal inside the dialog and restores a usable retry control', async () => {
  api.post(`${DOCS}/upload-init`, { status: 403, body: { error: 'Upload denied' } });
  renderModal();
  pick([fileNamed('refused.pdf')]);
  fireEvent.click(uploadButton());
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Upload denied');
  expect(alert.parentElement).toHaveFocus();
  fireEvent.click(within(alert).getByRole('button', { name: 'Close' }));
  expect(uploadButton()).toHaveFocus();
  expect(screen.getByText('refused.pdf')).toBeInTheDocument();
});

it('announces actual upload completion through a persistent status', async () => {
  arrangeInit(['uploaded.pdf']);
  xhr.onExact('PUT', SESSION_A, { status: 200 });
  api.post(`${DOCS}/upload-finalize`, { documents: [{ fileId: 'file-0', name: 'uploaded.pdf' }] });
  const { onUploaded } = renderModal();
  pick([fileNamed('uploaded.pdf')]);
  fireEvent.click(uploadButton());
  expect(screen.getByLabelText('Document upload')).toHaveAttribute('aria-live', 'polite');
  await waitFor(() => expect(screen.getByLabelText('Document upload')).toHaveTextContent('Upload complete'));
  expect(onUploaded).toHaveBeenCalledTimes(1);
  expect(api.callsTo(`${DOCS}/upload-finalize`)).toHaveLength(1);
});
