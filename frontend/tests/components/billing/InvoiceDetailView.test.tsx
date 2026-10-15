import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockPermissionsValue } from "../../setup";

const mockUpdateInvoiceDetails = jest.fn();

// The invoice the detail view loads: one unpaid 0.5 hour time entry billed to
// client-1. Each test overrides only the fields its case is about.
function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    invoiceName: "Invoice - test client 1",
    invoiceDate: "2026-04-07",
    createdAt: "2026-04-07T00:00:00.000Z",
    clientId: "client-1",
    status: "unpaid",
    isPaid: false,
    totalAmount: 22,
    totalHours: 0.5,
    flatFeesAmount: 0,
    amountPaid: 0,
    totalWrittenOff: 0,
    remainingBalance: 22,
    payments: [],
    creditNotes: [],
    timeEntries: [
      {
        id: "te-1",
        description: "test entry 1",
        hours: 0.5,
        rate: 44,
        amount: 22,
      },
    ],
    flatFees: [],
    auditLog: [],
    stripePaymentRequested: false,
    ...overrides,
  };
}

// A single stable QueryClient stand-in. The component's data-loading callbacks
// depend on the queryClient identity, so returning a fresh object per render
// would retrigger their effects and loop the loading state forever.
const mockQueryClient = { invalidateQueries: jest.fn() };
jest.mock("@tanstack/react-query", () => ({
  __esModule: true,
  useQueryClient: () => mockQueryClient,
  // The firm's Stripe status reads as a firm with no Stripe account. The other
  // query is the request dialog's fee quote; no case here opens that dialog.
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) =>
    queryKey[0] === "stripeStatus"
      ? { data: { connected: false, chargesEnabled: false }, isError: false, isFetching: false, refetch: jest.fn() }
      : { data: undefined, isLoading: false, error: null },
}));

const mockNavigate = jest.fn();

jest.mock("@/contexts/NavigationContext", () => ({
  __esModule: true,
  useNavigation: () => ({
    navigate: mockNavigate,
  }),
}));

jest.mock("@/services/billing.service", () => ({
  __esModule: true,
  default: {
    listInvoices: jest.fn().mockResolvedValue([invoice()]),
    updateInvoiceDetails: (...args: unknown[]) => mockUpdateInvoiceDetails(...args),
  },
}));

// Matter clients as the API really returns them: `id` is the clients.id that
// invoices.client_id points at, and `userId` is the separate portal account id.
// They are deliberately different values here, because a mock that reused one id
// for both would pass whether the code matched on the right field or not.
jest.mock("@/services/matters.service", () => ({
  __esModule: true,
  default: {
    listClients: jest.fn().mockResolvedValue([
      {
        id: "client-1",
        userId: "portal-uid-1",
        name: "test client 1",
        email: "client@example.com",
      },
      {
        id: "client-2",
        userId: "portal-uid-2",
        name: "test client 2",
        email: "client2@example.com",
      },
    ]),
  },
}));

jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: {
    lookupClients: jest.fn().mockResolvedValue({
      items: [
        {
          id: "client-1",
          userId: "portal-uid-1",
          name: "test client 1",
          email: "client@example.com",
        },
        {
          id: "client-2",
          userId: "portal-uid-2",
          name: "test client 2",
          email: "client2@example.com",
        },
      ],
      hasMore: false,
    }),
    getClient: jest.fn().mockResolvedValue({
      id: "client-1",
      name: "test client 1",
      email: "client@example.com",
    }),
  },
}));

jest.mock("@/services/lawfirm.service", () => ({
  __esModule: true,
  default: {
    getLawFirmById: jest.fn().mockResolvedValue({
      id: "test-law-firm-id",
    }),
  },
}));

