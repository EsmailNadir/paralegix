import React from "react";
import { render, screen } from "@testing-library/react";
import "../../setup";

// A Word-first "Fill & Download" link lands on the Templates page with
// ?fill=<id>. The fill form belongs to the Word-first library, so the link opens
// it whichever version the person last chose, with the linked matter picked.

jest.mock("next/navigation", () => ({
  useParams: () => ({ lawFirmId: "firm-1" }),
  useSearchParams: () => new URLSearchParams("fill=tpl-3&matterId=matter-4"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/lawfirm/firm-1/templates",
}));

jest.mock("@/contexts/PreferencesContext", () => ({
  usePreferences: () => ({ templateVersion: "overlay", updateTemplateVersion: jest.fn() }),
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

jest.mock("@/components/templatesComp/TemplatesWorkspace", () => ({
  __esModule: true,
  default: () => React.createElement("div", { "data-testid": "workspace" }),
}));

let libraryProps: any = null;
jest.mock("@/components/wordTemplates/WordTemplatesLibrary", () => ({
  __esModule: true,
  default: (props: any) => {
    libraryProps = props;
    return React.createElement("div", { "data-testid": "word-first-library" });
  },
}));

import TemplatesPage from "@/app/lawfirm/[lawFirmId]/templates/page";

it("opens the Word-first fill form for a fill link, with the matter picked", () => {
  render(React.createElement(TemplatesPage));

  expect(screen.getByTestId("word-first-library")).toBeInTheDocument();
  expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
  expect(libraryProps.initialFillTemplateId).toBe("tpl-3");
  expect(libraryProps.initialFillDraft).toEqual({ selectedCaseId: "matter-4" });
});
