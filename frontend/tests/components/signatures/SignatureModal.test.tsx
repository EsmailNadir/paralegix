/**
 * `SignatureModal`: saving a typed signature, and the dialog while it animates
 * closed.
 *
 * A typed signature is drawn in a web font, so Done waits for that font to load
 * before rasterising, and ignores repeated clicks while it waits.
 *
 * Callers close the dialog from `onDone` (and clear the field it was opened for,
 * which changes `fieldType` and `lockedStyle`). The dialog stays on screen for
 * its exit animation, so anything that changes in that same update is a visible
 * flash: the drawn signature wiped, the typed one replaced by the Draw tab, or
 * "Add Initials" becoming "Add Signature". These specs read the dialog while it
 * carries the exit class and fail if any of that content changes.
 *
 * The drawing canvas is a stub whose strokes are visible text, so a call to its
 * imperative `clear()` shows up in the DOM the same way it would on screen.
 */
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

jest.mock("react-signature-canvas", () => {
  const ReactActual = jest.requireActual("react");
  const MockCanvas = ReactActual.forwardRef(function MockSignatureCanvas(
    props: { onBegin?: () => void },
    ref: unknown,
  ) {
    const [strokes, setStrokes] = ReactActual.useState(0);
    ReactActual.useImperativeHandle(
      ref,
      () => ({
        clear: () => setStrokes(0),
        isEmpty: () => strokes === 0,
        getCanvas: () => document.createElement("canvas"),
      }),
      [strokes],
    );
    return ReactActual.createElement(
      "button",
      {
        type: "button",
        onClick: () => {
          setStrokes((count: number) => count + 1);
          props.onBegin?.();
        },
      },
      `Strokes drawn: ${strokes}`,
    );
  });
  MockCanvas.displayName = "MockSignatureCanvas";
  return MockCanvas;
});

import SignatureModal from "@/components/signaturesComp/SignatureModal";
import type { SignatureStyle } from "@/types/signature";

function createCanvasContext(canvas: HTMLCanvasElement) {
  return {
    scale: jest.fn(),
    clearRect: jest.fn(),
    fillText: jest.fn(),
    drawImage: jest.fn(),
    measureText: (text: string) => ({ width: text.length * 24 }),
    getImageData: () => {
      const data = new Uint8ClampedArray(Math.max(1, canvas.width * canvas.height) * 4);
      data[3] = 255;
      return { data, width: canvas.width, height: canvas.height };
    },
    font: "",
    fillStyle: "#000000",
    textBaseline: "middle",
  } as unknown as CanvasRenderingContext2D;
}

interface HarnessProps {
  fieldType?: "signature" | "initials";
  lockedStyle?: SignatureStyle;
}

/**
 * Mirrors `RestrictedSigningView`: one piece of state opens the dialog and
 * decides its field type and locked style, and `onDone` clears it.
 */
function Harness({ fieldType = "signature", lockedStyle }: HarnessProps) {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <SignatureModal
        isOpen={open}
        onClose={() => setOpen(false)}
        onDone={() => setOpen(false)}
        fieldType={open ? fieldType : "signature"}
        lockedStyle={open ? lockedStyle : undefined}
      />
    </>
  );
}

function exitingDialog() {
  return document.querySelector(".overlay-card-exit");
}

let originalFonts: FontFaceSet | undefined;

beforeEach(() => {
  originalFonts = (document as Document & { fonts?: FontFaceSet }).fonts;

  const fontsLink = document.createElement("link");
  fontsLink.id = "signature-google-fonts";
  Object.defineProperty(fontsLink, "sheet", { configurable: true, value: {} });
  document.head.appendChild(fontsLink);

  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function getContext(
    this: HTMLCanvasElement,
  ) {
    return createCanvasContext(this);
  });
  jest.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,test");
});

afterEach(() => {
  jest.restoreAllMocks();
  document.head.querySelector("#signature-google-fonts")?.remove();

  if (originalFonts) {
    Object.defineProperty(document, "fonts", { configurable: true, value: originalFonts });
  } else {
    // `Document.fonts` is non-optional in lib.dom, so it has to be widened to
    // an optional shape before `delete` is legal.
    delete (document as unknown as { fonts?: FontFaceSet }).fonts;
  }
});

describe("saving a typed signature", () => {
  it("waits for the selected font and ignores repeated typed-signature saves", async () => {
    const user = userEvent.setup();
    let resolveFontLoad!: () => void;
    const fontLoadPromise = new Promise<void>((resolve) => {
      resolveFontLoad = resolve;
    });
    const load = jest.fn().mockReturnValue(fontLoadPromise);

    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        load,
        ready: fontLoadPromise,
      },
    });

    const onDone = jest.fn();
    render(<SignatureModal isOpen onClose={jest.fn()} onDone={onDone} />);

    await user.click(screen.getByText("Type"));
    await user.type(screen.getByPlaceholderText("Type your signature..."), "Alex Example");

    const doneButton = screen.getByRole("button", { name: "Done" });
    await user.click(doneButton);

    expect(doneButton).toBeDisabled();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(expect.stringContaining("'Great Vibes'"), "Alex Example");

    await user.click(doneButton);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();

    resolveFontLoad();

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });
});

describe("SignatureModal closing", () => {
  it("keeps the drawn signature on the canvas while the dialog animates out after Done", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Strokes drawn: 0" }));
    await user.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(exitingDialog()).not.toBeNull());
    expect(screen.getByRole("button", { name: "Strokes drawn: 1" })).toBeInTheDocument();
  });

  it("keeps the typed signature and the Type tab while the dialog animates out after Done", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByText("Type"));
    await user.type(screen.getByPlaceholderText("Type your signature..."), "Ada Signer");
    await user.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(exitingDialog()).not.toBeNull());
    expect(screen.getByPlaceholderText("Type your signature...")).toHaveValue("Ada Signer");
    expect(screen.queryByRole("button", { name: /Strokes drawn/ })).not.toBeInTheDocument();
  });

  it("keeps the initials title and hides the layout picker while the caller clears the field on close", async () => {
    const user = userEvent.setup();
    render(<Harness fieldType="initials" lockedStyle="standard" />);

    expect(screen.getByText("Add Initials")).toBeInTheDocument();
    expect(screen.queryByText("Signature layout")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(exitingDialog()).not.toBeNull());
    expect(screen.getByText("Add Initials")).toBeInTheDocument();
    expect(screen.queryByText("Add Signature")).not.toBeInTheDocument();
    expect(screen.queryByText("Signature layout")).not.toBeInTheDocument();
  });

  it("opens again on an empty Draw tab once a typed signature was completed", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByText("Type"));
    await user.type(screen.getByPlaceholderText("Type your signature..."), "Ada Signer");
    await user.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(screen.queryByText("Add Signature")).not.toBeInTheDocument());
    // The reset runs once the exit animation has finished, not on unmount.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    await user.click(screen.getByRole("button", { name: "Reopen" }));

    expect(screen.getByRole("button", { name: "Strokes drawn: 0" })).toBeInTheDocument();
    await user.click(screen.getByText("Type"));
    expect(screen.getByPlaceholderText("Type your signature...")).toHaveValue("");
  });

  it("keeps a typed signature for another try after Cancel", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByText("Type"));
    await user.type(screen.getByPlaceholderText("Type your signature..."), "Ada Signer");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText("Add Signature")).not.toBeInTheDocument());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    await user.click(screen.getByRole("button", { name: "Reopen" }));
    expect(screen.getByPlaceholderText("Type your signature...")).toHaveValue("Ada Signer");
  });
});
