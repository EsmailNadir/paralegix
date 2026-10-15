/**
 * A matter's practice area and court must belong to the matter's own firm.
 *
 * Both columns are foreign keys to tenant tables, so a stored id from another
 * firm would make this firm's matter read another firm's catalog row. Creating
 * or editing a matter with an id that is not this firm's (another firm's, or
 * one that does not exist) is rejected with a 400 naming the field, and nothing
 * is written. Each case goes red if the service goes back to storing null (or
 * the foreign id) instead of refusing.
 */
import { randomUUID } from 'crypto';
import { installInMemoryBucket } from '../support/inMemoryBucket';
import {
  testPool,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let foreignAreaId: string;
let foreignCourtId: string;
let ownAreaId: string;
let ownCourtId: string;

const M = () => `/api/lawfirms/${firm.id}/matters`;

const insertArea = async (firmId: string, name: string) => (await testPool.query(
  'insert into practice_areas (law_firm_id, name) values ($1, $2) returning id', [firmId, name],
)).rows[0].id as string;
const insertCourt = async (firmId: string, name: string) => (await testPool.query(
  'insert into courts (law_firm_id, name) values ($1, $2) returning id', [firmId, name],
)).rows[0].id as string;

const matterCount = async () => Number((await testPool.query(
  'select count(*) n from matters where law_firm_id = $1', [firm.id],
)).rows[0].n);

const createBody = (extra: Record<string, unknown>) => ({
  name: 'Refs',
  clients: [{ clientId: client.id, name: 'Pat Person' }],
  ...extra,
});

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Pat Person' });
  const other = await createFirm();
  foreignAreaId = await insertArea(other.id, 'Foreign Area');
  foreignCourtId = await insertCourt(other.id, 'Foreign Court');
  ownAreaId = await insertArea(firm.id, 'Own Area');
  ownCourtId = await insertCourt(firm.id, 'Own Court');
});

describe('creating a matter', () => {
  it.each([
    ['practiceAreaId', 'Invalid practiceAreaId for this law firm', () => foreignAreaId],
    ['practiceAreaId', 'Invalid practiceAreaId for this law firm', () => randomUUID()],
    ['courtId', 'Invalid courtId for this law firm', () => foreignCourtId],
    ['courtId', 'Invalid courtId for this law firm', () => randomUUID()],
  ])('refuses a %s that is not this firm (%#), and writes no matter', async (field, message, idOf) => {
    const res = await owner.api.post(M()).send(createBody({ [field]: idOf() }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(message);
    expect(await matterCount()).toBe(0);
  });

  it('stores a practice area and court that belong to the firm', async () => {
    const res = await owner.api.post(M())
      .send(createBody({ practiceAreaId: ownAreaId, courtId: ownCourtId }));

    expect(res.status).toBe(201);
    const { rows } = await testPool.query(
      'select practice_area_id, court_id from matters where id = $1', [res.body.matterId],
    );
    expect(rows[0]).toEqual({ practice_area_id: ownAreaId, court_id: ownCourtId });
  });
});

describe('updating a matter', () => {
  let matterId: string;

  beforeEach(async () => {
    const res = await owner.api.post(M())
      .send(createBody({ practiceAreaId: ownAreaId, courtId: ownCourtId }));
    matterId = res.body.matterId;
  });

  const refsOf = async () => (await testPool.query(
    'select name, practice_area_id, court_id from matters where id = $1', [matterId],
  )).rows[0];

  it.each([
    ['practiceAreaId', 'Invalid practiceAreaId for this law firm', () => foreignAreaId],
    ['practiceAreaId', 'Invalid practiceAreaId for this law firm', () => randomUUID()],
    ['courtId', 'Invalid courtId for this law firm', () => foreignCourtId],
    ['courtId', 'Invalid courtId for this law firm', () => randomUUID()],
  ])('refuses a %s that is not this firm (%#), and changes nothing', async (field, message, idOf) => {
    const res = await owner.api.put(`${M()}/${matterId}`).send({ name: 'Renamed', [field]: idOf() });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(message);
    expect(await refsOf()).toEqual({ name: 'Refs', practice_area_id: ownAreaId, court_id: ownCourtId });
  });

  it('moves the matter to another practice area and court of the firm', async () => {
    const area = await insertArea(firm.id, 'Second Area');
    const court = await insertCourt(firm.id, 'Second Court');

    const res = await owner.api.put(`${M()}/${matterId}`).send({ practiceAreaId: area, courtId: court });

    expect(res.status).toBe(200);
    expect(await refsOf()).toEqual({ name: 'Refs', practice_area_id: area, court_id: court });
  });
});
