const { assertFirmPermission } = require('../../lawfirms/roles/requirePermission');
const { loadFirmPlan, assertFirmBillingActive, enforceFeatureAccess } = require('../../../shared/plans/planEnforcement');
const { runWithConcurrency } = require('../../../shared/utils/runWithConcurrency');
const { assertMatterReadAccess } = require('../../../shared/utils/membership');

/**
 * Firms gated at once. Every distinct firm id costs two to three pg queries on
 * a cache miss (membership + role, the firm's plan row, the feature check), and
 * the id list comes from a batch request body, so the number of firms in it is
 * the caller's choice rather than the app's. Bounding it keeps one batch from
 * holding more of the pool than it has any claim to.
 */
const SYNC_FIRM_GATE_CONCURRENCY = Number(process.env.SYNC_FIRM_GATE_CONCURRENCY) || 4;

/**
 * Cross-tenant guard for batch calendar-sync services.
 *
 * The batch routes (sync-tasks / sync-events) resolve their plan + permission
 * gate from only the FIRST item's lawFirmId, so a batch could mix in items that
 * belong to a different firm. Before touching any row, the service must
 * independently re-apply, per distinct firm, EVERY gate the route only checked
 * for the first item:
 *   - firm membership + the `calendar.sync` permission (assertFirmPermission), and
 *   - the `calendarSync` plan feature + active billing (the plan ceiling).
 *
 * Without the permission/feature checks a user who belongs to firm A (paid,
 * permitted) and firm B (lapsed billing, or a role without calendar.sync) could
 * push firm B's items for free by putting a firm-A item first. Membership alone
 * is not enough.
 *
 * Returns the set of firm ids that pass ALL gates; the caller skips any item
 * whose lawFirmId is not in the set.
 */
export async function resolveSyncableFirmIds(userId: string, lawFirmIds: any) {
  const distinct = [...new Set((lawFirmIds || []).filter(Boolean))];
  const allowed = new Set();
  await runWithConcurrency(distinct.map((firmId) => async () => {
    try {
      // Membership + calendar.sync permission (owner bypasses the permission).
      await assertFirmPermission(firmId, userId, 'calendar.sync');
      // Plan feature + active billing (the same ceiling requireFeature applies).
      const firmData = await loadFirmPlan(firmId);
      if (!firmData) return;
      assertFirmBillingActive(firmData);
      await enforceFeatureAccess(firmId, 'calendarSync', { firmData });
      allowed.add(firmId);
    } catch {
      // Any failed gate (not a member / lacks calendar.sync / feature off /
      // lapsed billing) excludes the firm; its items are skipped.
    }
  }), SYNC_FIRM_GATE_CONCURRENCY);
  return allowed;
}

/**
 * Matters gated at once, for the same reason as the firm bound above: each
 * distinct matter costs a membership probe (plus the owner/admin probe on the
 * widened path), and the list comes from a caller-sized request body.
 */
const SYNC_MATTER_GATE_CONCURRENCY = Number(process.env.SYNC_MATTER_GATE_CONCURRENCY) || 4;

/** Stable key for a (firm, matter) pair, since a matter id is only unique within its firm. */
const matterScopeKey = (lawFirmId: string, matterId: string) => `${lawFirmId}::${matterId}`;

/**
 * The ethical wall for batch calendar sync.
 *
 * `resolveSyncableFirmIds` above answers "may this user act as this FIRM", which
 * is where the batch routes stopped. It is not the question a matter-scoped item
 * asks. Every other matter-scoped read in this app also asks whether the caller
 * is on the matter, and the calendar push has more reason to than most: the item
 * bodies are enriched from the database by
 * `calendarDescriptionBuilder`, which resolves the named matter's CLIENT NAMES
 * AND PHONE NUMBERS out of `matter_clients` and writes them into the event
 * description. A firm member holding `calendar.sync` could therefore name any
 * matter in their firm, including one they were never staffed on, and receive
 * its client roster on their personal Google or Outlook calendar.
 *
 * `assertMatterReadAccess` rather than `assertMatterMembership` on purpose:
 * owners and firm admins already see every matter in the firm (`isFirmOwnerOrAdmin`,
 * and `visibleMatterIds` in dashboard.service returns ALL_MATTERS for them), so
 * holding this one path to strict membership would refuse them a matter they can
 * open in the app. What the widened check keeps is the existence check: a matter
 * id that names nothing in this firm is refused for an owner too, so a caller
 * cannot skip the entity check by holding a privileged role.
 *
 * Takes `[{ lawFirmId, matterId }]` and returns the set of `matterScopeKey`s that
 * pass; the caller skips any item whose pair is not in the set. Items carrying no
 * matter are not matter-scoped and are not this function's business.
 */
async function resolveSyncableMatterKeys(userId: string, refs: any) {
  const distinct = new Map();
  for (const ref of refs || []) {
    if (!ref?.lawFirmId || !ref?.matterId) continue;
    distinct.set(matterScopeKey(ref.lawFirmId, ref.matterId), ref);
  }

  const allowed = new Set();
  await runWithConcurrency([...distinct.entries()].map(([key, ref]: any) => async () => {
    try {
      await assertMatterReadAccess(ref.lawFirmId, ref.matterId, userId);
      allowed.add(key);
    } catch {
      // Not on the matter, not an owner/admin, or no such matter in this firm:
      // the item is skipped rather than failing the whole batch.
    }
  }), SYNC_MATTER_GATE_CONCURRENCY);
  return allowed;
}

/**
 * The ethical wall for one batch, asked of each item's SAVED row.
 *
 * The settings screen sends no matter id for a task, so a wall that read the
 * request let a member assigned to a task on a walled matter receive that
 * matter's client roster. Each row is checked as the loop reaches it, and a
 * matter already answered is not asked again. A row with no matter is not
 * matter-scoped and passes.
 */
export function matterWallFor(userId: string) {
  const answered = new Map<string, Promise<boolean>>();
  return (row: { lawFirmId: string; matterId?: string | null }): Promise<boolean> => {
    if (!row?.matterId) return Promise.resolve(true);
    const key = matterScopeKey(row.lawFirmId, row.matterId);
    let answer = answered.get(key);
    if (!answer) {
      answer = resolveSyncableMatterKeys(userId, [row]).then((allowed) => allowed.has(key));
      answered.set(key, answer);
    }
    return answer;
  };
}
