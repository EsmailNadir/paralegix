# Settings (Firm Settings + User Preferences)

## Summary

Paralegix's Settings feature covers two distinct scopes that share one backend module:

- **Firm settings**: firm-wide configuration stored in the `law_firms.settings` jsonb column (sidebar layout, billing defaults, messaging privacy, feature opt-outs, admin locks). Read/written through permission-gated routes. The storage warn threshold is the one "setting" that is not in the jsonb: it lives in the `law_firms.storage_warn_at_percent` column.
- **User settings / preferences**: per-user personal preferences stored in the `users.preferences` jsonb (theme, dashboard widgets, notification categories, date format). The old 1:1 `user_settings` table was dissolved by migration 0217 (historical number): preferences moved onto `users`, and the four calendar-sync direction flags moved onto the per-provider `user_oauth_tokens` rows (`is_sync_to_provider` / `is_sync_from_provider`, `backend/db/schema/10_identity.sql:20-21,146-147`). Scoped to the Firebase UID, not the firm.

A third scope, **client settings** (`clients.settings` jsonb), rides the same module but is mostly a portal concern; firm members reach it via `clients.view`/`clients.manage` routes, and clients edit their own copy through the separate `/api/client-portal/...` routes (`portal.routes.ts:487,499`), which call the same `settingsService.getClientSettings`/`updateClientSettings`.

The frontend Settings area is a tabbed page tree under `/lawfirm/[lawFirmId]/settings/*` whose tabs each lazily fetch their own data. Two React contexts cache the most-used slices: `FirmSettingsContext` (firm settings + plan-derived feature flags, seeded from the already-fetched firm record) and `PreferencesContext` (sidebar, dashboard, theme, with `localStorage` hydration). Both live in `frontend/src/contexts/`. `PreferencesContext` consumes `FirmSettingsContext` for the firm slice rather than refetching (`PreferencesContext.tsx:105`). Firm admins can **lock** selected user-level settings (`theme`, `sidebar`, `calendarSyncEnabled`) so members can't override them; the lock panel is on the Customization tab (`customization/page.tsx:106`).

## Key Takeaways

