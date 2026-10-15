/**
 * R6 from be459ec0: the last-billing-recipient warning.
 *
 * An organization's invoices go to the linked people flagged "Receives emails".
 * With none left, issuing one fails outright, so both write surfaces have to say
 * so before the change lands. The fix added the warning to OrgAccessModal and the
 * person-side relationship editor; before it, only one of four write surfaces
 * warned.
 *
 * NOTE ON THE MOCK. `tests/setup.ts` replaces every service module with a Proxy
 * whose methods all resolve to `{}`, which would make this component render an
 * empty roster and the warning unreachable. The per-file `jest.mock` below
 * overrides it for this spec only, because a test that cannot observe the
 * condition it asserts is not a test. That override is the pattern the existing
 * specs use, and it is a workaround for the setup file, not a fix: until Phase 6
 * changes the default, every component spec has to opt out like this to be able
 * to fail.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { holdResponse } from "../../support/deferred";

const mockListClientContacts = jest.fn();
const mockUpdateClientContact = jest.fn();

jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: {
    listClientContacts: (...args: unknown[]) => mockListClientContacts(...args),
    updateClientContact: (...args: unknown[]) => mockUpdateClientContact(...args),
  },
}));

import OrgAccessModal from "@/components/billingComp/OrgAccessModal";

const LAW_FIRM_ID = "firm-1";
const ORG_ID = "org-1";

function rosterMember(overrides: Record<string, unknown> = {}) {
  return {
    id: `link-${Math.random().toString(36).slice(2, 8)}`,
    personClientId: `person-${Math.random().toString(36).slice(2, 8)}`,
    name: "Bea Billing",
    email: "bea@acme.test",
    isPrimary: false,
    isEmailRecipient: true,
    canViewBilling: true,
    relationship: "Controller",
    ...overrides,
  };
}

function renderModal() {
  return render(
    <OrgAccessModal
      isOpen
      onClose={jest.fn()}
      lawFirmId={LAW_FIRM_ID}
      clientId={ORG_ID}
      clientName="Acme Corporation"
    />,
  );
}

/**
 * Open the row's edit form, clear "Receives Billing Emails", and save.
 *
 * The edit form exposes three link flags as checkboxes. The email one is found
 * through its label text rather than by index, so reordering the form does not
 * silently make this test toggle a different flag and still pass.
 */
async function openEditor(user: ReturnType<typeof userEvent.setup>, rowIndex = 0) {
  // Every roster row has its own Edit button, so the row is selected by index
  // into the fixture array rather than by a bare name lookup, which throws on
  // more than one match and silently edits the wrong member if it did not.
  const editButtons = await screen.findAllByRole("button", { name: "Edit" });
  await user.click(editButtons[rowIndex]);
}

async function clearEmailRecipientAndSave(user: ReturnType<typeof userEvent.setup>) {
  await openEditor(user);
  const emailToggle = (await screen.findAllByRole("checkbox")).find((box) =>
    (box.closest("label")?.textContent || "").includes("Receives Billing Emails"));
  expect(emailToggle).toBeDefined();
  await user.click(emailToggle as HTMLElement);
  await user.click(screen.getByRole("button", { name: "Save Changes" }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateClientContact.mockResolvedValue({});
});

describe("OrgAccessModal, last billing recipient", () => {
  it("warns before clearing the organization's only email recipient", async () => {
    const user = userEvent.setup();
    mockListClientContacts.mockResolvedValue([
      rosterMember({ name: "Only Recipient", isEmailRecipient: true }),
      // A second member who does NOT receive emails, so the count that matters
      // is the recipient count and not the roster size.
      rosterMember({ name: "Not A Recipient", isEmailRecipient: false }),
    ]);

    renderModal();
    await screen.findByText("Only Recipient");
    await clearEmailRecipientAndSave(user);

    expect(await screen.findByText(/only email recipient/i)).toBeInTheDocument();
    expect(screen.getByText(/nowhere to send/i)).toBeInTheDocument();
    // The warning must come BEFORE the write, or it is a notification rather
    // than a confirmation.
    expect(mockUpdateClientContact).not.toHaveBeenCalled();
  });

  it("does not warn when another email recipient remains", async () => {
    const user = userEvent.setup();
    mockListClientContacts.mockResolvedValue([
      rosterMember({ name: "First Recipient", isEmailRecipient: true }),
      rosterMember({ name: "Second Recipient", isEmailRecipient: true }),
    ]);

    renderModal();
    await screen.findByText("First Recipient");
    await clearEmailRecipientAndSave(user);

    await waitFor(() => expect(mockUpdateClientContact).toHaveBeenCalled());
    expect(screen.queryByText(/only email recipient/i)).not.toBeInTheDocument();
  });

  it("does not warn when the flag is not being cleared", async () => {
    const user = userEvent.setup();
    mockListClientContacts.mockResolvedValue([
      rosterMember({ name: "Only Recipient", isEmailRecipient: true }),
    ]);

    renderModal();
    await screen.findByText("Only Recipient");

    // Open the editor and save without touching the email flag. Warning on any
    // save of the last recipient, rather than on removing it, would train the
    // firm to click through a dialog that usually means nothing.
    await openEditor(user);
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateClientContact).toHaveBeenCalled());
    expect(screen.queryByText(/only email recipient/i)).not.toBeInTheDocument();
  });
});

describe("OrgAccessModal, while a member's access is saving", () => {
  // Red if: the roster dialog stays dismissible during the save (no
  // `dismissible={!saving}`), or the header X or footer Close stays enabled, so
  // the firm can close it mid-save and a later failure renders into a closed
  // dialog.
  it("cannot be closed until the save settles", async () => {
    const user = userEvent.setup();
    const held = holdResponse();
    mockUpdateClientContact.mockImplementation(held.handler);
    mockListClientContacts.mockResolvedValue([
      rosterMember({ name: "First Recipient", isEmailRecipient: true }),
    ]);
    const onClose = jest.fn();
    render(
      <OrgAccessModal
        isOpen
        onClose={onClose}
        lawFirmId={LAW_FIRM_ID}
        clientId={ORG_ID}
        clientName="Acme Corporation"
      />,
    );
    await screen.findByText("First Recipient");
    await openEditor(user);
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await held.untilRequested();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();

    await act(async () => held.release({}));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
