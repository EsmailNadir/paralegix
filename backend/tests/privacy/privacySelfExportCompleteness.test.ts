/**
 * B11.2: the self-service archive must include the subject's recorded consent
 * evidence. Policy version and source IP are stored against the user and are
 * personal data needed to verify the subject's own acceptance record.
 */
import {
  createFirm,
  drainEvents,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const ACCEPT_TERMS = '/api/privacy/accept-terms';
const EXPORT_ME = '/api/privacy/me/export';

let firm: Firm;
let me: Actor;

beforeEach(async () => {
  firm = await createFirm();
  me = await memberWith(firm.id, []);
  await drainEvents();
});

describe('self-service export consent evidence', () => {
  it('includes the caller policy version and recorded source IP', async () => {
    const accepted = await me.api.post(ACCEPT_TERMS)
      .set('X-Forwarded-For', '198.51.100.52')
      .send({ version: '2026-09-subject-access' });

    expect(accepted.status).toBe(200);

    const exported = await me.api.get(EXPORT_ME);

    // The caller's identity is the positive control: these assertions prove
    // this is their own accepted-policy evidence, not a generic response.
    expect(exported.status).toBe(200);
    expect(exported.body.user).toMatchObject({
      id: me.uid,
      consentVersion: '2026-09-subject-access',
      consentIp: '198.51.100.52',
    });
  });
});
