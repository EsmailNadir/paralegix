/**
 * `FillTemplateModal`: restoring a saved fill, its overlays while they animate
 * closed, and cancelling a save to Files.
 *
 * CLOSING. Two surfaces stay on screen for an exit animation after whatever
 * closes them has already changed their state: the fill dialog itself after a
 * save to Files (which reports "Saved!" and then closes), and the Field Usage
 * overlay, a custom overlay with its own mount transition that closes while the
 * dialog behind it stays open. Each spec reads the surface while it carries the
 * exit class and fails if its content changed on the way out.
 *
 * CANCELLING A SAVE. The destination picker's Cancel stays live while the save
 * runs. It used to close the picker and nothing else: the render and upload
 * carried on, the document was filed anyway, and the fill dialog then announced
 * "Saved!" and closed itself, all after the user had cancelled. These go red if
 * the dialog does not hand a signal to `filesService.upload`, the picker's
 * Cancel (or unmounting) does not abort it, the upload starts after a cancel
 * that landed during the render, or a cancel is reported as a failure or a
 * success.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { UploadCancelledError } from "@/lib/files/resumableUpload";

const mockUseQuery = jest.fn();

jest.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useQueries: () => [],
}));

// Stands in for the destination picker: confirming it hands the fill dialog a
// destination, which is all the save path needs from it. Its Cancel stays on
// screen while the save runs, as the real one's does.
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

const mockFillDocxTemplate = jest.fn();
const mockUpload = jest.fn();

jest.mock("@/services/templates.service", () => ({
  __esModule: true,
  templatesService: {
    fillDocxTemplate: (...args: unknown[]) => mockFillDocxTemplate(...args),
    getById: jest.fn(),
  },
}));

jest.mock("@/services/files.service", () => ({
  __esModule: true,
  default: { upload: (...args: unknown[]) => mockUpload(...args) },
}));

// The sanitizer's output is not under test here, so it passes the markup through.
jest.mock("@/lib/utils/sanitizeHtml", () => ({
  __esModule: true,
  sanitizeRichHtml: (html?: string | null) => html ?? "",
}));

import FillTemplateModal from "@/components/templatesComp/FillTemplateModal";

type TemplateProp = React.ComponentProps<typeof FillTemplateModal>["template"];

/** Answer only the template-detail query, with `detail`. */
function mockTemplateDetail(detail: Record<string, unknown>) {
  mockUseQuery.mockImplementation(({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "template-fill-detail") {
      return { data: detail, isLoading: false };
    }
    return { data: undefined, isLoading: false };
  });
}

