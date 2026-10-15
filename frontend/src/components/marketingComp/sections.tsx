"use client";

import { Btn, DotOk } from "./primitives";

/** Centered section header: eyebrow + serif title (with optional italic <em>) + sub. */
export function SectionHead({
  eyebrow,
  children,
  sub,
  className = "",
}: {
  eyebrow: string;
  children: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`mx-auto mb-14 max-w-[640px] text-center ${className}`}>
      <div className="mb-4 text-[13px] font-semibold uppercase tracking-[0.05em] text-mkt-accent-deep">
        {eyebrow}
      </div>
      <h2 className="font-mkt-serif text-[clamp(30px,3.4vw,44px)] font-medium leading-[1.08] tracking-[-0.015em] text-balance">
        {children}
      </h2>
      {sub && <p className="mt-[18px] text-[18px] leading-[1.55] text-mkt-ink-2 text-pretty">{sub}</p>}
    </div>
  );
}

/** Italic accent emphasis used inside serif headings. */
export function Em({ children }: { children: React.ReactNode }) {
  return <em className="italic text-mkt-accent-deep">{children}</em>;
}

/** Dark final call-to-action panel with a radial brass glow. */
export function FinalCTA({
  title,
  sub,
  note,
  primary = { label: "Start free", href: "/register" },
  secondary,
}: {
  title: React.ReactNode;
  sub: string;
  note?: string[];
  primary?: { label: string; href: string };
  secondary?: { label: string; href: string };
}) {
  return (
    <section className="px-[4vw] pb-0 pt-16 min-[981px]:pt-24">
      <div className="mx-auto w-[min(1180px,92vw)]">
        <div className="relative overflow-hidden rounded-[28px] bg-mkt-ink px-6 py-14 text-center text-mkt-paper min-[981px]:px-10 min-[981px]:py-[84px]">
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(700px 320px at 50% -10%, color-mix(in srgb, oklch(0.60 0.085 72) 22%, transparent), transparent 70%)",
            }}
          />
          <h2 className="relative font-mkt-serif text-[clamp(32px,4vw,50px)] font-medium leading-[1.08] tracking-[-0.015em] text-balance">
            {title}
          </h2>
          <p className="relative mt-[18px] text-[18px]" style={{ color: "rgba(247,244,237,0.68)" }}>
            {sub}
          </p>
          <div className="relative mt-8 flex flex-wrap items-center justify-center gap-4">
            <Btn variant="accent" size="lg" href={primary.href}>
              {primary.label}
            </Btn>
            {secondary && (
              <Btn
                variant="ghost"
                size="lg"
                href={secondary.href}
                className="!border-[rgba(247,244,237,0.45)] !text-mkt-paper hover:!border-mkt-paper hover:!bg-[rgba(247,244,237,0.10)]"
              >
                {secondary.label}
              </Btn>
            )}
          </div>
          {note && (
            <div
              className="relative mt-5 flex flex-wrap items-center justify-center gap-[18px] text-[13.5px] font-medium"
              style={{ color: "rgba(247,244,237,0.6)" }}
            >
              {note.map((n) => (
                <span key={n} className="inline-flex items-center gap-[7px]">
                  <DotOk /> {n}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
