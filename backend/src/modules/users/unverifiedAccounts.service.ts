const usersRepository = require('./users.repository');
const { auth } = require('../../shared/database/firebase');
const { ENV_WHITELIST } = require('../../shared/utils/emailWhitelist');
const { deleteUserPhotoObjects } = require('../../shared/utils/userPhoto');

/**
 * Sweep of never-verified accounts.
 *
 * Signing up writes a Firebase Auth identity AND a `users` row before the
 * address is proven (`POST /auth/create-user` runs on
 * `verifyTokenAllowUnverified`). That is required - the record has to exist
 * before the user can verify - but it means anyone can type a stranger's email
 * into the signup form and permanently occupy that address, since Firebase
 * rejects a second signup for an email already registered. The victim has no
 * self-service way out: the verify-email page offers only resend and sign-out.
 *
 * Such an account is inert while it lasts (every route except create-user and
 * user-type answers 403 EMAIL_NOT_VERIFIED, and invites are only claimed once
 * `emailVerified` is true), so the harm is the squatted address and the
 * indefinitely retained third-party email, not access.
 *
 * SAFETY MODEL. This is the only code path in the app that deletes a live
 * account without a human asking for it, so every rule below is written so that
 * anything unknown, unreachable or unexpected KEEPS the account:
 *
 *  - A systemic failure (whitelist read, Firebase lookup) throws and aborts the
 *    whole run before any delete. It never degrades into "assume not
 *    whitelisted" or "assume no Firebase identity".
 *  - A per-account failure is counted and skipped, never retried destructively.
 *  - Two layers guard what counts as "in use". `findAccountActivity` checks
 *    every reference Postgres would destroy or unlink silently (the cascading
 *    and set-null foreign keys) plus matter ownership; the remaining ~80
 *    no-action foreign keys are enforced by the database itself.
 *  - The row is deleted BEFORE the Firebase identity, so that database check is
 *    the last line of defence: anything still referencing the uid aborts the
 *    delete and the account keeps its login.
 *  - Absence of a Firebase identity is re-confirmed per account, so a batch
 *    anomaly cannot be read as "this user no longer exists".
 *  - The default mode is `dry-run`: the sweep reports what it would delete and
 *    deletes nothing until UNVERIFIED_ACCOUNT_SWEEP_MODE is set to `on`.
 */

/**
 * `on` deletes. `dry-run` (the DEFAULT) evaluates every guard and reports the
 * counts without deleting anything. `off` skips the pass entirely.
 *
 * The default is deliberately not `on`: deploying this must not start deleting
 * accounts on its own. Watch a few dry runs against real data first, then set
 * the mode explicitly.
 */
const MODE = (process.env.UNVERIFIED_ACCOUNT_SWEEP_MODE || 'dry-run').toLowerCase();

/**
 * How long an account may sit unverified before it is swept.
 *
 * Floored at 1 day and validated as a finite number: a typo that leaves this
 * empty, zero or negative would otherwise select every account ever created.
 */
const GRACE_DAYS = (() => {
  const configured = Number(process.env.UNVERIFIED_ACCOUNT_GRACE_DAYS);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 7;
})();

/** Rows examined per run, clamped for the same reason as the grace period. */
const SWEEP_BATCH = (() => {
  const configured = Number(process.env.UNVERIFIED_ACCOUNT_SWEEP_BATCH);
  return Number.isFinite(configured) && configured >= 1 ? Math.min(Math.floor(configured), 1000) : 200;
})();

// `auth.getUsers()` accepts at most 100 identifiers per call.
const FIREBASE_LOOKUP_CHUNK = 100;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Address sets that block a sweep, resolved once per run for the whole batch. */
interface KnownEmails {
  whitelisted: Set<string>;
  invited: Set<string>;
  clientRecord: Set<string>;
}

/**
 * Look the candidates up in Firebase in chunks, returning a uid -> record map.
 * A throw here aborts the run: a lookup we could not complete must never be
 * read as "these accounts have no identity".
 */
async function fetchAuthRecords(userIds: string[]) {
  const byUid = new Map<string, any>();
  for (let i = 0; i < userIds.length; i += FIREBASE_LOOKUP_CHUNK) {
    const chunk = userIds.slice(i, i + FIREBASE_LOOKUP_CHUNK);
    // eslint-disable-next-line no-await-in-loop -- sequential on purpose: chunks
    // are a rate-limit concession to Firebase, not work to fan out.
    const { users: found } = await auth.getUsers(chunk.map((uid) => ({ uid })));
    for (const record of found) byUid.set(record.uid, record);
  }
  return byUid;
}

/**
 * Confirm that Firebase really has no identity for this uid, rather than
 * trusting its absence from a batch response. Returns true ONLY on an explicit
 * `auth/user-not-found`; any other error propagates and skips the account.
 */
async function confirmAuthIdentityGone(userId: string) {
  try {
    await auth.getUser(userId);
    return false;
  } catch (err: any) {
    if (err && err.code === 'auth/user-not-found') return true;
    throw err;
  }
}

/** Remove the Firebase Auth identity, tolerating an already-absent account. */
async function deleteAuthIdentity(userId: string) {
  try {
    await auth.deleteUser(userId);
  } catch (err: any) {
    if (err && err.code === 'auth/user-not-found') return;
    throw err;
  }
}

/**
 * Decide whether one candidate may be swept on the evidence available without
 * further queries. Returns null when it may, or the name of the stat bucket
 * explaining why it may not.
 */
