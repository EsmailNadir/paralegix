/**
 * `EditMatterModal`: the main matter-edit form, saved through a diff-based
 * payload rather than a full snapshot.
 *
 * Rules that produce a wrong record if they slip:
 *
 *   PAYMENT-ONGOING ONLY MEANS SOMETHING ON A TERMINAL STATUS. Moving a matter
 *   off a terminal status must clear a stale "still owing" override, and
 *   saving without touching status must never clear it either.
 *
 *   REMOVING A TEAM MEMBER ALSO DROPS THEIR LEAD STATUS, and the save sends
 *   only the members/leads that actually changed - never re-sending an
 *   unchanged team, and never leaving a removed member as a lead.
 *
 *   A QUEUED NEW CLIENT WITH NO NAME OR A MALFORMED EMAIL MUST BLOCK SAVE
 *   entirely, not just that one row.
 *
 *   REMOVING A MEMBER IS CONFIRMED FIRST, with what is still assigned to them on
 *   this matter, and the chosen successor travels with the removal.
 *
 *   A REFUSED MEMBER OR CLIENT CALL MUST NOT COST THE USER THE REST OF THE SAVE.
 *   The matter's own fields are written regardless, and the modal stays open
 *   saying exactly what was not saved.
 */
const mockUpdateMatter = jest.fn();
const mockAddMembers = jest.fn();
const mockRemoveMembers = jest.fn();
const mockListClients = jest.fn();
const mockUpdatePracticeArea = jest.fn();
const mockPreviewRemoveMembers = jest.fn();
const mockAddClient = jest.fn();
const mockLookupClients = jest.fn();
const mockRemoveClient = jest.fn();
jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: { lookupClients: (...args: unknown[]) => mockLookupClients(...args) },
}));

jest.mock("@/services/matters.service", () => ({
  __esModule: true,
  default: {
    updateMatter: (...args: unknown[]) => mockUpdateMatter(...args),
    addMembers: (...args: unknown[]) => mockAddMembers(...args),
    removeMembers: (...args: unknown[]) => mockRemoveMembers(...args),
    listClients: (...args: unknown[]) => mockListClients(...args),
    updatePracticeArea: (...args: unknown[]) => mockUpdatePracticeArea(...args),
    previewRemoveMembers: (...args: unknown[]) => mockPreviewRemoveMembers(...args),
    addClient: (...args: unknown[]) => mockAddClient(...args),
    removeClient: (...args: unknown[]) => mockRemoveClient(...args),
    listCategories: jest.fn().mockResolvedValue([]),
  },
}));

import React from "react";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import EditMatterModal from "@/components/matterComp/EditMatterModal";
import { renderWithProviders } from "../../support/renderWithProviders";
import { grantPermissions, resetPermissions } from "../../support/permissions";
import type { Matter, User } from "@/types";

const USERS: User[] = [
  { uid: "test-uid", name: "Test User", email: "testuser@example.com" } as User,
  { uid: "user-2", name: "Bob Member", email: "bob@example.test" } as User,
];

function matter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: "matter-1",
    name: "Estate Plan",
    matterNumber: "2026-001",
    description: "",
    status: "closed",
    paymentOngoingManual: true,
    billingMethod: "hourly",
    isBillable: true,
    budgetIncludesExpenses: true,
    leadUserIds: ["test-uid", "user-2"],
    members: [{ userId: "test-uid" }, { userId: "user-2" }],
    ...overrides,
  } as Matter;
}

function openTeamStep() {
  fireEvent.click(screen.getByRole("button", { name: /^Team,/ }));
}

function memberCard(name: string) {
  const el = screen.getByText(name).closest(".group");
  if (!el) throw new Error(`member card for ${name} not found`);
  return within(el as HTMLElement);
}

/** The Remove button of the confirm that opens once the member preview is back. */
async function confirmRemoval() {
  const dialog = await screen.findByRole("dialog", { name: /Remove Users? from Matter/ });
  return within(dialog).getByRole("button", { name: "Remove" });
}

