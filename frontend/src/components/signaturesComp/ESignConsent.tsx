"use client";

import { useId } from "react";
import FieldLabel from "@/components/ui/FieldLabel";
import TextInput from "@/components/ui/TextInput";
/**
 * The ESIGN/UETA consent disclosure shown before a signer can sign.
 *
 * This is legally operative copy, so it lives in exactly one place: both signing
 * surfaces (`PDFAnnotator` for the annotate-and-sign flow, `RestrictedSigningView`
 * for the field-driven one) previously carried byte-identical duplicates of it,
 * which is how disclosure text drifts between flows without anyone noticing.
 *
 * The consent CHECKBOX is deliberately not part of this component: each surface
 * words and lays out its own agreement control, and each owns the
 * `consentAgreed` / `consentName` / `consentTimestamp` it submits to the backend.
 */

function ConsentBullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-on-surface-muted shrink-0" />
      {children}
    </li>
  );
}

export interface ESignConsentDisclosureProps {
  /** The signer's typed full legal name. */
  name: string;
  onNameChange: (value: string) => void;
  /** Locks the name field while a submission is in flight. */
  disabled?: boolean;
}

export default function ESignConsentDisclosure({
  name,
  onNameChange,
  disabled = false,
}: ESignConsentDisclosureProps) {
  const fieldIds = useId();
  return (
    <>
      <p className="text-sm text-on-surface-secondary">
        Please confirm your identity and consent to sign this document electronically.
      </p>

      <div>
        <FieldLabel htmlFor={`${fieldIds}-name`}>Full Legal Name *</FieldLabel>
        <TextInput
          id={`${fieldIds}-name`}
          type="text"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="Enter your full legal name"
          disabled={disabled}
        />
      </div>

      <div className="space-y-3 text-sm text-on-surface-secondary">
        <p className="font-medium text-on-surface">By signing below, I confirm that:</p>
        <ul className="space-y-1.5 pl-1">
          <ConsentBullet>I am the individual named above</ConsentBullet>
          <ConsentBullet>I have reviewed this document in full</ConsentBullet>
          <ConsentBullet>I consent to use an electronic signature for this document</ConsentBullet>
          <ConsentBullet>I understand that my electronic signature has the same legal effect as a handwritten signature</ConsentBullet>
          <ConsentBullet>I am signing this document voluntarily and without coercion</ConsentBullet>
        </ul>
      </div>

      <div className="space-y-3 text-sm text-on-surface-secondary">
        <p className="font-medium text-on-surface">Electronic records and signatures disclosure:</p>
        <ul className="space-y-1.5 pl-1">
          <ConsentBullet>I agree to use electronic records and electronic signatures, and that my electronic signature is the legal equivalent of my handwritten signature.</ConsentBullet>
          <ConsentBullet>I consent to receive the related records and disclosures electronically.</ConsentBullet>
          <ConsentBullet>I have the right to request a paper copy of any record at no charge.</ConsentBullet>
          <ConsentBullet>I may withdraw my consent before signing by contacting the sender. Withdrawing consent means I cannot complete this signing electronically.</ConsentBullet>
          <ConsentBullet>To access and keep these records I need a device with internet access, a current web browser, and the ability to view and save PDF files.</ConsentBullet>
          <ConsentBullet>By typing my name and submitting, I am signing this document.</ConsentBullet>
        </ul>
      </div>
    </>
  );
}
