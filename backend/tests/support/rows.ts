/**
 * Row readers, and the callers and fixtures that are too small for
 * `factories.ts` or `actors.ts` but were being redefined spec by spec.
 *
 * Plain SQL through the test pool, for the reason `factories.ts` gives: a
 * fixture or a read-back built from the code under test cannot fail when that
 * code is wrong.
 *
 * The readers select every column and answer `null` for a missing row, so a
 * spec asserts the columns it cares about with `toMatchObject` and an absent
 * row with `toBeNull()`.
 */
import { randomUUID } from 'crypto';
import { testPool } from './db';
import { tokenFor } from './firebase.mock';
import { as, type CallerAgent } from './app';

/** The one `law_firms` row, or null. */
export async function firmRow(lawFirmId: string) {
  const { rows } = await testPool.query('select * from law_firms where id = $1', [lawFirmId]);
  return rows[0] ?? null;
}

/** The one `users` row, or null. `email` is citext, so it reads back as the stored text. */
export async function userRow(uid: string) {
  const { rows } = await testPool.query('select * from users where id = $1', [uid]);
  return rows[0] ?? null;
}

/** The one `clients` row, or null. */
export async function clientRow(clientId: string) {
  const { rows } = await testPool.query('select * from clients where id = $1', [clientId]);
  return rows[0] ?? null;
}

/**
 * A caller with no credential: `as('')` sends an empty bearer, which
 * `verifyToken` answers exactly as it answers a missing header. Registration
 * and the public invite and share routes arrive this way.
 */
export const anonymous = (): CallerAgent => as('');

/**
 * A platform admin: a `users` row carrying `is_admin`, with no membership in
 * any firm, so nothing a spec proves with it can pass by membership. Seeded by
 * SQL rather than through the console's own account route, which would make the
 * fixture depend on the code under test.
 */
export async function platformAdmin(
  name = 'Platform Admin',
): Promise<{ uid: string; api: CallerAgent }> {
  const uid = `admin-${randomUUID().slice(0, 8)}`;
  await testPool.query(
    `insert into users (id, email, name, user_type, is_admin)
     values ($1, $2, $3, 'firm_member', true)`,
    [uid, `${uid}@example.test`, name],
  );
  return { uid, api: as(tokenFor({ uid })) };
}

export interface SeedInviteOptions {
  lawFirmId: string;
  inviteType: 'member' | 'client';
  /** Defaults to an address unique to this invitation. */
  email?: string;
  roleId?: string | null;
  invitedBy?: string | null;
  status?: 'pending' | 'accepted' | 'revoked' | 'expired';
  /** An interval from now, e.g. `'-1 hour'` for an invitation already past its expiry. */
  expiresIn?: string;
  /** Stamps `invited_at`, which the admin console lists by. Left null otherwise. */
  invitedNow?: boolean;
  resendCount?: number;
  /**
   * `invitation_sent_at`. Null reads as never sent, which the resend cooldown
   * treats as claimable; `'now'` is inside the cooldown and `'long ago'` is past it.
   */
  sentAt?: 'now' | 'long ago' | null;
}

/**
 * One invitation row, written directly because several cases need a state the
 * send path will not produce: already expired, already revoked, or addressed to
 * a user who exists. The token is `invite-token-<id>`. The insert's row count is
 * asserted, so an invitation that silently failed to seed cannot make a later
 * "was it claimed" assertion pass for the wrong reason.
 */
export async function seedInvite(options: SeedInviteOptions): Promise<string> {
  const id = randomUUID();
  const sentAtSql = options.sentAt === 'now'
    ? 'now()'
    : options.sentAt === 'long ago'
      ? "now() - interval '48 hours'"
      : 'null';
  const res = await testPool.query(
    `insert into invitations
       (id, law_firm_id, email, invite_type, role_id, token, status, invited_by,
        invited_at, invitation_resend_count, invitation_sent_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8,
             case when $9::boolean then now() end, $10, ${sentAtSql},
             now() + coalesce($11::interval, interval '7 days'))`,
    [
      id,
      options.lawFirmId,
      options.email ?? `invite-${id.slice(0, 8)}@example.test`,
      options.inviteType,
      options.roleId ?? null,
      `invite-token-${id}`,
      options.status ?? 'pending',
      options.invitedBy ?? null,
      options.invitedNow ?? false,
      options.resendCount ?? 0,
      options.expiresIn ?? null,
    ],
  );
  if (res.rowCount !== 1) throw new Error(`seedInvite: inserted ${res.rowCount} rows, expected 1`);
  return id;
}
