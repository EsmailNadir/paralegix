import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installApiMock, type ApiMock } from "../../support/apiMock";
import { installXhrMock, type XhrMock } from "../../support/xhrMock";

jest.unmock("@/services/client-portal.service");
jest.unmock("@/services/requestDeduplicator");

const mockUseQuery = jest.fn();
jest.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useQueryClient: () => ({ invalidateQueries: jest.fn(), setQueryData: jest.fn() }),
}));

// Captures what FilePreviewModal was told to show, so a spec can prove WHICH
// fulfillment ended up previewed, not just that a click handler fired.
const mockPreviewModal = jest.fn((_props: Record<string, unknown>) => null);
jest.mock("@/components/filesComp/FilePreviewModal", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => mockPreviewModal(props),
}));

import RequestedDocumentsPanel from "@/components/portalComp/RequestedDocumentsPanel";
import type { DocumentRequest } from "@/services/client-portal.service";

const REQUEST: DocumentRequest = {
  id: "req-1",
  matterId: null,
  clientId: "client-1",
  title: "Intake Documents",
  note: null,
  status: "open",
  dueDate: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  items: [
    {
      id: "item-a",
      requestId: "req-1",
      label: "W-9 form",
      description: "",
      status: "pending",
      fulfillments: [
        {
          id: "fulfillment-a",
          fileName: "w9-a.pdf",
          objectPath: "path/a.pdf",
          uploadedBy: "client-1",
          uploadedByName: "Alex",
          uploadedAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    },
    {
      id: "item-b",
      requestId: "req-1",
      label: "Lease agreement",
      description: "",
      status: "pending",
      fulfillments: [
        {
          id: "fulfillment-b",
          fileName: "lease-b.pdf",
          objectPath: "path/b.pdf",
          uploadedBy: "client-1",
          uploadedByName: "Alex",
          uploadedAt: "2026-04-02T00:00:00.000Z",
        },
      ],
    },
  ],
};

describe("RequestedDocumentsPanel preview race", () => {
  let api: ApiMock;

  beforeEach(() => {
    mockUseQuery.mockReturnValue({ data: [REQUEST], isLoading: false, error: null, refetch: jest.fn() });
    api = installApiMock();
    mockPreviewModal.mockClear();
  });

  afterEach(() => {
    api.restore();
  });

  it("keeps the most recently clicked fulfillment's preview, even when an earlier click's slower response arrives after it", async () => {
    // Fulfillment A is the SLOWER response: requested first, resolves last -
    // exactly the ordering that lets a stale response win without a guard.
    api.get("/fulfillments/fulfillment-a/url", {
      body: { signedUrl: "https://example.test/a.pdf", fileName: "w9-a.pdf", contentType: "application/pdf", size: 111 },
      delayMs: 80,
    });
    api.get("/fulfillments/fulfillment-b/url", {
      body: { signedUrl: "https://example.test/b.pdf", fileName: "lease-b.pdf", contentType: "application/pdf", size: 222 },
      delayMs: 10,
    });

    render(React.createElement(RequestedDocumentsPanel, { lawFirmId: "firm-1" }));

    fireEvent.click(screen.getByText("w9-a.pdf"));
    fireEvent.click(screen.getByText("lease-b.pdf"));

    await waitFor(() =>
      expect(mockPreviewModal).toHaveBeenCalledWith(
        expect.objectContaining({ file: expect.objectContaining({ name: "lease-b.pdf" }) })
      )
    );

    // Give fulfillment A's slower, now-stale response time to land too.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const lastCall = mockPreviewModal.mock.calls[mockPreviewModal.mock.calls.length - 1][0] as {
      file: { name: string } | null;
    };
    expect(lastCall.file?.name).toBe("lease-b.pdf");
  });
});

describe("RequestedDocumentsPanel request note", () => {
  let api: ApiMock;

  beforeEach(() => {
    mockUseQuery.mockReturnValue({
      data: [{ ...REQUEST, note: "Please send the signed copy." }],
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    api = installApiMock();
  });

  afterEach(() => {
    api.restore();
  });

  it("renders the note inside the collapsing body so it does not resize the header", () => {
    render(React.createElement(RequestedDocumentsPanel, { lawFirmId: "firm-1" }));

    const note = screen.getByText("Please send the signed copy.");
    const header = screen.getByRole("button", { name: /Intake Documents/i });

    // In the header the note appeared only while open, which snapped the header
    // taller on every toggle while the body animated.
    expect(header.contains(note)).toBe(false);
    expect(note.closest('[style*="grid-template-rows"]')).not.toBeNull();
  });

  it("keeps the note mounted when the request collapses, so it shrinks with the body", () => {
    render(React.createElement(RequestedDocumentsPanel, { lawFirmId: "firm-1" }));

    const header = screen.getByRole("button", { name: /Intake Documents/i });
    expect(header.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(header);

    expect(header.getAttribute("aria-expanded")).toBe("false");
    const note = screen.getByText("Please send the signed copy.");
    expect(note.closest('[style*="0fr"]')).not.toBeNull();
  });
});

describe("RequestedDocumentsPanel item upload", () => {
  const ITEM = "/lawfirm/firm-1/document-requests/req-1/items/item-a/fulfill";
  const SESSION_A = "https://storage.googleapis.com/upload/item-a-0";
  const SESSION_B = "https://storage.googleapis.com/upload/item-a-1";
  let api: ApiMock;
  let xhr: XhrMock;
  let refetch: jest.Mock;

  /** A promise the spec releases by hand, to hold a PUT while the bytes "move". */
  function deferred() {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }

  beforeEach(() => {
    refetch = jest.fn();
    mockUseQuery.mockReturnValue({ data: [REQUEST], isLoading: false, error: null, refetch });
    api = installApiMock();
    xhr = installXhrMock();
  });

  afterEach(() => {
    api.restore();
    xhr.restore();
  });

  function arrangeInit(names: string[]) {
    const sessions = [SESSION_A, SESSION_B];
    api.post(`${ITEM}/upload-init`, {
      uploads: names.map((name, i) => ({
        uploadUrl: sessions[i], objectPath: `docs/${i}`, fileId: `file-${i}`, fileName: name,
      })),
    });
    // A cancel gives back what init opened.
    api.post(`${ITEM}/upload-cancel`, { cancelled: names.length });
  }

  /**
   * Init as the server answers it for any number of groups, a PUT that lands
   * for every session, and a finalize that records every upload it is sent.
   */
  function arrangeAnyCount() {
    let opened = 0;
    api.post(`${ITEM}/upload-init`, (call) => ({
      uploads: (call.body as { files: Array<{ fileName: string }> }).files.map((f) => {
        const i = opened;
        opened += 1;
        return {
          uploadUrl: `https://storage.googleapis.com/upload/item-many-${i}`,
          objectPath: `docs/${i}`, fileId: `file-${i}`, fileName: f.fileName,
        };
      }),
    }));
    xhr.on("PUT", "storage.googleapis.com/upload/item-many-", { status: 200 });
    api.post(`${ITEM}/upload-finalize`, (call) => ({
      documents: (call.body as { uploads: Array<{ fileId: string }> }).uploads
        .map((u) => ({ fileId: u.fileId, name: u.fileId })),
      failures: [],
      requestId: "req-1",
      itemId: "item-a",
    }));
  }

  const named = (count: number) => Array.from({ length: count }, (_, i) => `doc-${i + 1}.pdf`);
  const LIMIT_WARNING = /Only 50 files can be uploaded at once/;

  /** Click the first item's upload button, then answer the file dialog. */
  function uploadToFirstItem(names: string[]) {
    fireEvent.click(screen.getAllByRole("button", { name: /Upload more/ })[0]);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: names.map((n) => new File(["x"], n, { type: "application/pdf" })) } });
  }

  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });

  it("offers a cancel while the bytes move, and a cancel records nothing and shows no error", async () => {
    const hold = deferred();
    arrangeInit(["w9.pdf"]);
    xhr.onExact("PUT", SESSION_A, { status: 200, until: hold.promise });
    // Registered so an upload that ignored the cancel would reach it and be seen.
    api.post(`${ITEM}/upload-finalize`, { documents: [{ fileId: "file-0", name: "w9.pdf" }] });
    const onFulfilled = jest.fn();
    render(React.createElement(RequestedDocumentsPanel, { lawFirmId: "firm-1", onFulfilled }));

    uploadToFirstItem(["w9.pdf"]);
    await waitFor(() => expect(xhr.calls("PUT")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));

    await waitFor(() => expect(screen.getAllByRole("button", { name: /Upload more/ })[0]).toBeEnabled());
    hold.release();
    await settle();

    // Finalize is what records the file against the checklist line.
    expect(api.callsTo(`${ITEM}/upload-finalize`)).toEqual([]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(onFulfilled).not.toHaveBeenCalled();
  });

  it("stops the upload when the panel goes away mid-transfer, so nothing is recorded behind it", async () => {
    const hold = deferred();
    arrangeInit(["w9.pdf"]);
    xhr.onExact("PUT", SESSION_A, { status: 200, until: hold.promise });
    api.post(`${ITEM}/upload-finalize`, { documents: [{ fileId: "file-0", name: "w9.pdf" }] });
    const onFulfilled = jest.fn();
    const { unmount } = render(React.createElement(RequestedDocumentsPanel, { lawFirmId: "firm-1", onFulfilled }));

    uploadToFirstItem(["w9.pdf"]);
    await waitFor(() => expect(xhr.calls("PUT")).toHaveLength(1));

    // Leaving the page. The upload used to finish unseen and fulfil the item.
    unmount();
    hold.release();
    await settle();

    expect(api.callsTo(`${ITEM}/upload-finalize`)).toEqual([]);
    expect(onFulfilled).not.toHaveBeenCalled();
  });

  it("names the files the server refused while keeping the ones it recorded", async () => {
    arrangeInit(["w9.pdf", "w9-scan.pdf"]);
    xhr.onExact("PUT", SESSION_A, { status: 200 });
    xhr.onExact("PUT", SESSION_B, { status: 200 });
    api.post(`${ITEM}/upload-finalize`, {
      documents: [{ fileId: "file-0", name: "w9.pdf" }],
      failures: [{ objectPath: "docs/1", fileName: "w9-scan.pdf", error: "That file type is not allowed." }],
      requestId: "req-1",
      itemId: "item-a",
    });
    const onFulfilled = jest.fn();
    render(React.createElement(RequestedDocumentsPanel, { lawFirmId: "firm-1", onFulfilled }));

    uploadToFirstItem(["w9.pdf", "w9-scan.pdf"]);

    await screen.findByText(/w9-scan\.pdf: That file type is not allowed\./);
    expect(onFulfilled).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalled();
  });

  it("uploads the first 50 of a larger pick and says how many were left out", async () => {
    arrangeAnyCount();
    render(React.createElement(RequestedDocumentsPanel, { lawFirmId: "firm-1" }));

    uploadToFirstItem(named(53));

    // Red without the cap: the service refuses the whole pick of 53 and the
    // client is told nothing was sent, rather than that three were left out.
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Only 50 files can be uploaded at once. 3 files were not added.",
    );
    await waitFor(() => expect(api.callsTo(`${ITEM}/upload-finalize`)).toHaveLength(1));
    const sent = (api.callsTo(`${ITEM}/upload-finalize`)[0].body as { uploads: Array<{ fileName: string }> }).uploads;
    expect(sent.map((u) => u.fileName)).toEqual(named(50));
  });

  it("says nothing when the pick fits exactly", async () => {
    arrangeAnyCount();
    render(React.createElement(RequestedDocumentsPanel, { lawFirmId: "firm-1" }));

    uploadToFirstItem(named(50));

    // Red if the notice keys off reaching 50 rather than going past it.
    await waitFor(() => expect(api.callsTo(`${ITEM}/upload-finalize`)).toHaveLength(1));
    expect(screen.queryByText(LIMIT_WARNING)).not.toBeInTheDocument();
  });

  it("drops the notice on the next pick that fits", async () => {
    arrangeAnyCount();
    render(React.createElement(RequestedDocumentsPanel, { lawFirmId: "firm-1" }));

    uploadToFirstItem(named(52));
    await screen.findByText(LIMIT_WARNING);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Upload more/ })[0]).toBeEnabled());
    uploadToFirstItem(named(1));

    // Red if the notice outlives the pick it describes.
    await waitFor(() => expect(api.callsTo(`${ITEM}/upload-finalize`)).toHaveLength(2));
    expect(screen.queryByText(LIMIT_WARNING)).not.toBeInTheDocument();
  });
});
