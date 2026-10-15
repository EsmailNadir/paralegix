"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { ArrowRight, type LucideIcon } from "lucide-react";
import ParalegixLogo from "@/components/ui/ParalegixLogo";
import Spinner from "@/components/ui/Spinner";
import { useInAppShell } from "@/contexts/AppShellContext";

interface StatusAction {
  label: string;
  href?: string;
  onClick?: () => void;
  icon?: LucideIcon;
  loading?: boolean;
  disabled?: boolean;
  variant?: "primary" | "secondary";
}

interface StatusPageProps {
  badge: string;
  title: string;
  description: string;
  code?: string;
  Icon: LucideIcon;
  primaryAction?: StatusAction;
  secondaryAction?: StatusAction;
  details?: string;
  children?: React.ReactNode;
}

/**
 * Every status screen (404, 403, offline, maintenance, upgrade required, ...) uses the
 * app's interaction palette rather than a per-status colour, so an error page still
 * reads as Paralegix instead of as a generic browser warning. Severity is carried by the
 * badge, code, and icon.
 */
const palette = {
  badge: "border-accent-border-soft bg-accent-soft text-accent-emphasis dark:text-accent-emphasis",
  iconWrap: "bg-accent-soft ring-focus-ring",
  icon: "text-accent-emphasis dark:text-accent-emphasis",
  orbA: "from-accent-solid/16 via-accent-solid/8 to-transparent",
  orbB: "from-accent-solid/12 via-accent-solid/6 to-transparent",
  ring: "ring-focus-ring/12",
  primaryButton: "bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover",
};

function ActionButton({ action }: { action: StatusAction }) {
  const Icon = action.icon || ArrowRight;
  const baseClasses =
    "inline-flex items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-medium transition-all duration-200 active:scale-[0.96] motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-60";
  const variantClasses =
    action.variant === "secondary"
      ? "border border-outline bg-surface text-on-surface hover:bg-surface-hover"
      : palette.primaryButton;
  const classes = `${baseClasses} ${variantClasses}`;

  const content = (
    <>
      {action.loading ? (
        <Spinner size={16} />
      ) : (
        <Icon className="h-4 w-4" />
      )}
      <span>{action.label}</span>
    </>
  );

  if (action.href) {
    return (
      <Link href={action.href} className={classes}>
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={action.onClick}
      className={classes}
      disabled={action.disabled || action.loading}
    >
      {content}
    </button>
  );
}

export default function StatusPage({
  badge,
  title,
  description,
  code,
  Icon,
  primaryAction,
  secondaryAction,
  details,
  children,
}: StatusPageProps) {
  // A status screen always owns the whole window. Rendered inside the firm or
  // portal shell it would otherwise be laid out in the content pane and read as
  // a card sitting next to a sidebar that no longer leads anywhere useful, so
  // there it is pinned over the viewport (above the sidebar's z-40/z-50 chrome)
  // instead of flowing inside its container.
  const inShell = useInAppShell();
  const Container = inShell ? 'div' : 'main';
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, [title]);

  return (
    <Container
      className={
        inShell
          ? "fixed inset-0 z-[60] overflow-y-auto overscroll-contain bg-page"
          : "relative min-h-screen bg-page"
      }
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className={`absolute -left-20 top-0 h-80 w-80 rounded-full bg-gradient-to-br ${palette.orbA} blur-3xl`}
        />
        <div
          className={`absolute -right-16 bottom-0 h-96 w-96 rounded-full bg-gradient-to-br ${palette.orbB} blur-3xl`}
        />
      </div>
      <div className="relative mx-auto flex min-h-screen w-full max-w-3xl flex-col px-5 py-6 sm:px-8 sm:py-8">
        <div className="flex items-center justify-between gap-4">
          <Link
            href="/"
            className="inline-flex items-center rounded-full border border-outline-subtle bg-surface/90 px-4 py-2 backdrop-blur-sm transition-colors hover:bg-surface"
          >
            <ParalegixLogo width={150} height={38} priority />
          </Link>
          <div className="hidden rounded-full border border-outline-subtle bg-surface/80 px-4 py-2 text-xs font-medium text-on-surface-secondary backdrop-blur-sm sm:block">
            Paralegix system states
          </div>
        </div>

        <div className="flex flex-1 items-center py-10">
          <section
            className={`relative w-full overflow-hidden rounded-[32px] border border-outline-subtle bg-surface/92 px-6 py-10 text-center shadow-[0_24px_80px_rgba(15,23,42,0.10)] ring-1 ${palette.ring} backdrop-blur-sm sm:px-10 sm:py-12`}
          >
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent dark:via-white/10" />

            <div
              className={`mx-auto inline-flex h-16 w-16 items-center justify-center rounded-[22px] ring-1 ${palette.iconWrap}`}
            >
              <Icon className={`h-8 w-8 ${palette.icon}`} strokeWidth={1.8} />
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <span
                className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${palette.badge}`}
              >
                {badge}
              </span>
              {code ? (
                <span className="text-xs font-medium uppercase tracking-[0.18em] text-on-surface-muted">
                  {code}
                </span>
              ) : null}
            </div>

            <h1 ref={headingRef} tabIndex={-1} className="mx-auto mt-5 max-w-2xl text-balance font-[family:var(--font-instrument-serif)] text-4xl leading-tight text-on-surface sm:text-5xl">
              {title}
            </h1>
            <p className="mx-auto mt-4 max-w-lg text-pretty text-base leading-7 text-on-surface-secondary">
              {description}
            </p>

            {(primaryAction || secondaryAction) && (
              // Secondary sits left of primary, matching the app's Cancel/Confirm
              // button order. Stacked on mobile the order reverses so the primary
              // action stays on top, where the thumb lands first.
              <div className="mt-8 flex flex-col-reverse items-center justify-center gap-3 sm:flex-row">
                {secondaryAction ? (
                  <ActionButton action={{ ...secondaryAction, variant: "secondary" }} />
                ) : null}
                {primaryAction ? <ActionButton action={primaryAction} /> : null}
              </div>
            )}

            {details ? (
              <p className="mx-auto mt-8 max-w-lg text-xs leading-5 text-on-surface-muted">
                {details}
              </p>
            ) : null}

            {children ? <div className="mt-8">{children}</div> : null}
          </section>
        </div>
      </div>
    </Container>
  );
}
