import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "../../setup";

const fillDraft = {
  values: {
    full_date: "April 1, 2000",
    pay: "",
  },
  repeaterValues: {
    payment: [{ date: "4/12/2026", rateofpay: "300" }],
  },
  selectedMatterId: "matter-1",
  selectedClientId: "client-1",
};

let latestWorkspaceProps: any = null;
let latestTemplateEditorProps: any = null;
const pickedFile = new File(["doc"], "retainer.pdf", { type: "application/pdf" });

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

// The templates page pulls in FillTemplateModal -> sanitizeHtml ->
// isomorphic-dompurify, whose transitive ESM deps Jest can't transform. Stub the
// sanitizer (its output isn't exercised here) to keep the module graph loadable.
jest.mock("@/lib/utils/sanitizeHtml", () => ({
  __esModule: true,
  sanitizeRichHtml: (html?: string | null) => html ?? "",
}));

// The page is gated by RequireFeature (reads FirmSettingsContext). The feature
// gate isn't what's under test here, so let it pass straight through.
jest.mock("@/components/ui/RequireFeature", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

jest.mock("@/components/templatesComp/TemplatesWorkspace", () => ({
  __esModule: true,
  default: (props: any) => {
    latestWorkspaceProps = props;
    return React.createElement(
      "div",
      null,
      React.createElement(
        "button",
        {
          type: "button",
          onClick: () => props.onEditTemplate("template-1", fillDraft),
        },
        "Open edit from fill"
      ),
      React.createElement(
        "button",
        {
          type: "button",
          onClick: () =>
            props.onOverlayCreated({
              templateId: "overlay-1",
              folderId: null,
              sourceFile: pickedFile,
            }),
        },
        "Start from picked file"
      ),
      React.createElement("div", { "data-testid": "fill-template-id" }, props.initialFillTemplateId ?? ""),
      React.createElement("div", { "data-testid": "fill-matter-id" }, props.initialFillDraft?.selectedMatterId ?? ""),
      React.createElement("div", { "data-testid": "fill-client-id" }, props.initialFillDraft?.selectedClientId ?? "")
    );
  },
}));

jest.mock("@/components/templatesComp/TemplateEditor", () => ({
  __esModule: true,
  default: (props: any) => {
    latestTemplateEditorProps = props;
    return React.createElement(
      "div",
      null,
      React.createElement("button", { type: "button", onClick: props.onBack }, "Back to Fill"),
      React.createElement("div", { "data-testid": "editor-pay" }, props.initialFillValues?.pay ?? ""),
      React.createElement("div", { "data-testid": "editor-rate" }, props.initialRepeaterFillValues?.payment?.[0]?.rateofpay ?? "")
    );
  },
}));

jest.mock("@/components/templatesComp/TemplateOverlayEditor", () => ({
  __esModule: true,
  default: (props: any) => {
    return React.createElement(
      "div",
      null,
      React.createElement("div", { "data-testid": "overlay-template-id" }, props.templateId ?? ""),
      props.onUseFullEditor
        ? React.createElement(
            "button",
            { type: "button", onClick: props.onUseFullEditor },
            "Use the full editor instead",
          )
        : null,
    );
  },
}));

import TemplatesPage from "@/app/lawfirm/[lawFirmId]/templates/page";

describe("TemplatesPage", () => {
  beforeEach(() => {
    latestWorkspaceProps = null;
    latestTemplateEditorProps = null;
  });

  it("returns to fill mode with the full saved draft after editing", async () => {
    render(React.createElement(TemplatesPage));

    fireEvent.click(screen.getByRole("button", { name: "Open edit from fill" }));

    await waitFor(() => {
      expect(latestTemplateEditorProps.initialFillValues).toEqual(fillDraft.values);
      expect(latestTemplateEditorProps.initialRepeaterFillValues).toEqual(fillDraft.repeaterValues);
    });

    expect(screen.getByTestId("editor-pay")).toHaveTextContent("");
    expect(screen.getByTestId("editor-rate")).toHaveTextContent("300");

    fireEvent.click(screen.getByRole("button", { name: "Back to Fill" }));

    await waitFor(() => {
      expect(screen.getByTestId("fill-template-id")).toHaveTextContent("template-1");
      expect(screen.getByTestId("fill-matter-id")).toHaveTextContent("matter-1");
      expect(screen.getByTestId("fill-client-id")).toHaveTextContent("client-1");
      expect(latestWorkspaceProps.initialFillDraft).toEqual(fillDraft);
    });
  });

  // A picked document becomes an overlay template first: the page opens the
  // overlay editor on the new draft, and only hands the original file to the
  // full editor if the user backs out to it. The file has to survive that hop,
  // because the full editor has nothing to build from without it.
  it("opens the overlay editor on a picked document and keeps the file for the full editor", async () => {
    render(React.createElement(TemplatesPage));

    fireEvent.click(screen.getByRole("button", { name: "Start from picked file" }));

    await waitFor(() => {
      expect(screen.getByTestId("overlay-template-id")).toHaveTextContent("overlay-1");
    });

    fireEvent.click(screen.getByRole("button", { name: "Use the full editor instead" }));

    await waitFor(() => {
      expect(latestTemplateEditorProps.initialFile?.name).toBe("retainer.pdf");
    });
  });
});
