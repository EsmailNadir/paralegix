"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import { identifyUser, resetAnalytics } from "@/lib/analytics/analytics";

// Keeps the analytics identity in step with Firebase auth: identifies on sign
// in, and resets on sign out or when a different user signs in on the same
// browser, so one person's events never carry over to the next.
export default function AnalyticsSession() {
  const { user, loading } = useAuth();
  const identifiedUserId = useRef<string | null>(null);

  useEffect(() => {
    if (loading) return;
    const uid = user?.uid ?? null;
    if (uid === identifiedUserId.current) return;

    if (identifiedUserId.current) resetAnalytics();
    if (uid) identifyUser(uid);
    identifiedUserId.current = uid;
  }, [loading, user]);

  return null;
}
