'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  msUntilReadUrlRefresh,
  readUrlVersionChanged,
} from '@/lib/pdfReadUrl';

interface RefreshingReadUrlOptions {
  /** The read url the caller resolved. Null while it is still resolving one. */
  url: string | null;
  /** False while nothing is reading the url, so no remint is scheduled. */
  enabled: boolean;
  /**
   * Mints a fresh read url for the SAME document.
   *
   * Must reauthorize: it runs long after the reader opened the document, and a
   * url that outlives the access it was granted under is the whole risk here.
   * Omitted by a caller with no session to reauthorize with, such as a public
   * share page, which simply lets its url lapse.
   */
  refresh?: () => Promise<string>;
}

export interface RefreshingReadUrl {
  /** The url to read from right now. */
  readUrl: string | null;
  /** A reminted url that reads DIFFERENT bytes, held back rather than shown. */
  replacedBy: string | null;
  /** Show the replacement, once the reader has been told there is one. */
  showReplacement: () => void;
}

/**
 * Keeps a short-lived read url usable for as long as a document is being read.
 *
 * A signed read url lapses in minutes and a long document is read for longer
 * than that, so it has to be reminted underneath the viewer. Two rules make that
 * safe, and both are easy to get wrong in a way nothing on screen reveals:
 *
 * A remint is a fresh authorization, not a refresh of a token already held. The
 * minter runs the same checks the original grant did, so access revoked in the
 * meantime ends the read instead of being extended by it.
 *
 * A remint that comes back pointing at a different version of the object is NOT
 * swapped in. Doing so replaces the pages under the reader with different pages
 * carrying the same numbers, which is indistinguishable from the document they
 * opened. It is held back and reported instead, and the reader decides.
 */
export function useRefreshingReadUrl({
  url,
  enabled,
  refresh,
}: RefreshingReadUrlOptions): RefreshingReadUrl {
  const [readUrl, setReadUrl] = useState<string | null>(url);
  const [replacedBy, setReplacedBy] = useState<string | null>(null);

  // Adjusting state during render rather than in an effect: a url the caller
  // resolved is the document to show, and showing the previous one for a frame
  // first is exactly the swap this hook exists to prevent.
  const [resolved, setResolved] = useState<string | null>(url);
  if (resolved !== url) {
    setResolved(url);
    setReadUrl(url);
    setReplacedBy(null);
  }

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled || !readUrl || !refreshRef.current) return;
    // A url that does not say when it lapses is left alone: reminting on a guess
    // would mean a request every few minutes for a url that may never expire.
    const delay = msUntilReadUrlRefresh(readUrl, Date.now());
    if (delay == null) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      refreshRef.current?.()
        .then((next) => {
          if (cancelled || !next) return;
          if (readUrlVersionChanged(readUrl, next)) setReplacedBy(next);
          else setReadUrl(next);
        })
        .catch(() => {
          // The reader keeps the url they have. It works until it lapses, and a
          // failed read then surfaces through the viewer's own error path
          // rather than being pre-empted by a message about a background
          // request they never made.
        });
    }, delay);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [enabled, readUrl]);

  const showReplacement = useCallback(() => {
    if (!replacedBy) return;
    setReadUrl(replacedBy);
    setReplacedBy(null);
  }, [replacedBy]);

  return { readUrl, replacedBy, showReplacement };
}
