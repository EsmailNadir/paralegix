import {
  BarChart3,
  MessageSquare,
  Bell,
  ShieldCheck,
  Scale,
  Monitor,
} from "lucide-react";
import MarketingNav from "@/components/marketingComp/MarketingNav";
import MarketingFooter from "@/components/marketingComp/MarketingFooter";
import MarketingTransition from "@/components/marketingComp/MarketingTransition";
import { Reveal } from "@/components/marketingComp/Reveal";
import { DashEyebrow, CheckChip } from "@/components/marketingComp/primitives";
import { SectionHead, Em, FinalCTA } from "@/components/marketingComp/sections";
import { UIPanel, UpRow, Bars, CalendarMock, GeneratedDocMock } from "@/components/marketingComp/Mockups";
import JsonLd from "@/components/marketingComp/JsonLd";
import { breadcrumbSchema, SOFTWARE_ID } from "@/lib/seo/structuredData";
import { SITE_URL } from "@/lib/seo/site";

/** Mirrors the feature rows and essentials rendered below, for the ItemList schema. */
const FEATURE_ITEMS = [
  { name: "Document automation", description: "Build reusable templates, auto-fill from the matter, and collect e-signatures with version history." },
  { name: "Matter management", description: "A single timeline per matter for custom fields, role-based access, tasks, notes, and activity." },
  { name: "Time, billing & trust", description: "Time and flat-fee billing, LEDES/UTBMS export, and trust accounting with an append-only ledger." },
  { name: "Deadlines & calendar", description: "Deadline tracking and reminders with two-way sync to Google Calendar and Outlook." },
  { name: "Client portal & intake", description: "Online intake, secure client messaging and file sharing, and online payments." },
  { name: "Reporting & insights", description: "Dashboards for billable time, invoicing, and matter activity, exportable for partners." },
  { name: "Secure client messaging", description: "Privileged conversations stay off email, in a row-level-secured messaging system." },
  { name: "Notifications & reminders", description: "Layered reminders for deadlines, tasks, and assignments so nothing is forgotten." },
  { name: "Role-based access", description: "Roles and permissions scoped to each member, with strict per-firm data isolation." },
  { name: "Practice areas & courts", description: "Organize matters by practice area and reference a built-in court directory." },
  { name: "Works in any browser", description: "A responsive web app keeps matters, timers, and calendar in sync on any device." },
];

type RowItem = { lead: string; rest: string };

