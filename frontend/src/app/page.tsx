import {
  Briefcase,
  Receipt,
  FileText,
  CalendarDays,
  Lock,
  Users,
  ScrollText,
  KeyRound,
  Building2,
  ShieldCheck,
  Fingerprint,
} from "lucide-react";
import SignedInRedirect from "@/components/marketingComp/SignedInRedirect";
import MarketingNav from "@/components/marketingComp/MarketingNav";
import MarketingFooter from "@/components/marketingComp/MarketingFooter";
import MarketingTransition from "@/components/marketingComp/MarketingTransition";
import { Reveal } from "@/components/marketingComp/Reveal";
import { Btn, DashEyebrow, DotOk, CheckChip } from "@/components/marketingComp/primitives";
import { SectionHead, Em, FinalCTA } from "@/components/marketingComp/sections";
import { DashboardMock, CalendarMock, DocAutomationFlow } from "@/components/marketingComp/Mockups";
import { PRACTICE_AREAS } from "@/components/marketingComp/marketingData";
import JsonLd from "@/components/marketingComp/JsonLd";
import { softwareApplicationSchema } from "@/lib/seo/structuredData";

const FEATURES = [
  {
    icon: Briefcase,
    title: "Matter management",
    body: "A single timeline per matter: notes, tasks, contacts, documents, and time entries, so anyone on the team can pick up a matter and know exactly where it stands.",
    tags: ["Custom fields", "Tasks", "Permissions"],
  },
  {
    icon: Receipt,
    title: "Time, billing & trust",
    body: "Capture billable time, generate invoices in a click, and manage trust accounting with an append-only ledger and built-in reconciliation.",
    tags: ["LEDES / UTBMS", "Trust ledger", "Online pay"],
  },
  {
    icon: FileText,
    title: "Document automation",
    body: "Assemble engagement letters, agreements, and forms from your own reusable templates, then collect signatures, version history and e-signature included.",
    tags: ["Templates", "e-Signature", "File sharing"],
  },
  {
    icon: CalendarDays,
    title: "Deadlines & calendar",
    body: "Track deadlines and reminders and keep them in sync both ways with Google Calendar and Outlook, so nothing slips through the cracks.",
    tags: ["Reminders", "Two-way sync", "Shared calendars"],
  },
];

const DOC_POINTS = [
  { lead: "Build your own templates", rest: "for engagement letters, agreements, wills, and the forms you reuse every week." },
  { lead: "Auto-filled from the matter", rest: "so client names, dates, and matter details are never re-keyed." },
  { lead: "Built-in e-signature", rest: "with version history, sent and tracked without leaving the matter." },
];

const STEPS = [
  { n: "01", h: "Intake & onboarding", p: "Online intake creates the client and matter automatically, with no re-keying to get started." },
  { n: "02", h: "Plan & calendar", p: "Apply a matter template, and tasks, assignments, and deadlines populate and sync to calendars." },
  { n: "03", h: "Work & collaborate", p: "Draft documents, log time, and message clients through a secure portal, all logged to the matter." },
  { n: "04", h: "Bill & get paid", p: "Turn tracked time into invoices and collect payment online, with trust accounting handled." },
];

const SEC_POINTS = [
  { icon: Lock, h: "Encryption everywhere", p: "Data is encrypted in transit and at rest, on managed Postgres and cloud storage." },
  { icon: Users, h: "Granular access control", p: "Role-based permissions and per-firm data isolation keep matters strictly need-to-know." },
  { icon: ScrollText, h: "Action logging", p: "Sensitive actions are recorded so you can always see who did what, and when." },
];

const SEC_TILES = [
  { icon: KeyRound, h: "Role-based access", p: "Roles and permissions scoped to each team member." },
  { icon: Building2, h: "Per-firm isolation", p: "Every query is scoped to your firm; messaging is row-level secured." },
  { icon: ShieldCheck, h: "Encrypted data", p: "TLS in transit and encryption at rest for documents and data." },
  { icon: Fingerprint, h: "Secure sign-in", p: "Google, Microsoft, or email authentication with verified email." },
];

// Title intentionally omitted: the root layout's `title.default` is already the
// homepage title, and re-stating it here would run it through the "%s |
// Paralegix" template and repeat the brand.
export const metadata = {
  description:
    "Paralegix unifies matter intake, documents, calendaring, time tracking, trust accounting, and billing into one workspace for law firms. Free Starter plan, no credit card.",
  alternates: { canonical: "/" },
};

