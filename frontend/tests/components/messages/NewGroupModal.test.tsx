import React from "react";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../../support/renderWithProviders";
import { holdResponse } from "../../support/deferred";

type LookupParams = {
  search?: string;
  ids?: string[];
  userIds?: string[];
  clientType?: "person" | "company";
};

type LookupRow = { id: string; userId?: string; label: string; sublabel?: string };

// The client picker is server-backed, so the modal is driven through the lookup
// endpoint rather than a preloaded list.
const mockLookupClients = jest.fn();
const mockListClientContacts = jest.fn();
jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: {
    lookupClients: (...args: any[]) => mockLookupClients(...args),
    // Picking an organization expands it into its people through this read.
    listClientContacts: (...args: any[]) => mockListClientContacts(...args),
  },
}));

const mockCreateGroup = jest.fn();
jest.mock("@/services/messages.service", () => ({
  __esModule: true,
  default: {
    createGroup: (...args: any[]) => mockCreateGroup(...args),
  },
}));

// The firm-member list stays a bounded in-memory read. The arguments are
// recorded so a spec can see whether the closed modal asked for it.
type MemberRow = { id: string; name: string; email: string; photoUrl?: string | null };
const mockUseFirmMembers = jest.fn<MemberRow[], unknown[]>(() => []);
jest.mock("@/hooks/useFirmMembers", () => ({
  __esModule: true,
  useFirmMembers: (...args: unknown[]) => mockUseFirmMembers(...args),
}));

import NewGroupModal from "@/components/messagesComp/NewGroupModal";

const baseProps = {
  open: true,
  onClose: jest.fn(),
  lawFirmId: "law-firm-1",
  onCreated: jest.fn(),
};

function renderModal(props: Partial<React.ComponentProps<typeof NewGroupModal>> = {}) {
  return renderWithProviders(<NewGroupModal {...baseProps} {...props} />);
}

const CLIENT_ONE: LookupRow = { id: "c1", userId: "cu1", label: "Client One", sublabel: "client1@example.com" };

/**
 * The modal mounts two client pickers against the same lookup endpoint: one for
 * organizations and one for people. Answering both with the same rows puts every
 * person on screen twice, so this stub honours `clientType` the way the server
 * does and leaves the organization picker empty.
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
 * The organization and client pickers share the "Search clients..." placeholder,
 * so a bare lookup matches both. Scope to the people picker through the note
 * only it carries.
 */
function peoplePickerSearch() {
  const note = screen.getByText(/leave empty for a firm-members-only chat/i);
  return within(note.parentElement as HTMLElement).getByPlaceholderText("Search clients...");
}

