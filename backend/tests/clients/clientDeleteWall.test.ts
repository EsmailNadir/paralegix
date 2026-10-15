/**
 * DELETE /api/lawfirms/:lawFirmId/clients/:clientId and the matter ethical wall.
 *
 * Deleting a client cascades away its `matter_clients` rows, notes, events and
 * files on every matter it is linked to. Linking and unlinking a client one
 * matter at a time requires write access to that matter, so a delete must not
 * be a way to do the same on matters the caller is walled from. The refusal
 * states how many matters stand in the way and names none of them: the caller
 * is not allowed to learn what those matters are.
 *
 * What has to break for each case to go red:
 *   - the refusal cases: remove the per-matter check from `removeClient`.
 *   - the count: report a fixed or total count instead of the hidden count.
 *   - the allowed cases: refuse on any linked matter rather than only walled ones.
 */
import { randomUUID } from 'crypto';
import { installInMemoryBucket } from '../support/inMemoryBucket';
import {
  testPool,
  createFirm,
  createPersonClient,
  memberWith,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

installInMemoryBucket();

let firm: Firm;
let clientId: string;
let deleter: Actor;

const del = (actor: Actor = deleter) => actor.api.delete(`/api/lawfirms/${firm.id}/clients/${clientId}`);

async function seedMatter(name: string, memberUids: string[]): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, $3, $4)`,
    [id, firm.id, name, `REF-${id.slice(0, 8)}`],
  );
  await testPool.query(
    'insert into matter_clients (law_firm_id, matter_id, client_id) values ($1, $2, $3)',
    [firm.id, id, clientId],
  );
  for (const uid of memberUids) {
    await testPool.query(
      'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
      [firm.id, id, uid],
    );
  }
  return id;
}

const clientRows = async () => (await testPool.query('select id from clients where id = $1', [clientId])).rowCount;
const linkRows = async () => (await testPool.query(
  'select count(*)::int n from matter_clients where client_id = $1', [clientId],
)).rows[0].n as number;

beforeEach(async () => {
  firm = await createFirm();
  clientId = (await createPersonClient(firm.id, { name: 'Walled Client' })).id;
  deleter = await memberWith(firm.id, ['clients.view', 'clients.manage', 'matters.view']);
});

describe('deleting a client linked to matters the caller cannot access', () => {
  it('refuses with 403, states the count and names no matter, and deletes nothing', async () => {
    await seedMatter('Visible Matter Alpha', [deleter.uid]);
    await seedMatter('Secret Matter Bravo', []);

    const res = await del();

    expect(res.status).toBe(403);
    expect(res.body.message ?? res.body.error).toMatch(/\b1 matter\b/);
    expect(JSON.stringify(res.body)).not.toContain('Secret Matter Bravo');
    expect(JSON.stringify(res.body)).not.toContain('Visible Matter Alpha');
    expect(await clientRows()).toBe(1);
    expect(await linkRows()).toBe(2);
  });

  it('counts every walled matter, not just whether there is one', async () => {
    await seedMatter('Secret Matter Bravo', []);
    await seedMatter('Secret Matter Charlie', []);
    await seedMatter('Visible Matter Alpha', [deleter.uid]);

    const res = await del();

    expect(res.status).toBe(403);
    expect(res.body.message ?? res.body.error).toMatch(/\b2 matters\b/);
    expect(await clientRows()).toBe(1);
  });

  it('deletes when the caller is on every matter the client is linked to', async () => {
    await seedMatter('Visible Matter Alpha', [deleter.uid]);
    await seedMatter('Visible Matter Bravo', [deleter.uid]);

    const res = await del();

    expect(res.status).toBe(200);
    expect(await clientRows()).toBe(0);
    expect(await linkRows()).toBe(0);
  });

  it('lets a firm owner delete through matters they are not a member of', async () => {
    await seedMatter('Secret Matter Bravo', []);

    const res = await del(await ownerOf(firm.id));

    expect(res.status).toBe(200);
    expect(await clientRows()).toBe(0);
  });

  it('deletes a client with no matters for a plain member', async () => {
    const res = await del();

    expect(res.status).toBe(200);
    expect(await clientRows()).toBe(0);
  });
});


describe('targeted client invitation cleanup', () => {
  it('deletes only the removed client invitation when another target shares its email', async () => {
    const email = 'shared-inbox@example.test';
    await testPool.query('update clients set email = $2 where id = $1', [clientId, email]);
    const other = await createPersonClient(firm.id, { name: 'Other Target' });
    const rival = await createFirm();
    const rivalClient = await createPersonClient(rival.id, { name: 'Other Firm Target' });
    const ownInvite = randomUUID();
    const otherInvite = randomUUID();
    const rivalInvite = randomUUID();
    for (const [id, lawFirmId, targetId] of [
      [ownInvite, firm.id, clientId],
      [otherInvite, firm.id, other.id],
      [rivalInvite, rival.id, rivalClient.id],
    ]) {
      await testPool.query(
        `insert into invitations (id, law_firm_id, email, invite_type, token, client_id)
         values ($1::uuid, $2, $3, 'client', $1::text, $4)`,
        [id, lawFirmId, email, targetId],
      );
    }

    const res = await del();

    expect(res.status).toBe(200);
    expect(await clientRows()).toBe(0);
    const { rows } = await testPool.query('select id, client_id from invitations order by id');
    expect(rows).toEqual([
      { id: otherInvite, client_id: other.id },
      { id: rivalInvite, client_id: rivalClient.id },
    ].sort((a, b) => a.id.localeCompare(b.id)));
  });
});
