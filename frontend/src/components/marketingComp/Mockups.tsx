"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Home,
  Briefcase,
  ClipboardCheck,
  MessageSquare,
  CalendarDays,
  Receipt,
  FolderOpen,
  Users,
  PenLine,
  FileText,
  Settings,
  Sparkles,
  Download,
  ChevronLeft,
  ChevronRight,
  Scale,
} from "lucide-react";
import ParalegixLogo from "@/components/ui/ParalegixLogo";
import { Badge, Check } from "./primitives";
import { EASE_OUT } from "./Reveal";

/* ============================================================
   Hand-built product mockups for the marketing pages.
   These suggest the real Paralegix UI; swap for screenshots later.
   ============================================================ */

/* ---------- Browser-framed hero dashboard ("Active Matters") ---------- */

const NAV_ITEMS = [
  { icon: Home, label: "Dashboard" },
  { icon: Briefcase, label: "Matters" },
  { icon: ClipboardCheck, label: "Tasks" },
  { icon: MessageSquare, label: "Messages" },
  { icon: CalendarDays, label: "Calendar" },
  { icon: Receipt, label: "Billing" },
  { icon: FolderOpen, label: "Files" },
  { icon: Users, label: "Clients" },
  { icon: PenLine, label: "E-Signatures" },
  { icon: FileText, label: "Templates" },
  { icon: Settings, label: "Settings" },
];

const MATTERS = [
  { title: "Acme v. Brightline", sub: "Commercial litigation", client: "Acme Corp.", badge: "Active", tone: "open" as const, due: "Jun 12", soon: true },
  { title: "Halloran Estate", sub: "Probate & trusts", client: "M. Halloran", badge: "In progress", tone: "disc" as const, due: "Jun 24", soon: false },
  { title: "Nguyen Immigration", sub: "Visa petition", client: "L. Nguyen", badge: "Pending", tone: "trial" as const, due: "Jun 10", soon: true },
  { title: "Cedar Park LLC", sub: "Corporate formation", client: "Cedar Park", badge: "Active", tone: "open" as const, due: "Jul 02", soon: false },
];

/* Hero cycles through three views of the same firm's data (matters, deadlines,
   billing) so it reads as "every matter, deadline & dollar" actually living in
   one product, not three unrelated screenshots. */
type HeroView = "matters" | "calendar" | "billing";

const HERO_VIEWS: HeroView[] = ["matters", "calendar", "billing"];
const HERO_NAV_LABEL: Record<HeroView, string> = {
  matters: "Matters",
  calendar: "Calendar",
  billing: "Billing",
};
const HERO_STEP_MS = 4500;

type HeroRow = {
  icon: React.ReactNode;
  l1: string;
  l2: string;
  amount?: string;
  badge?: string;
  badgeTone?: "open" | "disc" | "trial" | "ok";
  hl?: boolean;
};

const HERO_DEADLINES: HeroRow[] = [
  { icon: "⚑", l1: "Nguyen: visa petition filing", l2: "Filing deadline · reminder set", badge: "Today", badgeTone: "trial", hl: true },
  { icon: "⏱", l1: "Acme v. Brightline: response due", l2: "Superior Court, Dept. 14", badge: "Jun 12", badgeTone: "open" },
  { icon: "✓", l1: "Halloran Estate: filing confirmed", l2: "Probate court · filed this week", badge: "Done", badgeTone: "ok" },
];

const HERO_INVOICES: HeroRow[] = [
  { icon: "$", l1: "Invoice #2026-0418 · Acme Corp.", l2: "Sent · awaiting payment", amount: "$8,420" },
  { icon: "$", l1: "Invoice #2026-0402 · Nguyen Immigration", l2: "Paid online · applied to trust", amount: "$1,190", hl: true },
  { icon: <Scale size={15} />, l1: "Trust ledger reconciled", l2: "Reconciled · $326,400 held", badge: "Clean", badgeTone: "disc" },
];

