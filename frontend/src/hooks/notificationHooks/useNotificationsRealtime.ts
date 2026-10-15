"use client";

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  authorizeRealtime,
  getRealtimeClient,
  retainRealtime,
  releaseRealtime,
  onRealtimeResume,
} from "@/lib/supabase/realtimeClient";
import { deferWhileHidden, type HiddenDeferral } from "@/lib/supabase/deferWhileHidden";
import { useAuth } from "@/hooks/useAuth";
import { COUNT_QUERY_KEY, FEED_QUERY_KEY } from "./useNotifications";

// A single shared Supabase channel backs every mount of this hook for the
// current user. NotificationBell renders in several responsive layout slots at
// once (mobile top bar, mobile drawer, desktop sidebar, all mounted in the DOM
// and merely toggled with CSS), so a naive per-mount subscription would open
// multiple channels with the SAME topic (`notifications:<uid>`) on the shared
// realtime client and tear each other down on unmount. Instead we refcount:
// each mount registers a listener that invalidates its own query caches on any
// change, retains the realtime client, and bumps refCount.
//
// The channel is keyed on the uid it was opened for (`currentChannelUid`). On
// mount we open the channel if there is none OR the live channel is for a
// different uid; the last mount (refCount === 0) closes it. Keying on uid is
// what makes an account switch correct: when `uid` changes in place, React runs
// cleanup→setup per mount, so with several mounts alive refCount oscillates and
// never reaches 0. A plain "open at 1 / close at 0" scheme would leave the
// channel pinned to the OLD uid and the new user would get no realtime updates.
// The uid check tears down the stale-uid channel and reopens for the new uid
// exactly once, regardless of how many mounts are live.
//
// Module-level singleton state. NOTE: this persists across Next.js Fast Refresh
// in dev (HMR re-runs the module body but components don't fully remount), which
// can transiently desync refCount in development only; a production full reload
// always resets it cleanly.
let sharedChannel: RealtimeChannel | null = null;
let currentChannelUid: string | null = null;
let refCount = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
// Listeners are registered per firm: the channel is keyed on the uid alone (a
// Realtime subscription takes ONE filter, and it has to be the uid for RLS to
// line up), so a user who belongs to several firms receives rows for all of
// them. Each listener therefore states which firm it cares about and is only
// invoked for rows in that firm - otherwise a user working in firm A would get
// toasts for firm B and be navigated out of their current firm on click.
// Each carries its QueryClient so the fan-out can invalidate a firm's caches
// once per client, however many mounts share it.
const listeners = new Set<{ lawFirmId: string; queryClient: QueryClient; onChange?: () => void }>();
// Separate set of "a new notification row arrived" listeners, fired immediately
// (not debounced) on INSERT with the raw DB row. Used by the global toaster to
// surface a transient toast; most mounts (the bells) register nothing here.
const newRowListeners = new Set<{ lawFirmId: string; fn: (row: any) => void }>();
// Firms touched since the last debounced fan-out. A burst can span firms, so the
// set (not a single id) is what decides which listeners actually need to run.
let pendingFirmIds = new Set<string>();
// Sentinel firm id meaning "notify every listener regardless of firm".
const ALL_FIRMS = "*";
// Bumped on every close; an in-flight open captures the generation before its
// await and aborts if a close/reopen (e.g. a uid change) happened meanwhile, so
// a slow open for an old uid can never overwrite the channel for the new uid.
let openGeneration = 0;
// Live while any mount is: holds the fan-out back in a hidden tab (see
// `deferWhileHidden`), and reopens the channel when the realtime token lapsed
// while hidden, which is when the server drops it.
let fanOutDeferral: HiddenDeferral | null = null;
let stopResume: (() => void) | null = null;
// The uid the latest mount asked for, so a resume can reopen a channel whose
// first open never completed.
let requestedUid: string | null = null;

// Debounced fan-out: a burst of row changes (e.g. a bulk action) collapses to
// one invalidation per firm and QueryClient rather than one per row, or one per
// mount (several bells and the toaster share a client). Only listeners whose
// firm was actually touched are invoked. A row with no readable law_firm_id
// (shouldn't happen: the column is NOT NULL and DELETEs carry the full old row
// under REPLICA IDENTITY FULL) falls back to notifying everyone, so a missed
// refresh is never the failure mode. In a hidden tab the touched firms keep
// accumulating and the fan-out runs once when the tab is visible again.
function scheduleInvalidate(lawFirmId?: string | null) {
  if (lawFirmId) pendingFirmIds.add(lawFirmId);
  else pendingFirmIds.add(ALL_FIRMS);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (fanOutDeferral) fanOutDeferral.run();
    else fanOut();
  }, 300);
}

function fanOut() {
  const firms = pendingFirmIds;
  pendingFirmIds = new Set<string>();
  if (firms.size === 0) return;
  const all = firms.has(ALL_FIRMS);
  const invalidated = new Map<QueryClient, Set<string>>();
  listeners.forEach((l) => {
    if (!all && !firms.has(l.lawFirmId)) return;
    const firmsForClient = invalidated.get(l.queryClient) ?? new Set<string>();
    if (!firmsForClient.has(l.lawFirmId)) {
      firmsForClient.add(l.lawFirmId);
      invalidated.set(l.queryClient, firmsForClient);
      l.queryClient.invalidateQueries({ queryKey: [COUNT_QUERY_KEY, l.lawFirmId] });
      l.queryClient.invalidateQueries({ queryKey: [FEED_QUERY_KEY, l.lawFirmId] });
    }
    l.onChange?.();
  });
}

