"use client";

import { openCookieSettings } from "@/lib/analytics/consent";

/**
 * Reopens the cookie banner as an accept/decline choice, so any visitor can turn
 * analytics off (or back on) after the banner has gone. The caller styles it to
 * match the footer or text it sits in.
 */
export default function CookieSettingsLink({ className = "" }: { className?: string }) {
  return (
    <button type="button" onClick={openCookieSettings} className={`cursor-pointer ${className}`}>
      Cookie settings
    </button>
  );
}