- **Every jsonb write (firm, client, user) is an atomic SQL deep-merge**, with no app-side read-modify-write. `buildDeepMergeExpression` (`settings.repository.ts:50-88`) flattens the patch to leaf `(path, value)` pairs and folds them through `jsonb_set(...)` so concurrent writes don't clobber each other. Missing intermediate parents are created first (one ensure-op per ancestor, reading the parent's current value from the ORIGINAL column, so the SQL grows linearly with the patch). `updatedAt` is stamped last. User preferences now use the same builder against `users.preferences` (`settings.repository.ts:145-155`); the older app-side merge for user settings is gone.
- **`null` leaves CLEAR the key on write.** `flattenPatchLeaves` recurses into plain objects and treats arrays/scalars/`null` as leaves (`settings.repository.ts:38-47`); a `null` leaf becomes a `#-` path-delete (`:78-79`), so the setting falls back to its default. Payloads are bounded: max 50 top-level keys, 64 KB serialized, 12 levels of nesting (`bounded()`, `settings.validation.ts:11-56`).
- **Firm settings writes are closed at two layers.** The firm schema is `.strict()` (`settings.validation.ts:125-199`), so an unknown or authoritative top-level key (`features`, `locks`, `lockedSettings`, `updatedAt`) is a 400 at validation. The service then keeps only `WRITABLE_FIRM_KEYS` = `sidebar`, `billing`, `storage`, `messaging`, `emailNotificationsEnabled` (`settings.service.ts:12-18,197-220`). From `storage` only `warnAtPercent` survives (`pickWritableStorage`, `:36-40`), and it is written to the `law_firms.storage_warn_at_percent` column through `updateStorageConfig` (`storageUsage.ts:202-231`), not into the jsonb. Trap: `timezone` passes the schema (`settings.validation.ts:131-144`) but is not in the whitelist, so it is silently dropped (see Improvements).
- **Feature flags are plan-derived, not stored.** `getFirmSettings` reads `settings` + `plan`, `plan_id`, `billing_status` in one `law_firms` query (`settings.repository.ts:167-185`) and sets `merged.features = getEnabledFeatures(...)` (`settings.service.ts:182-195`). `getEnabledFeatures` applies the same rule as the API gates: plan ceiling AND firm opt-out (`featureCheck.ts:12-43`), so a feature the firm switched off reads back as off.
- **Admin locks override user prefs server-side.** `getUserSettings` substitutes the locked value for `theme`, `sidebar` and `calendarSyncEnabled` (`settings.service.ts:70-97`). For calendar sync, a `false` lock forces all four direction keys off and a `true` lock forces them on. The write side rejects any locked key, and any direction key whenever `calendarSyncEnabled` is locked, regardless of value (`settings.service.ts:116-144`). The General page mirrors the calendar lock: `calendarSyncLocked = isLocked('calendarSyncEnabled') && !canManageLockedSettings` (`general/page.tsx:118`) disables the Google/Outlook dropdowns (`:889`, `:916`), shows a `LockIndicator` (`:892-893`, `:918-919`), and the change handlers early-return (`:262`, `:313`).
- **Write-side lock authority comes from real membership, not the query param.** `updateUserSettings` ignores `?lawFirmId=` and unions the locks of every firm the user belongs to (`getFirmSettingsForUserMemberships`, `settings.repository.ts:203-210`; `settings.service.ts:102-127`). The read side uses the param when present (one JOIN that doubles as the membership check, `getMembershipAndFirmSettings`, `settings.repository.ts:187-201`) and otherwise the same all-memberships list (first firm to lock a key wins).
- **The four sync directions are columns, not jsonb.** `updateUserSettings` strips `allowParalegixToGoogleSync` and its three siblings out of the patch and writes them through `calendarTokens.saveSettings` to `user_oauth_tokens` (`settings.service.ts:146-160`); `getUserSettings` folds them back in from those rows (`settings.repository.ts:116-143`), so the response shape is unchanged.
- **Locking and unlocking are dedicated repo methods**, not the generic deep-merge. `lockSetting` rebuilds `lockedSettings` and `locks` with `coalesce(existing, '{}') || jsonb_build_object(key, ...)` so the first lock on a firm persists (`settings.repository.ts:222-244`); `unlockSetting` deletes the key from both maps with `#-` (`:246-259`). The key is constrained to `LOCKABLE_SETTING_KEYS` (`settings.validation.ts:234-257`).
- **`PreferencesContext` is the client-side persistence layer** for theme/sidebar/dashboard: optimistic updates, `localStorage` hydration for instant theme paint, rollback on API failure (`PreferencesContext.tsx:181-254`).
- **Custom matter fields are a matters concern, not settings.** Definitions live in `matter_field_defs` and values in `matters.custom_fields` (`backend/db/schema/30_matters.sql:78,155-158`), managed from the Matter Config tab's Custom Fields sub-tab. No settings-module route reads or writes them.

## How It Works

### Entry Points

**Backend routes** (settings module mounted under `/api`, `app.ts:882`; users module separately at `app.ts:890`):

| Method & Path | Permission | Handler |
| --- | --- | --- |
| `GET /api/settings/user?lawFirmId=` | auth; firm membership when `lawFirmId` is set | `settings.routes.ts:20-28` |
| `POST /api/settings/user` | auth only (any `lawFirmId` param is ignored) | `settings.routes.ts:31-41` |
| `GET /api/lawfirms/:lawFirmId/settings/firm` | `settings.viewFirm` | `settings.routes.ts:46-54` |
| `PUT /api/lawfirms/:lawFirmId/settings/firm` | `settings.manageFirm` | `settings.routes.ts:57-67` |
| `POST /api/lawfirms/:lawFirmId/settings/lock` | `settings.manageLocked` | `settings.routes.ts:70-80` |
| `POST /api/lawfirms/:lawFirmId/settings/unlock` | `settings.manageLocked` | `settings.routes.ts:85-95` |
| `GET /api/lawfirms/:lawFirmId/clients/:clientId/settings` | `clients.view` | `settings.routes.ts:100-108` |
| `PUT /api/lawfirms/:lawFirmId/clients/:clientId/settings` | `clients.manage` | `settings.routes.ts:111-121` |
| `GET /api/client-portal/lawfirm/:lawFirmId/settings` | client portal auth | `portal.routes.ts:487` |
| `PUT /api/client-portal/lawfirm/:lawFirmId/settings` | client portal auth | `portal.routes.ts:499` |
| `GET /api/users/profile` | auth only | `users.routes.ts:38` |
| `PUT /api/users/update-name` | auth only | `users.routes.ts:60` |

