import { z } from 'zod';
import { ALLOWED_INCREMENT_MINUTES } from '../billing/shared/timeRounding';

// ----- Payload bounds -----
//
// These jsonb settings blobs are written verbatim into Postgres jsonb columns
// and merged into existing settings, so an unbounded payload is both a storage
// and a merge-cost risk. We cap BOTH the number of top-level keys and the
// serialized byte size so a single PUT can't stash an absurdly large object.
// The bounds are deliberately generous (the real shapes are a handful of keys /
// a few KB) so no payload the app actually sends is rejected.
const MAX_SETTINGS_KEYS = 50;
const MAX_SETTINGS_BYTES = 64 * 1024; // 64 KB serialized
// Real settings nest 2-4 levels (e.g. notifications.inApp.message). Cap depth so
// a byte-cheap deeply-nested patch ({"a":{"a":{...}}}) can't drive the deep-merge
// SQL builder to produce one ensure-op per level. The merge builder is already
// linear per level, so this is defense-in-depth, not the primary guard.
const MAX_SETTINGS_DEPTH = 12;

// Max nesting depth of a plain-object tree, measured iteratively (BFS) with an
// early-out at `cap` so measuring a pathological input can't itself be expensive.
function objectDepth(obj: unknown, cap: number): number {
  if (obj == null || typeof obj !== 'object') return 0;
  let depth = 0;
  let level: unknown[] = [obj];
  while (level.length) {
    depth += 1;
    if (depth > cap) return depth;
    const next: unknown[] = [];
    for (const node of level) {
      if (node && typeof node === 'object' && !Array.isArray(node)) {
        for (const v of Object.values(node)) {
          if (v && typeof v === 'object' && !Array.isArray(v)) next.push(v);
        }
      }
    }
    level = next;
  }
  return depth;
}

// Attaches the key-count + serialized-size + nesting-depth bound to an existing
// object schema. Applied after the per-key typing so a malformed scalar still
// fails with its specific message, and only well-typed-but-oversized payloads
// hit these.
function bounded<T extends z.ZodTypeAny>(schema: T) {
  return schema
    .refine((obj: unknown) => Object.keys((obj as object) || {}).length <= MAX_SETTINGS_KEYS, {
      message: `Too many settings keys (max ${MAX_SETTINGS_KEYS})`,
    })
    .refine((obj: unknown) => Buffer.byteLength(JSON.stringify(obj || {}), 'utf8') <= MAX_SETTINGS_BYTES, {
      message: `Settings payload too large (max ${MAX_SETTINGS_BYTES} bytes)`,
    })
    .refine((obj: unknown) => objectDepth(obj, MAX_SETTINGS_DEPTH + 1) <= MAX_SETTINGS_DEPTH, {
      message: `Settings nesting too deep (max ${MAX_SETTINGS_DEPTH} levels)`,
    });
}

// Preference keys only the server writes: the calendar connection flags and
// states are derived from `user_oauth_tokens`, and the connected Google address
// comes from the provider's ID token on connect.
const SERVER_OWNED_PREFERENCE_KEYS = [
  'loggedInWithGoogle', 'loggedInWithMicrosoft', 'googleConnectedEmail',
  'googleCalendarState', 'microsoftCalendarState',
];

