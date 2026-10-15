/**
 * Clearing an optional field in `EditMatterModal`, through the REAL matters
 * and practice-area transport.
 *
 *   "NONE" CLEARS THE PRACTICE AREA. The dropdown's None option is an empty
 *   value; the save has to send null so the server clears the column, rather
 *   than a payload the route refuses.
 *
 *   AN EMPTIED MATTER NUMBER IS SENT. Dropping the key when the field is blank
 *   left the old number in place while the modal reported a clean save.
 */
jest.unmock("@/services/matters.service");
jest.unmock("@/services/practiceArea.service");
jest.unmock("@/services/requestDeduplicator");
jest.mock("@/hooks/useEntityLookup", () => ({
  useDuplicateNameCheck: () => ({ duplicate: null }),
  useEntityLookup: () => ({ items: [], hasMore: false, loading: false }),
}));

import React from "react";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import EditMatterModal from "@/components/matterComp/EditMatterModal";
import { installApiMock, type ApiMock } from "../../support/apiMock";
import { renderWithProviders } from "../../support/renderWithProviders";
import type { Matter, User } from "@/types";

const USERS: User[] = [{ uid: "test-uid", name: "Test User", email: "testuser@example.com" } as User];
const MATTER_URL = "/lawfirms/firm-1/matters/matter-1";

function matter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: "matter-1",
    name: "Estate Plan",
    matterNumber: "2026-001",
    description: "",
    status: "active",
    practiceAreaId: "pa-family",
    billingMethod: "hourly",
    isBillable: true,
    budgetIncludesExpenses: true,
    leadUserIds: ["test-uid"],
    members: [{ userId: "test-uid" }],
    ...overrides,
  } as Matter;
}

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  api.get("/lawfirms/firm-1/practice-areas", { practiceAreas: [{ id: "pa-family", name: "Family" }] });
  api.get(`${MATTER_URL}/clients`, { clients: [] });
  api.get("/lawfirms/firm-1/matters/categories", { categories: [] });
  api.put(MATTER_URL, { message: "ok" });
  api.post(`${MATTER_URL}/update-practice-area`, { message: "ok" });
});

afterEach(() => {
  api.restore();
});

async function renderModal(onClose = jest.fn()) {
  renderWithProviders(
    <EditMatterModal open onClose={onClose} lawFirmId="firm-1" users={USERS} matterItem={matter()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Matter Details,/ }));
  await screen.findByRole("button", { name: /^Family/ });
  return onClose;
}

function saveFromTeamStep() {
  fireEvent.click(screen.getByRole("button", { name: /^Team,/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
}

describe("clearing the practice area", () => {
  // Red if: None is sent as "" (which the route used to refuse) or not sent at all.
  it("sends null when None is chosen", async () => {
    const onClose = await renderModal();

    fireEvent.click(screen.getByRole("button", { name: /^Family/ }));
    fireEvent.click(await screen.findByRole("option", { name: "None" }));
    saveFromTeamStep();

    await waitFor(() => expect(api.callsTo(`${MATTER_URL}/update-practice-area`)).toHaveLength(1));
    expect(api.callsTo(`${MATTER_URL}/update-practice-area`)[0].body).toEqual({ practiceAreaId: null });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe("clearing the matter number", () => {
  // Red if: a blank matter number is dropped from the payload, leaving the old one.
  it("sends an empty matter number so the server clears it", async () => {
    await renderModal();

    fireEvent.change(screen.getByLabelText("Matter Number"), { target: { value: "   " } });
    saveFromTeamStep();

    await waitFor(() => expect(api.callsTo(MATTER_URL).filter((c) => c.method === "PUT")).toHaveLength(1));
    const [put] = api.callsTo(MATTER_URL).filter((c) => c.method === "PUT");
    expect((put.body as Record<string, unknown>).matterNumber).toBe("");
  });

  it("still sends an unchanged matter number", async () => {
    await renderModal();

    saveFromTeamStep();

    await waitFor(() => expect(api.callsTo(MATTER_URL).filter((c) => c.method === "PUT")).toHaveLength(1));
    const [put] = api.callsTo(MATTER_URL).filter((c) => c.method === "PUT");
    expect((put.body as Record<string, unknown>).matterNumber).toBe("2026-001");
  });
});

describe("a new client queued on the Clients step", () => {
  // Red if: "None" goes out as undefined, which the server stores as 'email'.
  it("is added with a null contact method when None is left chosen", async () => {
    api.post(`${MATTER_URL}/clients`, { message: "ok", clientId: "client-new" });
    renderWithProviders(
      <EditMatterModal open onClose={jest.fn()} lawFirmId="firm-1" users={USERS} matterItem={matter()} />,
    );
    await waitFor(() => expect(api.callsTo(`${MATTER_URL}/clients`)).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "+ New Client" }));
    fireEvent.change(screen.getByPlaceholderText("Full name"), { target: { value: "Jane Client" } });
    saveFromTeamStep();

    await waitFor(() => expect(api.callsTo(`${MATTER_URL}/clients`).filter((c) => c.method === "POST")).toHaveLength(1));
    const [post] = api.callsTo(`${MATTER_URL}/clients`).filter((c) => c.method === "POST");
    expect((post.body as { client: Record<string, unknown> }).client).toHaveProperty("preferredContactMethod", null);
  });
});
