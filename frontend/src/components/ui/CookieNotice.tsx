"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  COOKIE_SETTINGS_EVENT,
  acceptAnalytics,
  declineAnalytics,
  getCachedConsentRegion,
  getConsentChoice,
  resolveConsentRegion,
} from "@/lib/analytics/consent";
import type { ConsentRegion } from "@/lib/analytics/consentRegion";
import { useLastOpenValue, useMountTransition } from "@/hooks/useMountTransition";
import { bannerAnim } from "@/components/ui/transitionClasses";

const ACK_KEY = "paralegix_cookie_notice_ack";

// Pages drawn in the marketing palette (warm paper and ink, no dark mode).
const MARKETING_PATHS = new Set(["/", "/pricing", "/features", "/workflow"]);
// Sign-in pages: marketing paper in light mode, the app surface in dark mode.
const AUTH_PATHS = new Set(["/login", "/register"]);

const STYLES = {
  app: {
    card: "rounded-xl border border-outline bg-surface shadow-xl",
    text: "text-sm text-on-surface-secondary",
    link: "text-accent-emphasis hover:text-accent-emphasis-hover",
    button:
      "rounded-md bg-accent-solid px-4 py-2 text-sm font-medium text-accent-foreground hover:bg-accent-solid-hover transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--surface)]",
  },
  marketing: {
    card: "rounded-[14px] border border-mkt-line bg-mkt-card font-mkt-sans shadow-mkt-md",
    text: "text-[14px] text-mkt-ink-2",
    link: "text-mkt-accent-deep hover:text-mkt-ink",
    button:
      "rounded-[10px] border border-transparent bg-mkt-ink px-5 py-[11px] text-[15px] font-semibold text-mkt-paper hover:bg-[#0e1925] hover:shadow-mkt-sm transition-[transform,background-color,box-shadow] duration-150 active:translate-y-px",
  },
  // Mirrors the sign-in card (`bg-mkt-card dark:bg-surface` in LoginClient).
  auth: {
    card: "rounded-xl border border-mkt-line dark:border-outline bg-mkt-card dark:bg-surface shadow-mkt-md dark:shadow-xl",
    text: "text-sm text-mkt-ink-2 dark:text-on-surface-secondary",
    link: "text-mkt-accent-deep hover:text-mkt-ink dark:text-accent-emphasis dark:hover:text-accent-emphasis-hover",
    button:
      "rounded-md bg-mkt-ink hover:bg-[#0e1925] dark:bg-accent-solid dark:hover:bg-accent-solid-hover px-4 py-2 text-sm font-medium text-mkt-paper dark:text-accent-foreground transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
  },
};

function styleFor(pathname: string | null) {
  if (MARKETING_PATHS.has(pathname ?? "")) return STYLES.marketing;
  if (AUTH_PATHS.has(pathname ?? "")) return STYLES.auth;
  return STYLES.app;
}

function readAck(): boolean {
  try {
    return localStorage.getItem(ACK_KEY) === "1";
  } catch {
    // localStorage unavailable (private mode, blocked); treat as dismissed.
    return true;
  }
}

// "notice" informs and is dismissed with Got it. "consent" asks: shown to
// visitors whose region needs a choice before analytics, and to anyone who
// opens Cookie settings.
type Mode = "notice" | "consent" | null;

function modeFor(region: ConsentRegion): Mode {
  if (getConsentChoice()) return null;
  if (region === "required") return "consent";
  return readAck() ? null : "notice";
}

