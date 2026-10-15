"use client";

import { useCallback, useRef, useState } from "react";
import type { SortState } from "@/components/ui/SortableTh";

interface Page<Row, Stats> { rows: Row[]; totalItems: number; stats: Stats }

/** Paged admin directory state with a generation guard against stale filter responses. */
export default function useAdminDirectoryData<Row, Stats>(initialStats: Stats) {
  const [rows, setRows] = useState<Row[]>([]);
  const [stats, setStats] = useState(initialStats);
  const [totalItems, setTotalItems] = useState(0);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ field: "createdAt", direction: "desc" });
  const requestIdRef = useRef(0);
  const load = useCallback(async (readPage: () => Promise<Page<Row, Stats>>) => {
    const requestId = ++requestIdRef.current;
    setLoadingData(true);
    setError(null);
    try {
      const result = await readPage();
      if (requestId !== requestIdRef.current) return;
      setRows(result.rows);
      setTotalItems(result.totalItems);
      setStats(result.stats);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setError(error instanceof Error ? error.message : "Something went wrong. Please try again.");
    } finally {
      if (requestId === requestIdRef.current) setLoadingData(false);
    }
  }, []);
  return { rows, setRows, stats, setStats, totalItems, loadingData, error, setError, page, setPage, rowsPerPage, setRowsPerPage, search, setSearch, sort, setSort, load };
}