export function DashboardMock() {
  const reduceMotion = useReducedMotion();
  const [view, setView] = useState<HeroView>("matters");
  const pausedRef = useRef(false);

  useEffect(() => {
    if (reduceMotion) return;
    const id = setInterval(() => {
      if (pausedRef.current) return;
      setView((v) => HERO_VIEWS[(HERO_VIEWS.indexOf(v) + 1) % HERO_VIEWS.length]);
    }, HERO_STEP_MS);
    return () => clearInterval(id);
  }, [reduceMotion]);

  return (
    <div
      className="relative"
      role="img"
      aria-label="Product preview showing matter management, deadlines, and billing."
      onMouseEnter={() => { pausedRef.current = true; }}
      onMouseLeave={() => { pausedRef.current = false; }}
    >
      <div
        aria-hidden="true"
        className="overflow-hidden rounded-[18px] border border-mkt-line bg-mkt-card shadow-mkt-lg min-[981px]:[transform:perspective(2000px)_rotateY(-3deg)_rotateX(1.5deg)]"
      >
        {/* browser top bar */}
        <div className="flex items-center gap-2 border-b border-mkt-line-2 bg-mkt-paper px-4 py-[13px]">
          <div className="flex gap-[6px]">
            <i className="block h-[11px] w-[11px] rounded-full bg-mkt-line" />
            <i className="block h-[11px] w-[11px] rounded-full bg-mkt-line" />
            <i className="block h-[11px] w-[11px] rounded-full bg-mkt-line" />
          </div>
          <div className="flex h-6 flex-1 items-center rounded-md border border-mkt-line-2 bg-white px-[10px] text-[11px] text-mkt-ink-3">
            app.paralegix.com/{view}
          </div>
        </div>

        {/* body */}
        <div className="grid h-[430px] grid-cols-[188px_1fr] max-[560px]:grid-cols-1">
          {/* sidebar */}
          <aside className="border-r border-mkt-line-2 bg-[#fbfaf6] p-3 max-[560px]:hidden">
            <div className="flex items-center px-[6px] pb-[14px]">
              <ParalegixLogo width={112} height={28} forceTheme="light" />
            </div>
            {NAV_ITEMS.map(({ icon: Icon, label }) => {
              const active = HERO_NAV_LABEL[view] === label;
              return (
                <div
                  key={label}
                  className={`mb-[2px] flex items-center gap-[10px] rounded-lg px-[10px] py-2 text-[13px] font-medium transition-colors duration-300 ${
                    active ? "bg-mkt-ink text-mkt-paper" : "text-mkt-ink-2"
                  }`}
                >
                  <Icon size={15} className="flex-none opacity-90" />
                  {label}
                </div>
              );
            })}
          </aside>

          {/* main */}
          <div className="h-full overflow-hidden bg-white p-[18px]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={view}
                initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.35, ease: EASE_OUT }}
              >
                {view === "matters" && <HeroMattersPane />}
                {view === "calendar" && <HeroDeadlinesPane />}
                {view === "billing" && <HeroBillingPane />}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* floating billing card */}
      <div aria-hidden="true" className="absolute -bottom-[26px] right-[-22px] w-[246px] rounded-[14px] border border-mkt-line bg-mkt-card p-[15px] shadow-mkt-md max-[980px]:right-2">
        <div className="mb-[11px] flex items-center gap-[9px]">
          <span className="grid h-[30px] w-[30px] flex-none place-items-center rounded-lg bg-mkt-accent-soft text-mkt-accent-deep">
            <Receipt size={15} />
          </span>
          <div>
            <div className="text-[12.5px] font-bold">Billing · June</div>
            <div className="text-[10.5px] text-mkt-ink-3">Invoices collected</div>
          </div>
        </div>
        <div className="mt-1 h-[7px] overflow-hidden rounded bg-mkt-paper-2">
          <i className="block h-full rounded bg-mkt-accent" style={{ width: "64%" }} />
        </div>
        <div className="mt-[9px] flex justify-between text-[11px] text-mkt-ink-2">
          <span>Collected</span>
          <b className="font-bold text-mkt-ink">$12,400</b>
        </div>
      </div>
    </div>
  );
}

