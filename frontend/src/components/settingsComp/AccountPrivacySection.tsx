"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import SuccessNotification from "@/components/SuccessNotification";
import Button from "@/components/ui/Button";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import AuthService from "@/services/auth.service";
import privacyService from "@/services/privacy.service";
import { downloadJson } from "@/lib/utils/csv";
import { isApiError } from "@/lib/utils/apiErrors";
import { openCookieSettings } from "@/lib/analytics/consent";
import useFormFeedback from "@/hooks/useFormFeedback";

/**
 * Self-contained data-subject-rights card: export a copy of the caller's personal
 * data (GDPR Art. 15/20) and erase the account (Art. 17). Acts only on the signed-in
 * user through firm-independent endpoints, so it drops into any settings page - 
 * firm member, client portal, or the standalone account route.
 */
export default function AccountPrivacySection() {
  const router = useRouter();
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const { errorMessage: error, setErrorMessage: setError, feedbackRef } = useFormFeedback();
  const exportRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const lastActionRef = useRef<HTMLButtonElement | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (success && !exporting) exportRef.current?.focus();
  }, [success, exporting]);

  const handleExport = async () => {
    lastActionRef.current = exportRef.current;
    try {
      setExporting(true);
      setError('');
      setSuccess(null);
      const data = await privacyService.exportMyData();
      downloadJson("paralegix-my-data.json", data);
      setSuccess("Your data export has been downloaded.");
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to export your data");
    } finally {
      setExporting(false);
    }
  };

  const handleDelete = async () => {
    lastActionRef.current = deleteRef.current;
    setDeleting(true);
    setError('');
    setSuccess(null);

    // Only the erase call itself can fail in a way the user needs to act on
    // (e.g. transfer/delete owned firms first). Everything after it resolves
    // is best-effort cleanup, handled outside this try/catch - see below.
    try {
      await privacyService.eraseMyAccount();
    } catch (e) {
      setShowDeleteModal(false);
      // A firm owner cannot self-erase. Surface the backend's instruction to
      // transfer or delete owned firms first instead of signing them out.
      if (isApiError(e) && e.status === 403) {
        setError(e.message);
      } else {
        setError(e instanceof Error ? e.message : "Failed to delete your account");
      }
      setDeleting(false);
      return;
    }

    setShowDeleteModal(false);

    // By the time eraseMyAccount() resolves, the backend has already anonymized
    // the account and closed application access. Provider cleanup may still
    // be pending and will retry through housekeeping. So sign-out/redirect are not treated as
    // failures: reporting "failed to delete" here would be wrong (the deletion
    // already succeeded), and re-enabling the button would invite a retry
    // against a user that no longer exists. Swallow a sign-out error and
    // navigate away regardless.
    try {
      await AuthService.signOutUser();
    } catch {
      // Best-effort only; the account is already erased either way.
    }
    // `deleting` intentionally stays true here - never reset on this path - 
    // so the button stays disabled (can't be double-clicked) while we navigate away.
    router.push("/");
  };

  return (
    <div className="bg-surface rounded-2xl border border-outline-subtle p-5">
      <p className="text-sm font-medium text-on-surface">Privacy &amp; Your Data</p>
      <p className="text-xs text-on-surface-muted mt-1">
        Export a copy of your personal data, choose whether we collect product analytics, or
        permanently delete your account.
      </p>

      <div ref={feedbackRef} tabIndex={-1} className="mt-3">
        <ErrorNotification error={error} onClose={() => { setError(''); lastActionRef.current?.focus(); }} compact />
      </div>

      <SuccessNotification message={success} className="mt-3" />
      <p role="status" className="sr-only">{exporting ? 'Exporting your data...' : deleting ? 'Deleting your account...' : ''}</p>

      <div className="mt-4 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-on-surface">Export My Data</div>
          <div className="text-xs text-on-surface-muted mt-1">
            Download a machine-readable copy of the personal data we hold about you.
          </div>
        </div>
        <Button
          ref={exportRef}
          type="secondary"
          size="small"
          onClick={handleExport}
          loading={exporting}
          icon={<Download size={14} />}
          className="w-full md:w-auto shrink-0"
        >
          Export My Data
        </Button>
      </div>

      <div className="mt-4 pt-4 border-t border-outline-subtle flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-on-surface">Product Analytics</div>
          <div className="text-xs text-on-surface-muted mt-1">
            Accept or decline the product analytics we collect in this browser.
          </div>
        </div>
        <Button
          type="secondary"
          size="small"
          onClick={openCookieSettings}
          className="w-full md:w-auto shrink-0"
        >
          Cookie settings
        </Button>
      </div>

      <div className="mt-4 pt-4 border-t border-outline-subtle flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-red-600 dark:text-red-400">Delete My Account</div>
          <div className="text-xs mt-1 text-red-500 dark:text-red-400/70">
            Permanently erase your account and personal data. This cannot be undone.
          </div>
        </div>
        <Button
          type="secondary"
          size="small"
          onClick={() => setShowDeleteModal(true)}
          ref={deleteRef}
          disabled={deleting}
          className="w-full md:w-auto shrink-0 text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-500/30 dark:hover:bg-red-500/10"
        >
          Delete My Account
        </Button>
      </div>

      <ConfirmModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={handleDelete}
        loading={deleting}
        title="Delete My Account"
        message="This permanently erases your account and personal data, and signs you out. This action cannot be undone."
        confirmText="Delete My Account"
      />
    </div>
  );
}