Two other firm-level writers touch `law_firms.settings` outside this module: `PATCH /api/lawfirms/:lawFirmId/billing-settings` (`firm.update`) merges `invoiceReminderEnabled` / `invoiceReminderDays` / `defaultPreDueReminderDays` (`lawfirms.routes.ts:75-90`), and the trust and billing-workbench modules carry their own `GET/PUT /settings` routes (`trust.routes.ts:268,278`, `workbench.routes.ts:74,84`).

**Frontend settings sub-pages**: tabbed shell at `settings/layout.tsx` (tab list `:38-48`):

| Tab | Page file | Notes |
| --- | --- | --- |
| Getting Started | `settings/getting-started/page.tsx` | Onboarding checklist; hidden once complete (`hideWhenComplete`) |
| General | `settings/general/page.tsx` | Profile name, firm info/logo, calendar connections, sync directions (lock-aware, see above) |
| Members | `settings/members/page.tsx` | Firm member list/roles, pending invites |
| Subscriptions | `settings/billing/page.tsx` | Plan/subscription. Tab label reads "Subscriptions"; the route/page file is still `billing` |
| Payments | `settings/payments/page.tsx` | Stripe Connect |
| Roles | `settings/roles/page.tsx` | RBAC roles & permissions |
| Notifications | `settings/notifications/page.tsx` | Per-user: daily digest schedule + 11 in-app category toggles (`CATEGORIES`, `notifications/page.tsx:13-25`) |
| Matter Config | `settings/matter-config/page.tsx` | Sub-tabs (`matter-config/page.tsx:30-38`): practice areas, custom fields, stages, document request presets, lead stages, intake forms, charge codes, courts, deadline sets |
| Customization | `settings/customization/page.tsx` | Theme, sidebar visibility/order, dashboard info, driven by `PreferencesContext`; admin lock panel (`handleToggleLock`, `customization/page.tsx:106`) |
| (not in tab bar) | `settings/charge-codes`, `courts`, `practice-area`, `deadline-sets`, `document-request-templates`, `intake-forms`, `lead-stages`, `matter-fields`, `matter-stages` | Standalone routes for the Matter Config sub-sections |

Tabs can be filtered by plan feature flags (`allTabs.filter((tab) => !tab.feature || features[tab.feature])`, `layout.tsx:51`), where `features` comes from `FirmSettingsContext`; no tab currently sets `feature`.

**Frontend service layer**: `settings.service.ts` (firm/user/client/portal settings, lock/unlock at `:24`, `:30`) and `users.service.ts` (profile). GET calls go through `dedupedGet` to coalesce concurrent identical requests (`settings.service.ts:12,39,51,66`).

### Provider Wiring

The firm layout fetches the firm record once and seeds `FirmSettingsProvider` with `initialSettings` derived from `lawFirm.settings` + plan features. `PreferencesProvider` is mounted **inside** `FirmSettingsProvider` and pulls firm settings via `useFirmSettings()` instead of issuing its own `getFirmSettings` call (`PreferencesContext.tsx:105`). When `initialSettings` is present, `FirmSettingsProvider` treats the seed as source of truth instead of fetching (`FirmSettingsContext.tsx:88-120`).

Firm-setting loads and refreshes discard responses from a previous firm, including failed loads.
Both providers track firm transitions so a refused save from an earlier firm cannot roll back the
current firm's state or persisted theme/sidebar. `FirmSettingsProvider.updateFirmSettings` restores
the previous settings after a refused optimistic save if that update is still the current state
(`FirmSettingsContext.tsx:95-154`; `PreferencesContext.tsx:83-85,193-258`).

### Data Flow: Disabling trust accounting