async function renderModal(matterItem: Matter, onClose = jest.fn()) {
  renderWithProviders(
    <EditMatterModal open onClose={onClose} lawFirmId="firm-1" users={USERS} matterItem={matterItem} />,
  );
  await waitFor(() => expect(mockListClients).toHaveBeenCalled());
}

beforeEach(() => {
  mockUpdateMatter.mockReset().mockResolvedValue({ message: "ok" });
  mockAddMembers.mockReset().mockResolvedValue({});
  mockRemoveMembers.mockReset().mockResolvedValue({});
  mockListClients.mockReset().mockResolvedValue([]);
  mockUpdatePracticeArea.mockReset().mockResolvedValue({});
  mockPreviewRemoveMembers.mockReset().mockResolvedValue({ users: [] });
  mockAddClient.mockReset().mockResolvedValue({});
  mockLookupClients.mockReset().mockResolvedValue({ items: [], hasMore: false });
  mockRemoveClient.mockReset().mockResolvedValue({});
});

afterEach(() => {
  resetPermissions();
});

describe("confirming an existing client's removal", () => {
  async function requestRemoval(onClose = jest.fn()) {
    mockListClients.mockResolvedValue([{ id: "client-1", name: "Jane Client" }]);
    await renderModal(matter(), onClose);
    await screen.findByText("Jane Client");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    return screen.findByRole("dialog", { name: "Remove Client" });
  }

  it("keeps the client attached when removal is cancelled", async () => {
    const dialog = await requestRemoval();
    expect(within(dialog).getByText(/Jane Client.*from this matter/)).toBeInTheDocument();
    expect(mockRemoveClient).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove Client" })).not.toBeInTheDocument());
    expect(screen.getByText("Jane Client")).toBeInTheDocument();
    expect(mockRemoveClient).not.toHaveBeenCalled();
  });

  it("removes only the confirmed client from the current matter", async () => {
    const dialog = await requestRemoval();
    expect(mockRemoveClient).not.toHaveBeenCalled();
    mockListClients.mockResolvedValue([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mockRemoveClient).toHaveBeenCalledTimes(1));
    expect(mockRemoveClient).toHaveBeenCalledWith({ lawFirmId: "firm-1", matterId: "matter-1", clientId: "client-1" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove Client" })).not.toBeInTheDocument());
    expect(screen.getByText("No clients associated with this matter.")).toBeInTheDocument();
  });

  it("Escape dismisses only the confirmation, keeping the matter editor open", async () => {
    const onClose = jest.fn();
    const dialog = await requestRemoval(onClose);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove Client" })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(mockRemoveClient).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Edit Matter" })).toBeInTheDocument();
  });

  it("keeps the confirmation open with an error when removal fails, allowing a retry", async () => {
    mockRemoveClient.mockRejectedValueOnce(new Error("Removal refused"));
    const dialog = await requestRemoval();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await within(dialog).findByText("Removal refused")).toBeInTheDocument();
    expect(mockRemoveClient).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Jane Client")).toBeInTheDocument();
    mockListClients.mockResolvedValue([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mockRemoveClient).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove Client" })).not.toBeInTheDocument());
  });
});

describe("the payment-ongoing flag", () => {
  it("clears it when the status moves off a terminal one", async () => {
    await renderModal(matter({ status: "closed", paymentOngoingManual: true }));

    fireEvent.click(screen.getByRole("button", { name: /^Matter Details,/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    fireEvent.click(screen.getByRole("option", { name: "Active" }));

    openTeamStep();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateMatter).toHaveBeenCalledTimes(1));
    const [payload] = mockUpdateMatter.mock.calls[0];
    expect(payload.status).toBe("active");
    expect(payload.paymentOngoing).toBe(false);
  });

  it("preserves it when saving without touching a terminal status", async () => {
    await renderModal(matter({ status: "closed", paymentOngoingManual: true }));

    openTeamStep();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateMatter).toHaveBeenCalledTimes(1));
    const [payload] = mockUpdateMatter.mock.calls[0];
    expect(payload.status).toBe("closed");
    expect(payload.paymentOngoing).toBe(true);
  });
});

