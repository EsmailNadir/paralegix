import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// Mock heavy dependencies
jest.mock("@/components/templatesComp/PlaceholderModal", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/lib/pdfToHtml", () => ({
  convertPdfToHtml: jest.fn().mockResolvedValue({ html: "", warnings: [] }),
}));
jest.mock("@/types/signature", () => ({
  FONT_FAMILIES: [
    { label: "Helvetica", value: "Helvetica", css: "Helvetica, Arial, sans-serif" },
    { label: "Arial", value: "Arial", css: "Arial, Helvetica, sans-serif" },
    { label: "Times New Roman", value: "Times-Roman", css: "'Times New Roman', Times, serif" },
  ],
  FONT_SIZES: [12, 14, 16, 18],
}));
jest.mock("@/components/signaturesComp/textFormatting", () => ({
  foreColorToHex: jest.fn(),
  mapCssToFontValue: jest.fn((css: string) => (
    css.toLowerCase().includes("times") ? "Times-Roman" : "Helvetica"
  )),
}));
jest.mock("@/services/templates.service", () => ({
  templatesService: {
    list: jest.fn(),
    create: jest.fn(),
    getById: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    listFolders: jest.fn(),
    createFolder: jest.fn(),
    updateFolder: jest.fn(),
    deleteFolder: jest.fn(),
    moveTemplateToFolder: jest.fn(),
    convertToPdf: jest.fn(),
    convertToFormat: jest.fn(),
    uploadDocxTemplate: jest.fn(),
    reuploadDocxTemplate: jest.fn(),
    fillDocxTemplate: jest.fn(),
  },
}));

import TemplateEditor from "@/components/templatesComp/TemplateEditor";
import { templatesService } from "@/services/templates.service";

describe("TemplateEditor", () => {
  const mockedTemplatesService = templatesService as jest.Mocked<typeof templatesService>;
  const defaultProps = {
    lawFirmId: "test-law-firm-id",
    onSaved: jest.fn(),
    onBack: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uploads imported DOCX files through the direct-storage service", async () => {
    const docx = new File(["docx"], "agreement.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const pdf = new File(["pdf"], "agreement.pdf", { type: "application/pdf" });
    mockedTemplatesService.uploadDocxTemplate.mockResolvedValue({
      id: "template-docx",
      name: "agreement",
      type: "docx",
      fields: [],
      repeaters: [],
      html: undefined,
      assets: [],
      folderId: null,
      createdAt: "2026-04-09T00:00:00.000Z",
    });
    mockedTemplatesService.convertToPdf.mockResolvedValue(pdf);

    render(React.createElement(TemplateEditor, { ...defaultProps, initialFile: docx }));

    await waitFor(() => {
      expect(mockedTemplatesService.uploadDocxTemplate).toHaveBeenCalledWith(
        defaultProps.lawFirmId,
        docx,
        "agreement",
        { signal: expect.any(AbortSignal) },
      );
    });
  });

  it("renders the upload state before a document is loaded", () => {
    render(React.createElement(TemplateEditor, defaultProps));
    expect(screen.getByText(/drop a document here/i)).toBeInTheDocument();
  });

  it("renders editor tools for a saved template, including image insertion", async () => {
    mockedTemplatesService.getById.mockResolvedValue({
      id: "template-1",
      name: "Editable Template",
      type: "html",
      fields: [],
      repeaters: [],
      html: `
        <html>
          <body>
            <div class="pdf-page" style="position:relative;width:612px;min-height:792px;">
              <p>Hello world</p>
            </div>
          </body>
        </html>
      `,
      assets: [],
      folderId: null,
      createdAt: "2026-04-09T00:00:00.000Z",
    });

    render(React.createElement(TemplateEditor, {
      ...defaultProps,
      templateId: "template-1",
    }));

    expect(await screen.findByText(/insert field/i)).toBeInTheDocument();
    expect(screen.getByText(/insert image/i)).toBeInTheDocument();
    expect(screen.getByText(/update template/i)).toBeInTheDocument();
  });

  it("refreshes the font toolbar after native text input without relying on selectionchange", async () => {
    mockedTemplatesService.getById.mockResolvedValue({
      id: "template-2",
      name: "Styled Template",
      type: "html",
      fields: [],
      repeaters: [],
      html: `
        <html>
          <body>
            <div class="pdf-page" style="position:relative;width:612px;min-height:792px;">
              <p>Hello world</p>
            </div>
          </body>
        </html>
      `,
      assets: [],
      folderId: null,
      createdAt: "2026-04-09T00:00:00.000Z",
    });

    const { container } = render(React.createElement(TemplateEditor, {
      ...defaultProps,
      templateId: "template-2",
    }));

    await screen.findByText(/insert field/i);

    const editor = container.querySelector<HTMLElement>('[contenteditable="true"]');
    const paragraph = container.querySelector<HTMLElement>(".pdf-page p");
    expect(editor).not.toBeNull();
    expect(paragraph).not.toBeNull();

    paragraph!.innerHTML = '<span style="font-family:\'Times New Roman\', Times, serif;font-size:18px;">Hello world</span>';
    const textNode = paragraph!.querySelector("span")?.firstChild;
    expect(textNode?.nodeType).toBe(Node.TEXT_NODE);

    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(textNode as Text, 5);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.input(editor!);

    await waitFor(() => {
      expect(screen.getByText("Times New Roman")).toBeInTheDocument();
      expect(screen.getByText("18px")).toBeInTheDocument();
    });
  });

  it("promotes page background images into editable image objects without the old footer layer toolbar", async () => {
    mockedTemplatesService.getById.mockResolvedValue({
      id: "template-3",
      name: "Background Image Template",
      type: "html",
      fields: [],
      repeaters: [],
      html: `
        <html>
          <body>
            <div class="pdf-page" style="position:relative;width:612px;min-height:792px;">
              <img
                class="pdf-page-background"
                src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2P8z8DwHwAFgwJ/lv2F3QAAAABJRU5ErkJggg=="
                alt=""
                style="position:absolute;left:0;top:0;width:100%;height:100%;z-index:0;pointer-events:none;user-select:none;"
                data-template-source="pdf-import-fallback"
              />
              <p>Hello world</p>
            </div>
          </body>
        </html>
      `,
      assets: [],
      folderId: null,
      createdAt: "2026-04-09T00:00:00.000Z",
    });

    const { container } = render(React.createElement(TemplateEditor, {
      ...defaultProps,
      templateId: "template-3",
    }));

    await screen.findByText(/insert field/i);

    await waitFor(() => {
      expect(container.querySelector(".pdf-page-background")).toBeNull();
      expect(container.querySelector("[data-template-image-object-id]")).not.toBeNull();
    });

    expect(screen.queryByRole("toolbar", { name: /image layer/i })).not.toBeInTheDocument();
    expect(container.querySelector("[data-template-image-layer-trigger]")).not.toBeNull();
  });

});
