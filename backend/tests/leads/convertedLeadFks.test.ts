/**
 * Deleting a matter or client that a lead was converted into.
 *
 * `leads.converted_matter_id` and `leads.converted_client_id` are the trail
 * back from a won lead to what it became. They are declared ON DELETE SET NULL,
 * which reads as "the lead survives, it just stops pointing at a record that no
 * longer exists". That is the right intent.
 *
 * It did not work, because both keys were COMPOSITE and carried the tenant
 * column:
 *
 *     foreign key (law_firm_id, converted_matter_id)
 *       references matters (law_firm_id, id) on delete set null
 *
 * ON DELETE SET NULL nulls EVERY column of the key, so Postgres emitted
 *
 *     UPDATE ONLY leads SET law_firm_id = NULL, converted_matter_id = NULL ...
 *
 * against a `law_firm_id` that is NOT NULL. The delete died on 23502 and the
 * route answered 500. A firm could not delete a matter it had won, and the
 * error named a column the caller never mentioned.
 *
 * `leads_stage_fk` had the identical defect and was worked around in
 * `leadStages.repository.deleteWithReparent`, which clears `leads.stage_id`
 * inside its own transaction. These two had no such workaround.
 *
 * The fix is the schema one rather than another workaround: a single-column FK,
 * matching `matters.practice_area_id` and `contacts.court_id`, which are single
 * column for exactly this reason. Tenant scoping is the application's job here
 * and is unaffected; every query that reads these columns already carries
 * `law_firm_id` of its own.
 *
 * `converted_client_id` is DIFFERENT and gets no foreign key at all. The
 * SOFT-REFERENCE users & clients sweep at the foot of schema.sql drops every FK
 * pointing at `clients`, deliberately, so an orphaned reference survives as a
 * plain id rather than being rejected. The cases below therefore assert that
 * deleting a client LEAVES the pointer in place. That is the designed
 * behaviour, not an oversight, and asserting the opposite would have re-added
 * the very constraint that sweep exists to remove.
 *
 * Each case below drives the REAL delete route, because the 500 was only ever
 * visible from there.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

/** A matter with the owner on it, so the delete route's membership gate passes. */
async function seedMatter(name = 'Won matter'): Promise<string> {
  const id = randomUUID();
  const m = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1, $2, $3, $4, 'active') returning id`,
    [id, firm.id, name, `REF-${id.slice(0, 8)}`],
  );
  expect(m.rowCount).toBe(1);
  const mm = await testPool.query(
    `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at)
     values ($1, $2, $3, 'lead', now())`,
    [firm.id, id, owner.uid],
  );
  expect(mm.rowCount).toBe(1);
  return id;
}

/** A lead marked as converted into the given matter and/or client. */
async function seedConvertedLead(
  { matterId = null, clientId = null }: { matterId?: string | null; clientId?: string | null },
): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into leads (id, law_firm_id, name, converted_matter_id, converted_client_id, converted_at)
     values ($1, $2, 'Won lead', $3, $4, now()) returning id`,
    [id, firm.id, matterId, clientId],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