describe("team and lead diffing", () => {
  it("removing a lead drops their lead status and sends a scoped removeMembers/leadUserIds diff", async () => {
    await renderModal(matter({ leadUserIds: ["test-uid", "user-2"] }));

    openTeamStep();
    fireEvent.click(memberCard("Bob Member").getByRole("button", { name: "Remove" }));
    expect(screen.queryByText("Bob Member")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    // Removal is confirmed before anything is saved.
    fireEvent.click(await confirmRemoval());

    await waitFor(() => expect(mockUpdateMatter).toHaveBeenCalledTimes(1));
    expect(mockRemoveMembers).toHaveBeenCalledWith(
      expect.objectContaining({ targetUserIds: ["user-2"] }),
    );
    expect(mockAddMembers).toHaveBeenCalledWith(
      expect.objectContaining({ targetUserIds: ["test-uid"] }),
    );
    const [payload] = mockUpdateMatter.mock.calls[0];
    expect(payload.leadUserIds).toEqual(["test-uid"]);
  });

  it("omits leadUserIds and skips every member call when the team is untouched", async () => {
    await renderModal(matter({ leadUserIds: ["test-uid", "user-2"] }));

    openTeamStep();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateMatter).toHaveBeenCalledTimes(1));
    expect(mockAddMembers).not.toHaveBeenCalled();
    expect(mockRemoveMembers).not.toHaveBeenCalled();
    const [payload] = mockUpdateMatter.mock.calls[0];
    expect(payload).not.toHaveProperty("leadUserIds");
  });
});

describe("queued new-client validation", () => {
  it("autocompletes the organization for a queued client", async () => {
    mockLookupClients.mockResolvedValue({ items: [{ id: "org-1", label: "Delgado Freight LLC" }], hasMore: false });
    await renderModal(matter());

    fireEvent.click(screen.getByRole("button", { name: "+ New Client" }));
    fireEvent.change(screen.getByPlaceholderText("Full name"), { target: { value: "Dana Whitfield" } });
    const organization = screen.getByRole("combobox", { name: "Organization" });
    fireEvent.focus(organization);
    fireEvent.change(organization, { target: { value: "delgado" } });
    fireEvent.click(await screen.findByRole("option", { name: "Delgado Freight LLC" }));
    openTeamStep();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockAddClient).toHaveBeenCalledTimes(1));
    expect(mockAddClient.mock.calls[0][0].client.organization).toBe("Delgado Freight LLC");
  });

  it("keeps the existing-client picker visible without an extra open or Done button", async () => {
    await renderModal(matter());

    expect(screen.getByText("Search existing clients by name or email...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Existing Client" })).not.toBeInTheDocument();
  });

  it("blocks save when a queued client has no name", async () => {
    await renderModal(matter());

    fireEvent.click(screen.getByRole("button", { name: "+ New Client" }));
    openTeamStep();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(screen.getByText("Every queued client needs a name, or remove the row")).toBeInTheDocument(),
    );
    expect(mockUpdateMatter).not.toHaveBeenCalled();
  });

  it("blocks save when a queued client's email is malformed", async () => {
    await renderModal(matter());

    fireEvent.click(screen.getByRole("button", { name: "+ New Client" }));
    fireEvent.change(screen.getByPlaceholderText("Full name"), { target: { value: "Jane Client" } });
    fireEvent.change(screen.getByPlaceholderText("email@example.com"), { target: { value: "not-an-email" } });
    openTeamStep();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(screen.getByText("Please enter a valid email address for Jane Client")).toBeInTheDocument(),
    );
    expect(mockUpdateMatter).not.toHaveBeenCalled();
  });
});

