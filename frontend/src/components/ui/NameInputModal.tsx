"use client";

import { useId } from "react";
import type { ReactNode } from "react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import FieldError from "@/components/ui/FieldError";
import ErrorNotification from "@/components/ErrorNotification";
import FieldLabel from "@/components/ui/FieldLabel";
import TextInput from "@/components/ui/TextInput";

export interface NameInputModalNameField {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Per-field validation message, shown beneath the input via `FieldError`. */
  error?: string | null;
  autoFocus?: boolean;
}

interface NameInputModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Secondary line under the title (only the "md" size uses this). */
  contextLabel?: ReactNode;
  /**
   * "sm" = px-5 padding, h3/text-base heading, small buttons - the files-modal
   * family (Create/Rename/Color folder). "md" = px-6 padding, h2/text-lg
   * heading, default-size buttons, optional `contextLabel` - the
   * template-folder family. Defaults to "sm".
   */
  size?: "sm" | "md";
  /** Give the body a `max-h-[85vh]` scroll area (CreateFolderModal only). */
  scrollableBody?: boolean;
  /** Omit entirely for a modal with no name input (e.g. a color-only prompt). */
  nameField?: NameInputModalNameField;
  /** Extra body content rendered after the name field, such as a color picker. */
  extra?: ReactNode;
  error: string | null;
  onDismissError: () => void;
  submitting: boolean;
  submitLabel: string;
  submitDisabled?: boolean;
  onSubmit: () => void;
}

/**
 * Shared shell for the "prompt for a name" family of dialogs: a title bar, an
 * optional single text field, an optional extra field (a color picker today),
 * and a footer with an `ErrorNotification` plus Cancel/primary `Button`.
 *
 * Built on `Modal`, which owns the overlay, focus trap, Escape and the
 * open/close animation. Callers own their state and submit/validation logic;
 * this component renders the shared markup so every "name this thing" modal
 * stays pixel-identical instead of drifting.
 */
export default function NameInputModal({
  open,
  onClose,
  title,
  contextLabel,
  size = "sm",
  scrollableBody = false,
  nameField,
  extra,
  error,
  onDismissError,
  submitting,
  submitLabel,
  submitDisabled = false,
  onSubmit,
}: NameInputModalProps) {
  const nameFieldId = useId();
  const titleId = useId();
  const isMd = size === "md";
  const buttonSize = isMd ? undefined : "small";

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      size="md"
      height={scrollableBody ? "auto" : "none"}
      labelledBy={titleId}
      showClose={false}
      bodyClassName={null}
    >
      <div className={isMd ? "shrink-0 border-b border-outline px-6 py-4" : "border-b border-outline px-5 py-4"}>
        {isMd ? (
          <h2 id={titleId} className="text-lg font-semibold text-on-surface">
            {title}
          </h2>
        ) : (
          <h3 id={titleId} className="text-base font-semibold text-on-surface">
            {title}
          </h3>
        )}
        {contextLabel && <p className="mt-1 text-xs text-on-surface-muted">{contextLabel}</p>}
      </div>

      <div
        className={`${isMd ? "px-6 py-5" : "px-5 py-4"} ${
          scrollableBody ? "overflow-y-auto styled-scrollbar" : ""
        } space-y-4`}
      >
        <ErrorNotification error={error} onClose={onDismissError} compact />

        {nameField && (
          <div>
            <FieldLabel htmlFor={nameFieldId}>
              {nameField.label}
            </FieldLabel>
            <TextInput
              id={nameFieldId}
              type="text"
              value={nameField.value}
              autoFocus={nameField.autoFocus ?? true}
              onChange={(e) => nameField.onChange(e.target.value)}
              onKeyDown={(e) => {
                // Enter stands in for the primary button, so it is off
                // whenever that button is.
                if (e.key === "Enter" && !submitting && !submitDisabled) onSubmit();
              }}
              placeholder={nameField.placeholder}
            />
            <FieldError message={nameField.error ?? null} />
          </div>
        )}
        {extra}
      </div>

      <div
        className={
          isMd
            ? "flex flex-col gap-3 rounded-b-lg border-t border-outline bg-surface-alt px-6 py-4 shrink-0"
            : "border-t border-outline bg-surface-alt px-5 py-3 flex flex-col gap-3"
        }
      >
        <div className={isMd ? "flex items-center justify-end gap-2" : "flex justify-end gap-2"}>
          <Button onClick={onClose} type="secondary" size={buttonSize}>
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            type="primary"
            size={buttonSize}
            loading={submitting}
            disabled={submitDisabled}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