export default function CookieNotice() {
  const [mode, setMode] = useState<Mode>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  const declineRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const focusChoiceRef = useRef(false);
  const pathname = usePathname();
  const style = styleFor(pathname);

  useEffect(() => {
    let mounted = true;
    const cached = getCachedConsentRegion();
    if (cached) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the stored region and choice (browser-only storage) after mount to avoid an SSR/hydration mismatch
      setMode(modeFor(cached));
    } else {
      resolveConsentRegion().then((region) => {
        if (mounted) setMode(modeFor(region));
      });
    }
    const openSettings = () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && !regionRef.current?.contains(active)) previousFocusRef.current = active;
      focusChoiceRef.current = true;
      if (declineRef.current && !regionRef.current?.inert) {
        declineRef.current.focus();
        focusChoiceRef.current = false;
      }
      setMode("consent");
    };
    window.addEventListener(COOKIE_SETTINGS_EVENT, openSettings);
    return () => {
      mounted = false;
      window.removeEventListener(COOKIE_SETTINGS_EVENT, openSettings);
    };
  }, []);

  const restoreFocus = () => {
    if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    previousFocusRef.current = null;
  };

  const acknowledge = () => {
    try {
      localStorage.setItem(ACK_KEY, "1");
    } catch {
      // Persisting acknowledgement is best-effort; dismiss regardless.
    }
    setMode(null);
    restoreFocus();
  };

  const choose = (accept: boolean) => {
    if (accept) acceptAnalytics();
    else declineAnalytics();
    setMode(null);
    restoreFocus();
  };

  // Stays mounted through the slide-away, showing the mode it was closed from.
  const open = mode !== null;
  const { mounted, exiting } = useMountTransition(open, 200);
  const shown = useLastOpenValue(open, mode);

  useEffect(() => {
    if (mode === 'consent' && mounted && focusChoiceRef.current && declineRef.current) {
      declineRef.current.focus();
      focusChoiceRef.current = false;
    }
  }, [mode, mounted]);

  if (!mounted || !shown) return null;

  const buttonBase = "shrink-0 inline-flex items-center justify-center cursor-pointer";

  return (
    <div
      ref={regionRef}
      role="region"
      aria-label="Cookie notice"
      aria-live="polite"
      aria-hidden={exiting || undefined}
      inert={exiting}
      onFocusCapture={(event) => {
        if (event.relatedTarget instanceof HTMLElement && !event.currentTarget.contains(event.relatedTarget)) previousFocusRef.current = event.relatedTarget;
      }}
      className="fixed inset-x-0 bottom-0 z-50 px-4 pb-4 pointer-events-none"
    >
      <div className={`mx-auto max-w-3xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 ${style.card} ${bannerAnim(exiting)} ${exiting ? "pointer-events-none" : "pointer-events-auto"}`}>
        <p className={`leading-relaxed flex-1 ${style.text}`}>
          {shown === "consent" ? (
            <>
              We use essential cookies and local storage to keep you signed in and remember your
              preferences. With your permission, we also use an analytics cookie, processed by our
              provider PostHog, to understand which features are used and your approximate location.
              We do not use advertising or cross-site tracking cookies. Learn more in our{" "}
            </>
          ) : (
            <>
              We use essential cookies and local storage to keep you signed in and remember your
              preferences. Analytics is on: an analytics cookie, provided by PostHog, helps us
              understand which features are used, and you can turn it off in{" "}
              <button
                type="button"
                onClick={() => { focusChoiceRef.current = true; setMode("consent"); }}
                className={`font-medium transition-colors cursor-pointer ${style.link}`}
              >
                Cookie settings
              </button>
              . We do not use advertising or cross-site tracking cookies. Learn more in our{" "}
            </>
          )}
          <a
            href="/privacy#cookies"
            className={`font-medium transition-colors ${style.link}`}
          >
            Privacy Policy
          </a>
          .
        </p>
        {shown === "consent" ? (
          <div className="flex shrink-0 gap-2">
            {/* Declining is given the same style as accepting: refusing must be as easy and as visible as agreeing. */}
            <button ref={declineRef} type="button" onClick={() => choose(false)} className={`${buttonBase} ${style.button}`}>
              Decline
            </button>
            <button type="button" onClick={() => choose(true)} className={`${buttonBase} ${style.button}`}>
              Accept
            </button>
          </div>
        ) : (
          <button type="button" onClick={acknowledge} className={`${buttonBase} ${style.button}`}>
            Got it
          </button>
        )}
      </div>
    </div>
  );
}
