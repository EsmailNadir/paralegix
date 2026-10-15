/**
 * An archive outlives the page that asked for it.
 *
 * A folder download is a server-side JOB that takes minutes on a real matter.
 * It used to be awaited inside the file browser, so opening a matter while one
 * ran unmounted the wait and abandoned the archive: either cancelled outright,
 * or finished and filed for somebody who had already gone.
 *
 * These cases are about WHERE the wait lives, which is the only thing that can
 * be tested from outside: unmount the page, keep the provider, and require the
 * work to still be running and still stoppable.
 */
import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileExportProvider, useFileExport } from '@/contexts/FileExportContext';

/** A page that starts an export and can be unmounted out from under it. */
function Page({ onRun }: { onRun: (signal: AbortSignal) => Promise<void> }) {
  const { runExport } = useFileExport();
  return (
    <button type="button" onClick={() => { void runExport('Preparing “Discovery”…', onRun).catch(() => {}); }}>
      start
    </button>
  );
}

function Shell({ onRun }: { onRun: (signal: AbortSignal) => Promise<void> }) {
  const [open, setOpen] = useState(true);
  return (
    <FileExportProvider>
      {open && <Page onRun={onRun} />}
      <button type="button" onClick={() => setOpen(false)}>navigate away</button>
    </FileExportProvider>
  );
}

/** A promise the test resolves, standing in for the poll-and-download wait. */
function pending() {
  let settle: () => void = () => {};
  let signal: AbortSignal | null = null;
  const run = (s: AbortSignal) => {
    signal = s;
    return new Promise<void>((resolve) => { settle = resolve; });
  };
  return { run, settle: () => settle(), signalOf: () => signal };
}

describe('an export in flight', () => {
  it('keeps running when the page that started it goes away', async () => {
    const work = pending();
    render(<Shell onRun={work.run} />);
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    await screen.findByText(/Preparing/);

    fireEvent.click(screen.getByRole('button', { name: 'navigate away' }));

    // The page is gone and the archive is still being built. Asserting the
    // pill is still there is the whole point: it is rendered by the provider,
    // so it can only survive if the wait did.
    expect(screen.queryByRole('button', { name: 'start' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Preparing');
    expect(work.signalOf()!.aborted).toBe(false);
  });

  it('can still be cancelled after the page has gone', async () => {
    const work = pending();
    render(<Shell onRun={work.run} />);
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    await screen.findByText(/Preparing/);
    fireEvent.click(screen.getByRole('button', { name: 'navigate away' }));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Cancelling has to reach the WORKER, not just stop the waiting. The signal
    // is what the service turns into a cancel call on the job.
    expect(work.signalOf()!.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('clears the pill when the archive lands', async () => {
    const work = pending();
    render(<Shell onRun={work.run} />);
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    await screen.findByText(/Preparing/);

    work.settle();

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('replaces an export rather than running two at once', async () => {
    const first = pending();
    const second = pending();
    function Two() {
      const { runExport } = useFileExport();
      return (
        <>
          <button type="button" onClick={() => { void runExport('first…', first.run).catch(() => {}); }}>one</button>
          <button type="button" onClick={() => { void runExport('second…', second.run).catch(() => {}); }}>two</button>
        </>
      );
    }
    render(<FileExportProvider><Two /></FileExportProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'one' }));
    await screen.findByText('first…');
    fireEvent.click(screen.getByRole('button', { name: 'two' }));

    // Browsers honour only the first of several downloads fired together, so a
    // second archive landing beside the first is a file nobody receives. The
    // first is cancelled rather than left to finish invisibly.
    expect(first.signalOf()!.aborted).toBe(true);
    await screen.findByText('second…');
  });

  it('leaves the newer export alone when the one it replaced finishes', async () => {
    const first = pending();
    const second = pending();
    function Two() {
      const { runExport } = useFileExport();
      return (
        <>
          <button type="button" onClick={() => { void runExport('first…', first.run).catch(() => {}); }}>one</button>
          <button type="button" onClick={() => { void runExport('second…', second.run).catch(() => {}); }}>two</button>
        </>
      );
    }
    render(<FileExportProvider><Two /></FileExportProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'one' }));
    await screen.findByText('first…');
    fireEvent.click(screen.getByRole('button', { name: 'two' }));
    await screen.findByText('second…');

    first.settle();

    // The replaced export settling must not clear the pill: that would leave
    // the live one running with nothing on screen and no way to stop it.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('second…'));
  });
});
