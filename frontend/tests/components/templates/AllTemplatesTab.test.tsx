import React from "react";
import { render, screen } from "@testing-library/react";
import AllTemplatesTab from "@/components/templatesComp/AllTemplatesTab";
import type { Template } from "@/types/template";

const template = {
  id: "t1",
  name: "Engagement Letter",
  fields: ["client_name"],
  folderId: null,
  type: "docx",
  createdAt: "2026-09-01T12:00:00.000Z",
} as unknown as Template;

describe("AllTemplatesTab", () => {
  // The library is list-only. The List/Grid toggle and the card grid were
  // removed, so a toggle coming back would offer a view that no longer exists.
  it("renders the template list with no view toggle", () => {
    render(
      <AllTemplatesTab
        templates={[template]}
        folders={[]}
        loading={false}
        previewLoadingId={null}
        onPreview={jest.fn()}
        onFill={jest.fn()}
        onOpenMenu={jest.fn()}
      />
    );

    // The row rendered, so the absence below is not a tab that never drew.
    expect(screen.getByRole("button", { name: "Fill Engagement Letter" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "View mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Grid" })).toBeNull();
  });
});
