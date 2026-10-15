// Marketing-site content, mirrored from the backend's real plan definitions
// (backend/src/shared/plans/planDefinitions.js) and actual product modules.
// Keep prices/limits in sync with that file; it is the source of truth.

export type BillingCycle = "annual" | "monthly";

export interface MarketingPlan {
  id: string;
  name: string;
  description: string;
  /** Price shown for each cycle, in whole dollars. Annual shows the per-month equivalent. */
  monthly: number;
  annualPerMonth: number; // annual total / 12, rounded
  annualTotal: number;
  highlight?: boolean;
  flag?: string;
  ctaLabel: string;
  features: string[];
}

// Professional: $50/mo or $500/yr  →  $500/12 ≈ $42/mo billed annually
// Enterprise:   $100/mo or $1000/yr →  $1000/12 ≈ $83/mo billed annually
export const PLANS: MarketingPlan[] = [
  {
    id: "starter",
    name: "Starter",
    description: "For solo practitioners and small practices getting started.",
    monthly: 0,
    annualPerMonth: 0,
    annualTotal: 0,
    ctaLabel: "Start free",
    features: [
      "Up to 25 matters",
      "Up to 3 team members",
      "1 GB document storage",
      "Client portal & secure messaging",
      "Flat-fee billing & invoicing",
      "File sharing",
    ],
  },
  {
    id: "professional",
    name: "Professional",
    description: "For growing firms that need more power and integrations.",
    monthly: 50,
    annualPerMonth: 42,
    annualTotal: 500,
    highlight: true,
    flag: "Most popular",
    ctaLabel: "Start free trial",
    features: [
      "Up to 250 matters",
      "Up to 15 team members",
      "10 GB document storage",
      "Two-way Google & Outlook calendar sync",
      "Trust accounting & reconciliation",
      "Document templates & e-signature",
      "Reporting & analytics",
      "Everything in Starter",
    ],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    description: "For large firms with unlimited needs and premium support.",
    monthly: 100,
    annualPerMonth: 83,
    annualTotal: 1000,
    ctaLabel: "Start free trial",
    features: [
      "Unlimited matters",
      "Unlimited team members",
      "50 GB document storage",
      "Priority support",
      "Onboarding assistance",
      "Everything in Professional",
    ],
  },
];

export interface CmpRow {
  label: string;
  // value per plan id; true/false for checks, or a string for specifics
  starter: boolean | string;
  professional: boolean | string;
  enterprise: boolean | string;
}

export interface CmpGroup {
  group: string;
  rows: CmpRow[];
}

export const COMPARISON: CmpGroup[] = [
  {
    group: "Matters & clients",
    rows: [
      { label: "Active matters", starter: "25", professional: "250", enterprise: "Unlimited" },
      { label: "Team members", starter: "3", professional: "15", enterprise: "Unlimited" },
      { label: "Document storage", starter: "1 GB", professional: "10 GB", enterprise: "50 GB" },
      { label: "Client portal", starter: true, professional: true, enterprise: true },
      { label: "Secure client messaging", starter: true, professional: true, enterprise: true },
    ],
  },
  {
    group: "Billing & trust",
    rows: [
      { label: "Time & flat-fee billing", starter: true, professional: true, enterprise: true },
      { label: "Invoicing & online payments", starter: true, professional: true, enterprise: true },
      { label: "LEDES & UTBMS export", starter: false, professional: true, enterprise: true },
      { label: "Trust accounting & reconciliation", starter: false, professional: true, enterprise: true },
      { label: "Reporting & analytics", starter: false, professional: true, enterprise: true },
    ],
  },
  {
    group: "Calendaring & documents",
    rows: [
      { label: "Deadlines & reminders", starter: true, professional: true, enterprise: true },
      { label: "Google & Outlook calendar sync", starter: false, professional: true, enterprise: true },
      { label: "Document templates", starter: false, professional: true, enterprise: true },
      { label: "Built-in e-signature", starter: false, professional: true, enterprise: true },
      { label: "File sharing", starter: true, professional: true, enterprise: true },
    ],
  },
  {
    group: "Security & admin",
    rows: [
      { label: "Role-based access control", starter: true, professional: true, enterprise: true },
      { label: "Per-firm data isolation", starter: true, professional: true, enterprise: true },
      { label: "Encrypted storage", starter: true, professional: true, enterprise: true },
      { label: "Priority support", starter: false, professional: false, enterprise: true },
    ],
  },
];

export interface Faq {
  q: string;
  a: string;
}

export const FAQS: Faq[] = [
  {
    q: "Is there a free plan?",
    a: "Yes. The Starter plan is free and includes up to 25 matters, 3 team members, 1 GB of storage, the client portal, secure messaging, and flat-fee billing, with no credit card required.",
  },
  {
    q: "Can I change plans later?",
    a: "Absolutely. You can upgrade or downgrade at any time as your firm grows. Your matters, documents, and data stay exactly where they are when you switch.",
  },
  {
    q: "What's included in trust accounting?",
    a: "Professional and Enterprise plans include trust accounting with an append-only ledger, reconciliations, and reversing-entry corrections so completed entries are never silently edited, keeping client funds auditable.",
  },
  {
    q: "Do you support LEDES billing?",
    a: "Yes. Professional and Enterprise plans can export invoices in LEDES format with UTBMS task and activity codes, alongside standard PDF invoicing and online payments.",
  },
  {
    q: "Which calendars does Paralegix sync with?",
    a: "Two-way sync with both Google Calendar and Outlook is available on Professional and Enterprise, so deadlines and events stay current in the tools your team already uses.",
  },
  {
    q: "How is my firm's data secured?",
    a: "Every firm's data is isolated by tenant and protected with role-based permissions. Data is encrypted in transit and at rest, authentication runs on Google, Microsoft, or email sign-in, and sensitive actions are logged.",
  },
];

export const PRACTICE_AREAS = [
  "Litigation",
  "Family law",
  "Immigration",
  "Estate & probate",
  "Corporate",
  "Real estate",
];
