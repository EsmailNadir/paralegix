import type { ReactNode } from "react";
import Dropdown from "@/components/ui/Dropdown";
import TextInput from "@/components/ui/TextInput";
import FieldLabel from "@/components/ui/FieldLabel";
import Checkbox from "@/components/ui/Checkbox";
import type { MatterBillingMethod } from "@/types";

type Props = {
  fieldIds: string;
  layout: "grid" | "stack";
  billingMethod: string;
  setBillingMethod: (value: MatterBillingMethod) => void;
  budget: string;
  setBudget: (value: string) => void;
  contingencyPercent: string;
  setContingencyPercent: (value: string) => void;
  isBillable: boolean;
  setIsBillable: (value: boolean) => void;
  budgetIncludesExpenses: boolean;
  setBudgetIncludesExpenses: (value: boolean) => void;
  children?: ReactNode;
};

/** Validation and persistence stay with the form that owns these controlled fields. */
export default function MatterBillingFields({ fieldIds, layout, billingMethod, setBillingMethod,
  budget, setBudget, contingencyPercent, setContingencyPercent, isBillable, setIsBillable,
  budgetIncludesExpenses, setBudgetIncludesExpenses, children }: Props) {
  const fields = <>
    <Dropdown
      label="Billing Method"
      value={billingMethod}
      onChange={(value) => setBillingMethod(value as MatterBillingMethod)}
      options={[
        { label: "Hourly", value: "hourly" },
        { label: "Flat Fee", value: "flat" },
        { label: "Contingency", value: "contingency" },
        { label: "Pro Bono", value: "pro_bono" },
      ]}
      portal
    />
    {billingMethod === "contingency" && (
      <div>
        <FieldLabel htmlFor={`${fieldIds}-contingencypercent`}>Contingency %</FieldLabel>
        <TextInput
          id={`${fieldIds}-contingencypercent`}
          type="number" min={0} max={100} step="0.5"
          value={contingencyPercent}
          onChange={(e) => setContingencyPercent(e.target.value)}
          placeholder="e.g. 33.3"
        />
      </div>
    )}
    <div>
      <FieldLabel htmlFor={`${fieldIds}-${layout === "grid" && billingMethod === "contingency" ? "budget-usd" : "budget"}`}>Budget (USD)</FieldLabel>
      <TextInput
        id={`${fieldIds}-${layout === "grid" && billingMethod === "contingency" ? "budget-usd" : "budget"}`}
        type="number" min={0} step="100"
        value={budget}
        onChange={(e) => setBudget(e.target.value)}
        placeholder="e.g. 10000"
      />
      {layout === "stack" && <p className="mt-1 text-xs text-on-surface-muted">Leave blank for no budget.</p>}
    </div>

  </>;
  return <>
    {layout === "grid" ? <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{fields}{children}</div> : fields}
    <div className={layout === "grid" ? "flex flex-col gap-2" : "space-y-3 rounded-xl border border-outline bg-surface-alt/40 p-4"}>
      <Checkbox
        checked={isBillable}
        onChange={setIsBillable}
        label="This matter is billable"
      />
      {budget.trim() !== "" && (
        <Checkbox
          checked={budgetIncludesExpenses}
          onChange={setBudgetIncludesExpenses}
          label="Count expenses toward the budget"
        />
      )}
    </div>
  </>;
}