export default function Home() {
  return (
    <div className="min-h-screen bg-mkt-paper font-mkt-sans text-mkt-ink">
      <JsonLd data={{ "@context": "https://schema.org", ...softwareApplicationSchema() }} />
      <SignedInRedirect />
      <MarketingNav />

      <MarketingTransition>
        {/* ── HERO ───────────────────────────────────────────── */}
        <section className="overflow-hidden pt-[76px]">
          <div className="mx-auto grid w-[min(1180px,92vw)] items-center gap-14 min-[981px]:grid-cols-[1.05fr_1.1fr]">
            <div>
              <DashEyebrow>Legal practice management</DashEyebrow>
              <h1 className="font-mkt-serif text-[clamp(40px,4.6vw,62px)] font-medium leading-[1.04] tracking-[-0.015em] text-balance">
                Every matter, deadline &amp; dollar, <Em>in one place.</Em>
              </h1>
              <p className="mt-6 max-w-[30em] text-[19px] leading-[1.55] text-mkt-ink-2 text-pretty">
                Paralegix unifies matter intake, documents, calendaring, and billing into a single
                workspace, so your firm spends less time managing software and more time practicing law.
              </p>
              <div className="mt-[34px] flex flex-wrap items-center gap-4">
                <Btn variant="accent" size="lg" href="/register">Start free</Btn>
                <Btn variant="ghost" size="lg" href="/workflow">See how it works</Btn>
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-[18px] text-[13.5px] font-medium text-mkt-ink-3">
                <span className="inline-flex items-center gap-[7px]"><DotOk /> No credit card</span>
                <span className="inline-flex items-center gap-[7px]"><DotOk /> Free Starter plan</span>
                <span className="inline-flex items-center gap-[7px]"><DotOk /> Cancel anytime</span>
              </div>
            </div>

            <div className="min-[981px]:pr-6">
              <DashboardMock />
            </div>
          </div>

          {/* practice-area strip */}
          <div className="mx-auto mt-[68px] w-[min(1180px,92vw)] pb-2" id="customers">
            <div className="mb-[26px] text-center text-[13px] font-semibold uppercase tracking-[0.05em] text-mkt-ink-3">
              Built for the work your firm already does
            </div>
            <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 opacity-75 min-[981px]:justify-between min-[981px]:gap-7">
              {PRACTICE_AREAS.map((p) => (
                <div key={p} className="whitespace-nowrap font-mkt-serif text-[18px] font-medium tracking-[-0.01em] min-[981px]:text-[21px]">
                  {p}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── DOCUMENT AUTOMATION SPOTLIGHT ──────────────────── */}
        <section className="px-[4vw] pt-16 min-[981px]:pt-24" id="document-automation">
          <div className="mx-auto grid w-[min(1180px,92vw)] items-center gap-[60px] min-[981px]:grid-cols-[1fr_1.1fr]">
            <div>
              <div className="mb-4 text-[13px] font-semibold uppercase tracking-[0.05em] text-mkt-accent-deep">
                Document automation
              </div>
              <h2 className="font-mkt-serif text-[clamp(30px,3.4vw,44px)] font-medium leading-[1.08] tracking-[-0.015em] text-balance">
                Draft a polished document in <Em>seconds, not hours</Em>
              </h2>
              <p className="mt-[18px] text-[18px] leading-[1.55] text-mkt-ink-2 text-pretty">
                Start from one of your own templates, let Paralegix fill in the client, matter, and
                dates straight from the matter, then send it for signature without ever leaving the
                matter.
              </p>
              <ul className="mt-[22px] grid gap-[13px]">
                {DOC_POINTS.map((it) => (
                  <li key={it.lead} className="flex items-start gap-3 text-[15px] leading-[1.45] text-mkt-ink-2">
                    <CheckChip />
                    <span>
                      <b className="font-semibold text-mkt-ink">{it.lead}</b> {it.rest}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-[30px]">
                <Btn variant="accent" href="/features">See how it works</Btn>
              </div>
            </div>

            <div className="min-[981px]:pl-4">
              <Reveal>
                <DocAutomationFlow />
              </Reveal>
            </div>
          </div>
        </section>

        {/* ── FEATURES ───────────────────────────────────────── */}
        <section className="px-[4vw] py-16 min-[981px]:py-24" id="features">
          <div className="mx-auto w-[min(1180px,92vw)]">
            <SectionHead
              eyebrow="One workspace"
              sub="Stop stitching together five tools and a dozen spreadsheets. Paralegix handles the full matter lifecycle, from intake to invoice, in one system of record."
            >
              Everything your firm runs on, <Em>finally connected</Em>
            </SectionHead>

            <div className="grid gap-[18px] min-[981px]:grid-cols-2">
              {FEATURES.map(({ icon: Icon, title, body, tags }) => (
                <div
                  key={title}
                  className="rounded-[14px] border border-mkt-line bg-mkt-card p-[30px] transition-[transform,box-shadow] duration-200 hover:-translate-y-[3px] hover:shadow-mkt-md"
                >
                  <div className="mb-5 grid h-[46px] w-[46px] place-items-center rounded-[11px] border border-mkt-line-2 bg-mkt-paper text-mkt-accent-deep">
                    <Icon size={23} strokeWidth={1.8} />
                  </div>
                  <h3 className="mb-[9px] text-[20px] font-bold tracking-[-0.01em]">{title}</h3>
                  <p className="text-[15px] leading-[1.55] text-mkt-ink-2">{body}</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {tags.map((t) => (
                      <span key={t} className="rounded-[7px] border border-mkt-line-2 bg-mkt-paper px-[10px] py-[5px] text-[12px] font-semibold text-mkt-ink-3">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-8 text-center min-[981px]:mt-11">
              <Btn variant="ghost" size="lg" href="/features">Explore all features</Btn>
            </div>
          </div>
        </section>

        {/* ── WORKFLOW SHOWCASE (dark) ───────────────────────── */}
        <section className="px-[4vw]" id="workflow">
          <div className="mx-auto w-[min(1180px,92vw)]">
            <div className="overflow-hidden rounded-[28px] bg-mkt-ink text-mkt-paper">
              <div className="mx-auto grid w-[90%] items-center gap-[60px] py-[92px] min-[981px]:grid-cols-[1fr_1.1fr]">
                <div>
                  <div className="mb-4 text-[13px] font-semibold uppercase tracking-[0.05em] text-mkt-accent">
                    From intake to invoice
                  </div>
                  <h2 className="font-mkt-serif text-[clamp(30px,3.4vw,44px)] font-medium leading-[1.08] tracking-[-0.015em] text-balance">
                    A workflow that <em className="italic text-mkt-accent">moves matters forward</em>
                  </h2>
                  <p className="mt-[18px] text-[18px] leading-[1.55]" style={{ color: "rgba(247,244,237,0.62)" }}>
                    Every matter follows a clear path. Paralegix automates the handoffs so your team
                    always knows the next step.
                  </p>

                  <div className="mt-7 flex flex-col">
                    {STEPS.map((s, i) => (
                      <div
                        key={s.n}
                        className={`flex gap-[14px] py-4 ${i === 0 ? "border-t" : "border-t"} ${
                          i === STEPS.length - 1 ? "border-b" : ""
                        }`}
                        style={{ borderColor: "rgba(247,244,237,0.12)" }}
                      >
                        <span className="w-7 flex-none font-mkt-serif text-[17px] italic text-mkt-accent">{s.n}</span>
                        <div>
                          <h4 className="mb-[5px] text-[17px] font-semibold">{s.h}</h4>
                          <p className="text-[14.5px] leading-[1.5]" style={{ color: "rgba(247,244,237,0.62)" }}>
                            {s.p}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-[30px]">
                    <Btn variant="accent" href="/workflow">Walk through the workflow</Btn>
                  </div>
                </div>

                <div>
                  <Reveal>
                    <CalendarMock />
                  </Reveal>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── SECURITY ───────────────────────────────────────── */}
        <section className="px-[4vw] py-16 min-[981px]:py-24" id="security">
          <div className="mx-auto grid w-[min(1180px,92vw)] items-center gap-[60px] min-[981px]:grid-cols-2">
            <div>
              <div className="mb-4 text-[13px] font-semibold uppercase tracking-[0.05em] text-mkt-accent-deep">
                Security &amp; data protection
              </div>
              <h2 className="font-mkt-serif text-[clamp(30px,3.4vw,44px)] font-medium leading-[1.08] tracking-[-0.015em] text-balance">
                Built to the standard <Em>your clients expect</Em>
              </h2>
              <p className="mt-[18px] text-[18px] leading-[1.55] text-mkt-ink-2">
                Privileged client data deserves more than a password. Paralegix is engineered for
                confidentiality, with strict tenant isolation and access logged on sensitive actions.
              </p>
              <div className="mt-7 grid gap-[18px]">
                {SEC_POINTS.map(({ icon: Icon, h, p }) => (
                  <div key={h} className="flex items-start gap-[14px]">
                    <span className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] bg-mkt-accent-soft text-mkt-accent-deep">
                      <Icon size={18} strokeWidth={1.8} />
                    </span>
                    <div>
                      <h4 className="mb-[3px] text-base font-bold">{h}</h4>
                      <p className="text-[14.5px] leading-[1.5] text-mkt-ink-2">{p}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-[14px] max-[560px]:grid-cols-1">
              {SEC_TILES.map(({ icon: Icon, h, p }) => (
                <div key={h} className="flex flex-col gap-3 rounded-[14px] border border-mkt-line bg-mkt-card p-6">
                  <div className="grid h-[52px] w-[52px] place-items-center rounded-full border-2 border-mkt-accent text-mkt-accent-deep">
                    <Icon size={22} strokeWidth={1.8} />
                  </div>
                  <h4 className="text-[15px] font-bold">{h}</h4>
                  <p className="text-[13px] leading-[1.45] text-mkt-ink-3">{p}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── FINAL CTA ──────────────────────────────────────── */}
        <FinalCTA
          title={<>Bring your whole practice <em className="italic text-mkt-accent">into one place</em></>}
          sub="Start free in minutes. Upgrade as your firm grows."
          primary={{ label: "Start free", href: "/register" }}
          secondary={{ label: "Sign in", href: "/login" }}
          note={["Free Starter plan", "No credit card", "Upgrade anytime"]}
        />
      </MarketingTransition>

      <MarketingFooter />
    </div>
  );
}
