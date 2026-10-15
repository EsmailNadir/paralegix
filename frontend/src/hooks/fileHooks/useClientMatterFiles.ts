"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import FilesService, { type FileInfo } from "@/services/files.service";
import type { Matter } from "@/types/matter";

export interface ClientMatterFilesResult {
  /**
   * matterId -> the matter's documents, folders removed. A matter holding no
   * documents is absent rather than present and empty, which is what the tab's
   * per-matter count reads.
   */
  files: Map<string, FileInfo[]>;
  /**
   * One matter's listing came back short. This tab is the firm's answer to
   * "what do we hold for this client", so a partial listing that reads as
   * complete is how a document gets treated as never uploaded.
   */
  truncated: boolean;
  loading: boolean;
  /** Re-read, for after an upload lands. */
  reload: () => Promise<void>;
}

/**
 * The documents of every matter on the client Documents tab, read lazily the
 * first time the tab is opened.
 *
 * ONE request covers the whole list. The tab used to call `/files/list` once per
 * matter through `Promise.all`, so a corporate client with eighty matters fired
 * eighty simultaneous listings from a single tab click, each holding one of the
 * API instance's twelve shared Postgres connections. `/files/list-matters`
 * answers for a whole set of matters, so the request count now tracks the cap
 * rather than the size of the client.
 *
 * A matter the caller may not read is absent from the response. That is the
 * batch equivalent of the 403 the per-matter route answered, and it lands here
 * as the same "no documents" the old per-matter `catch` produced.
 */
export default function useClientMatterFiles({
  lawFirmId,
  matters,
  enabled,
}: {
  lawFirmId: string;
  matters: Matter[];
  enabled: boolean;
}): ClientMatterFilesResult {
  const [files, setFiles] = useState<Map<string, FileInfo[]>>(new Map());
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    if (matters.length === 0) return;
    setLoading(true);
    try {
      const matterIds = matters.map((clientMatter) => clientMatter.id);
      const pages = await FilesService.listMatterFilesBatch(lawFirmId, matterIds);

      const fileMap = new Map<string, FileInfo[]>();
      let anyTruncated = false;
      for (const matterId of matterIds) {
        const page = pages[matterId];
        if (!page) continue;
        if (page.truncated) anyTruncated = true;
        const actualFiles = (page.files || []).filter((f) => !f.isFolder);
        if (actualFiles.length > 0) fileMap.set(matterId, actualFiles);
      }
      setFiles(fileMap);
      // One short listing makes the combined view short, so the warning covers
      // the whole tab rather than the matter it came from.
      setTruncated(anyTruncated);
    } catch {
      // Silently fail: the tab keeps whatever it already showed rather than
      // painting an error over a client's documents.
    } finally {
      setLoading(false);
      loadedRef.current = true;
    }
  }, [lawFirmId, matters]);

  useEffect(() => {
    if (enabled && !loadedRef.current) void load();
  }, [enabled, load]);

  const reload = useCallback(async () => {
    loadedRef.current = false;
    await load();
  }, [load]);

  return { files, truncated, loading, reload };
}
