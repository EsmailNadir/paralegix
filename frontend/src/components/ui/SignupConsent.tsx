"use client";

import Link from 'next/link';
import type { MouseEvent } from 'react';

const LINK_CLASS =
  "text-accent-emphasis hover:text-accent-emphasis-hover font-medium transition-colors cursor-pointer";

/**
 * The agreement line under every sign-up form. It points to where product
 * analytics is explained and turned off, without treating sign-up as consent to
 * analytics: that choice is made separately, in the cookie banner. The page owns
 * navigation because each sign-up form shows its own leaving state before
 * routing.
 */
export default function SignupConsent({
  onNavigate,
  className = "",
}: {
  onNavigate: (path: "/terms" | "/privacy") => void;
  className?: string;
}) {
  const navigate = (event: MouseEvent<HTMLAnchorElement>, path: '/terms' | '/privacy') => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(path);
  };
  return (
    <p className={`text-center text-[10px] text-on-surface-muted leading-relaxed ${className}`}>
      By creating an account, you agree to our{" "}
      <Link href="/terms" onClick={(event) => navigate(event, '/terms')} className={LINK_CLASS}>
        Terms of Service
      </Link>{" "}
      and acknowledge our{" "}
      <Link href="/privacy" onClick={(event) => navigate(event, '/privacy')} className={LINK_CLASS}>
        Privacy Policy
      </Link>
      , which explains our product analytics and how to turn it off.
    </p>
  );
}
