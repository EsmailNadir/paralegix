import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { clients, lawFirms, members, users, userOauthTokens } from '../../shared/database/drizzle/schema';
import {
  firmQuery,
  systemQuery,
  tenantQuery,
  type DrizzleExecutor,
} from '../../shared/database/queryContext';
import { scopedUpdate } from '../../shared/database/scopedWrite';
import { connectionState, syncAllowed } from '../calendar/shared/calendarGrant';
const { isUuid } = require('../../shared/utils/isUuid');

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assignNestedValue(target: any, path: string, value: unknown) {
  const segments = path.split('.');
  if (segments.some((segment) => UNSAFE_KEYS.has(segment))) return;
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!cursor[segment] || typeof cursor[segment] !== 'object' || Array.isArray(cursor[segment])) {
      cursor[segment] = {};
    }
    cursor = cursor[segment];
  }
  cursor[segments[segments.length - 1]] = value;
}

function nestPartial(partialSettings: any) {
  const patch = {};
  Object.entries(partialSettings || {}).forEach(([key, value]) => assignNestedValue(patch, key, value));
  return patch;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function flattenPatchLeaves(object: any, prefix: string[] = []): Array<{ path: string[]; value: any }> {
  const leaves: Array<{ path: string[]; value: any }> = [];
  Object.keys(object || {}).forEach((key) => {
    const value = object[key];
    const path = prefix.concat(key);
    if (isPlainObject(value)) leaves.push(...flattenPatchLeaves(value, path));
    else leaves.push({ path, value });
  });
  return leaves;
}

/** Atomic deep-jsonb merge; null removes a leaf so reads fall back to defaults. */
function buildDeepMergeExpression(column: any, patch: any): SQL {
  const leaves = flattenPatchLeaves(nestPartial(patch));
  leaves.push({ path: ['updatedAt'], value: new Date().toISOString() });
  let expression: SQL = sql`coalesce(${column}, '{}'::jsonb)`;

  const seenAncestors = new Set<string>();
  const ancestors: string[][] = [];
  for (const leaf of leaves) {
    for (let depth = 1; depth < leaf.path.length; depth += 1) {
      const ancestor = leaf.path.slice(0, depth);
      const key = JSON.stringify(ancestor);
      if (!seenAncestors.has(key)) {
        seenAncestors.add(key);
        ancestors.push(ancestor);
      }
    }
  }
  ancestors.sort((left, right) => left.length - right.length);
  for (const ancestor of ancestors) {
    expression = sql`jsonb_set(
      ${expression},
      ${sql.param(ancestor)}::text[],
      coalesce(${column} #> ${sql.param(ancestor)}::text[], '{}'::jsonb),
      true
    )`;
  }

  for (const leaf of leaves) {
    expression = leaf.value === null
      ? sql`(${expression}) #- ${sql.param(leaf.path)}::text[]`
      : sql`jsonb_set(
          ${expression},
          ${sql.param(leaf.path)}::text[],
          ${JSON.stringify(leaf.value)}::jsonb,
          true
        )`;
  }
  return expression;
}

function deepMergePreferences(target: any, patch: any) {
  const output = { ...(target || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (value === null) delete output[key];
    else if (isPlainObject(value)) output[key] = deepMergePreferences(output[key], value);
    else output[key] = value;
  }
  return output;
}

function normalizeSettings(value: any) {
  return value || {};
}

class SettingsRepository {
  /**
   * The user's preferences, with the four calendar-sync directions folded in
   * from their typed columns.
   *
   * Those four live in columns, not in the jsonb: `calendarTokens.getSettings`
   * reads the columns and lets them override anything of the same name in
   * `preferences`, so a value that only reached the jsonb would be read back
   * correctly here and still ignored by the sync engines. Reading and writing
   * them at the same address as the engines is what keeps the toggle honest.
   *
   * The calendar connection is folded in the same way. `googleCalendarState` and
   * `microsoftCalendarState` come from the stored grant through
   * `connectionState()`, and `loggedInWithGoogle`/`loggedInWithMicrosoft` are
   * derived from them, overriding any stale value of the same name in the jsonb.
   */
  async getUserSettings(userId: string, executor?: DrizzleExecutor) {
    // Two reads since migration 0217 dissolved `user_settings`: the preferences
    // jsonb is on the user, and the four sync flags are two columns on each of
    // the user's provider rows. The RESPONSE SHAPE IS UNCHANGED, so callers and
    // the sync engines still read `allowParalegixToGoogleSync` and friends.
    const [prefRows, tokenRows] = await Promise.all([
      systemQuery('auth_identity', (queryExecutor) => queryExecutor
        .select({ preferences: users.preferences })
        .from(users).where(eq(users.id, userId)).limit(1), executor),
      systemQuery('auth_identity', (queryExecutor) => queryExecutor
        .select({
          provider: userOauthTokens.provider,
          toProvider: userOauthTokens.isSyncToProvider,
          fromProvider: userOauthTokens.isSyncFromProvider,
          refreshToken: userOauthTokens.refreshToken,
          scope: userOauthTokens.scope,
          meta: userOauthTokens.meta,
        })
        .from(userOauthTokens).where(eq(userOauthTokens.userId, userId)), executor),
    ]);
    if (!prefRows[0] && !tokenRows.length) return {};
    const google = tokenRows.find((r: any) => r.provider === 'google');
    const microsoft = tokenRows.find((r: any) => r.provider === 'microsoft');
    const grant = (row: any) => (row ? { refresh_token: row.refreshToken, scope: row.scope, meta: row.meta } : null);
    const googleCalendarState = connectionState('google', grant(google));
    const microsoftCalendarState = connectionState('microsoft', grant(microsoft));
    return {
      ...(prefRows[0]?.preferences || {}),
      allowParalegixToGoogleSync: google?.toProvider ?? false,
      allowGoogleToParalegixSync: google?.fromProvider ?? false,
      allowParalegixToOutlookSync: microsoft?.toProvider ?? false,
      allowOutlookToParalegixSync: microsoft?.fromProvider ?? false,
      googleCalendarState,
      microsoftCalendarState,
      loggedInWithGoogle: syncAllowed(googleCalendarState),
      loggedInWithMicrosoft: syncAllowed(microsoftCalendarState),
    };
  }

  async updateUserSettings(userId: string, preferences: any, executor?: DrizzleExecutor) {
    const initial = deepMergePreferences({}, preferences || {});
    initial.updatedAt = new Date().toISOString();
    // The user row always exists by the time preferences are written, so this is
    // an update rather than the upsert `user_settings` needed.
    const expression = buildDeepMergeExpression(users.preferences, preferences || {});
    await systemQuery('auth_identity', (queryExecutor) => queryExecutor
      .update(users)
      .set({ preferences: expression })
      .where(eq(users.id, userId)), executor);
  }

  async getPreferencesForUsers(userIds: unknown[], executor?: DrizzleExecutor) {
    const ids = Array.from(new Set((userIds || []).filter(Boolean))) as string[];
    if (!ids.length) return new Map();
    const rows = await systemQuery('auth_identity', (executor) => executor
      .select({ userId: users.id, preferences: users.preferences })
      .from(users)
      .where(inArray(users.id, ids)), executor);
    return new Map(rows.map((row) => [row.userId, row.preferences || {}]));
  }

  async getFirmSettings(lawFirmId: string, executor?: DrizzleExecutor) {
    const rows = await firmQuery(
      lawFirms,
      lawFirmId,
      ({ executor, scope }) => executor
        .select({
          settings: lawFirms.settings,
          plan: lawFirms.plan,
          planId: lawFirms.planId,
          billingStatus: lawFirms.billingStatus,
        })
        .from(lawFirms)
        .where(scope)
        .limit(1),
      executor,
    );
    if (!rows[0]) return { settings: {}, plan: null, planId: null, billingStatus: null };
    return { ...rows[0], settings: normalizeSettings(rows[0].settings) };
  }

  async getMembershipAndFirmSettings(lawFirmId: string, userId: string, executor?: DrizzleExecutor) {
    const rows = await tenantQuery(
      members,
      lawFirmId,
      ({ executor, scope }) => executor
        .select({ settings: lawFirms.settings })
        .from(members)
        .innerJoin(lawFirms, eq(lawFirms.id, members.lawFirmId))
        .where(and(scope, eq(members.userId, userId)))
        .limit(1),
      executor,
    );
    if (!rows[0]) return { isMember: false, settings: {} };
    return { isMember: true, settings: normalizeSettings(rows[0].settings) };
  }

  async getFirmSettingsForUserMemberships(userId: string, executor?: DrizzleExecutor) {
    const rows = await systemQuery('auth_identity', (executor) => executor
      .select({ settings: lawFirms.settings })
      .from(members)
      .innerJoin(lawFirms, eq(lawFirms.id, members.lawFirmId))
      .where(eq(members.userId, userId)), executor);
    return rows.map((row) => normalizeSettings(row.settings));
  }

  async updateFirmSettings(lawFirmId: string, partialSettings: any, executor?: DrizzleExecutor) {
    const expression = buildDeepMergeExpression(lawFirms.settings, partialSettings);
    await firmQuery(
      lawFirms,
      lawFirmId,
      ({ executor, scope }) => executor.update(lawFirms).set({ settings: expression }).where(scope),
      executor,
    );
  }

  async lockSetting(lawFirmId: string, key: string, value: unknown, executor?: DrizzleExecutor) {
    const updatedAt = JSON.stringify(new Date().toISOString());
    const encodedValue = JSON.stringify(value ?? null);
    const expression = sql`jsonb_set(
      jsonb_set(
        jsonb_set(
          coalesce(${lawFirms.settings}, '{}'::jsonb),
          '{lockedSettings}',
          coalesce(${lawFirms.settings} -> 'lockedSettings', '{}'::jsonb)
            || jsonb_build_object(${key}::text, ${encodedValue}::jsonb),
          true),
        '{locks}',
        coalesce(${lawFirms.settings} -> 'locks', '{}'::jsonb)
          || jsonb_build_object(${key}::text, true),
        true),
      '{updatedAt}', ${updatedAt}::jsonb, true)`;
    await firmQuery(
      lawFirms,
      lawFirmId,
      ({ executor, scope }) => executor.update(lawFirms).set({ settings: expression }).where(scope),
      executor,
    );
  }

  async unlockSetting(lawFirmId: string, key: string, executor?: DrizzleExecutor) {
    const updatedAt = JSON.stringify(new Date().toISOString());
    const expression = sql`jsonb_set(
      coalesce(${lawFirms.settings}, '{}'::jsonb)
        #- array['locks', ${key}::text]
        #- array['lockedSettings', ${key}::text],
      '{updatedAt}', ${updatedAt}::jsonb, true)`;
    await firmQuery(
      lawFirms,
      lawFirmId,
      ({ executor, scope }) => executor.update(lawFirms).set({ settings: expression }).where(scope),
      executor,
    );
  }

  // `clientId` is always a `clients.id` uuid here. Both callers (the firm-side
  // route, which reads it straight from the URL, and the portal, which passes
  // its resolved clientRecordId) now resolve a real client row id before
  // calling in - this used to also accept a Firebase UID as a fallback match
  // against clients.user_id, blending the two id spaces in one param.
  async findClient(lawFirmId: string, clientId: string, executor?: DrizzleExecutor) {
    if (!isUuid(clientId)) return null;
    const rows = await tenantQuery(
      clients,
      lawFirmId,
      ({ executor, scope }) => executor
        .select({ id: clients.id, userId: clients.userId, settings: clients.settings })
        .from(clients)
        .where(and(scope, eq(clients.id, clientId)))
        .limit(1),
      executor,
    );
    return rows[0] ? { ...rows[0], settings: rows[0].settings || {} } : null;
  }

  async resolveClientId(lawFirmId: string, clientId: string, executor?: DrizzleExecutor) {
    if (!isUuid(clientId)) return null;
    const rows = await tenantQuery(
      clients,
      lawFirmId,
      ({ executor, scope }) => executor
        .select({ id: clients.id, userId: clients.userId })
        .from(clients)
        .where(and(scope, eq(clients.id, clientId)))
        .limit(1),
      executor,
    );
    return rows[0] || null;
  }

  async updateClientSettings(
    lawFirmId: string,
    clientRowId: string,
    partialSettings: any,
    executor?: DrizzleExecutor,
  ) {
    const expression = buildDeepMergeExpression(clients.settings, partialSettings);
    const rows = await scopedUpdate(
      clients,
      lawFirmId,
      eq(clients.id, clientRowId),
      { settings: expression },
      executor,
    );
    return rows.length;
  }
}

export = new SettingsRepository();
