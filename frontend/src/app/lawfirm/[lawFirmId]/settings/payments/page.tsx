'use client';

import { useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { CreditCard, ExternalLink, CheckCircle, AlertCircle } from 'lucide-react';
import { usePermissions } from '@/contexts/PermissionsContext';
import ErrorNotification from '@/components/ErrorNotification';
import ConfirmModal from '@/components/ui/ConfirmModal';
import Spinner from '@/components/ui/Spinner';
import PanelLoadingSpinner from '@/components/ui/PanelLoadingSpinner';
import useStripeConnect from '@/hooks/useStripeConnect';
import OnlinePaymentFeesSettings from '@/components/billingComp/OnlinePaymentFeesSettings';
import { PAYMENTS_HOW_IT_WORKS_PAY_STEP } from '@/lib/payments/cardFeeCopy';

export default function PaymentsSettingsPage() {
  const { hasPermission } = usePermissions();
  // The Stripe status and card fee reads both require billing.viewInvoices,
  // which the settings baseline does not carry. Without it the page explains
  // itself rather than mounting the reads and showing their refusal.
  if (!hasPermission('billing.viewInvoices')) {
    return (
      <div className="px-6 py-6">
        <div className="rounded-lg border border-outline bg-surface-alt px-4 py-3 text-sm text-on-surface-secondary">
          You need billing access to view payment settings.
        </div>
      </div>
    );
  }
  return <PaymentsSettingsContent />;
}

function PaymentsSettingsContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const lawFirmId = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);
  const { hasPermission } = usePermissions();
  // Every action below (connect, view the Stripe dashboard, disconnect) hits a
  // backend route gated on `settings.manageFirm`
  // (`backend/src/modules/stripe/stripe.routes.ts`) - firm administration, not
  // the `settings.viewFirm` baseline every member holds just to reach this tab.
  const canManage = hasPermission('settings.manageFirm');

  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const stripeParam = searchParams?.get('stripe');

  const {
    status, loading, error, setError,
    connecting, openingDashboard, disconnecting,
    connect: handleConnect,
    openDashboard: handleViewDashboard,
    disconnect,
  } = useStripeConnect(
    { kind: 'firm', lawFirmId },
    // Coming back from Stripe, the status on screen is the one read before the
    // firm ever left, so the return has to re-read it.
    { refreshKey: stripeParam, loadErrorMessage: 'Failed to load payment settings' },
  );

  const handleDisconnect = async () => {
    // The confirmation closes only on success, so a failure leaves the dialog
    // up with the reason on it rather than dismissing itself silently.
    if (await disconnect()) setConfirmDisconnect(false);
  };

  if (loading) {
    return <PanelLoadingSpinner label="Loading payments" />;
  }

  return (
    <div className="px-6 py-6 space-y-6">
      {error && <ErrorNotification error={error} onClose={() => setError(null)} />}

      {/* Return from Stripe onboarding */}
      {stripeParam === 'return' && status?.onboardingComplete && (
        <div className="bg-emerald-50 dark:bg-emerald-500/10 rounded-xl border border-emerald-200 dark:border-emerald-500/20 p-4 flex items-center gap-3">
          <CheckCircle className="w-5 h-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
            Stripe account connected successfully. You can now request online payments on invoices.
          </p>
        </div>
      )}

      {stripeParam === 'refresh' && (
        <div className="bg-amber-50 dark:bg-amber-500/10 rounded-xl border border-amber-200 dark:border-amber-500/20 p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
            Stripe onboarding session expired. Please click &quot;Connect Stripe Account&quot; to continue.
          </p>
        </div>
      )}

      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-on-surface">Online Payments</h2>
        <p className="text-sm text-on-surface-secondary mt-1">
          Connect your Stripe account to collect invoice payments online from clients.
        </p>
      </div>

      {/* Status Card */}
      <div className="rounded-xl border border-outline-subtle p-5 space-y-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
              status?.connected && status?.chargesEnabled
                ? 'bg-emerald-100 dark:bg-emerald-500/15'
                : 'bg-surface-alt'
            }`}>
              <CreditCard className={`w-5 h-5 ${
                status?.connected && status?.chargesEnabled
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-on-surface-muted'
              }`} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-on-surface">Stripe Account</h3>
              {status?.connected ? (
                <div className="flex items-center gap-2 mt-0.5">
                  {status.chargesEnabled ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                      <CheckCircle className="w-3 h-3" />
                      Connected &amp; Active
                    </span>
                  ) : status.onboardingComplete ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                      <AlertCircle className="w-3 h-3" />
                      Pending Verification
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                      <AlertCircle className="w-3 h-3" />
                      Onboarding Incomplete
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-xs text-on-surface-muted mt-0.5">Not connected</p>
              )}
            </div>
          </div>
        </div>

        {status?.connected && (
          <div className="grid grid-cols-2 gap-3 pt-2">
            <div className="rounded-lg bg-surface-alt p-3">
              <p className="text-[10px] uppercase tracking-wider text-on-surface-muted font-medium">Charges</p>
              <p className={`text-sm font-semibold mt-1 ${
                status.chargesEnabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
              }`}>
                {status.chargesEnabled ? 'Enabled' : 'Not Ready'}
              </p>
            </div>
            <div className="rounded-lg bg-surface-alt p-3">
              <p className="text-[10px] uppercase tracking-wider text-on-surface-muted font-medium">Payouts</p>
              <p className={`text-sm font-semibold mt-1 ${
                status.payoutsEnabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
              }`}>
                {status.payoutsEnabled ? 'Enabled' : 'Not Ready'}
              </p>
            </div>
          </div>
        )}

        {/* Actions */}
        {canManage && (
        <div className="flex items-center gap-3 pt-2">
          {!status?.connected ? (
            <button
              onClick={handleConnect}
              disabled={connecting}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-accent-solid hover:bg-accent-solid-hover text-accent-foreground text-sm font-semibold rounded-xl shadow-sm transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 cursor-pointer"
            >
              {connecting ? (
                <Spinner size={16} />
              ) : (
                <CreditCard className="w-4 h-4" />
              )}
              {connecting ? 'Setting up...' : 'Connect Stripe Account'}
            </button>
          ) : !status.onboardingComplete ? (
            <button
              onClick={handleConnect}
              disabled={connecting}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-accent-solid hover:bg-accent-solid-hover text-accent-foreground text-sm font-semibold rounded-xl shadow-sm transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 cursor-pointer"
            >
              {connecting ? (
                <Spinner size={16} />
              ) : (
                <CreditCard className="w-4 h-4" />
              )}
              {connecting ? 'Setting up...' : 'Complete Onboarding'}
            </button>
          ) : (
            <>
              <button
                onClick={handleViewDashboard}
                disabled={openingDashboard}
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-surface hover:bg-surface-hover text-on-surface text-sm font-medium rounded-xl border border-outline-subtle transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {openingDashboard
                  ? <Spinner size={16} />
                  : <ExternalLink className="w-4 h-4" />}
                {openingDashboard ? 'Opening...' : 'View Stripe Dashboard'}
              </button>
              <button
                onClick={() => setConfirmDisconnect(true)}
                disabled={disconnecting}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 text-sm font-medium rounded-xl border border-red-200 dark:border-red-500/20 transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 cursor-pointer"
              >
                {disconnecting ? <Spinner size={16} /> : <CreditCard className="w-4 h-4" />}
                {disconnecting ? 'Disconnecting...' : 'Disconnect'}
              </button>
            </>
          )}
        </div>
        )}
      </div>

      <OnlinePaymentFeesSettings lawFirmId={lawFirmId} canEdit={canManage} />

      {/* Info Section */}
      <div className="rounded-xl border border-outline-subtle p-5 space-y-3">
        <h3 className="text-sm font-semibold text-on-surface">How it works</h3>
        <ul className="text-sm text-on-surface-secondary space-y-2">
          <li className="flex items-start gap-2">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent-soft dark:bg-accent-soft text-accent-emphasis text-[10px] font-bold flex-shrink-0 mt-0.5">1</span>
            Connect your Stripe account above to enable online payments.
          </li>
          <li className="flex items-start gap-2">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent-soft dark:bg-accent-soft text-accent-emphasis text-[10px] font-bold flex-shrink-0 mt-0.5">2</span>
            On any invoice, click &quot;Request Payment via Stripe&quot; to send a payment request to the client.
          </li>
          <li className="flex items-start gap-2">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent-soft dark:bg-accent-soft text-accent-emphasis text-[10px] font-bold flex-shrink-0 mt-0.5">3</span>
            {PAYMENTS_HOW_IT_WORKS_PAY_STEP}
          </li>
          <li className="flex items-start gap-2">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent-soft dark:bg-accent-soft text-accent-emphasis text-[10px] font-bold flex-shrink-0 mt-0.5">4</span>
            Payments are deposited directly into your connected Stripe account.
          </li>
        </ul>
      </div>

      <ConfirmModal
        isOpen={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={handleDisconnect}
        title="Disconnect Stripe"
        message="Are you sure you want to disconnect your Stripe account? You can reconnect later."
        confirmText="Disconnect"
        confirmType="danger"
        loading={disconnecting}
      />
    </div>
  );
}