jest.mock("@/services/trust.service", () => ({
  __esModule: true,
  default: {
    getClientBalance: jest.fn().mockResolvedValue({
      totalBalanceCents: 0,
      accountBalances: [],
    }),
    listAccounts: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock("@/services/messages.service", () => ({
  __esModule: true,
  default: {
    uploadAttachments: jest.fn(),
    sendMessage: jest.fn(),
  },
}));

// Mock hooks used by InvoiceDetailView
jest.mock("@/hooks/useUsers", () => ({
  __esModule: true,
  useLawFirmUsers: () => ({
    users: [{ uid: "user-1", name: "Alice Smith", email: "alice@example.com" }],
    loading: false,
  }),
}));

jest.mock("@react-pdf/renderer", () => ({
  pdf: jest.fn(),
  Document: ({ children }: any) => React.createElement("div", null, children),
  Page: ({ children }: any) => React.createElement("div", null, children),
  Text: ({ children }: any) => React.createElement("span", null, children),
  View: ({ children }: any) => React.createElement("div", null, children),
  StyleSheet: { create: (s: any) => s },
  Image: (props: any) => React.createElement("img", props),
}));

jest.mock("@/lib/utils/fetchWithTokenRefresh", () => ({
  apiFetch: jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}));

jest.mock("@/lib/utils/auth", () => ({
  getFirebaseToken: jest.fn().mockResolvedValue("mock-token"),
}));

import InvoiceDetailView from "@/components/billingComp/InvoiceDetailView";

const defaultProps = {
  lawFirmId: "test-law-firm-id",
  entityId: "matter-1",
  invoiceId: "inv-1",
  contextType: "matter" as const,
  backHref: "/lawfirm/test-law-firm-id/matters/matter-1",
  backLabel: "Back to Matter",
};

describe("InvoiceDetailView", () => {
  beforeEach(() => {
    mockPermissionsValue.loading = false;
    mockPermissionsValue.hasPermission = () => true;
    mockUpdateInvoiceDetails.mockReset();
    mockUpdateInvoiceDetails.mockResolvedValue(invoice({ dueDate: "2026-04-21" }));
  });

  afterEach(() => {
    mockPermissionsValue.loading = false;
    mockPermissionsValue.hasPermission = () => true;
  });

  it("shows the Stripe setup prompt in a dedicated online payments card", async () => {
    render(React.createElement(InvoiceDetailView, defaultProps));
    expect(
      await screen.findByRole("heading", { name: "Online Payments" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Payment Settings" })).toBeInTheDocument();
  });

  it("lets you add a due date from the invoice details edit flow", async () => {
    render(React.createElement(InvoiceDetailView, defaultProps));

    fireEvent.click(await screen.findByRole("button", { name: "Edit invoice details" }));

    // Both dates are calendar buttons, not native date inputs. The issue date
    // already has a value and reads as it displays; the due date is the empty
    // one, so it still carries the placeholder.
    expect(screen.getByRole("button", { name: "Apr 7, 2026" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select date" }));
    fireEvent.click(screen.getByRole("button", { name: "21" }));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockUpdateInvoiceDetails).toHaveBeenCalledWith(
        { type: "matter", lawFirmId: "test-law-firm-id", entityId: "matter-1" },
        "inv-1",
        // The calendar opens on the month it opens on; what matters is that the
        // day the user clicked is the day that gets sent.
        expect.objectContaining({
          dueDate: expect.stringMatching(/^\d{4}-\d{2}-21$/),
        }),
      ),
    );
  });

  it("renders in read-only mode for invoice viewers without manage access", async () => {
    mockPermissionsValue.hasPermission = (permission: string) => permission === "billing.viewInvoices";

    render(React.createElement(InvoiceDetailView, defaultProps));

    expect(await screen.findByText("Back to Matter")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit invoice details" }),
    ).not.toBeInTheDocument();
  });

  it("lets an invoice manager correct the billing email from beside it", async () => {
    const billingService = jest.requireMock("@/services/billing.service").default;
    billingService.listInvoices.mockResolvedValueOnce([invoice({ billingSnapshotAt: "2026-10-01T12:00:00.000Z", billingEmails: ["wrong@example.com"] })]);
    render(React.createElement(InvoiceDetailView, defaultProps));

    fireEvent.click(await screen.findByRole("button", { name: "Edit billing email" }));

    const dialog = await screen.findByRole("dialog", { name: "Edit billing email" });
    // Seeded with the address the invoice goes to now, ready to correct.
    expect(within(dialog).getByRole("button", { name: "Remove wrong@example.com" })).toBeInTheDocument();
  });

  it("offers no billing email edit to a viewer", async () => {
    mockPermissionsValue.hasPermission = (permission: string) => permission === "billing.viewInvoices";

    render(React.createElement(InvoiceDetailView, defaultProps));

    expect(await screen.findByText("Back to Matter")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit billing email" })).not.toBeInTheDocument();
  });

  it("names the client the invoice is billed to, not the matter's first client", async () => {
    // invoices.client_id ("client-1") is a clients.id. It was being compared
    // against the matter client's portal userId, which never matched, so every
    // matter invoice fell through to the first client on the matter.
    render(React.createElement(InvoiceDetailView, defaultProps));

    expect(await screen.findByText("test client 1")).toBeInTheDocument();
    expect(screen.queryByText("test client 2")).not.toBeInTheDocument();
  });

  it("names no client when the invoice is not billed to one", async () => {
    const billingService = jest.requireMock("@/services/billing.service").default;
    billingService.listInvoices.mockResolvedValueOnce([
      invoice({
        invoiceName: "Matter-level invoice",
        clientId: null,
        matterClientId: null,
        timeEntries: [],
      }),
    ]);

    render(React.createElement(InvoiceDetailView, defaultProps));

    await screen.findByText("Back to Matter");
    // Neither matter client may be presented as the payer: nobody was chosen.
    expect(screen.queryByText("test client 1")).not.toBeInTheDocument();
    expect(screen.queryByText("test client 2")).not.toBeInTheDocument();
  });
});

/**
 * The Adjustments section, which nothing could cover until the API returned it.
 *
 * A late fee and an "add amount" raise the invoice total without creating a
 * line item, so they are the only record of why the total is what it is. The
 * detail API used to drop `amountAdjustmentNotes` entirely, which made this
 * section permanently empty: the client saw a total larger than the work listed
 * above it, with nothing on screen accounting for the difference.
 */
describe("InvoiceDetailView adjustments", () => {
  function invoiceWithAdjustments(amountAdjustmentNotes: unknown[]) {
    return [invoice({
      totalAmount: 47,
      remainingBalance: 47,
      timeEntries: [],
      amountAdjustmentNotes,
    })];
  }

  beforeEach(() => {
    mockPermissionsValue.loading = false;
    mockPermissionsValue.hasPermission = () => true;
  });

  it("lists a late fee with its amount", async () => {
    const billingService = jest.requireMock("@/services/billing.service").default;
    billingService.listInvoices.mockResolvedValueOnce(invoiceWithAdjustments([
      { kind: "late_fee", amount: 25, note: "Late fee", addedAt: "2026-05-01T00:00:00.000Z" },
    ]));

    render(React.createElement(InvoiceDetailView, defaultProps));

    expect(await screen.findByRole("heading", { name: "Adjustments" })).toBeInTheDocument();
    // The figure ON THE FEE'S OWN ROW. The section subtotal below carries the
    // same number, so a bare text match would pass on a row rendering nothing.
    const row = screen.getByText("Late fee").closest("tr") as HTMLElement;
    expect(within(row).getByText("$25.00")).toBeInTheDocument();
  });

  it("labels an adjustment that carries no note from its kind", async () => {
    const billingService = jest.requireMock("@/services/billing.service").default;
    billingService.listInvoices.mockResolvedValueOnce(invoiceWithAdjustments([
      { kind: "late_fee", amount: 25, note: null, addedAt: "2026-05-01T00:00:00.000Z" },
    ]));

    render(React.createElement(InvoiceDetailView, defaultProps));

    // Never the raw enum: "late_fee" on a client-facing invoice is a leak of
    // the column, not a description of the charge.
    expect(await screen.findByText("Late Fee")).toBeInTheDocument();
    expect(screen.queryByText("late_fee")).not.toBeInTheDocument();
  });

  it("shows no Adjustments section when there are none", async () => {
    const billingService = jest.requireMock("@/services/billing.service").default;
    billingService.listInvoices.mockResolvedValueOnce(invoiceWithAdjustments([]));

    render(React.createElement(InvoiceDetailView, defaultProps));

    await screen.findByText("Back to Matter");
    expect(screen.queryByRole("heading", { name: "Adjustments" })).not.toBeInTheDocument();
  });
});

/**
 * The PDF previews close by clearing their blob url, and the panel stays mounted
 * for its exit animation. The iframe has to keep showing the PDF while it fades,
 * and the blob can only be released once the panel is gone: revoking it on
 * close blanks the iframe for the length of the animation.
 */
describe("InvoiceDetailView PDF preview exit", () => {
  const pdfMock = jest.requireMock("@react-pdf/renderer").pdf as jest.Mock;
  const urlStatics = URL as unknown as {
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
  };
  const originalCreate = urlStatics.createObjectURL;
  const originalRevoke = urlStatics.revokeObjectURL;
  let createObjectURL: jest.Mock;
  let revokeObjectURL: jest.Mock;

  beforeEach(() => {
    mockPermissionsValue.loading = false;
    mockPermissionsValue.hasPermission = () => true;
    pdfMock.mockReturnValue({ toBlob: async () => new Blob(["%PDF"], { type: "application/pdf" }) });
    createObjectURL = jest.fn().mockReturnValueOnce("blob:preview-1");
    revokeObjectURL = jest.fn();
    urlStatics.createObjectURL = createObjectURL;
    urlStatics.revokeObjectURL = revokeObjectURL;
  });

  afterEach(() => {
    jest.useRealTimers();
    pdfMock.mockReset();
    urlStatics.createObjectURL = originalCreate;
    urlStatics.revokeObjectURL = originalRevoke;
  });

  // The close control is the icon-only button beside Download in the header.
  function closeButtonOf(dialog: HTMLElement): HTMLElement {
    const unnamed = within(dialog)
      .getAllByRole("button")
      .filter((button) => !button.textContent?.trim() && !button.getAttribute("aria-label"));
    expect(unnamed).toHaveLength(1);
    return unnamed[0];
  }

  it("keeps the invoice PDF in the fading preview and revokes its blob only after the exit", async () => {
    render(React.createElement(InvoiceDetailView, defaultProps));

    fireEvent.click(await screen.findByRole("button", { name: "Preview invoice PDF" }));
    const iframe = await screen.findByTitle("Invoice PDF Preview");
    expect(iframe).toHaveAttribute("src", "blob:preview-1");
    const dialog = screen.getByRole("dialog", { name: "Invoice Preview" });

    jest.useFakeTimers();
    fireEvent.click(closeButtonOf(dialog));

    // Closed, still animating out, still showing the same PDF.
    expect(dialog).toHaveClass("overlay-card-exit");
    expect(screen.getByTitle("Invoice PDF Preview")).toHaveAttribute("src", "blob:preview-1");
    expect(revokeObjectURL).not.toHaveBeenCalled();

    React.act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
    expect(screen.queryByTitle("Invoice PDF Preview")).not.toBeInTheDocument();
  });

  it("keeps the receipt PDF in the fading preview and revokes its blob only after the exit", async () => {
    const billingService = jest.requireMock("@/services/billing.service").default;
    billingService.listInvoices.mockResolvedValueOnce([
      invoice({
        invoiceNumber: "INV-1",
        status: "paid",
        isPaid: true,
        amountPaid: 22,
        remainingBalance: 0,
        payments: [{ amount: 22, date: "2026-04-10", note: "Check", paymentSource: "manual" }],
        timeEntries: [],
      }),
    ]);

    render(React.createElement(InvoiceDetailView, defaultProps));

    const viewButtons = await screen.findAllByRole("button", { name: "View receipt" });
    fireEvent.click(viewButtons[0]);
    const iframe = await screen.findByTitle("Receipt PDF Preview");
    expect(iframe).toHaveAttribute("src", "blob:preview-1");
    const dialog = screen.getByRole("dialog", { name: "Receipt Preview" });

    jest.useFakeTimers();
    fireEvent.click(closeButtonOf(dialog));

    expect(dialog).toHaveClass("overlay-card-exit");
    expect(screen.getByTitle("Receipt PDF Preview")).toHaveAttribute("src", "blob:preview-1");
    expect(revokeObjectURL).not.toHaveBeenCalled();

    React.act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
    expect(screen.queryByTitle("Receipt PDF Preview")).not.toBeInTheDocument();
  });
});

describe("InvoiceDetailView line item column widths", () => {
  /**
   * The read view's line tables sized their columns from their content, so an
   * amount that gained a digit widened its own column and took the width out of
   * the description beside it, rewrapping a line nobody had touched. jsdom lays
   * out no tables, so this pins the mechanism that stops it rather than the
   * pixels: fixed layout, and a width declared once per column.
   */
  beforeEach(() => {
    mockPermissionsValue.loading = false;
    mockPermissionsValue.hasPermission = () => true;
  });

  it("lays out the time entries table with fixed columns", async () => {
    render(React.createElement(InvoiceDetailView, defaultProps));

    const row = (await screen.findByText("test entry 1")).closest("table") as HTMLElement;
    expect(row).toHaveClass("table-fixed");

    const cols = Array.from(row.querySelectorAll("col"));
    // Description, rate, hours, amount. The read view has no action column.
    expect(cols).toHaveLength(4);
    // The prose column takes what the sized ones leave.
    expect(cols[0].getAttribute("class")).toBeNull();
    cols.slice(1).forEach((col) => expect(col.getAttribute("class")).toMatch(/^w-/));
  });
});

describe("InvoiceDetailView client link", () => {
  /**
   * The billed client was plain text, so reading an invoice and then wanting the
   * client behind it meant going back out through the list. It is a link now,
   * but only where there is somewhere to land: an invoice can name a client it
   * has no id for (a frozen bill-to snapshot), and `clients.view` is what the
   * client page itself requires, so without it the link would open a refusal.
   */
  beforeEach(() => {
    mockPermissionsValue.loading = false;
    mockPermissionsValue.hasPermission = () => true;
    mockNavigate.mockClear();
  });

  afterEach(() => {
    mockPermissionsValue.hasPermission = () => true;
  });

  it("opens the client's page from the billed client's name", async () => {
    render(React.createElement(InvoiceDetailView, defaultProps));

    const link = await screen.findByRole("button", { name: /test client 1/ });
    fireEvent.click(link);

    expect(mockNavigate).toHaveBeenCalledWith("/lawfirm/test-law-firm-id/clients/client-1");
  });

  it("takes the whole block as the target, not just the name", async () => {
    // A one-word name is a small thing to hit. The address under it belongs to
    // the same client, so it is part of the same control rather than dead space
    // beside a link.
    render(React.createElement(InvoiceDetailView, defaultProps));

    const link = await screen.findByRole("button", { name: /test client 1/ });

    expect(link).toHaveTextContent("client@example.com");
    expect(link.className).toContain("hover:bg-surface-hover");
  });

  it("puts no button inside the client button", async () => {
    // The Organization roster trigger used to sit on the icon beside the name.
    // Inside the block button that would be a nested button, which is invalid
    // and swallows one of the two clicks, so it moved out to a sibling.
    render(React.createElement(InvoiceDetailView, defaultProps));

    const link = await screen.findByRole("button", { name: /test client 1/ });

    expect(link.querySelector("button")).toBeNull();
  });

  it("prints the name as text for a reader who cannot open a client", async () => {
    mockPermissionsValue.hasPermission = (code: string) => code !== "clients.view";

    render(React.createElement(InvoiceDetailView, defaultProps));

    expect(await screen.findByText("test client 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /test client 1/ })).not.toBeInTheDocument();
  });

  it("prints the name as text when the invoice carries no client id", async () => {
    const billingService = jest.requireMock("@/services/billing.service").default;
    billingService.listInvoices.mockResolvedValueOnce([
      invoice({
        invoiceName: "Snapshot-only invoice",
        clientId: null,
        matterClientId: null,
        clientName: "Snapshot Only Ltd",
        timeEntries: [],
      }),
    ]);

    render(React.createElement(InvoiceDetailView, defaultProps));

    expect(await screen.findByText("Snapshot Only Ltd")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Snapshot Only Ltd/ })).not.toBeInTheDocument();
  });
});


/**
 * The portal send uploads the invoice PDF as a message attachment. Finalize can
 * refuse a file and still answer 200, reporting it through `onRejected` while
 * returning only the files it accepted. A refused invoice must be reported by
 * name, and the message that says "I've attached invoice ..." must not go out
 * without it.
 */
describe("InvoiceDetailView portal send with a refused attachment", () => {
  const pdfMock = jest.requireMock("@react-pdf/renderer").pdf as jest.Mock;
  const messagesMock = jest.requireMock("@/services/messages.service").default as {
    uploadAttachments: jest.Mock;
    sendMessage: jest.Mock;
  };

  beforeEach(() => {
    mockPermissionsValue.loading = false;
    mockPermissionsValue.hasPermission = () => true;
    pdfMock.mockReturnValue({ toBlob: async () => new Blob(["%PDF"], { type: "application/pdf" }) });
    messagesMock.uploadAttachments.mockReset();
    messagesMock.sendMessage.mockReset().mockResolvedValue({});
  });

  afterEach(() => {
    pdfMock.mockReset();
  });

  async function sendViaPortal() {
    render(React.createElement(InvoiceDetailView, defaultProps));
    fireEvent.click(await screen.findByRole("button", { name: "Send to Client" }));
    const portalButton = await screen.findByRole("button", { name: /Send via Client Portal/ });
    await waitFor(() => expect(portalButton).toBeEnabled());
    fireEvent.click(portalButton);
    await waitFor(() => expect(messagesMock.uploadAttachments).toHaveBeenCalledTimes(1));
  }

  // Red if: a refused invoice PDF is dropped silently, or the message still goes.
  it("names the refused file and sends no message", async () => {
    messagesMock.uploadAttachments.mockImplementation(
      async (_firm: string, _target: unknown, files: File[], _progress: unknown, options?: {
        onRejected?: (rejected: Array<{ name: string; error: string }>) => void;
      }) => {
        options?.onRejected?.([{ name: files[0].name, error: "File content does not match its type" }]);
        return [];
      },
    );

    await sendViaPortal();

    const uploadedName = (messagesMock.uploadAttachments.mock.calls[0][2] as File[])[0].name;
    expect(
      await screen.findByText(`Could not attach "${uploadedName}": File content does not match its type`),
    ).toBeInTheDocument();
    expect(messagesMock.sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Invoice sent to /)).not.toBeInTheDocument();
  });

  // Red if: the rejection handling also blocks a send whose attachment was accepted.
  it("sends the message with the attachment when nothing is refused", async () => {
    messagesMock.uploadAttachments.mockResolvedValue([{ id: "att-1" }]);

    await sendViaPortal();

    await waitFor(() => expect(messagesMock.sendMessage).toHaveBeenCalledTimes(1));
    expect(messagesMock.sendMessage.mock.calls[0][0]).toMatchObject({
      clientId: "portal-uid-1",
      attachments: [{ id: "att-1" }],
    });
    expect(await screen.findByText(/^Invoice sent to /)).toBeInTheDocument();
    expect(screen.queryByText(/Could not attach/)).not.toBeInTheDocument();
  });
});

describe("InvoiceDetailView next payment placement", () => {
  it("renders Next Payment stacked within the Due Date column (desktop) and full-width (mobile)", async () => {
    const billingService = jest.requireMock("@/services/billing.service").default;
    billingService.listInvoices.mockResolvedValueOnce([
      invoice({
        invoiceName: "Plan Invoice",
        dueDate: "2031-05-16",
        nextPaymentDate: "2026-10-16",
        paymentPlan: {
          enabled: true,
          frequency: "monthly",
          installments: [],
        },
      }),
    ]);

    render(React.createElement(InvoiceDetailView, defaultProps));

    const dueDateLabel = await screen.findByText("Due Date");
    const nextPaymentLabels = await screen.findAllByText("Next Payment");

    // 2 responsive instances: one for desktop inside column 2, one for mobile spanning full width
    expect(nextPaymentLabels.length).toBe(2);

    const desktopInstance = nextPaymentLabels.find((el) =>
      Boolean(el.closest(".hidden") || el.closest(".md\\:block"))
    );
    const mobileInstance = nextPaymentLabels.find((el) =>
      Boolean(el.closest(".col-span-2") || el.closest(".md\\:hidden"))
    );

    expect(desktopInstance).toBeDefined();
    expect(mobileInstance).toBeDefined();

    // The desktop instance is nested in the Due Date column container
    const dueDateCol = dueDateLabel.closest("div");
    expect(dueDateCol).toContainElement(desktopInstance!);
  });
});

