import type { MatterEventType } from "./matterEvent";

// ─── Sidebar Preferences (Law Firm Level) ────────────────────

export type SidebarItemKey =
  | "dashboard"
  | "matters"
  | "tasks"
  | "messages"
  | "calendar"
  | "billing"
  | "files"
  | "clients"
  | "contacts"
  | "signatures"
  | "trust"
  | "templates";

export type SidebarItem = {
  key: SidebarItemKey;
  visible: boolean;
};

export type SidebarPreferences = {
  items: SidebarItem[];
};

// ─── Dashboard Preferences (User Level) ──────────────────────

export type DashboardWidgetKey =
  | "hero"
  | "stats"
  | "recentMatters"
  | "upcomingTasks"
  | "myAssignments"
  | "messages"
  | "team"
  | "pendingSignatures"
  | "financial"
  | "upcomingPayments"
  | "upcomingEvents"
  | "calendar"
  | "overdueItems"
  | "myTime";

export type DashboardWidgetZone = "main" | "sidebar";

export type StatCardKey =
  | "openMatters"
  | "totalMatters"
  | "closedMatters"
  | "pendingTasks"
  | "completedTasks"
  | "totalTasks"
  | "upcomingDeadlines"
  | "overdueTasks"
  | "unreadMessages"
  | "totalConversations"
  | "teamSize"
  | "outstandingAR"
  | "overdueInvoices"
  | "collectedThisMonth"
  | "unbilledWip"
  | "hoursToday"
  | "hoursThisWeek";

export type DashboardWidget = {
  key: DashboardWidgetKey;
  visible: boolean;
  zone?: DashboardWidgetZone;
};

export type DashboardPreferences = {
  widgets: DashboardWidget[];
  statCards?: StatCardKey[];
};

// ─── Theme Preference (User Level) ──────────────────────────

export type ThemePreference = "light" | "dark" | "system";

// ─── Template Version Preference (User Level) ────────────────

/**
 * Which template experience the Templates page shows this person: Document
 * Overlay uploads, the full HTML / DOCX editor, or the Word-first library.
 */
export type TemplateVersion = "overlay" | "full-editor" | "word-first";

export const DEFAULT_TEMPLATE_VERSION: TemplateVersion = "overlay";

export function isTemplateVersion(value: unknown): value is TemplateVersion {
  return value === "overlay" || value === "full-editor" || value === "word-first";
}

// ─── Top-Level Preference Containers ─────────────────────────

export type InAppNotificationPrefs = {
  taskAssigned?: boolean;
  message?: boolean;
  mention?: boolean;
  matterAdded?: boolean;
  invoicePaid?: boolean;
  invoiceOverdue?: boolean;
  signingRequested?: boolean;
  signingCompleted?: boolean;
  signingDeclined?: boolean;
  documentUploaded?: boolean;
  roleChanged?: boolean;
};

export type EmailNotificationPrefs = {
  taskAssigned?: boolean;
  taskDue?: boolean;
  mention?: boolean;
  message?: boolean;
  matterAdded?: boolean;
  invoiceReminder?: boolean;
  invoicePaid?: boolean;
  documentUploaded?: boolean;
  fileShared?: boolean;
  signingCompleted?: boolean;
  signingDeclined?: boolean;
  eventReminder?: boolean;
};

export type DigestDeliveryPrefs = {
  enabled?: boolean;
  hour?: number;
  days?: "daily" | "weekdays";
};

export type UserNotificationPrefs = {
  // Per-category outbound-email toggles (gates whether the recipient receives
  // a non-transactional email of that category).
  email?: EmailNotificationPrefs;
  // Daily digest delivery. `enabled` here is the only switch for the digest;
  // there is deliberately no `digest` key in `email` above, so the schedule and
  // the delivery channel cannot disagree.
  digest?: DigestDeliveryPrefs;
  // Per-category in-app notification toggles (gates whether the bell/feed
  // receives a notification of that category).
  inApp?: InAppNotificationPrefs;
};

