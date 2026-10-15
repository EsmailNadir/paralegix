import MarketingNav from "@/components/marketingComp/MarketingNav";
import MarketingFooter from "@/components/marketingComp/MarketingFooter";
import MarketingTransition from "@/components/marketingComp/MarketingTransition";
import { Reveal } from "@/components/marketingComp/Reveal";
import { DashEyebrow } from "@/components/marketingComp/primitives";
import { Em, FinalCTA } from "@/components/marketingComp/sections";
import {
  UIPanel,
  UpRow,
  CalendarMock,
  IntakeFormMock,
  InvoiceMock,
} from "@/components/marketingComp/Mockups";
import JsonLd from "@/components/marketingComp/JsonLd";
import { breadcrumbSchema } from "@/lib/seo/structuredData";

/** Mirrors the five <Stage> blocks rendered below, for the HowTo schema. */
const HOWTO_STEPS = [
  {
    name: "Intake & onboarding",
    text: "A prospective client completes your online intake form. Paralegix creates the client and the matter from their answers, so the file is ready before you have spent a minute re-keying data.",
  },
  {
    name: "Open the matter and plan",
    text: "Accept the lead and a full matter opens, pre-filled from intake. Apply a matter template and the standard tasks, responsible attorney, and assignments drop into place automatically.",
  },
  {
    name: "Deadlines, tracked and synced",
    text: "Set the key dates for the matter and Paralegix keeps everyone on track, with layered reminders and two-way sync to each attorney's Google or Outlook calendar.",
  },
  {
    name: "Do the work, all in one place",
    text: "Draft documents from a template, log time as you go, and exchange documents and messages with the client through the secure portal. Everything lands back on the matter timeline.",
  },
  {
    name: "Bill and get paid",
    text: "Turn tracked time and expenses into a clean invoice, send it for online payment, and apply funds from trust, with every entry recorded on an append-only ledger.",
  },
];

const PIPELINE = [
  { n: "01", h: "Intake", p: "Capture & onboard" },
  { n: "02", h: "Plan", p: "Open matter & assign" },
  { n: "03", h: "Calendar", p: "Track deadlines" },
  { n: "04", h: "Work", p: "Draft, log & share" },
  { n: "05", h: "Bill", p: "Invoice & collect" },
];

function StageNum({ n }: { n: string }) {
  return (
    <div
      className="font-mkt-serif text-[64px] font-medium leading-none text-mkt-accent-soft"
      style={{ WebkitTextStroke: "1px oklch(0.60 0.085 72)" }}
    >
      {n}
    </div>
  );
}

function Stage({
  n,
  title,
  body,
  meta,
  media,
  rev = false,
}: {
  n: string;
  title: string;
  body: string;
  meta: string[];
  media: React.ReactNode;
  rev?: boolean;
}) {
  return (
    <div className="grid items-center gap-16 border-t border-mkt-line py-16 first:border-t-0 min-[981px]:grid-cols-[1fr_1.1fr]">
      <div className={rev ? "min-[981px]:order-2" : ""}>
        <StageNum n={n} />
        <h2 className="mt-2 font-mkt-serif text-[clamp(28px,3vw,38px)] font-medium leading-[1.1] tracking-[-0.015em] text-balance">
          {title}
        </h2>
        <p className="mt-4 text-[17px] leading-[1.55] text-mkt-ink-2 text-pretty">{body}</p>
        <div className="mt-[22px] flex flex-wrap gap-[10px]">
          {meta.map((m) => (
            <span key={m} className="rounded-[20px] border border-mkt-line bg-mkt-card px-[13px] py-[7px] text-[12.5px] font-semibold text-mkt-ink-2">
              {m}
            </span>
          ))}
        </div>
      </div>
      <div className={rev ? "min-[981px]:order-1" : ""}>
        <Reveal>{media}</Reveal>
      </div>
    </div>
  );
}

const DESCRIPTION =
  "How a matter moves through Paralegix, from client intake and matter planning to deadlines, drafting, billing, and collection.";

export const metadata = {
  title: "Workflow",
  description: DESCRIPTION,
  alternates: { canonical: "/workflow" },
  openGraph: {
    title: "Workflow | Paralegix",
    description: DESCRIPTION,
    url: "/workflow",
  },
};

