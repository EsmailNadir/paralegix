'use client';

import { useEffect, useState } from 'react';
import signaturesService from '@/services/signatures.service';
import { pollDelay } from '@/lib/utils/pollDelay';

/**
 * How long the signer's page waits for the executed document. Past this the
 * durable job carries on without the page, and the signer is told so.
 */
const FINALIZE_WAIT_LIMIT_MS = 10 * 60 * 1000;

/**
 * Wait for the executed document after a signature was recorded but the
 * session not yet sealed (`processing` or `recoverable_failure`).
 *
 * Set `isFinalizing` from the completion outcome; while it is true the session
 * status is polled until it reads `completed`. The reads back off, a hidden tab
 * skips them, and the wait ends at a deadline: an abandoned tab goes quiet
 * rather than polling a job for as long as it stays open, and
 * `finalizeTimedOut` tells the page to say the signer can leave.
 */
export function useExecutedDocumentWait(token: string | undefined) {
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [finalizeTimedOut, setFinalizeTimedOut] = useState(false);

  useEffect(() => {
    if (!isFinalizing || !token) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    const deadline = Date.now() + FINALIZE_WAIT_LIMIT_MS;
    const poll = async () => {
      if (stopped) return;
      if (Date.now() > deadline) {
        setFinalizeTimedOut(true);
        return;
      }
      if (typeof document === 'undefined' || !document.hidden) {
        try {
          const status = await signaturesService.getSigningStatus(token);
          if (stopped) return;
          if (status.sessionStatus === 'completed') {
            setIsFinalizing(false);
            return;
          }
        } catch {
          // The durable job continues independently. A transient poll failure
          // should not ask the signer to submit their consent again.
        }
      }
      if (stopped) return;
      attempt += 1;
      timer = setTimeout(poll, pollDelay(attempt));
    };
    timer = setTimeout(poll, pollDelay(attempt));
    return () => { stopped = true; clearTimeout(timer); };
  }, [isFinalizing, token]);

  return { isFinalizing, setIsFinalizing, finalizeTimedOut };
}
