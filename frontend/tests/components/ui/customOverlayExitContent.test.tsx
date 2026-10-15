/**
 * Overlays that animate out on their own `useMountTransition` rather than
 * through `Modal`, which freezes its content during the exit for free.
 *
 * Each one used to change what it showed in the same update that closed it: a
 * caller cleared the fields it renders, or a `finally` dropped the busy flag and
 * the button relabelled. These specs close each overlay and read it while it is
 * still on screen animating out.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockConvertLead = jest.fn();
jest.mock('@/services/leads.service', () => ({
  __esModule: true,
  default: { convertLead: (...args: unknown[]) => mockConvertLead(...args) },
}));

jest.mock('@/hooks/practiceHooks/usePracticeAreas', () => ({
  __esModule: true,
  default: () => ({ practiceAreas: [], loading: false, createPracticeArea: jest.fn() }),
}));

import RecordPaymentModal from '@/components/billingComp/RecordPaymentModal';
import ConvertLeadModal from '@/components/leadComp/ConvertLeadModal';
import MatterMemberPicker from '@/components/matterComp/matterForm/MatterMemberPicker';

describe('RecordPaymentModal while closing', () => {
  const props = {
    onClose: () => {},
    invoiceLabel: 'INV-7',
    totalAmount: 500,
    amountPaid: 0,
    remainingBalance: 500,
    onAmountChange: () => {},
    allowOverpayment: false,
    onAllowOverpaymentChange: () => {},
    onNoteChange: () => {},
    onSubmit: () => {},
  };

  it('keeps the note and the saving label the caller clears as it closes', () => {
    const { rerender } = render(
      <RecordPaymentModal {...props} open amount="200" note="Paid by cheque" submitting />,
    );

    rerender(<RecordPaymentModal {...props} open={false} amount="" note="" submitting={false} />);

    expect(screen.getByRole('dialog')).toHaveClass('overlay-card-exit');
    expect(screen.getByLabelText('Note')).toHaveValue('Paid by cheque');
    expect(screen.getByRole('button', { name: /Saving\.\.\./ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record Payment' })).not.toBeInTheDocument();
  });
});

describe('ConvertLeadModal while closing', () => {
  it('still reads "Converting..." as it closes after a successful conversion', async () => {
    let finish: (value: unknown) => void = () => {};
    mockConvertLead.mockReturnValue(new Promise((resolve) => { finish = resolve; }));

    function Harness() {
      const [open, setOpen] = React.useState(true);
      return (
        <ConvertLeadModal
          open={open}
          onClose={() => setOpen(false)}
          lawFirmId="firm-1"
          lead={{ id: 'lead-1', name: 'Dana Reyes' } as never}
        />
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(screen.getByRole('button', { name: /Converting/ })).toBeInTheDocument();

    await act(async () => { finish({}); });

    await waitFor(() => expect(screen.getByRole('dialog')).toHaveClass('overlay-card-exit'));
    expect(screen.getByRole('button', { name: /Converting/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Convert' })).not.toBeInTheDocument();
  });
});

describe('MatterMemberPicker menu while closing', () => {
  const users = [
    { uid: 'u-1', name: 'Avery Stone', email: 'avery@example.com' },
    { uid: 'u-2', name: 'Blake Hart', email: 'blake@example.com' },
  ] as never[];

  function Harness() {
    const [memberUserIds, setMemberUserIds] = React.useState<string[]>([]);
    return (
      <MatterMemberPicker
        users={users}
        memberUserIds={memberUserIds}
        leadUserIds={[]}
        onAdd={(id) => setMemberUserIds((prev) => [...prev, id])}
        onRemove={() => {}}
        onToggleLead={() => {}}
        onToggleAll={() => {}}
        subtitle="Who works on this matter"
        emptyState={null}
      />
    );
  }

  it('keeps the filtered rows it showed when a member is picked', () => {
    render(<Harness />);
    fireEvent.change(screen.getByPlaceholderText('Search members...'), { target: { value: 'Avery' } });

    const pick = screen.getByRole('button', { name: /Avery Stone/ });
    const menu = pick.parentElement as HTMLElement;
    fireEvent.mouseDown(pick);

    // The search box clears and Avery joins the team, but the fading menu keeps
    // the single match rather than jumping to every remaining member.
    expect(menu).toHaveClass('overlay-menu-exit');
    expect(menu).toHaveTextContent('Avery Stone');
    expect(menu).not.toHaveTextContent('Blake Hart');
  });
});
