/**
 * Sending an intake form to a lead.
 *
 * `intakeSend.service.ts` is short and it is the only place in the leads module
 * that puts something in front of a person outside the firm. Two failure modes
 * matter and neither is visible from a status code:
 *
 *   WHO IT REACHED. The recipient is resolved as "the override address, else
 *   the lead's own", and the message carries a bearer link: whoever holds
 *   `/intake/<token>` can open the form and submit answers under that lead.
 *   Sending to the wrong address is a disclosure, and the firm member who
 *   clicked send is told it worked either way.
 *
 *   WHETHER IT SENT AT ALL ON A REFUSAL. Every validation failure here happens
 *   BEFORE the send, so a refused request must leave the outbox empty and the
 *   `intake_submissions` table untouched. A route that minted a submission and
 *   then threw would leave a live token behind for a form the firm decided not
 *   to send.
 *
 * The harness captures mail at the Resend transport, so the whole real send
 * path runs: the firm master switch, the per-recipient cap, the compliance
 * footer. `sentEmails()` is what would have gone over the wire.
 */
import { randomUUID } from 'crypto';
import { rejectNextEmail } from '../support/email.mock';

import {
  testPool,
  drainEvents,
  sentEmails,
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;

const sendPath = (leadId: string) => `/api/lawfirms/${firm.id}/leads/${leadId}/send-intake-form`;

async function seedLead(
  lawFirmId: string,
  overrides: { name?: string; email?: string | null } = {},
): Promise<{ id: string; name: string; email: string | null }> {
  const id = randomUUID();
  const name = overrides.name ?? 'Prospective Client';
  const email = 'email' in overrides ? overrides.email : `lead-${id.slice(0, 8)}@example.test`;
  const res = await testPool.query(
    'insert into leads (id, law_firm_id, name, email) values ($1, $2, $3, $4)',
    [id, lawFirmId, name, email],
  );
  expect(res.rowCount).toBe(1);
  return { id, name, email: email ?? null };
}

async function seedTemplate(
  lawFirmId: string,
  overrides: { name?: string; isActive?: boolean } = {},
): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  const name = overrides.name ?? 'General Intake';
  const res = await testPool.query(
    `insert into intake_form_templates (id, law_firm_id, name, public_token, fields, is_active)
     values ($1, $2, $3, $4, '[]'::jsonb, $5)`,
    [id, lawFirmId, name, `token-${randomUUID()}`, overrides.isActive ?? true],
  );
  expect(res.rowCount).toBe(1);
  return { id, name };
}

async function submissionsFor(lawFirmId: string) {
  const { rows } = await testPool.query(
    `select id, token, status, delivery_status, lead_id, sent_to_email, sent_by, sent_at, opened_at
       from intake_submissions where law_firm_id = $1 order by created_at asc`,
    [lawFirmId],
  );
  return rows;
}

/** Every address the intake mail actually went to, flattened. */
function intakeRecipients(): string[] {
  return sentEmails()
    .filter((m) => /please complete/i.test(m.subject || ''))
    .flatMap((m) => (Array.isArray(m.to) ? m.to : [m.to]));
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale and Co' });
  owner = await ownerOf(firm.id);
});

