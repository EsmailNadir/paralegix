import type { FirmBillingTimeEntry } from "@/types";

/**
 * A firm time entry with its matter, billed client and member resolved.
 *
 * This module used to also export a `useFirmTimeEntries` hook that downloaded the
 * firm's COMPLETE time-entry list, billed and unbilled alike. Only the billing
 * reports ever needed it, because their roll-ups are lifetime hours - and those
 * roll-ups are now a server-side GROUP BY, so nothing has to hold the firm's
 * whole billing history in the browser to add it up. The type stayed because the
 * time-entry lists are shaped by it; page them through `useFirmTimeEntriesTable`.
 */
export interface EnrichedTimeEntry extends FirmBillingTimeEntry {
  matterId: string;
  matterName: string;
  clientId: string;
  /**
   * The client this entry is billed to, empty when none is. It deliberately does
   * NOT fall back to the first name in `clientNames`: that array is every client
   * ON the matter, so the fallback billed one client for another's work. Use
   * `getTimeEntryClientAttribution` to render it.
   */
  clientName: string;
  clientNames: string[];
  memberName: string;
  hourlyRate: number | null;
  context: "matter" | "client";
  sourceLabel: string;
}