`setFirmFeature` updates the opt-out and checks client holdings in one transaction. Updating first
holds the firm row until the holdings check completes; a refusal rolls back the opt-out. Deposit
and void writes read the opt-out under a shared firm-row lock retained through commit, so disabling
waits for pending writes before checking holdings. Later writes wait for disabling and are refused
if it commits, including writes into newly created accounts (`settings.service.ts:303-311`;
`trust.repository.ts:23-30,836,1166`). The race tests cover both write orderings, new accounts, and
withdrawal voids in
`backend/tests/settings/trustFeatureRace.test.ts`.

### Data Flow: Reading firm settings

1. `FirmSettingsProvider` mounts. If `initialSettings` was seeded by the layout, it uses that directly; otherwise `loadFirmSettings()` fetches (`FirmSettingsContext.tsx:88-120`).
2. `settingsService.getFirmSettings(lawFirmId)` issues `GET /api/lawfirms/:lawFirmId/settings/firm` through the deduplicator (`settings.service.ts:12`).
3. Route checks `settings.viewFirm` via `requirePermission` (`settings.routes.ts:48`).
4. Backend `getFirmSettings` reads `law_firms.settings` + plan columns in one query (`settings.repository.ts:167-185`) and `deepMerge`s `settings` over `DEFAULTS.firm` (`settings.service.ts:184-185`, `settings.defaults.ts:67-107`).
5. It replaces `merged.features` with `getEnabledFeatures({ plan, planId, billingStatus, settings })` (`settings.service.ts:192`).
6. Response `{ settings }` is merged client-side through `mergeFirmSettings` (defaults overlay, `FirmSettingsContext.tsx:37`) and cached in context state.

### Data Flow: Updating a user preference (theme toggle)

1. Theme button on the Customization page → `updateTheme(value)`.
2. `PreferencesContext.updateTheme` short-circuits if `lockState.theme` is true, sets state, and writes `localStorage["paralegix-theme"]` for instant repaint (`PreferencesContext.tsx:231-254`).
3. Calls `settingsService.updateUserSettings({ theme }, lawFirmId)` → `POST /api/settings/user?lawFirmId=`.
4. Route validates body against `updateUserSettingsSchema` (typed `userPreferencesSchema`, `settings.validation.ts:66-115`) and calls the service (`settings.routes.ts:31-41`).
5. Service loads the locks of every firm the user belongs to, throws `ForbiddenError` if any submitted key is locked, and rejects the calendar direction keys when `calendarSyncEnabled` is locked (`settings.service.ts:116-144`).
6. Direction keys are routed to `user_oauth_tokens` via `calendarTokens.saveSettings`; everything else is deep-merged into `users.preferences` in one `UPDATE` (`settings.service.ts:150-160`, `settings.repository.ts:145-155`).
7. On next load `getUserSettings` re-merges over `DEFAULTS.user` and re-applies firm locks (`settings.service.ts:44-100`).

### Data Flow: Updating firm settings (sidebar reorder)

1. `PreferencesContext.updateSidebarPreferences(newSidebar)` returns early if `lockState.sidebar`; otherwise optimistically sets state + `localStorage` (`PreferencesContext.tsx:181-206`).
2. Calls `settingsService.updateFirmSettings(lawFirmId, { sidebar: newSidebar })` → `PUT /api/lawfirms/:lawFirmId/settings/firm`.
3. Permission `settings.manageFirm` enforced (`settings.routes.ts:59`), body validated by the `.strict()` `firmSettingsSchema` (`settings.validation.ts:125-205`).
4. Service keeps only `WRITABLE_FIRM_KEYS`; `storage.warnAtPercent` is diverted to `updateStorageConfig` (`settings.service.ts:197-220`).
5. Repository deep-merges the patch atomically in SQL via `buildDeepMergeExpression` inside a `firmQuery` (`settings.repository.ts:212-220`). No pre-read. On error, `PreferencesContext` rolls back state + `localStorage`.

### Data Flow: Locking / unlocking a user setting (admin)