// The token lapsed while the tab was hidden, so the server closed the channel
// and every row change since went undelivered: reopen it and re-read once.
function handleRealtimeResume() {
  const uid = currentChannelUid ?? requestedUid;
  if (refCount === 0 || !uid) return;
  closeSharedChannel();
  openSharedChannel(uid).catch((err) => {
    if (process.env.NODE_ENV === "development") {
      console.error("[useNotificationsRealtime] Failed to reopen channel:", err);
    }
  });
  scheduleInvalidate(null);
}

async function openSharedChannel(uid: string) {
  const gen = openGeneration;
  const supabase = await authorizeRealtime();
  if (!supabase) {
    // Realtime unavailable (missing env / token fetch failed); the backstop
    // poll still refreshes the badge. Surface it in dev for debuggability.
    if (process.env.NODE_ENV === "development") {
      console.warn("[useNotificationsRealtime] Realtime unavailable; using backstop poll.");
    }
    return;
  }
  // Abort if, while we awaited the token: a close happened (stale generation,
  // e.g. a uid change reopened for a different user), everyone unmounted, or
  // another mount already opened the channel. Prevents stale-uid / duplicate /
  // orphan channels.
  if (gen !== openGeneration || refCount === 0 || sharedChannel) return;

  currentChannelUid = uid;
  sharedChannel = supabase
    .channel(`notifications:${uid}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "notifications",
        // RLS already limits rows to this user; this filter additionally pins
        // the subscription so we only wake for our own rows.
        filter: `user_id=eq.${uid}`,
      },
      (payload) => {
        // DELETEs carry the old row (REPLICA IDENTITY FULL); everything else the
        // new one. Either way we need its firm to decide who cares.
        const row: any = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
        const rowFirmId: string | null = row?.law_firm_id ?? null;
        // Fire toast listeners immediately on a brand-new row, then run the
        // debounced cache invalidation for every change type.
        if (payload.eventType === "INSERT" && payload.new) {
          newRowListeners.forEach((l) => {
            if (rowFirmId && l.lawFirmId !== rowFirmId) return;
            try { l.fn(payload.new); } catch { /* a bad listener must not break realtime */ }
          });
        }
        scheduleInvalidate(rowFirmId);
      },
    )
    .subscribe();
}

function closeSharedChannel() {
  // Invalidate any in-flight open so it can't resurrect a channel after close.
  openGeneration += 1;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingFirmIds = new Set<string>();
  if (sharedChannel) {
    getRealtimeClient()?.removeChannel(sharedChannel);
    sharedChannel = null;
  }
  currentChannelUid = null;
}

/**
 * Subscribes to the current user's `notifications` rows via Supabase Realtime
 * and invalidates the unread-count + feed React Query caches on any change, so
 * the badge/feed update on push instead of waiting for the slow backstop poll.
 *
 * Safe to mount in multiple places at once (see the shared-channel note above):
 * every mount shares one refcounted channel. RLS (migration 0074) restricts the
 * JWT to the user's own rows; the `user_id` filter further pins the channel.
 *
 * Rows are additionally filtered to `lawFirmId` in the client: the subscription
 * spans every firm the user belongs to, and only this firm's changes should
 * reach the caller.
 *
 * `onNew` fires per inserted row (used by the toaster); `onChange` fires once
 * per debounced burst, for callers that hold their own list state rather than
 * reading the React Query caches this hook already invalidates.
 */
export function useNotificationsRealtime(
  lawFirmId?: string,
  options?: { onNew?: (row: any) => void; onChange?: () => void },
) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const uid = user?.uid;
  const onNew = options?.onNew;
  const onChange = options?.onChange;

  useEffect(() => {
    if (typeof window === "undefined" || !uid || !lawFirmId) return;

    const listener = { lawFirmId, queryClient, onChange };
    const newRowListener = onNew ? { lawFirmId, fn: onNew } : null;

    listeners.add(listener);
    if (newRowListener) newRowListeners.add(newRowListener);
    retainRealtime();
    refCount += 1;
    requestedUid = uid;
    if (!fanOutDeferral) fanOutDeferral = deferWhileHidden(fanOut);
    if (!stopResume) stopResume = onRealtimeResume(handleRealtimeResume);
    // Open the channel when there is none, or reopen it when the live channel is
    // for a different uid (account switch). On a uid change, close the stale-uid
    // channel first. closeSharedChannel bumps openGeneration (aborting any
    // in-flight open for the old uid), clears the debounce timer, and removes the
    // channel, then open for the new uid. The openGeneration guard inside
    // openSharedChannel still protects a slow open from resurrecting a stale uid.
    if (!sharedChannel || currentChannelUid !== uid) {
      if (sharedChannel) closeSharedChannel();
      openSharedChannel(uid).catch((err) => {
        if (process.env.NODE_ENV === "development") {
          console.error("[useNotificationsRealtime] Failed to open channel:", err);
        }
      });
    }

    return () => {
      listeners.delete(listener);
      if (newRowListener) newRowListeners.delete(newRowListener);
      refCount -= 1;
      if (refCount === 0) {
        closeSharedChannel();
        fanOutDeferral?.dispose();
        fanOutDeferral = null;
        stopResume?.();
        stopResume = null;
        requestedUid = null;
      }
      releaseRealtime();
    };
  }, [uid, lawFirmId, queryClient, onNew, onChange]);
}
