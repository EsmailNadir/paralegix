import React from "react";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../support/renderWithProviders";
import { grantReadOnly, resetPermissions } from "../../support/permissions";
import { deferred } from "../../support/deferred";

const mockNavigate = jest.fn();
const mockListSigningTemplates = jest.fn();

jest.mock("@/contexts/NavigationContext", () => ({
  __esModule: true,
  useNavigation: () => ({
    navigate: mockNavigate,
    isNavigating: false,
  }),
}));

jest.mock("@/services/signatures.service", () => ({
  __esModule: true,
  default: {
    listSigningTemplates: (...args: any[]) => mockListSigningTemplates(...args),
    updateSigningTemplate: jest.fn(),
    deleteSigningTemplate: jest.fn(),
  },
}));

import SigningTemplateGrid from "@/components/signaturesComp/SigningTemplateGrid";
import signaturesService from "@/services/signatures.service";

// The grid reads through useSigningTemplates (React Query), so renders need a
// QueryClient. The mocked service still supplies the underlying data.
function renderGrid(props: React.ComponentProps<typeof SigningTemplateGrid>) {
  return renderWithProviders(React.createElement(SigningTemplateGrid, props));
}

describe("SigningTemplateGrid", () => {
  const buildTemplate = (overrides: Record<string, any> = {}) => ({
    templateId: "template-1",
    name: "Engagement letter",
    description: "Saved layout",
    routingMode: "sequential",
    signerRoles: [{ roleLabel: "Client", order: 1, deliveryMethod: "email" }],
    fields: [{ id: "field-1", page: 1, xPercent: 10, yPercent: 10, widthPercent: 20, heightPercent: 6 }],
    sourceFileName: "engagement.pdf",
    sourceObjectPath: "signing-uploads/template-docs/engagement.pdf",
    ...overrides,
  });

  beforeEach(() => {
    mockNavigate.mockClear();
    mockListSigningTemplates.mockReset();
  });

  afterEach(() => {
    resetPermissions();
  });

  it("opens the saved document with its template when a template card is clicked", async () => {
    const user = userEvent.setup();

    mockListSigningTemplates.mockResolvedValue({ templates: [buildTemplate()] });

    renderGrid({ lawFirmId: "law-firm-1" });

    await user.click(await screen.findByText("Engagement letter"));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        "/signature?objectPath=signing-uploads%2Ftemplate-docs%2Fengagement.pdf&fileName=engagement.pdf&mode=designate&lawFirmId=law-firm-1&templateId=template-1"
      );
    });
  });

  it("hides Edit/Delete for a viewer without signatures.send", async () => {
    grantReadOnly();
    mockListSigningTemplates.mockResolvedValue({ templates: [buildTemplate()] });

    renderGrid({ lawFirmId: "law-firm-1" });

    await screen.findByText("Engagement letter");
    expect(screen.queryByRole("button", { name: "Actions for Engagement letter" })).not.toBeInTheDocument();
  });

  // A template saved before source documents were retained has nothing left to
  // open, and can never be reused. It is left out of the library rather than
  // listed as a row that fails when clicked.
  it("leaves out a template missing its saved source document", async () => {
    mockListSigningTemplates.mockResolvedValue({
      templates: [
        buildTemplate({
          templateId: "template-legacy",
          name: "Legacy template",
          sourceFileName: "legacy.pdf",
          sourceObjectPath: null,
        }),
        buildTemplate({ templateId: "template-1", name: "Engagement letter" }),
      ],
    });

    renderGrid({ lawFirmId: "law-firm-1" });

    expect(await screen.findByText("Engagement letter")).toBeInTheDocument();
    expect(screen.queryByText("Legacy template")).not.toBeInTheDocument();
  });

  it("shows the whole library rather than a truncated preview", async () => {
    mockListSigningTemplates.mockResolvedValue({
      templates: [
        buildTemplate({ templateId: "template-1", name: "Alpha template" }),
        buildTemplate({ templateId: "template-2", name: "Bravo template" }),
        buildTemplate({ templateId: "template-3", name: "Charlie template" }),
        buildTemplate({ templateId: "template-4", name: "Delta template" }),
        buildTemplate({ templateId: "template-5", name: "Echo template", sourceFileName: "echo.pdf" }),
      ],
    });

    renderGrid({ lawFirmId: "law-firm-1" });

    expect(await screen.findByText("Alpha template")).toBeInTheDocument();
    expect(screen.getByText("Echo template")).toBeInTheDocument();
    expect(screen.getByText("5 templates")).toBeInTheDocument();
  });

  it("filters the grid by the search term", async () => {
    const user = userEvent.setup();

    mockListSigningTemplates.mockResolvedValue({
      templates: [
        buildTemplate({ templateId: "template-1", name: "Alpha template" }),
        buildTemplate({ templateId: "template-2", name: "Echo template", sourceFileName: "echo.pdf" }),
      ],
    });

    renderGrid({ lawFirmId: "law-firm-1" });

    await user.type(await screen.findByLabelText(/search signing templates/i), "Echo");

    expect(await screen.findByText("Echo template")).toBeInTheDocument();
    expect(screen.queryByText("Alpha template")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 2 templates")).toBeInTheDocument();
  });

  // The edit dialog stays on screen for its exit animation, and a successful
  // save closes it in the same update that would otherwise empty the form.
  it("keeps the edited name and description while Edit Template animates out after saving", async () => {
    const user = userEvent.setup();
    mockListSigningTemplates.mockResolvedValue({ templates: [buildTemplate()] });

    renderGrid({ lawFirmId: "law-firm-1" });

    await user.click(await screen.findByRole("button", { name: "Actions for Engagement letter" }));
    await user.click(await screen.findByRole("menuitem", { name: /Edit details/ }));

    const dialog = await screen.findByRole("dialog", { name: "Edit Template" });
    const nameInput = screen.getByLabelText(/Template Name/);
    await user.clear(nameInput);
    await user.type(nameInput, "Retainer letter");
    await user.clear(screen.getByLabelText("Description"));
    await user.type(screen.getByLabelText("Description"), "Updated layout");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(dialog).toHaveClass("overlay-card-exit"));
    expect(screen.getByLabelText(/Template Name/)).toHaveValue("Retainer letter");
    expect(screen.getByLabelText("Description")).toHaveValue("Updated layout");
  });

  it("opens already filtered when given an initial search term", async () => {
    mockListSigningTemplates.mockResolvedValue({
      templates: [
        buildTemplate({ templateId: "template-1", name: "Alpha template" }),
        buildTemplate({ templateId: "template-2", name: "Echo template", sourceFileName: "echo.pdf" }),
      ],
    });

    renderGrid({ lawFirmId: "law-firm-1", initialSearch: "Echo" });

    expect(await screen.findByText("Echo template")).toBeInTheDocument();
    expect(screen.queryByText("Alpha template")).not.toBeInTheDocument();
  });

  // Red if: Edit Template stays dismissible (or its Cancel stays live) while
  // the update is in flight, so Escape closes it and a refused save reports its
  // error into a closed dialog.
  it("keeps Edit Template open until the save settles", async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    const update = signaturesService.updateSigningTemplate as jest.Mock;
    update.mockClear();
    update.mockReturnValueOnce(pending.promise);
    mockListSigningTemplates.mockResolvedValue({ templates: [buildTemplate()] });

    renderGrid({ lawFirmId: "law-firm-1" });

    await user.click(await screen.findByRole("button", { name: "Actions for Engagement letter" }));
    await user.click(await screen.findByRole("menuitem", { name: /Edit details/ }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Template" });
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog).not.toHaveClass("overlay-card-exit");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    await act(async () => pending.resolve({}));
    await waitFor(() => expect(dialog).toHaveClass("overlay-card-exit"));
  });
});
