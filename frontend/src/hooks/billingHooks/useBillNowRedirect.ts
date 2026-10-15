import { useCallback } from "react";
import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import type { BillingReadyItem, TimeEntry } from "@/types";

/**
 * Result shape emitted by TimeEntryModal.onSuccess when the user saved a time
 * entry and (optionally) chose "bill now".
 */
export type AddTimeEntryResult = {
  createdEntry: TimeEntry;
  shouldBillNow: boolean;
  draftItem?: BillingReadyItem;
};

/**
 * The invoice composer for ONE billing context: the matter's or the client's
 * `generate-invoice` page, with an optional query string to preload it.
 *
 * Billing one context always lands here, whether it starts from "bill now" in
 * the time-entry modal or from a row's Bill action. The firm-wide invoice run
 * (`/billing/invoice-run`) is for billing several contexts in one pass, and is
 * reached only from the billing workbench's batch and ready-to-bill flows.
 */
export function invoiceComposerPath(
  lawFirmId: string,
  context: { type: "matter" | "client"; entityId: string },
  query?: URLSearchParams,
): string {
  const qs = query && query.toString() ? `?${query.toString()}` : "";
  const segment = context.type === "matter" ? "matters" : "clients";
  return `/lawfirm/${lawFirmId}/${segment}/${context.entityId}/generate-invoice${qs}`;
}

/**
 * The context a bill-now draft belongs to. The draft's own `matterId` or
 * `clientId` wins; a draft that names its context only as `contextType` +
 * `entityId`, the way the rest of billing does, is read from those.
 */
function draftContext(d: BillingReadyItem): { type: "matter" | "client"; entityId: string } | null {
  const matterId = d.matterId || (d.contextType === "matter" ? d.entityId : null);
  if (matterId) return { type: "matter", entityId: matterId };
  const clientId = d.clientId || (d.contextType === "client" ? d.entityId : null);
  if (clientId) return { type: "client", entityId: clientId };
  return null;
}

/**
 * Builds the TimeEntryModal `onSuccess` handler that, when the user chose
 * "bill now", routes to the matter or client invoice composer pre-loaded with the
 * just-created time-entry draft. Every TimeEntryModal that offers "bill now"
 * goes through this (the tasks grid, the task, matter and billing pages, the
 * matter Time Tracking and Events tabs, and the floating timer), so the
 * destination is the same from every entry point.
 *
 * @param onDone runs first on every save (bill-now or not) - use it to close the
 *   modal and clear any prefill state.
 */
export function useBillNowRedirect(lawFirmId: string, onDone?: () => void) {
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const canManageInvoices = hasPermission("billing.manageInvoices");

  return useCallback(
    (result?: AddTimeEntryResult) => {
      onDone?.();
      // The composer needs invoice rights that time-entry rights do not imply.
      if (!canManageInvoices || !result?.shouldBillNow || !result.draftItem) return;

      const d = result.draftItem;
      const context = draftContext(d);
      if (!context) return;

      const params = new URLSearchParams();
      if (d.timeEntryId) {
        params.set("draftType", "time_entry");
        params.set("draftId", d.timeEntryId);
      }
      if (d.matterClientIds && d.matterClientIds.length > 1) {
        params.set("mode", "split");
        params.set("preferredMatterClientIds", d.matterClientIds.join(","));
      } else if (d.matterClientId) {
        params.set("billToMatterClientId", d.matterClientId);
      }

      navigate(invoiceComposerPath(lawFirmId, context, params));
    },
    [canManageInvoices, lawFirmId, navigate, onDone]
  );
}