1. Customization page `handleToggleLock` (`customization/page.tsx:106`) calls `settingsService.unlockSetting` (`:113`) or `settingsService.lockSetting` (`:121`); changing the locked sidebar or theme value re-locks with the new value (`:139`, `:171`).
2. **Lock**: `POST /api/lawfirms/:lawFirmId/settings/lock` (`settings.manageLocked`, `lockSettingSchema`) → `settingsRepo.lockSetting`, one atomic `UPDATE` that sets `lockedSettings.<key>` and `locks.<key> = true`, creating either map if absent, then stamps `updatedAt` (`settings.repository.ts:222-244`).
3. **Unlock**: `POST /api/lawfirms/:lawFirmId/settings/unlock` (`settings.manageLocked`, `unlockSettingSchema`) → `settingsRepo.unlockSetting`, one atomic `UPDATE` using `#- array['locks', key] #- array['lockedSettings', key]`, then stamps `updatedAt` (`settings.repository.ts:246-259`).

### Data Model

**`law_firms.settings` (jsonb)**: shape defined by `DEFAULTS.firm` (`settings.defaults.ts:67-107`):

| Key | Type | Writable via PUT? | Notes |
| --- | --- | --- | --- |
| `sidebar` | `{ items: [] }` | yes | Sidebar layout/visibility/order |
| `billing` | `{ defaultRate, invoicePrefix:'INV', invoiceStartNumber:1, eventTypeChargeCodeDefaults:{}, timeRounding, lateFee, tax }` (+ `utbmsEnabled` accepted by the schema) | yes | |
| `messaging` | `{ hideClientNamesFromClients: false }` | yes | Hides other clients' names from a client in a group conversation |
| `storage` | `{ quotaBytes, usedBytes, warnAtPercent, hardLimit }` defaults only | no, see note | `warnAtPercent` from the PUT goes to the `storage_warn_at_percent` column; quota/used/hardLimit are the typed columns |
| `emailNotificationsEnabled` | bool | yes | |
| `features` | `{ clientPortal, messaging, calendarSync, analytics, flatFees, fileSharing, templates, trustAccounting, documentSigning }` | no | replaced by `getEnabledFeatures` on every read; a stored `false` is the firm opt-out that read honors |
| `locks` | `{ [key]: true }` | no (lock/unlock routes only) | which user settings are admin-locked |
| `lockedSettings` | `{ [key]: value }` | no (lock/unlock routes only) | the enforced value for each locked key |
| `timezone` | IANA name | accepted by the schema, dropped by the service | read by the invoice reminder pass (`invoiceReminders.service.ts:184`) |
| `invoiceReminderEnabled`, `invoiceReminderDays`, `defaultPreDueReminderDays` | | no (billing-settings route) | written by `lawfirms.routes.ts:75-90` |
| `updatedAt` | ISO string | no, stamped server-side | |

`DEFAULTS.firm` does **not** include a `branding` slice (see Improvements). The `law_firms` row also carries first-class columns used by settings pages but **not** stored in the jsonb: `name/description/address/...`, `logo_object_path`, `plan_id`, `billing_status`, `plan` (jsonb), Stripe columns, and `storage_quota_bytes/storage_used_bytes/storage_hard_limit/storage_warn_at_percent` (`backend/db/schema/10_identity.sql:51-106`). Firm info/branding edits go through `LawFirmService`, not the settings module.

