/**
 * RLS policy tests for the notifications table.
 *
 * The policy is straightforward: (auth.jwt() ->> 'sub') = user_id.
 * Each user sees only their own notifications, regardless of firm.
 */
import { createFirm, testPool } from '../support/setupInProcess';
import { ensureUser } from '../support/factories';
import { attemptUnderRls, withRlsIdentity } from '../support/rlsSession';

describe('RLS: notifications', () => {
  it('R01: user sees only their own notifications across firms', async () => {
    const firmX = await createFirm();
    const firmY = await createFirm();
    const userA = 'notif-user-a';
    const userB = 'notif-user-b';
    const userC = 'notif-user-c';
    // notifications.user_id is a real key to users since migration 0224, so the
    // three actors this spec names have to be accounts before they can be
    // notified.
    for (const uid of [userA, userB, userC]) await ensureUser(uid);

    // Seed notifications for three users across two firms
    await testPool.query(`
      INSERT INTO notifications (id, law_firm_id, user_id, type, title, body, created_at)
      VALUES
        (gen_random_uuid(), $1, $2, 'sys', 'A note in X', 'body-a', now()),
        (gen_random_uuid(), $1, $3, 'sys', 'B note in X', 'body-b', now()),
        (gen_random_uuid(), $4, $5, 'sys', 'C note in Y', 'body-c', now())
    `, [firmX.id, userA, userB, firmY.id, userC]);

    // User A sees only their notification
    await withRlsIdentity(userA, async (client) => {
      const { rows } = await client.query('SELECT title FROM notifications ORDER BY title');
      expect(rows).toEqual([{ title: 'A note in X' }]);
    });

    // User B sees only their notification
    await withRlsIdentity(userB, async (client) => {
      const { rows } = await client.query('SELECT title FROM notifications ORDER BY title');
      expect(rows).toEqual([{ title: 'B note in X' }]);
    });

    // User C sees only their notification (different firm)
    await withRlsIdentity(userC, async (client) => {
      const { rows } = await client.query('SELECT title FROM notifications ORDER BY title');
      expect(rows).toEqual([{ title: 'C note in Y' }]);
    });

    // A stranger sees nothing
    await withRlsIdentity('stranger-uid', async (client) => {
      const { rows } = await client.query('SELECT title FROM notifications');
      expect(rows).toEqual([]);
    });
  });

  it('R08: INSERT/UPDATE/DELETE on notifications is denied', async () => {
    const firm = await createFirm();
    const uid = 'notif-write-test';
    await ensureUser(uid);

    await testPool.query(`
      INSERT INTO notifications (id, law_firm_id, user_id, type, title, body, created_at)
      VALUES (gen_random_uuid(), $1, $2, 'sys', 'Existing', 'body', now())
    `, [firm.id, uid]);

    // Each attempt runs in its own savepoint. Without that the first refusal
    // aborts the transaction and the other two report "current transaction is
    // aborted" instead of their own reason, so the test would only ever prove
    // that INSERT is refused.
    await withRlsIdentity(uid, async (client) => {
      const inserted = await attemptUnderRls(client, `
        INSERT INTO notifications (id, law_firm_id, user_id, type, title, body, created_at)
        VALUES (gen_random_uuid(), $1, $2, 'sys', 'Hacked', 'body', now())
      `, [firm.id, uid]);
      expect(inserted.ok).toBe(false);
      expect(inserted.message).toMatch(/permission denied/);

      const updated = await attemptUnderRls(client, `
        UPDATE notifications SET title = 'Modified' WHERE user_id = $1
      `, [uid]);
      expect(updated.ok).toBe(false);
      expect(updated.message).toMatch(/permission denied/);

      const deleted = await attemptUnderRls(client, `
        DELETE FROM notifications WHERE user_id = $1
      `, [uid]);
      expect(deleted.ok).toBe(false);
      expect(deleted.message).toMatch(/permission denied/);
    });

    // The row the refused statements targeted is still there and unchanged.
    const { rows } = await testPool.query(
      'SELECT title FROM notifications WHERE user_id = $1', [uid],
    );
    expect(rows).toEqual([{ title: 'Existing' }]);
  });
});
