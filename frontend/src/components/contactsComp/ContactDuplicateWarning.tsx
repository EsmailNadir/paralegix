import ContactCategoryBadge from "@/components/ui/ContactCategoryBadge";
import type { Contact } from "@/types";

export default function ContactDuplicateWarning({ duplicates, onUseExisting }: {
  duplicates: Contact[];
  onUseExisting?: (contact: Contact) => void;
}) {
  return duplicates.length > 0 ? (
    <div className="mt-1.5 rounded-md border border-amber-200 dark:border-amber-800/40 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-2">
      <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
        {duplicates.length === 1
          ? "A contact with this name or email already exists. You can still continue."
          : "Contacts with this name or email already exist. You can still continue."}
      </p>
      <div className="space-y-1.5">
        {duplicates.map((dupe) => (
          <div key={dupe.id} className="flex items-center justify-between gap-2 min-w-0">
            <div className="min-w-0">
              <p className="text-xs font-medium text-on-surface truncate">{dupe.name}</p>
              <p className="text-[11px] text-on-surface-secondary truncate">
                {dupe.organization || dupe.email || "No other details"}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <ContactCategoryBadge category={dupe.category} />
              {onUseExisting && (
                <button
                  type="button"
                  onClick={() => onUseExisting(dupe)}
                  className="text-xs font-medium text-accent-emphasis hover:underline cursor-pointer"
                >
                  Use this one
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  ) : null;
}