**`users.preferences`** (jsonb, `10_identity.sql:21`) plus **`users.timezone`** (`:20`). `DEFAULTS.user` (`settings.defaults.ts:8-66`): `theme:'system'`, `dashboard:{widgets:[],statCards:[...]}`, `dateFormat:'MM/DD/YYYY'`, `calendarView:'month'`, and a `notifications` object with three parts: `email` (12 per-category booleans read by `emailPreferences.ts` before non-transactional sends, `:16-29`), `digest` (`enabled`, `hour` in the user's own timezone, `days`, `:41-45`), and `inApp` (12 category toggles that gate notification fan-out via `getNotificationPrefsForUsers`, `settings.service.ts:168-178`; `:49-62`). The Notifications page exposes 11 of the 12 in-app keys (`invoiceIssued` has no toggle). The General page also stores `googleCalendarTarget`/`outlookCalendarTarget`/`googleConnectedEmail`/`loggedInWith*` into `preferences`; these are typed, and the object stays `.passthrough()` (`settings.validation.ts:66-109`).

**`user_oauth_tokens`** (`10_identity.sql:129-149`): PK `(user_id, provider in ('google','microsoft'))`. Holds tokens, `calendar_id`, `sync_cursor`, and the two sync booleans the settings module reads and writes for the four direction flags. Token columns are owned by the calendar/auth modules.

**`clients.settings`** (jsonb): shape from `DEFAULTS.client` (`settings.defaults.ts:108-117`): `notifications` (4 email flags), `communication:{preferredMethod}`, `portal:{defaultView}`. `clientId` is always a `clients.id` uuid now (no Firebase-uid fallback): `findClient` (`settings.repository.ts:266-279`) and `resolveClientId` (`:281-294`) both reject a non-uuid. Validated by the `.strict()` `clientSettingsSchema` (`settings.validation.ts:210-224`).

### Key Logic & Rules

- **Merge semantics.** Every settings write deep-merges **in SQL** through `buildDeepMergeExpression`: `flattenPatchLeaves` recurses only into plain objects, so each scalar/array leaf becomes a `jsonb_set` that replaces it in place, creates missing parents, and leaves siblings untouched; a `null` leaf is a `#-` delete (`settings.repository.ts:38-88`). Arrays are replaced wholesale, so `sidebar.items` is fully replaced (correct for reorder/visibility, but you can't patch a single item). Reads use the app-side `deepMerge` over `DEFAULTS` (`settings.defaults.ts:120-132`).
- **Writable-key whitelist** for firm PUT (`settings.service.ts:12-18,197-220`): the `.strict()` schema rejects unknown top-level keys first; the service then drops any schema-valid key not in the whitelist (today only `timezone`). `storage.warnAtPercent` is clamped by `normalizeStorageSettings` and again to 1-100 by `updateStorageConfig`.
- **Validation shapes.** `userPreferencesSchema` is typed but `.passthrough()` so the General/calendar pages can stash extra keys; `firmSettingsSchema` and `clientSettingsSchema` are `.strict()` at the top level with `.passthrough()` sub-objects; all three are wrapped in `bounded()` (`settings.validation.ts:45-224`).
- **Plan feature resolution** on every firm read (`settings.service.ts:192`).
- **Lock enforcement.** Server-side on read (substitution for theme, sidebar, calendarSyncEnabled, plus the direction cascade, `settings.service.ts:70-97`) and on write (403 on any locked key, and on any direction key when calendar sync is locked, `settings.service.ts:116-144`); client-side in `PreferencesContext` (early-return guards, `PreferencesContext.tsx:187,233`) and disabled UI on the Customization and General pages.
- **Permissions per section**: `settings.viewFirm` (read firm), `settings.manageFirm` (write firm), `settings.manageLocked` (lock/unlock), `clients.view`/`clients.manage` (client settings). The user-settings GET requires firm **membership** (not a named permission) when `lawFirmId` is passed, via the JOIN in `getMembershipAndFirmSettings` (`settings.service.ts:46-54`); the POST needs only a valid token.
- **PreferencesContext persistence**: theme read from `localStorage` synchronously for first paint (`PreferencesContext.tsx:85-93`); the firm-locked theme (or user preference if unlocked) overwrites on load and is written back to `localStorage` (`:173-176`); sidebar persisted per-firm under `paralegix-sidebar:<lawFirmId>` (`:27`). Updates are optimistic. Overlapping saves retain the newest pending or successful choice; if every save fails, state and local storage return to the value before the batch. Responses from a previous firm and saves that finish after a firm locks the preference cannot replace the current value.

### Dependencies

- `requirePermission` middleware + roles/members repos for RBAC.
- `getEnabledFeatures` (`shared/plans/featureCheck.ts`) over the plan definitions (`shared/plans/planDefinitions.ts`) for the feature map.
- `normalizeStorageSettings` + storage-quota defaults (`shared/migrations/storageQuota.ts`); `updateStorageConfig` (`shared/utils/storageUsage.ts:202`) for the warn threshold column.
- `calendarTokens.saveSettings` (`modules/calendar/shared/calendarTokens.ts`) for the four sync-direction flags.
- Audited Drizzle contexts (`firmQuery`, `tenantQuery`, `systemQuery`, `scopedUpdate`) for every read and write (`settings.repository.ts:1-9`).
- `FirmSettingsContext`, `PreferencesContext`, `PermissionsContext`, `LawFirmContext` (frontend providers).
- Auth/calendar services for OAuth connection state and sync toggles (General tab).

### Example

Locking the firm theme to dark for all members:

```
POST /api/lawfirms/<firmId>/settings/lock
{ "key": "theme", "value": "dark" }
```

`settingsRepo.lockSetting` sets `lockedSettings.theme = "dark"` and `locks.theme = true` on `law_firms.settings` in one atomic `UPDATE` (`settings.repository.ts:222-244`). Afterwards, any member's `GET /api/settings/user?lawFirmId=<firmId>` returns `theme: "dark"` regardless of stored preference (`settings.service.ts:75-78`), and `POST /api/settings/user` with `{ preferences: { theme: "light" } }` returns **403** "Setting "theme" is locked by your firm admin" (`settings.service.ts:130-134`). Removing the lock:

```
POST /api/lawfirms/<firmId>/settings/unlock
{ "key": "theme" }
```

deletes `theme` from both `locks` and `lockedSettings` via `#-` (`settings.repository.ts:246-259`), restoring member control.

---

## What Can Be Improved

Fixed and therefore not listed: the calendar-sync lock UI on the General page; lock authority on write derived from real memberships rather than `?lawFirmId=`; the lock/unlock key constrained to `LOCKABLE_SETTING_KEYS`; nulls now clear a key instead of being skipped; user preferences deep-merged in SQL instead of a shallow `||`; the four sync-direction flags written to the columns the sync engines read; the firm PUT schema made `.strict()`.

1. **The firm timezone cannot be set through the API.** `firmSettingsSchema` accepts and validates `timezone` (`settings.validation.ts:131-144`), but `WRITABLE_FIRM_KEYS` omits it (`settings.service.ts:12-18`), so the PUT drops it without error and responds "Firm settings updated". The invoice reminder pass reads `settings.timezone` to decide lateness on the firm's calendar (`invoiceReminders.service.ts:184`) and silently falls back to UTC. No frontend page writes it either. Add `timezone` to the whitelist (and a field on the General tab), or remove it from the schema so the gap is visible.

2. **The firm-settings GET reports a `storage` slice that is not the enforced one.** `getFirmSettings` returns `storage` from the jsonb merged over `DEFAULTS.firm` (`settings.service.ts:185`), while the PUT writes `warnAtPercent` to the `storage_warn_at_percent` column (`settings.service.ts:215-218`) and quota/hard-limit live in their own columns. A firm that sets 70% reads back the default 85 (or a stale mirror). Either overlay the typed columns onto `merged.storage` on read, or drop `storage` from the settings response and point callers at the storage-usage endpoint.

3. **Dead code in `updateUserSettings`.** `const initial = deepMergePreferences({}, preferences)` and its `updatedAt` stamp are computed and never used (`settings.repository.ts:146-147`); the write uses `buildDeepMergeExpression` directly. `deepMergePreferences` has no other caller. Delete both.

4. **Duplicated firm-settings merge logic + client-only `branding` slice (low).** Backend `deepMerge` over `DEFAULTS.firm` (`settings.defaults.ts:67-132`) and frontend `mergeFirmSettings` over `DEFAULT_FIRM_SETTINGS` (`FirmSettingsContext.tsx:37`) implement overlapping default-merging, and the shapes diverge: `mergeFirmSettings` always supplies a `branding` default (`FirmSettingsContext.tsx:50-59`) that the backend never produces or persists (`settings.defaults.ts:101-106`); the type is optional (`preferences.ts:194-198`). Consolidate to one canonical default shape, and drop `branding` from the frontend merge.

5. **One in-app category has no toggle.** `DEFAULTS.user.notifications.inApp` has 12 keys (`settings.defaults.ts:49-62`) but the Notifications page lists 11; `invoiceIssued` is missing from `CATEGORIES` (`notifications/page.tsx:13-25`), so a user can never mute it.

6. **User and client preference schemas have no key allow-list.** `userPreferencesSchema` is `.passthrough()` by design (`settings.validation.ts:66-109`) and bounded by `bounded()`, so this is hygiene rather than a size risk; an allow-list would stop ad-hoc keys accumulating in `users.preferences`.
