const {
  DEFAULT_STORAGE_QUOTA_BYTES,
  DEFAULT_STORAGE_WARN_AT_PERCENT,
  DEFAULT_STORAGE_HARD_LIMIT,
} = require('../../shared/plans/storageQuota');

export const DEFAULTS = {
  user: {
    theme: 'system',
    dashboard: { widgets: [], statCards: ['openMatters', 'totalMatters', 'pendingTasks', 'upcomingDeadlines'] },
    notifications: {
      // Per-category outbound-email toggles, read by
      // `shared/services/emailPreferences.js` before every non-transactional
      // send. Transactional mail (invitations, receipts, signing invites) is not
      // listed here and cannot be turned off.
      email: {
        taskAssigned: true,
        taskDue: true,
        mention: true,
        message: true,
        matterAdded: true,
        invoiceReminder: true,
        invoicePaid: true,
        documentUploaded: true,
        fileShared: true,
        signingCompleted: true,
        signingDeclined: true,
        eventReminder: true,
      },
      // Daily digest delivery. `enabled` is the single authority on whether a
      // user receives the digest - there is deliberately no matching `digest`
      // key in the `email` map above, because two independent booleans gating
      // one email can disagree: a user with the schedule on and the channel off
      // would receive neither the digest nor the individual reminders it
      // replaces.
      //
      // `hour` is 0-23 in the recipient's own IANA timezone
      // (`users.timezone`), which is captured from the request the
      // browser stamps rather than set by hand. A user with no stored timezone
      // falls back to UTC.
      digest: {
        enabled: true,
        hour: 7,
        days: 'weekdays',
      },
      // Per-category in-app notification toggles. Each key gates whether a
      // notification of that category is created for the user (the fan-out
      // filters recipients by these before inserting). Defaults to all on.
      inApp: {
        taskAssigned: true,
        message: true,
        mention: true,
        matterAdded: true,
        invoicePaid: true,
        invoiceIssued: true,
        invoiceOverdue: true,
        signingRequested: true,
        signingCompleted: true,
        signingDeclined: true,
        documentUploaded: true,
        roleChanged: true,
      },
    },
    dateFormat: 'MM/DD/YYYY',
    calendarView: 'month',
  },
  firm: {
    sidebar: { items: [] },
    billing: {
      defaultRate: null,
      invoicePrefix: 'INV',
      invoiceStartNumber: 1,
      eventTypeChargeCodeDefaults: {},
      timeRounding: { enabled: false, incrementMinutes: 6 },
      lateFee: { enabled: false, flatAmount: 0, percent: 0, graceDays: 0, autoApply: false },
      tax: { enabled: false, defaultRate: 0, label: 'Tax' },
      processingFees: { card: 'firm', bank: 'firm' },
      cardFees: { debitCards: 'absorb', internationalCards: 'absorb', ratePercent: 2.9, fixedCents: 30, confirmation: null },
    },
    storage: {
      quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
      usedBytes: 0,
      warnAtPercent: DEFAULT_STORAGE_WARN_AT_PERCENT,
      hardLimit: DEFAULT_STORAGE_HARD_LIMIT,
    },
    features: {
      clientPortal: true,
      messaging: true,
      calendarSync: true,
      analytics: true,
      flatFees: true,
      fileSharing: true,
      templates: true,
      trustAccounting: true,
      documentSigning: true,
    },
    // Messaging privacy. When hideClientNamesFromClients is on, a client viewing
    // a shared (group) conversation sees other clients as a generic "Client"
    // instead of their real name/avatar. Firm members always see real names.
    messaging: { hideClientNamesFromClients: false },
    locks: {},
    lockedSettings: {},
    // NOTE: `branding` is intentionally absent. The frontend FirmSettings type
    // requires a `branding: {}` slice (DEFAULT_FIRM_SETTINGS, types/preferences.ts)
    // but the backend never reads, writes, or round-trips it. It is a
    // client-only default. Firm branding (logo/colors) lives on first-class
    // law_firms columns owned by LawFirmService, not in this settings jsonb. Do
    // not add it here unless the settings module is meant to persist it.
  },
  client: {
    notifications: {
      emailOnNewInvoice: true,
      emailOnNewMessage: true,
      emailOnMatterUpdate: false,
      emailOnFileShared: true,
    },
    communication: { preferredMethod: 'email' },
    portal: { defaultView: 'matters' },
  },
};

export function deepMerge(defaults: any, overrides: any = {}) {
  if (Array.isArray(defaults) || Array.isArray(overrides)) return overrides ?? defaults;
  if (typeof defaults !== 'object' || defaults === null) return overrides ?? defaults;
  const result = { ...defaults };
  Object.keys(overrides || {}).forEach((key) => {
    if (key in defaults) {
      result[key] = deepMerge(defaults[key], overrides[key]);
    } else {
      result[key] = overrides[key];
    }
  });
  return result;
}
