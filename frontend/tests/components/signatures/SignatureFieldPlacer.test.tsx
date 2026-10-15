import React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../../support/renderWithProviders";
import { deferred } from "../../support/deferred";

// The rects a real layout would give two stacked pages with a gap. jsdom has no
// layout, so the stub pins them onto the page elements itself; the cross-page
// drag resolves pages purely from this geometry.
const STUB_PAGE_RECTS: Record<number, DOMRect> = {
  1: { left: 100, right: 900, top: 0, bottom: 1000, width: 800, height: 1000 } as DOMRect,
  2: { left: 100, right: 900, top: 1016, bottom: 2016, width: 800, height: 1000 } as DOMRect,
};

// Named so the hooks lint rule sees a component. Reports a 3-page document, and
// renders pages 1 and 2 (tagged and measured like the real stack) so a test can
// watch a field move between them.
function ViewerStub({ onDocumentLoad, onPageClick, children }: any) {
  React.useEffect(() => {
    onDocumentLoad?.(3);
  }, [onDocumentLoad]);
  return React.createElement(
    "div",
    null,
    React.createElement(
      "button",
      {
        type: "button",
        onClick: () => onPageClick(1, 10, 10),
      },
      "Add field",
    ),
    // The viewer calls this once per page: children(page, width, height).
    ...(typeof children === "function"
      ? [1, 2].map((page) =>
          React.createElement(
            "div",
            {
              key: page,
              "data-testid": `page-${page}`,
              "data-pdf-page": page,
              ref: (el: HTMLElement | null) => {
                if (el) el.getBoundingClientRect = () => STUB_PAGE_RECTS[page];
              },
            },
            children(page, 800, 1000),
          ),
        )
      : [children]),
  );
}
jest.mock("@/components/signaturesComp/PDFPageViewer", () => ({
  __esModule: true,
  default: (props: any) => React.createElement(ViewerStub, props),
}));

jest.mock("@/components/signaturesComp/SignatureVisual", () => ({
  __esModule: true,
  default: () => React.createElement("div", null, "Signature placeholder"),
}));

jest.mock("@/components/signaturesComp/DestinationPickerModal", () => ({
  __esModule: true,
  default: () => null,
}));

const mockSendSigningRequest = jest.fn().mockResolvedValue({});
const mockGetSigningTemplate = jest.fn();
const mockCreateSigningTemplate = jest.fn().mockResolvedValue({});

jest.mock("@/services/signatures.service", () => ({
  __esModule: true,
  default: {
    getSigningTemplate: (...args: any[]) => mockGetSigningTemplate(...args),
    createSigningTemplate: (...args: any[]) => mockCreateSigningTemplate(...args),
    sendSigningRequest: (...args: any[]) => mockSendSigningRequest(...args),
    listSigningRecipients: (...args: any[]) => mockListSigningRecipients(...args),
  },
}));

const mockLookupClients = jest.fn().mockResolvedValue({ items: [], hasMore: false });

// In-Paralegix delivery reads its recipients from the dedicated
// `/signature-links/recipients` endpoint, not the generic client lookup: only
// that endpoint can see a company's roster contacts, whose portal identity
// lives on `contact_clients` rather than `clients.user_id`.
const mockListSigningRecipients = jest.fn().mockResolvedValue({ items: [], hasMore: false });

/** One row as the recipients endpoint returns it. */
function recipient(over: Record<string, unknown> = {}) {
  return {
    userId: "firebase-uid-abc",
    name: "Ada Client",
    email: "ada@example.com",
    clientId: "client-row-id",
    clientName: "Ada Client",
    clientType: "person" as const,
    companyLinkId: null,
    companyName: null,
    ...over,
  };
}

jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: {
    lookupClients: (...args: any[]) => mockLookupClients(...args),
  },
}));

jest.mock("@/services/lawfirm.service", () => ({
  __esModule: true,
  default: {
    getLawFirmMembers: jest.fn().mockResolvedValue([]),
  },
}));

import SignatureFieldPlacer from "@/components/signaturesComp/SignatureFieldPlacer";

