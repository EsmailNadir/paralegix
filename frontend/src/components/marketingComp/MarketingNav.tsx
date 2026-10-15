"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X, ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import ParalegixLogo from "@/components/ui/ParalegixLogo";
import { Btn } from "./primitives";
import SkipLink from "@/components/ui/SkipLink";

const LINKS = [
  { label: "Features", href: "/features" },
  { label: "Workflow", href: "/workflow" },
  { label: "Pricing", href: "/pricing" },
];

const ITEM_VARIANTS = {
  closed: { opacity: 0, y: -8 },
  open: { opacity: 1, y: 0 },
};

export default function MarketingNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const mobileId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);

  return (
    <header
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          toggleRef.current?.focus();
        }
      }}
      className="sticky top-0 z-50 border-b border-mkt-line-2"
      style={{
        background: "color-mix(in srgb, #f7f4ed 82%, transparent)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
      }}
    >
      <SkipLink />
      <div className="mx-auto flex h-[72px] w-[min(1180px,92vw)] items-center justify-between">
        <Link
          href="/"
          className="flex items-center"
          aria-label="Paralegix home"
        >
          <ParalegixLogo width={150} height={38} forceTheme="light" priority />
        </Link>

        {/* Desktop links */}
        <nav aria-label="Primary" className="hidden items-center gap-1 min-[981px]:flex">
          {LINKS.map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-lg px-[14px] py-2 text-[15px] font-medium transition-colors duration-150 ${
                  active
                    ? "bg-mkt-accent-soft text-mkt-accent-deep"
                    : "text-mkt-ink-2 hover:bg-mkt-paper-2 hover:text-mkt-ink"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>

        {/* Desktop CTA */}
        <div className="hidden items-center gap-3 min-[981px]:flex">
          <Btn variant="ghost" href="/login">
            Sign In
          </Btn>
          <Btn variant="solid" href="/register">
            Get Started
          </Btn>
        </div>

        {/* Mobile hamburger */}
        <button
          ref={toggleRef}
          type="button"
          className="grid h-10 w-10 place-items-center overflow-hidden text-mkt-ink min-[981px]:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls={mobileId}
        >
          <AnimatePresence initial={false} mode="wait">
            <motion.span
              key={open ? "close" : "open"}
              initial={{ rotate: -90, opacity: 0 }}
              animate={{ rotate: 0, opacity: 1 }}
              exit={{ rotate: 90, opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="grid place-items-center"
            >
              {open ? <X size={22} /> : <Menu size={22} />}
            </motion.span>
          </AnimatePresence>
        </button>
      </div>

      {/* Mobile drawer */}
      <motion.div
        key="mobile-drawer"
        initial={false}
        animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
        transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
        className={`overflow-hidden border-mkt-line-2 bg-mkt-paper min-[981px]:hidden ${open ? "border-t" : ""}`}
      >
        <motion.nav
          id={mobileId}
          aria-label="Mobile primary"
          aria-hidden={!open}
          inert={!open}
          className="flex flex-col gap-1 px-[4vw] pb-6 pt-3"
          initial="closed"
          animate={open ? "open" : "closed"}
          variants={{
            open: { transition: { staggerChildren: 0.05, delayChildren: 0.08 } },
            closed: { transition: { staggerChildren: 0.03, staggerDirection: -1 } },
          }}
        >
          {LINKS.map((l) => {
            const active = pathname === l.href;
            return (
              <motion.div
                key={l.href}
                variants={ITEM_VARIANTS}
              >
                <Link
                  href={l.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => {
                    setOpen(false);
                  }}
                  className={`group flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-left text-[16px] font-medium transition-colors duration-150 ${
                    active
                      ? "bg-mkt-accent-soft text-mkt-accent-deep"
                      : "text-mkt-ink-2 hover:bg-mkt-paper-2 hover:text-mkt-ink"
                  }`}
                >
                  <span className="inline-flex items-center gap-3">
                    <span
                      className={`h-5 w-[3px] flex-none rounded-full transition-colors duration-150 ${
                        active ? "bg-mkt-accent" : "bg-transparent group-hover:bg-mkt-line"
                      }`}
                    />
                    {l.label}
                  </span>
                  <ChevronRight
                    size={18}
                    className={`flex-none transition-transform duration-150 group-hover:translate-x-0.5 ${
                      active ? "text-mkt-accent-deep" : "text-mkt-ink-3"
                    }`}
                  />
                </Link>
              </motion.div>
            );
          })}
          <motion.div variants={ITEM_VARIANTS} className="my-3 h-px bg-mkt-line-2" />
          <motion.div variants={ITEM_VARIANTS} className="flex flex-col gap-3">
            <Btn variant="ghost" href="/login" onClick={() => setOpen(false)}>
              Sign In
            </Btn>
            <Btn variant="solid" href="/register" onClick={() => setOpen(false)}>
              Get Started
            </Btn>
          </motion.div>
        </motion.nav>
      </motion.div>
    </header>
  );
}
