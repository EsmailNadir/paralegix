/**
 * DeadlineSetEditorModal: the deadline-set recipe form.
 *
 * WHAT BREAKS THIS:
 * - rendering a cleared days field as 0, so the form shows a valid-looking
 *   number and then refuses to save it;
 * - keying deadline rows by index, so removing a middle row hands the rows
 *   below it the DOM (focus, open dropdowns, caret) of the row above;
 * - seeding the form in an effect, which commits one frame holding the last
 *   session's values every time the dialog opens.
 */
import React from "react";
import { fireEvent, screen } from "@testing-library/react";

import { renderWithProviders } from "../../support/renderWithProviders";
import DeadlineSetEditorModal from "@/components/deadlineSetsComp/DeadlineSetEditorModal";
import type { DeadlineSet } from "@/types/deadlineSet";

function setOf(id: string, name: string): DeadlineSet {
  return {
    id,
    name,
    description: null,
    adjustForWeekends: false,
    items: [{ title: `${name} item`, type: "filing_deadline", offsetDays: 10, offsetDirection: "after", relativeTo: "trigger" }],
  } as unknown as DeadlineSet;
}

let onSave: jest.Mock;
let onClose: jest.Mock;

beforeEach(() => {
  onSave = jest.fn().mockResolvedValue(undefined);
  onClose = jest.fn();
});

function props(overrides: Partial<React.ComponentProps<typeof DeadlineSetEditorModal>> = {}) {
  return { open: true, editing: null, saving: false, onClose, onSave, ...overrides };
}

describe("the days field", () => {
  it("stays empty once cleared and the save names the row that needs a number", async () => {
    renderWithProviders(<DeadlineSetEditorModal {...props()} />);
    fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Civil" } });
    fireEvent.change(screen.getByPlaceholderText("Deadline title, e.g. Answer due"), { target: { value: "Answer due" } });

    const days = screen.getByRole("spinbutton");
    fireEvent.change(days, { target: { value: "" } });

    // Showing 0 here would tell the user the row is valid when it is not.
    expect(days).toHaveValue(null);

    fireEvent.click(screen.getByRole("button", { name: "Create deadline set" }));
    expect(await screen.findByRole("alert")).toHaveTextContent('"Answer due" needs a valid number of days');
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("removing a deadline row", () => {
  it("keeps each remaining row on its own inputs", () => {
    renderWithProviders(<DeadlineSetEditorModal {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add deadline" }));
    fireEvent.click(screen.getByRole("button", { name: "Add deadline" }));
    const titles = screen.getAllByPlaceholderText("Deadline title, e.g. Answer due");
    ["One", "Two", "Three"].forEach((title, i) => fireEvent.change(titles[i], { target: { value: title } }));
    const third = screen.getByDisplayValue("Three");

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]);

    expect(screen.queryByDisplayValue("Two")).not.toBeInTheDocument();
    // The "Three" row must still own its input. With index keys React drops the
    // last row's DOM and repaints the middle one with Three's values.
    expect(third).toBeInTheDocument();
    expect(third).toHaveValue("Three");
  });
});

describe("opening the dialog", () => {
  /** Reads the Name field at every commit, after React has written the DOM. */
  function CommitProbe({ log, children }: { log: string[]; children: React.ReactNode }) {
    return (
      <React.Profiler
        id="editor"
        onRender={() => {
          const input = document.querySelector<HTMLInputElement>('input[maxlength="200"]');
          if (input) log.push(input.value);
        }}
      >
        {children}
      </React.Profiler>
    );
  }

  it("never commits a frame with the previous session's values when reopened mid-exit", () => {
    const log: string[] = [];
    const { rerender } = renderWithProviders(
      <CommitProbe log={log}><DeadlineSetEditorModal {...props({ editing: setOf("a", "Set Alpha") })} /></CommitProbe>,
    );
    expect(screen.getByLabelText("Name *")).toHaveValue("Set Alpha");

    // Closed, and reopened on another set before the 100ms exit has finished,
    // so the dialog is still on screen when the new session starts.
    rerender(<CommitProbe log={log}><DeadlineSetEditorModal {...props({ open: false, editing: null })} /></CommitProbe>);
    log.length = 0;
    rerender(<CommitProbe log={log}><DeadlineSetEditorModal {...props({ editing: setOf("b", "Set Beta") })} /></CommitProbe>);

    expect(screen.getByLabelText("Name *")).toHaveValue("Set Beta");
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain("Set Alpha");
  });

  it("reseeds without a stale frame when the set being edited is swapped while open", () => {
    const log: string[] = [];
    const { rerender } = renderWithProviders(
      <CommitProbe log={log}><DeadlineSetEditorModal {...props({ editing: setOf("a", "Set Alpha") })} /></CommitProbe>,
    );
    log.length = 0;

    rerender(<CommitProbe log={log}><DeadlineSetEditorModal {...props({ editing: setOf("b", "Set Beta") })} /></CommitProbe>);

    expect(screen.getByLabelText("Name *")).toHaveValue("Set Beta");
    expect(log).not.toContain("Set Alpha");
  });
});
