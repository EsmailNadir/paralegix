/**
 * `useDialog`: shared modal accessibility plumbing - focus capture/restore,
 * a Tab focus trap, and Escape-to-close.
 *
 * Losing any of these is invisible on screen (the dialog still looks right)
 * but breaks keyboard and screen-reader use: focus escaping to the page
 * behind the modal, focus never returning to what opened it, or Escape
 * doing nothing.
 */
import React, { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useDialog } from "@/hooks/useDialog";

// jsdom never computes layout, so every element's real `offsetParent` reads
// `null` regardless of visibility - the trap's visibility filter would see
// every non-active element as "hidden" and always trap on a list of one.
// Report every element as visible so the wrap-around logic under test can
// actually see more than one focusable candidate.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return document.body;
    },
  });
});

function Dialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { dialogRef, titleId } = useDialog<HTMLDivElement>({ isOpen, onClose });
  if (!isOpen) return null;
  return (
    <div ref={dialogRef} role="dialog" aria-labelledby={titleId}>
      <h2 id={titleId}>Confirm</h2>
      <button>First</button>
      <button>Last</button>
    </div>
  );
}

function Harness() {
  const [open, setOpen] = React.useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={triggerRef} onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog isOpen={open} onClose={() => setOpen(false)} />
    </div>
  );
}

describe("focus capture and restore", () => {
  it("moves focus into the dialog on open, and restores it to the trigger on close", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open" });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("Escape", () => {
  it("calls onClose", () => {
    const onClose = jest.fn();
    render(<Dialog isOpen onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("the Tab focus trap", () => {
  it("wraps Tab from the last focusable element back to the first", () => {
    render(<Dialog isOpen onClose={jest.fn()} />);
    const last = screen.getByRole("button", { name: "Last" });
    last.focus();

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
  });

  it("wraps Shift+Tab from the first focusable element back to the last", () => {
    render(<Dialog isOpen onClose={jest.fn()} />);
    const first = screen.getByRole("button", { name: "First" });
    first.focus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
  });
});
