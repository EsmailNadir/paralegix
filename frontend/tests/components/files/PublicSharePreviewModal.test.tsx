/**
 * What the public share preview tells the shared overlay about its file.
 *
 * The share page has no firm session, so there is nothing here to reauthorize
 * with and no reminting: the url it was handed is the only one it will get. What
 * it CAN do is pass on a size when the share response carried one, so a
 * multi-gigabyte share is read in ranges rather than measured with an extra
 * round trip or, worse, assumed small and pulled into the tab whole.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

let overlayProps: Record<string, any> | null = null;

jest.mock('@/components/filesComp/DocumentPreviewOverlay', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    overlayProps = props;
    return <div data-testid="overlay" />;
  },
}));

import PublicSharePreviewModal from '@/components/filesComp/PublicSharePreviewModal';

const URL_ = 'https://storage.googleapis.com/bucket/shared.pdf?sig=a';

beforeEach(() => {
  overlayProps = null;
});

it('passes a known size through instead of leaving it to be probed', async () => {
  render(
    <PublicSharePreviewModal
      open
      onClose={() => {}}
      name="shared.pdf"
      contentType="application/pdf"
      fileUrl={URL_}
      sizeBytes={3_000_000_000}
    />,
  );

  await screen.findByTestId('overlay');
  expect(overlayProps!.sizeBytes).toBe(3_000_000_000);
});

it('leaves the size unset when the share response did not carry one', async () => {
  render(
    <PublicSharePreviewModal
      open
      onClose={() => {}}
      name="shared.pdf"
      contentType="application/pdf"
      fileUrl={URL_}
    />,
  );

  await screen.findByTestId('overlay');
  // Undefined, not zero and not a guess: it is what makes the overlay resolve
  // the size itself rather than assume one.
  expect(overlayProps!.sizeBytes).toBeUndefined();
});

it('offers no reminter, because there is no session to reauthorize', async () => {
  render(
    <PublicSharePreviewModal
      open
      onClose={() => {}}
      name="shared.pdf"
      contentType="application/pdf"
      fileUrl={URL_}
    />,
  );

  await screen.findByTestId('overlay');
  expect(overlayProps!.onRefreshUrl).toBeUndefined();
});
