"use client";

import MatterBillingFields from "./MatterBillingFields";
import { useCallback, useId, useState } from "react";
import Button from "@/components/ui/Button";

import Modal from "@/components/ui/Modal";
import ErrorNotification from "@/components/ErrorNotification";
import MattersService from "@/services/matters.service";
import type { Matter, MatterBillingMethod } from "@/types/matter";
import { getErrorMessage } from "@/lib/utils/apiErrors";

type Props = {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  matter: Matter;
  onAfter?: () => Promise<void> | void;
};

function getBudgetValue(matter: Matter): string {
  if (typeof matter.budget === "number") return String(matter.budget);
  if (typeof matter.budgetCents === "number") return String(matter.budgetCents / 100);
  return "";
}

export default function EditMatterBillingModal({
  open,
  onClose,
  lawFirmId,
  matter,
  onAfter,
}: Props) {
  const fieldIds = useId();
  const [billingMethod, setBillingMethod] = useState<MatterBillingMethod>(matter.billingMethod || "hourly");
  const [isBillable, setIsBillable] = useState(matter.isBillable !== false);
  const [budget, setBudget] = useState(getBudgetValue(matter));
  const [budgetIncludesExpenses, setBudgetIncludesExpenses] = useState(matter.budgetIncludesExpenses !== false);
  const [contingencyPercent, setContingencyPercent] = useState(
    matter.contingencyPercent != null ? String(matter.contingencyPercent) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    if (saving) return;
    onClose();
  }, [onClose, saving]);

  // Seeds the form from the matter as it is when the modal opens. The modal
  // stays mounted on the matter page, and the full Edit Matter modal can change
  // these same fields while it is closed; values kept from an earlier open would
  // be written back over that change on the next save.
  const [seededForOpen, setSeededForOpen] = useState(open);
  if (open && !seededForOpen) {
    setSeededForOpen(true);
    setBillingMethod(matter.billingMethod || "hourly");
    setIsBillable(matter.isBillable !== false);
    setBudget(getBudgetValue(matter));
    setBudgetIncludesExpenses(matter.budgetIncludesExpenses !== false);
    setContingencyPercent(matter.contingencyPercent != null ? String(matter.contingencyPercent) : "");
    setError(null);
  } else if (!open && seededForOpen) {
    setSeededForOpen(false);
  }

  const save = async () => {
    const parsedBudget = budget.trim() === "" ? null : Number(budget);
    if (parsedBudget !== null && (!Number.isFinite(parsedBudget) || parsedBudget < 0)) {
      setError("Enter a valid non-negative budget.");
      return;
    }

    const parsedContingency =
      billingMethod === "contingency" && contingencyPercent.trim() !== ""
        ? Number(contingencyPercent)
        : null;
    if (
      parsedContingency !== null &&
      (!Number.isFinite(parsedContingency) || parsedContingency < 0 || parsedContingency > 100)
    ) {
      setError("Contingency percentage must be between 0 and 100.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await MattersService.updateMatter({
        lawFirmId,
        matterId: matter.id,
        billingMethod,
        isBillable,
        budget: parsedBudget,
        budgetIncludesExpenses,
        contingencyPercent: parsedContingency,
      });
      await onAfter?.();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to update billing settings"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={close}
      title="Edit Billing"
      subtitle={`Update billing preferences for ${matter.name}.`}
      size="lg"
      dismissible={!saving}
      lockScroll
      bodyClassName="space-y-5 px-5 py-5 sm:px-6"
      footer={
        <>
          <Button type="secondary" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button type="primary" onClick={() => void save()} loading={saving}>
            Save Billing
          </Button>
        </>
      }
    >
      {error && <ErrorNotification error={error} onClose={() => setError(null)} compact />}

            <MatterBillingFields layout="stack" fieldIds={fieldIds} billingMethod={billingMethod} setBillingMethod={setBillingMethod}
                  budget={budget} setBudget={setBudget} contingencyPercent={contingencyPercent} setContingencyPercent={setContingencyPercent}
                  isBillable={isBillable} setIsBillable={setIsBillable} budgetIncludesExpenses={budgetIncludesExpenses} setBudgetIncludesExpenses={setBudgetIncludesExpenses} />
    </Modal>
  );
}
