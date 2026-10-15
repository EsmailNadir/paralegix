/**
 * `law_firm_created` reaches product analytics from the server, not the browser.
 *
 * A browser can miss the event (a closed tab between the 201 and the capture)
 * or send it twice (a retried click), and it only ever saw the self-serve path.
 * `createLawFirm` is where every firm is actually written, so the event fires
 * there, once per firm row, and nowhere on a refused create.
 *
 * WHAT MAY LEAVE. The create form's size and practice area are free text on the
 * wire (`z.string().max(50)`), so neither is forwarded as typed. Size is mapped
 * onto the form's own option values and anything else collapses to `other`;
 * practice area is reported only as present or absent. The firm NAME never
 * leaves: it is client-identifying for a solo practitioner.
 *
 * The analytics module is replaced with a recording fake, so every assertion
 * below is about what the service ASKED to send. The two refusals (a portal
 * client, and a founder at the membership cap) are pinned here in full, the
 * row that was not written as well as the event that was not sent.
 */
const mockCapture = jest.fn();
jest.mock('../../src/shared/analytics/serverAnalytics', () => ({
  captureServerEvent: (...args: unknown[]) => mockCapture(...args),
}));

import { randomUUID } from 'crypto';

import {
  as,
  createFirm,
  ownerOf,
  testPool,
  tokenFor,
  type Actor,
} from '../support/setupInProcess';

const firebase = require('../../src/shared/database/firebase');

/** A signed-in firm_member who belongs to no firm yet, so they may create one. */
async function unaffiliatedFounder() {
  const uid = `founder-${randomUUID().slice(0, 8)}`;
  await testPool.query(
    `insert into users (id, email, name, user_type) values ($1, $2, 'Founder', 'firm_member')`,
    [uid, `${uid}@example.test`],
  );
  return { uid, api: as(tokenFor({ uid })) };
}

const createdCaptures = () => mockCapture.mock.calls
  .map(([input]) => input)
  .filter((input: any) => input.event === 'law_firm_created');

beforeEach(() => {
  mockCapture.mockReset();
});

describe('self-serve firm creation', () => {
  it('captures law_firm_created once, for the new firm, as the founder', async () => {
    const founder = await unaffiliatedFounder();

    const res = await founder.api.post('/api/lawfirms/create-lawfirm').send({
      name: 'Patterson & Associates',
      firmSize: '2-5',
      practiceArea: 'Family Law',
    });

    expect(res.status).toBe(201);
    expect(createdCaptures()).toEqual([{
      event: 'law_firm_created',
      lawFirmId: res.body.lawFirmId,
      distinctId: founder.uid,
      properties: { firm_size: '2-5', has_practice_area: true, created_via: 'self_serve' },
    }]);
  });

  it('reports an omitted size and practice area as not_specified / false', async () => {
    const founder = await unaffiliatedFounder();

    const res = await founder.api.post('/api/lawfirms/create-lawfirm').send({ name: 'Solo Practice' });

    expect(res.status).toBe(201);
    expect(createdCaptures()).toEqual([expect.objectContaining({
      lawFirmId: res.body.lawFirmId,
      properties: { firm_size: 'not_specified', has_practice_area: false, created_via: 'self_serve' },
    })]);
  });

  it('never forwards free text typed into the size field', async () => {
    const founder = await unaffiliatedFounder();

    const res = await founder.api.post('/api/lawfirms/create-lawfirm').send({
      name: 'Freeform LLP',
      firmSize: 'Jane Smith and her paralegal',
    });

    expect(res.status).toBe(201);
    const [capture] = createdCaptures();
    expect(capture.properties.firm_size).toBe('other');
    // Nothing the founder typed, including the firm name, is in the payload.
    expect(JSON.stringify(capture)).not.toMatch(/Jane Smith|Freeform/);
  });

  it('captures nothing when the create is refused for a portal client', async () => {
    const uid = `portal-${randomUUID().slice(0, 8)}`;
    await testPool.query(
      `insert into users (id, email, name, user_type) values ($1, $2, 'Portal Person', 'client')`,
      [uid, `${uid}@example.test`],
    );

    const res = await as(tokenFor({ uid })).post('/api/lawfirms/create-lawfirm').send({ name: 'Client Owned Firm' });

    // `requireUserType(['firm_member'])` is the whole gate: the signup radio is
    // UI only, and without it a portal client could post here and become the
    // owner of a firm. Nothing is written, so nothing is reported.
    expect(res.status).toBe(403);
    const { rows } = await testPool.query(`select 1 from law_firms where name = 'Client Owned Firm'`);
    expect(rows).toHaveLength(0);
    expect(createdCaptures()).toEqual([]);
  });

  it('captures nothing when the founder is at the firm-membership cap', async () => {
    const firm = await createFirm({ name: 'Existing Firm' });
    const owner: Actor = await ownerOf(firm.id);

    const res = await owner.api.post('/api/lawfirms/create-lawfirm').send({ name: 'Second Firm' });

    // The refusal is the premise: a 201 here would make the empty list meaningless.
    // The cap is what stops one account from accumulating firms.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/maximum number of law firm memberships/i);
    expect(createdCaptures()).toEqual([]);
  });
});

describe('admin test-account tooling', () => {
  let restoreAuth: () => void;

  beforeEach(() => {
    const previous = {
      createUser: firebase.auth.createUser,
      getUserByEmail: firebase.auth.getUserByEmail,
    };
    Object.assign(firebase.auth, {
      createUser: jest.fn(async () => ({ uid: `fb-${randomUUID().slice(0, 8)}` })),
      getUserByEmail: jest.fn(async () => {
        throw Object.assign(new Error('auth/user-not-found'), { code: 'auth/user-not-found' });
      }),
    });
    restoreAuth = () => Object.assign(firebase.auth, previous);
  });

  afterEach(() => restoreAuth());

  it('marks a firm minted by the admin tool as admin-created', async () => {
    const adminUid = `admin-${randomUUID().slice(0, 8)}`;
    await testPool.query(
      `insert into users (id, email, name, user_type, is_admin) values ($1, $2, 'Tooling Admin', 'firm_member', true)`,
      [adminUid, `${adminUid}@example.test`],
    );

    const res = await as(tokenFor({ uid: adminUid })).post('/api/admin/test-accounts').send({
      kind: 'firm_owner',
      email: `owner-${randomUUID().slice(0, 8)}@example.test`,
      password: 'correct horse',
      name: 'Founder Person',
      firmName: 'Tooling Firm',
    });

    expect(res.status).toBe(201);
    const { uid, lawFirmId } = res.body.account;
    // Filed under the minted owner, not the admin who pressed the button: the
    // owner is who will use the firm.
    expect(createdCaptures()).toEqual([{
      event: 'law_firm_created',
      lawFirmId,
      distinctId: uid,
      properties: { firm_size: 'not_specified', has_practice_area: false, created_via: 'admin' },
    }]);
  });
});