function HeroMattersPane() {
  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-base font-bold tracking-[-0.01em]">Active Matters</h3>
          <div className="mt-[2px] text-[11.5px] text-mkt-ink-3">Across all practice areas</div>
        </div>
        <span className="rounded-[20px] bg-mkt-ink px-[11px] py-[5px] text-[11px] font-semibold text-mkt-paper">
          + New matter
        </span>
      </div>

      {/* stat cells */}
      <div className="mb-4 grid grid-cols-3 gap-[10px]">
        <StatCell k="Active matters" v="24" sup="of 38" />
        <StatCell k="Deadlines" v="9" sup="this wk" />
        <StatCell k="Closed" v="8" sup="this mo" />
      </div>

      {/* matters table */}
      <div className="overflow-hidden rounded-[10px] border border-mkt-line-2">
        <div className="grid grid-cols-[1.5fr_1fr_0.9fr_0.9fr] gap-2 border-b border-mkt-line-2 bg-[#fbfaf6] px-[13px] py-[9px] text-[10.5px] font-semibold uppercase tracking-[0.03em] text-mkt-ink-3">
          <div>Matter</div>
          <div>Client</div>
          <div>Status</div>
          <div>Next due</div>
        </div>
        {MATTERS.map((m) => (
          <div
            key={m.title}
            className="grid grid-cols-[1.5fr_1fr_0.9fr_0.9fr] items-center gap-2 border-b border-mkt-line-2 px-[13px] py-[9px] text-[12px] last:border-b-0"
          >
            <div className="font-semibold text-mkt-ink">
              {m.title}
              <small className="mt-px block text-[10.5px] font-medium text-mkt-ink-3">{m.sub}</small>
            </div>
            <div className="text-mkt-ink-2">{m.client}</div>
            <div>
              <Badge tone={m.tone}>{m.badge}</Badge>
            </div>
            <div className={`font-semibold ${m.soon ? "text-[oklch(0.52_0.14_30)]" : ""}`}>{m.due}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function HeroDeadlinesPane() {
  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-base font-bold tracking-[-0.01em]">Upcoming deadlines</h3>
          <div className="mt-[2px] text-[11.5px] text-mkt-ink-3">Synced to Google &amp; Outlook</div>
        </div>
        <span className="rounded-[20px] bg-mkt-ink px-[11px] py-[5px] text-[11px] font-semibold text-mkt-paper">
          9 this week
        </span>
      </div>
      <div className="grid gap-[9px]">
        {HERO_DEADLINES.map((d) => (
          <UpRow key={d.l1} icon={d.icon} l1={d.l1} l2={d.l2} badge={d.badge} badgeTone={d.badgeTone} hl={d.hl} />
        ))}
      </div>
    </>
  );
}

function HeroBillingPane() {
  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-base font-bold tracking-[-0.01em]">Billing · June</h3>
          <div className="mt-[2px] text-[11.5px] text-mkt-ink-3">Invoices &amp; trust activity</div>
        </div>
        <span className="rounded-[20px] bg-mkt-ink px-[11px] py-[5px] text-[11px] font-semibold text-mkt-paper">
          Generate invoices
        </span>
      </div>
      <div className="grid gap-[9px]">
        {HERO_INVOICES.map((row) => (
          <UpRow key={row.l1} icon={row.icon} l1={row.l1} l2={row.l2} amount={row.amount} badge={row.badge} badgeTone={row.badgeTone} hl={row.hl} />
        ))}
      </div>
    </>
  );
}

function StatCell({ k, v, sup }: { k: string; v: string; sup: string }) {
  return (
    <div className="rounded-[10px] border border-mkt-line-2 px-3 py-[11px]">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.03em] text-mkt-ink-3">{k}</div>
      <div className="mt-[3px] font-mkt-serif text-[21px] font-bold tracking-[-0.02em]">
        {v}
        <small className="ml-[3px] font-mkt-sans text-[12px] font-semibold text-mkt-accent-deep">{sup}</small>
      </div>
    </div>
  );
}

/* ---------- Calendar mock (home / features / workflow) ---------- */

type CalEvent = { tick: string; title: string; sub: string; time: string };

const DEFAULT_EVENTS: CalEvent[] = [
  { tick: "var(--color-mkt-warn)", title: "Nguyen: visa petition filing", sub: "Filing deadline · reminder set", time: "Today" },
  { tick: "var(--color-mkt-accent)", title: "Acme v. Brightline: response due", sub: "Superior Court, Dept. 14", time: "Jun 12" },
];

export function CalendarMock({ events = DEFAULT_EVENTS }: { events?: CalEvent[] }) {
  // event dots keyed by day number
  const dots: Record<number, string> = {
    3: "var(--color-mkt-ok)",
    9: "var(--color-mkt-accent)",
    12: "var(--color-mkt-warn)",
    17: "var(--color-mkt-accent)",
    24: "var(--color-mkt-ok)",
  };
  const today = 10;
  const cells: (number | null)[] = [
    31, 1, 2, 3, 4, 5, 6,
    7, 8, 9, 10, 11, 12, 13,
    14, 15, 16, 17, 18, 19, 20,
    21, 22, 23, 24, 25, 26, 27,
  ];

  return (
    <div role="img" aria-label={`Calendar preview for June 2026. ${events.map(event => `${event.title}, ${event.sub}, ${event.time}`).join('. ')}.`} className="rounded-2xl bg-[#fbfaf6] p-5 text-mkt-ink shadow-mkt-lg">
      <div aria-hidden="true" className="mb-4 flex items-center justify-between">
        <h4 className="text-[15px] font-bold">June 2026</h4>
        <div className="flex gap-[6px]">
          <i className="grid h-[26px] w-[26px] place-items-center rounded-[7px] border border-mkt-line-2 text-mkt-ink-3">
            <ChevronLeft size={12} />
          </i>
          <i className="grid h-[26px] w-[26px] place-items-center rounded-[7px] border border-mkt-line-2 text-mkt-ink-3">
            <ChevronRight size={12} />
          </i>
        </div>
      </div>

      <div aria-hidden="true" className="grid grid-cols-7 gap-[5px]">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} className="pb-1 text-center text-[10px] font-bold uppercase text-mkt-ink-3">
            {d}
          </div>
        ))}
        {cells.map((n, i) => {
          const off = i === 0; // leading 31
          const isToday = n === today && !off;
          const dot = n != null && !off ? dots[n] : undefined;
          return (
            <div
              key={i}
              className={`relative flex aspect-square items-start justify-end rounded-lg border px-[6px] py-[5px] text-[11px] ${
                isToday
                  ? "border-transparent bg-mkt-ink font-bold text-mkt-paper"
                  : dot
                    ? "border-mkt-line-2 bg-white text-mkt-ink-2"
                    : off
                      ? "border-transparent text-mkt-line"
                      : "border-transparent text-mkt-ink-2"
              }`}
            >
              {n}
              {dot && (
                <span
                  className="absolute bottom-[6px] left-[6px] h-[6px] w-[6px] rounded-full"
                  style={{ background: dot }}
                />
              )}
            </div>
          );
        })}
      </div>

      <div aria-hidden="true" className="mt-4 flex flex-col gap-[9px]">
        {events.map((e, i) => (
          <div key={i} className="flex items-center gap-[11px] rounded-[10px] border border-mkt-line-2 bg-white px-3 py-[10px]">
            <div className="w-1 self-stretch rounded-[3px]" style={{ background: e.tick }} />
            <div className="flex-1">
              <div className="text-[12.5px] font-semibold">{e.title}</div>
              <div className="text-[11px] text-mkt-ink-3">{e.sub}</div>
            </div>
            <div className="text-[11px] font-semibold text-mkt-ink-2">{e.time}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Generic UI panel (feature rows / workflow stages) ---------- */

export function UIPanel({
  title,
  sub,
  action,
  actionTone = "pill",
  children,
}: {
  title: string;
  sub: string;
  action?: string;
  actionTone?: "pill" | "open" | "disc";
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-mkt-line bg-mkt-card shadow-mkt-lg">
      <div className="flex items-center justify-between border-b border-mkt-line-2 bg-[#fbfaf6] px-[18px] py-4">
        <div>
          <div className="text-sm font-bold">{title}</div>
          <div className="mt-px text-[11px] text-mkt-ink-3">{sub}</div>
        </div>
        {action &&
          (actionTone === "pill" ? (
            <span className="rounded-[20px] bg-mkt-ink px-[11px] py-[5px] text-[11px] font-semibold text-mkt-paper">
              {action}
            </span>
          ) : (
            <Badge tone={actionTone}>{action}</Badge>
          ))}
      </div>
      <div className="grid gap-3 p-[18px]">{children}</div>
    </div>
  );
}

export function UpRow({
  icon,
  l1,
  l2,
  amount,
  badge,
  badgeTone = "trial",
  hl = false,
}: {
  icon: React.ReactNode;
  l1: string;
  l2: string;
  amount?: string;
  badge?: string;
  badgeTone?: "open" | "disc" | "trial" | "ok";
  hl?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-[11px] border px-[14px] py-[13px] ${
        hl ? "border-transparent bg-mkt-accent-soft" : "border-mkt-line-2"
      }`}
    >
      <div className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] bg-mkt-accent-soft text-[15px] text-mkt-accent-deep">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold">{l1}</div>
        <div className="mt-px text-[11.5px] text-mkt-ink-3">{l2}</div>
      </div>
      {amount && <span className="font-mkt-serif text-[13.5px] font-bold">{amount}</span>}
      {badge && <Badge tone={badgeTone}>{badge}</Badge>}
    </div>
  );
}

export function Bars({ rows }: { rows: { label: string; pct: number }[] }) {
  return (
    <div className="grid gap-[9px]">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[84px_1fr_44px] items-center gap-3 text-[12px] text-mkt-ink-2">
          <span>{r.label}</span>
          <span className="h-2 overflow-hidden rounded-[5px] bg-mkt-paper-2">
            <i className="block h-full rounded-[5px] bg-mkt-accent" style={{ width: `${r.pct}%` }} />
          </span>
          <b className="text-right font-bold text-mkt-ink">{r.pct}%</b>
        </div>
      ))}
    </div>
  );
}

/* ---------- Intake form mock (workflow stage 01) ---------- */

export function IntakeFormMock() {
  return (
    <UIPanel title="New client intake" sub="Immigration · visa petition" action="New" actionTone="open">
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Client" value="Linh Nguyen" />
          <Field label="Matter type" value="Visa petition" />
        </div>
        <Field label="Practice area" value="Immigration" />
        <div className="flex items-center gap-[10px] rounded-[9px] bg-mkt-accent-soft px-[13px] py-[11px] text-[13px] font-semibold text-mkt-accent-deep">
          <span>✓</span> Intake complete · matter and client created automatically
        </div>
      </div>
    </UIPanel>
  );
}

function Field({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="grid gap-[6px]">
      <label className="text-[11px] font-bold uppercase tracking-[0.04em] text-mkt-ink-3">{label}</label>
      <div
        className={`flex h-[38px] items-center rounded-[9px] border border-mkt-line-2 bg-white px-3 text-[13px] ${
          muted ? "text-mkt-ink-3" : "text-mkt-ink"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/* ---------- Invoice mock (workflow stage 05) ---------- */

export function InvoiceMock() {
  const lines = [
    { d: "Petition preparation · 4.2 hrs", a: "$1,470" },
    { d: "Document drafting · 1.8 hrs", a: "$630" },
    { d: "Filing fee (USCIS)", a: "$460" },
  ];
  return (
    <UIPanel title="Invoice #2026-0118" sub="L. Nguyen · Visa petition" action="Paid" actionTone="disc">
      <div>
        {lines.map((l) => (
          <div key={l.d} className="grid grid-cols-[1fr_auto] gap-3 border-b border-mkt-line-2 py-[10px] text-[13px]">
            <span className="text-mkt-ink-2">{l.d}</span>
            <span className="font-semibold tabular-nums">{l.a}</span>
          </div>
        ))}
        <div className="grid grid-cols-[1fr_auto] gap-3 pt-[14px] font-mkt-serif text-[20px]">
          <span>Total</span>
          <b className="font-semibold">$2,560</b>
        </div>
      </div>
      <div className="flex items-center gap-[10px] rounded-[9px] bg-mkt-accent-soft px-[13px] py-[11px] text-[13px] font-semibold text-mkt-accent-deep">
        <span>✓</span> Paid online · funds applied from trust
      </div>
    </UIPanel>
  );
}

/* ---------- Document automation flow (home spotlight + features lead) ----------
   A three-stage "how it works" panel: pick a template, generate it auto-filled
   from the matter, then send it for e-signature. Stages stack down a numbered
   rail so the sequence reads top-to-bottom in a narrow column. */

const DOC_TEMPLATES = [
  { name: "Engagement Letter", sel: false },
  { name: "Last Will & Testament", sel: true },
  { name: "Asset Schedule", sel: false },
];

export function DocAutomationFlow() {
  return (
    <div className="overflow-hidden rounded-2xl border border-mkt-line bg-mkt-card shadow-mkt-lg">
      <div className="flex items-center justify-between border-b border-mkt-line-2 bg-[#fbfaf6] px-[18px] py-4">
        <div>
          <div className="text-sm font-bold">Document automation</div>
          <div className="mt-px text-[11px] text-mkt-ink-3">Halloran Estate · Probate &amp; trusts</div>
        </div>
        <span className="rounded-[20px] bg-mkt-ink px-[11px] py-[5px] text-[11px] font-semibold text-mkt-paper">
          New from template
        </span>
      </div>

      <div className="p-[18px]">
        <DocStage n="1" title="Choose a template">
          <div className="grid gap-[6px]">
            {DOC_TEMPLATES.map((t) => (
              <div
                key={t.name}
                className={`flex items-center gap-[10px] rounded-[9px] border px-[12px] py-[9px] text-[12.5px] ${
                  t.sel
                    ? "border-transparent bg-mkt-accent-soft font-semibold text-mkt-accent-deep"
                    : "border-mkt-line-2 text-mkt-ink-2"
                }`}
              >
                <FileText size={15} className="flex-none opacity-80" />
                <span className="flex-1">{t.name}</span>
                {t.sel && <Check size={12} />}
              </div>
            ))}
          </div>
        </DocStage>

        <DocStage n="2" title="Generate from the matter">
          <div className="rounded-[10px] border border-mkt-line-2 bg-white p-[14px]">
            <div className="font-mkt-serif text-[13px] font-bold">Last Will &amp; Testament</div>
            <p className="mt-[9px] text-[11.5px] leading-[1.6] text-mkt-ink-2">
              Made by <Merge>Margaret Halloran</Merge>, residing in{" "}
              <Merge>Travis County, Texas</Merge>, on this{" "}
              <Merge>20th day of June, 2026</Merge>.
            </p>
            <div className="mt-[10px] grid gap-[6px]">
              <span className="block h-[6px] w-full rounded bg-mkt-paper-2" />
              <span className="block h-[6px] w-[82%] rounded bg-mkt-paper-2" />
            </div>
            <div className="mt-[12px] inline-flex items-center gap-[7px] text-[11px] font-semibold text-mkt-accent-deep">
              <Sparkles size={13} /> Fields auto-filled from matter data
            </div>
          </div>
        </DocStage>

        <DocStage n="3" title="Send for signature" last>
          <div className="flex items-center gap-3 rounded-[11px] bg-mkt-accent-soft px-[14px] py-[13px]">
            <div className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] bg-white text-mkt-accent-deep">
              <PenLine size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold">Awaiting client signature</div>
              <div className="mt-px text-[11.5px] text-mkt-ink-3">Sent to M. Halloran · e-signature</div>
            </div>
            <Badge tone="trial">Sent</Badge>
          </div>
        </DocStage>
      </div>
    </div>
  );
}

/** Inline highlighted merge field inside the generated-document preview. */
function Merge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-[4px] bg-mkt-accent-soft px-[5px] py-px font-semibold text-mkt-accent-deep">
      {children}
    </span>
  );
}

/** One numbered stage on the document-automation rail. */
function DocStage({
  n,
  title,
  last = false,
  children,
}: {
  n: string;
  title: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[26px_1fr] gap-[13px]">
      <div className="flex flex-col items-center">
        <span className="grid h-[26px] w-[26px] flex-none place-items-center rounded-full bg-mkt-ink text-[12px] font-bold text-mkt-paper">
          {n}
        </span>
        {!last && <span className="my-[6px] w-px flex-1 bg-mkt-line-2" />}
      </div>
      <div className={last ? "" : "pb-[18px]"}>
        <div className="mb-[9px] text-[12.5px] font-bold tracking-[-0.01em]">{title}</div>
        {children}
      </div>
    </div>
  );
}

/* ---------- Generated document preview (features lead) ----------
   A document-viewer panel showing the finished file: a will assembled from a
   template with the matter's parties, place, and date already merged into the
   prose, plus a download toolbar and a "ready to download" status line. Goes
   one level deeper than DocAutomationFlow by showing the actual document. */

export function GeneratedDocMock() {
  return (
    <div className="overflow-hidden rounded-2xl border border-mkt-line bg-mkt-card shadow-mkt-lg">
      {/* viewer toolbar */}
      <div className="flex items-center justify-between gap-3 border-b border-mkt-line-2 bg-[#fbfaf6] px-[18px] py-[13px]">
        <div className="flex min-w-0 items-center gap-[10px]">
          <span className="grid h-[30px] w-[30px] flex-none place-items-center rounded-lg bg-mkt-accent-soft text-mkt-accent-deep">
            <FileText size={15} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-bold">Last_Will_and_Testament.pdf</div>
            <div className="truncate text-[10.5px] text-mkt-ink-3">Generated from template · Halloran Estate</div>
          </div>
        </div>
        <span className="inline-flex flex-none items-center gap-[6px] rounded-[20px] bg-mkt-ink px-[12px] py-[6px] text-[11px] font-semibold text-mkt-paper">
          <Download size={13} /> Download
        </span>
      </div>

      {/* document page */}
      <div className="relative bg-[#e9e7df] p-5">
        <div className="mx-auto max-w-[440px] rounded-[4px] border border-mkt-line-2 bg-white px-[34px] pt-[28px] pb-[34px] shadow-mkt-md">
          <div className="text-center">
            <div className="font-mkt-serif text-[16px] font-bold tracking-[0.02em]">LAST WILL AND TESTAMENT</div>
            <div className="mt-1 font-mkt-serif text-[12px] italic text-mkt-ink-2">of Margaret Halloran</div>
          </div>

          <div className="mt-[18px] grid gap-[12px] text-[10.5px] leading-[1.7] text-mkt-ink-2">
            <p>
              I, <b className="font-semibold text-mkt-ink">Margaret Halloran</b>, a resident of{" "}
              <b className="font-semibold text-mkt-ink">Travis County, Texas</b>, being of sound mind and
              memory, declare this to be my Last Will and Testament, and hereby revoke all wills and
              codicils previously made by me.
            </p>

            <div>
              <div className="mb-[3px] font-mkt-serif text-[10.5px] font-bold tracking-[0.04em] text-mkt-ink">
                ARTICLE I · EXECUTOR
              </div>
              <p>
                I appoint <b className="font-semibold text-mkt-ink">James Mercer</b> to serve as Executor
                of this Will, to act without bond and with full authority to settle my estate.
              </p>
            </div>

            <div>
              <div className="mb-[3px] font-mkt-serif text-[10.5px] font-bold tracking-[0.04em] text-mkt-ink">
                ARTICLE II · DISTRIBUTION
              </div>
              <p>
                I give all my property, real and personal, to the beneficiaries named in the attached
                Asset Schedule, in the shares set forth therein.
              </p>
            </div>

            <p>
              Signed this <b className="font-semibold text-mkt-ink">20th day of June, 2026</b> at Austin,
              Texas.
            </p>

            <div className="mt-2 flex items-end gap-5">
              <div className="flex-1">
                <div className="font-mkt-serif text-[16px] italic leading-none text-mkt-ink">Margaret Halloran</div>
                <div className="mt-[5px] border-t border-mkt-ink/45 pt-[4px] text-[8.5px] font-semibold uppercase tracking-[0.06em] text-mkt-ink-3">
                  Testator
                </div>
              </div>
              <div className="flex-1">
                <div className="text-[16px] leading-none text-transparent">.</div>
                <div className="mt-[5px] border-t border-mkt-line pt-[4px] text-[8.5px] font-semibold uppercase tracking-[0.06em] text-mkt-ink-3">
                  Date
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* fade implies further pages below */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-[#e9e7df]" />
      </div>

      {/* status footer */}
      <div className="flex items-center justify-between gap-3 border-t border-mkt-line-2 bg-[#fbfaf6] px-[18px] py-[10px] text-[11px]">
        <span className="inline-flex items-center gap-[7px] font-semibold text-mkt-accent-deep">
          <Check size={12} /> Auto-filled and ready to download
        </span>
        <span className="flex-none text-mkt-ink-3">Page 1 of 3 · PDF · 84 KB</span>
      </div>
    </div>
  );
}