describe('sending the form', () => {
  it('mails the lead and records the submission', async () => {
    const lead = await seedLead(firm.id, { name: 'Jane Prospect' });
    const template = await seedTemplate(firm.id, { name: 'Estate Planning Intake' });

    const res = await owner.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: template.id });
    await drainEvents();

    expect(res.status).toBe(201);

    const rows = await submissionsFor(firm.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('sent');
    expect(rows[0].lead_id).toBe(lead.id);
    expect(rows[0].sent_to_email).toBe(lead.email);
    expect(rows[0].sent_by).toBe(owner.uid);
    expect(rows[0].opened_at).toBeNull();

    expect(intakeRecipients()).toEqual([lead.email]);
  });

  it('carries the submission token in the link, so the form is reachable', async () => {
    const lead = await seedLead(firm.id);
    const template = await seedTemplate(firm.id);

    await owner.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: template.id });
    await drainEvents();

    const [submission] = await submissionsFor(firm.id);
    const [message] = sentEmails();
    // The token IS the authentication of the public form page. A link built
    // from the template's own token, or from an id, would open the wrong thing
    // or nothing at all, and the send would still report success.
    expect(message.html).toContain(`/intake/${submission.token}`);
  });

  it('names the form and the firm in the subject', async () => {
    const lead = await seedLead(firm.id);
    const template = await seedTemplate(firm.id, { name: 'Estate Planning Intake' });

    await owner.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: template.id });
    await drainEvents();

    const [message] = sentEmails();
    expect(message.subject).toContain('Estate Planning Intake');
    expect(message.subject).toContain('Hale and Co');
  });

  it('sends to the override address instead of the lead address', async () => {
    const lead = await seedLead(firm.id, { email: 'old@example.test' });
    const template = await seedTemplate(firm.id);

    const res = await owner.api.post(sendPath(lead.id)).send({
      intakeFormTemplateId: template.id,
      email: 'Corrected@Example.test',
    });
    await drainEvents();

    expect(res.status).toBe(201);
    // Normalized, and the stale address on the lead must not also receive it.
    expect(intakeRecipients()).toEqual(['corrected@example.test']);
    expect(intakeRecipients()).not.toContain('old@example.test');
    expect((await submissionsFor(firm.id))[0].sent_to_email).toBe('corrected@example.test');
  });

  it('sends to a lead that has no address of its own when given an override', async () => {
    const lead = await seedLead(firm.id, { email: null });
    const template = await seedTemplate(firm.id);

    const res = await owner.api.post(sendPath(lead.id)).send({
      intakeFormTemplateId: template.id,
      email: 'reached@example.test',
    });
    await drainEvents();

    expect(res.status).toBe(201);
    expect(intakeRecipients()).toEqual(['reached@example.test']);
  });
});

describe('refusals send nothing', () => {
  it('refuses an inactive form and leaves the outbox and the table empty', async () => {
    const lead = await seedLead(firm.id);
    const template = await seedTemplate(firm.id, { isActive: false });

    const res = await owner.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: template.id });
    await drainEvents();

    expect(res.status).toBe(400);
    // Paired with the happy path above: identical fixtures apart from
    // `is_active`, so an empty outbox here can only be the check firing.
    expect(sentEmails()).toHaveLength(0);
    expect(await submissionsFor(firm.id)).toHaveLength(0);
  });

  it('refuses when there is no address anywhere, and mints no token', async () => {
    const lead = await seedLead(firm.id, { email: null });
    const template = await seedTemplate(firm.id);

    const res = await owner.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: template.id });
    await drainEvents();

    expect(res.status).toBe(400);
    expect(sentEmails()).toHaveLength(0);
    // A submission created before the address check would leave a live token
    // for a form the firm never actually sent.
    expect(await submissionsFor(firm.id)).toHaveLength(0);
  });

  it('refuses a malformed override address at validation, before the lead is read', async () => {
    const lead = await seedLead(firm.id);
    const template = await seedTemplate(firm.id);

    const res = await owner.api.post(sendPath(lead.id)).send({
      intakeFormTemplateId: template.id,
      email: 'not-an-address',
    });
    await drainEvents();

    expect(res.status).toBe(400);
    expect(sentEmails()).toHaveLength(0);
    expect(await submissionsFor(firm.id)).toHaveLength(0);
  });

  it('refuses a lead that does not exist', async () => {
    const template = await seedTemplate(firm.id);

    const res = await owner.api
      .post(sendPath('00000000-0000-0000-0000-000000000000'))
      .send({ intakeFormTemplateId: template.id });
    await drainEvents();

    expect(res.status).toBe(404);
    expect(sentEmails()).toHaveLength(0);
  });

  it('refuses a form that does not exist', async () => {
    const lead = await seedLead(firm.id);

    const res = await owner.api.post(sendPath(lead.id)).send({
      intakeFormTemplateId: '00000000-0000-0000-0000-000000000000',
    });
    await drainEvents();

    expect(res.status).toBe(404);
    expect(sentEmails()).toHaveLength(0);
  });
});

