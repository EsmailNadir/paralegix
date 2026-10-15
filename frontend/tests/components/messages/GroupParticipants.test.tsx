import React from "react";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../../support/renderWithProviders";

type LookupParams = {
  search?: string;
  ids?: string[];
  userIds?: string[];
  clientType?: "person" | "company";
};

type LookupRow = { id: string; userId?: string; label: string; sublabel?: string };

// The add-clients picker is server-backed, so it is driven through the lookup
// endpoint rather than a preloaded list.
const mockLookupClients = jest.fn();
jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: {
    lookupClients: (...args: any[]) => mockLookupClients(...args),
  },
}));

const mockAddGroupParticipants = jest.fn();
jest.mock("@/services/messages.service", () => ({
  __esModule: true,
  default: {
    addGroupParticipants: (...args: any[]) => mockAddGroupParticipants(...args),
    removeGroupParticipant: jest.fn().mockResolvedValue({}),
  },
}));

// The firm-member list stays a bounded in-memory read.
jest.mock("@/hooks/useFirmMembers", () => ({
  __esModule: true,
  useFirmMembers: () => [],
}));

import GroupParticipants from "@/components/messagesComp/GroupParticipants";

const participants = [
  { userId: "u1", type: "firm_member" as const, name: "Alice Attorney", email: "alice@firm.com" },
  { userId: "u2", type: "client" as const, name: "Carl Client", email: "carl@example.com" },
];

const baseProps = {
  lawFirmId: "law-firm-1",
  conversationId: "conv-1",
  participants,
  canManage: true,
  // Adding a client carries its own permission on top of `canManage`, and it
  // defaults to false. Most of this file is about the client pickers, so grant
  // it here; the one test that covers the gate turns it back off.
  canAddClients: true,
  currentUserId: "u1",
  onChanged: jest.fn(),
};

function renderParticipants(
  props: Partial<React.ComponentProps<typeof GroupParticipants>> = {},
) {
  return renderWithProviders(<GroupParticipants {...baseProps} {...props} />);
}

const DANA: LookupRow = { id: "c3", userId: "u3", label: "Dana Client", sublabel: "dana@example.com" };

/**
 * The component mounts two client pickers against the same lookup endpoint: one
 * for people and one for organizations. Answering both with the same rows puts
 * every person on screen twice, so this stub honours `clientType` the way the
 * server does and leaves the organization picker empty.
 *
 * `perCall` narrows the person rows for a given request; returning undefined
 * falls back to `people`.
 */
function stubClientLookup(people: LookupRow[], perCall?: (params: LookupParams) => LookupRow[] | undefined) {
  mockLookupClients.mockImplementation(async (_firmId: string, params: LookupParams = {}) => {
    if (params.clientType === "company") return { items: [], hasMore: false };
    return { items: perCall?.(params) ?? people, hasMore: false };
  });
}

/**
 * The people and organization pickers share the "Search clients..." placeholder,
 * so a bare lookup matches both. Scope to the people picker through the note
 * only it carries.
 */
function peoplePickerSearch() {
  const note = screen.getByText(/clients without an account will get access/i);
  return within(note.parentElement as HTMLElement).getByPlaceholderText("Search clients...");
}

