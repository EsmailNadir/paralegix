"use client";

import { Search } from "lucide-react";
import { FIELD_CLS, FIELD_LABEL_CLS, INPUT_CLS } from "@/components/ui/inputClasses";

/** Search control for the paged account and client directories in the admin console. */
export default function AdminDirectorySearch({ id, value, onChange, placeholder }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return <div className={`${FIELD_CLS} flex-1 min-w-[220px]`}>
    <label className={FIELD_LABEL_CLS} htmlFor={id}>Search</label>
    <div className="relative">
      <Search className="w-4 h-4 text-on-surface-muted absolute left-3 top-1/2 -translate-y-1/2" />
      <input id={id} type="text" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} className={`${INPUT_CLS} w-full pl-9`} />
    </div>
  </div>;
}