describe('resending', () => {
  it('replaces the old link only after an email to a replacement recipient succeeds', async () => {
    const lead = await seedLead(firm.id);
    const template = await seedTemplate(firm.id);
    expect((await owner.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: template.id })).status).toBe(201);
    const [before] = await submissionsFor(firm.id);
    const replacement = await owner.api.post(sendPath(lead.id)).send({
      intakeFormTemplateId: template.id, email: 'replacement@example.test',
    });
    expect(replacement.status).toBe(201);
    const [after] = await submissionsFor(firm.id);
    expect(after.id).toBe(before.id);
    expect(after.token).not.toBe(before.token);
    expect(after.sent_to_email).toBe('replacement@example.test');
    expect(after.delivery_status).toBe('sent');
    expect((await owner.api.get(`/api/intake/${before.token}`)).status).toBe(404);
    expect((await owner.api.get(`/api/intake/${after.token}`)).status).toBe(200);
  });
  it('reuses the open submission and preserves the link for the same recipient', async () => {
    const lead = await seedLead(firm.id);
    const template = await seedTemplate(firm.id);

    await owner.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: template.id });
    await drainEvents();
    const first = (await submissionsFor(firm.id))[0];

    await owner.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: template.id });
    await drainEvents();
    const rows = await submissionsFor(firm.id);

    // One row, not two: a second submission would leave two live tokens for
    // the same lead and form, and whichever the lead opened first would decide
    // which one the firm sees answers on.
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].token).toBe(first.token);
    expect(sentEmails()).toHaveLength(2);
    expect(sentEmails()[1].html).toContain(`/intake/${rows[0].token}`);
  });

  it('starts a new submission for a different form', async () => {
    const lead = await seedLead(firm.id);
    const first = await seedTemplate(firm.id, { name: 'First Form' });
    const second = await seedTemplate(firm.id, { name: 'Second Form' });

    await owner.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: first.id });
    await owner.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: second.id });
    await drainEvents();

    // Paired with the resend case: the reuse is scoped to lead AND form, so
    // two different forms must not collapse into one submission.
    expect(await submissionsFor(firm.id)).toHaveLength(2);
  });
});

