import type { ComponentProps, ReactNode } from "react";
import DatePicker from "@/components/ui/DatePicker";
import HoursMinutesInput from "@/components/ui/HoursMinutesInput";
import { hmToHours } from "@/lib/utils/format";

/** Callers retain their own duration limits; note entries cap a day locally. */
export function timeEntryDuration(hours: string, minutes: string, maxHours?: number) {
  const total = hmToHours(hours, minutes);
  return { total, valid: total > 0 && (maxHours === undefined || total <= maxHours) };
}

export function TimeDurationField({ label, ...input }: ComponentProps<typeof HoursMinutesInput> & { label: ReactNode }) {
  return <div>{label}<HoursMinutesInput {...input} /></div>;
}

export function TimeDateField({ label, ...input }: ComponentProps<typeof DatePicker> & { label: ReactNode }) {
  return <div>{label}<DatePicker {...input} /></div>;
}
