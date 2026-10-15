"use client";

import { useId, useState } from "react";
import dayjs from "dayjs";
import Button from "@/components/ui/Button";
import billingService from "@/services/billing.service";
import DatePicker from "@/components/ui/DatePicker";
import Dropdown from "@/components/ui/Dropdown";
import EntityPicker from "@/components/ui/EntityPicker";
import ErrorNotification from "@/components/ErrorNotification";
import Modal from "@/components/ui/Modal";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import type { ExpenseCategoryConfig } from "@/types";
import Checkbox from "@/components/ui/Checkbox";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import FieldLabel from "@/components/ui/FieldLabel";

type TargetType = "matter" | "client";
type TargetValue = `matter:${string}` | `client:${string}`;

const TARGET_TYPE_OPTIONS = [
  { value: "matter", label: "Matter" },
  { value: "client", label: "Client" },
];

const FALLBACK_CATEGORIES: { value: string; label: string }[] = [
  { value: "court_fees", label: "Court Fees" },
  { value: "filing_fees", label: "Filing Fees" },
  { value: "travel", label: "Travel" },
  { value: "expert_witness", label: "Expert Witness" },
  { value: "postage", label: "Postage" },
  { value: "copying", label: "Copying" },
  { value: "service_of_process", label: "Service of Process" },
  { value: "other", label: "Other" },
];

interface AddExpenseModalProps {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  /** Firm-configurable expense categories; falls back to built-in list if empty */
  expenseCategories?: ExpenseCategoryConfig[];
  onSuccess: () => void;
}

export default function AddExpenseModal({
  open,
  onClose,
  lawFirmId,
  expenseCategories,
  onSuccess,
}: AddExpenseModalProps) {
  const fieldIds = useId();
  // The expense is filed against one matter or one client. The type picker
  // chooses which entity is being searched; the id combines with it into the
  // `matter:<id>` / `client:<id>` value the save handler splits apart.
  const [targetType, setTargetType] = useState<TargetType>("matter");
  const [targetId, setTargetId] = useState("");
  const selectedTarget: TargetValue | "" = targetId ? `${targetType}:${targetId}` : "";
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(dayjs().format("YYYY-MM-DD"));
  const [selectedCategoryId, setSelectedCategoryId] = useState("");

  const categoryOptions = expenseCategories && expenseCategories.length > 0
    ? expenseCategories.map((cat) => ({ value: cat.id, label: `${cat.code} - ${cat.name}` }))
    : FALLBACK_CATEGORIES;
  const [vendor, setVendor] = useState("");
  const [billable, setBillable] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleClose() {
    if (!saving) onClose();
  }

  useResetAfterClose(open, () => {
    setTargetType("matter");
    setTargetId("");
    setDescription("");
    setAmount("");
    setDate(dayjs().format("YYYY-MM-DD"));
    setSelectedCategoryId("");
    setVendor("");
    setBillable(true);
    setError(null);
  });

  async function handleSave() {
    if (!selectedTarget) { setError("Select a matter or client."); return; }
    if (!description.trim()) { setError("Enter a description."); return; }
    const parsedAmount = parseFloat(amount);
    if (!amount || isNaN(parsedAmount) || parsedAmount <= 0) { setError("Enter a valid amount."); return; }

    const [type, entityId] = selectedTarget.split(":") as ["matter" | "client", string];
    const context = type === "matter"
      ? { type: "matter" as const, lawFirmId, entityId }
      : { type: "client" as const, lawFirmId, entityId };

    setSaving(true);
    setError(null);
    try {
      // Resolve category: if using firm categories, send expenseCategoryId; otherwise legacy category string
      const isUsingFirmCategories = expenseCategories && expenseCategories.length > 0;
      const categoryPayload = isUsingFirmCategories
        ? { expenseCategoryId: selectedCategoryId || null, category: expenseCategories.find(c => c.id === selectedCategoryId)?.code || 'other' }
        : { category: selectedCategoryId || 'other' };

      await billingService.addExpense(context, {
        description: description.trim(),
        amount: parsedAmount,
        // Day-only: send the raw YYYY-MM-DD. toISOString() would reinterpret it as
        // local midnight and shift the stored date a day for UTC+ users.
        date,
        ...categoryPayload,
        vendor: vendor.trim(),
        billable,
      });
      onClose();
      onSuccess();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to add expense"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      isOpen={open}
      onClose={handleClose}
      dismissible={!saving}
      title="Add Expense"
      subtitle="Track an expense for a matter or client."
      size="md"
      footer={
        <>
          <Button type="secondary" onClick={handleClose} disabled={saving}>Cancel</Button>
          <Button
            type="primary"
            onClick={handleSave}
            loading={saving}
            disabled={saving || !selectedTarget || !description.trim() || !amount}
          >
            Save Expense
          </Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} compact />

      <div className="grid grid-cols-2 gap-4">
        <Dropdown
          label="Bill To"
          value={targetType}
          onChange={(value) => {
            setTargetType(value as TargetType);
            setTargetId("");
          }}
          options={TARGET_TYPE_OPTIONS}
          portal
        />
        <EntityPicker
          key={targetType}
          entity={targetType === "matter" ? "matters" : "clients"}
          lawFirmId={lawFirmId}
          label={targetType === "matter" ? "Matter *" : "Client *"}
          value={targetId}
          onChange={setTargetId}
          emptyOption={{ label: targetType === "matter" ? "Select a matter..." : "Select a client...", value: "" }}
          placeholder={targetType === "matter" ? "Select a matter..." : "Select a client..."}
          portal
        />
      </div>

      <div>
        <FieldLabel htmlFor={`${fieldIds}-description`}>Description *</FieldLabel>
        <input
          id={`${fieldIds}-description`}
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Court filing fee, Expert witness..."
          className="w-full border border-input-border rounded-md px-3 py-2 text-sm bg-input-bg text-on-surface"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <FieldLabel>Amount *</FieldLabel>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-muted pointer-events-none">$</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full pl-6 border border-input-border rounded-md px-3 py-2 text-sm bg-input-bg text-on-surface"
            />
          </div>
        </div>
        <div>
          <FieldLabel id={`${fieldIds}-date-label`}>Date</FieldLabel>
          <DatePicker
            ariaLabelledBy={`${fieldIds}-date-label`}
            value={date} onChange={setDate} className="w-full" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Dropdown
            label="Category"
            value={selectedCategoryId}
            onChange={setSelectedCategoryId}
            options={categoryOptions}
            placeholder="Select category"
            portal
          />
        </div>
        <div>
          <FieldLabel htmlFor={`${fieldIds}-vendor`}>Vendor</FieldLabel>
          <input
            id={`${fieldIds}-vendor`}
            type="text"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            placeholder="e.g. County Clerk"
            className="w-full border border-input-border rounded-md px-3 py-2 text-sm bg-input-bg text-on-surface"
          />
        </div>
      </div>

      <Checkbox checked={billable} onChange={setBillable} label="Billable expense" />
    </Modal>
  );
}