/** Serve the filled PDF the save downloads before uploading it. */
function servePdfDownload() {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    blob: async () => new Blob(["%PDF-1.7"], { type: "application/pdf" }),
  }) as unknown as typeof fetch;
}

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("FillTemplateModal restoring a saved fill", () => {
  const template = {
    id: "template-1",
    name: "Test Template",
    type: "html" as const,
    fields: ["full_date", "client_last_name", "pay", "payment.date", "payment.rateofpay"],
    repeaters: [{ name: "payment", fields: ["date", "rateofpay"] }],
    folderId: null,
    createdAt: "2026-04-09T00:00:00.000Z",
  };

  beforeEach(() => {
    // The matter picker is server-backed now: the enriched matter arrives from
    // the matters /lookup query (full=true) rather than a full-firm matter list.
    const enrichedMatter = {
      id: "case-1",
      name: "Case A",
      label: "Case A",
      sublabel: "Jane Doe",
      matterNumber: "2026-CV-1",
      clientUserIds: ["client-1"],
      clientNames: ["Jane Doe"],
      clients: [{ id: "client-1", userId: "client-1", name: "Jane Doe" }],
    };

    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: string[] }) => {
      if (queryKey[0] === "matters" && queryKey[2] === "lookup") {
        return { data: { items: [enrichedMatter], hasMore: false }, isFetching: false };
      }

      // The client picker is server-backed too: the enriched client arrives from
      // the clients /lookup query (full=true) rather than a full-firm client list.
      if (queryKey[0] === "clients" && queryKey[2] === "lookup") {
        return {
          data: {
            items: [
              {
                id: "client-1",
                userId: "client-1",
                name: "Jane Doe",
                label: "Jane Doe",
                email: "jane@example.com",
              },
            ],
            hasMore: false,
          },
          isFetching: false,
        };
      }

      if (queryKey[0] === "template-fill-matter-clients") {
        return {
          data: [{ id: "client-1", userId: "client-1", name: "Jane Doe", email: "jane@example.com" }],
          isLoading: false,
        };
      }

      if (queryKey[0] === "template-fill-detail") {
        return {
          data: {
            ...template,
            html: "<html><body><div class=\"pdf-page\"></div></body></html>",
            assets: [],
          },
          isLoading: false,
        };
      }

      return { data: undefined, isLoading: false };
    });
  });

  it("restores saved fields, repeater rows, and selections without overwriting them with autofill", async () => {
    render(
      React.createElement(FillTemplateModal, {
        template,
        lawFirmId: "test-law-firm-id",
        onClose: jest.fn(),
        initialValues: {
          full_date: "April 1, 2000",
          client_last_name: "Saved Last",
          pay: "324234",
        },
        initialRepeaterValues: {
          payment: [{ date: "4/12/2026", rateofpay: "300" }],
        },
        initialSelectedMatterId: "case-1",
        initialSelectedClientId: "client-1",
      })
    );

    expect(await screen.findByDisplayValue("April 1, 2000")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Saved Last")).toBeInTheDocument();
    expect(screen.getByDisplayValue("324234")).toBeInTheDocument();
    expect(screen.getByDisplayValue("4/12/2026")).toBeInTheDocument();
    expect(screen.getByDisplayValue("300")).toBeInTheDocument();

    await waitFor(() => {
      // EntityPicker renders its selection as the trigger's label, not an input.
      expect(screen.getAllByText(/Case A/).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Jane Doe/).length).toBeGreaterThan(0);
    });
  });

  it("ignores removed fields while leaving new fields empty on restore", async () => {
    render(
      React.createElement(FillTemplateModal, {
        template: {
          ...template,
          fields: ["client_last_name", "new_field", "payment.date", "payment.rateofpay"],
        },
        lawFirmId: "test-law-firm-id",
        onClose: jest.fn(),
        initialValues: {
          removed_field: "should be ignored",
          client_last_name: "Restored Last",
        },
        initialRepeaterValues: {
          payment: [{ date: "Saved Date", removed_sub_field: "ignored" }],
        },
      })
    );

    expect(await screen.findByDisplayValue("Restored Last")).toBeInTheDocument();
    expect(screen.queryByText("removed_field")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Saved Date")).toBeInTheDocument();

    // Reach each input by its own placeholder rather than by walking up from the
    // label: the label carries a required marker and a "View line" control, so
    // its text is not the field name alone and its DOM shape is free to change.
    expect(screen.getByPlaceholderText("Enter new_field")).toHaveValue("");
    expect(screen.getByPlaceholderText("Enter rateofpay")).toHaveValue("");
  });
});

function Harness({ template }: { template: TemplateProp }) {
  const [open, setOpen] = React.useState(true);
  return (
    <FillTemplateModal
      template={template}
      lawFirmId="firm-1"
      open={open}
      onClose={() => setOpen(false)}
    />
  );
}

