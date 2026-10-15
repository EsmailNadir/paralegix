"use client";

import { useQuery } from "@tanstack/react-query";
import billingService from "@/services/billing.service";
import type { CalendarWindow } from "@/lib/utils/calendarWindow";
import type { PaymentDate } from "@/types";
import { paymentDatesWindowKey } from "@/hooks/calendarHooks/calendarSectionQueries";

/**
 * Payment dates for one calendar window.
 *
 * The key keeps the ["billing", "paymentDates", lawFirmId] prefix that the invoice
 * and client views already invalidate, so recording a payment still refreshes the
 * calendar's cached windows by prefix match.
 *
 * `enabled: false` holds the read back while the calendar feed is filling this
 * entry (see `useCalendarWindowData`).
 */
export default function usePaymentDates(lawFirmId?: string, window?: CalendarWindow, { enabled = true } = {}) {
  return useQuery<PaymentDate[]>({
    queryKey: paymentDatesWindowKey(lawFirmId, window),
    queryFn: () => billingService.getCalendarPaymentDates(lawFirmId!, window),
    enabled: enabled && !!lawFirmId && !!window,
    staleTime: 60_000,
    // Guarded on the previous query's OWN firm (index 2 of its key above): bare
    // `keepPreviousData` hands over the last successful result on ANY key
    // change, not just a window change within the same firm. Without the
    // guard, switching firms rendered the first firm's payment dates as though
    // they belonged to the second, for as long as the new firm's request took
    // to resolve - a cross-tenant leak in the UI. (`useCalendarWindowData`
    // already masks this for the calendar page specifically, but the raw hook
    // must not leak to any other caller either.)
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[2] === lawFirmId ? prev : undefined
    ),
  });
}
