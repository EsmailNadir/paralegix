"use client";

import { useCallback, useRef, useState } from "react";
import type { FileInfo } from "@/services/files.service";
import { getErrorMessage } from "@/lib/utils/apiErrors";

type Listing = { files?: FileInfo[]; truncated?: boolean };

/** The latest browse or search request owns the rows, regardless of response order. */
export default function useFolderBrowser(failureMessage: string) {
  const [items, setItems] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const folderId = trail.length ? trail[trail.length - 1].id : undefined;
  const openFolder = (id: string, name: string) => setTrail((previous) => [...previous, { id, name }]);
  const navigateFolder = (index: number) => {
    const next = index < 0 ? [] : trail.slice(0, index + 1);
    setTrail(next);
    return next.length ? next[next.length - 1].id : undefined;
  };
  const requestIdRef = useRef(0);
  const load = useCallback(async (request: () => Promise<Listing>, filter?: (item: FileInfo) => boolean, onResult?: (listing: Listing | null) => void) => {
    const requestId = ++requestIdRef.current;
    const isCurrent = () => requestIdRef.current === requestId;
    setLoading(true);
    setError(null);
    try {
      const response = await request();
      if (!isCurrent()) return;
      const rows = response.files || [];
      setItems(filter ? rows.filter(filter) : rows);
      onResult?.(response);
      setTruncated(!!response.truncated);
    } catch (err) {
      if (!isCurrent()) return;
      onResult?.(null);
      setError(getErrorMessage(err, failureMessage));
      setItems([]);
      setTruncated(false);
    } finally {
      if (isCurrent()) { setLoading(false); setLoaded(true); }
    }
  }, [failureMessage]);
  return { items, setItems, loading, setLoading, loaded, setLoaded, error, setError, truncated, setTruncated, requestIdRef, load, trail, setTrail, folderId, openFolder, navigateFolder };
}
