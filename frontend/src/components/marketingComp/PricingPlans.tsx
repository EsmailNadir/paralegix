"use client";

import { useState } from "react";
import { Btn, DashEyebrow, CheckChip } from "@/components/marketingComp/primitives";
import { Em } from "@/components/marketingComp/sections";
import { PLANS, type BillingCycle } from "@/components/marketingComp/marketingData";

function PriceCard({ plan, cycle }: { plan: (typeof PLANS)[number]; cycle: BillingCycle }) {
  const free = plan.monthly === 0;
  const amount = free ? 0 : cycle === "annual" ? plan.annualPerMonth : plan.monthly;
  const billNote = free
    ? "Free forever"
    : cycle === "annual"
      ? `Billed annually ($${plan.annualTotal}/yr)`
      : "Billed monthly";

  return (
    <div
      className={`flex flex-col rounded-[18px] border bg-mkt-card p-8 ${
        plan.highlight ? "relative border-mkt-ink shadow-mkt-md" : "border-mkt-line"
      }`}
    >
      {plan.flag && (
        <span className="absolute right-[18px] top-[18px] rounded-[20px] bg-mkt-accent px-[11px] py-[5px] text-[11px] font-bold uppercase tracking-[0.03em] text-white">
          {plan.flag}
        </span>
      )}
      <div className="text-[14px] font-bold uppercase tracking-[0.03em] text-mkt-accent-deep">{plan.name}</div>
      <p className="mt-2 min-h-[42px] text-[14px] leading-[1.5] text-mkt-ink-2">{plan.description}</p>

      <div className="mt-[22px] font-mkt-serif text-[52px] font-medium leading-none tracking-[-0.02em]">
        ${amount}
        {!free && <small className="font-mkt-sans text-[15px] font-medium tracking-normal text-mkt-ink-3">/mo</small>}
      </div>
      <div className="mt-2 text-[13px] text-mkt-ink-3">{billNote}</div>

      <div className="mt-6">
        <Btn variant={plan.highlight ? "accent" : "ghost"} href="/register" className="w-full">
          {plan.ctaLabel}
        </Btn>
      </div>

      <ul className="mt-[26px] grid gap-3 border-t border-mkt-line-2 pt-6">
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-[11px] text-[14px] leading-[1.45] text-mkt-ink-2">
            <CheckChip />
            <span>{f}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Sub-hero and plan cards. These share the annual/monthly toggle state, and the
 * toggle sits inside the hero while the cards live in the section below it, so
 * the island spans both rather than splitting the state across two components.
 */
export default function PricingPlans() {
  const [cycle, setCycle] = useState<BillingCycle>("annual");

  return (
    <>
      {/* sub-hero + toggle */}
      <section className="px-[4vw] pb-2 pt-[92px] text-center">
        <div className="mx-auto w-[min(1180px,92vw)]">
          <DashEyebrow className="justify-center">Pricing</DashEyebrow>
          <h1 className="mx-auto font-mkt-serif text-[clamp(38px,4.4vw,58px)] font-medium leading-[1.05] tracking-[-0.015em] text-balance">
            Simple plans that <Em>grow with your firm</Em>
          </h1>
          <p className="mx-auto mt-[22px] max-w-[38em] text-[19px] leading-[1.55] text-mkt-ink-2 text-pretty">
            Start free on the Starter plan, then upgrade when you need calendar sync, trust
            accounting, templates, and e-signature. No credit card to begin.
          </p>

          <div className="mx-auto mt-7 inline-flex items-center gap-1 rounded-xl border border-mkt-line-2 bg-mkt-paper-2 p-[5px]">
            <button
              type="button"
              onClick={() => setCycle("annual")}
              aria-pressed={cycle === "annual"}
              className={`rounded-lg px-[18px] py-[9px] text-[14px] font-semibold transition-all ${
                cycle === "annual" ? "bg-mkt-card text-mkt-ink shadow-mkt-sm" : "text-mkt-ink-2"
              }`}
            >
              Annual <span className="ml-[6px] text-[11px] font-bold text-mkt-accent-deep">Save 20%</span>
            </button>
            <button
              type="button"
              onClick={() => setCycle("monthly")}
              aria-pressed={cycle === "monthly"}
              className={`rounded-lg px-[18px] py-[9px] text-[14px] font-semibold transition-all ${
                cycle === "monthly" ? "bg-mkt-card text-mkt-ink shadow-mkt-sm" : "text-mkt-ink-2"
              }`}
            >
              Monthly
            </button>
          </div>
          <p role="status" className="sr-only">
            {cycle === "annual" ? "Annual" : "Monthly"} billing selected. Prices are shown per month.
          </p>
        </div>
      </section>

      {/* price cards */}
      <section className="px-[4vw] pt-12">
        <div className="mx-auto grid w-[min(1180px,92vw)] items-start gap-[22px] min-[981px]:grid-cols-3 max-[980px]:mx-auto max-[980px]:max-w-[440px]">
          {PLANS.map((p) => (
            <PriceCard key={p.id} plan={p} cycle={cycle} />
          ))}
        </div>
      </section>
    </>
  );
}