function FeatureRow({
  tag,
  title,
  body,
  items,
  media,
  rev = false,
}: {
  tag: string;
  title: string;
  body: string;
  items: RowItem[];
  media: React.ReactNode;
  rev?: boolean;
}) {
  return (
    <div className="grid items-center gap-16 border-t border-mkt-line py-14 first:border-t-0 min-[981px]:grid-cols-[1fr_1.1fr]">
      <div className={rev ? "min-[981px]:order-2" : ""}>
        <span className="mb-[18px] inline-flex items-center gap-2 rounded-[20px] bg-mkt-accent-soft px-3 py-[6px] text-[12px] font-bold uppercase tracking-[0.04em] text-mkt-accent-deep">
          {tag}
        </span>
        <h2 className="font-mkt-serif text-[clamp(28px,3vw,38px)] font-medium leading-[1.1] tracking-[-0.015em] text-balance">
          {title}
        </h2>
        <p className="mt-4 text-[17px] leading-[1.55] text-mkt-ink-2 text-pretty">{body}</p>
        <ul className="mt-[22px] grid gap-[13px]">
          {items.map((it) => (
            <li key={it.lead} className="flex items-start gap-3 text-[15px] leading-[1.45] text-mkt-ink-2">
              <CheckChip />
              <span>
                <b className="font-semibold text-mkt-ink">{it.lead}</b> {it.rest}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className={rev ? "min-[981px]:order-1" : ""}>
        <Reveal>{media}</Reveal>
      </div>
    </div>
  );
}

const ESSENTIALS = [
  { icon: BarChart3, h: "Reporting & insights", p: "Dashboards for billable time, invoicing, and matter activity, exportable for partners." },
  { icon: MessageSquare, h: "Secure client messaging", p: "Privileged conversations stay off email, in a row-level-secured messaging system." },
  { icon: Bell, h: "Notifications & reminders", p: "Layered reminders for deadlines, tasks, and assignments so nothing is forgotten." },
  { icon: ShieldCheck, h: "Role-based access", p: "Roles and permissions scoped to each member, with strict per-firm data isolation." },
  { icon: Scale, h: "Practice areas & courts", p: "Organize matters by practice area and reference a built-in court directory." },
  { icon: Monitor, h: "Works in any browser", p: "A responsive web app keeps your matters, timers, and calendar in sync on any device." },
];

const DESCRIPTION =
  "Matter management, billing, trust accounting, client portal, calendar sync, and e-signatures in one legal practice management platform.";

export const metadata = {
  title: "Features",
  description: DESCRIPTION,
  alternates: { canonical: "/features" },
  openGraph: {
    title: "Features | Paralegix",
    description: DESCRIPTION,
    url: "/features",
  },
};

export default function FeaturesPage() {
  return (
    <div className="min-h-screen bg-mkt-paper font-mkt-sans text-mkt-ink">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            breadcrumbSchema([
              { name: "Home", path: "/" },
              { name: "Features", path: "/features" },
            ]),
            {
              "@type": "ItemList",
              "@id": `${SITE_URL}/features#itemlist`,
              name: "Paralegix features",
              itemListElement: FEATURE_ITEMS.map((f, i) => ({
                "@type": "ListItem",
                position: i + 1,
                name: f.name,
                description: f.description,
              })),
              about: { "@id": SOFTWARE_ID },
            },
          ],
        }}
      />
      <MarketingNav />

      <MarketingTransition>
        {/* sub-hero */}
        <section className="px-[4vw] pb-2 pt-[92px] text-center">
          <div className="mx-auto w-[min(1180px,92vw)]">
            <DashEyebrow className="justify-center">Features</DashEyebrow>
            <h1 className="mx-auto font-mkt-serif text-[clamp(38px,4.4vw,58px)] font-medium leading-[1.05] tracking-[-0.015em] text-balance">
              One system for the <Em>whole matter lifecycle</Em>
            </h1>
            <p className="mx-auto mt-[22px] max-w-[38em] text-[19px] leading-[1.55] text-mkt-ink-2 text-pretty">
              Every module shares the same matters, contacts, and documents, so work flows from
              intake to invoice without a single copy-paste. Here is what is inside Paralegix.
            </p>
          </div>
        </section>

        {/* feature rows */}
        <section className="px-[4vw] pt-12">
          <div className="mx-auto w-[min(1180px,92vw)]">
            <FeatureRow
              tag="Document automation"
              title="Draft in minutes, not hours"
              body="Build any document from a template, fill it straight from the matter, then collect signatures without ever leaving the matter. This is the work your firm does most, automated end to end."
              items={[
                { lead: "Build your own templates", rest: "for engagement letters, agreements, and the forms you reuse." },
                { lead: "Auto-filled from the matter", rest: "so client names, dates, and details are never re-keyed." },
                { lead: "Version history", rest: "so you always know what changed and who approved it." },
                { lead: "Built-in e-signature", rest: "and file sharing across every matter document." },
              ]}
              media={<GeneratedDocMock />}
            />

            <FeatureRow
              rev
              tag="Matter management"
              title="A living record of every matter"
              body="Each matter is a single source of truth: parties, deadlines, tasks, notes, time entries, and every document, all on one timeline the whole team can trust."
              items={[
                { lead: "Custom matter details", rest: "with the fields and stages each practice area actually uses." },
                { lead: "Role-based access", rest: "keeps sensitive matters on a need-to-know basis." },
                { lead: "Activity timeline", rest: "shows who did what, and when, across the matter." },
              ]}
              media={
                <UIPanel title="Acme v. Brightline" sub="Commercial litigation · Opened Mar 2026" action="Open" actionTone="open">
                  <UpRow hl icon="⚑" l1="Response to motion to dismiss" l2="Assigned to R. Okafor · due Jun 12" badge="Due soon" badgeTone="trial" />
                  <UpRow icon="✎" l1="Deposition summary uploaded" l2="by J. Mercer · 2 days ago" />
                  <UpRow icon="⏱" l1="3.4 hrs logged · document review" l2="Billable · $1,190" />
                </UIPanel>
              }
            />

            <FeatureRow
              tag="Time, billing & trust"
              title="From tracked time to money in the bank"
              body="Capture time as work happens, turn it into invoices in a click, and keep client funds clean with built-in trust accounting."
              items={[
                { lead: "Time & flat-fee billing", rest: "with charge codes, batch invoicing, and online payments." },
                { lead: "LEDES & UTBMS export", rest: "for clients who require structured electronic billing." },
                { lead: "Trust accounting", rest: "with an append-only ledger and reconciliation." },
              ]}
              media={
                <UIPanel title="Billing · June" sub="Utilization by attorney" action="Generate invoices">
                  <Bars rows={[
                    { label: "R. Okafor", pct: 88 },
                    { label: "J. Mercer", pct: 74 },
                    { label: "P. Adeyemi", pct: 81 },
                    { label: "S. Vance", pct: 63 },
                  ]} />
                  <UpRow icon="$" l1="Invoice #2026-0418 · Acme Corp." l2="Sent · awaiting payment" amount="$8,420" />
                  <UpRow hl icon={<Scale size={16} />} l1="Trust ledger reconciled" l2="Reconciled · $326,400 held" badge="Clean" badgeTone="disc" />
                </UIPanel>
              }
            />

            <FeatureRow
              rev
              tag="Deadlines & calendar"
              title="Never miss a date again"
              body="Track every deadline and reminder in one place, and keep them in sync both ways with the calendars your team already lives in."
              items={[
                { lead: "Deadlines & reminders", rest: "with layered alerts so dates never slip quietly." },
                { lead: "Two-way sync", rest: "with both Google Calendar and Outlook." },
                { lead: "Shared firm calendars", rest: "for matters, events, and team availability." },
              ]}
              media={<CalendarMock />}
            />

            <FeatureRow
              tag="Client portal & intake"
              title="A professional front door for clients"
              body="Capture new business with online intake, then give clients a secure portal to share documents, sign, message, and pay, all tied to their matter."
              items={[
                { lead: "Online intake", rest: "that creates the client and matter automatically." },
                { lead: "Secure messaging", rest: "and file sharing that keeps privileged conversations off email." },
                { lead: "Online payments", rest: "and shared invoices so clients can settle balances in seconds." },
              ]}
              media={
                <UIPanel title="Client portal · L. Nguyen" sub="Immigration · Visa petition" action="Active" actionTone="disc">
                  <UpRow icon="✓" l1="Intake form completed" l2="Client & matter created" />
                  <UpRow hl icon="✍" l1="Retainer agreement" l2="Awaiting client signature" badge="Sent" badgeTone="trial" />
                  <UpRow icon="$" l1="Initial deposit received" l2="Paid online · to trust" amount="$2,500" />
                </UIPanel>
              }
            />
          </div>
        </section>

        {/* essentials */}
        <section className="px-[4vw] py-24">
          <div className="mx-auto w-[min(1180px,92vw)]">
            <SectionHead eyebrow="And the essentials">
              Everything else a firm <Em>expects to just work</Em>
            </SectionHead>
            <div className="grid gap-[18px] min-[981px]:grid-cols-2 lg:grid-cols-3">
              {ESSENTIALS.map(({ icon: Icon, h, p }) => (
                <div
                  key={h}
                  className="rounded-[14px] border border-mkt-line bg-mkt-card p-[30px] transition-[transform,box-shadow] duration-200 hover:-translate-y-[3px] hover:shadow-mkt-md"
                >
                  <div className="mb-5 grid h-[46px] w-[46px] place-items-center rounded-[11px] border border-mkt-line-2 bg-mkt-paper text-mkt-accent-deep">
                    <Icon size={23} strokeWidth={1.8} />
                  </div>
                  <h3 className="mb-[9px] text-[20px] font-bold tracking-[-0.01em]">{h}</h3>
                  <p className="text-[15px] leading-[1.55] text-mkt-ink-2">{p}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <FinalCTA
          title={<>See Paralegix <em className="italic text-mkt-accent">on your matters</em></>}
          sub="Start free in minutes, or sign in to your firm."
          primary={{ label: "Start free", href: "/register" }}
          secondary={{ label: "Sign in", href: "/login" }}
        />
      </MarketingTransition>

      <MarketingFooter />
    </div>
  );
}