describe("confirming a member's removal before it is saved", () => {
  const BOB_BUSY = { users: [{ userId: "user-2", openTasks: 3, upcomingEvents: 1, reminderSlots: 0 }] };

  async function removeBobAndSave(matterItem = matter({ leadUserIds: ["test-uid"] })) {
    await renderModal(matterItem);
    openTeamStep();
    fireEvent.click(memberCard("Bob Member").getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  }

  it("asks the server what is assigned to every removed member, on this matter", async () => {
    mockPreviewRemoveMembers.mockResolvedValue(BOB_BUSY);
    await removeBobAndSave();

    await confirmRemoval();
    expect(mockPreviewRemoveMembers).toHaveBeenCalledWith(
      expect.objectContaining({ lawFirmId: "firm-1", matterId: "matter-1", targetUserIds: ["user-2"] }),
    );
    // Nothing is written until the user has seen the counts.
    expect(mockUpdateMatter).not.toHaveBeenCalled();
    expect(mockRemoveMembers).not.toHaveBeenCalled();
  });

  it("sends the chosen member as reassignTo when work is assigned to the one leaving", async () => {
    mockPreviewRemoveMembers.mockResolvedValue(BOB_BUSY);
    await removeBobAndSave();

    const dialog = await screen.findByRole("dialog", { name: /Remove User from Matter/ });
    expect(within(dialog).getByText(/3 open tasks and 1 upcoming event on this matter are assigned to Bob Member/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Reassign to/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Test User" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(mockRemoveMembers).toHaveBeenCalledTimes(1));
    expect(mockRemoveMembers).toHaveBeenCalledWith(
      expect.objectContaining({ targetUserIds: ["user-2"], reassignTo: "test-uid" }),
    );
  });

  it("offers no picker and sends no reassignTo when nothing is assigned", async () => {
    mockPreviewRemoveMembers.mockResolvedValue({
      users: [{ userId: "user-2", openTasks: 0, upcomingEvents: 0, reminderSlots: 0 }],
    });
    await removeBobAndSave();

    const dialog = await screen.findByRole("dialog", { name: /Remove User from Matter/ });
    expect(within(dialog).queryByRole("button", { name: /^Reassign to/ })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(mockRemoveMembers).toHaveBeenCalledTimes(1));
    expect(mockRemoveMembers.mock.calls[0][0].reassignTo).toBeUndefined();
  });

  it("removes nobody and saves nothing when the preview cannot be read", async () => {
    mockPreviewRemoveMembers.mockRejectedValue(new Error("Preview is unavailable"));
    await removeBobAndSave();

    expect(await screen.findByText("Preview is unavailable")).toBeInTheDocument();
    expect(mockRemoveMembers).not.toHaveBeenCalled();
    expect(mockUpdateMatter).not.toHaveBeenCalled();
  });

  it("saves nothing when the user backs out of the confirm", async () => {
    mockPreviewRemoveMembers.mockResolvedValue(BOB_BUSY);
    await removeBobAndSave();

    const dialog = await screen.findByRole("dialog", { name: /Remove User from Matter/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Remove User from Matter/ })).not.toBeInTheDocument());
    expect(mockRemoveMembers).not.toHaveBeenCalled();
    expect(mockUpdateMatter).not.toHaveBeenCalled();
  });

  it("does not ask when nobody is being removed", async () => {
    await renderModal(matter());

    openTeamStep();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateMatter).toHaveBeenCalledTimes(1));
    expect(mockPreviewRemoveMembers).not.toHaveBeenCalled();
  });
});

