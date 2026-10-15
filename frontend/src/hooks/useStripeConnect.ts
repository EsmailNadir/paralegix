"use client";

import { stripeStatusQueryKey } from "@/hooks/billingHooks/useStripeStatus";
import { QueryClientContext } from "@tanstack/react-query";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import billingService from "@/services/billing.service";
import { getErrorMessage } from "@/lib/utils/apiErrors";

/**
 * The Stripe Connect onboarding lifecycle, shared by the two surfaces that run it.
 *
 * A firm onboards a connected account twice, for different money: its operating
 * account, where client invoice payments settle, and one per trust account, so a
 * client can fund an IOLTA by bank transfer. The screens are deliberately
 * different (a settings card and a per-account row), but the lifecycle behind
 * them is the same four calls in the same order, with the same failure modes.
 *
 * It had been written twice. That is how one side gains a fix the other never
 * gets: a cleared error banner, a button that stays disabled through the
 * redirect, a re-fetch on the way back from Stripe. None of it looks wrong on
 * the screen that is missing it.
 *
 * `target` says which connected account, and nothing else. Everything a caller
 * renders stays with the caller.
 */

export interface StripeConnectStatus {
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingComplete: boolean;
  stripeAccountId?: string | null;
}

export type StripeConnectTarget =
  | { kind: "firm"; lawFirmId: string }
  | { kind: "trust"; lawFirmId: string; trustAccountId: string };

interface UseStripeConnectOptions {
  /** Any change re-fetches the status: a `?stripe=return`, a parent's refresh signal. */
  refreshKey?: number | string | null;
  /** Copy for the failure banner when the status itself cannot be read. */
  loadErrorMessage?: string;
}

export interface UseStripeConnectResult {
  status: StripeConnectStatus | null;
  loading: boolean;
  error: string | null;
  setError: (message: string | null) => void;
  /** Per-action, because each button renders its own progress label. */
  connecting: boolean;
  openingDashboard: boolean;
  disconnecting: boolean;
  /** True while any of the three is in flight, for callers with one shared flag. */
  busy: boolean;
  connect: () => Promise<void>;
  openDashboard: () => Promise<void>;
  /** Resolves true when the account was disconnected, so a caller can keep its
   *  confirmation open (with the error on it) when it was not. */
  disconnect: () => Promise<boolean>;
  refresh: () => Promise<void>;
}

export function useStripeConnect(
  target: StripeConnectTarget,
  { refreshKey = null, loadErrorMessage = "Failed to load connection status" }: UseStripeConnectOptions = {},
): UseStripeConnectResult {
  // Read the primitives out of `target`: it is a fresh object literal on every
  // render, so depending on it directly would re-fetch forever.
  const { kind, lawFirmId } = target;
  const trustAccountId = target.kind === "trust" ? target.trustAccountId : null;

  const [status, setStatus] = useState<StripeConnectStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [openingDashboard, setOpeningDashboard] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Only the latest status read may write. When the account changes while a
  // read is in flight, the earlier answer describes the previous account and
  // would otherwise replace the current one's status.
  const latestRefreshRef = useRef(0);

  // The invoice pages cache the firm's status (`useStripeStatus`). A fresh read
  // here, after a disconnect or a finished onboarding, replaces that cached
  // answer so an invoice never offers a payment request for an account that is
  // gone. Optional: a page without a query client simply has nothing to update.
  const queryClient = useContext(QueryClientContext);

  const refresh = useCallback(async () => {
    const requestId = ++latestRefreshRef.current;
    const isLatest = () => requestId === latestRefreshRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = kind === "trust"
        ? await billingService.getTrustConnectStatus(lawFirmId, trustAccountId as string)
        : await billingService.getFirmConnectStatus(lawFirmId);
      if (isLatest()) {
        setStatus(result);
        if (kind === "firm") queryClient?.setQueryData(stripeStatusQueryKey(lawFirmId), result);
      }
    } catch (err) {
      if (isLatest()) setError(getErrorMessage(err, loadErrorMessage));
    } finally {
      if (isLatest()) setLoading(false);
    }
  }, [kind, lawFirmId, trustAccountId, loadErrorMessage, queryClient]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: loads Stripe Connect status on mount and whenever refreshKey changes
    refresh();
  }, [refresh, refreshKey]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const { url } = kind === "trust"
        ? await billingService.createTrustConnectAccount(lawFirmId, trustAccountId as string)
        : await billingService.createFirmConnectAccount(lawFirmId);
      // Deliberately leaves `connecting` true: the browser is on its way to
      // Stripe, and re-enabling the button would invite a second onboarding
      // link during the redirect.
      window.location.href = url;
    } catch (err) {
      setError(getErrorMessage(err, "Failed to start onboarding"));
      setConnecting(false);
    }
  }, [kind, lawFirmId, trustAccountId]);

  const openDashboard = useCallback(async () => {
    setOpeningDashboard(true);
    setError(null);
    try {
      const { url } = kind === "trust"
        ? await billingService.getTrustConnectDashboardLink(lawFirmId, trustAccountId as string)
        : await billingService.getFirmConnectDashboardLink(lawFirmId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(getErrorMessage(err, "Failed to open Stripe dashboard"));
    } finally {
      setOpeningDashboard(false);
    }
  }, [kind, lawFirmId, trustAccountId]);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    setError(null);
    try {
      if (kind === "trust") {
        await billingService.disconnectTrustConnect(lawFirmId, trustAccountId as string);
      } else {
        await billingService.disconnectFirmConnect(lawFirmId);
      }
      await refresh();
      return true;
    } catch (err) {
      setError(getErrorMessage(err, "Failed to disconnect"));
      return false;
    } finally {
      setDisconnecting(false);
    }
  }, [kind, lawFirmId, trustAccountId, refresh]);

  return {
    status,
    loading,
    error,
    setError,
    connecting,
    openingDashboard,
    disconnecting,
    busy: connecting || openingDashboard || disconnecting,
    connect,
    openDashboard,
    disconnect,
    refresh,
  };
}

export default useStripeConnect;