describe("NewGroupModal", () => {
  // Mounted closed on the messages page and on the matter and client message
  // tabs, so it must not load the firm's members until it opens.
  it("asks for the firm member list only while open", () => {
    mockUseFirmMembers.mockClear();
    const { rerender } = renderModal({ open: false });
    expect(mockUseFirmMembers).toHaveBeenCalled();
    expect(mockUseFirmMembers.mock.calls.every((call) => call[1] === false)).toBe(true);

    rerender(<NewGroupModal {...baseProps} open />);
    expect(mockUseFirmMembers).toHaveBeenLastCalledWith("law-firm-1", true);
  });

  beforeEach(() => {
    mockCreateGroup.mockReset();
    mockCreateGroup.mockResolvedValue({ conversationId: "new-conv-1" });
    mockLookupClients.mockReset();
    mockListClientContacts.mockReset();
    mockListClientContacts.mockResolvedValue([]);
    stubClientLookup([CLIENT_ONE]);
    baseProps.onClose.mockClear();
    baseProps.onCreated.mockClear();
    mockUseFirmMembers.mockReset();
    mockUseFirmMembers.mockReturnValue([]);
  });

  it("renders nothing while closed", () => {
    const { container } = renderModal({ open: false });
    expect(container).toBeEmptyDOMElement();
  });

  // The client picker is not limited to portal-enabled clients: one added before
  // registering sees the conversation the day they create an account. What it is
  // limited to is people, so organizations cannot be picked here.
  it("offers people rather than organizations in the client picker", async () => {
    renderModal();

    await waitFor(() =>
      expect(mockLookupClients).toHaveBeenCalledWith(
        "law-firm-1",
        expect.objectContaining({ clientType: "person" }),
      ),
    );
  });

  it("creates the group with the selected client's record id and closes", async () => {
    const user = userEvent.setup();
    renderModal();

    // Select the one available client, then submit. The picker selects on the
    // client row id, which is what lets a client with no account yet be added.
    await user.click(await screen.findByText("Client One"));
    await user.click(screen.getByRole("button", { name: /start conversation/i }));

    await waitFor(() => {
      expect(mockCreateGroup).toHaveBeenCalledWith(
        "law-firm-1",
        expect.objectContaining({ clientRecordIds: ["c1"] }),
      );
      expect(baseProps.onCreated).toHaveBeenCalledWith("new-conv-1");
      expect(baseProps.onClose).toHaveBeenCalled();
    });
  });

  // The defect the shared picker fixes: before it, a search that excluded an
  // already-selected client hid the row, so the user could neither see nor
  // un-select it, yet submitting still sent them.
  it("keeps a selected client visible and removable while a search excludes them", async () => {
    const user = userEvent.setup();
    // A resolve-by-id call still finds him; a search for "zzz" does not.
    stubClientLookup([CLIENT_ONE], (params) =>
      params.ids?.length || params.userIds?.length ? [CLIENT_ONE] : params.search ? [] : undefined);

    renderModal();

    await user.click(await screen.findByText("Client One"));
    await user.type(peoplePickerSearch(), "zzz");

    await waitFor(
      () =>
        expect(mockLookupClients).toHaveBeenCalledWith(
          "law-firm-1",
          expect.objectContaining({ search: "zzz" }),
        ),
      { timeout: 3000 },
    );

    expect(screen.getByText("Client One")).toBeInTheDocument();

    // ...and still un-selectable, so the modal falls back to nothing selected
    // rather than sending someone the user can no longer see.
    await user.click(screen.getByText("Client One"));

    expect(screen.getByRole("button", { name: /start conversation/i })).toBeDisabled();
    expect(mockCreateGroup).not.toHaveBeenCalled();
  });

  // An empty group is refused by disabling the control rather than by letting the
  // click through to an error, so there is nothing to undo and nothing to read.
  it("blocks submission when no client or member is selected", async () => {
    const user = userEvent.setup();
    renderModal();

    const submit = screen.getByRole("button", { name: /start conversation/i });
    expect(submit).toBeDisabled();

    await user.click(submit);
    expect(mockCreateGroup).not.toHaveBeenCalled();
  });

  // A preselected client arrives as a portal UID, which is already the value the
  // picker selects on, so it needs no translation to become a live selection.
  it("seeds the selection from initialClientUserId", async () => {
    const user = userEvent.setup();
    renderModal({ initialClientUserId: "cu1" });

    await screen.findByText("Client One");
    await user.click(screen.getByRole("button", { name: /start conversation/i }));

    await waitFor(() =>
      expect(mockCreateGroup).toHaveBeenCalledWith(
        "law-firm-1",
        expect.objectContaining({ clientIds: ["cu1"] }),
      ),
    );
  });

  describe("the signed-in member in the firm member list", () => {
    // The signed-in user from tests/setup is "test-uid" / "Test User".
    const SELF: MemberRow = { id: "test-uid", name: "Alex Self", email: "self@firm.com" };
    const COLLEAGUE: MemberRow = { id: "m2", name: "Bob Barrister", email: "bob@firm.com" };

    function memberList() {
      const search = screen.getByPlaceholderText("Search firm members...");
      return search.parentElement!.nextElementSibling as HTMLElement;
    }

    function selfRow() {
      return within(memberList()).getByRole("button", { name: /\(you\)/ });
    }

    it("lists the creator as an included, locked row using their firm profile", () => {
      mockUseFirmMembers.mockReturnValue([COLLEAGUE, SELF]);
      renderModal();

      const row = selfRow();
      expect(row).toHaveTextContent("Alex Self (you)");
      expect(row).toHaveTextContent("self@firm.com");
      expect(row).toHaveAttribute("aria-pressed", "true");
      expect(row).toBeDisabled();
      // Listed first, ahead of the colleagues who can be picked.
      expect(within(memberList()).getAllByRole("button")[0]).toBe(row);
      // Exactly once: the creator's own member record is not also a pickable row.
      expect(within(memberList()).getAllByText(/Alex Self/)).toHaveLength(1);
    });

    it("falls back to the signed-in profile when the member list lacks the creator", () => {
      mockUseFirmMembers.mockReturnValue([COLLEAGUE]);
      renderModal();

      expect(selfRow()).toHaveTextContent("Test User (you)");
      expect(selfRow()).toHaveTextContent("testuser@example.com");
    });

    it("shows the creator even before any colleague exists", () => {
      renderModal();

      expect(selfRow()).toHaveTextContent("Test User (you)");
      expect(within(memberList()).getByText("No other members.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /add whole firm/i })).not.toBeInTheDocument();
    });

    // Always included, so a search cannot hide them, the same way a selected
    // client stays visible in the client picker.
    it("keeps the creator visible while a search excludes them", async () => {
      const user = userEvent.setup();
      mockUseFirmMembers.mockReturnValue([COLLEAGUE, SELF]);
      renderModal();

      await user.type(screen.getByPlaceholderText("Search firm members..."), "zzz");

      expect(selfRow()).toBeInTheDocument();
      expect(within(memberList()).queryByText("Bob Barrister")).not.toBeInTheDocument();
      expect(within(memberList()).getByText("No members match your search.")).toBeInTheDocument();
    });

    // The creator alone is not a conversation: their locked row must not count
    // as a recipient, and they are never sent, since the server adds them.
    it("does not count or send the creator as a picked member", async () => {
      const user = userEvent.setup();
      mockUseFirmMembers.mockReturnValue([COLLEAGUE, SELF]);
      renderModal();

      const submit = screen.getByRole("button", { name: /start conversation/i });
      await user.click(selfRow());
      expect(selfRow()).toHaveAttribute("aria-pressed", "true");
      expect(submit).toBeDisabled();

      await user.click(screen.getByRole("button", { name: /add whole firm/i }));
      await user.click(submit);

      await waitFor(() =>
        expect(mockCreateGroup).toHaveBeenCalledWith(
          "law-firm-1",
          expect.objectContaining({ memberIds: ["m2"] }),
        ),
      );
    });
  });

  describe("while the group is being created", () => {
    // Red if: the dialog stays dismissible during the create (no
    // `dismissible={!submitting}`) or Cancel stays enabled, so Escape abandons
    // the dialog mid-save and a later failure renders into a closed dialog.
    it("cannot be closed until the create settles", async () => {
      const held = holdResponse<{ conversationId: string }>();
      mockCreateGroup.mockImplementation(held.handler);
      const user = userEvent.setup();
      renderModal();

      await user.click(await screen.findByText("Client One"));
      await user.click(screen.getByRole("button", { name: /start conversation/i }));
      await held.untilRequested();

      fireEvent.keyDown(document, { key: "Escape" });
      expect(baseProps.onClose).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

      await act(async () => held.release({ conversationId: "new-conv-1" }));
      await waitFor(() => expect(baseProps.onClose).toHaveBeenCalledTimes(1));
      expect(baseProps.onCreated).toHaveBeenCalledWith("new-conv-1");
    });
  });
});