describe("a refused member or client call during save", () => {
  function renderWithHandlers(matterItem: Matter) {
    const onClose = jest.fn();
    const onAfter = jest.fn();
    renderWithProviders(
      <EditMatterModal open onClose={onClose} onAfter={onAfter} lawFirmId="firm-1" users={USERS} matterItem={matterItem} />,
    );
    return { onClose, onAfter };
  }

  async function retitle(name: string) {
    await waitFor(() => expect(mockListClients).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /^Matter Details,/ }));
    fireEvent.change(screen.getByPlaceholderText("Enter a title"), { target: { value: name } });
  }

  it("still saves the matter's fields when the team call is refused, and says so", async () => {
    mockAddMembers.mockRejectedValue(new Error("You cannot change this matter's team"));
    const { onClose, onAfter } = renderWithHandlers(matter({ leadUserIds: ["test-uid"] }));

    await retitle("Estate Plan (revised)");
    openTeamStep();
    fireEvent.click(memberCard("Bob Member").getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    fireEvent.click(await confirmRemoval());

    // The title is written even though the team call was refused.
    await waitFor(() => expect(mockUpdateMatter).toHaveBeenCalledTimes(1));
    expect(mockUpdateMatter.mock.calls[0][0].name).toBe("Estate Plan (revised)");
    expect(await screen.findByText(/team changes were not saved/i)).toBeInTheDocument();
    expect(screen.getByText(/You cannot change this matter's team/)).toBeInTheDocument();
    // Open, so the user reads it; refreshed, so the page shows the new title.
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(onAfter).toHaveBeenCalledTimes(1));
  });

  it("does not send a lead set it could not make valid when the team call was refused", async () => {
    mockAddMembers.mockRejectedValue(new Error("Refused"));
    renderWithHandlers(matter({ leadUserIds: ["test-uid", "user-2"] }));

    await retitle("Estate Plan (revised)");
    openTeamStep();
    fireEvent.click(memberCard("Bob Member").getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    fireEvent.click(await confirmRemoval());

    await waitFor(() => expect(mockUpdateMatter).toHaveBeenCalledTimes(1));
    // Leads must be members, and the membership change did not go through.
    expect(mockUpdateMatter.mock.calls[0][0]).not.toHaveProperty("leadUserIds");
  });

  it("names the client that could not be added with the server's reason, and stays open", async () => {
    mockAddClient.mockRejectedValue(new Error("A client with this email already exists"));
    const { onClose, onAfter } = renderWithHandlers(matter());

    await waitFor(() => expect(mockListClients).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "+ New Client" }));
    fireEvent.change(screen.getByPlaceholderText("Full name"), { target: { value: "Jane Client" } });
    openTeamStep();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(await screen.findByText(/Jane Client/)).toBeInTheDocument();
    expect(screen.getByText(/A client with this email already exists/)).toBeInTheDocument();
    expect(mockUpdateMatter).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(onAfter).toHaveBeenCalledTimes(1));
  });

  it("closes as before when everything was saved", async () => {
    const { onClose, onAfter } = renderWithHandlers(matter());

    await waitFor(() => expect(mockListClients).toHaveBeenCalled());
    openTeamStep();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onAfter).toHaveBeenCalledTimes(1);
  });
});

describe("steps a role has no permission to use", () => {
  it("hides the Team step from a role without matters.manageMembers", async () => {
    grantPermissions(["matters.update", "matters.manageClients"]);
    await renderModal(matter());

    expect(screen.queryByLabelText(/^Team,/)).not.toBeInTheDocument();
    // The other steps are still there, so the absence is not a modal that failed to draw.
    expect(screen.getByLabelText(/^Clients,/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Matter Details,/)).toBeInTheDocument();
  });

  it("hides the Clients step from a role without matters.manageClients", async () => {
    grantPermissions(["matters.update", "matters.manageMembers"]);
    await renderModal(matter());

    expect(screen.queryByLabelText(/^Clients,/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Team,/)).toBeInTheDocument();
  });

  it("still saves the matter's fields for a role that can only update the matter", async () => {
    grantPermissions(["matters.update"]);
    await renderModal(matter());

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateMatter).toHaveBeenCalledTimes(1));
    expect(mockAddMembers).not.toHaveBeenCalled();
    expect(mockRemoveMembers).not.toHaveBeenCalled();
  });
});

describe("while the save is in flight", () => {
  it("holds Back and the step indicator shut so the user cannot reach Cancel mid-save", async () => {
    let resolveSave: (value: unknown) => void = () => {};
    mockUpdateMatter.mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }));
    const onClose = jest.fn();
    await renderModal(matter({ status: "active", paymentOngoingManual: false }), onClose);

    openTeamStep();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockUpdateMatter).toHaveBeenCalledTimes(1));

    const back = screen.getByRole("button", { name: "Back" });
    expect(back).toBeDisabled();
    fireEvent.click(back);
    // The completed steps render as buttons once reached; mid-save they are
    // disabled, so clicking the first one leaves the user on the last step.
    const firstStep = screen.getByRole("button", { name: /^Clients,/ });
    expect(firstStep).toBeDisabled();
    fireEvent.click(firstStep);
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Saving/ })).toBeInTheDocument();

    resolveSave({ message: "ok" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Back" })).not.toBeDisabled());
    expect(screen.getByRole("button", { name: /^Clients,/ })).not.toBeDisabled();
  });
});
