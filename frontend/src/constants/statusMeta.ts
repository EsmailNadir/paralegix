/**
 * Every status and priority vocabulary in the app: the words, the colour, and the
 * extra facets individual surfaces need to express the same state without a badge.
 *
 * Two layers:
 *
 * 1. `STATUS_VARIANTS` is the palette. A variant names a *meaning* ("this is
 *    fine", "this needs attention"), not a colour, and carries one entry per way a
 *    surface can express it - a badge's dot, a tinted header, a card's left edge, a
 *    literal hex for chart libraries that cannot take a class name.
 * 2. The `*_META` records map a stored enum value to a label plus one of those
 *    variants. Every surface reads from here, so a state looks and reads the same
 *    everywhere it appears.
 *
 * Add a facet to `STATUS_VARIANTS` rather than hardcoding a shade at a call site.
 * Hardcoding is what left a matter's `active` status blue on the matters grid
 * and detail page but green on the dashboard and the client detail page,
 * and task priority `low` blue in one list and green in another.
 */

export type StatusVariant =
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "neutral"
  | "purple"
  | "indigo"
  | "teal"
  | "pink"
  | "cyan";

export interface StatusVariantStyle {
  /** Solid fill - the badge's leading dot, and standalone status dots. */
  dot: string;
  /** Foreground text, light and dark. */
  text: string;
  /** 10%-alpha wash for tinted surfaces (status chips, icon tiles). */
  tint: string;
  /**
   * Opaque fill for a surface that carries white text and sits over the page
   * rather than in it - toasts. A shade darker than `dot`, which has to read as
   * a small mark against a card and not as a panel.
   */
  solid: string;
  /** Left-edge accent for cards that carry their state on the border. */
  edge: string;
  /** Literal hex for SVG/canvas libraries (recharts) that cannot take a class. */
  hex: string;
}

