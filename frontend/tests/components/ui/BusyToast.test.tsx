import { fireEvent, render, screen } from '@testing-library/react';
import BusyToast from '@/components/ui/BusyToast';

describe('BusyToast', () => {
  it('renders nothing when message is empty or null', () => {
    const { container } = render(<BusyToast message={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders polite status alert when message is present', () => {
    render(<BusyToast message="Exporting LEDES file…" />);

    const toast = screen.getByRole('status');
    expect(toast).toBeInTheDocument();
    expect(toast).toHaveTextContent('Exporting LEDES file…');
  });

  it('offers no way to stop work that cannot be stopped', () => {
    render(<BusyToast message="Moving..." />);

    // Most callers report work that is over before anyone could act on it. A
    // Cancel that did nothing would be worse than none.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('calls onCancel when the person stops a long build', () => {
    const onCancel = jest.fn();
    render(<BusyToast message="Preparing “Discovery” for download…" onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('keeps the cancel button clickable through the pill', () => {
    const onCancel = jest.fn();
    render(<BusyToast message="Preparing 12 items for download…" onCancel={onCancel} />);

    // The pill is deliberately click-through so it can sit over a file list
    // without swallowing a row click. The button has to opt back in, or the
    // control renders and does nothing.
    expect(screen.getByRole('status')).toHaveClass('pointer-events-none');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('pointer-events-auto');
  });
});
