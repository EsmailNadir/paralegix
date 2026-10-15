"use client";

import { useId } from "react";
import Dropdown from "@/components/ui/Dropdown";
import FieldLabel from "@/components/ui/FieldLabel";
import { INPUT_CLS } from "@/components/ui/inputClasses";

type CreditNoteType = "write_off" | "discount" | "adjustment";

interface CreditNoteFieldsProps {
  type: CreditNoteType;
  onTypeChange: (value: CreditNoteType) => void;
  amount: string;
  onAmountChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
}

/** Shared credit-note inputs; invoice dialogs retain their save and close behavior. */
export default function CreditNoteFields({
  type, onTypeChange, amount, onAmountChange, description, onDescriptionChange,
}: CreditNoteFieldsProps) {
  const fieldIds = useId();
  return (
    <>
      <div>
        <Dropdown
          label="Type"
          value={type}
          onChange={(value) => onTypeChange(value as CreditNoteType)}
          options={[
            { label: "Write Off", value: "write_off" },
            { label: "Discount", value: "discount" },
            { label: "Adjustment", value: "adjustment" },
          ]}
          portal
        />
      </div>
      <div>
        <FieldLabel htmlFor={`${fieldIds}-amount`}>Amount *</FieldLabel>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted">$</span>
          <input
            id={`${fieldIds}-amount`}
            type="number"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(event) => onAmountChange(event.target.value)}
            className={`${INPUT_CLS} w-full pl-7`}
            placeholder="0.00"
            autoFocus
          />
        </div>
      </div>
      <div>
        <FieldLabel htmlFor={`${fieldIds}-description`}>Description</FieldLabel>
        <input
          id={`${fieldIds}-description`}
          type="text"
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          className={`${INPUT_CLS} w-full`}
          placeholder="e.g. Courtesy discount, billing error adjustment"
        />
      </div>
    </>
  );
}
