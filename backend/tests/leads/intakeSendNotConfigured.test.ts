/**
 * Sending an intake form where no email provider key is configured (local
 * development). The send cannot succeed, and the member is told why with a
 * code that is distinct from a transient provider failure, so the message is
 * not a prompt to retry something that will never work.
 *
 * This lives in its own file because `emailService` resolves the provider key
 * once per process, at the first send: the key has to be gone before any send
 * in the file runs.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  ownerOf,
  sentEmails,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

beforeAll(() => {
  delete process.env.RESEND_API_KEY;
});

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale and Co' });
  owner = await ownerOf(firm.id);
});

it('reports a missing provider key as its own error and records the send as failed', async () => {
  const leadId = randomUUID();
  const templateId = randomUUID();
  await testPool.query(
    'insert into leads (id, law_firm_id, name, email) values ($1, $2, $3, $4)',
    [leadId, firm.id, 'Prospect', 'prospect@example.test'],
  );
  await testPool.query(
    `insert into intake_form_templates (id, law_firm_id, name, public_token, fields, is_active)
     values ($1, $2, 'General Intake', $3, '[]'::jsonb, true)`,
    [templateId, firm.id, `token-${randomUUID()}`],
  );

  const res = await owner.api
    .post(`/api/lawfirms/${firm.id}/leads/${leadId}/send-intake-form`)
    .send({ intakeFormTemplateId: templateId });

  expect(res.status).toBe(503);
  expect(res.body.code).toBe('EMAIL_NOT_CONFIGURED');
  expect(res.body.error ?? res.body.message).not.toMatch(/try again/i);
  expect(sentEmails()).toHaveLength(0);
  const { rows } = await testPool.query(
    'select delivery_status from intake_submissions where law_firm_id = $1',
    [firm.id],
  );
  expect(rows.map((r) => r.delivery_status)).toEqual(['failed']);
});
