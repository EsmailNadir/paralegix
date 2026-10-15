import type { FirmBillingInvoice } from "@/types";

/**
 * A firm invoice with its matter's name and clients resolved.
 *
 * This module used to also export a `useFirmInvoices` hook that downloaded the
 * firm's COMPLETE invoice list. Only the billing reports ever needed it, because
 * their roll-ups are lifetime totals - and those roll-ups are now a server-side
 * GROUP BY, so nothing has to hold every invoice in the browser to add them up.
 * The type stayed because the invoice lists and detail views are shaped by it;
 * page them through `useFirmInvoicesTable`.
 */
export interface EnrichedInvoice extends FirmBillingInvoice {
  matterName: string;
  matterClientNames: string[];
}