/**
 * How a stored calendar grant reads, derived by the API from the token row:
 * `connected` holds the calendar permission; `unverified` is an older grant
 * whose permission was never recorded (still syncs); `permission_required`
 * and `reconnect_required` cannot sync until the person reconnects.
 */
export type CalendarConnectionState =
  | 'connected'
  | 'unverified'
  | 'permission_required'
  | 'reconnect_required'
  | 'disconnected';

/** What a calendar `check-auth` probe reports. `state` is absent when the probe could not ask. */
export type CalendarAuthStatus = {
  authenticated: boolean;
  state?: CalendarConnectionState;
  email?: string;
};

/**
 * Fields the API derives on read and refuses on write. `loggedInWith*` is true
 * for a grant that can sync (`connected` or `unverified`).
 */
export type DerivedCalendarConnection = {
  loggedInWithGoogle?: boolean;
  loggedInWithMicrosoft?: boolean;
  googleConnectedEmail?: string | null;
  googleCalendarState?: CalendarConnectionState;
  microsoftCalendarState?: CalendarConnectionState;
};

/** The preferences a client may write through `POST /settings/user`. */
export type WritableUserPreferences = {
  dashboard?: DashboardPreferences;
  theme?: ThemePreference;
  templateVersion?: TemplateVersion;
  notifications?: UserNotificationPrefs;
  // Calendar sync directions and targets
  allowParalegixToOutlookSync?: boolean;
  allowParalegixToGoogleSync?: boolean;
  allowGoogleToParalegixSync?: boolean;
  allowOutlookToParalegixSync?: boolean;
  googleCalendarTarget?: "paralegix" | "default";
  outlookCalendarTarget?: "paralegix" | "default";
};

/** The preferences `GET /settings/user` answers with. */
export type UserPreferences = WritableUserPreferences & DerivedCalendarConnection;

export type FirmStorageSettings = {
  quotaBytes: number;
  usedBytes: number;
  warnAtPercent: number;
  hardLimit: boolean;
};

export type FirmFeatures = {
  clientPortal: boolean;
  messaging: boolean;
  calendarSync: boolean;
  analytics: boolean;
  flatFees: boolean;
  fileSharing: boolean;
  templates: boolean;
  trustAccounting: boolean;
  documentSigning: boolean;
};

/**
 * Features a firm may switch off for itself, with the label each one shows.
 *
 * A short, explicit list rather than every key in `FirmFeatures`: switching one
 * off hides a whole area of the product from everyone in the firm, so adding a
 * key here is a product decision. Kept in step with the backend's
 * FIRM_TOGGLEABLE_FEATURES (settings.service.ts), which is what enforces it.
 */
export const FIRM_TOGGLEABLE_FEATURES = {
  trustAccounting: {
    label: "Trust accounting",
    description:
      "Client trust and IOLTA ledgers, reconciliation, and paying invoices from trust. Turn this off if your firm does not hold client funds.",
  },
} as const;

export type FirmFeatureKey = keyof typeof FIRM_TOGGLEABLE_FEATURES;

export type FirmSettings = {
  sidebar: SidebarPreferences;
  billing: {
    defaultRate: number | null;
    invoicePrefix: string;
    invoiceStartNumber: number;
    eventTypeChargeCodeDefaults: Partial<Record<MatterEventType, string | null>>;
    utbmsEnabled?: boolean;
    timeRounding?: {
      enabled: boolean;
      incrementMinutes: number;
    };
    lateFee?: {
      enabled: boolean;
      flatAmount: number;
      percent: number;
      graceDays: number;
      autoApply: boolean;
    };
    tax?: {
      enabled: boolean;
      defaultRate: number;
      label: string;
    };
    // Who pays the online processing fee per payment method. "client" adds it
    // on top of the invoice at checkout.
    processingFees?: {
      card: "firm" | "client";
      bank: "firm" | "client";
    };
  };
  // Client-only slice: the backend settings module never reads, writes, or
  // round-trips `branding` (firm branding lives on first-class law_firms columns
  // owned by LawFirmService (see backend settings.defaults.js). Optional so the
  // type matches what the server actually sends; mergeFirmSettings still always
  // supplies a normalized `{}` default so consumers can read it safely.
  branding?: {
    logoUrl?: string;
    colors?: Record<string, string>;
  };
  firmInfo?: {
    name?: string;
    address?: string;
    phone?: string;
    email?: string;
    size?: string;
    practiceArea?: string;
  };
  storage: FirmStorageSettings;
  features: FirmFeatures;
  lockedSettings: Record<string, any>;
  locks: Record<string, boolean>;
};

