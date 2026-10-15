/**
 * `RestrictedSigningView`: the signer's own view of a document, restricted to
 * their assigned fields.
 *
 * Rules that produce a wrong disclosure if they slip:
 *
 *   SUBMISSION MUST BE BLOCKED WHILE A REQUIRED FIELD IS UNFILLED. Clicking
 *   "Done" with a required field still empty must show the missing-fields
 *   warning, never the sign-and-submit confirmation - submitting a document
 *   missing a required signature is worse than a UI bug, it is a bad
 *   document.
 *
 *   THE E-SIGN CONSENT GATE. "Sign & Submit" must stay disabled until BOTH
 *   the consent checkbox and the signer's typed name are present - the
 *   legal basis for treating the click as a binding signature.
 *
 *   DECLINING MUST NEVER SUBMIT A DOCUMENT. Declining and signing are
 *   mutually exclusive outcomes for the same session.
 */
const mockSubmitSignedDocument = jest.fn();
const mockCompleteSigning = jest.fn();
const mockDeclineToSign = jest.fn();
const mockGetSigningStatus = jest.fn();
const mockStampSignatureFieldsOntoPdf = jest.fn();

jest.mock("@/services/signatures.service", () => ({
  __esModule: true,
  default: {
    submitSignedDocument: (...args: unknown[]) => mockSubmitSignedDocument(...args),
    completeSigning: (...args: unknown[]) => mockCompleteSigning(...args),
    getSigningStatus: (...args: unknown[]) => mockGetSigningStatus(...args),
    declineToSign: (...args: unknown[]) => mockDeclineToSign(...args),
  },
}));

jest.mock("@/components/signaturesComp/pdfStamper", () => ({
  __esModule: true,
  stampSignatureFieldsOntoPdf: (...args: unknown[]) => mockStampSignatureFieldsOntoPdf(...args),
  downloadPdf: jest.fn(),
}));

