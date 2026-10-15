/**
 * Matters, the entity everything else in the product hangs off.
 *
 * Twenty-nine routes, and not one test before this file. A matter carries the
 * work, the money, the documents and the client relationships, so a mistake here
 * does not stay local: it reaches billing, the client portal and the calendar.
 *
 * Three groups of rules get the most attention, because each has a consequence
 * that no screen shows:
 *
 *   LEGAL HOLD blocks deletion. A matter under hold is one a court or an
 *   insurer has told the firm to preserve. Deleting it is a spoliation problem,
 *   not a product one.
 *
 *   CONFLICT CHECKING is how a firm avoids acting against an existing client.
 *   A missed conflict is a disqualification and a malpractice exposure.
 *
 *   BULK OPERATIONS touch many matters at once, so a partial failure that
 *   reports success leaves a firm believing work happened that did not.
 */
import { installInMemoryBucket } from '../support/inMemoryBucket';
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createPersonClient,
  createOrgClient,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;
let client: ClientRecord;

const M = () => `/api/lawfirms/${firm.id}/matters`;

async function createMatter(name: string, extra: Record<string, unknown> = {}) {
  return owner.api.post(M()).send({
    name,
    clients: [{ clientId: client.id, name: 'Pat Person' }],
    ...extra,
  });
}

const idOf = (res: any) => res.body.matterId as string;

const matterRow = async (id: string) => {
  const { rows } = await testPool.query(
    `select m.name, m.status, m.matter_reference_id, m.law_firm_id,
            exists (select 1 from legal_holds h
                     where h.matter_id = m.id and h.released_at is null) as legal_hold
       from matters m where m.id = $1`,
    [id],
  );
  return rows[0];
};

const matterCount = async () => {
  const { rows } = await testPool.query(
    'select count(*)::int n from matters where law_firm_id = $1', [firm.id],
  );
  return rows[0].n;
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Pat Person' });
  await drainEvents();
});

describe('creating a matter', () => {
  it('starts it active', async () => {
    const res = await createMatter('Matter One');

    // A matter that arrived closed would be invisible on every default list the
    // moment it was opened.
    expect((await matterRow(idOf(res))).status).toBe('active');
  });

  it('assigns a reference id', async () => {
    const res = await createMatter('Matter One');

    // The human-facing handle a firm quotes on correspondence. Generated on
    // create, so it exists before anyone needs to cite it.
    expect((await matterRow(idOf(res))).matter_reference_id).toMatch(/^CP-/);
  });

  it('gives two matters DIFFERENT reference ids', async () => {
    const first = await createMatter('First');
    const second = await createMatter('Second');

    // Two matters sharing a reference is worse than none having one: every
    // document filed under it becomes ambiguous.
    expect((await matterRow(idOf(first))).matter_reference_id)
      .not.toBe((await matterRow(idOf(second))).matter_reference_id);
  });

  it('attaches the client it was given', async () => {
    const res = await createMatter('Matter One');

    const { rows } = await testPool.query(
      'select client_id from matter_clients where matter_id = $1', [idOf(res)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].client_id).toBe(client.id);
  });

  it('accepts an ORGANIZATION as the client', async () => {
    const org = await createOrgClient(firm.id, { name: 'Acme Corporation' });
    await drainEvents();

    const res = await owner.api.post(M()).send({
      name: 'Corporate Matter',
      clients: [{ clientId: org.id, name: 'Acme Corporation' }],
    });

    // An organization is a client like any other. A create path resolving
    // clients through `clients.user_id`, which an organization can never carry,
    // refuses here and a firm cannot open a matter for a company at all.
    expect(res.status).toBe(201);
    const { rows } = await testPool.query(
      'select client_id from matter_clients where matter_id = $1', [idOf(res)],
    );
    expect(rows[0].client_id).toBe(org.id);
  });

  it('accepts SEVERAL clients on one matter', async () => {
    const second = await createPersonClient(firm.id, { name: 'Second Client' });
    await drainEvents();

    const res = await owner.api.post(M()).send({
      name: 'Joint Matter',
      clients: [
        { clientId: client.id, name: 'Pat Person' },
        { clientId: second.id, name: 'Second Client' },
      ],
    });

    // Co-clients are ordinary, and the split-invoice feature depends on this
    // shape existing.
    expect(res.status).toBe(201);
    const { rows } = await testPool.query(
      'select client_id from matter_clients where matter_id = $1', [idOf(res)],
    );
    expect(rows).toHaveLength(2);
  });

  it('refuses a matter with no name', async () => {
    const res = await owner.api.post(M()).send({ clients: [] });

    expect(res.status).toBe(400);
  });

  it('refuses a member without the create permission', async () => {
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi.post(M()).send({ name: 'Sneaky Matter', clients: [] });

    expect(res.status).toBe(403);
  });

});

