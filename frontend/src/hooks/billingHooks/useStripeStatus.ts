"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import billingService from "@/services/billing.service";

/**
 * Whether the firm can take online payments through Stripe, as one status.
 *
 * - `loading`: the first read is in flight (or a retry after a failure is).
 * - `ready`: connected and Stripe will accept charges.
 * - `needs_setup`: an account exists but cannot take charges yet, usually
 *   because onboarding was not finished.
 * - `not_connected`: the firm has no Stripe account.
 * - `error`: the read failed, so readiness is unknown. Never shown as "not
 *   connected": telling a connected firm to connect Stripe is worse than
 *   saying the check failed.
 */
export type StripeStatus = "loading" | "ready" | "needs_setup" | "not_connected" | "error";

export interface UseStripeStatusResult {
  status: StripeStatus;
  /** The firm's own Standard account takes invoice payments as direct charges. */
  directCharges: boolean;
  retry: () => void;
}

interface UseStripeStatusOptions {
  /** Hold the read back until the page has what it needs to render the answer. */
  enabled?: boolean;
}

/** The cache key of a firm's Stripe status, shared with `useStripeConnect`. */
export function stripeStatusQueryKey(lawFirmId: string) {
  return ["stripeStatus", lawFirmId] as const;
}

export function useStripeStatus(
  lawFirmId: string,
  { enabled = true }: UseStripeStatusOptions = {},
): UseStripeStatusResult {
  const query = useQuery({
    queryKey: stripeStatusQueryKey(lawFirmId),
    queryFn: () => billingService.getFirmConnectStatus(lawFirmId),
    enabled: !!lawFirmId && enabled,
    // Cached per firm, so moving between invoices or into the client page
    // renders the answer at once instead of a placeholder every time.
    staleTime: 60_000,
    // A failure is offered back as "Try again" rather than retried behind a
    // placeholder for several seconds.
    retry: false,
  });
  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  const data = query.data;
  let status: StripeStatus;
  if (data) {
    status = !data.connected ? "not_connected" : data.chargesEnabled ? "ready" : "needs_setup";
  } else if (query.isError && !query.isFetching) {
    status = "error";
  } else {
    status = "loading";
  }

  return { status, directCharges: data?.directCharges === true, retry };
}
