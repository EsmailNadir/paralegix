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
import { getErrorMessage } from "@/lib/utils/apiErrors";
import FieldLabel from "@/components/ui/FieldLabel";

type TargetType = "matter" | "client";
type TargetValue = `matter:${string}` | `client:${string}`;

const TARGET_TYPE_OPTIONS = [
  { value: "matter", label: "Matter" },
  { value: "client", label: "Client" },
];

interface AddFlatFeeModalProps {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  onSuccess: () => void;
}

export default function AddFlatFeeModal({
  open,
  onClose,
  lawFirmId,
  onSuccess,
}: AddFlatFeeModalProps) {
  const fieldIds = useId();
  // The fee is filed against one matter or one client. The type picker chooses
  // which entity is being searched; the id combines with it into the
  // `matter:<id>` / `client:<id>` value the save handler splits apart.
  const [targetType, setTargetType] = useState<TargetType>("matter");
  const [targetId, setTargetId] = useState("");
  const selectedTarget: TargetValue | "" = targetId ? `${targetType}:${targetId}` : "";
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(dayjs().format("YYYY-MM-DD"));
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
      await billingService.addFlatFee(context, {
        description: description.trim(),
        amount: parsedAmount,
        // Day-only: send the raw YYYY-MM-DD. toISOString() would reinterpret it as
        // local midnight and shift the stored date a day for UTC+ users.
        date,
      });
      onClose();
      onSuccess();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to add flat fee"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      isOpen={open}
      onClose={handleClose}
      dismissible={!saving}
      title="Add Flat Fee"
      subtitle="Add a fixed-price charge to a matter or client."
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
            Save Flat Fee
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
          placeholder="e.g. Court filing fee, Expert witness retainer..."
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
    </Modal>
  );
}