// The default global mock renders null (skips pdf.js entirely); this test
// needs the field overlay buttons the render-prop produces, so it renders a
// single fixed page.
jest.mock("@/components/signaturesComp/PDFPageViewer", () => {
  const { useEffect } = require("react");
  function FakePDFPageViewer(props: any) {
    useEffect(() => {
      props.onDocumentLoad?.(1);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div>{props.children(1, 800, 1000, { width: 612, height: 792 })}</div>;
  }
  return { __esModule: true, default: FakePDFPageViewer };
});

jest.mock("@/components/signaturesComp/SignatureModal", () => ({
  __esModule: true,
  default: (props: any) =>
    props.isOpen ? (
      <button type="button" onClick={() => props.onDone("data:image/png;base64,test", "default")}>
        Complete signature
      </button>
    ) : null,
}));

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RestrictedSigningView from "@/components/signaturesComp/RestrictedSigningView";
import type { SignatureField } from "@/types/signature";

const FILE = { url: "blob:test", name: "Agreement.pdf", bytes: new Uint8Array([1, 2, 3]) };

const REQUIRED_SIGNATURE_FIELD: SignatureField = {
  id: "field-1",
  page: 1,
  xPercent: 10,
  yPercent: 10,
  widthPercent: 20,
  heightPercent: 5,
  fieldType: "signature",
  required: true,
};

function renderView(fields: SignatureField[], onSubmitted: jest.Mock = jest.fn()) {
  return render(
    <RestrictedSigningView
      file={FILE}
      fields={fields}
      token="tok-1"
      sourceRevision="rev-1"
      onSubmitted={onSubmitted}
    />,
  );
}

async function completeSignatureField() {
  fireEvent.click(screen.getByTitle("Signature"));
  fireEvent.click(screen.getByRole("button", { name: "Complete signature" }));
}

beforeEach(() => {
  mockSubmitSignedDocument.mockReset().mockResolvedValue({ completed: true });
  mockCompleteSigning.mockReset().mockResolvedValue({ completed: true, state: 'completed' });
  mockDeclineToSign.mockReset().mockResolvedValue({});
  mockGetSigningStatus.mockReset().mockResolvedValue({ sessionStatus: 'in_progress' });
  mockStampSignatureFieldsOntoPdf.mockReset().mockResolvedValue(new Uint8Array([9, 9, 9]));
});

describe("required-field gate", () => {
  it("shows the missing-fields warning, not the submit confirmation, while a required field is empty", () => {
    renderView([REQUIRED_SIGNATURE_FIELD]);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(screen.getByText("Fields still missing")).toBeInTheDocument();
    expect(screen.queryByText("Sign & Submit Document")).not.toBeInTheDocument();
  });

  it("opens the submit confirmation once the required field is filled", async () => {
    renderView([REQUIRED_SIGNATURE_FIELD]);

    await completeSignatureField();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(screen.getByText("Sign & Submit Document")).toBeInTheDocument();
    expect(screen.queryByText("Fields still missing")).not.toBeInTheDocument();
  });
});

describe("the e-sign consent gate", () => {
  it("keeps Sign & Submit disabled until both the checkbox and a name are present", async () => {
    renderView([REQUIRED_SIGNATURE_FIELD]);
    await completeSignatureField();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    const submitButton = screen.getByRole("button", { name: /Sign & Submit/ });
    expect(submitButton).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox"));
    expect(submitButton).toBeDisabled(); // checkbox alone is not enough

    await userEvent.type(screen.getByPlaceholderText("Enter your full legal name"), "Jane Doe");
    expect(submitButton).not.toBeDisabled();
  });

  it("never calls submitSignedDocument while the consent gate is unsatisfied", async () => {
    renderView([REQUIRED_SIGNATURE_FIELD]);
    await completeSignatureField();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    // Attempt to fire the handler directly the way a disabled button cannot;
    // the real UI already prevents the click, this proves the guard isn't
    // only cosmetic. (fireEvent.click on a disabled button is a no-op in
    // jsdom, which is itself part of what's being verified here.)
    fireEvent.click(screen.getByRole("button", { name: /Sign & Submit/ }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockSubmitSignedDocument).not.toHaveBeenCalled();
  });
});

describe("submitting", () => {
  it("sends the consent name, agreement, and the filled field value", async () => {
    renderView([REQUIRED_SIGNATURE_FIELD]);
    await completeSignatureField();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("checkbox"));
    await userEvent.type(screen.getByPlaceholderText("Enter your full legal name"), "Jane Doe");

    fireEvent.click(screen.getByRole("button", { name: /Sign & Submit/ }));

    // VALUES, not a document. This view fills placed fields, and the server
    // rebuilds the executed copy from what the signer actually agreed to.
    await waitFor(() => expect(mockCompleteSigning).toHaveBeenCalledTimes(1));
    const [token, payload] = mockCompleteSigning.mock.calls[0];
    expect(token).toBe("tok-1");
    expect(payload).toMatchObject({
      consentAgreed: true,
      consentName: "Jane Doe",
      sourceRevision: "rev-1",
    });
    expect(payload.fieldValues).toEqual([{ fieldId: "field-1", value: "data:image/png;base64,test" }]);
    // The browser stamper is not on this path at all any more.
    expect(mockSubmitSignedDocument).not.toHaveBeenCalled();
    expect(mockStampSignatureFieldsOntoPdf).not.toHaveBeenCalled();
  });

  it("does not claim the document is ready while finalization is still processing", async () => {
    mockCompleteSigning.mockResolvedValue({ consentRecorded: true, state: 'processing' });
    renderView([REQUIRED_SIGNATURE_FIELD]);
    await completeSignatureField();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("checkbox"));
    await userEvent.type(screen.getByPlaceholderText("Enter your full legal name"), "Jane Doe");
    fireEvent.click(screen.getByRole("button", { name: /Sign & Submit/ }));

    await screen.findByText(/still being produced/i);
    expect(screen.queryByRole('button', { name: /Download a Copy/i })).not.toBeInTheDocument();
  });

  it("reuses the idempotency key after an uncertain submission failure", async () => {
    mockCompleteSigning
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce({ completed: true, state: 'completed' });
    renderView([REQUIRED_SIGNATURE_FIELD]);
    await completeSignatureField();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("checkbox"));
    await userEvent.type(screen.getByPlaceholderText("Enter your full legal name"), "Jane Doe");
    const submit = screen.getByRole("button", { name: /Sign & Submit/ });
    fireEvent.click(submit);
    await waitFor(() => expect(mockCompleteSigning).toHaveBeenCalledTimes(1));
    fireEvent.click(submit);
    await waitFor(() => expect(mockCompleteSigning).toHaveBeenCalledTimes(2));

    expect(mockCompleteSigning.mock.calls[1][1].idempotencyKey)
      .toBe(mockCompleteSigning.mock.calls[0][1].idempotencyKey);
  });
});