describe("GroupParticipants", () => {
  beforeEach(() => {
    mockAddGroupParticipants.mockReset();
    mockAddGroupParticipants.mockResolvedValue({});
    mockLookupClients.mockReset();
    stubClientLookup([DANA]);
  });

  it("renders the participant roster from props", () => {
    renderParticipants();

    expect(screen.getByText(/Participants \(2\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Alice Attorney/)).toBeInTheDocument();
    expect(screen.getByText(/Carl Client/)).toBeInTheDocument();
    // The current user is tagged "(you)".
    expect(screen.getByText(/Alice Attorney \(you\)/)).toBeInTheDocument();
  });

  it("shows a remove control only for other participants and confirms on click", async () => {
    const user = userEvent.setup();
    renderParticipants();

    // No remove affordance for the current user (u1); one for the other (u2).
    expect(screen.queryByRole("button", { name: /remove alice attorney/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /remove carl client/i }));

    // Clicking opens the delete confirmation.
    expect(await screen.findByText(/remove carl client from the group/i)).toBeInTheDocument();
  });

  it("hides management controls when canManage is false", () => {
    renderParticipants({ canManage: false });

    expect(screen.queryByText("Add participant")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove carl client/i })).not.toBeInTheDocument();
  });

  // Adding a colleague needs only `messaging.send`; adding a client hands
  // someone outside the firm a way into the correspondence, so it carries its
  // own permission. Without it the pickers are hidden rather than left to fail
  // on the server.
  it("hides the client pickers when the user cannot add clients", async () => {
    const user = userEvent.setup();
    renderParticipants({ canAddClients: false });

    await user.click(screen.getByRole("button", { name: /add participant/i }));

    expect(screen.getByPlaceholderText("Search firm members...")).toBeInTheDocument();
    expect(screen.queryByText(/clients without an account will get access/i)).not.toBeInTheDocument();
    expect(mockLookupClients).not.toHaveBeenCalled();
  });

  // The people picker is not limited to clients who already hold a portal
  // account: one added before registering joins the thread the day they sign up.
  // What it is limited to is people, so organizations cannot be picked here.
  it("offers people rather than organizations in the client picker", async () => {
    const user = userEvent.setup();
    renderParticipants();

    await user.click(screen.getByRole("button", { name: /add participant/i }));

    expect(await screen.findByText("Dana Client")).toBeInTheDocument();
    await waitFor(() =>
      expect(mockLookupClients).toHaveBeenCalledWith(
        "law-firm-1",
        expect.objectContaining({ clientType: "person" }),
      ),
    );
  });

  // Existing participants are keyed by portal UID, so the picker must exclude
  // them on that same key or it would offer someone already in the group.
  //
  // KNOWN BUG, tracked by this test: GroupParticipants builds `existingUserIds`
  // and its comment says the client picker takes it as `excludeIds`, but the
  // picker is never given the prop. The exclusion would not land even if it
  // were, because the people picker now keys on the client record id while
  // participants are keyed by portal UID. `it.failing` passes while the bug is
  // present and starts failing the day it is fixed, at which point this should
  // become a plain `it`.
  it.failing("does not offer a client already in the conversation", async () => {
    const user = userEvent.setup();
    stubClientLookup([{ id: "c2", userId: "u2", label: "Carl Client" }, DANA]);

    renderParticipants();
    await user.click(screen.getByRole("button", { name: /add participant/i }));

    await screen.findByText("Dana Client");
    // "Carl Client" still appears once, in the roster above; the picker must not
    // add a second, selectable copy of him.
    expect(screen.getAllByText(/Carl Client/)).toHaveLength(1);
  });

  // The defect the shared picker fixes: before it, a search that excluded an
  // already-selected client hid the row, so the user could neither see nor
  // un-select it, yet submitting still added them.
  it("keeps a selected client visible and removable while a search excludes them", async () => {
    const user = userEvent.setup();
    // A resolve-by-id call still finds her; a search for "zzz" does not.
    stubClientLookup([DANA], (params) => (params.userIds?.length ? [DANA] : params.search ? [] : undefined));

    renderParticipants({ groupHasMatter: true });
    await user.click(screen.getByRole("button", { name: /add participant/i }));

    await user.click(await screen.findByText("Dana Client"));
    await user.type(peoplePickerSearch(), "zzz");

    await waitFor(
      () =>
        expect(mockLookupClients).toHaveBeenCalledWith(
          "law-firm-1",
          expect.objectContaining({ search: "zzz" }),
        ),
      { timeout: 3000 },
    );

    // Still on screen although the search returned nothing...
    expect(screen.getByText("Dana Client")).toBeInTheDocument();

    // ...and still un-selectable, so submitting no longer adds a person the user
    // can no longer see.
    await user.click(screen.getByText("Dana Client"));
    await user.click(screen.getByRole("button", { name: /^add$/i }));

    expect(await screen.findByText(/select at least one person or organization to add/i)).toBeInTheDocument();
    expect(mockAddGroupParticipants).not.toHaveBeenCalled();
  });

  // The people picker selects on the client row id, not the portal UID, which is
  // what lets a client with no account yet be added at all.
  it("adds the selected client by record id and keeps the share-history choice", async () => {
    const user = userEvent.setup();
    renderParticipants({ groupHasMatter: true });

    await user.click(screen.getByRole("button", { name: /add participant/i }));
    await user.click(await screen.findByText("Dana Client"));

    // The toggle only appears once a client is selected.
    await user.click(screen.getByLabelText(/let added clients see previous messages/i));
    await user.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() =>
      expect(mockAddGroupParticipants).toHaveBeenCalledWith(
        "law-firm-1",
        "conv-1",
        expect.objectContaining({ clientRecordIds: ["c3"], shareHistory: false }),
      ),
    );
  });

  // A second client on a group with no matter scope is confirmed first, so an
  // unscoped cross-client thread is never created by accident.
  it("confirms before adding a client to an unscoped multi-client group", async () => {
    const user = userEvent.setup();
    renderParticipants();

    await user.click(screen.getByRole("button", { name: /add participant/i }));
    await user.click(await screen.findByText("Dana Client"));
    await user.click(screen.getByRole("button", { name: /^add$/i }));

    expect(await screen.findByText(/add client to an unscoped group\?/i)).toBeInTheDocument();
    expect(mockAddGroupParticipants).not.toHaveBeenCalled();
  });
});