describe('reading matters', () => {
  it('answers not-found for an id that does not exist', async () => {
    const res = await owner.api.get(`${M()}/00000000-0000-0000-0000-000000000000`);

    expect(res.status).toBe(404);
  });

  it('does NOT list another firm matters', async () => {
    await createMatter('Confidential Matter');
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api.get(`/api/lawfirms/${otherFirm.id}/matters`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('Confidential Matter');
  });

  it('does NOT serve another firm matter by id', async () => {
    const created = await createMatter('Confidential Matter');
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .get(`/api/lawfirms/${otherFirm.id}/matters/${idOf(created)}`);

    // Knowing the id must not be enough. Ids appear in urls and get pasted
    // around.
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Confidential Matter');
  });

  it('does not look up across firms', async () => {
    await createMatter('Distinctive Lookup Name');
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .get(`/api/lawfirms/${otherFirm.id}/matters/lookup?q=Distinctive`);

    expect(JSON.stringify(res.body)).not.toContain('Distinctive Lookup Name');
  });
});

describe('updating a matter', () => {
  it('renames it', async () => {
    const created = await createMatter('Original Name');

    const res = await owner.api.put(`${M()}/${idOf(created)}`).send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect((await matterRow(idOf(created))).name).toBe('New Name');
  });

  it('closes it', async () => {
    const created = await createMatter('Closable');

    await owner.api.put(`${M()}/${idOf(created)}`).send({ status: 'closed' });

    expect((await matterRow(idOf(created))).status).toBe('closed');
  });

  it('refuses renaming it to an EMPTY string', async () => {
    const created = await createMatter('Original Name');

    const res = await owner.api.put(`${M()}/${idOf(created)}`).send({ name: '' });

    // Worse than the create case. An optional field with a max but no min lets
    // an update blank an existing matter's name outright, and a nameless matter
    // is unfindable in every list and search the firm has.
    expect(res.status).toBe(400);
  });

  it('does not let one firm rename another firm matter', async () => {
    const created = await createMatter('Original Name');
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .put(`/api/lawfirms/${otherFirm.id}/matters/${idOf(created)}`)
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect((await matterRow(idOf(created))).name).toBe('Original Name');
  });

  it('refuses a member without the edit permission', async () => {
    const created = await createMatter('Original Name');
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi.put(`${M()}/${idOf(created)}`).send({ name: 'Changed' });

    expect(res.status).toBe(403);
    expect((await matterRow(idOf(created))).name).toBe('Original Name');
  });

  it('refuses an impossible calendar date on update too', async () => {
    const created = await createMatter('Dated Matter');

    const res = await owner.api.put(`${M()}/${idOf(created)}`)
      .send({ statuteOfLimitationsDate: '2026-13-01' });

    // Month 13 fails the same way an out-of-range day does: the regex-only
    // check lets it through and Postgres is the one that actually refuses it.
    expect(res.status).toBe(400);
  });
});

describe('changing the practice area through the edit route', () => {
  // The practice-area routes copy the new area onto every task of the matter;
  // the general edit route wrote the matter row only, so the same change made
  // through Edit Matter left the tasks on the old area. Red if the single edit
  // stops propagating to the matter's tasks.
  it('moves the matter tasks to the new practice area and leaves other matters tasks alone', async () => {
    const area = async (name: string) => (await testPool.query(
      `insert into practice_areas (law_firm_id, name) values ($1, $2) returning id`, [firm.id, name],
    )).rows[0].id as string;
    const oldArea = await area('Old Area');
    const newArea = await area('New Area');
    const matterId = idOf(await createMatter('Moving', { practiceAreaId: oldArea }));
    const otherId = idOf(await createMatter('Staying', { practiceAreaId: oldArea }));
    const seedTask = async (matter: string, title: string) => (await testPool.query(
      `insert into tasks (law_firm_id, matter_id, title, practice_area_id) values ($1, $2, $3, $4) returning id`,
      [firm.id, matter, title, oldArea],
    )).rows[0].id as string;
    const mine = await seedTask(matterId, 'Mine');
    const theirs = await seedTask(otherId, 'Theirs');
    const areaOf = async (id: string) => (await testPool.query(
      'select practice_area_id from tasks where id = $1', [id])).rows[0].practice_area_id;

    const res = await owner.api.put(`${M()}/${matterId}`).send({ practiceAreaId: newArea });

    expect(res.status).toBe(200);
    expect(await areaOf(mine)).toBe(newArea);
    expect(await areaOf(theirs)).toBe(oldArea);
    const matter = await testPool.query('select practice_area_id from matters where id = $1', [matterId]);
    expect(matter.rows[0].practice_area_id).toBe(newArea);
  });
});

describe('legal hold', () => {
  it('records the hold', async () => {
    const created = await createMatter('Held Matter');

    const res = await owner.api
      .patch(`${M()}/${idOf(created)}/legal-hold`)
      .send({ legalHold: true });

    expect(res.status).toBe(200);
    expect((await matterRow(idOf(created))).legal_hold).toBe(true);
  });

  it('BLOCKS deletion while the hold is on', async () => {
    const created = await createMatter('Held Matter');
    await owner.api.patch(`${M()}/${idOf(created)}/legal-hold`).send({ legalHold: true });

    const res = await owner.api.delete(`${M()}/${idOf(created)}`);

    // The whole point of a hold. A matter under one is evidence a court or an
    // insurer has told the firm to preserve, and deleting it is spoliation.
    expect(res.status).toBe(403);
    // Asserting the ROW too. A route that refused after already deleting would
    // satisfy the status check and destroy the evidence anyway.
    expect(await matterRow(idOf(created))).toBeDefined();
  });

  it('allows deletion once the hold is lifted', async () => {
    const created = await createMatter('Held Matter');
    await owner.api.patch(`${M()}/${idOf(created)}/legal-hold`).send({ legalHold: true });
    await owner.api.patch(`${M()}/${idOf(created)}/legal-hold`).send({ legalHold: false });

    const res = await owner.api.delete(`${M()}/${idOf(created)}`);

    // The positive half. A guard that never released would make every held
    // matter permanent, which is its own records-retention problem.
    expect(res.status).toBe(200);
  });

  it('records the change on the activity log', async () => {
    const created = await createMatter('Held Matter');
    await owner.api.patch(`${M()}/${idOf(created)}/legal-hold`).send({ legalHold: true });
    await drainEvents();

    const res = await owner.api.get(`${M()}/${idOf(created)}/activity`);

    // A hold is a legal instruction. Who applied it and when has to be
    // reconstructable.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('legal_hold');
  });
});

describe('deleting a matter', () => {
  it('removes it from the list', async () => {
    const created = await createMatter('Deletable');

    const res = await owner.api.delete(`${M()}/${idOf(created)}`);

    expect(res.status).toBe(200);
    expect(await matterCount()).toBe(0);
  });

  it('does not let one firm delete another firm matter', async () => {
    const created = await createMatter('Deletable');
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .delete(`/api/lawfirms/${otherFirm.id}/matters/${idOf(created)}`);

    expect(res.status).toBe(404);
    expect(await matterCount()).toBe(1);
  });

  it('refuses a member without the delete permission', async () => {
    const created = await createMatter('Deletable');
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi.delete(`${M()}/${idOf(created)}`);

    expect(res.status).toBe(403);
    expect(await matterCount()).toBe(1);
  });
});

describe('bulk operations', () => {
  it('closes several matters at once', async () => {
    const a = idOf(await createMatter('A'));
    const b = idOf(await createMatter('B'));

    const res = await owner.api.post(`${M()}/bulk-update-status`)
      .send({ matterIds: [a, b], status: 'closed' });

    expect(res.status).toBe(200);
    expect((await matterRow(a)).status).toBe('closed');
    expect((await matterRow(b)).status).toBe('closed');
    // The counts are the only feedback a firm gets on a bulk action. A response
    // that always said "requested: N, updated: N" would hide every partial
    // failure.
    expect(res.body.requested).toBe(2);
    expect(res.body.updated).toBe(2);
  });

  // Matter status and task status are different vocabularies. Bulk status used
  // to copy the matter status into every task on the matter, so closing a
  // matter with tasks hit the tasks status CHECK and failed outright, and a
  // status both vocabularies share overwrote each task's own progress. Red if
  // the bulk path writes `status` into `tasks` again.
  describe('leaves the statuses of the matter tasks alone', () => {
    const seedTask = async (matterId: string, status: string) => {
      const { rows } = await testPool.query(
        `insert into tasks (law_firm_id, matter_id, title, status)
         values ($1, $2, $3, $4) returning id`,
        [firm.id, matterId, `Task ${status}`, status],
      );
      return rows[0].id as string;
    };
    const taskStatus = async (id: string) => (await testPool.query(
      'select status from tasks where id = $1', [id],
    )).rows[0].status;

    it('closes a matter that has tasks without touching them', async () => {
      const a = idOf(await createMatter('With tasks'));
      const open = await seedTask(a, 'open');
      const done = await seedTask(a, 'completed');

      const res = await owner.api.post(`${M()}/bulk-update-status`)
        .send({ matterIds: [a], status: 'closed' });

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(1);
      expect(res.body.failed).toEqual([]);
      expect((await matterRow(a)).status).toBe('closed');
      expect(await taskStatus(open)).toBe('open');
      expect(await taskStatus(done)).toBe('completed');
    });

    it('does not overwrite task statuses with a status both vocabularies share', async () => {
      const a = idOf(await createMatter('Shared vocabulary'));
      const open = await seedTask(a, 'open');
      const inProgress = await seedTask(a, 'in_progress');

      const res = await owner.api.post(`${M()}/bulk-update-status`)
        .send({ matterIds: [a], status: 'completed' });

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(1);
      expect((await matterRow(a)).status).toBe('completed');
      expect(await taskStatus(open)).toBe('open');
      expect(await taskStatus(inProgress)).toBe('in_progress');
    });
  });

  it('deletes several at once', async () => {
    const a = idOf(await createMatter('A'));
    const b = idOf(await createMatter('B'));

    const res = await owner.api.post(`${M()}/bulk-delete`).send({ matterIds: [a, b] });

    expect(res.status).toBe(200);
    expect(await matterCount()).toBe(0);
  });

  it('leaves matters it was not asked about alone', async () => {
    const a = idOf(await createMatter('A'));
    await createMatter('Untouched');

    await owner.api.post(`${M()}/bulk-delete`).send({ matterIds: [a] });

    // A bulk operation that ignored its id list and worked on the whole firm is
    // the failure this catches, and the success message reads identically.
    expect(await matterCount()).toBe(1);
    const { rows } = await testPool.query(
      'select name from matters where law_firm_id = $1', [firm.id],
    );
    expect(rows[0].name).toBe('Untouched');
  });

  it('does NOT reach into another firm matters', async () => {
    const mine = idOf(await createMatter('Mine'));
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/matters/bulk-delete`)
      .send({ matterIds: [mine] });

    // A bulk id list is caller-supplied, so it is the easiest place to pass an
    // id from somewhere else and see what happens.
    expect(await matterRow(mine)).toBeDefined();
    expect(res.body.deleted).toBe(0);
  });

  it('refuses a member without the permission', async () => {
    const a = idOf(await createMatter('A'));
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi.post(`${M()}/bulk-delete`).send({ matterIds: [a] });

    expect(res.status).toBe(403);
    expect(await matterCount()).toBe(1);
  });
});

describe('conflict checking', () => {
  it('finds an existing client by name', async () => {
    await createMatter('Existing Matter');

    const res = await owner.api.post(`${M()}/conflict-check`)
      .send({ names: ['Pat Person'] });

    // The check a firm runs before taking on work. Missing a conflict is a
    // disqualification, so a false negative is the expensive direction.
    expect(res.status).toBe(200);
    expect(res.body.hasConflicts).toBe(true);
    // "There is a conflict" is not actionable on its own. The firm has to see
    // WHICH matter, to decide whether it is a real one.
    expect(JSON.stringify(res.body)).toContain('Existing Matter');
  });

  it('reports no conflict for an unrelated name', async () => {
    await createMatter('Existing Matter');

    const res = await owner.api.post(`${M()}/conflict-check`)
      .send({ names: ['Nobody By That Name'] });

    // The negative half. A check that always reported a conflict would satisfy
    // the cases above and be ignored within a week.
    expect(res.body.hasConflicts).toBe(false);
  });

  it('does NOT report another firm clients as a conflict', async () => {
    await createMatter('Existing Matter');
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/matters/conflict-check`)
      .send({ names: ['Pat Person'] });

    // A conflict check that crossed firms would disclose another firm's client
    // list one name at a time, to anyone willing to guess.
    expect(res.body.hasConflicts).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('Existing Matter');
  });
});

