/**
 * `EditMatterModal`'s Clients step and its save, where the rows queued for the
 * matter are written.
 *
 *   AN EXISTING CLIENT PICKED FROM THE SEARCH IS LINKED, NOT RE-CREATED. The
 *   add-client call has to name the picked client's id; without it the server
 *   finds nothing to reuse and inserts a second client row with the same name.
 *
 *   A PAGE REFRESH DURING THE SAVE DOES NOT WIPE WHAT FAILED. The matter page
 *   reloads the matter in `onAfter`, which hands the modal a new `matterItem`
 *   object for the same matter. The clients that could not be added, and the
 *   message naming them, must survive that so the user can retry.
 */
const mockUpdateMatter = jest.fn();
const mockListClients = jest.fn();
const mockAddClient = jest.fn();
jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: { lookupClients: jest.fn().mockResolvedValue({ items: [], hasMore: false }) },
}));

jest.mock("@/services/matters.service", () => ({
  __esModule: true,
  default: {
    updateMatter: (...args: unknown[]) => mockUpdateMatter(...args),
    addMembers: jest.fn().mockResolvedValue({}),
    removeMembers: jest.fn().mockResolvedValue({}),
    listClients: (...args: unknown[]) => mockListClients(...args),
    updatePracticeArea: jest.fn().mockResolvedValue({}),
    previewRemoveMembers: jest.fn().mockResolvedValue({ users: [] }),
    addClient: (...args: unknown[]) => mockAddClient(...args),
    removeClient: jest.fn().mockResolvedValue({}),
    listCategories: jest.fn().mockResolvedValue([]),
  },
}));

// The typeahead is not under test: a button stands in for picking a result.
jest.mock("@/components/matterComp/matterForm/MatterClientPicker", () => ({
  __esModule: true,
  default: ({ onSelect }: { onSelect: (c: { id: string; name: string; email: string; clientType?: "person" | "company" | null }) => void }) => (
    <button
      type="button"
      onClick={() => onSelect({ id: "client-acme", name: "Acme Corp", email: "", clientType: "company" })}
    >
      Pick Acme Corp
    </button>
  ),
}));

import React, { useState } from "react";
import { act, screen, fireEvent, waitFor } from "@testing-library/react";
import { deferred } from "../../support/deferred";
import EditMatterModal from "@/components/matterComp/EditMatterModal";
import { renderWithProviders } from "../../support/renderWithProviders";
import type { Matter, User } from "@/types";

const USERS: User[] = [{ uid: "test-uid", name: "Test User", email: "testuser@example.com" } as User];

function matter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: "matter-1",
    name: "Estate Plan",
    description: "",
    status: "active",
    billingMethod: "hourly",
    isBillable: true,
    budgetIncludesExpenses: true,
    leadUserIds: ["test-uid"],
    members: [{ userId: "test-uid" }],
    ...overrides,
  } as Matter;
}

function saveFromTeamStep() {
  fireEvent.click(screen.getByRole("button", { name: /^Team,/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
}

beforeEach(() => {
  mockUpdateMatter.mockReset().mockResolvedValue({ message: "ok" });
  mockListClients.mockReset().mockResolvedValue([]);
  mockAddClient.mockReset().mockResolvedValue({});
});

describe("an existing client picked on the Clients step", () => {
  // Red if: the add-client call omits the picked client's id (or its type), so
  // the server creates a duplicate person row named "Acme Corp".
  it("is linked by its id and type rather than sent as a new client", async () => {
    const onClose = jest.fn();
    renderWithProviders(
      <EditMatterModal open onClose={onClose} lawFirmId="firm-1" users={USERS} matterItem={matter()} />,
    );
    await waitFor(() => expect(mockListClients).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Pick Acme Corp" }));
    saveFromTeamStep();

    await waitFor(() => expect(mockAddClient).toHaveBeenCalledTimes(1));
    expect(mockAddClient.mock.calls[0][0].client).toEqual(
      expect.objectContaining({ clientId: "client-acme", clientType: "company", name: "Acme Corp" }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  // Red if: the queued row offers name/email inputs for a client whose record
  // the save never touches, so an edit typed there is silently discarded.
  it("is shown as the picked client, not as editable new-client fields", async () => {
    renderWithProviders(
      <EditMatterModal open onClose={jest.fn()} lawFirmId="firm-1" users={USERS} matterItem={matter()} />,
    );
    await waitFor(() => expect(mockListClients).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Pick Acme Corp" }));

    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Full name")).not.toBeInTheDocument();
  });
});

describe("a matter refresh while a partly failed save is on screen", () => {
  // The matter page passes its own state as `matterItem` and reloads it in
  // `onAfter`, so the modal receives a fresh object for the same matter.
  function RefreshingHost() {
    const [item, setItem] = useState<Matter>(matter());
    return (
      <EditMatterModal
        open
        onClose={jest.fn()}
        lawFirmId="firm-1"
        users={USERS}
        matterItem={item}
        onAfter={() => setItem(matter({ name: "Estate Plan" }))}
      />
    );
  }

  // Red if: the modal re-syncs its form whenever the `matterItem` object
  // changes, which empties the queue of failed clients and clears the error.
  it("keeps the client that was not added queued, with the reason", async () => {
    mockAddClient.mockRejectedValue(new Error("A client with this email already exists"));
    renderWithProviders(<RefreshingHost />);
    await waitFor(() => expect(mockListClients).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "+ New Client" }));
    fireEvent.change(screen.getByPlaceholderText("Full name"), { target: { value: "Jane Client" } });
    saveFromTeamStep();

    expect(await screen.findByText(/A client with this email already exists/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Clients,/ }));
    expect(screen.getByPlaceholderText("Full name")).toHaveValue("Jane Client");
  });
});

describe("where a failed save is reported", () => {
  // The create wizard reads its error above the buttons; the edit wizard must
  // match, or the message sits at the top of a scrolled body out of view.
  // Red if: the banner is rendered in the scrolling body instead of the footer.
  it("shows the error in the footer, beside Save Changes", async () => {
    mockUpdateMatter.mockRejectedValue(new Error("Matter number already in use"));
    renderWithProviders(
      <EditMatterModal open onClose={jest.fn()} lawFirmId="firm-1" users={USERS} matterItem={matter()} />,
    );
    await waitFor(() => expect(mockListClients).toHaveBeenCalled());

    saveFromTeamStep();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Matter number already in use");
    const footer = screen.getByRole("button", { name: "Save Changes" }).closest(".border-t");
    expect(footer).toContainElement(alert);
  });
});

describe("Escape while the save is in flight", () => {
  // The save is several requests (team, matter, practice area, each client).
  // Red if: the modal stays dismissible while it runs, so Escape closes it and
  // a later "X was not added" message renders into a dialog that is gone.
  it("does not close the dialog until the save settles", async () => {
    const held = deferred<{ message: string }>();
    mockUpdateMatter.mockReturnValue(held.promise);
    const onClose = jest.fn();
    renderWithProviders(
      <EditMatterModal open onClose={onClose} lawFirmId="firm-1" users={USERS} matterItem={matter()} />,
    );
    await waitFor(() => expect(mockListClients).toHaveBeenCalled());

    saveFromTeamStep();
    await waitFor(() => expect(mockUpdateMatter).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => held.resolve({ message: "ok" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
