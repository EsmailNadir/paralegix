"use client";

import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import Button from "@/components/ui/Button";

/**
 * What an `/admin` page renders when the signed-in user is not an admin.
 *
 * The eight admin pages each carried this screen, 150 lines of identical
 * markup between them. It is deliberately NOT `ui/AccessDeniedPage`: that one
 * renders `StatusPage` inside the firm shell, and `/admin` is a separate
 * surface with its own full-page chrome.
 *
 * Seven pages name the setting that grants access, since the reader is a
 * developer who can go and set it. The firm detail page says only that access
 * is missing, and passes its own `description` to keep saying that.
 */
export default function AdminAccessRequired({
  description,
  onBack,
}: {
  description?: ReactNode;
  onBack: () => void;
}) {
  return (
    <div className="min-h-screen bg-page p-6 md:p-10">
      <div className="max-w-2xl mx-auto bg-surface rounded-2xl border border-outline-subtle p-8 text-center shadow-sm">
        <div className="w-14 h-14 rounded-2xl bg-red-50 dark:bg-red-900/30 mx-auto flex items-center justify-center mb-5">
          <ShieldAlert className="w-7 h-7 text-red-600 dark:text-red-400" />
        </div>
        <h1 className="text-xl font-bold text-on-surface mb-2">Admin Access Required</h1>
        <p className="text-sm text-on-surface-secondary mb-6">
          {description ?? (
            <>
              Your account does not have admin access. Ask an existing admin to set
              <code className="mx-1">isAdmin: true</code>
              on your user record.
            </>
          )}
        </p>
        <Button type="secondary" onClick={onBack}>
          Back to Dashboard
        </Button>
      </div>
    </div>
  );
}
