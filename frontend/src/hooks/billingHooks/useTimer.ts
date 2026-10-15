"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";

const STORAGE_KEY = "paralegix_timer";

export interface TimerState {
  isRunning: boolean;
  startedAt: number | null; // epoch ms when last resumed
  accumulatedMs: number; // total ms accumulated before current run
  /**
   * The firm the timer was started in. Persisted state is shared across firms in
   * one browser, so without this a timer started in firm A would resurface in
   * firm B still pointing at firm A's matter.
   */
  lawFirmId?: string | null;
  matterId?: string | null;
  clientId?: string | null;
  targetLabel: string;
  name: string;
  description: string;
  chargeCodeId?: string | null;
  sourceTaskId?: string | null;
  sourceTaskTitle?: string | null;
  sourceEventId?: string | null;
  sourceEventTitle?: string | null;
  /**
   * The billing scope the source task itself belongs to. Carried through the timer
   * so that when the user picks a target at stop time, the modal can tell whether
   * that choice is compatible with the task and keep the link instead of dropping it.
   */
  sourceMatterId?: string | null;
  sourceClientIds?: string[] | null;
}

export interface TimerStartParams {
  matterId?: string | null;
  clientId?: string | null;
  targetLabel: string;
  name?: string;
  description?: string;
  chargeCodeId?: string | null;
  sourceTaskId?: string | null;
  sourceTaskTitle?: string | null;
  sourceEventId?: string | null;
  sourceEventTitle?: string | null;
  /**
   * The billing scope the source task itself belongs to. Carried through the timer
   * so that when the user picks a target at stop time, the modal can tell whether
   * that choice is compatible with the task and keep the link instead of dropping it.
   */
  sourceMatterId?: string | null;
  sourceClientIds?: string[] | null;
}

export interface TimerResult {
  hours: number;
  matterId?: string | null;
  clientId?: string | null;
  name: string;
  description: string;
  chargeCodeId?: string | null;
  sourceTaskId?: string | null;
  sourceTaskTitle?: string | null;
  sourceEventId?: string | null;
  sourceEventTitle?: string | null;
  /**
   * The billing scope the source task itself belongs to. Carried through the timer
   * so that when the user picks a target at stop time, the modal can tell whether
   * that choice is compatible with the task and keep the link instead of dropping it.
   */
  sourceMatterId?: string | null;
  sourceClientIds?: string[] | null;
}

const EMPTY_STATE: TimerState = {
  isRunning: false,
  startedAt: null,
  accumulatedMs: 0,
  lawFirmId: null,
  matterId: null,
  clientId: null,
  targetLabel: "",
  name: "",
  description: "",
  chargeCodeId: null,
  sourceTaskId: null,
  sourceTaskTitle: null,
  sourceEventId: null,
  sourceEventTitle: null,
  sourceMatterId: null,
  sourceClientIds: null,
};

function loadState(lawFirmId?: string): TimerState {
  if (typeof window === "undefined") return EMPTY_STATE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STATE;
    const parsed = JSON.parse(raw) as TimerState;
    // A timer belonging to another firm must not be adopted here: its matter and
    // client ids mean nothing in this firm. A record with no firm id cannot be
    // shown to belong here either, so it is discarded too.
    if (lawFirmId && parsed.lawFirmId !== lawFirmId) return EMPTY_STATE;
    return parsed;
  } catch {
    return EMPTY_STATE;
  }
}

function saveState(state: TimerState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage full or private browsing, ignore
  }
}

function clearState(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export default function useTimer(lawFirmId?: string) {
  const [state, setState] = useState<TimerState>(() => loadState(lawFirmId));
  const [tick, setTick] = useState(0); // forces re-render for elapsed time
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Persist every state change
  useEffect(() => {
    saveState(state);
  }, [state]);

  // Run interval when timer is active
  useEffect(() => {
    if (state.isRunning) {
      intervalRef.current = setInterval(() => {
        setTick((t) => t + 1);
      }, 1000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [state.isRunning]);

  const elapsedMs = useMemo(() => {
    // Use tick to force recalculation
    void tick;
    if (state.isRunning && state.startedAt) {
      return state.accumulatedMs + (Date.now() - state.startedAt);
    }
    return state.accumulatedMs;
  }, [state.isRunning, state.startedAt, state.accumulatedMs, tick]);

  const elapsedHours = elapsedMs / 3_600_000;

  const formattedTime = useMemo(() => {
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, [elapsedMs]);

  const isActive = state.isRunning || state.accumulatedMs > 0 || state.startedAt !== null;

  const start = useCallback((params: TimerStartParams) => {
    setState({
      isRunning: true,
      startedAt: Date.now(),
      accumulatedMs: 0,
      lawFirmId: lawFirmId || null,
      matterId: params.matterId || null,
      clientId: params.clientId || null,
      targetLabel: params.targetLabel,
      name: params.name || "",
      description: params.description || "",
      chargeCodeId: params.chargeCodeId || null,
      sourceTaskId: params.sourceTaskId || null,
      sourceTaskTitle: params.sourceTaskTitle || null,
      sourceEventId: params.sourceEventId || null,
      sourceEventTitle: params.sourceEventTitle || null,
      sourceMatterId: params.sourceMatterId || null,
      sourceClientIds: params.sourceClientIds || null,
    });
  }, [lawFirmId]);

  const pause = useCallback(() => {
    setState((prev) => {
      if (!prev.isRunning || !prev.startedAt) return prev;
      return {
        ...prev,
        isRunning: false,
        accumulatedMs: prev.accumulatedMs + (Date.now() - prev.startedAt),
        startedAt: null,
      };
    });
  }, []);

  const resume = useCallback(() => {
    setState((prev) => {
      if (prev.isRunning) return prev;
      return {
        ...prev,
        isRunning: true,
        startedAt: Date.now(),
      };
    });
  }, []);

  const stop = useCallback((): TimerResult => {
    const finalMs = state.isRunning && state.startedAt
      ? state.accumulatedMs + (Date.now() - state.startedAt)
      : state.accumulatedMs;

    const result: TimerResult = {
      hours: Math.round((finalMs / 3_600_000) * 100) / 100,
      matterId: state.matterId,
      clientId: state.clientId,
      name: state.name,
      description: state.description,
      chargeCodeId: state.chargeCodeId,
      sourceTaskId: state.sourceTaskId,
      sourceTaskTitle: state.sourceTaskTitle,
      sourceEventId: state.sourceEventId,
      sourceEventTitle: state.sourceEventTitle,
      sourceMatterId: state.sourceMatterId,
      sourceClientIds: state.sourceClientIds,
    };

    setState(EMPTY_STATE);
    clearState();
    return result;
  }, [state]);

  const discard = useCallback(() => {
    setState(EMPTY_STATE);
    clearState();
  }, []);

  const updateDescription = useCallback((desc: string) => {
    setState((prev) => ({ ...prev, description: desc }));
  }, []);

  return {
    ...state,
    elapsedMs,
    elapsedHours,
    formattedTime,
    isActive,
    start,
    pause,
    resume,
    stop,
    discard,
    updateDescription,
  };
}
