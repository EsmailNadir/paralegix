import { fieldsOutsideDocument } from "@/components/signaturesComp/templateFields";
import type { SignatureField } from "@/types/signature";

const field = (id: string, page: number): SignatureField => ({
  id, page, xPercent: 10, yPercent: 10, widthPercent: 20, heightPercent: 6,
});

describe("fieldsOutsideDocument", () => {
  it("finds fields on pages the document does not have", () => {
    const result = fieldsOutsideDocument([field("a", 1), field("b", 5)], 2);
    expect(result.map((f) => f.id)).toEqual(["b"]);
  });

  it("returns nothing when every field fits", () => {
    expect(fieldsOutsideDocument([field("a", 1), field("b", 2)], 2)).toEqual([]);
  });

  it("counts the last page as inside the document", () => {
    expect(fieldsOutsideDocument([field("a", 2)], 2)).toEqual([]);
  });

  it("treats an unknown page count as fitting, so nothing is flagged mid-load", () => {
    // The template resolves before the PDF reports its page count; flagging at that
    // moment would show a warning that clears itself a beat later.
    expect(fieldsOutsideDocument([field("a", 9)], 0)).toEqual([]);
  });

  it("handles a template with no fields", () => {
    expect(fieldsOutsideDocument([], 3)).toEqual([]);
  });
});
