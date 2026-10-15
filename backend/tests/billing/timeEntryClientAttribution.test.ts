/**
 * Which clients a matter time entry was worked for.
 *
 * `time_entries` carried TWO columns for this: `matter_client_id` (text, one
 * client) and `matter_client_ids` (jsonb, many). The singular was the earlier
 * shape and the plural superseded it. Migration 0197 drops the singular.
 *
 * IT WAS NOT UNREAD, WHICH IS THE WHOLE POINT OF THIS FILE. An earlier draft of
 * migration 0197 dropped the column on the strength of "the API round-trips it
 * and nothing consumes it". That was true of `timeEntries.repository.toEntity`
 * and of the frontend, and false where it mattered: the by-client billing report
 * read the singular in three places as a FALLBACK for an empty array, so
 * dropping it bare would have silently removed those entries' hours from every
 * by-client figure. `billingReports.test.ts` caught it.
 *
 * So 0197 backfills the array from the singular first, which makes the fallback
 * unreachable, and only then drops the column.
 *
 * WHAT MAKES THESE GO RED: re-adding the singular column, or the plural losing
 * its round-trip. The second matters more now: the array is the ONLY record of
 * who a matter entry was worked for, so a change that drops it drops the fact.
 *
 * The singular was also the UNVALIDATED half of the pair. `matterClientIds` is
 * checked against `matter_clients` on write; the singular was not. That is
 * asserted below, because it is the reason the surviving column is the better
 * one to have kept.
 */
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: { uid: string; api: any };

/** A matter the caller is a member of, which time-entry creation requires. */
async function createMatter(lawFirmId: string, userId: string): Promise<string> {
  const { rows } = await testPool.query(
    `insert into matters (law_firm_id, name, matter_reference_id)
     values ($1, 'Attribution Matter', 'REF-ATTR-1') returning id`,
    [lawFirmId],
  );
  const matterId = rows[0].id;
  await testPool.query(
    `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
     values ($1, $2, $3, 'lead', now())`,
    [matterId, userId, lawFirmId],
  );
  return matterId;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

describe('matter time-entry client attribution', () => {
  it('round-trips the client set through create and read', async () => {
    const matterId = await createMatter(firm.id, owner.uid);
    const clientA = await createPersonClient(firm.id, { name: 'Client A' });
    const clientB = await createPersonClient(firm.id, { name: 'Client B' });
    // The service validates matterClientIds against `matter_clients`, so both
    // have to actually be on the matter. That check is the reason this column
    // is worth keeping: it is enforced, not just stored.
    await testPool.query(
      `insert into matter_clients (matter_id, client_id, law_firm_id)
       values ($1, $2, $4), ($1, $3, $4)`,
      [matterId, clientA.id, clientB.id, firm.id],
    );

    const created = await owner.api
      .post(`/api/lawfirms/${firm.id}/billing/time-entries`)
      .send({
        matterId,
        matterClientIds: [clientA.id, clientB.id],
        userId: owner.uid,
        hours: 1.5,
        date: '2026-03-15',
        description: 'Attributed work',
      });

    expect(created.status).toBe(201);
    const entryId = created.body.timeEntry.id as string;
    expect(entryId).toMatch(/^[0-9a-f-]{36}$/);

    // Asserting through the stored row as well as the response: a response that
    // merely echoes the request back would pass on a write that never landed.
    const { rows } = await testPool.query(
      `select matter_client_ids from activities where kind = 'time' and id = $1`, [entryId],
    );
    expect(rows[0].matter_client_ids).toEqual([clientA.id, clientB.id]);
  });

  it('rejects a client set on a client-level entry, which has no matter to attribute against', async () => {
    const client = await createPersonClient(firm.id, { name: 'Direct Client' });

    const res = await owner.api
      .post(`/api/lawfirms/${firm.id}/billing/time-entries`)
      .send({
        clientId: client.id,
        matterClientIds: [client.id],
        userId: owner.uid,
        hours: 1,
        date: '2026-03-15',
      });

    expect(res.status).toBe(400);
  });
});