describe("FillTemplateModal closing", () => {
  it("still reads Saved! while the dialog animates out after saving to Files", async () => {
    const template = {
      id: "template-1",
      name: "Engagement",
      type: "docx" as const,
      fields: [],
      repeaters: [],
      folderId: null,
      createdAt: "2026-04-09T00:00:00.000Z",
    } as unknown as TemplateProp;
    mockTemplateDetail({ ...template, assets: [] });
    mockFillDocxTemplate.mockResolvedValue({ url: "https://storage.example/filled.pdf" });
    mockUpload.mockResolvedValue({});
    servePdfDownload();

    render(<Harness template={template} />);

    fireEvent.click(screen.getByRole("button", { name: "Save to files" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm destination" }));

    expect(await screen.findByText("Saved!")).toBeInTheDocument();
    expect(mockUpload).toHaveBeenCalledTimes(1);

    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(dialog).toHaveClass("overlay-card-exit"), { timeout: 2500 });
    expect(within(dialog).getByText("Saved!")).toBeInTheDocument();
    expect(within(dialog).queryByText("Save to Files")).not.toBeInTheDocument();
  });

  it("keeps the matching line in the Field Usage overlay while it animates out", async () => {
    const html =
      '<html><body><div class="pdf-page">' +
      '<p>Payable to <span data-placeholder-chip="payee">payee</span> on receipt</p>' +
      "</div></body></html>";
    const template = {
      id: "template-2",
      name: "Invoice",
      type: "html" as const,
      fields: ["payee"],
      repeaters: [],
      folderId: null,
      createdAt: "2026-04-09T00:00:00.000Z",
    } as unknown as TemplateProp;
    mockTemplateDetail({ ...template, html, assets: [] });

    render(<Harness template={template} />);

    fireEvent.click(screen.getByText("View line").closest("button")!);

    const overlay = await screen.findByRole("dialog", { name: "Field Usage" });
    expect(overlay).toHaveTextContent("Payable to payee on receipt");

    fireEvent.click(within(overlay).getByRole("button", { name: "Close field usage preview" }));

    await waitFor(() => expect(overlay).toHaveClass("overlay-card-exit"));
    expect(overlay).toHaveTextContent("Payable to payee on receipt");
    expect(
      within(overlay).queryByText("This field does not appear in a previewable line yet."),
    ).not.toBeInTheDocument();
  });

  it("stacks the Field Usage overlay above the fill dialog, outside its animated panel", async () => {
    const template = {
      id: "template-3",
      name: "Invoice",
      type: "html" as const,
      fields: ["payee"],
      repeaters: [],
      folderId: null,
      createdAt: "2026-04-09T00:00:00.000Z",
    } as unknown as TemplateProp;
    mockTemplateDetail({ ...template, html: "<p>payee</p>", assets: [] });

    render(<Harness template={template} />);
    const fillDialog = screen.getByRole("dialog");

    fireEvent.click(screen.getByText("View line").closest("button")!);
    const overlay = await screen.findByRole("dialog", { name: "Field Usage" });

    // Inside the fill panel, a transformed ancestor would trap the overlay's
    // fixed positioning and z-index under the panel it was opened from.
    expect(fillDialog).not.toContainElement(overlay);
    expect(overlay.closest(".fixed")).toHaveClass("z-[60]");
  });
});

const docxTemplate = {
  id: "template-1",
  name: "Engagement",
  type: "docx" as const,
  fields: [],
  repeaters: [],
  folderId: null,
  createdAt: "2026-04-09T00:00:00.000Z",
} as unknown as TemplateProp;

/** A promise the spec settles by hand, to hold a step in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Like `filesService.upload`: rejects with `UploadCancelledError` once its signal aborts. */
function holdUpload() {
  const held = deferred<unknown>();
  const seen: { signal?: AbortSignal } = {};
  mockUpload.mockImplementation((...args: unknown[]) => {
    seen.signal = args[5] as AbortSignal | undefined;
    return new Promise((resolve, reject) => {
      seen.signal?.addEventListener("abort", () => reject(new UploadCancelledError()), { once: true });
      held.promise.then(resolve);
    });
  });
  return { held, seen };
}

describe("FillTemplateModal cancelling a save to Files", () => {
  const onClose = jest.fn();

  beforeEach(() => {
    mockTemplateDetail({ ...docxTemplate, assets: [] });
    servePdfDownload();
  });

  function renderModal() {
    return render(
      <FillTemplateModal template={docxTemplate} lawFirmId="firm-1" open onClose={onClose} />,
    );
  }

  it("aborts the upload and neither reports it saved nor as a failure", async () => {
    mockFillDocxTemplate.mockResolvedValue({ url: "https://storage.example/filled.pdf" });
    const { held, seen } = holdUpload();

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Save to files" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm destination" }));
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Cancel save" }));
    // Unaborted, this is the upload landing after the cancel.
    await act(async () => { held.resolve({ files: [] }); });

    expect(seen.signal?.aborted).toBe(true);
    expect(screen.queryByText("Saved!")).not.toBeInTheDocument();
    expect(screen.queryByText(/Failed to save to files|upload was cancelled/i)).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("uploads nothing when cancelled while the document is still rendering", async () => {
    const rendering = deferred<{ url: string }>();
    mockFillDocxTemplate.mockImplementation(() => rendering.promise);
    mockUpload.mockResolvedValue({ files: [] });

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Save to files" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm destination" }));
    await waitFor(() => expect(mockFillDocxTemplate).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Cancel save" }));
    await act(async () => { rendering.resolve({ url: "https://storage.example/filled.pdf" }); });

    expect(mockUpload).not.toHaveBeenCalled();
    expect(screen.queryByText("Saved!")).not.toBeInTheDocument();
  });

  it("aborts the upload when the dialog unmounts mid-save", async () => {
    mockFillDocxTemplate.mockResolvedValue({ url: "https://storage.example/filled.pdf" });
    const { seen } = holdUpload();

    const { unmount } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Save to files" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm destination" }));
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));

    unmount();

    expect(seen.signal?.aborted).toBe(true);
  });
});
