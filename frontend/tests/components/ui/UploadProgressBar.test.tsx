/**
 * The shared upload indicator.
 *
 * Every upload panel used to hand-roll its own bar around a byte percentage.
 * That number measured only the transfer, which on a normal document is over
 * long before the upload is: it ran to 99 in a moment and then sat there while
 * the file was hashed, verified, converted and recorded. These pin the
 * replacement, which is one steady indicator for the whole upload.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import UploadProgressBar from '@/components/ui/UploadProgressBar';
import UploadStatusChip from '@/components/ui/UploadStatusChip';

describe('UploadProgressBar', () => {
  it('shows one general label and no percentage', () => {
    render(<UploadProgressBar />);

    expect(screen.getByText('Uploading')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('sweeps rather than reporting a position', () => {
    render(<UploadProgressBar />);

    // A width, or an `aria-valuenow`, is a claim about how far along the upload
    // is. Nothing here can make that claim honestly, and the claim it used to
    // make was the defect: a bar stopped near the end while work continued.
    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar.firstElementChild).toHaveClass('progress-sweep');
    expect(bar.firstElementChild).not.toHaveAttribute('style');
  });

  it('takes the caller wording when a surface needs its own', () => {
    render(<UploadProgressBar label="Attaching" />);

    expect(screen.getByText('Attaching')).toBeInTheDocument();
  });
});

describe('UploadStatusChip', () => {
  it('cancels without activating the panel it sits inside', () => {
    const onCancel = jest.fn();
    const onPanelClick = jest.fn();
    render(
      <div onClick={onPanelClick}>
        <UploadStatusChip onCancel={onCancel} />
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));

    // The chip lives inside a drop panel that is itself a button. Letting the
    // click through opens a file picker on top of the cancel the user asked for.
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onPanelClick).not.toHaveBeenCalled();
  });

  it('omits the cancel control when the upload cannot be stopped', () => {
    render(<UploadStatusChip />);

    expect(screen.queryByRole('button', { name: 'Cancel upload' })).not.toBeInTheDocument();
    expect(screen.getByText('Uploading')).toBeInTheDocument();
  });
});
