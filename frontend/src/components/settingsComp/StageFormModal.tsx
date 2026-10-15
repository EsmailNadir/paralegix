"use client";

import { useId, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import ToggleSwitch from "@/components/ui/ToggleSwitch";
import ColorSwatchPicker from "@/components/ui/ColorSwatchPicker";
import ErrorNotification from "@/components/ErrorNotification";
import useSeedOnOpen from "@/hooks/useSeedOnOpen";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { FIELD_LABEL_BLOCK_CLS, FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { STAGE_COLORS } from "@/constants/stageColors";

interface StageFormValues {
  name: string;
  color: string | null;
  isClosed: boolean;
}

interface StageFormModalProps<T extends StageFormValues> {
  open: boolean;
  onClose: () => void;
  editing: boolean;
  initialValues: T;
  seedKey: string;
  onSubmit: (values: T) => Promise<unknown>;
  namePlaceholder: string;
  closedDescription: string;
  renderScope?: (values: T, onChange: (values: T) => void) => ReactNode;
  stacked?: boolean;
  bodyClassName?: string;
}

/** Shared stage editor; wrappers supply scope controls and domain save payloads. */
export default function StageFormModal<T extends StageFormValues>({
  open, onClose, editing, initialValues, seedKey, onSubmit, namePlaceholder,
  closedDescription, renderScope, stacked, bodyClassName,
}: StageFormModalProps<T>) {
  const nameId = useId();
  const [values, setValues] = useState(initialValues);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useSeedOnOpen(open, () => {
    setValues(initialValues);
    setError(null);
    setSubmitting(false);
  }, seedKey);

  const handleSubmit = async () => {
    if (!values.name.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ ...values, name: values.name.trim(), color: values.color || null });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={editing ? "Edit stage" : "New stage"}
      closeIcon={<X size={18} />}
      size="md"
      stacked={stacked}
      dismissible={!submitting}
      bodyClassName={bodyClassName}
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="primary" onClick={handleSubmit} loading={submitting} disabled={submitting || !values.name.trim()}>
            {editing ? "Save changes" : "Create stage"}
          </Button>
        </>
      }
    >
      <ErrorNotification error={error ? getErrorMessage(error) : null} onClose={() => setError(null)} />
      <div>
        <label className={FIELD_LABEL_BLOCK_CLS} htmlFor={nameId}>Name *</label>
        <input
          id={nameId}
          type="text"
          value={values.name}
          onChange={(event) => setValues({ ...values, name: event.target.value })}
          placeholder={namePlaceholder}
          className={FULL_INPUT_CLS}
          autoFocus
        />
      </div>
      {renderScope?.(values, setValues)}
      <div>
        <label className={FIELD_LABEL_BLOCK_CLS}>Color</label>
        <ColorSwatchPicker colors={STAGE_COLORS} value={values.color} onChange={(color) => setValues({ ...values, color })} />
      </div>
      <div className="flex items-center justify-between rounded-md border border-outline bg-surface-alt px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm font-medium text-on-surface">Closed stage</div>
          <div className="text-xs text-on-surface-secondary">{closedDescription}</div>
        </div>
        <ToggleSwitch checked={values.isClosed} onChange={() => setValues({ ...values, isClosed: !values.isClosed })} ariaLabel="Closed stage" />
      </div>
    </Modal>
  );
}
