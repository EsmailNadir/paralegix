import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "../../setup";
import type { TemplateVersion } from "@/types/preferences";

// The Templates page hosts three template experiences behind one per-user
// switch. These specs pin which flow "New" leads to under each one, and that
// the switch itself is on screen in every version so a person can always get
// back.

let templateVersion: TemplateVersion = "overlay";
const updateTemplateVersion = jest.fn(async (next: TemplateVersion) => {
  templateVersion = next;
});
jest.mock("@/contexts/PreferencesContext", () => ({
  usePreferences: () => ({ templateVersion, updateTemplateVersion }),
}));

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock("@/lib/utils/sanitizeHtml", () => ({
  __esModule: true,
  sanitizeRichHtml: (html?: string | null) => html ?? "",
}));

jest.mock("@/components/ui/RequireFeature", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

const pickedFile = new File(["doc"], "engagement.docx", {
  type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
});
let latestWorkspaceProps: any = null;
let latestTemplateEditorProps: any = null;

jest.mock("@/components/templatesComp/TemplatesWorkspace", () => ({
  __esModule: true,
  default: (props: any) => {
    latestWorkspaceProps = props;
    return React.createElement(
      "div",
      { "data-testid": "workspace" },
      props.headerActions,
      React.createElement(
        "button",
        { type: "button", onClick: () => props.onDocumentPicked?.({ file: pickedFile, folderId: "folder-9" }) },
        "Pick a document",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          onClick: () =>
            props.onOverlayCreated({ templateId: "overlay-1", folderId: null, sourceFile: pickedFile }),
        },
        "Overlay uploaded",
      ),
    );
  },
}));

jest.mock("@/components/templatesComp/TemplateEditor", () => ({
  __esModule: true,
  default: (props: any) => {
    latestTemplateEditorProps = props;
    return React.createElement("div", { "data-testid": "full-editor" });
  },
}));

jest.mock("@/components/templatesComp/TemplateOverlayEditor", () => ({
  __esModule: true,
  default: (props: any) =>
    React.createElement("div", { "data-testid": "overlay-editor" }, props.templateId),
}));

jest.mock("@/components/wordTemplates/WordTemplatesLibrary", () => ({
  __esModule: true,
  default: (props: any) =>
    React.createElement("div", { "data-testid": "word-first-library" }, props.versionToggle),
}));

import TemplatesPage from "@/app/lawfirm/[lawFirmId]/templates/page";

beforeEach(() => {
  templateVersion = "overlay";
  updateTemplateVersion.mockClear();
  latestWorkspaceProps = null;
  latestTemplateEditorProps = null;
});

it("labels the switch Overlay, Full editor and Word-first (JJ), with the current version pressed", () => {
  templateVersion = "full-editor";
  render(React.createElement(TemplatesPage));

  const group = screen.getByRole("group", { name: "Template version" });
  const buttons = Array.from(group.querySelectorAll("button")).map((b) => b.textContent);
  expect(buttons).toEqual(["Overlay", "Full editor", "Word-first (JJ)"]);
  expect(screen.getByRole("button", { name: "Full editor" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Overlay" })).toHaveAttribute("aria-pressed", "false");
});

it("overlay: a new document opens the overlay editor, which offers the full editor", async () => {
  render(React.createElement(TemplatesPage));

  expect(latestWorkspaceProps.createMode).toBe("overlay");
  fireEvent.click(screen.getByRole("button", { name: "Overlay uploaded" }));

  await waitFor(() => expect(screen.getByTestId("overlay-editor")).toHaveTextContent("overlay-1"));
});

it("full editor: a picked document goes straight to the full editor with no overlay step", async () => {
  templateVersion = "full-editor";
  render(React.createElement(TemplatesPage));

  expect(latestWorkspaceProps.createMode).toBe("full-editor");
  fireEvent.click(screen.getByRole("button", { name: "Pick a document" }));

  await waitFor(() => expect(screen.getByTestId("full-editor")).toBeInTheDocument());
  expect(screen.queryByTestId("overlay-editor")).not.toBeInTheDocument();
  expect(latestTemplateEditorProps.initialFile).toBe(pickedFile);
  expect(latestTemplateEditorProps.folderId).toBe("folder-9");
  expect(latestTemplateEditorProps.templateId).toBeUndefined();
  // No overlay draft sits behind this editor, so there is nothing to go back to.
  expect(latestTemplateEditorProps.onUseOverlayEditor).toBeUndefined();
});

it("word-first: shows the Word-first library instead of the Paralegix workspace", () => {
  templateVersion = "word-first";
  render(React.createElement(TemplatesPage));

  expect(screen.getByTestId("word-first-library")).toBeInTheDocument();
  expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
  // The switch rides into the Word-first header, so the way back is still there.
  expect(screen.getByRole("button", { name: "Overlay" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "Word-first (JJ)" })).toHaveAttribute("aria-pressed", "true");
});

it("saves the version the person picks", () => {
  render(React.createElement(TemplatesPage));

  fireEvent.click(screen.getByRole("button", { name: "Word-first (JJ)" }));

  expect(updateTemplateVersion).toHaveBeenCalledWith("word-first");
});
