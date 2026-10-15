"use client";

import { useRef, useState } from 'react';
import ConfirmModal from './ConfirmModal';
import Dropdown from './Dropdown';
import ErrorNotification from '@/components/ErrorNotification';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import useSeedOnOpen from '@/hooks/useSeedOnOpen';

interface EligibleMember {
  userId: string;
  name: string;
}

interface AdminTransferModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Performs the transfer. The dialog stays open and busy until this settles:
   * it closes itself when it resolves, and shows the reason when it rejects.
   */
  onConfirm: (newAdminUserId: string) => Promise<void>;
  eligibleMembers: EligibleMember[];
}

export default function AdminTransferModal({
  isOpen,
  onClose,
  onConfirm,
  eligibleMembers,
}: AdminTransferModalProps) {
  const [selectedMember, setSelectedMember] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  // Each opening starts with no successor picked and no error from last time.
  useSeedOnOpen(isOpen, () => {
    setSelectedMember('');
    setError(null);
  });

  const confirm = async () => {
    if (inFlight.current || !selectedMember) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(selectedMember);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not transfer ownership. Try again.'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const dropdownOptions = eligibleMembers.map(m => ({
    value: m.userId,
    label: m.name || m.userId,
  }));

  return (
    <ConfirmModal
      isOpen={isOpen}
      onClose={() => { if (!inFlight.current) onClose(); }}
      onConfirm={() => { void confirm(); }}
      title="Transfer Ownership"
      message="You are the firm owner. Select a member to become the new owner before you leave."
      confirmText="Transfer & Leave"
      confirmDisabled={!selectedMember}
      loading={busy}
      extra={
        <>
          <Dropdown
            portal
            label="New Admin"
            value={selectedMember}
            onChange={setSelectedMember}
            options={dropdownOptions}
            placeholder="Select a member..."
            busy={busy}
          />
          <ErrorNotification error={error} onClose={() => setError(null)} />
        </>
      }
    />
  );
}
