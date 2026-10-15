import type { ComponentProps, ReactNode } from "react";
import { FULL_INPUT_CLS, FIELD_LABEL_BLOCK_CLS } from "@/components/ui/inputClasses";

/** Native input attributes stay explicit because directory and roster forms use different limits. */
export default function ContactIdentityField({ label, ...input }: Omit<ComponentProps<"input">, "className"> & { label: ReactNode }) {
  return <>
    <label htmlFor={input.id} className={FIELD_LABEL_BLOCK_CLS}>{label}</label>
    <input {...input} className={FULL_INPUT_CLS} />
  </>;
}
