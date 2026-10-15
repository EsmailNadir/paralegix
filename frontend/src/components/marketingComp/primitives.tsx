"use client";

import Link from "next/link";

/* ============================================================
   Shared primitives for the marketing pages.
   All styling uses the mkt- design tokens (see global.css).
   ============================================================ */

type BtnVariant = "solid" | "accent" | "ghost" | "link";

const BTN_BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] font-semibold cursor-pointer " +
  "transition-[transform,background-color,box-shadow,border-color,color] duration-150 active:translate-y-px";

const BTN_VARIANT: Record<BtnVariant, string> = {
  solid: "border border-transparent bg-mkt-ink text-mkt-paper hover:bg-[#0e1925] hover:shadow-mkt-sm",
  accent: "border border-transparent bg-mkt-accent text-white hover:bg-mkt-accent-deep",
  ghost: "border border-mkt-ink/35 bg-transparent text-mkt-ink hover:border-mkt-ink hover:bg-mkt-paper-2",
  link: "text-mkt-ink-2 hover:text-mkt-ink",
};

export function Btn({
  children,
  href,
  onClick,
  variant = "solid",
  size = "md",
  className = "",
}: {
  children: React.ReactNode;
  href?: string;
  onClick?: () => void;
  variant?: BtnVariant;
  size?: "md" | "lg";
  className?: string;
}) {
  const isHash = href?.startsWith("#");
  const isExternal = href?.startsWith("http") || href?.startsWith("mailto:");

  const sizing =
    variant === "link"
      ? "text-[15px]"
      : size === "lg"
        ? "px-7 py-[15px] text-base rounded-xl"
        : "px-5 py-[11px] text-[15px]";

  const cls = `${variant === "link" ? "" : BTN_BASE} ${BTN_VARIANT[variant]} ${sizing} ${className}`;

  if (href && (isHash || isExternal)) {
    return (
      <a href={href} onClick={onClick} className={cls}>
        {children}
      </a>
    );
  }

  if (href) {
    return <Link href={href} onClick={onClick} className={cls}>{children}</Link>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cls}
    >
      {children}
    </button>
  );
}

type BadgeTone = "open" | "disc" | "trial" | "ok";

const BADGE_TONE: Record<BadgeTone, React.CSSProperties> = {
  open: { background: "oklch(0.94 0.03 230)", color: "oklch(0.45 0.10 250)" },
  disc: { background: "oklch(0.94 0.04 78)", color: "oklch(0.50 0.085 70)" },
  trial: { background: "oklch(0.93 0.04 25)", color: "oklch(0.50 0.13 25)" },
  ok: { background: "oklch(0.93 0.05 155)", color: "oklch(0.42 0.10 155)" },
};

export function Badge({ children, tone = "open" }: { children: React.ReactNode; tone?: BadgeTone }) {
  return (
    <span
      className="inline-block rounded-md px-[9px] py-[3px] text-[10.5px] font-semibold"
      style={BADGE_TONE[tone]}
    >
      {children}
    </span>
  );
}

export function Check({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={3}>
      <path d="M5 12l5 5L20 6" />
    </svg>
  );
}

/** Small check inside an accent-soft chip, used in feature/pricing lists. */
export function CheckChip() {
  return (
    <span className="mt-px grid h-[18px] w-[18px] flex-none place-items-center rounded-[5px] bg-mkt-accent-soft text-mkt-accent-deep">
      <Check size={11} />
    </span>
  );
}

/** Inline eyebrow with a leading accent dash (hero / interior heads). */
export function DashEyebrow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`mb-[22px] inline-flex items-center gap-[9px] text-[13px] font-semibold uppercase tracking-[0.04em] text-mkt-accent-deep ${className}`}
    >
      <span className="h-[1.5px] w-[22px] bg-mkt-accent" />
      {children}
    </span>
  );
}

export function DotOk() {
  return <span className="inline-block h-[7px] w-[7px] rounded-full bg-mkt-ok" />;
}
