/**
 * The two account routes keyed on the caller's own identity: the firm list the
 * app switcher renders, and the display name every other surface shows.
 * Neither had coverage.
 *
 * Both take the uid from the token and never from the request, which is the
 * property worth pinning, because both are otherwise shaped like routes that
 * would accept one:
 *
 *   GET /api/users/my-memberships
 *     Answers "which firms am I in". A version that read a caller-supplied uid
 *     would enumerate anyone's firms, and the response carries firm names, so
 *     the leak is legible rather than a list of opaque ids.
 *
 *   PUT /api/users/update-name
 *     Writes `users.name`. That one row is read by every roster, every note
 *     byline and every message sender label across every firm the person is in,
 *     so a route that wrote to a supplied uid would let anyone rename anyone,
 *     including into a colleague's name inside a client-facing thread.
 *
 * The cross-firm cases seed a SECOND firm the caller does not belong to, so
 * "only my firms" is measured against firms that really exist.
 */
import {
  createFirm,
  createFirmMember,
  createPortalUser,
  memberWith,
  ownerOf,
  testPool,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let rival: Firm;
let rivalOwner: Actor;

const MEMBERSHIPS = '/api/users/my-memberships';
const UPDATE_NAME = '/api/users/update-name';

const firmIdsIn = (body: any) => (body.memberships ?? []).map((m: any) => m.lawFirmId ?? m.id);

async function storedName(uid: string) {
  const { rows } = await testPool.query('select name from users where id = $1', [uid]);
  return rows[0]?.name;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  rival = await createFirm({ name: 'Rival LLP' });
  rivalOwner = await ownerOf(rival.id);
});

describe('GET /api/users/my-memberships', () => {
  it('lists the calling user own firm and not one they are not in', async () => {
    const res = await owner.api.get(MEMBERSHIPS);

    // The rival firm exists and has its own owner, so this is a boundary
    // assertion rather than a statement about an empty table.
    expect(res.status).toBe(200);
    expect(firmIdsIn(res.body)).toEqual([firm.id]);
    expect(JSON.stringify(res.body)).not.toContain('Rival LLP');
  });

  it('lists every firm one person belongs to', async () => {
    // The same real person, an owner at one firm and a narrow role at the other.
    // This is what the app switcher renders, so a query that stopped at the
    // first row would silently strand somebody in one workspace.
    const second = await memberWith(rival.id, ['matters.view'], { uid: owner.uid });
    expect(second.uid).toBe(owner.uid);

    const res = await owner.api.get(MEMBERSHIPS);

    expect(firmIdsIn(res.body).sort()).toEqual([firm.id, rival.id].sort());
  });

  it('ignores a uid supplied by the caller', async () => {
    const res = await owner.api.get(`${MEMBERSHIPS}?userId=${rivalOwner.uid}`);

    // The uid comes from the verified token. Reading one off the query string
    // would turn this into an enumeration of anyone's firms by uid.
    expect(firmIdsIn(res.body)).toEqual([firm.id]);
  });

  it('serves an empty list to a signed-in caller who is in no firm', async () => {
    const portal = await createPortalUser();

    const res = await as(tokenFor({ uid: portal.uid })).get(MEMBERSHIPS);

    // Two firms exist. A portal-only person is in neither, and the answer is an
    // empty list rather than an error, because the client portal calls this too.
    expect(res.status).toBe(200);
    expect(res.body.memberships ?? []).toEqual([]);
  });

  it('drops a membership once the person is removed from the firm', async () => {
    const colleague = await memberWith(firm.id, ['matters.view']);
    expect(firmIdsIn((await colleague.api.get(MEMBERSHIPS)).body)).toEqual([firm.id]);

    await testPool.query('delete from members where law_firm_id = $1 and user_id = $2',
      [firm.id, colleague.uid]);

    // Read live from `members`, not from a copy on the user row. A cached list
    // would keep showing a workspace every request inside it now refuses.
    expect(firmIdsIn((await colleague.api.get(MEMBERSHIPS)).body)).toEqual([]);
  });
});

describe('PUT /api/users/update-name', () => {
  it('renames the calling user', async () => {
    const res = await owner.api.put(UPDATE_NAME).send({ name: 'Alice Attorney' });

    expect(res.status).toBe(200);
    expect(await storedName(owner.uid)).toBe('Alice Attorney');
  });

  it('trims surrounding whitespace before storing', async () => {
    await owner.api.put(UPDATE_NAME).send({ name: '  Alice Attorney  ' });

    // The stored value is what every roster and message byline renders. Leading
    // space missorts the roster; trailing space is invisible and undebuggable.
    expect(await storedName(owner.uid)).toBe('Alice Attorney');
  });

  it('refuses a blank name instead of storing one', async () => {
    await owner.api.put(UPDATE_NAME).send({ name: 'Alice Attorney' });

    const res = await owner.api.put(UPDATE_NAME).send({ name: '   ' });

    // A person with no name renders as an empty byline everywhere at once, and
    // there is no screen that would explain why.
    expect(res.status).toBe(400);
    expect(await storedName(owner.uid)).toBe('Alice Attorney');
  });

  it('writes only the caller own row, whatever uid the body carries', async () => {
    const { uid: victim } = await createFirmMember(firm.id, { isOwner: false });
    await testPool.query('update users set name = $2 where id = $1', [victim, 'Bob Colleague']);

    const res = await owner.api.put(UPDATE_NAME)
      .send({ name: 'Renamed By Someone Else', userId: victim, uid: victim, id: victim });

    // Offered three ways a handler might plausibly read it. The caller's own row
    // moves and the colleague's does not: renaming a colleague inside a
    // client-facing thread is impersonation, not a profile edit.
    expect(res.status).toBe(200);
    expect(await storedName(owner.uid)).toBe('Renamed By Someone Else');
    expect(await storedName(victim)).toBe('Bob Colleague');
  });

  it('shows the new name to the caller own firm roster', async () => {
    await owner.api.put(UPDATE_NAME).send({ name: 'Alice Renamed' });

    const roster = await owner.api.get(`/api/users/lawfirm/${firm.id}/users`);

    // The name is no longer denormalized onto member rows, so the roster has to
    // read it back through a join. Asserting the row alone would pass against a
    // write nothing downstream can see.
    expect(roster.status).toBe(200);
    expect(JSON.stringify(roster.body)).toContain('Alice Renamed');
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so its
// top-level bindings stay file-scoped rather than colliding across specs.
export {};