describe('tenancy', () => {
  it('refuses a form belonging to another firm and sends nothing', async () => {
    const lead = await seedLead(firm.id);
    const otherFirm = await createFirm({ name: 'Neighbouring Firm' });
    const otherOwner = await ownerOf(otherFirm.id);
    const theirLead = await seedLead(otherFirm.id);
    const theirTemplate = await seedTemplate(otherFirm.id, { name: 'Neighbour Intake' });

    const res = await owner.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: theirTemplate.id });
    await drainEvents();

    expect(res.status).toBe(404);
    expect(sentEmails()).toHaveLength(0);
    expect(await submissionsFor(firm.id)).toHaveLength(0);

    // The neighbour sending their OWN lead their OWN form proves both rows are
    // real and the route works, so the refusal above is the scope and not a
    // broken fixture.
    const theirs = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/leads/${theirLead.id}/send-intake-form`)
      .send({ intakeFormTemplateId: theirTemplate.id });
    await drainEvents();
    expect(theirs.status).toBe(201);
    expect(await submissionsFor(otherFirm.id)).toHaveLength(1);
  });

  it('refuses a lead belonging to another firm and sends nothing', async () => {
    const template = await seedTemplate(firm.id);
    const otherFirm = await createFirm({ name: 'Neighbouring Firm' });
    const theirLead = await seedLead(otherFirm.id, { name: 'Their Prospect' });

    const res = await owner.api
      .post(sendPath(theirLead.id))
      .send({ intakeFormTemplateId: template.id });
    await drainEvents();

    expect(res.status).toBe(404);
    expect(sentEmails()).toHaveLength(0);
    expect(await submissionsFor(firm.id)).toHaveLength(0);
  });
});

describe('permissions', () => {
  it('refuses a member without leads.manage and sends nothing', async () => {
    const lead = await seedLead(firm.id);
    const template = await seedTemplate(firm.id);
    // `leads.view` is baseline, `leads.manage` is not. The fixtures are real
    // and sendable, so this cannot pass against an empty world.
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: template.id });
    await drainEvents();

    expect(res.status).toBe(403);
    expect(sentEmails()).toHaveLength(0);
    expect(await submissionsFor(firm.id)).toHaveLength(0);
  });

  it('lets a member holding leads.manage send one', async () => {
    const lead = await seedLead(firm.id);
    const template = await seedTemplate(firm.id);
    const manager = await memberWith(firm.id, ['leads.manage']);

    const res = await manager.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: template.id });
    await drainEvents();

    // Paired with the refusal above so neither passes against a route that
    // refuses everybody.
    expect(res.status).toBe(201);
    expect(intakeRecipients()).toEqual([lead.email]);
  });
});


describe('delivery refusals and resend recovery', () => {
  it.each(['provider rejection', 'daily cap'] as const)('reports %s, then reuses the submission on a successful resend', async (failure) => {
    const lead = await seedLead(firm.id);
    const template = await seedTemplate(firm.id);
    if (failure === 'provider rejection') {
      rejectNextEmail('Provider unavailable');
    } else {
      const seeded = await testPool.query(
        `insert into rate_limits (key, hits, expires_at) values ($1, $2, now() + interval '12 hours')`,
        [`email-daily:${lead.email}`, Number(process.env.EMAIL_MAX_PER_RECIPIENT_PER_DAY || 100)],
      );
      expect(seeded.rowCount).toBe(1);
    }
    const refusedDelivery = await owner.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: template.id });
    await drainEvents();
    expect(refusedDelivery.status).toBe(failure === 'daily cap' ? 429 : 503);
    expect(refusedDelivery.body.code).toBe('INTAKE_DELIVERY_FAILED');
    expect(intakeRecipients()).toEqual([]);
    const failedRows = await submissionsFor(firm.id);
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0].status).toBe('sent');
    expect(failedRows[0].sent_at).toBeNull();
    expect(failedRows[0].delivery_status).toBe('failed');
    expect(failedRows[0].sent_to_email).toBe(lead.email);
    if (failure === 'daily cap') {
      const expired = await testPool.query("update rate_limits set expires_at = now() - interval '1 hour' where key = $1", [`email-daily:${lead.email}`]);
      expect(expired.rowCount).toBe(1);
    }
    const resend = await owner.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: template.id });
    await drainEvents();
    expect(resend.status).toBe(201);
    const recoveredRows = await submissionsFor(firm.id);
    expect(recoveredRows).toHaveLength(1);
    expect(recoveredRows[0].id).toBe(failedRows[0].id);
    expect(recoveredRows[0].token).toBe(failedRows[0].token);
    expect(recoveredRows[0].delivery_status).toBe('sent');
    expect(intakeRecipients()).toEqual([lead.email]);
    const delivered = sentEmails().filter(message => /please complete/i.test(message.subject));
    expect(delivered).toHaveLength(1);
    expect(delivered[0].html).toContain(`/intake/${recoveredRows[0].token}`);
  });

  it.each([undefined, 'replacement@example.test'])('preserves a delivered link when a resend to %s fails', async (email) => {
    const lead = await seedLead(firm.id);
    const template = await seedTemplate(firm.id);
    const original = await owner.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: template.id });
    expect(original.status).toBe(201);
    const [before] = await submissionsFor(firm.id);
    rejectNextEmail('Provider unavailable');
    const failed = await owner.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: template.id, email });
    expect(failed.status).toBe(503);
    const [after] = await submissionsFor(firm.id);
    expect(after.token).toBe(before.token);
    expect(after.sent_to_email).toBe(before.sent_to_email);
    expect(after.sent_at).toEqual(before.sent_at);
    // The earlier email was delivered and its link still opens the form, so a
    // failed attempt to send another must not relabel the row as undelivered.
    expect(after.delivery_status).toBe('sent');
    const form = await owner.api.get(`/api/intake/${before.token}`);
    expect(form.status).toBe(200);
    expect(intakeRecipients()).toEqual([lead.email]);
  });
});

describe('a firm that turned email notifications off', () => {
  it('still delivers an intake form the member explicitly sent', async () => {
    const lead = await seedLead(firm.id);
    const template = await seedTemplate(firm.id);
    const switchedOff = await testPool.query(
      `update law_firms set settings = settings || '{"emailNotificationsEnabled": false}'::jsonb where id = $1`,
      [firm.id],
    );
    expect(switchedOff.rowCount).toBe(1);

    const res = await owner.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: template.id });
    await drainEvents();

    // The switch gates mail the system decides to send. This one was requested
    // by a click on "send", so suppressing it would hand the member a failure
    // that a retry can never clear.
    expect(res.status).toBe(201);
    expect(intakeRecipients()).toEqual([lead.email]);
    const [row] = await submissionsFor(firm.id);
    expect(row.delivery_status).toBe('sent');
    expect(row.sent_at).not.toBeNull();
  });
});

describe('a send that never finished', () => {
  async function seedPendingSubmission(leadId: string, templateId: string, ageMinutes: number) {
    const inserted = await testPool.query(
      `insert into intake_submissions
         (law_firm_id, intake_form_template_id, token, status, delivery_status, lead_id, sent_to_email, created_at)
       values ($1, $2, $3, 'sent', 'pending', $4, 'prospect@example.test', now() - make_interval(mins => $5::int))`,
      [firm.id, templateId, `tok-${randomUUID()}`, leadId, ageMinutes],
    );
    expect(inserted.rowCount).toBe(1);
  }

  it('shows a recent pending submission as pending and an abandoned one as failed', async () => {
    const lead = await seedLead(firm.id);
    const template = await seedTemplate(firm.id);
    await seedPendingSubmission(lead.id, template.id, 5);
    const recent = await owner.api.get(`/api/lawfirms/${firm.id}/leads/${lead.id}`);
    expect(recent.status).toBe(200);
    expect(recent.body.lead.latestIntakeSubmission.deliveryStatus).toBe('pending');

    // Paired with the recent row: same fixture, only the age differs, so the
    // flip to failed is the staleness rule and not a broken read.
    await testPool.query(
      `update intake_submissions set created_at = now() - interval '20 minutes' where lead_id = $1`,
      [lead.id],
    );
    const abandoned = await owner.api.get(`/api/lawfirms/${firm.id}/leads/${lead.id}`);
    expect(abandoned.body.lead.latestIntakeSubmission.deliveryStatus).toBe('failed');
  });

  it('lets the next send finish an abandoned submission', async () => {
    const lead = await seedLead(firm.id);
    const template = await seedTemplate(firm.id);
    await seedPendingSubmission(lead.id, template.id, 20);
    await testPool.query(`update intake_submissions set sent_to_email = $2 where lead_id = $1`, [lead.id, lead.email]);

    const res = await owner.api.post(sendPath(lead.id)).send({ intakeFormTemplateId: template.id });
    expect(res.status).toBe(201);
    const rows = await submissionsFor(firm.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].delivery_status).toBe('sent');
  });
});