export type ClientSettings = {
  notifications: {
    emailOnNewInvoice: boolean;
    emailOnNewMessage: boolean;
    emailOnMatterUpdate: boolean;
    emailOnFileShared: boolean;
  };
  communication: {
    preferredMethod: "email" | "phone" | "portal";
  };
  portal: {
    defaultView: "matters" | "invoices" | "messages" | "files";
  };
};

export const DEFAULT_THEME: ThemePreference = "light";
export const DEFAULT_STORAGE_SETTINGS: FirmStorageSettings = {
  quotaBytes: 314572800,
  usedBytes: 0,
  warnAtPercent: 90,
  hardLimit: true,
};

export const DEFAULT_FIRM_FEATURES: FirmFeatures = {
  clientPortal: true,
  messaging: true,
  calendarSync: true,
  analytics: true,
  flatFees: true,
  fileSharing: true,
  templates: true,
  trustAccounting: true,
  documentSigning: true,
};

// ─── Defaults ────────────────────────────────────────────────

export const DEFAULT_SIDEBAR_ITEMS: SidebarItem[] = [
  { key: "dashboard", visible: true },
  { key: "matters", visible: true },
  { key: "tasks", visible: true },
  { key: "clients", visible: true },
  { key: "contacts", visible: true },
  { key: "calendar", visible: true },
  { key: "billing", visible: true },
  { key: "templates", visible: true },
  { key: "messages", visible: true },
  { key: "signatures", visible: true },
  { key: "files", visible: true },
  { key: "trust", visible: true },
];

export const DEFAULT_SIDEBAR_PREFERENCES: SidebarPreferences = {
  items: DEFAULT_SIDEBAR_ITEMS,
};

export const DEFAULT_DASHBOARD_WIDGETS: DashboardWidget[] = [
  { key: "hero", visible: true },
  { key: "stats", visible: true },
  { key: "recentMatters", visible: true },
  { key: "upcomingTasks", visible: true },
  { key: "myAssignments", visible: true },
  { key: "messages", visible: true },
  { key: "team", visible: true },
  { key: "pendingSignatures", visible: false, zone: "sidebar" },
  // Opt-in widgets. Ship hidden so existing layouts are undisturbed; users
  // enable them from Customize. Permission gating still applies regardless.
  { key: "financial", visible: false },
  { key: "upcomingPayments", visible: true },
  { key: "calendar", visible: true, zone: "sidebar" },
  { key: "upcomingEvents", visible: false },
  { key: "overdueItems", visible: false },
  { key: "myTime", visible: false, zone: "sidebar" },
];

export const DEFAULT_STAT_CARDS: StatCardKey[] = [
  "openMatters",
  "totalMatters",
  "pendingTasks",
  "upcomingDeadlines",
];

export const DEFAULT_DASHBOARD_PREFERENCES: DashboardPreferences = {
  widgets: DEFAULT_DASHBOARD_WIDGETS,
  statCards: DEFAULT_STAT_CARDS,
};

