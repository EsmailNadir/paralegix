import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ConfirmModal from '@/components/ui/ConfirmModal';

describe('ConfirmModal', () => {
  it('does not render when isOpen is false', () => {
    render(
      <ConfirmModal
        isOpen={false}
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        title="Delete Item"
        message="Are you sure you want to delete this?"
      />
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders title, message, and default action buttons when isOpen is true', () => {
    render(
      <ConfirmModal
        isOpen={true}
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        title="Delete Item"
        message="Are you sure you want to delete this?"
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('Delete Item')).toBeInTheDocument();
    expect(screen.getByText('Are you sure you want to delete this?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('calls onConfirm when confirm button is clicked', () => {
    const handleConfirm = jest.fn();
    const handleClose = jest.fn();

    render(
      <ConfirmModal
        isOpen={true}
        onClose={handleClose}
        onConfirm={handleConfirm}
        title="Delete Item"
        message="Are you sure?"
        confirmText="Yes, delete"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));

    expect(handleConfirm).toHaveBeenCalledTimes(1);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when cancel button is clicked', () => {
    const handleClose = jest.fn();

    render(
      <ConfirmModal
        isOpen={true}
        onClose={handleClose}
        onConfirm={jest.fn()}
        title="Cancel Action"
        message="Cancel confirmation"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onConfirm when confirmDisabled is true', () => {
    const handleConfirm = jest.fn();

    render(
      <ConfirmModal
        isOpen={true}
        onClose={jest.fn()}
        onConfirm={handleConfirm}
        title="Disabled Action"
        message="Confirm is disabled"
        confirmDisabled={true}
      />
    );

    const confirmBtn = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmBtn).toBeDisabled();

    fireEvent.click(confirmBtn);
    expect(handleConfirm).not.toHaveBeenCalled();
  });

  it('renders extra content when provided', () => {
    render(
      <ConfirmModal
        isOpen={true}
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        title="With Extra"
        message="Notice with extra input"
        extra={<input data-testid="extra-reason" placeholder="Reason" />}
      />
    );

    expect(screen.getByTestId('extra-reason')).toBeInTheDocument();
  });

  it('shows a failed confirm inside the dialog, above its own backdrop', () => {
    render(
      <ConfirmModal
        isOpen={true}
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        title="Delete court"
        message="Delete this court?"
        error="Court is still assigned to 3 matters"
      />
    );

    // A page banner sits behind the backdrop, so the reason has to be in the dialog.
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Court is still assigned to 3 matters');
  });

  it('renders no alert when there is no error', () => {
    render(
      <ConfirmModal
        isOpen={true}
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        title="Delete court"
        message="Delete this court?"
        error={null}
      />
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('disables cancel and escape closing when loading is true', () => {
    const handleClose = jest.fn();

    render(
      <ConfirmModal
        isOpen={true}
        onClose={handleClose}
        onConfirm={jest.fn()}
        title="In Flight"
        message="Deleting..."
        loading={true}
      />
    );

    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    expect(cancelBtn).toBeDisabled();

    fireEvent.click(cancelBtn);
    expect(handleClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' });
    expect(handleClose).not.toHaveBeenCalled();
  });

  // A caller that passes no `loading` gets closed by the dialog right after
  // `onConfirm`. When that handler sets a busy flag first, the relabelled button
  // used to show for the length of the exit animation.
  it('keeps the confirm button reading as it did when clicked while it animates out', () => {
    function RemoveClient() {
      const [open, setOpen] = React.useState(true);
      const [removing, setRemoving] = React.useState(false);
      return (
        <ConfirmModal
          isOpen={open}
          onClose={() => setOpen(false)}
          onConfirm={() => setRemoving(true)}
          title="Remove client"
          message="Remove this client?"
          confirmText={removing ? 'Removing...' : 'Remove Client'}
          confirmType={removing ? 'secondary' : 'danger'}
        />
      );
    }

    render(<RemoveClient />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Client' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('overlay-card-exit');
    expect(screen.getByRole('button', { name: 'Remove Client' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Removing...' })).not.toBeInTheDocument();
  });

  it('keeps the spinner and labels when the caller closes as loading ends', () => {
    const { rerender } = render(
      <ConfirmModal
        isOpen={true}
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        title="Delete"
        message="Delete it?"
        confirmText="Deleting..."
        cancelText="Keep"
        loading={true}
      />
    );

    rerender(
      <ConfirmModal
        isOpen={false}
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        title="Delete"
        message="Delete it?"
        confirmText="Delete"
        cancelText="Cancel"
        loading={false}
      />
    );

    expect(screen.getByRole('dialog')).toHaveClass('overlay-card-exit');
    expect(screen.getByRole('button', { name: 'Keep' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Deleting\.\.\./ })).toBeInTheDocument();
  });
});
