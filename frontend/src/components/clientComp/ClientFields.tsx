"use client";

import type { ComponentProps, ReactNode } from "react";
import Dropdown from "@/components/ui/Dropdown";
import FieldLabel from "@/components/ui/FieldLabel";
import TextInput from "@/components/ui/TextInput";
import DuplicateNameWarning from "@/components/ui/DuplicateNameWarning";
import ClientOrganizationAutocomplete from "./ClientOrganizationAutocomplete";

type Field = "name" | "email" | "phone" | "organization" | "address" | "preferredContactMethod";
type Props = {
  lawFirmId: string;
  idPrefix: string;
  values: Partial<Record<Field, string | null>>;
  onChange: (field: Field, value: string) => void;
  clientType?: "person" | "company";
  nameId?: string;
  addressId?: string;
  organizationId?: string;
  nameRequired?: boolean;
  nameAutoFocus?: boolean;
  typedContactInputs?: boolean;
  explicitTextType?: boolean;
  addressClassName?: string;
  duplicateName?: string;
  preferredLabel?: string;
  preferredOwnLabel?: boolean;
  preferredUnwrapped?: boolean;
  afterOrganization?: ReactNode;
  onSelectCompany?: ComponentProps<typeof ClientOrganizationAutocomplete>["onSelectCompany"];
};

const CONTACT_METHOD_OPTIONS = [
  { label: "None", value: "none" },
  { label: "Email", value: "email" },
  { label: "Phone", value: "phone" },
  { label: "SMS", value: "sms" },
];

/** Controlled fields only: creation, portal invitations and organization links belong to the caller. */
export default function ClientFields({ lawFirmId, idPrefix, values, onChange, clientType = "person",
  nameId = `${idPrefix}-name`, addressId = `${idPrefix}-address`, organizationId,
  nameRequired, nameAutoFocus, typedContactInputs, explicitTextType, addressClassName,
  duplicateName, preferredLabel = "Preferred Contact", preferredOwnLabel, preferredUnwrapped,
  afterOrganization, onSelectCompany }: Props) {
  const preferred = <>
    {!preferredOwnLabel && <FieldLabel id={`${idPrefix}-preferred-contact-label`}>{preferredLabel}</FieldLabel>}
    <Dropdown
      label={preferredOwnLabel ? preferredLabel : undefined}
      ariaLabelledBy={preferredOwnLabel ? undefined : `${idPrefix}-preferred-contact-label`}
      value={values.preferredContactMethod || "none"}
      onChange={(value) => onChange("preferredContactMethod", value)}
      options={CONTACT_METHOD_OPTIONS}
      portal
    />
  </>;
  return <>
    <div>
      <FieldLabel htmlFor={nameId}>{clientType === "company" ? "Organization Name *" : "Name *"}</FieldLabel>
      <TextInput id={nameId} type={explicitTextType ? "text" : undefined} value={values.name || ""}
        onChange={(e) => onChange("name", e.target.value)}
        placeholder={clientType === "company" ? "Organization name" : "Full name"}
        required={nameRequired} autoFocus={nameAutoFocus} />
      <DuplicateNameWarning duplicateName={duplicateName} entityLabel="client" />
    </div>
    <div>
      <FieldLabel htmlFor={`${idPrefix}-email`}>Email</FieldLabel>
      <TextInput id={`${idPrefix}-email`} type={typedContactInputs ? "email" : undefined}
        value={values.email || ""} onChange={(e) => onChange("email", e.target.value)} placeholder="email@example.com" />
    </div>
    <div>
      <FieldLabel htmlFor={`${idPrefix}-phone`}>Phone</FieldLabel>
      <TextInput id={`${idPrefix}-phone`} type={typedContactInputs ? "tel" : undefined}
        value={values.phone || ""} onChange={(e) => onChange("phone", e.target.value)} placeholder="(555) 123-4567" />
    </div>
    {clientType !== "company" && <div>
      <FieldLabel htmlFor={organizationId}>Organization</FieldLabel>
      <ClientOrganizationAutocomplete id={organizationId} lawFirmId={lawFirmId} value={values.organization || ""}
        onChange={(value) => onChange("organization", value)} onSelectCompany={onSelectCompany} />
    </div>}
    {afterOrganization}
    <div className={addressClassName}>
      <FieldLabel htmlFor={addressId}>Address</FieldLabel>
      <TextInput id={addressId} type={explicitTextType ? "text" : undefined} value={values.address || ""}
        onChange={(e) => onChange("address", e.target.value)} placeholder="Street, City, State ZIP" />
    </div>
    {preferredUnwrapped ? preferred : <div>{preferred}</div>}
  </>;
}
