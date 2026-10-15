/**
 * The quick note dialog edits the lead's whole `notes` field, prefilled with
 * what is there. It is mounted closed on the lead page, so the notes it prefills
 * must be the lead's notes when it OPENS: saving a stale copy writes the older
 * text back over an edit made elsewhere on the page in the meantime.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import QuickAddLeadNoteModal from "@/components/leadComp/QuickAddLeadNoteModal";
import type { Lead } from "@/types";
import { installApiMock, type ApiMock } from "../../support/apiMock";
import { holdResponse } from "../../support/deferred";

const lead = (notes: string) => ({ id: "lead-1", name: "Jane Roe", notes }) as Lead;

it("prefills the notes the lead has when it opens, not when it mounted", () => {
  const props = { onClose: jest.fn(), lawFirmId: "firm-1" };
  const { rerender } = render(<QuickAddLeadNoteModal {...props} open={false} lead={lead("Called on Monday")} />);

  // The lead is edited (its notes rewritten) while the quick note dialog is closed.
  rerender(<QuickAddLeadNoteModal {...props} open={false} lead={lead("Called Monday. Retainer sent.")} />);
  rerender(<QuickAddLeadNoteModal {...props} open lead={lead("Called Monday. Retainer sent.")} />);

  expect(screen.getByLabelText("Note")).toHaveValue("Called Monday. Retainer sent.");
});

it("drops an unsaved draft when it is cancelled and reopened", () => {
  const props = { onClose: jest.fn(), lawFirmId: "firm-1", lead: lead("Original") };
  const { rerender } = render(<QuickAddLeadNoteModal {...props} open />);
  fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Half-written draft" } });
  rerender(<QuickAddLeadNoteModal {...props} open={false} />);
  rerender(<QuickAddLeadNoteModal {...props} open />);

  expect(screen.getByLabelText("Note")).toHaveValue("Original");
});

describe("Escape while the save is in flight", () => {
  let api: ApiMock;
  beforeEach(() => {
    api = installApiMock();
  });
  afterEach(() => api.restore());

  // Red if: the dialog stays dismissible during the save, so Escape abandons it
  // and a refused save reports its error into a closed dialog.
  it("does not close the dialog until the save settles", async () => {
    const put = holdResponse();
    api.put("/lawfirms/firm-1/leads/lead-1", put.handler);
    const onClose = jest.fn();
    render(<QuickAddLeadNoteModal open onClose={onClose} lawFirmId="firm-1" lead={lead("Original")} />);

    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await put.untilRequested();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    await act(async () => put.release({ message: "ok", lead: lead("Original") }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
