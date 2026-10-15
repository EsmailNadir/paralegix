import React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import "../../setup";
import { installApiMock, type ApiMock } from "../../support/apiMock";
import { installXhrMock, type XhrMock } from "../../support/xhrMock";
import { renderWithProviders } from "../../support/renderWithProviders";

jest.unmock("@/services/client-portal.service");
jest.unmock("@/services/requestDeduplicator");

// isomorphic-dompurify pulls in a jsdom dependency chain Jest's transform
// config can't parse in this suite; this spec has no rich-text content to
// sanitize, so a passthrough stub sidesteps it.
jest.mock("@/lib/utils/sanitizeHtml", () => ({
  __esModule: true,
  sanitizeRichHtml: (html?: string | null) => html ?? "",
}));

jest.mock("next/navigation", () => ({
  useParams: () => ({ lawFirmId: "firm-1", matterId: "matter-1" }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/client/lawfirm/firm-1/matters/matter-1",
}));

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

import ClientMatterDetailPage from "@/app/client/lawfirm/[lawFirmId]/matters/[matterId]/page";

describe("ClientMatterDetailPage preview race", () => {
  let api: ApiMock;

  it('loads the current matter documents without requesting the retired shared-notes endpoint', async () => {
    renderWithProviders(<ClientMatterDetailPage />);
    await screen.findByText('Report-A.pdf');
    expect(api.callsTo('/matters/matter-1/documents')).toHaveLength(1);
    expect(api.callsTo('/matters/matter-1/notes')).toHaveLength(0);
  });

  it('links the client-facing event description and location', async () => {
    api.get('/events', { events: [{ id: 'shared-event', title: 'Client appointment', date: '2026-11-10T12:00:00Z', allDay: true, description: 'Email client@example.com', location: 'https://example.com/office' }], truncated: false });
    renderWithProviders(<ClientMatterDetailPage />);
    await screen.findByText('Client appointment');
    expect(screen.getByRole('link', { name: 'client@example.com' })).toHaveAttribute('href', 'mailto:client@example.com');
    expect(screen.getByRole('link', { name: 'https://example.com/office' })).toHaveAttribute('href', 'https://example.com/office');
  });

  // The suite runs in Los Angeles (jest.config.js), so that is the viewer zone.
  it('shows when an event ends, and the zone it was set in when that is not the viewer zone', async () => {
    api.get('/events', { events: [
      { id: 'timed', matterId: 'matter-1', title: 'Deposition', date: '2026-11-10T18:00:00.000Z', endsAt: '2026-11-10T19:30:00.000Z', allDay: false, timeZone: 'Pacific/Auckland' },
      { id: 'local', matterId: 'matter-1', title: 'Phone call', date: '2026-11-11T18:00:00.000Z', allDay: false, timeZone: 'America/Los_Angeles' },
      { id: 'days', matterId: 'matter-1', title: 'Trial', date: '2026-11-16T12:00:00.000Z', endsAt: '2026-11-19T12:00:00.000Z', allDay: true, timeZone: 'Pacific/Auckland' },
    ], truncated: false });
    renderWithProviders(<ClientMatterDetailPage />);
    await screen.findByText('Deposition');

    const zone = screen.getByText('(Wed 7:00 AM – 8:30 AM in Auckland)');
    expect(zone).toHaveClass('text-on-surface-secondary');
    expect(zone.parentElement).toHaveTextContent(/^Tue, Nov 10, 2026 · 10:00 AM – 11:30 AM PST \(Wed 7:00 AM – 8:30 AM in Auckland\)$/);
    expect(screen.getByText('Mon, Nov 16, 2026 – Wed, Nov 18, 2026 · All day')).toBeInTheDocument();
    expect(screen.getAllByText(/ in (Auckland|Los Angeles)\)$/)).toHaveLength(1);
  });

  beforeEach(() => {
    api = installApiMock();
    mockPreviewModal.mockClear();

    api.get("/matters/matter-1", { matter: { id: "matter-1", title: "Test Matter", status: "active" } });
    api.get("/events", { events: [], truncated: false });
    api.get("/billing", { invoices: [] });
    // RequestedDocumentsPanel renders alongside the document list; give it an
    // empty set so it renders nothing and stays out of this spec's way.
    api.get("/document-requests", { requests: [] });
    api.get("/matters/matter-1/documents", {
      documents: [
        {
          id: "doc-a",
          matterId: "matter-1",
          name: "Report-A.pdf",
          type: "application/pdf",
          size: 111,
          uploadedAt: "2026-04-01T00:00:00.000Z",
          downloadUrl: "",
          objectPath: "docs/a.pdf",
        },
        {
          id: "doc-b",
          matterId: "matter-1",
          name: "Report-B.pdf",
          type: "application/pdf",
          size: 222,
          uploadedAt: "2026-04-02T00:00:00.000Z",
          downloadUrl: "",
          objectPath: "docs/b.pdf",
        },
      ],
      truncated: false,
    });
  });

  afterEach(() => {
    api.restore();
  });

  it("keeps the most recently clicked document's preview, even when an earlier click's slower response arrives after it", async () => {
    // Document A is the SLOWER response: requested first, resolves last -
    // exactly the ordering that lets a stale response win without a guard.
    api.post("/matters/matter-1/documents/refresh-url", async (call) => {
      const objectPath = (call.body as { objectPath?: string } | null)?.objectPath;
      if (objectPath === "docs/a.pdf") {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { downloadUrl: "https://example.test/a.pdf" };
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { downloadUrl: "https://example.test/b.pdf" };
    });

    renderWithProviders(React.createElement(ClientMatterDetailPage));

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

describe("ClientMatterDetailPage document upload", () => {
  const DOCS = "/matters/matter-1/documents";
  const SESSION_A = "https://storage.googleapis.com/upload/matter-doc-0";
  const SESSION_B = "https://storage.googleapis.com/upload/matter-doc-1";
  let api: ApiMock;
  let xhr: XhrMock;

  /** A promise the spec releases by hand, to hold a PUT while the bytes "move". */
  function deferred() {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }

  beforeEach(() => {
    api = installApiMock();
    xhr = installXhrMock();
    api.get("/matters/matter-1", { matter: { id: "matter-1", title: "Test Matter", status: "active" } });
    api.get("/events", { events: [], truncated: false });
    api.get("/billing", { invoices: [] });
    api.get("/document-requests", { requests: [] });
    api.get(DOCS, { documents: [], truncated: false });
  });

  afterEach(() => {
    api.restore();
    xhr.restore();
  });

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

  /**
   * Init as the server answers it for any number of groups, a PUT that lands
   * for every session, and a finalize that files every upload it is sent.
   */
  function arrangeAnyCount() {
    let opened = 0;
    api.post(`${DOCS}/upload-init`, (call) => ({
      uploads: (call.body as { files: Array<{ fileName: string }> }).files.map((f) => {
        const i = opened;
        opened += 1;
        return {
          uploadUrl: `https://storage.googleapis.com/upload/matter-many-${i}`,
          objectPath: `docs/${i}`, fileId: `file-${i}`, fileName: f.fileName,
        };
      }),
    }));
    xhr.on("PUT", "storage.googleapis.com/upload/matter-many-", { status: 200 });
    api.post(`${DOCS}/upload-finalize`, (call) => ({
      documents: (call.body as { uploads: Array<{ fileId: string }> }).uploads
        .map((u) => ({ fileId: u.fileId, name: u.fileId })),
      failures: [],
    }));
  }

  const named = (count: number) => Array.from({ length: count }, (_, i) => `doc-${i + 1}.pdf`);
  const LIMIT_WARNING = /Only 50 files can be uploaded at once/;

  async function pick(names: string[]) {
    await screen.findByText("Test Matter");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: names.map((n) => new File(["x"], n, { type: "application/pdf" })) } });
  }

  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });

  it("offers a cancel while the bytes move, and a cancel files nothing and shows no error", async () => {
    const hold = deferred();
    arrangeInit(["deed.pdf"]);
    xhr.onExact("PUT", SESSION_A, { status: 200, until: hold.promise });
    // Registered so an upload that ignored the cancel would reach it and be seen.
    api.post(`${DOCS}/upload-finalize`, { documents: [{ fileId: "file-0", name: "deed.pdf" }] });
    renderWithProviders(React.createElement(ClientMatterDetailPage));

    await pick(["deed.pdf"]);
    await waitFor(() => expect(xhr.calls("PUT")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Upload a document/ })).toBeEnabled());
    hold.release();
    await settle();

    expect(api.callsTo(`${DOCS}/upload-finalize`)).toEqual([]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("stops the upload when the page is left mid-transfer, so nothing is filed behind it", async () => {
    const hold = deferred();
    arrangeInit(["deed.pdf"]);
    xhr.onExact("PUT", SESSION_A, { status: 200, until: hold.promise });
    api.post(`${DOCS}/upload-finalize`, { documents: [{ fileId: "file-0", name: "deed.pdf" }] });
    const { unmount } = renderWithProviders(React.createElement(ClientMatterDetailPage));

    await pick(["deed.pdf"]);
    await waitFor(() => expect(xhr.calls("PUT")).toHaveLength(1));

    unmount();
    hold.release();
    await settle();

    // The upload used to run on with nothing on screen and file the document.
    expect(api.callsTo(`${DOCS}/upload-finalize`)).toEqual([]);
  });

  it("names the files the server refused instead of dropping them", async () => {
    arrangeInit(["deed.pdf", "deed-copy.pdf"]);
    xhr.onExact("PUT", SESSION_A, { status: 200 });
    xhr.onExact("PUT", SESSION_B, { status: 200 });
    api.post(`${DOCS}/upload-finalize`, {
      documents: [{ fileId: "file-0", name: "deed.pdf" }],
      failures: [{ objectPath: "docs/1", fileName: "deed-copy.pdf", error: "That file type is not allowed." }],
    });
    renderWithProviders(React.createElement(ClientMatterDetailPage));

    await pick(["deed.pdf", "deed-copy.pdf"]);

    await screen.findByText(/deed-copy\.pdf: That file type is not allowed\./);
  });

  it("uploads the first 50 of a larger pick and says how many were left out", async () => {
    arrangeAnyCount();
    renderWithProviders(React.createElement(ClientMatterDetailPage));

    await pick(named(53));

    // Red without the cap: the service refuses the whole pick of 53 and the
    // client is told nothing was sent, rather than that three were left out.
    expect(await screen.findByText(LIMIT_WARNING)).toHaveTextContent(
      "Only 50 files can be uploaded at once. 3 files were not added.",
    );
    await waitFor(() => expect(api.callsTo(`${DOCS}/upload-finalize`)).toHaveLength(1));
    const sent = (api.callsTo(`${DOCS}/upload-finalize`)[0].body as { uploads: Array<{ fileName: string }> }).uploads;
    expect(sent.map((u) => u.fileName)).toEqual(named(50));
  });

  it("says nothing when the pick fits exactly", async () => {
    arrangeAnyCount();
    renderWithProviders(React.createElement(ClientMatterDetailPage));

    await pick(named(50));

    // Red if the notice keys off reaching 50 rather than going past it.
    await waitFor(() => expect(api.callsTo(`${DOCS}/upload-finalize`)).toHaveLength(1));
    expect(screen.queryByText(LIMIT_WARNING)).not.toBeInTheDocument();
  });

  it("drops the notice on the next pick that fits", async () => {
    arrangeAnyCount();
    renderWithProviders(React.createElement(ClientMatterDetailPage));

    await pick(named(51));
    await screen.findByText(LIMIT_WARNING);
    await waitFor(() => expect(screen.getByRole("button", { name: /Upload a document/ })).toBeEnabled());
    await pick(named(1));

    // Red if the notice outlives the pick it describes.
    await waitFor(() => expect(api.callsTo(`${DOCS}/upload-finalize`)).toHaveLength(2));
    expect(screen.queryByText(LIMIT_WARNING)).not.toBeInTheDocument();
  });
});