// User preferences: the well-known keys are typed so obviously-wrong shapes are
// rejected at the edge. The object intentionally stays OPEN (.passthrough) and
// is NOT .strict() because the General/calendar pages stash assorted keys (sync
// flags, calendar targets, connection metadata, plus ad-hoc UI flags like
// `sidebarCollapsed`) into `preferences`, and an exhaustive allow-list here
// would silently reject valid client writes. Unknown keys are therefore
// permitted by design; abuse is contained by the `bounded()` size/key-count cap
// applied below.
const userPreferencesSchema = bounded(
  z
    .object({
      theme: z.enum(['light', 'dark', 'system']).optional(),
      dashboard: z
        .object({
          widgets: z.array(z.any()).optional(),
          statCards: z.array(z.string()).optional(),
        })
        .passthrough()
        .optional(),
      // `inApp` and `email` are per-category boolean maps; `digest` carries the
      // daily-digest delivery window. Stays open (passthrough) for
      // forward-compatible keys.
      notifications: z
        .object({
          inApp: z.record(z.string(), z.boolean()).optional(),
          email: z.record(z.string(), z.boolean()).optional(),
          digest: z
            .object({
              enabled: z.boolean().optional(),
              hour: z.number().int().min(0).max(23).optional(),
              days: z.enum(['daily', 'weekdays']).optional(),
            })
            .optional(),
        })
        .passthrough()
        .optional(),
      dateFormat: z.string().optional(),
      calendarView: z.string().optional(),
      // Calendar sync direction toggles + targets written by the General page.
      allowParalegixToGoogleSync: z.boolean().optional(),
      allowGoogleToParalegixSync: z.boolean().optional(),
      allowParalegixToOutlookSync: z.boolean().optional(),
      allowOutlookToParalegixSync: z.boolean().optional(),
      calendarSyncEnabled: z.boolean().optional(),
      googleCalendarTarget: z.enum(['paralegix', 'default']).optional(),
      outlookCalendarTarget: z.enum(['paralegix', 'default']).optional(),
    })
    .passthrough()
    // The calendar connection is read from the stored OAuth grant, never from a
    // flag the client wrote, so the keys that used to carry it are refused
    // rather than silently merged into the open object.
    .refine((obj: Record<string, unknown>) => !SERVER_OWNED_PREFERENCE_KEYS.some((key) => key in obj), {
      message: 'Calendar connection status cannot be set directly. Connect or disconnect the calendar instead.',
    })
);

export const updateUserSettingsSchema = z.object({
  body: z.object({
    preferences: userPreferencesSchema.optional(),
  }),
});

// Firm settings: only the caller-writable slices are typed AND the schema is
// .strict(). The firm-settings PUT has a known, closed shape (the service
// whitelist already drops authoritative keys like features/locks/lockedSettings
// and storage quota fields, so accepting them here would be misleading). A typo
// or attempt to smuggle an authoritative key now fails validation up front
// rather than being silently dropped. The writable sub-objects stay
// .passthrough() so forward-compatible sub-keys (e.g. a new billing pref) don't
// break, but the size/key-count bound still applies.
const firmSettingsSchema = bounded(
  z
    .object({
      // The firm's own calendar. Scheduled work has no request to read `req.tz`
      // from, so anything that decides "is this late today" reads this instead.
      // Unset means UTC, which is what every firm had before the key existed.
      timezone: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .refine((tz: string) => {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: tz });
            return true;
          } catch {
            return false;
          }
        }, { message: 'timezone must be an IANA time zone name, e.g. America/New_York' })
        .optional(),
      sidebar: z
        .object({ items: z.array(z.any()).optional() })
        .passthrough()
        .optional(),
      billing: z
        .object({
          defaultRate: z.number().nullable().optional(),
          invoicePrefix: z.string().optional(),
          invoiceStartNumber: z.number().int().optional(),
          eventTypeChargeCodeDefaults: z.record(z.string(), z.any()).optional(),
          utbmsEnabled: z.boolean().optional(),
          timeRounding: z
            .object({
              enabled: z.boolean().optional(),
              incrementMinutes: z.number().int()
                .refine((m: number) => (ALLOWED_INCREMENT_MINUTES as readonly number[]).includes(m), {
                  message: `incrementMinutes must be one of ${ALLOWED_INCREMENT_MINUTES.join(', ')}`,
                })
                .optional(),
            })
            .passthrough()
            .optional(),
          lateFee: z
            .object({
              enabled: z.boolean().optional(),
              flatAmount: z.number().min(0).max(1000000).optional(),
              percent: z.number().min(0).max(100).optional(),
              graceDays: z.number().int().min(0).max(365).optional(),
              autoApply: z.boolean().optional(),
            })
            .passthrough()
            .optional(),
          tax: z
            .object({
              enabled: z.boolean().optional(),
              defaultRate: z.number().min(0).max(100).optional(),
              label: z.string().max(40).optional(),
            })
            .passthrough()
            .optional(),
          // Strict: these values decide what a client is charged. The card fee
          // can only be switched on through PUT /billing/card-fees, which checks
          // the firm may use it and records its confirmation.
          processingFees: z
            .object({
              card: z.literal('firm', { message: 'Turn on credit card fees in Billing settings.' }).optional(),
              bank: z.enum(['firm', 'client']).optional(),
            })
            .strict()
            .optional(),
          // Written only by PUT /billing/card-fees.
          cardFees: z.never().optional(),
        })
        .passthrough()
        .optional(),
      storage: z
        .object({
          warnAtPercent: z.number().min(0).max(100).optional(),
        })
        .passthrough()
        .optional(),
      messaging: z
        .object({
          hideClientNamesFromClients: z.boolean().optional(),
        })
        .passthrough()
        .optional(),
      emailNotificationsEnabled: z.boolean().optional(),
    })
    .strict()
);

