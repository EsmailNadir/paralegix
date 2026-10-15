import React from "react";
import { render, screen } from "@testing-library/react";
import ESignConsentDisclosure from "@/components/signaturesComp/ESignConsent";

// The ESIGN/UETA disclosure is legally operative copy shown before a signer can
// sign. It lives in one component so the two signing surfaces can't drift apart;
// this test pins the exact wording so a reword is a deliberate, reviewed change.
describe("ESignConsentDisclosure", () => {
  it("renders the full ESIGN disclosure copy", () => {
    render(<ESignConsentDisclosure name="Jane Doe" onNameChange={() => {}} />);
    for (const line of [
      "Please confirm your identity and consent to sign this document electronically.",
      "By signing below, I confirm that:",
      "I am the individual named above",
      "I have reviewed this document in full",
      "I consent to use an electronic signature for this document",
      "I understand that my electronic signature has the same legal effect as a handwritten signature",
      "I am signing this document voluntarily and without coercion",
      "Electronic records and signatures disclosure:",
      "I agree to use electronic records and electronic signatures, and that my electronic signature is the legal equivalent of my handwritten signature.",
      "I consent to receive the related records and disclosures electronically.",
      "I have the right to request a paper copy of any record at no charge.",
      "I may withdraw my consent before signing by contacting the sender. Withdrawing consent means I cannot complete this signing electronically.",
      "To access and keep these records I need a device with internet access, a current web browser, and the ability to view and save PDF files.",
      "By typing my name and submitting, I am signing this document.",
    ]) {
      expect(screen.getByText(line)).toBeInTheDocument();
    }
    expect((screen.getByPlaceholderText("Enter your full legal name") as HTMLInputElement).value).toBe("Jane Doe");
  });
});
