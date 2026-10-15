"use client";

import { Building2, User, ChevronRight } from "lucide-react";
import type { ClientPortalAssociation } from "@/contexts/ClientPortalContext";

interface ClientRecordPickerProps {
  associations: ClientPortalAssociation[];
  onSelect: (clientRecordId: string) => void;
}

/**
 * The portal's CLIENT_SELECTION_REQUIRED state: a uid with more than one
 * client-record association in this firm (a personal client record and/or one
 * or more company roster links, e.g. Pat in the acceptance identities) has not
 * yet picked which one to view. Rendered by a page in place of its normal
 * content instead of attempting a fetch the backend would just 400.
 */
export default function ClientRecordPicker({ associations, onSelect }: ClientRecordPickerProps) {
  return (
    <div className="p-8">
      <div className="max-w-lg mx-auto mt-16">
        <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-8 text-center">
          <div className="mx-auto w-16 h-16 bg-accent-soft dark:bg-accent-soft rounded-2xl flex items-center justify-center mb-5">
            <Building2 className="w-7 h-7 text-accent-emphasis" />
          </div>

          <h1 className="text-xl font-bold text-on-surface mb-2">Choose an account</h1>
          <p className="text-sm text-on-surface-secondary mb-6 leading-relaxed">
            You have access to more than one client account with this law firm. Select which one you&apos;d like to view.
          </p>

          <div className="space-y-2 text-left">
            {associations.map((association) => {
              const Icon = association.clientType === "company" ? Building2 : User;
              return (
                <button
                  key={association.clientRecordId}
                  onClick={() => {
                    onSelect(association.clientRecordId);
                    queueMicrotask(() => document.getElementById('main-content')?.focus());
                  }}
                  className="w-full flex items-center gap-3 rounded-xl border border-outline-subtle bg-surface-alt hover:bg-surface-hover px-4 py-3 text-left transition-colors cursor-pointer active:scale-[0.98] motion-reduce:active:scale-100"
                >
                  <div className="w-9 h-9 rounded-xl bg-accent-soft dark:bg-accent-soft text-accent-emphasis flex items-center justify-center flex-shrink-0">
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-on-surface truncate">{association.clientName}</p>
                    <p className="text-[11px] text-on-surface-muted mt-0.5">
                      {association.clientType === "company" ? "Organization" : "Personal account"}
                    </p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-on-surface-muted flex-shrink-0" />
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
