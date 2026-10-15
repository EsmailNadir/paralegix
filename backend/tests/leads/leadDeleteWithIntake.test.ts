/**
 * Deleting a lead that has an intake submission attached.
 *
 * `intake_submissions.lead_id` is the trail from a submitted or sent intake form
 * back to the lead it produced, and it is declared ON DELETE SET NULL: the
 * submission survives as a record of what the firm received, it just stops
 * pointing at a lead that no longer exists. That is audit history, so keeping it
 * is the intent.
 *
 * The key is COMPOSITE and carries the tenant column, which is the same defect
 * migrations 0184 and 0186 fixed elsewhere: ON DELETE SET NULL nulls EVERY
 * column of the key, including a NOT NULL one.
 *
 * Every completed public intake writes one of these rows, and so does sending an
 * intake form to an existing lead, so this is not an edge case. It is every lead
 * that ever touched an intake form.
 */
import { ownerOf, createFirm, testPool } from '../support/setupInProcess';
import { randomUUID } from 'crypto';

async function seedIntakeSubmission(lawFirmId: string, leadId: string) {
  const templateId = randomUUID();
  await testPool.query(
    `insert into intake_form_templates (id, law_firm_id, name, public_token, fields, is_active)
     values ($1, $2, 'Intake form', $3, '[]'::jsonb, true)`,
    [templateId, lawFirmId, `tok-${templateId}`],
  );
  const submissionId = randomUUID();
  await testPool.query(
    `insert into intake_submissions
       (id, law_firm_id, intake_form_template_id, token, field_values, status, lead_id)
     values ($1, $2, $3, $4, '{}'::jsonb, 'completed', $5)`,
    [submissionId, lawFirmId, templateId, `sub-${submissionId}`, leadId],
  );
  return submissionId;
}

async function createLead(api: any, lawFirmId: string, name: string) {
  const res = await api.post(`/api/lawfirms/${lawFirmId}/leads`).send({ name });
  expect(res.status).toBe(201);
  return res.body.lead?.id ?? res.body.id;
}

describe('a lead that received an intake form can still be deleted', () => {
  it('deletes the lead and keeps the submission as history', async () => {
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const leadId = await createLead(owner.api, firmId, 'Lead who submitted an intake form');
    const submissionId = await seedIntakeSubmission(firmId, leadId);

    const res = await owner.api.delete(`/api/lawfirms/${firmId}/leads/${leadId}`);

    expect(res.status).toBe(200);

    const { rows: leads } = await testPool.query(
      'select count(*)::int as n from leads where law_firm_id = $1 and id = $2',
      [firmId, leadId],
    );
    expect(leads[0].n).toBe(0);

    // The submission survives with its pointer cleared. Deleting it instead
    // would destroy the record of what the firm was actually sent, which is the
    // part a firm may need months later.
    const { rows: subs } = await testPool.query(
      'select lead_id, law_firm_id, status from intake_submissions where id = $1',
      [submissionId],
    );
    expect(subs).toHaveLength(1);
    expect(subs[0].lead_id).toBeNull();
    expect(subs[0].law_firm_id).toBe(firmId);
    expect(subs[0].status).toBe('completed');
  });

  it('still deletes a lead that never touched an intake form', async () => {
    // The control. Without it, a route that refused every delete would satisfy
    // nothing above but would look plausible.
    const { id: firmId } = await createFirm();
    const owner = await ownerOf(firmId);
    const leadId = await createLead(owner.api, firmId, 'Lead with no intake form');

    const res = await owner.api.delete(`/api/lawfirms/${firmId}/leads/${leadId}`);

    expect(res.status).toBe(200);
  });

  it('leaves another firm\'s submission untouched', async () => {
    // The tenancy control on a cascade-adjacent operation: the SET NULL must
    // reach exactly the rows of the deleted lead.
    const { id: firmA } = await createFirm();
    const { id: firmB } = await createFirm();
    const ownerA = await ownerOf(firmA);
    const ownerB = await ownerOf(firmB);

    const leadA = await createLead(ownerA.api, firmA, 'Firm A lead');
    await seedIntakeSubmission(firmA, leadA);
    const leadB = await createLead(ownerB.api, firmB, 'Firm B lead');
    const subB = await seedIntakeSubmission(firmB, leadB);

    await ownerA.api.delete(`/api/lawfirms/${firmA}/leads/${leadA}`);

    const { rows } = await testPool.query(
      'select lead_id from intake_submissions where id = $1',
      [subB],
    );
    expect(rows[0].lead_id).toBe(leadB);
  });
});