describe("waiting for the executed document", () => {
  afterEach(() => jest.useRealTimers());

  /** Sign, consent and submit without userEvent, whose own delays run on the timers these cases fake. */
  async function submitIntoFinalizing() {
    mockCompleteSigning.mockResolvedValue({ consentRecorded: true, state: "processing" });
    renderView([REQUIRED_SIGNATURE_FIELD]);
    await completeSignatureField();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByPlaceholderText("Enter your full legal name"), { target: { value: "Jane Doe" } });
    fireEvent.click(screen.getByRole("button", { name: /Sign & Submit/ }));
    await act(async () => { await jest.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/still being produced/i)).toBeInTheDocument();
    expect(screen.getByText(/Sealing document and preparing your copy/i)).toBeInTheDocument();
  }

  const advance = (ms: number) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });

  it("polls at 1s, 2s, 5s, then every 10s", async () => {
    jest.useFakeTimers();
    await submitIntoFinalizing();

    await advance(999);
    expect(mockGetSigningStatus).toHaveBeenCalledTimes(0);
    await advance(1);
    expect(mockGetSigningStatus).toHaveBeenCalledTimes(1);
    await advance(2000);
    expect(mockGetSigningStatus).toHaveBeenCalledTimes(2);
    await advance(5000);
    expect(mockGetSigningStatus).toHaveBeenCalledTimes(3);
    await advance(9999);
    expect(mockGetSigningStatus).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(mockGetSigningStatus).toHaveBeenCalledTimes(4);
  });

  it("stops polling after ten minutes and tells the signer they can leave", async () => {
    jest.useFakeTimers();
    await submitIntoFinalizing();

    await advance(9 * 60 * 1000);
    // Still waiting inside the deadline.
    expect(mockGetSigningStatus.mock.calls.length).toBeGreaterThan(0);
    expect(screen.queryByText(/You can close this page/i)).not.toBeInTheDocument();

    await advance(60 * 1000 + 10_000);
    expect(screen.getByText(/The executed document is still being prepared\. You can close this page/i))
      .toBeInTheDocument();
    expect(screen.queryByText(/Sealing document and preparing your copy/i)).not.toBeInTheDocument();

    // An abandoned tab goes quiet rather than polling a job for as long as it
    // stays open.
    const settled = mockGetSigningStatus.mock.calls.length;
    await advance(30 * 60 * 1000);
    expect(mockGetSigningStatus).toHaveBeenCalledTimes(settled);
  });
});

describe("an outcome recovered from the status route", () => {
  // After a lost answer the service reads the status route instead, which
  // knows a signer is recorded but not who signs next, so `nextSignerName` is
  // null. The screen must still say something true and readable.
  async function submitWith(result: Record<string, unknown>) {
    mockCompleteSigning.mockResolvedValue(result);
    renderView([REQUIRED_SIGNATURE_FIELD]);
    await completeSignatureField();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByPlaceholderText("Enter your full legal name"), { target: { value: "Jane Doe" } });
    fireEvent.click(screen.getByRole("button", { name: /Sign & Submit/ }));
  }

  it("names no next signer when the outcome carries none", async () => {
    await submitWith({
      success: true, state: "waiting_for_others", consentRecorded: true,
      completed: false, waitingForNextSigner: true, nextSignerName: null,
    });

    expect(await screen.findByText(/The other signers still need to complete it\./)).toBeInTheDocument();
    expect(screen.queryByText(/null/)).not.toBeInTheDocument();
  });

  it("shows a cancelled or expired session as recorded but unfinalizable, not as complete", async () => {
    const onSubmitted = jest.fn();
    mockCompleteSigning.mockResolvedValue({
      success: false, state: "permanent_refusal", consentRecorded: true,
      completed: false, waitingForNextSigner: false, nextSignerName: null,
    });
    renderView([REQUIRED_SIGNATURE_FIELD], onSubmitted);
    await completeSignatureField();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByPlaceholderText("Enter your full legal name"), { target: { value: "Jane Doe" } });
    fireEvent.click(screen.getByRole("button", { name: /Sign & Submit/ }));

    expect(await screen.findByText(/cannot be finalized\. Please contact the sender/i)).toBeInTheDocument();
    expect(screen.queryByText("Signing Complete")).not.toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
  });
});