describe("SignatureFieldPlacer", () => {
  const defaultProps = {
    file: { url: "https://example.com/test.pdf", name: "test.pdf", bytes: new Uint8Array([1, 2, 3]) },
    lawFirmId: "law-firm-1",
    objectPath: "signatures/test.pdf",
    onBack: jest.fn(),
  };

  // The portal client picker is an `EntityPicker`, so it reads its options
  // through React Query rather than a preloaded list.
  function renderPlacer(props: Partial<typeof defaultProps> & Record<string, any> = {}) {
    return renderWithProviders(React.createElement(SignatureFieldPlacer, { ...defaultProps, ...props } as any));
  }

  beforeEach(() => {
    mockSendSigningRequest.mockClear();
    mockSendSigningRequest.mockResolvedValue({});
    mockGetSigningTemplate.mockReset();
    mockCreateSigningTemplate.mockClear();
    mockLookupClients.mockReset();
    mockLookupClients.mockResolvedValue({ items: [], hasMore: false });
    mockListSigningRecipients.mockReset();
    mockListSigningRecipients.mockResolvedValue({ items: [], hasMore: false });
  });

  /** Selects the first signer's delivery method and then a portal client. */
  async function pickPortalClient(user: ReturnType<typeof userEvent.setup>, optionName: RegExp) {
    await user.click(await screen.findByRole("button", { name: /send via email/i }));
    await user.click(await screen.findByRole("option", { name: "Send in Paralegix" }));

    await user.click(await screen.findByRole("button", { name: /search portal clients and team/i }));
    await user.click(await screen.findByRole("option", { name: optionName }));
  }

  /**
   * The portal signer's identity is the linked Firebase UID (`userId`), not the
   * `clients` row id, and the two are different values. Pinned because the
   * picker is an `EntityPicker` keyed on `clients.id`: without an explicit
   * id -> userId mapping it would send the signing request to a different
   * identity with no visible change in the UI.
   */
  it("sends the portal signer's linked user id, not the client row id", async () => {
    const user = userEvent.setup();

    mockListSigningRecipients.mockResolvedValue({ items: [recipient()], hasMore: false });

    renderPlacer();

    await pickPortalClient(user, /Ada Client/);

    await user.click(screen.getByRole("button", { name: /continue to place fields/i }));
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.click(screen.getByRole("button", { name: /^continue$/i }));
    await user.click(screen.getByRole("button", { name: /send for signing/i }));

    await waitFor(() => expect(mockSendSigningRequest).toHaveBeenCalled());

    const [, payload] = mockSendSigningRequest.mock.calls[0];
    expect(payload.signers).toHaveLength(1);
    expect(payload.signers[0]).toMatchObject({
      deliveryMethod: "portal",
      clientUserId: "firebase-uid-abc",
      name: "Ada Client",
    });
    expect(payload.signers[0].clientUserId).not.toBe("client-row-id");
  });

  // The generic client lookup cannot see a company's roster contacts, so it
  // would silently omit every company-linked signer. The picker must read the
  // dedicated recipients endpoint instead.
  it("reads signers from the recipients endpoint, not the generic client lookup", async () => {
    const user = userEvent.setup();

    renderPlacer();

    await user.click(await screen.findByRole("button", { name: /send via email/i }));
    await user.click(await screen.findByRole("option", { name: "Send in Paralegix" }));
    await user.click(await screen.findByRole("button", { name: /search portal clients and team/i }));

    await waitFor(() => expect(mockListSigningRecipients).toHaveBeenCalled());
    expect(mockLookupClients).not.toHaveBeenCalled();
  });

  /**
   * The server only returns portal-linked clients here, so a row without a
   * `userId` means the contract broke. The old code fell back to the `clients`
   * row id, which submits a client id in a field the backend reads as a user id.
   * Refusing to send is the only safe answer: the alternative is silently asking
   * the wrong party, or nobody, to sign.
   */
  it("blocks sending when the chosen portal client has no linked portal account", async () => {
    const user = userEvent.setup();

    mockListSigningRecipients.mockResolvedValue({
      // Whitespace, not empty: an empty id reads as "nothing picked yet" and gets
      // the generic prompt, while a present-but-unusable id is the broken-contract
      // case this test is about.
      items: [recipient({ userId: " ", name: "Unlinked Client", email: "unlinked@example.com", clientName: "Unlinked Client" })],
      hasMore: false,
    });

    renderPlacer();

    await pickPortalClient(user, /Unlinked Client/);

    expect(
      await screen.findByText(/Unlinked Client has no client portal account/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to place fields/i })).toBeDisabled();
    expect(mockSendSigningRequest).not.toHaveBeenCalled();
  });

  // The flow is now three steps: choose signers -> place fields -> review & send.
  // The initial signer defaults to Email delivery, so it needs an email before
  // "Continue to Place Fields" is enabled.
  async function goToFields(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByPlaceholderText("signer@example.com"), "client@example.com");
    await user.click(screen.getByRole("button", { name: /continue to place fields/i }));
  }

  it("blocks sending when an added signer has no assigned fields", async () => {
    const user = userEvent.setup();

    renderPlacer();

    // Signers step: give the initial Client an email, add a second (email) signer
    // and give it an email too, so only the field assignment is missing.
    await user.type(await screen.findByPlaceholderText("signer@example.com"), "client@example.com");
    await user.click(screen.getByRole("button", { name: /add signer/i }));
    const emailInputs = screen.getAllByPlaceholderText("signer@example.com");
    await user.type(emailInputs[1], "signer2@example.com");

    await user.click(screen.getByRole("button", { name: /continue to place fields/i }));

    // Both signers appear in the placement strip.
    expect(screen.getByRole("button", { name: /placing for client/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /placing for signer/i })).toBeInTheDocument();

    // The newly added signer is auto-selected, so this field goes to it, leaving
    // the Client with none.
    await user.click(screen.getByRole("button", { name: "Add field" }));

    // Open Review & Send.
    await user.click(screen.getByRole("button", { name: /^continue$/i }));

    expect(await screen.findByText(/has no fields assigned/i)).toBeInTheDocument();
    expect(screen.getByText(/assign at least one field or remove this signer before sending/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send for signing/i })).toBeDisabled();
  });

  it("clears the signer-without-fields error as soon as that signer is removed", async () => {
    const user = userEvent.setup();

    renderPlacer();

    await user.type(await screen.findByPlaceholderText("signer@example.com"), "client@example.com");
    await user.click(screen.getByRole("button", { name: /add signer/i }));
    const emailInputs = screen.getAllByPlaceholderText("signer@example.com");
    await user.type(emailInputs[1], "signer2@example.com");
    await user.click(screen.getByRole("button", { name: /continue to place fields/i }));

    // Field goes to the auto-selected second signer; the Client is left empty.
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.click(screen.getByRole("button", { name: /^continue$/i }));

    expect(await screen.findByText(/has no fields assigned/i)).toBeInTheDocument();

    // Close the review dialog (Escape) and delete the empty Client from the strip.
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /delete client/i }));

    // Re-open the review: the error is gone and sending is enabled.
    await user.click(screen.getByRole("button", { name: /^continue$/i }));

    await waitFor(() => {
      expect(screen.queryByText(/has no fields assigned/i)).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /send for signing/i })).not.toBeDisabled();
  });

  it("renders signer recap rows as non-interactive summaries", async () => {
    const user = userEvent.setup();

    renderPlacer();

    await goToFields(user);
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.click(screen.getByRole("button", { name: /^continue$/i }));

    const review = await screen.findByRole("dialog", { name: /review & send/i });
    const signerName = within(review).getByText("Client: client@example.com");
    expect(signerName.closest("button")).toBeNull();
  });

  it("deletes a signer from the top strip along with that signer's fields", async () => {
    const user = userEvent.setup();

    const { container } = renderPlacer();

    await goToFields(user);

    // Place a field for the Client, add a second signer (auto-selected), place a
    // field for it.
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.click(screen.getByRole("button", { name: /add signer/i }));
    await user.click(screen.getByRole("button", { name: "Add field" }));

    expect(screen.getByText("2 fields placed")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /delete signer/i }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /placing for signer/i })).not.toBeInTheDocument();
    });
    expect(screen.getByText("1 field placed")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-signer-active="true"]')).toHaveLength(1);
  });

  it("focuses that signer's fields when a signer is selected from the top strip", async () => {
    const user = userEvent.setup();
    const { container } = renderPlacer();

    await goToFields(user);

    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.click(screen.getByRole("button", { name: /add signer/i }));
    await user.click(screen.getByRole("button", { name: "Add field" }));

    await waitFor(() => {
      const overlays = Array.from(container.querySelectorAll('[data-annotation="field"]'));
      expect(overlays).toHaveLength(2);
      expect(overlays[0]).toHaveAttribute('data-signer-active', 'false');
      expect(overlays[1]).toHaveAttribute('data-signer-active', 'true');
    });

    await user.click(screen.getByRole("button", { name: /placing for client/i }));

    await waitFor(() => {
      const overlays = Array.from(container.querySelectorAll('[data-annotation="field"]'));
      expect(overlays).toHaveLength(2);
      expect(overlays[0]).toHaveAttribute('data-signer-active', 'true');
      expect(overlays[1]).toHaveAttribute('data-signer-active', 'false');
    });
  });

  it("auto-selects a newly added signer for the next placed field", async () => {
    const user = userEvent.setup();
    const { container } = renderPlacer();

    await goToFields(user);

    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.click(screen.getByRole("button", { name: /add signer/i }));
    await user.click(screen.getByRole("button", { name: "Add field" }));

    await waitFor(() => {
      const overlays = Array.from(container.querySelectorAll('[data-annotation="field"]'));
      expect(overlays).toHaveLength(2);
      expect(overlays[0]).toHaveAttribute('data-signer-active', 'false');
      expect(overlays[1]).toHaveAttribute('data-signer-active', 'true');
    });
  });

  it("keeps duplicate signer labels mapped to separate fields when a template is loaded", async () => {
    const user = userEvent.setup();

    mockGetSigningTemplate.mockResolvedValue({
      template: {
        templateId: "template-1",
        name: "Duplicate signer template",
        routingMode: "sequential",
        signerRoles: [
          { roleLabel: "Signer", order: 1, deliveryMethod: "email" },
          { roleLabel: "Signer", order: 2, deliveryMethod: "email" },
        ],
        fields: [
          { id: "field-1", page: 1, xPercent: 10, yPercent: 10, widthPercent: 20, heightPercent: 6, signerId: "role:1" },
          { id: "field-2", page: 1, xPercent: 40, yPercent: 10, widthPercent: 20, heightPercent: 6, signerId: "role:2" },
        ],
      },
    });

    renderPlacer({ templateId: "template-1" });

    // Both hydrated signers default to Email delivery; give them emails so the
    // field-placement step can be reached.
    await waitFor(() => {
      expect(screen.getAllByPlaceholderText("signer@example.com")).toHaveLength(2);
    });
    const emailInputs = screen.getAllByPlaceholderText("signer@example.com");
    await user.type(emailInputs[0], "a@example.com");
    await user.type(emailInputs[1], "b@example.com");
    await user.click(screen.getByRole("button", { name: /continue to place fields/i }));

    // Each of the two same-labelled signers keeps its own single field.
    expect(await screen.findAllByText("1 field")).toHaveLength(2);
    expect(screen.getByText("2 fields placed")).toBeInTheDocument();
  });

  it("returns to the signing page when done is clicked after sending", async () => {
    const user = userEvent.setup();
    const onBack = jest.fn();

    mockSendSigningRequest.mockResolvedValue({
      copyLinks: [
        {
          participantId: "participant-1",
          name: "Client",
          link: "https://example.com/sign/client",
        },
      ],
    });

    renderPlacer({ onBack });

    await goToFields(user);
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.click(screen.getByRole("button", { name: /^continue$/i }));
    await user.click(screen.getByRole("button", { name: /send for signing/i }));
    await user.click(await screen.findByRole("button", { name: /^done$/i }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  // Done leaves the placer, and the parent's navigation takes a moment. Until it
  // lands the Review & Send dialog must keep showing the links it produced, not
  // fall back to the send form with a live Send button for a request already sent.
  it("keeps the signing links on screen after Done while the placer is being left", async () => {
    const user = userEvent.setup();
    const onBack = jest.fn();

    mockSendSigningRequest.mockResolvedValue({
      copyLinks: [
        {
          participantId: "participant-1",
          name: "Client",
          link: "https://example.com/sign/client",
        },
      ],
    });

    renderPlacer({ onBack });

    await goToFields(user);
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.click(screen.getByRole("button", { name: /^continue$/i }));
    await user.click(screen.getByRole("button", { name: /send for signing/i }));
    await user.click(await screen.findByRole("button", { name: /^done$/i }));

    expect(onBack).toHaveBeenCalledTimes(1);
    const review = screen.getByRole("dialog", { name: /review & send/i });
    expect(within(review).getByText("Signing links ready")).toBeInTheDocument();
    expect(within(review).getByRole("button", { name: /^done$/i })).toBeInTheDocument();
    expect(within(review).queryByRole("button", { name: /send for signing/i })).not.toBeInTheDocument();
  });

  it("keeps the saved template's name and the Saving label while Save as Template animates out", async () => {
    const user = userEvent.setup();
    let finishSave!: () => void;
    mockCreateSigningTemplate.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishSave = resolve; }),
    );

    renderPlacer();

    await goToFields(user);
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.click(screen.getByRole("button", { name: "Save Template" }));

    const dialog = await screen.findByRole("dialog", { name: /save as template/i });
    await user.type(within(dialog).getByPlaceholderText("Client engagement letter"), "Engagement letter");
    await user.type(within(dialog).getByPlaceholderText("Notes for this template"), "Two signers");
    await user.click(within(dialog).getByRole("button", { name: "Save Template" }));

    expect(within(dialog).getByRole("button", { name: "Saving..." })).toBeDisabled();

    await React.act(async () => {
      finishSave();
    });

    await waitFor(() => expect(dialog).toHaveClass("overlay-card-exit"));
    expect(within(dialog).getByPlaceholderText("Client engagement letter")).toHaveValue("Engagement letter");
    expect(within(dialog).getByPlaceholderText("Notes for this template")).toHaveValue("Two signers");
    expect(within(dialog).getByRole("button", { name: "Saving..." })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Save Template" })).not.toBeInTheDocument();
  });

  it("carries a dragged field onto the next page mid-drag, not at release", async () => {
    const user = userEvent.setup();
    const { container } = renderPlacer();

    await goToFields(user);
    await user.click(screen.getByRole("button", { name: "Add field" }));

    const overlay = container.querySelector('[data-signer-active="true"]')! as HTMLElement;

    // Press on the field, then move the pointer into page 2's box WITHOUT
    // releasing. The field must already be on page 2 while the button is held —
    // that is the difference between following the cursor and snapping on drop.
    await user.pointer([
      { keys: "[MouseLeft>]", target: overlay, coords: { x: 400, y: 500 } },
      { coords: { x: 400, y: 1500 } },
    ]);

    expect(within(screen.getByTestId("page-2")).queryAllByText(/signature/i).length).toBeGreaterThan(0);
    expect(within(screen.getByTestId("page-1")).queryAllByText(/signature/i)).toHaveLength(0);

    await user.pointer(["[/MouseLeft]"]);
    expect(screen.getByText("1 field placed")).toBeInTheDocument();
  });

  it("toggles the access code input and removes it on demand", async () => {
    const user = userEvent.setup();
    renderPlacer();

    const addBtn = await screen.findByRole("button", { name: /add access code/i });
    expect(addBtn).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("e.g. 6-digit code or phrase")).not.toBeInTheDocument();

    await user.click(addBtn);
    const input = screen.getByPlaceholderText("e.g. 6-digit code or phrase");
    expect(input).toBeInTheDocument();

    await user.type(input, "12345");
    expect(screen.getByText(/access code must be at least 6 characters/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /remove/i }));
    expect(screen.queryByPlaceholderText("e.g. 6-digit code or phrase")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add access code/i })).toBeInTheDocument();
  });

  it("blocks progressing when an access code is shorter than 6 characters", async () => {
    const user = userEvent.setup();
    renderPlacer();

    await user.type(await screen.findByPlaceholderText("signer@example.com"), "client@example.com");
    await user.click(await screen.findByRole("button", { name: /add access code/i }));
    const input = screen.getByPlaceholderText("e.g. 6-digit code or phrase");
    await user.type(input, "short");

    const continueBtn = screen.getByRole("button", { name: /continue to place fields/i });
    expect(continueBtn).toBeDisabled();
    expect(screen.getByText(/access code must be at least 6 characters/i)).toBeInTheDocument();

    await user.type(input, "code");
    expect(continueBtn).toBeEnabled();
  });

  it("includes access code in send payload for email delivery", async () => {
    const user = userEvent.setup();
    renderPlacer();

    await user.type(await screen.findByPlaceholderText("signer@example.com"), "client@example.com");
    await user.click(screen.getByRole("button", { name: /add access code/i }));
    await user.type(screen.getByPlaceholderText("e.g. 6-digit code or phrase"), "secureCode123");

    await user.click(screen.getByRole("button", { name: /continue to place fields/i }));
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.click(screen.getByRole("button", { name: /^continue$/i }));
    await user.click(screen.getByRole("button", { name: /send for signing/i }));

    await waitFor(() => expect(mockSendSigningRequest).toHaveBeenCalled());
    const [, payload] = mockSendSigningRequest.mock.calls[0];
    expect(payload.signers[0]).toMatchObject({
      deliveryMethod: "email",
      email: "client@example.com",
      accessCode: "secureCode123",
    });
  });

  it("supports access code for copy signing link delivery", async () => {
    const user = userEvent.setup();
    renderPlacer();

    await user.click(await screen.findByRole("button", { name: /send via email/i }));
    await user.click(await screen.findByRole("option", { name: "Copy Signing Link" }));
    await user.type(await screen.findByPlaceholderText("Full name"), "Alice Signer");
    await user.click(screen.getByRole("button", { name: /add access code/i }));
    await user.type(screen.getByPlaceholderText("e.g. 6-digit code or phrase"), "linkCode999");

    await user.click(screen.getByRole("button", { name: /continue to place fields/i }));
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(screen.queryByRole("button", { name: /send for signing/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /generate signing link/i }));

    await waitFor(() => expect(mockSendSigningRequest).toHaveBeenCalled());
    const [, payload] = mockSendSigningRequest.mock.calls[0];
    expect(payload.signers[0]).toMatchObject({
      deliveryMethod: "copy_link",
      name: "Alice Signer",
      accessCode: "linkCode999",
    });
  });

  // Red if: Review & Send stays dismissible while the request is being sent,
  // so Escape drops back to the editor mid-send and a refused send reports
  // its error into a closed dialog.
  it("keeps Review & Send open while the signing request is in flight", async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    mockSendSigningRequest.mockReturnValueOnce(pending.promise);

    renderPlacer();

    await goToFields(user);
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.click(screen.getByRole("button", { name: /^continue$/i }));
    const review = await screen.findByRole("dialog", { name: /review & send/i });
    await user.click(within(review).getByRole("button", { name: /send for signing/i }));
    await waitFor(() => expect(mockSendSigningRequest).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(review).not.toHaveClass("overlay-card-exit");

    await React.act(async () => {
      pending.reject(new Error("Signer email bounced"));
    });
    expect(await within(review).findByText("Signer email bounced")).toBeInTheDocument();
    expect(review).not.toHaveClass("overlay-card-exit");
  });

  // Red if: the Signers "Edit" link stays live during the send, so a click
  // leaves Review & Send for the signers step mid-send, the same exit Escape
  // is blocked from taking.
  it("disables the Signers Edit link while the signing request is in flight", async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    mockSendSigningRequest.mockReturnValueOnce(pending.promise);

    renderPlacer();

    await goToFields(user);
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.click(screen.getByRole("button", { name: /^continue$/i }));
    const review = await screen.findByRole("dialog", { name: /review & send/i });
    await user.click(within(review).getByRole("button", { name: /send for signing/i }));
    await waitFor(() => expect(mockSendSigningRequest).toHaveBeenCalledTimes(1));

    const edit = within(review).getByRole("button", { name: /^edit$/i });
    expect(edit).toBeDisabled();
    await user.click(edit);
    expect(review).not.toHaveClass("overlay-card-exit");

    await React.act(async () => {
      pending.reject(new Error("Signer email bounced"));
    });
    expect(await within(review).findByText("Signer email bounced")).toBeInTheDocument();
    expect(within(review).getByRole("button", { name: /^edit$/i })).toBeEnabled();
  });

  // Red if: Save as Template stays dismissible while the template is being
  // saved, so Escape closes it and a refused save reports into a closed dialog.
  it("keeps Save as Template open while the save is in flight", async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    mockCreateSigningTemplate.mockReturnValueOnce(pending.promise);

    renderPlacer();

    await goToFields(user);
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.click(screen.getByRole("button", { name: "Save Template" }));
    const dialog = await screen.findByRole("dialog", { name: /save as template/i });
    await user.type(within(dialog).getByPlaceholderText("Client engagement letter"), "Engagement letter");
    await user.click(within(dialog).getByRole("button", { name: "Save Template" }));
    await waitFor(() => expect(mockCreateSigningTemplate).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog).not.toHaveClass("overlay-card-exit");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();

    await React.act(async () => {
      pending.resolve({});
    });
    await waitFor(() => expect(dialog).toHaveClass("overlay-card-exit"));
  });
});
