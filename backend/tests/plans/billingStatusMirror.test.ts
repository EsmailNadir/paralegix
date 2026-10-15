/**
 * `law_firms.billing_status` is the AUTHORITATIVE store for a firm's billing
 * state, and `lawfirms.repository.normalizeBillingStatusColumn` is the single
 * place a caller's spelling is translated into the column's vocabulary.
 *
 * It was not always single. Until migration 0200 the canonical value lived in
 * the `plan` jsonb and a `law_firms_sync_plan_columns` trigger mirrored it onto
 * the column, so the same normalization existed twice -- once in the trigger's
 * `case`, once in the repository. Migration 0055's header said outright that the
 * two MUST match, and they did not: the trigger's fallback for an unrecognised
 * status was `else 'active'` while the app's was `'incomplete'`, and because the
 * trigger ran AFTER the app's SET list it was the trigger's value that landed. A
 * status neither side recognised therefore stored as the most PERMISSIVE value
 * in the CHECK set. 0185 patched the fallback; 0200 deleted the second copy.
 *
 * What this file pins now is the one translation that remains, on the input that
 * actually produces it. The platform-admin console's `updatePlanSchema` accepts
 * `billingStatus: 'suspended'`, which is not a column value -- it is the
 * console's own spelling for a cancelled firm, and the frontend labels it
 * "Canceled" (frontend/src/constants/statusMeta.ts). It must therefore store as
 * `canceled`. Mapping it to `incomplete` instead, as the old fail-closed default
 * did, loses the distinction between a firm an admin cancelled and one that
 * never finished checkout, in the two places the column is read.
 *
 * What has to break for this to go red: drop the `suspended` case so it falls
 * through to the `incomplete` default again, or fold it into an access-granting
 * value. The firm's actual access is asserted first so a green run cannot mean
 * "nothing happened": the console refuses inert PATCHes with a 400, and an
 * aggregate assertion alone would pass against a firm whose plan was never
 * written at all.
 *
 * Access itself does not depend on WHICH of the two the status maps to --
 * `canceled` and `incomplete` are both locked -- so the 402 below is evidence
 * the write took effect, not the behaviour under test. What the mapping decides
 * is whether the console's directory filter and stat cards can tell the two
 * kinds of dead firm apart.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  resetCaches,
  createFirm,
  ownerOf,
  as,
  tokenFor,
  type CallerAgent,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let admin: CallerAgent;

/**
 * A platform admin belonging to no firm, seeded with SQL rather than through the
 * console's own account route so the fixture does not depend on the code under
 * test. `is_admin` is a column on the user row, not a firm permission.
 */
async function platformAdmin(): Promise<CallerAgent> {
  const uid = `admin-${randomUUID().slice(0, 8)}`;
  await testPool.query(
    `insert into users (id, email, name, user_type, is_admin)
     values ($1, $2, 'Platform Admin', 'firm_member', true)`,
    [uid, `${uid}@example.test`],
  );
  return as(tokenFor({ uid }));
}

const readStatusColumn = async (lawFirmId: string) => {
  const { rows } = await testPool.query(
    `select billing_status from law_firms where id = $1`, [lawFirmId],
  );
  return rows[0].billing_status;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  admin = await platformAdmin();
  await drainEvents();
});

describe('the console spelling suspended stores as canceled, not incomplete', () => {
  it('locks the firm out and stops the platform stats counting it as active', async () => {
    const patch = await admin.patch(`/api/admin/lawfirms/${firm.id}/plan`)
      .send({ billingStatus: 'suspended' });
    expect(patch.status).toBe(200);

    // The plan cache is keyed per firm and outlives the write within a request
    // cycle; the console and the workspace gate are separate requests in
    // production, so clearing it here reproduces that, not a bug being hidden.
    resetCaches();

    // HALF ONE: the write really landed. An ordinary workspace route now refuses
    // the firm's own OWNER, and names the status it stored. Without this the
    // aggregate assertion below would pass just as happily against a PATCH that
    // was rejected and wrote nothing at all.
    const gated = await owner.api.get(`/api/lawfirms/${firm.id}/matters`);
    expect(gated.status).toBe(402);
    expect(gated.body.code).toBe('BILLING_INACTIVE');
    // The gate reports the STORED status, which is the translated one: nothing
    // carries the console's spelling past the repository any more.
    expect(gated.body.details).toEqual({ billingStatus: 'canceled' });

    // HALF TWO: the console agrees. `stats` is the platform-wide aggregate over
    // the billing_status COLUMN, and the harness truncates between tests, so
    // this firm is the only row it can be counting.
    const listed = await admin.get('/api/admin/lawfirms?limit=50');
    expect(listed.status).toBe(200);
    expect(listed.body.stats.total).toBe(1);
    expect(listed.body.stats.byBillingStatus).toEqual({ canceled: 1 });
  });

  it('keeps the firm out of the directory filtered to active', async () => {
    const patch = await admin.patch(`/api/admin/lawfirms/${firm.id}/plan`)
      .send({ billingStatus: 'suspended' });
    expect(patch.status).toBe(200);
    // The column, read directly: the other reader of it is the filter below,
    // and both must see the same value.
    expect(await readStatusColumn(firm.id)).toBe('canceled');

    const asActive = await admin.get('/api/admin/lawfirms?limit=50&billingStatus=active');
    expect(asActive.status).toBe(200);
    expect(asActive.body.totalItems).toBe(0);
    expect(asActive.body.lawFirms).toEqual([]);

    // The positive half: it is not merely missing from every bucket, it is in
    // the CANCELED one. Asserting the absence alone would pass just as happily
    // if the PATCH had written nothing.
    const asCanceled = await admin.get('/api/admin/lawfirms?limit=50&billingStatus=canceled');
    expect(asCanceled.status).toBe(200);
    expect(asCanceled.body.totalItems).toBe(1);
    expect(asCanceled.body.lawFirms.map((f: any) => f.id)).toEqual([firm.id]);

    // And NOT in the bucket the old fail-closed default would have put it in.
    const asIncomplete = await admin.get('/api/admin/lawfirms?limit=50&billingStatus=incomplete');
    expect(asIncomplete.body.totalItems).toBe(0);
  });
});
