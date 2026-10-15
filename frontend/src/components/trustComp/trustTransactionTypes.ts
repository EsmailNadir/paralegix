import { ArrowDownCircle, ArrowUpCircle, ArrowRightCircle, RotateCcw, type LucideIcon } from "lucide-react";
import type { StatusVariant } from "@/constants/statusMeta";
import type { TrustTransactionType } from "@/types/trust";

/**
 * Trust transaction types, coloured by what the money did: green in, red out,
 * blue moved between accounts, amber returned. The transaction list and both
 * ledger dialogs read this one record, so a type never looks different from one
 * trust screen to the next.
 */
export const TRUST_TRANSACTION_TYPES: Record<
  TrustTransactionType,
  { label: string; icon: LucideIcon; variant: StatusVariant }
> = {
  deposit: { label: "Deposit", icon: ArrowDownCircle, variant: "success" },
  withdrawal: { label: "Withdrawal", icon: ArrowUpCircle, variant: "danger" },
  transfer: { label: "Transfer", icon: ArrowRightCircle, variant: "info" },
  refund: { label: "Refund", icon: RotateCcw, variant: "warning" },
};
