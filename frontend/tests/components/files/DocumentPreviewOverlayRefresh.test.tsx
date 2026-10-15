/**
 * What happens when the read url a preview is holding lapses mid-read.
 *
 * A signed read url is short lived by design, and a long document is read for
 * longer than one lasts. Two things can go wrong once it is reminted, and both
 * are silent:
 *
 *   The reader is thrown back to page 1 at their current zoom, halfway through a
 *   500-page production, because the viewer treated a new signature over the
 *   same object as a new document.
 *
 *   The object changed underneath them and the new bytes are shown in place of
 *   the old ones, so a page they were reading is quietly replaced by a different
 *   page carrying the same number. A preview that swaps versions without saying
 *   so is worse than one that fails.
 *
 * `PdfPreview` is stubbed, so this file asserts what the overlay hands it and
 * what it shows the reader, not what pdf.js then fetches.
 */
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DocumentPreviewOverlay from '@/components/filesComp/DocumentPreviewOverlay';

const pdfPreviewProps: Array<Record<string, unknown>> = [];

jest.mock('@/components/filesComp/PdfPreview', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    pdfPreviewProps.push(props);
    return <div data-testid="pdf-preview" />;
  },
}));

/** A V4 signed url that lapses `seconds` from now, over `object`, at `generation`. */
function signedUrl(
  { object = 'doc.pdf', seconds = 900, generation = '1700000000000001', sig = 'a' } = {},
) {
  const issued = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return (
    `https://storage.googleapis.com/bucket/${object}` +
    `?generation=${generation}&X-Goog-Date=${issued}&X-Goog-Expires=${seconds}&X-Goog-Signature=${sig}`
  );
}

const BIG = 200 * 1024 * 1024;

/** The overlay's own wording for a document replaced mid-read. */
const CHANGED_NOTICE = /changed while you were reading/i;

let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  pdfPreviewProps.length = 0;
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    headers: new Headers(),
    arrayBuffer: async () => new Uint8Array([0x25]).buffer,
    text: async () => '',
  } as unknown as Response);
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  fetchSpy.mockRestore();
});

function open(fileUrl: string, onRefreshUrl: () => Promise<string>) {
  return render(
    <DocumentPreviewOverlay
      open
      onClose={() => {}}
      name="production.pdf"
      contentType="application/pdf"
      fileUrl={fileUrl}
      // Large enough that the ranged path is in use, which is the only path a
      // url expiring mid-read can affect.
      sizeBytes={BIG}
      onRefreshUrl={onRefreshUrl}
    />,
  );
}

/** Runs the scheduled remint and lets its promise settle. */
async function reachExpiry() {
  await act(async () => {
    jest.advanceTimersByTime(15 * 60 * 1000);
  });
}

function lastUrl() {
  return pdfPreviewProps[pdfPreviewProps.length - 1]?.url;
}

describe('a url reminted over the same object', () => {
  it('is swapped in, and only the url changes', async () => {
    const first = signedUrl({ sig: 'first' });
    const second = signedUrl({ sig: 'second' });
    const refresh = jest.fn().mockResolvedValue(second);

    open(first, refresh);
    await waitFor(() => expect(lastUrl()).toBe(first));

    await reachExpiry();

    // Reauthorized by the caller's minter, which goes through the same
    // membership and permission checks the first url did.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(lastUrl()).toBe(second);
    // Same component, so its page window, its measurements and the overlay's own
    // zoom are all still the ones the reader had.
    expect(screen.getAllByTestId('pdf-preview')).toHaveLength(1);
    expect(screen.queryByText(CHANGED_NOTICE)).not.toBeInTheDocument();
  });

  it('does not remint a url with no expiry to read', async () => {
    const refresh = jest.fn().mockResolvedValue('https://x/other.pdf');
    open('https://storage.googleapis.com/bucket/doc.pdf', refresh);
    await waitFor(() => expect(pdfPreviewProps.length).toBeGreaterThan(0));

    await reachExpiry();

    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('a remint that comes back pointing at different bytes', () => {
  it('says so instead of swapping the document out underneath the reader', async () => {
    const first = signedUrl({ generation: '1700000000000001' });
    const replaced = signedUrl({ generation: '1700000000000002', sig: 'second' });
    const refresh = jest.fn().mockResolvedValue(replaced);

    open(first, refresh);
    await waitFor(() => expect(lastUrl()).toBe(first));

    await reachExpiry();

    // The pages on screen still belong to the version the reader opened.
    expect(lastUrl()).toBe(first);
    const notice = screen.getByText(CHANGED_NOTICE);
    // Announced, not just drawn: the reader may be deep in a long document with
    // the message well above the viewport.
    expect(notice.closest('[role="status"]')).not.toBeNull();
  });

  it('loads the new version only when the reader asks for it', async () => {
    const first = signedUrl({ generation: '1700000000000001' });
    const replaced = signedUrl({ generation: '1700000000000002', sig: 'second' });
    const refresh = jest.fn().mockResolvedValue(replaced);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    open(first, refresh);
    await waitFor(() => expect(lastUrl()).toBe(first));
    await reachExpiry();

    await user.click(screen.getByRole('button', { name: /new version/i }));

    expect(lastUrl()).toBe(replaced);
    expect(screen.queryByText(CHANGED_NOTICE)).not.toBeInTheDocument();
  });
});
