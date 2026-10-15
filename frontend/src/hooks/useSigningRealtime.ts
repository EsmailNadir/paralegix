"use client";

import { useEffect } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { authorizeRealtime, getRealtimeClient, onRealtimeResume, retainRealtime, releaseRealtime } from '@/lib/supabase/realtimeClient';
import { deferWhileHidden } from '@/lib/supabase/deferWhileHidden';

interface SigningRealtimeFilter {
  /** Supabase table to subscribe to. */
  table: 'signature_participants' | 'signature_sessions';
  /** Column used to scope the postgres_changes filter. */
  column: string;
  /** Value the column must equal (e.g. the firebase uid or law firm id). */
  value: string | null | undefined;
}

interface UseSigningRealtimeOptions {
  filter: SigningRealtimeFilter;
  /** Called (debounced) whenever a relevant row changes. */
  onChange: () => void;
}

/**
 * Generic Supabase Realtime subscription used as a CHANGE TRIGGER for signing
 * data. Mirrors the messaging Realtime pattern in `useConversations`:
 *
 * - exchanges the Firebase ID token for a Supabase JWT via `authorizeRealtime()`
 * - subscribes to `postgres_changes` on the given table, scoped by
 *   `filter: '<column>=eq.<value>'`
 * - calls a debounced `onChange()` on any event so the caller can REST-refetch
 *   the authoritative data (the REST API remains the single source of truth)
 * - holds `onChange()` back while the tab is hidden and runs it once when the
 *   tab is visible again, so a background tab does not refetch on every change
 * - reopens the channel and refetches once when `onRealtimeResume` reports that
 *   the token lapsed in a hidden tab, which is when the server drops the channel
 *
 * SSR-guarded: returns early when `getRealtimeClient()` is null. The channel is
 * removed on unmount, and the auth-refresh/reconnect handling lives inside
 * `authorizeRealtime()` (it reschedules its own token refresh).
 */
export function useSigningRealtime({ filter, onChange }: UseSigningRealtimeOptions) {
  const { table, column, value } = filter;

  useEffect(() => {
    if (typeof window === 'undefined' || !value) return;
    // SSR / misconfiguration guard, no realtime client available.
    if (!getRealtimeClient()) return;

    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Mark an active subscriber so the shared JWT refresh timer runs while this
    // channel is open and stops once it (and every other channel) is gone.
    retainRealtime();

    const refetch = deferWhileHidden(() => {
      if (cancelled) return;
      try {
        onChange();
      } catch (err) {
        if (process.env.NODE_ENV === 'development') {
          console.error('Signing realtime onChange error:', err);
        }
      }
    });

    const triggerChange = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (cancelled) return;
        refetch.run();
      }, 300);
    };

    const subscribe = async () => {
      const supabase = await authorizeRealtime();
      if (cancelled || !supabase) return;
      // A resume can reopen while an earlier open is still resolving; keep one.
      if (channel) supabase.removeChannel(channel);

      // RLS scopes the rows this JWT can see; the column filter narrows the
      // subscription further so only relevant changes wake the callback.
      channel = supabase
        .channel(`signing:${table}:${column}:${value}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table,
            filter: `${column}=eq.${value}`,
          },
          () => triggerChange(),
        )
        .subscribe();
    };

    subscribe();

    // Changes made while the channel was down were never delivered, so replace
    // the channel and re-read once.
    const stopResume = onRealtimeResume(() => {
      if (cancelled) return;
      subscribe();
      triggerChange();
    });

    return () => {
      cancelled = true;
      stopResume();
      refetch.dispose();
      if (debounceTimer) clearTimeout(debounceTimer);
      if (channel) {
        getRealtimeClient()?.removeChannel(channel);
      }
      releaseRealtime();
    };
  }, [table, column, value, onChange]);
}

/**
 * Subscribe to signing participant changes for a single client (by their
 * Firebase uid). Fires `onChange` when any of the client's participant rows
 * change (e.g. a new document is routed to them, or their status updates).
 */
export function useClientSigningRealtime(clientUid: string | null | undefined, onChange: () => void) {
  useSigningRealtime({
    filter: { table: 'signature_participants', column: 'client_user_id', value: clientUid },
    onChange,
  });
}

/**
 * Subscribe to signing session changes for a law firm. Fires `onChange` when
 * any session belonging to the firm changes (created, advanced, completed, etc.).
 */
export function useFirmSigningRealtime(lawFirmId: string | null | undefined, onChange: () => void) {
  useSigningRealtime({
    filter: { table: 'signature_sessions', column: 'law_firm_id', value: lawFirmId },
    onChange,
  });
}