export const updateFirmSettingsSchema = z.object({
  body: z.object({
    settings: firmSettingsSchema,
  }),
});

// Client settings: the three known slices are typed and the top level is
// .strict() (closed shape: only notifications/communication/portal exist), with
// the bound applied for safety.
const clientSettingsSchema = bounded(
  z
    .object({
      notifications: z.record(z.string(), z.any()).optional(),
      communication: z.record(z.string(), z.any()).optional(),
      portal: z.record(z.string(), z.any()).optional(),
    })
    .strict()
);

export const updateClientSettingsSchema = z.object({
  body: z.object({
    settings: clientSettingsSchema,
  }),
});

// The single source of truth for which firm settings an admin may lock/unlock.
// Both the lock and the unlock schema below validate `key` against this enum so
// an unsupported or typo'd key is rejected at the edge. Every entry is a FLAT
// (top-level, dot-free) key, which is what keeps lock and unlock symmetric: the
// repository's lock path splits the key on `.` (nestPartial) and the unlock path
// deletes a single map key, so a dot-free key locks and unlocks the SAME
// `locks.<key>`/`lockedSettings.<key>` slot. The service's read/write
// enforcement only knows these three keys (theme, sidebar, calendarSyncEnabled).
export const LOCKABLE_SETTING_KEYS = ['theme', 'sidebar', 'calendarSyncEnabled'];

const lockableKeySchema = z.enum(LOCKABLE_SETTING_KEYS);

export const lockSettingSchema = z.object({
  body: z.object({
    key: lockableKeySchema,
    // The locked value's shape depends on the key (string for theme, object for
    // sidebar, boolean for calendarSyncEnabled), so it stays open but is size-
    // bounded so the lock can't be used to stash an oversized blob.
    value: z
      .any()
      .refine(
        (v) => Buffer.byteLength(JSON.stringify(v ?? null), 'utf8') <= MAX_SETTINGS_BYTES,
        { message: `Locked value too large (max ${MAX_SETTINGS_BYTES} bytes)` }
      ),
  }),
});

export const unlockSettingSchema = z.object({
  body: z.object({
    key: lockableKeySchema,
  }),
});

// Features a firm may switch off for itself. Kept in step with the service's
// FIRM_TOGGLEABLE_FEATURES set, which is the enforcement copy; this one rejects
// an unknown feature name at the edge so the service never sees it.
export const FIRM_TOGGLEABLE_FEATURE_KEYS = ['trustAccounting'];

export const updateFirmFeatureSchema = z.object({
  params: z.object({
    feature: z.enum(FIRM_TOGGLEABLE_FEATURE_KEYS),
  }),
  body: z.object({
    enabled: z.boolean(),
  }).strict(),
});
