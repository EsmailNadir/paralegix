import { Fragment } from "react";
import MarketingNav from "@/components/marketingComp/MarketingNav";
import MarketingFooter from "@/components/marketingComp/MarketingFooter";
import MarketingTransition from "@/components/marketingComp/MarketingTransition";
import { Reveal } from "@/components/marketingComp/Reveal";
import PricingPlans from "@/components/marketingComp/PricingPlans";
import PricingFaq from "@/components/marketingComp/PricingFaq";
import { FinalCTA } from "@/components/marketingComp/sections";
import { COMPARISON, type CmpRow } from "@/components/marketingComp/marketingData";
import JsonLd from "@/components/marketingComp/JsonLd";
import { breadcrumbSchema, faqPageSchema, softwareApplicationSchema } from "@/lib/seo/structuredData";

const DESCRIPTION =
  "Paralegix pricing for law firms: a free Starter plan, plus Professional and Enterprise tiers adding calendar sync, trust accounting, templates, and e-signature.";

export const metadata = {
  title: "Pricing",
  description: DESCRIPTION,
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing | Paralegix",
    description: DESCRIPTION,
    url: "/pricing",
  },
};

function Cell({ v, hl }: { v: boolean | string; hl?: boolean }) {
  return (
    <td className={`border-b border-mkt-line-2 px-1.5 py-3 text-center text-[13px] min-[981px]:px-[18px] min-[981px]:py-4 min-[981px]:text-[14.5px] ${hl ? "bg-[color-mix(in_srgb,var(--color-mkt-accent-soft)_50%,transparent)]" : ""}`}>
      {typeof v === "string" ? (
        <span className="font-medium text-mkt-ink">{v}</span>
      ) : v ? (
        <span className="font-bold text-mkt-accent-deep">✓</span>
      ) : (
        <span className="text-mkt-line">–</span>
      )}
    </td>
  );
}

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-mkt-paper font-mkt-sans text-mkt-ink">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            breadcrumbSchema([
              { name: "Home", path: "/" },
              { name: "Pricing", path: "/pricing" },
            ]),
            softwareApplicationSchema(),
            faqPageSchema(),
          ],
        }}
      />
      <MarketingNav />

      <MarketingTransition>
        <PricingPlans />

        {/* comparison table */}
        <section className="px-[4vw] py-24">
          <div className="mx-auto w-[min(1180px,92vw)]">
            <h2 className="mb-2 text-center font-mkt-serif text-[clamp(26px,3vw,38px)] font-medium tracking-[-0.015em]">
              Compare every plan
            </h2>
            <Reveal className="overflow-x-auto">
              <table className="mt-4 w-full table-fixed border-collapse min-[981px]:min-w-[680px]">
                <colgroup>
                  <col className="w-[34%] min-[981px]:w-[40%]" />
                  <col className="w-[22%] min-[981px]:w-[20%]" />
                  <col className="w-[22%] min-[981px]:w-[20%]" />
                  <col className="w-[22%] min-[981px]:w-[20%]" />
                </colgroup>
                <thead>
                  <tr>
                    <th className="px-1.5 pb-[18px] text-left min-[981px]:px-[18px]" />
                    <th className="px-1.5 pb-[18px] font-mkt-serif text-[14px] font-bold min-[981px]:px-[18px] min-[981px]:text-[16px]">
                      Starter
                      <small className="block font-mkt-sans text-[11px] font-medium text-mkt-ink-3 min-[981px]:text-[12px]">Free</small>
                    </th>
                    <th className="rounded-t-lg bg-[color-mix(in_srgb,var(--color-mkt-accent-soft)_50%,transparent)] px-1.5 pb-[18px] pt-3 font-mkt-serif text-[14px] font-bold min-[981px]:px-[18px] min-[981px]:text-[16px]">
                      Professional
                      <small className="block font-mkt-sans text-[11px] font-medium text-mkt-ink-3 min-[981px]:text-[12px]">Most popular</small>
                    </th>
                    <th className="px-1.5 pb-[18px] font-mkt-serif text-[14px] font-bold min-[981px]:px-[18px] min-[981px]:text-[16px]">
                      Enterprise
                      <small className="block font-mkt-sans text-[11px] font-medium text-mkt-ink-3 min-[981px]:text-[12px]">Unlimited</small>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {COMPARISON.map((grp) => (
                    <Fragment key={grp.group}>
                      <tr>
                        <td colSpan={4} className="bg-[#fbfaf6] px-1.5 py-3 text-left text-[12px] font-bold uppercase tracking-[0.04em] text-mkt-ink-3 min-[981px]:px-[18px]">
                          {grp.group}
                        </td>
                      </tr>
                      {grp.rows.map((r: CmpRow) => (
                        <tr key={r.label}>
                          <th className="border-b border-mkt-line-2 px-1.5 py-3 text-left text-[13px] font-semibold text-mkt-ink min-[981px]:px-[18px] min-[981px]:py-4 min-[981px]:text-[14.5px]">
                            {r.label}
                          </th>
                          <Cell v={r.starter} />
                          <Cell v={r.professional} hl />
                          <Cell v={r.enterprise} />
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </Reveal>
          </div>
        </section>

        {/* FAQ */}
        <section className="px-[4vw] pb-24">
          <div className="mx-auto w-[min(1180px,92vw)]">
            <h2 className="mb-14 text-center font-mkt-serif text-[clamp(26px,3vw,38px)] font-medium tracking-[-0.015em]">
              Questions, answered
            </h2>
            <PricingFaq />
          </div>
        </section>

        <FinalCTA
          title={<>Start free, <em className="italic text-mkt-accent">upgrade anytime</em></>}
          sub="Create your firm in minutes on the free Starter plan."
          primary={{ label: "Start free", href: "/register" }}
          secondary={{ label: "Sign in", href: "/login" }}
          note={["No credit card", "Cancel anytime", "Upgrade as you grow"]}
        />
      </MarketingTransition>

      <MarketingFooter />
    </div>
  );
}
