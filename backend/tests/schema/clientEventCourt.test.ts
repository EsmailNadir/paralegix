/**
 * `events.court_id` is a uuid with a foreign key to `courts`.
 *
 * It was `text` with no key, alone among the three court references in the
 * schema: `matters.court_id` and `contacts.court_id` are both
 * `uuid references courts(id) on delete set null`. Nothing enforced that a
 * client event's court was a court, or that it belonged to the same firm, or
 * that it existed at all. The service validated it on the way in
 * (`resolveCourt` -> `mattersRepo.validateCourt`), so the values were real; the
 * column simply did not say so, and any writer that skipped the service could
 * put an arbitrary string there.
 *
 * The foreign key is SINGLE-COLUMN, not `(law_firm_id, court_id)`, matching
 * `matters.court_id` and `contacts.court_id` and for the same reason: an
 * `ON DELETE SET NULL` on a composite key nulls EVERY column of the key,
 * including the NOT NULL tenant column, and deleting a court would fail with
 * 23502. Tenant agreement stays the service's job, as it is for matters. See
 * migrations 0184, 0186 and 0187 for the three times that hazard was paid for.
 *
 * WHAT MAKES THESE GO RED: reverting the column to text, dropping the key, or
 * making the key composite (the delete case below is what would catch that
 * last one, since a composite key raises 23502 instead of nulling).
 *
 * `court_name` beside it is GONE (migration 0205, with the events merge that
 * reshaped these reads anyway). It was a denormalized copy the service rewrote
 * on every save, and it went stale whenever a court was renamed afterwards. All
 * four read paths in `clientEvents.repository.ts` now LEFT JOIN `courts` for the
 * name, which is how `matters.repository`, `tasks.repository` and
 * `contacts.repository` have always read it.
 */
import { randomUUID } from 'crypto';

import { testPool, createFirm, type Firm } from '../support/setupInProcess';

let firm: Firm;

beforeEach(async () => {
  firm = await createFirm();
});

async function createCourt(lawFirmId: string, name = 'Superior Court'): Promise<string> {
  const { rows } = await testPool.query(
    `insert into courts (law_firm_id, name) values ($1, $2) returning id`,
    [lawFirmId, name],
  );
  return rows[0].id;
}

async function createClientEvent(lawFirmId: string, courtId: string | null): Promise<string> {
  const { rows } = await testPool.query(
    `insert into clients (law_firm_id, name) values ($1, 'Court Client') returning id`,
    [lawFirmId],
  );
  const { rows: ev } = await testPool.query(
    `insert into events (law_firm_id, client_id, title, court_id)
     values ($1, $2, 'Hearing', $3) returning id`,
    [lawFirmId, rows[0].id, courtId],
  );
  return ev[0].id;
}

describe('events.court_id', () => {
  it('is a uuid column', async () => {
    const { rows } = await testPool.query(
      `select data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'events'
          and column_name = 'court_id'`,
    );
    expect(rows[0]?.data_type).toBe('uuid');
  });

  it('rejects a court id that names no court', async () => {
    // The whole point of the key. As text this insert succeeded and the event
    // pointed at nothing, which only showed up as a blank court in the UI.
    await expect(
      createClientEvent(firm.id, randomUUID()),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('accepts a real court', async () => {
    const courtId = await createCourt(firm.id);
    const eventId = await createClientEvent(firm.id, courtId);
    const { rows } = await testPool.query(
      `select court_id from events where id = $1`, [eventId],
    );
    expect(rows[0].court_id).toBe(courtId);
  });

  it('nulls the reference when the court is deleted, rather than failing', async () => {
    // This is the case that catches a COMPOSITE key being used here by mistake.
    // `on delete set null` on `(law_firm_id, court_id)` would try to null the
    // NOT NULL tenant column too and raise 23502, so a court could not be
    // deleted at all once any client event referenced it.
    const courtId = await createCourt(firm.id);
    const eventId = await createClientEvent(firm.id, courtId);

    await testPool.query(`delete from courts where id = $1`, [courtId]);

    const { rows } = await testPool.query(
      `select court_id from events where id = $1`, [eventId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].court_id).toBeNull();
  });
});
