"use client";

import FieldLabel from "../ui/FieldLabel";
import { FULL_INPUT_CLS } from "../ui/inputClasses";

export default function ClientEventDescriptionField({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return <div>
    <FieldLabel htmlFor={id}>Client-facing description</FieldLabel>
    <textarea id={id} value={value} onChange={(event) => onChange(event.target.value)} rows={3} className={FULL_INPUT_CLS} maxLength={2000} />
    <p className="mt-1 text-xs text-on-surface-muted">Clients see this description. Notes stay internal.</p>
  </div>;
}
