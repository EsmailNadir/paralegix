/**
 * Who may read whose profile through `GET /api/users/:userId`.
 *
 * The profile carries a person's real name and address. Its rule is: yourself,
 * anyone who shares a firm with you as a member, or a client reading a member
 * of their own firm (their legal team). A client may NOT read another client,
 * even one in the same firm, because a co-client's uid is visible in a group
 * conversation payload and the firm may have chosen to hide client names.
 * Everyone refused gets the same 404 an unknown uid gets, so a uid cannot be
 * used to confirm that an account exists.
 */
import {
  testPool,
  createFirm,
  createFirmMember,
  createPersonClient,
  createPortalUser,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

const profile = (uid: string) => `/api/users/${uid}`;

beforeEach(async () => {
  firm = await createFirm({ name: 'Profile Firm' });
  owner = await ownerOf(firm.id);
  await testPool.query(`update users set is_admin = true, name = 'Owner Person' where id = $1`, [owner.uid]);
});

/** A portal client of `lawFirmId` with a users row, and their caller. */
async function portalClientOf(lawFirmId: string, name: string) {
  const { uid } = await createPortalUser();
  await testPool.query('update users set name = $2 where id = $1', [uid, name]);
  await createPersonClient(lawFirmId, { userId: uid, email: `${uid}@example.test`, name });
  return { uid, api: as(tokenFor({ uid })) };
}

describe('reading a profile', () => {
  it('shows a person their own profile, including their admin flag', async () => {
    const res = await owner.api.get(profile(owner.uid));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: owner.uid, name: 'Owner Person', isAdmin: true });
  });

  it('shows a co-member the profile, without the admin flag', async () => {
    const colleague = await createFirmMember(firm.id, { isOwner: false, permissions: ['matters.view'] });

    const res = await as(tokenFor({ uid: colleague.uid })).get(profile(owner.uid));

    // Platform-admin status is withheld from everyone but the account owner,
    // so a uid cannot be used to find the super-admins.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: owner.uid, name: 'Owner Person' });
    expect(res.body).not.toHaveProperty('isAdmin');
  });

  it('shows a firm member one of the firm clients', async () => {
    const client = await portalClientOf(firm.id, 'Firm Client');

    const res = await owner.api.get(profile(client.uid));

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Firm Client');
  });

  it('shows a client a member of their own firm', async () => {
    const client = await portalClientOf(firm.id, 'Firm Client');

    const res = await client.api.get(profile(owner.uid));

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Owner Person');
  });

  it('hides one client from another client of the same firm', async () => {
    const first = await portalClientOf(firm.id, 'First Client');
    const second = await portalClientOf(firm.id, 'Second Client');

    const res = await first.api.get(profile(second.uid));

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Second Client');
  });

  it('hides a member of another firm', async () => {
    const other = await createFirm({ name: 'Other Firm' });
    const outsider = await ownerOf(other.id);

    const res = await outsider.api.get(profile(owner.uid));

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Owner Person');
  });

  it('answers a refused read and an unknown uid identically', async () => {
    const other = await createFirm();
    const outsider = await ownerOf(other.id);

    const refused = await outsider.api.get(profile(owner.uid));
    const unknown = await outsider.api.get(profile('no-such-user'));

    expect([refused.status, refused.body.error, refused.body.code])
      .toEqual([unknown.status, unknown.body.error, unknown.body.code]);
  });
});
