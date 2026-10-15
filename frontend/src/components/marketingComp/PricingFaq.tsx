"use client";

import { useId, useState } from "react";
import { Plus } from "lucide-react";
import { FAQS } from "@/components/marketingComp/marketingData";

/** Accordion of pricing FAQs, with the first entry open on load. */
export default function PricingFaq() {
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const faqId = useId();

  return (
    <div className="mx-auto grid max-w-[760px] gap-[14px]">
      {FAQS.map((f, i) => {
        const open = openFaq === i;
        return (
          <div key={f.q} className="rounded-xl border border-mkt-line bg-mkt-card px-[22px]">
            <button
              type="button"
              onClick={() => setOpenFaq(open ? null : i)}
              className="flex w-full items-center justify-between gap-4 py-[18px] text-left text-[17px] font-semibold"
              aria-expanded={open}
              aria-controls={`${faqId}-answer-${i}`}
            >
              {f.q}
              <Plus
                size={20}
                className="flex-none text-mkt-accent-deep transition-transform duration-200"
                style={{ transform: open ? "rotate(45deg)" : "none" }}
              />
            </button>
            <div
              id={`${faqId}-answer-${i}`}
              hidden={!open}
              className={`grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out ${
                open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
              }`}
            >
              <div className="min-h-0 overflow-hidden">
                <p className="max-w-[60ch] pb-5 text-[15px] leading-[1.6] text-mkt-ink-2">{f.a}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
