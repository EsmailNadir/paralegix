"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import { pdf } from "@react-pdf/renderer";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import useClientLedger from "@/hooks/trustHooks/useClientLedger";
import Spinner from "@/components/ui/Spinner";
import ErrorNotification from "@/components/ErrorNotification";
import trustService from "@/services/trust.service";
import { formatDateOnly } from "@/lib/utils/dateUtils";
import type { TrustTransaction } from "@/types/trust";
import { centsToDollars } from "@/lib/utils/currency";
import { toCsv, downloadCsv } from "@/lib/utils/csv";
import ClientStatementReport from "./ClientStatementReport";
import TrustLedgerModal from "./TrustLedgerModal";
import { getErrorMessage } from "@/lib/utils/apiErrors";

const capitalize = (s?: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
const sanitizeFilename = (s: string) => s.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || "client";

/** Export batch size. Matches the ledger endpoint's maximum `limit`. */
const EXPORT_PAGE_SIZE = 200;
/** Hard stop on the export loop, so an inconsistent total can't spin forever. */
const MAX_EXPORT_PAGES = 40;

interface ClientLedgerModalProps {
  open: boolean;
  lawFirmId: string;
  clientId: string | null;
  clientName?: string;
  onClose: () => void;
}

export default function ClientLedgerModal({ open, lawFirmId, clientId, clientName, onClose }: ClientLedgerModalProps) {
  // Preserve last valid values through the close animation so content doesn't flash empty.
  const stableClientId = useRef(clientId);
  const stableClientName = useRef(clientName);
  if (clientId) { stableClientId.current = clientId; stableClientName.current = clientName; }

  const ledger = useClientLedger(lawFirmId, stableClientId.current ?? undefined);

  // The statement's closing balance comes from the balance endpoint, which sums
  // EVERY transaction in SQL, not from the page of rows on screen.
  const { data: balance } = useQuery({
    queryKey: ["clientTrustBalance", lawFirmId, stableClientId.current],
    queryFn: () => trustService.getClientBalance(lawFirmId, stableClientId.current as string),
    enabled: !!lawFirmId && !!stableClientId.current,
  });
  const currentBalance = balance?.totalBalanceCents ?? 0;

  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  useResetAfterClose(open, () => setExportError(null));
  const clientLabel = stableClientName.current || "Client";

  /**
   * The whole ledger, oldest first - what a statement and a CSV both have to
   * cover. The modal holds one page, so the export re-requests the same ledger in
   * backend-max windows rather than exporting whatever happens to be on screen.
   */
  async function fetchFullLedger(): Promise<TrustTransaction[]> {
    const clientId = stableClientId.current;
    if (!clientId) return [];
    const collected: TrustTransaction[] = [];
    for (let pageNumber = 1; pageNumber <= MAX_EXPORT_PAGES; pageNumber += 1) {
      const { transactions: batch, totalItems: total } = await trustService.getClientLedgerPaged(
        lawFirmId,
        clientId,
        { limit: EXPORT_PAGE_SIZE, offset: (pageNumber - 1) * EXPORT_PAGE_SIZE, order: "asc" },
      );
      collected.push(...batch);
      if (batch.length < EXPORT_PAGE_SIZE || collected.length >= total) break;
      // Reaching the cap with rows still unfetched would hand over a partial
      // statement that looks complete, so say so instead.
      if (pageNumber === MAX_EXPORT_PAGES && collected.length < total) {
        throw new Error(
          `This ledger is larger than a single export (${collected.length} of ${total} entries). Export from the Transactions tab instead.`,
        );
      }
    }
    return collected;
  }

  async function handleExportCsv() {
    if (exportingCsv) return;
    setExportingCsv(true);
    setExportError(null);
    try {
      const full = await fetchFullLedger();
      buildCsv(full);
    } catch (err) {
      setExportError(getErrorMessage(err, "Failed to export the ledger."));
    } finally {
      setExportingCsv(false);
    }
  }

  function buildCsv(entries: TrustTransaction[]) {
    const rows = entries.map((txn) => ({
      date: formatDateOnly(txn.date),
      type: capitalize(txn.type),
      account: txn.trustAccountName || "",
      description: txn.description || "",
      reference: txn.referenceNumber || "",
      amount: centsToDollars(txn.amountCents),
      status: capitalize(txn.status),
      balance: txn.status === "void" || txn.clientBalanceAfter == null ? "" : centsToDollars(txn.clientBalanceAfter),
    }));
    const csv = toCsv(rows, [
      { key: "date", header: "Date" },
      { key: "type", header: "Type" },
      { key: "account", header: "Account" },
      { key: "description", header: "Description" },
      { key: "reference", header: "Reference" },
      { key: "amount", header: "Amount" },
      { key: "status", header: "Status" },
      { key: "balance", header: "Balance" },
    ]);
    downloadCsv(`trust-ledger-${sanitizeFilename(clientLabel)}.csv`, csv);
  }

  async function handleDownloadStatement() {
    if (downloadingPdf) return;
    setDownloadingPdf(true);
    setExportError(null);
    try {
      const full = await fetchFullLedger();
      const blob = await pdf(
        <ClientStatementReport
          clientName={clientLabel}
          transactions={full}
          currentBalanceCents={currentBalance}
        />
      ).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `trust-statement-${sanitizeFilename(clientLabel)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(getErrorMessage(err, "Failed to build the statement."));
    } finally {
      setDownloadingPdf(false);
    }
  }

  return (
    <TrustLedgerModal
      open={open}
      onClose={onClose}
      title={stableClientName.current ? `${stableClientName.current}: Ledger` : "Client Ledger"}
      ledger={ledger}
      balance={balance}
      emptyMessage="No transactions for this client."
      headerActions={
        <>
          <Tooltip title="Export the whole ledger to CSV" enterDelay={300}>
            <span>
              <button
                onClick={handleExportCsv}
                disabled={exportingCsv}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-on-surface bg-surface-alt border border-outline-subtle hover:bg-surface-hover rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {exportingCsv ? <Spinner size={13} /> : <Download size={13} />}
                CSV
              </button>
            </span>
          </Tooltip>
          <Tooltip title="Download the full trust statement as a PDF" enterDelay={300}>
            <span>
              <button
                onClick={handleDownloadStatement}
                disabled={downloadingPdf}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-on-surface bg-surface-alt border border-outline-subtle hover:bg-surface-hover rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {downloadingPdf ? <Spinner size={13} /> : <FileText size={13} />}
                Download statement
              </button>
            </span>
          </Tooltip>
        </>
      }
      banner={
        <ErrorNotification
          error={exportError}
          onClose={() => setExportError(null)}
          compact
          className="mx-6 mt-3 shrink-0"
        />
      }
    />
  );
}
