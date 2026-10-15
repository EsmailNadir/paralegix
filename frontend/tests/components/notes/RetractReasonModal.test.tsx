import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import RetractReasonModal from '@/components/notesComp/RetractReasonModal';

// Red if sharing the reason field makes retraction require a reason, drops
// controlled edits, or removes ConfirmModal's close-while-saving guard.
function Harness({ onConfirm, loading = false, onClose = jest.fn() }: { onConfirm: (reason: string) => void; loading?: boolean; onClose?: () => void }) {
  const [reason, setReason] = useState('');
  return <RetractReasonModal isOpen title="Retract note" message="Retract this note?" placeholder="Explain why" reason={reason} onReasonChange={setReason} onConfirm={() => onConfirm(reason)} onClose={onClose} loading={loading} />;
}

it('permits retraction without a reason and submits typed reasons unchanged', () => {
  const onConfirm = jest.fn();
  render(<Harness onConfirm={onConfirm} />);
  expect(screen.getByText('Reason')).toHaveAttribute('class', 'mb-1 block text-sm font-medium text-on-surface');
  fireEvent.click(screen.getByRole('button', { name: 'Retract' }));
  expect(onConfirm).toHaveBeenLastCalledWith('');
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  Wrong recipient  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Retract' }));
  expect(onConfirm).toHaveBeenLastCalledWith('  Wrong recipient  ');
  expect(screen.getByLabelText('Reason')).toHaveValue('  Wrong recipient  ');
});

it('refuses Escape and Cancel while retracting', () => {
  const onClose = jest.fn();
  render(<Harness onConfirm={jest.fn()} onClose={onClose} loading />);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(onClose).not.toHaveBeenCalled();
});