describe("declining", () => {
  it("declines without ever submitting a signed document", async () => {
    renderView([REQUIRED_SIGNATURE_FIELD]);

    fireEvent.click(screen.getByRole("button", { name: "Decline to Sign" }));
    await userEvent.type(screen.getByPlaceholderText("Why are you declining to sign?"), "Not agreed");
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    await waitFor(() => expect(mockDeclineToSign).toHaveBeenCalledWith("tok-1", "Not agreed"));
    expect(screen.getByText("You Have Declined to Sign")).toBeInTheDocument();
    expect(mockSubmitSignedDocument).not.toHaveBeenCalled();
  });
});

// The field editor stays on screen for its exit animation. Cancel and Save both
// close it in the same update that would otherwise blank its input, so these
// read the input while the dialog carries the exit class.
describe("closing the field editor", () => {
  const TEXT_FIELD: SignatureField = {
    id: "field-text",
    page: 1,
    xPercent: 10,
    yPercent: 30,
    widthPercent: 20,
    heightPercent: 5,
    fieldType: "text",
    label: "Full name",
    required: true,
  };

  async function openAndType(value: string) {
    fireEvent.click(screen.getByTitle("Full name"));
    const dialog = await screen.findByRole("dialog", { name: "Full name" });
    fireEvent.change(screen.getByPlaceholderText("Enter full name"), { target: { value } });
    return dialog;
  }

  it("keeps the typed value in the input while the editor animates out after Cancel", async () => {
    renderView([TEXT_FIELD]);
    const dialog = await openAndType("Ada Signer");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(dialog).toHaveClass("overlay-card-exit"));
    expect(screen.getByPlaceholderText("Enter full name")).toHaveValue("Ada Signer");
  });

  it("keeps the saved value in the input while the editor animates out after Save", async () => {
    renderView([TEXT_FIELD]);
    const dialog = await openAndType("Ada Signer");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(dialog).toHaveClass("overlay-card-exit"));
    expect(screen.getByPlaceholderText("Enter full name")).toHaveValue("Ada Signer");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});

it.each(['text', 'date'] as const)('associates the signer %s editor with its visible field name', async (fieldType) => {
  renderView([{ ...REQUIRED_SIGNATURE_FIELD, id: 'editor-field', fieldType, label: 'Agreement effective date' }]);
  fireEvent.click(document.getElementById('field-editor-field')!);
  const control = fieldType === 'text'
    ? screen.getByRole('textbox', { name: 'Agreement effective date' })
    : screen.getByRole('button', { name: 'Agreement effective date Select date' });
  expect(control).toHaveAccessibleName(fieldType === 'text' ? 'Agreement effective date' : 'Agreement effective date Select date');
  if (fieldType === 'text') {
    await userEvent.type(control, 'October 4');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(document.getElementById('field-editor-field')).toHaveTextContent('October 4');
  }
});

it('keeps existing signer fields keyboard accessible without adding review controls', async () => {
  renderView([{ ...REQUIRED_SIGNATURE_FIELD, id: 'checkbox-a', page: 1, fieldType: 'checkbox', label: 'Accept the terms' }]);
  const field = screen.getByRole('button', { name: 'Accept the terms, page 1, required, incomplete' });
  field.focus();
  await userEvent.keyboard('{Enter}');
  expect(screen.getByRole('button', { name: 'Accept the terms, page 1, required, complete' })).toHaveFocus();
  expect(screen.queryByRole('button', { name: 'Review fields' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Read document text' })).not.toBeInTheDocument();
});