export default function WorkflowPage() {
  return (
    <div className="min-h-screen bg-mkt-paper font-mkt-sans text-mkt-ink">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            breadcrumbSchema([
              { name: "Home", path: "/" },
              { name: "Workflow", path: "/workflow" },
            ]),
            {
              "@type": "HowTo",
              name: "How a matter moves through Paralegix",
              description:
                "How a matter moves through Paralegix, from client intake and matter planning to deadlines, drafting, billing, and collection.",
              step: HOWTO_STEPS.map((s, i) => ({
                "@type": "HowToStep",
                position: i + 1,
                name: s.name,
                text: s.text,
              })),
            },
          ],
        }}
      />
      <MarketingNav />

      <MarketingTransition>
        {/* sub-hero + pipeline */}
        <section className="px-[4vw] pb-2 pt-[92px] text-center">
          <div className="mx-auto w-[min(1180px,92vw)]">
            <DashEyebrow className="justify-center">Workflow</DashEyebrow>
            <h1 className="mx-auto font-mkt-serif text-[clamp(38px,4.4vw,58px)] font-medium leading-[1.05] tracking-[-0.015em] text-balance">
              From first call to <Em>final invoice</Em>
            </h1>
            <p className="mx-auto mt-[22px] max-w-[38em] text-[19px] leading-[1.55] text-mkt-ink-2 text-pretty">
              Follow a single matter through Paralegix. Every stage hands off cleanly to the next,
              with nothing re-keyed and nothing forgotten.
            </p>

            <div className="mt-11 grid overflow-hidden rounded-2xl border border-mkt-line bg-mkt-card text-left min-[981px]:grid-cols-5">
              {PIPELINE.map((s, i) => (
                <div
                  key={s.n}
                  className="relative border-mkt-line-2 px-5 py-[22px] max-[980px]:border-b min-[981px]:border-r [&:last-child]:border-0"
                >
                  <div className="font-mkt-serif text-[18px] italic text-mkt-accent-deep">{s.n}</div>
                  <h4 className="mt-2 text-[15px] font-bold">{s.h}</h4>
                  <p className="mt-[5px] text-[12.5px] leading-[1.45] text-mkt-ink-3">{s.p}</p>
                  {i === 0 && (
                    <div className="absolute bottom-0 left-0 right-0 h-[3px] origin-left scale-x-[0.2] bg-mkt-accent" />
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* stages */}
        <section className="px-[4vw] pt-10">
          <div className="mx-auto w-[min(1180px,92vw)]">
            <Stage
              n="01"
              title="Intake & onboarding"
              body="A prospective client completes your online intake form. Paralegix creates the client and the matter from their answers, so the file is ready before you have spent a minute re-keying data."
              meta={["Online intake form", "Auto-created matter", "Client record"]}
              media={<IntakeFormMock />}
            />

            <Stage
              rev
              n="02"
              title="Open the matter and plan"
              body="Accept the lead and a full matter opens, pre-filled from intake. Apply a matter template and the standard tasks, responsible attorney, and assignments drop into place automatically."
              meta={["Matter templates", "Task assignments", "Billing setup"]}
              media={
                <UIPanel title="Nguyen Immigration" sub="Matter #2026-118 · opened today" action="Apply template">
                  <UpRow hl icon="1" l1="Collect supporting documents" l2="Assigned to P. Adeyemi" badge="To do" badgeTone="trial" />
                  <UpRow icon="2" l1="Prepare Form I-129" l2="Assigned to lead attorney" />
                  <UpRow icon="3" l1="Review & file petition" l2="Due before filing deadline" />
                </UIPanel>
              }
            />

            <Stage
              n="03"
              title="Deadlines, tracked and synced"
              body="Set the key dates for the matter and Paralegix keeps everyone on track, with layered reminders and two-way sync to each attorney's Google or Outlook calendar."
              meta={["Deadline tracking", "Reminders", "Calendar sync"]}
              media={
                <CalendarMock
                  events={[
                    { tick: "var(--color-mkt-warn)", title: "Petition filing deadline", sub: "Reminder set · synced to calendar", time: "Today" },
                    { tick: "var(--color-mkt-accent)", title: "Supporting docs due to client", sub: "Reminder · 3 days prior", time: "Jun 17" },
                  ]}
                />
              }
            />

            <Stage
              rev
              n="04"
              title="Do the work, all in one place"
              body="Draft the petition from a template, log time as you go, and exchange documents and messages with the client through the secure portal. Everything lands back on the matter timeline."
              meta={["Document automation", "Time capture", "Client portal"]}
              media={
                <UIPanel title="Matter activity" sub="Today" action="Live" actionTone="disc">
                  <UpRow icon="📄" l1="Form I-129 drafted from template" l2="Merged client & matter data · v1" />
                  <UpRow hl icon="⏱" l1="1.8 hrs logged · petition prep" l2="Billable" amount="$630" />
                  <UpRow icon="💬" l1="Client uploaded passport scan" l2="Via secure portal · 1 hr ago" />
                </UIPanel>
              }
            />

            <Stage
              n="05"
              title="Bill and get paid"
              body="Turn tracked time and expenses into a clean invoice, send it for online payment, and apply funds from trust, with every entry recorded on an append-only ledger."
              meta={["One-click invoicing", "Online payments", "Trust accounting"]}
              media={<InvoiceMock />}
            />
          </div>
        </section>

        {/* closing statement */}
        <section className="px-[4vw] py-24" style={{ background: "var(--color-mkt-paper-2)" }}>
          <div className="mx-auto max-w-[880px] text-center">
            <span className="block h-9 font-mkt-serif text-[72px] italic leading-[0.5] text-mkt-accent">“</span>
            <blockquote className="mt-7 font-mkt-serif text-[clamp(24px,3vw,34px)] font-normal leading-[1.32] tracking-[-0.01em] text-balance">
              One matter, one timeline, from the first intake form to the final paid invoice, with{" "}
              <Em>nothing re-keyed and nothing forgotten.</Em>
            </blockquote>
          </div>
        </section>

        <FinalCTA
          title={<>Run your next matter <em className="italic text-mkt-accent">end to end</em></>}
          sub="Start free in minutes, or sign in to your firm."
          primary={{ label: "Start free", href: "/register" }}
          secondary={{ label: "Sign in", href: "/login" }}
        />
      </MarketingTransition>

      <MarketingFooter />
    </div>
  );
}