export const STATUS_VARIANTS: Record<StatusVariant, StatusVariantStyle> = {
  success: { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400", tint: "bg-emerald-500/10", solid: "bg-emerald-600", edge: "border-l-emerald-500", hex: "#10b981" },
  warning: { dot: "bg-amber-500",   text: "text-amber-600 dark:text-amber-400",     tint: "bg-amber-500/10",   solid: "bg-amber-600",   edge: "border-l-amber-500",   hex: "#f59e0b" },
  danger:  { dot: "bg-red-500",     text: "text-red-700 dark:text-red-400",         tint: "bg-red-500/10",     solid: "bg-red-600",     edge: "border-l-red-500",     hex: "#ef4444" },
  info:    { dot: "bg-blue-500",    text: "text-blue-600 dark:text-blue-400",       tint: "bg-blue-500/10",    solid: "bg-blue-600",    edge: "border-l-blue-500",    hex: "#3b82f6" },
  neutral: { dot: "bg-slate-400",   text: "text-on-surface-secondary",              tint: "bg-slate-500/10",   solid: "bg-slate-600",   edge: "border-l-slate-400",   hex: "#94a3b8" },
  purple:  { dot: "bg-purple-500",  text: "text-purple-600 dark:text-purple-400",   tint: "bg-purple-500/10",  solid: "bg-purple-600",  edge: "border-l-purple-500",  hex: "#a855f7" },
  indigo:  { dot: "bg-indigo-500",  text: "text-indigo-600 dark:text-indigo-400",   tint: "bg-indigo-500/10",  solid: "bg-indigo-600",  edge: "border-l-indigo-500",  hex: "#6366f1" },
  teal:    { dot: "bg-teal-500",    text: "text-teal-600 dark:text-teal-400",       tint: "bg-teal-500/10",    solid: "bg-teal-600",    edge: "border-l-teal-500",    hex: "#14b8a6" },
  pink:    { dot: "bg-pink-500",    text: "text-pink-600 dark:text-pink-400",       tint: "bg-pink-500/10",    solid: "bg-pink-600",    edge: "border-l-pink-500",    hex: "#ec4899" },
  cyan:    { dot: "bg-cyan-500",    text: "text-cyan-600 dark:text-cyan-400",       tint: "bg-cyan-500/10",    solid: "bg-cyan-600",    edge: "border-l-cyan-500",    hex: "#06b6d4" },
};

/** One enum value's presentation: the word to show, and the colour to show it in. */
export interface StatusMeta {
  label: string;
  variant: StatusVariant;
}

/** The palette facets of whatever a `*Meta()` lookup returned. */
export const styleOf = (meta: StatusMeta): StatusVariantStyle => STATUS_VARIANTS[meta.variant];

/* ─── Matters ─────────────────────────────────────────────────────────────── */

/**
 * Matter statuses, mirroring `VALID_MATTER_STATUSES` in
 * `backend/src/modules/matters/matters.validation.js`.
 *
 * `active` is blue rather than green so colour separates work still in flight from
 * work that is finished: green is reserved for terminal-good states (Completed,
 * Paid), which lets a badge's colour alone say whether a matter still needs
 * attention.

 */
export const MATTER_STATUS_META: Record<string, StatusMeta> = {
  active:      { label: "Active",    variant: "info"    },
  pending:     { label: "Pending",   variant: "warning" },
  on_hold:     { label: "Paused",    variant: "warning" },
  completed:   { label: "Completed", variant: "success" },
  blocked:     { label: "Blocked",   variant: "danger"  },
  closed:      { label: "Closed",    variant: "neutral" },
  archived:    { label: "Archived",  variant: "neutral" },
};

/** Selectable matter statuses, in display order. */
export const MATTER_STATUS_ORDER = [
  "active",
  "pending",
  "on_hold",
  "completed",
  "blocked",
  "closed",
  "archived",
] as const;

export const matterStatusMeta = (status?: string | null): StatusMeta =>
  MATTER_STATUS_META[status ?? ""] ?? MATTER_STATUS_META.active;

export const MATTER_STATUS_OPTIONS = MATTER_STATUS_ORDER.map((status) => ({
  label: MATTER_STATUS_META[status].label,
  value: status as string,
}));

/* ─── Clients ─────────────────────────────────────────────────────────────── */

/**
 * Client statuses (`clientStatusEnum` in
 * `backend/src/modules/clients/clients.validation.js`).
 *
 * `active` is green here, unlike a matter's blue: a client has no in-flight stage
 * to distinguish, so active *is* the terminal-good state rather than a step toward
 * one.
 */
export const CLIENT_STATUS_META: Record<string, StatusMeta> = {
  active:   { label: "Active",   variant: "success" },
  inactive: { label: "Inactive", variant: "warning" },
  archived: { label: "Archived", variant: "neutral" },
};

export const CLIENT_STATUS_ORDER = ["active", "inactive", "archived"] as const;

export const clientStatusMeta = (status?: string | null): StatusMeta =>
  CLIENT_STATUS_META[status ?? ""] ?? CLIENT_STATUS_META.active;

export const CLIENT_STATUS_OPTIONS = CLIENT_STATUS_ORDER.map((status) => ({
  label: CLIENT_STATUS_META[status].label,
  value: status as string,
  dotClassName: STATUS_VARIANTS[CLIENT_STATUS_META[status].variant].dot,
}));

/* ─── Tasks ───────────────────────────────────────────────────────────────── */

export const TASK_STATUS_META: Record<string, StatusMeta> = {
  open:        { label: "Open",        variant: "info"    },
  in_progress: { label: "In Progress", variant: "purple"  },
  blocked:     { label: "Blocked",     variant: "danger"  },
  completed:   { label: "Completed",   variant: "success" },
};

/** Display order for status dropdowns and filters. */
export const TASK_STATUS_ORDER = ["open", "in_progress", "blocked", "completed"] as const;

export const taskStatusMeta = (status?: string | null): StatusMeta =>
  TASK_STATUS_META[status ?? ""] ?? TASK_STATUS_META.open;

export const TASK_STATUS_OPTIONS = TASK_STATUS_ORDER.map((status) => ({
  label: TASK_STATUS_META[status].label,
  value: status as string,
}));

/**
 * Task priority. Ordered low → urgent, and coloured so severity climbs with the
 * palette rather than jumping hue: `low` is informational blue, `medium` is
 * deliberately neutral (it is the default, and the common case should not shout),
 * then amber and red.
 */
export const TASK_PRIORITY_META: Record<string, StatusMeta> = {
  low:    { label: "Low",    variant: "info"    },
  medium: { label: "Medium", variant: "neutral" },
  high:   { label: "High",   variant: "warning" },
  urgent: { label: "Urgent", variant: "danger"  },
};

export const TASK_PRIORITY_ORDER = ["low", "medium", "high", "urgent"] as const;

export const taskPriorityMeta = (priority?: string | null): StatusMeta =>
  TASK_PRIORITY_META[priority ?? ""] ?? TASK_PRIORITY_META.medium;

export const TASK_PRIORITY_OPTIONS = TASK_PRIORITY_ORDER.map((priority) => ({
  label: TASK_PRIORITY_META[priority].label,
  value: priority as string,
}));

/* ─── Contacts ────────────────────────────────────────────────────────────── */

/**
 * The contact vocabulary, shared by two related fields: a directory contact's
 * `category` (what they usually are) and a `matter_contacts.role` (what they are
 * on one matter). The role list is the narrower of the two - `court_reporter`
 * and `vendor` are people the firm deals with, not parties to a matter - so both
 * read their label and colour from this one record.
 *
 * Colour tracks which side of the matter someone is on: the opposing side is
 * red, the firm's own side and neutral officers of the court are cooler, and
 * everyone who is merely involved is neutral.
 */
export const CONTACT_CATEGORY_META: Record<string, StatusMeta> = {
  opposing_counsel:   { label: "Opposing Counsel",   variant: "danger"  },
  opposing_party:     { label: "Opposing Party",     variant: "danger"  },
  co_counsel:         { label: "Co-Counsel",         variant: "info"    },
  judge:              { label: "Judge",              variant: "purple"  },
  witness:            { label: "Witness",            variant: "teal"    },
  expert:             { label: "Expert",             variant: "indigo"  },
  adjuster:           { label: "Adjuster",           variant: "warning" },
  court_clerk:        { label: "Court Clerk",        variant: "neutral" },
  mediator:           { label: "Mediator",           variant: "success" },
  guardian_ad_litem:  { label: "Guardian ad Litem",  variant: "purple"  },
  court_reporter:     { label: "Court Reporter",     variant: "neutral" },
  vendor:             { label: "Vendor",             variant: "neutral" },
  other:              { label: "Other",              variant: "neutral" },
};

/** Selectable directory categories, in display order. */
export const CONTACT_CATEGORY_ORDER = [
  "opposing_counsel",
  "opposing_party",
  "co_counsel",
  "judge",
  "witness",
  "expert",
  "adjuster",
  "court_clerk",
  "mediator",
  "guardian_ad_litem",
  "court_reporter",
  "vendor",
  "other",
] as const;

/**
 * The roles a contact can play ON a matter. A subset of the categories above:
 * the directory covers everyone the firm deals with, a matter has parties.
 */
export const MATTER_CONTACT_ROLE_ORDER = [
  "opposing_counsel",
  "opposing_party",
  "co_counsel",
  "judge",
  "witness",
  "expert",
  "adjuster",
  "court_clerk",
  "mediator",
  "guardian_ad_litem",
  "other",
] as const;

export const contactCategoryMeta = (category?: string | null): StatusMeta =>
  CONTACT_CATEGORY_META[category ?? ""] ?? CONTACT_CATEGORY_META.other;

export const CONTACT_CATEGORY_OPTIONS = CONTACT_CATEGORY_ORDER.map((category) => ({
  label: CONTACT_CATEGORY_META[category].label,
  value: category as string,
}));

export const MATTER_CONTACT_ROLE_OPTIONS = MATTER_CONTACT_ROLE_ORDER.map((role) => ({
  label: CONTACT_CATEGORY_META[role].label,
  value: role as string,
}));

/* ─── Matter & client events ──────────────────────────────────────────────── */

/**
 * Event types, mirroring `MATTER_EVENT_TYPES` in
 * `backend/src/modules/matters/matterEvents.validation.js`. Client events are
 * validated against the same list, so both tabs read from this one record.
 *
 * Colour tracks consequence rather than category: missing a court date, a trial,
 * or a limitation period is unrecoverable (red), a hearing or deposition is a
 * fixed appointment someone has to be at (amber), a filing or discovery cutoff is
 * ordinary work with a date on it (blue), and a settlement track or a meeting is
 * neither (green/indigo).
 */
export const MATTER_EVENT_TYPE_META: Record<string, StatusMeta> = {
  court_date:             { label: "Court Date",             variant: "danger"  },
  hearing:                { label: "Hearing",                variant: "warning" },
  deposition:             { label: "Deposition",             variant: "warning" },
  filing_deadline:        { label: "Filing Deadline",        variant: "info"    },
  discovery_cutoff:       { label: "Discovery Cutoff",       variant: "info"    },
  mediation:              { label: "Mediation",              variant: "success" },
  arbitration:            { label: "Arbitration",            variant: "success" },
  trial:                  { label: "Trial",                  variant: "danger"  },
  appeal_deadline:        { label: "Appeal Deadline",        variant: "purple"  },
  statute_of_limitations: { label: "Statute of Limitations", variant: "danger"  },
  meeting:                { label: "Meeting",                variant: "indigo"  },
  other:                  { label: "Other",                  variant: "neutral" },
};

/** Selectable event types, in display order. */
export const MATTER_EVENT_TYPE_ORDER = [
  "court_date",
  "hearing",
  "deposition",
  "filing_deadline",
  "discovery_cutoff",
  "mediation",
  "arbitration",
  "trial",
  "appeal_deadline",
  "statute_of_limitations",
  "meeting",
  "other",
] as const;

/**
 * The `type` column is plain text with no check constraint, so rows exist that
 * the current vocabulary does not cover - imported data, and events pulled in by
 * calendar sync that arrived with no type at all. Those fall back to the stored
 * word in title case and a neutral colour, so an unrecognised type still reads as
 * something instead of rendering blank.
 */
export const matterEventTypeMeta = (type?: string | null): StatusMeta =>
  MATTER_EVENT_TYPE_META[type ?? ""] ?? {
    label: (type || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "Event",
    variant: "neutral",
  };

export const MATTER_EVENT_TYPE_OPTIONS = MATTER_EVENT_TYPE_ORDER.map((type) => ({
  label: MATTER_EVENT_TYPE_META[type].label,
  value: type as string,
}));

/* ─── Notes ───────────────────────────────────────────────────────────────── */

/**
 * What a note is about. Colour separates the kinds of contact a note records: a
 * call, meeting or message is a conversation (blue/green/teal), court and
 * research are work product (purple/amber), and a general or internal note is
 * neither.
 */
export const NOTE_TYPE_META: Record<string, StatusMeta> = {
  general:           { label: "General",           variant: "neutral" },
  "phone-call":      { label: "Phone Call",        variant: "info"    },
  meeting:           { label: "Meeting",           variant: "success" },
  court:             { label: "Court Appearance",  variant: "purple"  },
  research:          { label: "Research",          variant: "warning" },
  internal:          { label: "Internal Memo",     variant: "neutral" },
  communication:     { label: "Communication",     variant: "teal"    },
  "document-review": { label: "Document Review",   variant: "indigo"  },
};

export const NOTE_TYPE_ORDER = [
  "general",
  "phone-call",
  "meeting",
  "court",
  "research",
  "internal",
  "communication",
  "document-review",
] as const;

/**
 * Firm-custom note types (added from the note composer's quick-add) have no
 * static entry here, so an unrecognised value falls back to the stored word
 * in title case and a neutral colour rather than silently reading "General".
 */
export const noteTypeMeta = (type?: string | null): StatusMeta =>
  NOTE_TYPE_META[type ?? ""] ?? {
    label: (type || "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "General",
    variant: "neutral",
  };

export const NOTE_TYPE_OPTIONS = NOTE_TYPE_ORDER.map((type) => ({
  label: NOTE_TYPE_META[type].label,
  value: type as string,
}));

/**
 * `noteTypeMeta` plus a per-firm color override (`note_types.color`), for
 * surfaces that have loaded the firm's note-type list and want a firm's own
 * color choice to win over the built-in/fallback one. Keeps a colored note
 * type reading the same everywhere it appears, per this file's guiding rule.
 */
export const resolveNoteTypeMeta = (
  type: string | null | undefined,
  colorOverrides?: Record<string, string>,
): StatusMeta => {
  const base = noteTypeMeta(type);
  const override = type ? colorOverrides?.[type] : undefined;
  return override && override in STATUS_VARIANTS
    ? { ...base, variant: override as StatusVariant }
    : base;
};

/* ─── Recurring billing plans ─────────────────────────────────────────────── */

/**
 * A recurring retainer's own state (`billing_plans.status`). `ended` is neutral
 * rather than red: a retainer reaching its end condition is the plan working,
 * not failing. `paused` is amber because someone has to resume it.
 */
export const BILLING_PLAN_STATUS_META: Record<string, StatusMeta> = {
  active: { label: "Active", variant: "success" },
  paused: { label: "Paused", variant: "warning" },
  ended:  { label: "Ended",  variant: "neutral" },
};

export const billingPlanStatusMeta = (status?: string | null): StatusMeta =>
  BILLING_PLAN_STATUS_META[status ?? ""] ?? BILLING_PLAN_STATUS_META.active;

/**
 * How far a single time entry has travelled towards an invoice
 * (`time_entries.billing_status`). Amber is the only state that still needs
 * someone to act; `queued` is work already sitting on a draft, and `billed` and
 * `covered_by_retainer` are both finished, so they read as calm rather than as
 * two shades of the same green.
 */
export const TIME_ENTRY_BILLING_STATUS_META: Record<string, StatusMeta> = {
  unbilled:            { label: "Unbilled",           variant: "warning" },
  queued:              { label: "On a draft invoice", variant: "info"    },
  billed:              { label: "Billed",             variant: "success" },
  covered_by_retainer: { label: "Included in plan",   variant: "teal"    },
};

export const timeEntryBillingStatusMeta = (status?: string | null): StatusMeta =>
  TIME_ENTRY_BILLING_STATUS_META[status ?? ""] ?? TIME_ENTRY_BILLING_STATUS_META.unbilled;

/* ─── Document requests ───────────────────────────────────────────────────── */

/**
 * A firm-to-client document checklist and the items on it. Two vocabularies,
 * kept together because they are read side by side: a request's own state, and
 * the state of each document it asks for.
 *
 * `waived` and `cancelled` are neutral rather than red: deciding a document is
 * no longer needed is a normal outcome, not a failure.
 */
export const DOCUMENT_REQUEST_STATUS_META: Record<string, StatusMeta> = {
  open:      { label: "Open",      variant: "info"    },
  completed: { label: "Completed", variant: "success" },
  cancelled: { label: "Cancelled", variant: "neutral" },
};

export const documentRequestStatusMeta = (status?: string | null): StatusMeta =>
  DOCUMENT_REQUEST_STATUS_META[status ?? ""] ?? DOCUMENT_REQUEST_STATUS_META.open;

export const DOCUMENT_REQUEST_ITEM_STATUS_META: Record<string, StatusMeta> = {
  pending:  { label: "Pending",  variant: "warning" },
  received: { label: "Received", variant: "success" },
  waived:   { label: "Waived",   variant: "neutral" },
};

export const documentRequestItemStatusMeta = (status?: string | null): StatusMeta =>
  DOCUMENT_REQUEST_ITEM_STATUS_META[status ?? ""] ?? DOCUMENT_REQUEST_ITEM_STATUS_META.pending;

/* ─── Portal access and account type ──────────────────────────────────────── */

/**
 * Whether a client can reach the portal. Green once they are in, amber while an
 * invitation is outstanding, and neutral when nobody has invited them - "not
 * invited" is not a problem, so it does not get a warning colour.
 */
export const CLIENT_PORTAL_STATUS_META: Record<string, StatusMeta> = {
  linked:  { label: "Linked",         variant: "success" },
  pending: { label: "Invite pending", variant: "warning" },
  none:    { label: "Not invited",    variant: "neutral" },
};

export const clientPortalStatusMeta = (status?: string | null): StatusMeta =>
  CLIENT_PORTAL_STATUS_META[status ?? ""] ?? CLIENT_PORTAL_STATUS_META.none;

/**
 * The `user_type` column on `users`: which side of the product an account is on.
 * `pending` is someone who has authenticated but not yet chosen, so it reads as
 * in-progress rather than broken.
 */
export const USER_TYPE_META: Record<string, StatusMeta> = {
  firm_member: { label: "Firm member", variant: "indigo"  },
  client:      { label: "Client",      variant: "success" },
  pending:     { label: "Pending",     variant: "warning" },
};

export const userTypeMeta = (type?: string | null): StatusMeta =>
  USER_TYPE_META[type ?? ""] ?? { label: type || "Unknown", variant: "neutral" };

/* ─── Firm billing ────────────────────────────────────────────────────────── */

/**
 * A firm's subscription state, mirroring the `billing_status` check constraint on
 * `law_firms` in `backend/db/schema.sql`.
 *
 * Colour tracks whether the firm can keep working: `active`, `trialing` and
 * `comped` are all paying-or-permitted (green, blue, purple), `incomplete` and
 * `past_due` need someone to act, and `canceled` is terminal.
 *
 * Only the admin console shows these, but they live here for the same reason
 * every other vocabulary does: the words and the colour are decided once.
 */
export const BILLING_STATUS_META: Record<string, StatusMeta> = {
  active:     { label: "Active",     variant: "success" },
  trialing:   { label: "Trialing",   variant: "info"    },
  comped:     { label: "Comped",     variant: "purple"  },
  incomplete: { label: "Incomplete", variant: "warning" },
  past_due:   { label: "Past Due",   variant: "danger"  },
  canceled:   { label: "Canceled",   variant: "neutral" },

  // `BillingStatus` in `types/subscription.ts` also admits these two, which the
  // check constraint does not. Kept as aliases so old data still reads as
  // something rather than falling through to the default.
  trial:     { label: "Trialing", variant: "info"    },
  suspended: { label: "Canceled", variant: "neutral" },
};

export const billingStatusMeta = (status?: string | null): StatusMeta =>
  BILLING_STATUS_META[status ?? ""] ?? BILLING_STATUS_META.active;

/* ─── Trust accounting ────────────────────────────────────────────────────── */

/**
 * Trust bank account status. `active` is green rather than the blue matters use
 * for "in flight": an account is either open for business or it is not, so this
 * is a terminal-good state, not work still in progress.
 */
export const TRUST_ACCOUNT_STATUS_META: Record<string, StatusMeta> = {
  active:   { label: "Active",   variant: "success" },
  inactive: { label: "Inactive", variant: "neutral" },
};

export const trustAccountStatusMeta = (status?: string | null): StatusMeta =>
  TRUST_ACCOUNT_STATUS_META[status ?? ""] ?? TRUST_ACCOUNT_STATUS_META.inactive;

/**
 * Whether interest earned on a trust account has been paid over to the state bar
 * yet. `pending` is amber because it is money the firm is holding that is not
 * its own, and somebody has to send it.
 */
export const TRUST_REMITTANCE_STATUS_META: Record<string, StatusMeta> = {
  pending:  { label: "Pending",  variant: "warning" },
  remitted: { label: "Remitted", variant: "success" },
};

export const trustRemittanceStatusMeta = (status?: string | null): StatusMeta =>
  TRUST_REMITTANCE_STATUS_META[status ?? ""] ?? TRUST_REMITTANCE_STATUS_META.pending;
