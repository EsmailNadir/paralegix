"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import signaturesService from "@/services/signatures.service";
import type { SigningTemplate } from "@/types/signature";

const dirtyKey = (lawFirmId: string) => `signingTemplatesDirty_${lawFirmId}`;

// The signing editor (/signature) lives outside the law-firm QueryClient, so it
// can't invalidate this cache directly. Instead it flags the firm's template
// list as dirty here; useSigningTemplates honors the flag on its next mount.
export function markSigningTemplatesDirty(lawFirmId?: string) {
  if (!lawFirmId || typeof window === "undefined") return;
  try { window.sessionStorage?.setItem(dirtyKey(lawFirmId), "1"); } catch {}
}

// Signing templates for a firm, cached and shared across the signatures page and
// the dedicated templates page so navigating between them serves from cache
// instead of re-issuing an un-deduped GET on every mount. `enabled: false` holds
// the read back while the signatures page's workspace request is filling it.
export function useSigningTemplates(lawFirmId?: string, { enabled = true }: { enabled?: boolean } = {}) {
  const { data, isLoading, error, refetch } = useQuery<SigningTemplate[]>({
    queryKey: ["signingTemplates", lawFirmId],
    queryFn: async () => {
      const res = await signaturesService.listSigningTemplates(lawFirmId!);
      return res.templates || [];
    },
    enabled: enabled && !!lawFirmId,
    staleTime: 60_000,
  });

  // Force a refetch on mount if the editor flagged a just-saved template, so it
  // appears immediately instead of waiting out staleTime.
  useEffect(() => {
    if (!lawFirmId || typeof window === "undefined") return;
    if (window.sessionStorage?.getItem(dirtyKey(lawFirmId)) === "1") {
      try { window.sessionStorage.removeItem(dirtyKey(lawFirmId)); } catch {}
      refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch identity is stable; run once per firm on mount
  }, [lawFirmId]);

  return {
    templates: data ?? [],
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to load templates") : null,
    refetch,
  };
}

// Invalidate the cached template list after a create/update/delete within the
// law-firm QueryClient (same-app mutations, not the cross-route editor).