const leadRow = async (id: string) => {
  const { rows } = await testPool.query(
    `select law_firm_id, name, converted_matter_id, converted_client_id, converted_at
       from leads where id = $1`,
    [id],
  );
  return rows[0];
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

describe('deleting a matter a lead was converted into', () => {
  it('succeeds, rather than failing on the tenant column', async () => {
    const matterId = await seedMatter();
    await seedConvertedLead({ matterId });

    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/matters/${matterId}`);

    // Before the fix this was a 500 carrying SQLSTATE 23502 about
    // leads.law_firm_id, a column the caller never named.
    expect(res.status).toBe(200);
    const { rows } = await testPool.query(
      'select count(*)::int as n from matters where id = $1', [matterId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('clears the pointer and leaves the lead otherwise intact', async () => {
    const matterId = await seedMatter();
    const leadId = await seedConvertedLead({ matterId });

    await owner.api.delete(`/api/lawfirms/${firm.id}/matters/${matterId}`);

    const lead = await leadRow(leadId);
    // The whole point of ON DELETE SET NULL: the lead is a record of work won
    // and outlives the matter. Only the dangling pointer goes.
    expect(lead.converted_matter_id).toBeNull();
    expect(lead.law_firm_id).toBe(firm.id);
    expect(lead.name).toBe('Won lead');
    expect(lead.converted_at).not.toBeNull();
  });

  it('leaves a lead converted into a DIFFERENT matter alone', async () => {
    const doomed = await seedMatter('Doomed matter');
    const survivor = await seedMatter('Surviving matter');
    const doomedLead = await seedConvertedLead({ matterId: doomed });
    const otherLead = await seedConvertedLead({ matterId: survivor });

    await owner.api.delete(`/api/lawfirms/${firm.id}/matters/${doomed}`);

    // Both halves. Asserting only that the doomed pointer cleared would pass
    // against a cascade that nulled every lead in the firm.
    expect((await leadRow(doomedLead)).converted_matter_id).toBeNull();
    expect((await leadRow(otherLead)).converted_matter_id).toBe(survivor);
  });
});

describe('deleting a client a lead was converted into (a SOFT reference)', () => {
  let client: ClientRecord;

  beforeEach(async () => {
    client = await createPersonClient(firm.id, { name: 'Won client' });
  });

  it('succeeds, rather than failing on the tenant column', async () => {
    await seedConvertedLead({ clientId: client.id });

    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/clients/${client.id}`);

    expect(res.status).toBe(200);
    const { rows } = await testPool.query(
      'select count(*)::int as n from clients where id = $1', [client.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('KEEPS the pointer, because there is no foreign key to null it', async () => {
    const leadId = await seedConvertedLead({ clientId: client.id });

    await owner.api.delete(`/api/lawfirms/${firm.id}/clients/${client.id}`);

    const lead = await leadRow(leadId);
    // Deliberate. The soft-reference sweep drops every FK pointing at `clients`,
    // so nothing nulls this and the lead keeps the id of the client it became.
    // Red if someone adds a hard FK here: the sweep would remove it on the next
    // schema apply, so a database with one disagrees with a freshly built one.
    expect(lead.converted_client_id).toBe(client.id);
    expect(lead.law_firm_id).toBe(firm.id);
    expect(lead.name).toBe('Won lead');
  });

  it('leaves a lead converted into a DIFFERENT client alone', async () => {
    const survivor = await createPersonClient(firm.id, { name: 'Surviving client' });
    const otherLead = await seedConvertedLead({ clientId: survivor.id });

    await owner.api.delete(`/api/lawfirms/${firm.id}/clients/${client.id}`);

    // The surviving client is untouched and still resolves, so the case above
    // is about the deleted one specifically and not about leads in general.
    expect((await leadRow(otherLead)).converted_client_id).toBe(survivor.id);
    const { rows } = await testPool.query(
      'select count(*)::int as n from clients where id = $1', [survivor.id],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('a lead converted into BOTH, when only one end is deleted', () => {
  it('clears the matter pointer and leaves the client one, which has no FK', async () => {
    const client = await createPersonClient(firm.id, { name: 'Kept client' });
    const matterId = await seedMatter();
    const leadId = await seedConvertedLead({ matterId, clientId: client.id });

    await owner.api.delete(`/api/lawfirms/${firm.id}/matters/${matterId}`);

    const lead = await leadRow(leadId);
    // The two pointers are independent, and only one of them is a real FK.
    expect(lead.converted_matter_id).toBeNull();
    expect(lead.converted_client_id).toBe(client.id);
  });
});

describe('the constraint still refers to something', () => {
  it('refuses a lead pointing at a matter that does not exist', async () => {
    // The foreign keys are narrowed from composite to single column, not
    // dropped. Without this case, deleting them outright would satisfy every
    // test above while leaving the column free to hold any uuid at all.
    await expect(seedConvertedLead({ matterId: randomUUID() })).rejects.toThrow();
  });

  it('ACCEPTS a lead pointing at a client that does not exist', async () => {
    // The other half of the soft reference. `clients` carries no FK from here,
    // so an id that resolves to nothing is storable on purpose: that is how a
    // reference to a since-deleted client survives. Red if a hard FK is added.
    await expect(seedConvertedLead({ clientId: randomUUID() })).resolves.toEqual(
      expect.any(String),
    );
  });
});
