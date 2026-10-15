"use client";

import { useId } from "react";
import FieldLabel, { type FieldLabelSize, type FieldLabelTone } from "./FieldLabel";

interface ReasonFieldProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder: string;
  rows?: number;
  labelSize?: FieldLabelSize;
  labelTone?: FieldLabelTone;
  className?: string;
}

/** Controlled reason input; ConfirmModal and its caller own confirmation rules. */
export default function ReasonField({
  value, onChange, label = "Reason", placeholder, rows = 2, labelSize, labelTone,
  className = "w-full resize-none rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
}: ReasonFieldProps) {
  const id = useId();
  return (
    <>
      <FieldLabel htmlFor={id} size={labelSize} tone={labelTone}>{label}</FieldLabel>
      <textarea id={id} value={value} onChange={(event) => onChange(event.target.value)} rows={rows} placeholder={placeholder} className={className} />
    </>
  );
}
