"use client";

import Link from "next/link";
import ParalegixLogo from "@/components/ui/ParalegixLogo";
import CookieSettingsLink from "@/components/ui/CookieSettingsLink";

type FootLink = { label: string; href: string };

const COLS: { title: string; links: FootLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "/features" },
      { label: "Workflow", href: "/workflow" },
      { label: "Pricing", href: "/pricing" },
      { label: "Security", href: "/#security" },
    ],
  },
  {
    title: "Get started",
    links: [
      { label: "Create an account", href: "/register" },
      { label: "Sign in", href: "/login" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy Policy", href: "/privacy" },
      { label: "Terms of Service", href: "/terms" },
    ],
  },
];

export default function MarketingFooter() {
  return (
    <footer className="mt-24 border-t border-mkt-line bg-mkt-paper pt-[72px] pb-10">
      <div className="mx-auto w-[min(1180px,92vw)]">
        <div className="grid gap-10 md:grid-cols-[1.6fr_1fr_1fr_1fr]">
          <div>
            <div className="mb-4">
              <ParalegixLogo width={150} height={38} forceTheme="light" />
            </div>
            <p className="max-w-[26em] text-sm leading-relaxed text-mkt-ink-2">
              The intelligent workspace for modern law firms: matter management, billing,
              documents, and deadlines, finally connected.
            </p>
          </div>

          {COLS.map((col) => (
            <div key={col.title}>
              <h5 className="mb-4 text-[13px] font-bold uppercase tracking-[0.04em] text-mkt-ink-3">
                {col.title}
              </h5>
              {col.links.map((l) => (
                <Link
                  key={l.label}
                  href={l.href}
                  className="mb-[11px] block text-left text-[14.5px] text-mkt-ink-2 transition-colors hover:text-mkt-ink"
                >
                  {l.label}
                </Link>
              ))}
            </div>
          ))}
        </div>

        <p className="mt-14 border-t border-mkt-line-2 pt-7 text-[13px] text-mkt-ink-3">
          Paralegix is a software tool, not a law firm, and does not provide legal advice.
        </p>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 text-[13.5px] text-mkt-ink-3">
          <div>© {new Date().getFullYear()} Paralegix, Inc. All rights reserved.</div>
          <div className="flex gap-6">
            <Link href="/privacy" className="hover:text-mkt-ink">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-mkt-ink">
              Terms
            </Link>
            <Link href="/#security" className="hover:text-mkt-ink">
              Security
            </Link>
            <CookieSettingsLink className="hover:text-mkt-ink" />
          </div>
        </div>
      </div>
    </footer>
  );
}
