/**
 * ConvertLeadModal: the client-type copy uses the product's term for a
 * non-person client ("Organization"), and the dialog opens above the lead
 * dialog it is launched from.
 */
const mockConvertLead = jest.fn();
jest.mock("@/services/leads.service", () => ({
  __esModule: true,
  default: { convertLead: (...args: unknown[]) => mockConvertLead(...args) },
}));
const mockLookupClients = jest.fn();
jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: { lookupClients: (...args: unknown[]) => mockLookupClients(...args) },
}));

import React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../support/renderWithProviders";
import ConvertLeadModal from "@/components/leadComp/ConvertLeadModal";
import type { Lead } from "@/types";

const LEAD = { id: "lead-1", name: "Jane Roe", organization: "Roe Holdings" } as Lead;

function renderModal(lead: Lead = LEAD, onClose = jest.fn()) {
  return renderWithProviders(
    <ConvertLeadModal open onClose={onClose} lawFirmId="firm-1" lead={lead} />,
  );
}

it("offers an Organization client type, never Company", () => {
  renderModal();
  fireEvent.click(screen.getByRole("button", { name: /Client Type/ }));

  expect(screen.getByRole("option", { name: "Organization" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Company" })).not.toBeInTheDocument();
});

it("describes an organization conversion in organization terms", () => {
  renderModal();
  fireEvent.click(screen.getByRole("button", { name: /Client Type/ }));
  fireEvent.click(screen.getByRole("option", { name: "Organization" }));

  expect(screen.getByText(/Creates an organization client from Roe Holdings/)).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Organization" })).toHaveValue("Roe Holdings");
  expect(screen.queryByText(/company/i)).not.toBeInTheDocument();
});

it("opens above the lead dialog it is launched from", () => {
  renderModal();
  const overlay = screen.getByRole("dialog").parentElement?.parentElement as HTMLElement;
  expect(overlay).toHaveClass("z-[60]");
  expect(overlay.parentElement).toBe(document.body);
});

it("ignores a backdrop click while the conversion is in flight", async () => {
  mockConvertLead.mockReturnValue(new Promise(() => {}));
  const onClose = jest.fn();
  renderModal(LEAD, onClose);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Convert" }));
  });
  expect(mockConvertLead).toHaveBeenCalledTimes(1);

  const backdrop = screen.getByRole("dialog").parentElement?.previousElementSibling as HTMLElement;
  fireEvent.click(backdrop);
  expect(onClose).not.toHaveBeenCalled();
});

describe("choosing the organization", () => {
  const NO_ORG = { id: "lead-2", name: "Sameera Joshi", organization: "" } as Lead;

  beforeEach(() => {
    mockConvertLead.mockReset();
    mockConvertLead.mockResolvedValue({ matterId: null, clientId: "org-1" });
    mockLookupClients.mockReset();
    mockLookupClients.mockResolvedValue({ items: [{ id: "org-1", label: "Northwind Traders" }] });
  });

  function chooseOrganizationType() {
    fireEvent.click(screen.getByRole("button", { name: /Client Type/ }));
    fireEvent.click(screen.getByRole("option", { name: "Organization" }));
  }

  async function convert() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Convert" }));
    });
    return mockConvertLead.mock.calls[0][2];
  }

  it("lets a lead with no organization be converted into a new one by name", async () => {
    // Red before: the type picker was disabled whenever the lead had no organization.
    renderModal(NO_ORG);
    expect(screen.getByRole("button", { name: /Client Type/ })).toBeEnabled();
    chooseOrganizationType();

    const field = screen.getByRole("combobox", { name: "Organization" });
    expect(field).toHaveValue("");
    expect(screen.getByRole("button", { name: "Convert" })).toBeDisabled();

    fireEvent.change(field, { target: { value: "  Joshi Holdings " } });
    const payload = await convert();
    expect(payload).toMatchObject({ clientType: "company", organizationName: "Joshi Holdings" });
    expect(payload).not.toHaveProperty("organizationClientId");
  });

  it("converts into an existing organization picked from the suggestions", async () => {
    renderModal(NO_ORG);
    chooseOrganizationType();
    const field = screen.getByRole("combobox", { name: "Organization" });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "North" } });

    fireEvent.click(await screen.findByRole("option", { name: "Northwind Traders" }));
    expect(field).toHaveValue("Northwind Traders");
    expect(screen.getByText(/Adds Sameera Joshi to Northwind Traders/)).toBeInTheDocument();

    const payload = await convert();
    expect(payload).toMatchObject({ clientType: "company", organizationClientId: "org-1" });
    expect(payload).not.toHaveProperty("organizationName");
  });

  it("drops the picked organization once the name is edited", async () => {
    renderModal(NO_ORG);
    chooseOrganizationType();
    const field = screen.getByRole("combobox", { name: "Organization" });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "North" } });
    fireEvent.click(await screen.findByRole("option", { name: "Northwind Traders" }));

    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "Northwind Traders West" } });
    await waitFor(() => expect(screen.queryByText(/Adds Sameera Joshi to/)).not.toBeInTheDocument());

    const payload = await convert();
    expect(payload).toMatchObject({ clientType: "company", organizationName: "Northwind Traders West" });
    expect(payload).not.toHaveProperty("organizationClientId");
  });

  it("sends no organization fields for a person conversion", async () => {
    renderModal(LEAD);
    const payload = await convert();
    expect(payload).toMatchObject({ clientType: "person" });
    expect(payload).not.toHaveProperty("organizationName");
    expect(payload).not.toHaveProperty("organizationClientId");
  });
});
