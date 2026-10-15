/**
 * The login audit event carries the caller's approximate location.
 *
 * The admin audit UI shows and searches the city, region and country recorded
 * here, so the lookup has to land real values in the stored metadata, not a
 * placeholder. The location comes from the offline MaxMind data behind
 * `src/shared/utils/geoip.ts`, keyed on the client address Express derives from
 * `X-Forwarded-For` under the app's `trust proxy` setting.
 */
import {
  createFirm,
  ownerOf,
  request,
  testPool,
  tokenFor,
  type Firm,
} from '../support/setupInProcess';

const realGeoip = jest.requireActual('geoip-lite');

let firm: Firm;

beforeEach(async () => {
  firm = await createFirm({ name: 'Login Audit Firm' });
});

/** The login event is written after the response, so wait for it rather than racing it. */
async function loginEventFor(lawFirmId: string, uid: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling for a fire-and-forget write
    const { rows } = await testPool.query(
      `select metadata from audit_events
        where law_firm_id = $1 and actor_uid = $2 and action = 'auth.login'`,
      [lawFirmId, uid],
    );
    if (rows.length || Date.now() > deadline) return rows[0] || null;
    // eslint-disable-next-line no-await-in-loop -- polling for a fire-and-forget write
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

describe('POST /api/auth/login', () => {
  it('records the city, region and country of the client address on the audit event', async () => {
    const owner = await ownerOf(firm.id);
    const expected = realGeoip.lookup('81.2.69.142');
    expect(expected.city).toBeTruthy();

    const res = await request()
      .post('/api/auth/login')
      .set('X-Forwarded-For', '81.2.69.142')
      .send({ token: tokenFor({ uid: owner.uid }) });

    expect(res.status).toBe(200);
    const event = await loginEventFor(firm.id, owner.uid);
    expect(event).not.toBeNull();
    expect(event.metadata.location).toEqual({
      city: expected.city,
      region: expected.region,
      country: expected.country,
      timezone: expected.timezone,
      coordinates: expected.ll,
    });
  });
});
