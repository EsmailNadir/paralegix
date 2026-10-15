import React from "react";
import { render, screen, waitFor } from "@testing-library/react";

const calculateSignatureLayout = jest.fn();

jest.mock("@/components/signaturesComp/signatureLayout", () => ({
  calculateSignatureLayout: (...args: unknown[]) => calculateSignatureLayout(...args),
}));

import SignatureVisual from "@/components/signaturesComp/SignatureVisual";

describe("SignatureVisual", () => {
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

  beforeEach(() => {
    calculateSignatureLayout.mockReturnValue({
      style: "standard",
      imageRect: { x: 12, y: 8, width: 70, height: 24 },
    });

    HTMLElement.prototype.getBoundingClientRect = jest.fn(() => ({
      width: 200,
      height: 60,
      top: 0,
      left: 0,
      right: 200,
      bottom: 60,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })) as typeof HTMLElement.prototype.getBoundingClientRect;
  });

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    jest.clearAllMocks();
  });

  it("uses the computed layout rect for the rendered preview image", async () => {
    render(
      React.createElement("div", { style: { width: 200, height: 60 } },
        React.createElement(SignatureVisual, {
          style: "standard",
          dataUrl: "data:image/png;base64,test",
        }))
    );

    const image = await screen.findByAltText("Signature");

    await waitFor(() => {
      expect(calculateSignatureLayout).toHaveBeenCalled();
      expect(image).toHaveStyle({
        left: "12px",
        top: "8px",
        width: "70px",
        height: "24px",
      });
    });
  });
});