describe('clients on a matter', () => {
  it('attaches a client', async () => {
    const created = await createMatter('Matter One');

    const res = await owner.api.post(`${M()}/${idOf(created)}/clients`)
      .send({ client: { name: 'Extra Person' } });

    expect(res.status).toBe(201);
    const lookup = await owner.api.get(`${M()}/lookup?q=Matter One`);
    expect(JSON.stringify(lookup.body)).toContain('Extra Person');
  });

  it('does not let one firm attach a client to another firm matter', async () => {
    const created = await createMatter('Matter One');
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/matters/${idOf(created)}/clients`)
      .send({ client: { name: 'Injected Person' } });

    expect(res.status).toBe(404);
  });
});

describe('matter input validation', () => {
  it('refuses an impossible calendar date for openDate, closeDate, or statuteOfLimitationsDate', async () => {
    const badOpen = await createMatter('Bad Open Date', { openDate: '2026-02-30' });
    expect(badOpen.status).toBe(400);
    expect(JSON.stringify(badOpen.body)).toMatch(/calendar date/i);

    const badClose = await createMatter('Bad Close Date', { closeDate: '2026-13-01' });
    expect(badClose.status).toBe(400);
    expect(JSON.stringify(badClose.body)).toMatch(/calendar date/i);

    const badSol = await createMatter('Bad SOL Date', { statuteOfLimitationsDate: '2026-04-31' });
    expect(badSol.status).toBe(400);
    expect(JSON.stringify(badSol.body)).toMatch(/calendar date/i);

    expect(await matterCount()).toBe(0);
  });

  it('refuses negative budget and out-of-range contingencyPercent', async () => {
    const negBudget = await createMatter('Negative Budget', { budget: -100 });
    expect(negBudget.status).toBe(400);

    const highContingency = await createMatter('Over 100 Percent Contingency', { contingencyPercent: 105 });
    expect(highContingency.status).toBe(400);

    const negContingency = await createMatter('Negative Contingency', { contingencyPercent: -5 });
    expect(negContingency.status).toBe(400);

    expect(await matterCount()).toBe(0);
  });

  it('refuses whitespace-only name on both create and update', async () => {
    const blankCreate = await createMatter('   ');
    expect(blankCreate.status).toBe(400);
    expect(JSON.stringify(blankCreate.body)).toMatch(/Name is required/i);
    expect(await matterCount()).toBe(0);

    const valid = await createMatter('Valid Name');
    expect(valid.status).toBe(201);
    const validId = idOf(valid);

    const blankUpdate = await owner.api.put(`${M()}/${validId}`).send({ name: '   ' });
    expect(blankUpdate.status).toBe(400);
    expect(JSON.stringify(blankUpdate.body)).toMatch(/Name is required/i);

    const current = await matterRow(validId);
    expect(current.name).toBe('Valid Name');
  });
});

