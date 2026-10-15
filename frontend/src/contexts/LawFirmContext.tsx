'use client';

import { createContext, useContext } from 'react';
import type { LawFirm } from '@/types';
import type { SubscriptionStatus } from '@/types/subscription';

interface LawFirmContextValue {
  lawFirm: LawFirm | null;
  refetchLawFirm: () => Promise<void>;
  // The firm's subscription status, resolved once by the layout for the billing
  // paywall. Shared so the billing settings page can seed from it instead of
  // issuing its own duplicate /subscriptions/status request on mount.
  subscriptionStatus: SubscriptionStatus | null;
  // True once the layout's billing resolution has settled (success OR failure),
  // so consumers can distinguish "not fetched yet" from "fetched, no status"
  // and only fall back to their own fetch in the latter case.
  subscriptionStatusLoaded: boolean;
}

export const LawFirmContext = createContext<LawFirmContextValue>({
  lawFirm: null,
  refetchLawFirm: async () => {},
  subscriptionStatus: null,
  subscriptionStatusLoaded: false,
});

export function useLawFirm() {
  return useContext(LawFirmContext);
}
