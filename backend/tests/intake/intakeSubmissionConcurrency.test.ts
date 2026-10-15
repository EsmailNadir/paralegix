/**
 * Concurrency tests for targeted intake form submissions.
 *
 * B10.3 requirement:
 * "Two simultaneous targeted submissions, lead conversions, or invitation
 * acceptances exercise uniqueness and atomicity through routes."
 *
 * A targeted intake link is issued to a specific prospective client/lead as an
 * intake_submissions row in 'sent' status. Once submitted, it transitions to
 * 'completed' and applies values to the lead.
 *
 * If two requests arrive for the same targeted token concurrently, exactly ONE
 * must succeed (201 Created), and the other must be cleanly refused (400 Bad
 * Request: "This form has already been submitted"). The lead must be updated
 * exactly once without duplicate notes or multiple INTAKE_SUBMITTED events.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  request,
  drainEvents,
  createFirm,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod, type Gate } from '../support/gate';

const intakeFormsRepo = require('../../src/modules/leads/intakeForms.repository');
const eventBus = require('../../src/shared/events/eventBus');
const { INTAKE_SUBMITTED } = require('../../src/shared/events/eventTypes');

const visitor = () => request();
const submit = async (token: string, body: unknown) => visitor().post(`/api/intake/${token}/submit`).send(body as never);

let firm: Firm;
let gate: Gate | null = null;

const FIELDS = [
  { key: 'full_name', label: 'Full name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email', required: true },
  { key: 'phone', label: 'Phone', type: 'phone', required: false },
  { key: 'details', label: 'Details', type: 'textarea', required: false },
];

async function seedTargetedSubmission(lawFirmId: string, leadId?: string): Promise<{
  templateId: string;
  submissionId: string;
  token: string;
  leadId: string;
}> {
  const templateId = randomUUID();
  const publicToken = `pt-${randomUUID()}`;
  await testPool.query(
    `insert into intake_form_templates
       (id, law_firm_id, name, public_token, fields, is_active)
     values ($1, $2, 'Targeted Intake Form', $3, $4::jsonb, true)`,
    [templateId, lawFirmId, publicToken, JSON.stringify(FIELDS)],
  );

  let targetLeadId = leadId;
  if (!targetLeadId) {
    targetLeadId = randomUUID();
    await testPool.query(
      `insert into leads (id, law_firm_id, name, email, notes)
       values ($1, $2, 'Target Lead', 'target.lead@example.test', 'Original lead notes.')`,
      [targetLeadId, lawFirmId],
    );
  }

  const submissionId = randomUUID();
  const submissionToken = `sub-${randomUUID()}`;
  await testPool.query(
    `insert into intake_submissions
       (id, law_firm_id, intake_form_template_id, token, status, lead_id, sent_to_email)
     values ($1, $2, $3, $4, 'sent', $5, 'target.lead@example.test')`,
    [submissionId, lawFirmId, templateId, submissionToken, targetLeadId],
  );

  return { templateId, submissionId, token: submissionToken, leadId: targetLeadId };
}

async function getSubmission(id: string) {
  const { rows } = await testPool.query(
    'select * from intake_submissions where id = $1',
    [id],
  );
  return rows[0];
}

async function getLead(id: string) {
  const { rows } = await testPool.query(
    'select * from leads where id = $1',
    [id],
  );
  return rows[0];
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Intake Concurrency Firm' });
  await drainEvents();
});

afterEach(() => {
  gate?.restore();
  gate = null;
});

describe('targeted intake submission concurrency', () => {
  it('two simultaneous submissions of the SAME targeted token: exactly one succeeds, one is rejected', async () => {
    const { token, submissionId, leadId } = await seedTargetedSubmission(firm.id);

    const emittedEvents: any[] = [];
    const recordEvent = (evt: any) => {
      if (evt.submissionId === submissionId) {
        emittedEvents.push(evt);
      }
    };
    eventBus.on(INTAKE_SUBMITTED, recordEvent);

    try {
      // Gate on `getSubmissionByToken` so both requests resolve the open submission
      // concurrently before either begins the completion write.
      gate = gateMethod(intakeFormsRepo, 'getSubmissionByToken');

      const payloadA = {
        fieldValues: {
          full_name: 'Submitter A',
          email: 'target.lead@example.test',
          phone: '555-0101',
          details: 'Note from submitter A',
        },
      };

      const payloadB = {
        fieldValues: {
          full_name: 'Submitter B',
          email: 'target.lead@example.test',
          phone: '555-0202',
          details: 'Note from submitter B',
        },
      };

      const reqA = submit(token, payloadA);
      const reqB = submit(token, payloadB);

      // Verify both calls arrived at getSubmissionByToken simultaneously
      await gate.arrived(2, 20_000);
      gate.open();

      const [resA, resB] = await Promise.all([reqA, reqB]);
      await drainEvents();

      const statuses = [resA.status, resB.status];
      const succeeded = statuses.filter((s) => s === 201);
      const rejected = statuses.filter((s) => s === 400);

      // Exactly ONE submission must succeed, and the other must be cleanly refused
      expect(succeeded).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rejectedRes = resA.status === 400 ? resA : resB;
      expect(rejectedRes.body.error).toBe('This form has already been submitted');

      // The submission row must be completed
      const submission = await getSubmission(submissionId);
      expect(submission.status).toBe('completed');
      expect(submission.completed_at).toBeTruthy();

      // Exactly one INTAKE_SUBMITTED event should have been emitted
      expect(emittedEvents).toHaveLength(1);

      // The lead must have received notes exactly once (not duplicated)
      const lead = await getLead(leadId);
      const intakeHeaderCount = (lead.notes.match(/--- Intake ---/g) || []).length;
      expect(intakeHeaderCount).toBe(1);
    } finally {
      eventBus.removeListener(INTAKE_SUBMITTED, recordEvent);
    }
  });

  it('sequential retry of an already-completed targeted submission is rejected with 400', async () => {
    const { token, submissionId } = await seedTargetedSubmission(firm.id);

    const payload = {
      fieldValues: {
        full_name: 'Submitter Once',
        email: 'target.lead@example.test',
        phone: '555-0303',
        details: 'Initial submission',
      },
    };

    const first = await submit(token, payload);
    expect(first.status).toBe(201);

    const second = await submit(token, payload);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('This form has already been submitted');

    const sub = await getSubmission(submissionId);
    expect(sub.status).toBe('completed');
  });
});
