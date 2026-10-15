/**
 * NewGroupModal: who a new conversation reaches.
 *
 * Two failure modes here message people the user did not mean to message:
 *  - a group of several hand-picked clients with no matter must be confirmed
 *    first, like an organization pick is, because everyone added sees each other;
 *  - an organization dropped before its roster finished loading must not add
 *    that roster when the request lands afterwards.
 */
import React from "react";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../support/renderWithProviders";

type LookupParams = { search?: string; ids?: string[]; userIds?: string[]; clientType?: "person" | "company" };
type LookupRow = { id: string; userId?: string; label: string; sublabel?: string };

const mockLookupClients = jest.fn();
const mockListClientContacts = jest.fn();
jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: {
    lookupClients: (...args: any[]) => mockLookupClients(...args),
    listClientContacts: (...args: any[]) => mockListClientContacts(...args),
  },
}));

const mockCreateGroup = jest.fn();
jest.mock("@/services/messages.service", () => ({
  __esModule: true,
  default: { createGroup: (...args: any[]) => mockCreateGroup(...args) },
}));

jest.mock("@/hooks/useFirmMembers", () => ({
  __esModule: true,
  useFirmMembers: () => [],
}));

import NewGroupModal from "@/components/messagesComp/NewGroupModal";

const PEOPLE: LookupRow[] = [
  { id: "c1", userId: "cu1", label: "Client One" },
  { id: "c2", userId: "cu2", label: "Client Two" },
];
const ORGS: LookupRow[] = [{ id: "org-1", label: "Roe Holdings" }];

const props = { open: true, onClose: jest.fn(), lawFirmId: "law-firm-1", onCreated: jest.fn() };

beforeEach(() => {
  mockCreateGroup.mockReset().mockResolvedValue({ conversationId: "conv-1" });
  mockListClientContacts.mockReset();
  mockLookupClients.mockReset().mockImplementation(async (_firm: string, params: LookupParams = {}) => {
    if (params.clientType === "company") return { items: ORGS, hasMore: false };
    return { items: PEOPLE, hasMore: false };
  });
});

it("asks before starting a matterless conversation with several hand-picked clients", async () => {
  const user = userEvent.setup();
  renderWithProviders(<NewGroupModal {...props} />);

  await user.click(await screen.findByText("Client One"));
  await user.click(screen.getByText("Client Two"));
  await user.click(screen.getByRole("button", { name: /start conversation/i }));

  expect(await screen.findByText("Start conversation without a matter?")).toBeInTheDocument();
  expect(mockCreateGroup).not.toHaveBeenCalled();
});

it("starts a conversation with one hand-picked client without asking", async () => {
  const user = userEvent.setup();
  renderWithProviders(<NewGroupModal {...props} />);

  await user.click(await screen.findByText("Client One"));
  await user.click(screen.getByRole("button", { name: /start conversation/i }));

  await waitFor(() => expect(mockCreateGroup).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("Start conversation without a matter?")).not.toBeInTheDocument();
});

it("does not add an organization's people when it was dropped before they loaded", async () => {
  const user = userEvent.setup();
  let releaseRoster: ((contacts: unknown[]) => void) | undefined;
  mockListClientContacts.mockImplementation(
    () => new Promise((resolve) => { releaseRoster = resolve; }),
  );
  renderWithProviders(<NewGroupModal {...props} />);

  // Pick the organization, then drop it while its roster is still loading.
  await user.click(await screen.findByText("Roe Holdings"));
  await waitFor(() => expect(releaseRoster).toBeDefined());
  await user.click(screen.getByText("Roe Holdings"));

  releaseRoster?.([{ id: "contact-1", personClientId: "c2" }]);
  // Give the late roster a chance to land, then pick one person by hand.
  await waitFor(() => expect(mockListClientContacts).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await user.click(screen.getByText("Client One"));
  await user.click(screen.getByRole("button", { name: /start conversation/i }));

  await waitFor(() => expect(mockCreateGroup).toHaveBeenCalledTimes(1));
  expect(mockCreateGroup).toHaveBeenCalledWith(
    "law-firm-1",
    expect.objectContaining({ clientRecordIds: ["c1"], organizationClientIds: [] }),
  );
});
