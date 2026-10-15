"use client";

import { useState, useCallback } from "react";
import { useBillingTimer } from "@/contexts/BillingTimerContext";
import { useAuth } from "@/hooks/useAuth";
import type { TimerPrefill } from "@/components/billingComp/TimeEntryModal";
import { taskTimerTarget } from "@/constants/taskConstants";

export interface EntityBillingContext {
  matterId?: string | null;
  clientId?: string | null;
  clientIds?: string[];
  /** Names the running timer; see `taskTimerTarget`. */
  matterName?: string | null;
  /** Positional with `clientIds`, for naming a timer on a single client. */
  clientNames?: string[];
  sourceTaskId?: string | null;
  sourceTaskTitle?: string | null;
  title: string;
  description?: string | null;
}

export function useEntityBillingActions(context: EntityBillingContext | null) {
  const { user } = useAuth();
  const billingTimer = useBillingTimer();
  const [addTimeEntryOpen, setAddTimeEntryOpen] = useState(false);
  const [timeEntryPrefill, setTimeEntryPrefill] = useState<TimerPrefill | null>(null);

  const handleLogTime = useCallback(() => {
    if (!context) return;

    const primaryClientId =
      context.clientId || (context.clientIds && context.clientIds.length > 0 ? context.clientIds[0] : null);

    setTimeEntryPrefill({
      matterId: context.matterId || null,
      clientId: !context.matterId ? primaryClientId : null,
      userId: user?.uid || null,
      name: context.title,
      description: context.description || undefined,
      sourceTaskId: context.sourceTaskId || null,
      sourceTaskTitle: context.sourceTaskTitle || undefined,
      sourceMatterId: context.matterId || null,
      sourceClientIds: context.clientIds || (primaryClientId ? [primaryClientId] : []),
    });
    setAddTimeEntryOpen(true);
  }, [context, user]);

  // Same target rule as the tasks grid: the matter, else exactly one client.
  // With neither there is nothing to bill against, so no timer starts and the
  // caller offers Log Time, whose modal can ask where the time belongs.
  const handleStartTimer = useCallback(() => {
    if (!context) return;

    const clientIds = context.clientIds?.length
      ? context.clientIds
      : context.clientId ? [context.clientId] : [];
    const target = taskTimerTarget({
      matterId: context.matterId,
      matterName: context.matterName,
      clientIds,
      clientNames: context.clientNames,
    });
    if (!target) return;

    billingTimer.startTimer({
      matterId: target.matterId,
      clientId: target.clientId,
      targetLabel: target.label || context.title,
      name: context.title,
      description: context.description || "",
      sourceTaskId: context.sourceTaskId || null,
      sourceTaskTitle: context.sourceTaskTitle || undefined,
      sourceMatterId: context.matterId || null,
      sourceClientIds: clientIds,
    });
  }, [billingTimer, context]);

  return {
    addTimeEntryOpen,
    setAddTimeEntryOpen,
    timeEntryPrefill,
    setTimeEntryPrefill,
    handleLogTime,
    handleStartTimer,
  };
}
