"use client";

import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import useMatterLedger from "@/hooks/trustHooks/useMatterLedger";
import trustService from "@/services/trust.service";
import TrustLedgerModal from "./TrustLedgerModal";

interface MatterLedgerModalProps {
  open: boolean;
  lawFirmId: string;
  matterId: string | null;
  matterName?: string;
  onClose: () => void;
}

export default function MatterLedgerModal({ open, lawFirmId, matterId, matterName, onClose }: MatterLedgerModalProps) {
  // Preserve last valid values through the close animation so content doesn't flash empty.
  const stableMatterId = useRef(matterId);
  const stableMatterName = useRef(matterName);
  if (matterId) { stableMatterId.current = matterId; stableMatterName.current = matterName; }

  const ledger = useMatterLedger(lawFirmId, stableMatterId.current ?? undefined);
  const { data: balance } = useQuery({
    queryKey: ["matterTrustBalance", lawFirmId, stableMatterId.current],
    queryFn: () => trustService.getMatterBalance(lawFirmId, stableMatterId.current as string),
    enabled: !!lawFirmId && !!stableMatterId.current,
  });

  return (
    <TrustLedgerModal
      open={open}
      onClose={onClose}
      title={stableMatterName.current ? `${stableMatterName.current}: Trust Ledger` : "Matter Trust Ledger"}
      ledger={ledger}
      balance={balance}
      emptyMessage="No transactions for this matter."
    />
  );
}
