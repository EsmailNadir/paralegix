const settingsRepo = require('./settings.repository');
const { DEFAULTS, deepMerge } = require('./settings.defaults');
const { ForbiddenError, NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const { normalizeStorageSettings } = require('../../shared/plans/storageQuota');
const { updateStorageConfig } = require('../../shared/utils/storageUsage');
const { getEnabledFeatures } = require('../../shared/plans/featureCheck');
const calendarTokens = require('../calendar/shared/calendarTokens');
import { withDrizzleTransaction, type DrizzleExecutor } from '../../shared/database/queryContext';

// Firm settings keys that callers may write through the free-form settings PUT.
// Authoritative storage quota/limits derive from the plan (not user input), and
// feature flags / locks are managed by dedicated, permission-gated paths.
const WRITABLE_FIRM_KEYS = new Set([
  // Read by `firmZone` (shared/utils/personalDay.ts) for work no person does.
  'timezone',
  'sidebar',
  'billing',
  'storage',
  'messaging',
  'emailNotificationsEnabled',
]);
// The General settings page does not persist a single `calendarSyncEnabled`
// flag. It writes per-direction sub-keys. So when an admin locks
// `calendarSyncEnabled`, treat all of these stored keys as locked too, both for
// read substitution and write rejection.
const CALENDAR_SYNC_SUBKEYS = [
  'allowParalegixToGoogleSync',
  'allowGoogleToParalegixSync',
  'allowParalegixToOutlookSync',
  'allowOutlookToParalegixSync',
];

// Picks the only caller-writable storage value (`warnAtPercent`) out of a
// storage patch and returns it clamped, or `undefined` when there is nothing
// writable in it. quotaBytes/usedBytes/hardLimit are authoritative
// (plan-derived) and never taken from caller input. It lives in
// `law_firms.storage_warn_at_percent`, not in the settings jsonb, so the caller
// applies it separately from the jsonb merge.
function pickWritableStorage(storageInput: any) {
  const input = storageInput || {};
  if (!('warnAtPercent' in input)) return undefined;
  return normalizeStorageSettings({ warnAtPercent: input.warnAtPercent }).warnAtPercent;
}

// ----- User settings -----

export async function getUserSettings({ lawFirmId, userId }: any) {
  let firmSettingsList;
  if (lawFirmId) {
    // The lawFirmId is caller-supplied (query param); verify membership before
    // reading firm settings / applying that firm's locks. One JOINed query does
    // both the membership check and the firm-settings read.
    const { isMember, settings } = await settingsRepo.getMembershipAndFirmSettings(lawFirmId, userId);
    if (!isMember) {
      throw new ForbiddenError('Law Firm does not exist or user is not a member of this law firm');
    }
    firmSettingsList = [settings];
  } else {
    // No explicit firm: derive locks from EVERY firm the user is a member of, so
    // lock substitution still applies on read when the caller omits the param.
    // Previously the read returned raw preferences with no substitution here, while
    // the write path already enforced locks from real membership regardless of the
    // param — this makes the read consistent with the write.
    firmSettingsList = await settingsRepo.getFirmSettingsForUserMemberships(userId);
  }
  const userPrefs = await settingsRepo.getUserSettings(userId);
  const merged = deepMerge(DEFAULTS.user, userPrefs);

  // Apply locks (theme, sidebar, calendarSyncEnabled, ...) from each applicable
  // firm. The first firm to lock a key wins its value, so the result is
  // deterministic for the rare multi-firm-with-conflicting-locks case, and mirrors
  // the write path's "any firm's lock blocks the change" union semantics.
  const applied = new Set();
  for (const firmSettings of (firmSettingsList || [])) {
    const locks = firmSettings.locks || {};
    const lockedSettings = firmSettings.lockedSettings || {};

    if (locks.theme && !applied.has('theme')) {
      merged.theme = lockedSettings.theme;
      applied.add('theme');
    }
    if (locks.sidebar && !applied.has('sidebar')) {
      // Mirror the write-rejection side: when a firm locks `sidebar`, force the
      // firm's locked value back on read so the user sees (not just is blocked
      // from changing) the enforced sidebar. Symmetric with theme/calendarSyncEnabled.
      merged.sidebar = lockedSettings.sidebar;
      applied.add('sidebar');
    }
    if (locks.calendarSyncEnabled && !applied.has('calendarSyncEnabled')) {
      merged.calendarSyncEnabled = lockedSettings.calendarSyncEnabled;
      // The lock governs the actual stored sync-direction keys. Enforce it
      // symmetrically with the write-rejection side: a `false` lock forces every
      // direction off, a `true` lock forces every direction on. (The write side
      // already rejects any sub-key change whenever the lock is set, regardless
      // of value, settings.service.js updateUserSettings.)
      const forced = lockedSettings.calendarSyncEnabled === true;
      CALENDAR_SYNC_SUBKEYS.forEach((k) => { merged[k] = forced; });
      applied.add('calendarSyncEnabled');
    }
  }

  return merged;
}

export async function updateUserSettings({ lawFirmId, userId, preferences }: any) {
  // SECURITY: lock authority is derived from the authenticated user's real firm
  // memberships, NOT from the caller-supplied `lawFirmId` query param. Previously
  // the lock gate only ran when `lawFirmId` was present, so a member could write
  // a locked key simply by omitting (or forging) `?lawFirmId=`. Now we ignore the
  // query param for lock enforcement and look up the locks of every firm the user
  // actually belongs to.
  //
  // Multi-firm semantics (chosen for safety): a write to a key locked by ANY firm
  // the user is a member of is rejected, so no individual firm's lock can be
  // bypassed by routing the request "through" another firm. A user in exactly one
  // firm sees just that firm's locks; a pure client-portal user (zero firm
  // memberships) has no firm locks and writes freely. This mirrors the read-time
  // substitution, which forces each firm's locked value back on read.
  const firmSettingsList = await settingsRepo.getFirmSettingsForUserMemberships(userId);

  // Union of locked keys across all the user's firms.
  const lockedKeys = new Set();
  let calendarSyncLocked = false;
  firmSettingsList.forEach((firmSettings: any) => {
    const locks = firmSettings.locks || {};
    Object.keys(locks).forEach((key) => {
      if (locks[key]) lockedKeys.add(key);
    });
    if (locks.calendarSyncEnabled) calendarSyncLocked = true;
  });

  // Prevent updates to any locked key.
  Object.keys(preferences || {}).forEach((key) => {
    if (lockedKeys.has(key)) {
      throw new ForbiddenError(`Setting "${key}" is locked by your firm admin`);
    }
  });

  // A `calendarSyncEnabled` lock also covers the per-direction sub-keys the
  // General page actually writes, so block those too.
  if (calendarSyncLocked) {
    CALENDAR_SYNC_SUBKEYS.forEach((key) => {
      if (key in (preferences || {})) {
        throw new ForbiddenError('Calendar sync is locked by your firm admin');
      }
    });
  }

  // The four sync directions are columns, not jsonb. `calendarTokens.getSettings`
  // lets the columns override same-named jsonb keys, so writing one of these into
  // `preferences` would read back correctly here and still leave the sync engines
  // on the old value. Route them to the columns and merge only the rest.
  const patch = { ...(preferences || {}) };
  const syncPatch: Record<string, any> = {};
  CALENDAR_SYNC_SUBKEYS.forEach((key) => {
    if (key in patch) {
      syncPatch[key] = patch[key];
      delete patch[key];
    }
  });

  // Which calendar live import watches follows the target setting, so a change
  // to either target re-points that provider's channel or subscription.
  const targetChanges: Array<'google' | 'outlook'> = [];
  if ('googleCalendarTarget' in patch || 'outlookCalendarTarget' in patch) {
    const before = (await settingsRepo.getUserSettings(userId)) || {};
    const effective = (v: any) => v || 'default';
    if ('googleCalendarTarget' in patch && effective(patch.googleCalendarTarget) !== effective(before.googleCalendarTarget)) targetChanges.push('google');
    if ('outlookCalendarTarget' in patch && effective(patch.outlookCalendarTarget) !== effective(before.outlookCalendarTarget)) targetChanges.push('outlook');
  }

  if (Object.keys(patch).length) await settingsRepo.updateUserSettings(userId, patch);
  if (Object.keys(syncPatch).length) await calendarTokens.saveSettings(userId, syncPatch);

  for (const provider of targetChanges) {
    const syncRepo = require('../calendar/shared/calendarSync.repository');
    const resolver = require('../calendar/shared/calendarEntityResolver');
    let afterId = '';
    for (;;) {
      const mappings = await syncRepo.listMappingsForUser(provider, userId, afterId);
      if (!mappings.length) break;
      for (const mapping of mappings) {
        afterId = mapping.externalEventId;
        if (mapping.entityType === 'externalEvent') continue;
        const entity = resolver.resolveFromMapping(mapping);
        const state = await entity?.getState();
        if (!state) continue;
        const context = mapping.entityType === 'invoiceBilling' ? { contextType: entity.context.type, entityId: entity.context.entityId } : {};
        await syncRepo.recordOutboundWork({ provider, userId, entityType: mapping.entityType,
          entityData: { ...state, ...context, lawFirmId: mapping.lawFirmId, relocateCalendar: true }, action: 'updateEventsFromEntity' });
      }
    }
    const firmIds = await require('../users/users.repository').getLawFirmIdsForUser(userId);
    if (firmIds.length) await syncRepo.recordWebhookFailure({ provider, userId, lawFirmId: firmIds[0], changeType: 'catch_up', eventId: 'reconnect', pending: true });
    try {
      if (provider === 'google') await require('../calendar/google/google.service').rearmWatchChannel(userId);
      else await require('../calendar/outlook/outlook.service').rearmSubscription(userId);
    } catch (err: any) {
      // The setting itself is saved; the hourly poll still reads the new
      // calendar, and re-enabling sync recreates the channel.
      console.error(`settings.service: re-pointing ${provider} live import after a target change failed:`, err?.message || err);
    }
  }
  return { message: 'User settings updated' };
}

// Returns each user's in-app notification preferences (`notifications.inApp`),
// merged with defaults, keyed by user id. Built for the notification fan-out:
// one query for all recipients, then a category lookup decides who to notify.
// Users without a stored row (or without the key) get the full default set.
export async function getNotificationPrefsForUsers(userIds: string[]) {
  const stored = await settingsRepo.getPreferencesForUsers(userIds);
  const defaults = DEFAULTS.user.notifications.inApp;
  const map = new Map();
  Array.from(new Set((userIds || []).filter(Boolean))).forEach((userId) => {
    const prefs = stored.get(userId) || {};
    const inApp = (prefs.notifications && prefs.notifications.inApp) || {};
    map.set(userId, deepMerge(defaults, inApp));
  });
  return map;
}

// ----- Firm settings -----

export async function getFirmSettings({ lawFirmId }: any) {
  // Single round-trip: settings jsonb + plan columns come back together.
  const { settings: firmSettings, plan, planId, billingStatus } = await settingsRepo.getFirmSettings(lawFirmId);
  const merged = deepMerge(DEFAULTS.firm, firmSettings);

  // Derive features from the law firm's plan so the sidebar hides items the
  // current plan doesn't include. Resolved through the same rule the API gates
  // apply (`isFeatureEnabled`: plan ceiling AND firm opt-out), because spreading
  // the raw plan features over the stored settings let a plan-allowed feature the
  // firm had switched off read back as enabled while every route for it 403'd.
  merged.features = getEnabledFeatures({ plan, planId, billingStatus, settings: firmSettings });

  return merged;
}

export async function updateFirmSettings({ lawFirmId, settings }: any) {
  const input = settings || {};

  // Whitelist writable keys. Reject authoritative/plan-controlled keys
  // (features, locks, lockedSettings, storage.quotaBytes/hardLimit/usedBytes)
  // so a firm can't raise its own storage quota or flip feature gates via the
  // free-form settings PUT.
  const normalized: Record<string, any> = {};
  let warnAtPercent;
  Object.keys(input).forEach((key) => {
    if (!WRITABLE_FIRM_KEYS.has(key)) return; // silently drop non-writable keys
    if (key === 'storage') {
      warnAtPercent = pickWritableStorage(input.storage);
    } else {
      normalized[key] = input[key];
    }
  });

  await settingsRepo.updateFirmSettings(lawFirmId, normalized);
  if (warnAtPercent !== undefined) {
    await updateStorageConfig(lawFirmId, { warnAtPercent });
  }
  return { message: 'Firm settings updated' };
}

/**
 * Features a firm may switch off for itself, through the dedicated route below.
 *
 * This is deliberately NOT every key in `DEFAULTS.firm.features`. The opt-out is
 * for a feature a firm has decided it does not practise, and switching one off
 * hides a whole area of the product from everyone in the firm. Adding a key here
 * is a product decision, so the set is explicit and short rather than derived.
 *
 * The plan remains the ceiling either way: an opt-out can only ever subtract
 * from what the plan allows (`featureCheck.isFeatureEnabled`).
 */
const FIRM_TOGGLEABLE_FEATURES = new Set(['trustAccounting']);

/**
 * Refuse to switch trust accounting off while the firm still holds client money.
 *
 * Turning the feature off hides the IOLTA ledger from every screen and answers
 * 403 on every trust route. The ledger rows survive, but a firm that still holds
 * client funds is required to keep that ledger available, so hiding it is a
 * bar-rules problem rather than a display preference. Zero the balances first
 * (disburse or transfer), then switch it off.
 *
 * Only the DISABLE direction is checked: re-enabling can never strand funds.
 */
async function assertFeatureSafeToDisable(lawFirmId: string, feature: string, executor: DrizzleExecutor) {
  if (feature !== 'trustAccounting') return;
  const { trustTxnRepo } = require('../trust/trust.repository');
  const { nonzeroLedgers, heldCents } = await trustTxnRepo.summarizeFirmHoldings(lawFirmId, executor);
  if (!nonzeroLedgers) return;
  const amount = (heldCents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
  throw new ValidationError(
    `Trust accounting cannot be turned off while the firm holds client funds. `
    + `${amount} is still on deposit across ${nonzeroLedgers} client ledger`
    + `${nonzeroLedgers === 1 ? '' : 's'}. Disburse or transfer the remaining `
    + `balances to zero, then turn it off.`,
  );
}

/**
 * Switch one plan-allowed feature off (or back on) for a firm.
 *
 * Writes `settings.features.<feature>`, the opt-out half of the gate that
 * `featureCheck.isFeatureEnabled` already honors on every route. Disabling
 * stores `false`; enabling REMOVES the key rather than storing `true`, because
 * the absence of an opt-out is the honest representation: a stored `true` would
 * read as the firm granting itself a feature, which it cannot do. The repository
 * treats a null leaf as a removal.
 *
 * This is a separate route from the firm-settings PUT on purpose. That PUT is
 * free-form and drops `features` wholesale (WRITABLE_FIRM_KEYS), so a feature
 * switch reaching it would be silently ignored; and a feature is not a
 * preference, so it gets its own audited, explicitly-allowlisted path.
 */
export async function setFirmFeature({ lawFirmId, feature, enabled }: any) {
  if (!FIRM_TOGGLEABLE_FEATURES.has(feature)) {
    throw new ValidationError(`"${feature}" is not a feature your firm can turn on or off.`);
  }
  await withDrizzleTransaction(async (executor) => {
    await settingsRepo.updateFirmSettings(lawFirmId, {
      features: { [feature]: enabled ? null : false },
    }, executor);
    // Updating first holds the firm row against trust writes until the holdings check completes.
    if (!enabled) await assertFeatureSafeToDisable(lawFirmId, feature, executor);
  });
  return { message: `Feature "${feature}" ${enabled ? 'enabled' : 'disabled'}` };
}

export async function lockSetting({ lawFirmId, key, value }: any) {
  // Writes `locks.<key>=true` and `lockedSettings.<key>=value` against the exact
  // same flat key slot that unlockSetting prunes, so a lock is always reversible
  // by an unlock of the same key. `key` is constrained to LOCKABLE_SETTING_KEYS
  // by the route validation.
  await settingsRepo.lockSetting(lawFirmId, key, value);
  return { message: `Setting "${key}" locked` };
}

// Clears an admin lock so members can override the setting again. Removes the
// key from both `locks` and `lockedSettings` (the old behavior of locking to a
// null value left the setting effectively locked).
export async function unlockSetting({ lawFirmId, key }: any) {
  await settingsRepo.unlockSetting(lawFirmId, key);
  return { message: `Setting "${key}" unlocked` };
}

// ----- Client settings -----
//
// Client settings live on the `clients.settings` jsonb column. `clientId` here
// is always a `clients.id` uuid: the firm-side route reads it from the URL,
// and the portal passes its resolved clientRecordId (never the linked
// Firebase user_id). A client linked to a company (`client_company_links`) is
// a real standalone `clients` row of their own, so their preferences live on
// THIS same column too - there is no separate per-link settings storage to
// branch on anymore.

export async function getClientSettings({ lawFirmId, clientId }: any) {
  const client = await settingsRepo.findClient(lawFirmId, clientId);
  if (!client) throw new NotFoundError('Client');
  return deepMerge(DEFAULTS.client, client.settings || {});
}

export async function updateClientSettings({ lawFirmId, clientId, settings }: any) {
  // The write deep-merges in SQL, so we only need the canonical row id. No
  // need to read the stored settings jsonb here.
  const client = await settingsRepo.resolveClientId(lawFirmId, clientId);
  if (!client) throw new NotFoundError('Client');
  const rowCount = await settingsRepo.updateClientSettings(lawFirmId, client.id, settings);
  if (!rowCount) throw new NotFoundError('Client');
  return { message: 'Client settings updated' };
}
