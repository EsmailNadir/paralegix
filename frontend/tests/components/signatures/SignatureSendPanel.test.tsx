import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import SignatureSendPanel from '@/components/signaturesComp/SignatureSendPanel';

it('shows one steady indicator and lets the user cancel an active signing upload', () => {
  const onCancel = jest.fn();
  render(
    <SignatureSendPanel
      onClick={jest.fn()}
      onCancel={onCancel}
      uploading
      extensions={['.pdf']}
    />,
  );

  // No percentage. A signing upload spends most of a normal document's wait on
  // the server reading the PDF, so a byte number reached 99 in a moment and
  // then stopped, which reads as an upload that has frozen.
  expect(screen.getByText('Uploading')).toBeInTheDocument();
  expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');

  fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});

it('offers the file picker instead when nothing is uploading', () => {
  render(<SignatureSendPanel onClick={jest.fn()} uploading={false} extensions={['.pdf']} />);

  expect(screen.getByText('Choose a file')).toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
});
