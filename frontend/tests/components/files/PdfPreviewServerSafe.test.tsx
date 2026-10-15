/**
 * Importing the PDF viewer must not load pdf.js.
 *
 * pdf.js touches browser globals (`DOMMatrix`) as its module is evaluated, and
 * every page that can open a preview is rendered once on the server. When the
 * viewer imported `react-pdf` statically, the public share page answered 500
 * with "DOMMatrix is not defined". Here `react-pdf` throws on load the way it
 * does on the server, so a static import anywhere under `PdfPreview` fails the
 * import below.
 */
jest.unmock("@/components/filesComp/PdfPreview");
jest.mock("react-pdf", () => {
  throw new ReferenceError("DOMMatrix is not defined");
});

describe("PdfPreview", () => {
  it("can be imported without evaluating pdf.js", () => {
    expect(() => jest.requireActual("@/components/filesComp/PdfPreview")).not.toThrow();
  });
});