export const DEFAULT_FIRM_SETTINGS: FirmSettings = {
  sidebar: DEFAULT_SIDEBAR_PREFERENCES,
  billing: {
    defaultRate: null,
    invoicePrefix: "INV",
    invoiceStartNumber: 1,
    eventTypeChargeCodeDefaults: {},
  },
  branding: {},
  storage: DEFAULT_STORAGE_SETTINGS,
  features: DEFAULT_FIRM_FEATURES,
  lockedSettings: {},
  locks: {},
};

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  notifications: {
    emailOnNewInvoice: true,
    emailOnNewMessage: true,
    emailOnMatterUpdate: false,
    emailOnFileShared: true,
  },
  communication: {
    preferredMethod: "email",
  },
  portal: {
    defaultView: "matters",
  },
};

// ─── Helpers ─────────────────────────────────────────────────

/** Sidebar item display metadata, used by sidebar and settings UI */
export const SIDEBAR_ITEM_LABELS: Record<SidebarItemKey, string> = {
  dashboard: "Dashboard",
  matters: "Matters",
  tasks: "Tasks",
  messages: "Messages",
  calendar: "Calendar",
  billing: "Billing",
  files: "Files",
  clients: "Clients",
  contacts: "Contacts",
  signatures: "Document Signing",
  trust: "Trust Accounting",
  templates: "Templates",
};

/** Maps sidebar items to the firm feature they require. Items not listed here are always available. */
export const SIDEBAR_FEATURE_REQUIREMENTS: Partial<Record<SidebarItemKey, keyof FirmFeatures>> = {
  messages: "messaging",
  files: "fileSharing",
  templates: "templates",
  signatures: "documentSigning",
  trust: "trustAccounting",
};

/** Dashboard widget display metadata, used by dashboard and customize modal */
export const DASHBOARD_WIDGET_LABELS: Record<DashboardWidgetKey, string> = {
  hero: "Welcome Banner",
  stats: "Stat Cards",
  recentMatters: "Recent Matters",
  upcomingTasks: "Upcoming Tasks",
  myAssignments: "My Assignments",
  messages: "Messages",
  team: "Your Team",
  pendingSignatures: "Pending Signatures",
  financial: "Financial Snapshot",
  upcomingPayments: "Upcoming Payments",
  upcomingEvents: "Upcoming Events",
  calendar: "Calendar",
  overdueItems: "Overdue Tasks",
  myTime: "My Time",
};

/** Stat card display metadata */
export const STAT_CARD_LABELS: Record<StatCardKey, string> = {
  openMatters: "Open Matters",
  totalMatters: "Total Matters",
  closedMatters: "Closed Matters",
  pendingTasks: "Pending Tasks",
  completedTasks: "Completed Tasks",
  totalTasks: "Total Tasks",
  upcomingDeadlines: "Upcoming Deadlines",
  overdueTasks: "Overdue Tasks",
  unreadMessages: "Unread Messages",
  totalConversations: "Conversations",
  teamSize: "Team Members",
  outstandingAR: "Outstanding A/R",
  overdueInvoices: "Overdue Invoices",
  collectedThisMonth: "Collected This Month",
  unbilledWip: "Unbilled WIP",
  hoursToday: "Hours Today",
  hoursThisWeek: "Hours This Week",
};

const DEFAULT_SIDEBAR_ITEMS_BY_KEY: Record<SidebarItemKey, SidebarItem> =
  DEFAULT_SIDEBAR_ITEMS.reduce((acc, item) => {
    acc[item.key] = item;
    return acc;
  }, {} as Record<SidebarItemKey, SidebarItem>);

const DEFAULT_DASHBOARD_WIDGETS_BY_KEY: Record<DashboardWidgetKey, DashboardWidget> =
  DEFAULT_DASHBOARD_WIDGETS.reduce((acc, widget) => {
    acc[widget.key] = widget;
    return acc;
  }, {} as Record<DashboardWidgetKey, DashboardWidget>);

const SIDEBAR_ITEM_KEY_SET = new Set<SidebarItemKey>(Object.keys(DEFAULT_SIDEBAR_ITEMS_BY_KEY) as SidebarItemKey[]);
const DASHBOARD_WIDGET_KEY_SET = new Set<DashboardWidgetKey>(Object.keys(DEFAULT_DASHBOARD_WIDGETS_BY_KEY) as DashboardWidgetKey[]);
const STAT_CARD_KEY_SET = new Set<StatCardKey>(Object.keys(STAT_CARD_LABELS) as StatCardKey[]);