function blockedReason(candidate: any, record: any, known: KnownEmails): string | null {
  if (candidate.isAdmin) return 'keptAdmin';

  const email = String(candidate.email || '').trim().toLowerCase();

  // An account we cannot identify by address is one we cannot reason about.
  if (!email) return 'keptNoEmail';
  if (known.whitelisted.has(email)) return 'keptWhitelisted';

  // A firm invited this address, or already has a client on its books at it.
  // Neither is linked to the account yet - that only happens once the address is
  // verified - so a uid-keyed check cannot see them. Both mean a real person is
  // most likely mid-onboarding, and re-registering after a wrongful delete is a
  // worse experience than an address staying occupied a while longer.
  if (known.invited.has(email)) return 'keptInvited';
  if (known.clientRecord.has(email)) return 'keptClientRecord';

  // No Firebase identity in the batch response. Treated as a possible orphaned
  // row, but only after confirmAuthIdentityGone re-checks it individually.
  if (!record) return null;

  if (record.emailVerified) return 'keptVerified';

  // Only password sign-ups can be unverified in the first place. Any other
  // provider vouches for the address, so never sweep one on the strength of a
  // stale emailVerified flag.
  const providers = (record.providerData || []).map((p: any) => p.providerId);
  if (!providers.length) return 'keptVerified';
  if (providers.some((id: string) => id !== 'password')) return 'keptVerified';

  // Trust whichever clock is more generous. A row backdated by an import must
  // not drag a genuinely new signup into the sweep.
  const created = Date.parse(record.metadata?.creationTime || '');
  if (Number.isFinite(created) && Date.now() - created < GRACE_DAYS * MS_PER_DAY) {
    return 'keptRecent';
  }

  return null;
}

/**
 * Cron entry point (housekeeping, daily): delete accounts that never verified
 * their email address, freeing the address for whoever actually owns it.
 *
 * Deletion order is the row FIRST, then the Firebase identity. The row delete is
 * the guarded step - every foreign key that has no delete action aborts it - so
 * doing it first means a uid the activity check somehow missed keeps both its
 * data and its login. The cost is that a crash between the two steps leaves a
 * Firebase identity with no row pointing at it, which keeps that one address
 * blocked until an operator clears it. That is a recoverable inconvenience for
 * one account; the reverse order risks taking the login off a real user, which
 * is not.
 */
export async function purgeUnverifiedAccounts() {
  const results = {
    mode: MODE,
    graceDays: GRACE_DAYS,
    scanned: 0,
    deleted: 0,
    wouldDelete: 0,
    keptVerified: 0,
    keptInUse: 0,
    keptReferenced: 0,
    keptRecent: 0,
    keptAdmin: 0,
    keptWhitelisted: 0,
    keptInvited: 0,
    keptClientRecord: 0,
    keptNoEmail: 0,
    keptAuthPresent: 0,
    failed: 0,
    // Which check held each kept-in-use account back, for reading a dry run.
    keptInUseBy: {} as Record<string, number>,
  };
  if (MODE === 'off') return results;

  const candidates = await usersRepository.findOlderThanDays({
    days: GRACE_DAYS,
    limit: SWEEP_BATCH,
  });
  if (!candidates.length) return results;
  results.scanned = candidates.length;

  // Every lookup below throws rather than degrades. An unreadable whitelist, an
  // unreadable firm record or an unreachable Firebase must abort the run, never
  // widen what gets deleted.
  const candidateEmails = candidates.map((row: any) => row.email);
  const whitelisted = await usersRepository.findWhitelistedEmails(candidateEmails);
  for (const envEntry of ENV_WHITELIST) whitelisted.add(envEntry);

  const firmRecords = await usersRepository.findEmailsWithFirmRecords(candidateEmails);
  const known: KnownEmails = {
    whitelisted,
    invited: firmRecords.invited,
    clientRecord: firmRecords.clients,
  };

  const authRecords = await fetchAuthRecords(candidates.map((row: any) => row.id));

  for (const candidate of candidates) {
    const record = authRecords.get(candidate.id);
    const reason = blockedReason(candidate, record, known);
    if (reason) {
      (results as any)[reason] += 1;
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop -- one account at a time on
      // purpose: this deletes accounts, so it is not work to fan out.
      const activeVia = await usersRepository.findAccountActivity(candidate.id);
      if (activeVia) {
        results.keptInUse += 1;
        results.keptInUseBy[activeVia] = (results.keptInUseBy[activeVia] || 0) + 1;
        continue;
      }

      // The batch lookup said Firebase has no identity for this uid. Confirm it
      // one-to-one before acting on an absence.
      // eslint-disable-next-line no-await-in-loop
      if (!record && !(await confirmAuthIdentityGone(candidate.id))) {
        results.keptAuthPresent += 1;
        continue;
      }

      if (MODE !== 'on') {
        results.wouldDelete += 1;
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const removed = await usersRepository.deleteAccount(candidate.id);
      if (!removed) {
        // The row vanished between the scan and now. Nothing to do, and the
        // identity is deliberately left alone rather than deleted on a guess.
        results.failed += 1;
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await deleteAuthIdentity(candidate.id);
      // eslint-disable-next-line no-await-in-loop
      await deleteUserPhotoObjects(candidate.id);
      results.deleted += 1;
    } catch (err: any) {
      // 23503 is a foreign-key violation: something still references this uid
      // through one of the ~80 no-action foreign keys, and Postgres refused the
      // delete. That is the backstop working, not a fault, so it is counted as a
      // clean skip rather than logged as an error every single run.
      if (err && err.code === '23503') {
        results.keptReferenced += 1;
        continue;
      }
      console.error(`unverifiedAccounts.service: sweep skipped user ${candidate.id}:`, err);
      results.failed += 1;
    }
  }

  return results;
}