function isSidebarItemKey(value: unknown): value is SidebarItemKey {
  return typeof value === "string" && SIDEBAR_ITEM_KEY_SET.has(value as SidebarItemKey);
}

function isDashboardWidgetKey(value: unknown): value is DashboardWidgetKey {
  return typeof value === "string" && DASHBOARD_WIDGET_KEY_SET.has(value as DashboardWidgetKey);
}

function isStatCardKey(value: unknown): value is StatCardKey {
  return typeof value === "string" && STAT_CARD_KEY_SET.has(value as StatCardKey);
}

function sanitizeSidebarItems(items: unknown): SidebarItem[] {
  const seen = new Set<SidebarItemKey>();
  const savedItems = Array.isArray(items) ? items : [];

  const sanitized = savedItems.flatMap((item) => {
    if (!item || typeof item !== "object") return [];

    const maybeKey = "key" in item ? item.key : undefined;
    if (!isSidebarItemKey(maybeKey) || seen.has(maybeKey)) {
      return [];
    }

    seen.add(maybeKey);
    const defaults = DEFAULT_SIDEBAR_ITEMS_BY_KEY[maybeKey];
    const visible = typeof item.visible === "boolean" ? item.visible : defaults.visible;

    return [{ key: maybeKey, visible }];
  });

  const missing = DEFAULT_SIDEBAR_ITEMS
    .filter((item) => !seen.has(item.key))
    .map((item) => ({ ...item }));

  return [...sanitized, ...missing];
}

function sanitizeDashboardWidgets(widgets: unknown): DashboardWidget[] {
  const seen = new Set<DashboardWidgetKey>();
  const savedWidgets = Array.isArray(widgets) ? widgets : [];

  const sanitized = savedWidgets.flatMap((widget) => {
    if (!widget || typeof widget !== "object") return [];

    const maybeKey = "key" in widget ? widget.key : undefined;
    if (!isDashboardWidgetKey(maybeKey) || seen.has(maybeKey)) {
      return [];
    }

    seen.add(maybeKey);
    const defaults = DEFAULT_DASHBOARD_WIDGETS_BY_KEY[maybeKey];
    const visible = typeof widget.visible === "boolean" ? widget.visible : defaults.visible;
    const zone = widget.zone === "main" || widget.zone === "sidebar" ? widget.zone : defaults.zone;

    return [{ key: maybeKey, visible, zone }];
  });

  const missing = DEFAULT_DASHBOARD_WIDGETS
    .filter((widget) => !seen.has(widget.key))
    .map((widget) => ({ ...widget }));

  return [...sanitized, ...missing];
}

function sanitizeStatCards(statCards: unknown): StatCardKey[] {
  const seen = new Set<StatCardKey>();
  const savedStatCards = Array.isArray(statCards) ? statCards : [];

  const sanitized = savedStatCards.filter((statCard): statCard is StatCardKey => {
    if (!isStatCardKey(statCard) || seen.has(statCard)) {
      return false;
    }

    seen.add(statCard);
    return true;
  });

  return sanitized.length > 0 ? sanitized : [...DEFAULT_STAT_CARDS];
}

/**
 * Merge saved preferences with defaults to ensure all keys are present.
 * Preserves saved order and visibility, appends any new keys from defaults.
 */
export function mergeSidebarPreferences(
  saved: Partial<SidebarPreferences> | undefined
): SidebarPreferences {
  return {
    items: sanitizeSidebarItems(saved?.items),
  };
}

export function mergeDashboardPreferences(
  saved: Partial<DashboardPreferences> | undefined
): DashboardPreferences {
  return {
    widgets: sanitizeDashboardWidgets(saved?.widgets),
    statCards: sanitizeStatCards(saved?.statCards),
  };
}
