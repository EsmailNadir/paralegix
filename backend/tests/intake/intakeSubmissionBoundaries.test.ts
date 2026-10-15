/**
 * Unicode fidelity, character encoding, and input boundary tests for public intake forms.
 *
 * B10.3 requirements:
 * "Generic and targeted form tokens remain distinct. Targeted repeat submit,
 * template retirement, access-code validation, missing required declared fields,
 * unknown answers, Unicode, and field type/size boundaries."
 *
 * Covers:
 * 1. Unicode fidelity: non-Latin scripts (Cyrillic, CJK, Arabic RTL), accented Latin,
 *    and 4-byte UTF-8 emojis across all supported intake field types (text, textarea,
 *    select, phone, organization) for both generic and targeted paths.
 * 2. Verification that Unicode survives into intake_submissions.field_values and
 *    leads.name / leads.organization / leads.notes with zero corruption or encoding loss.
 * 3. Answer cleaning:
 *    - Optional field with whitespace-only or empty string (stored as null)
 *    - Undeclared fields (dropped, never written to lead notes or submission cleaned values)
 *
 * The size boundaries (token, key count, key length, answer length, each from
 * both sides) are pinned in `publicIntake.test.ts`.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  request,
  drainEvents,
  createFirm,
  type Firm,
} from '../support/setupInProcess';

const visitor = () => request();
const submit = (token: string, body: unknown) => visitor().post(`/api/intake/${token}/submit`).send(body as never);
const getForm = (token: string) => visitor().get(`/api/intake/${token}`);

let firm: Firm;

const UNICODE_FIELDS = [
  { key: 'full_name', label: 'Nom complet / 姓名', type: 'text', required: true },
  { key: 'email', label: 'Courriel', type: 'email', required: true },
  { key: 'phone', label: 'Téléphone', type: 'phone', required: false },
  { key: 'organization', label: 'Société / 公司', type: 'text', required: false },
  {
    key: 'category',
    label: 'Catégorie / 类别',
    type: 'select',
    required: true,
    options: ['Droit des affaires / 商业法', 'Litige civil / 民事诉讼', 'Propriété intellectuelle 💡'],
  },
  { key: 'details', label: 'Détails / 详细信息', type: 'textarea', required: false },
];

async function seedTemplate(
  lawFirmId: string,
  fields: unknown[] = UNICODE_FIELDS,
): Promise<{ id: string; publicToken: string }> {
  const id = randomUUID();
  const publicToken = `pt-${randomUUID()}`;
  const templateName = 'Cabinet d\'avocats Juridique ⚖️';
  await testPool.query(
    `insert into intake_form_templates
       (id, law_firm_id, name, public_token, fields, is_active)
     values ($1, $2, $3, $4, $5::jsonb, true)`,
    [id, lawFirmId, templateName, publicToken, JSON.stringify(fields)],
  );
  return { id, publicToken };
}

async function seedTargeted(
  lawFirmId: string,
  templateId: string,
  initialLead?: { name?: string; email?: string; notes?: string },
): Promise<{ submissionId: string; token: string; leadId: string }> {
  const leadId = randomUUID();
  await testPool.query(
    `insert into leads (id, law_firm_id, name, email, notes)
     values ($1, $2, $3, $4, $5)`,
    [
      leadId,
      lawFirmId,
      initialLead?.name || 'Client Initial',
      initialLead?.email || 'lead@example.test',
      initialLead?.notes || 'Notes initiales.',
    ],
  );

  const submissionId = randomUUID();
  const token = `sub-${randomUUID()}`;
  await testPool.query(
    `insert into intake_submissions
       (id, law_firm_id, intake_form_template_id, token, status, lead_id, sent_to_email)
     values ($1, $2, $3, $4, 'sent', $5, $6)`,
    [submissionId, lawFirmId, templateId, token, leadId, initialLead?.email || 'lead@example.test'],
  );

  return { submissionId, token, leadId };
}

async function getSubmission(id: string) {
  const { rows } = await testPool.query('select * from intake_submissions where id = $1', [id]);
  return rows[0];
}

async function getLead(id: string) {
  const { rows } = await testPool.query('select * from leads where id = $1', [id]);
  return rows[0];
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Étude Notariale & Avocats Associés' });
  await drainEvents();
});

describe('intake form Unicode fidelity', () => {
  it('preserves multi-lingual Unicode (CJK, Cyrillic, Arabic, accented Latin, emojis) in generic submissions', async () => {
    const { publicToken } = await seedTemplate(firm.id);

    const unicodeName = '李小龙 (Bruce Lee) / Владимир Смирнов / طارق بن زياد';
    const unicodeOrg = 'Société Générale 🌐 / 北京科技有限公司 🚀';
    const unicodeDetails = 'Besoin d\'assistance juridique urgente 🏛️⚖️. '
      + 'Contrat commercial international: 50 000 € d\'arrhes.\n'
      + '涉及知识产权维权及合同争议。\n'
      + 'القضية تتعلق بعقد تجاري دولي.';
    const selectedOption = 'Propriété intellectuelle 💡';

    const res = await submit(publicToken, {
      fieldValues: {
        full_name: unicodeName,
        email: 'multilingual.client@example.test',
        phone: '+33 1 42 68 00 00',
        organization: unicodeOrg,
        category: selectedOption,
        details: unicodeDetails,
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();

    // Verify submission row
    const submission = await getSubmission(res.body.id);
    expect(submission.field_values.full_name).toBe(unicodeName);
    expect(submission.field_values.organization).toBe(unicodeOrg);
    expect(submission.field_values.category).toBe(selectedOption);
    expect(submission.field_values.details).toBe(unicodeDetails);

    // Verify newly minted lead row
    expect(submission.lead_id).toBeTruthy();
    const lead = await getLead(submission.lead_id);
    expect(lead.name).toBe(unicodeName);
    expect(lead.organization).toBe(unicodeOrg);
    expect(lead.notes).toContain(unicodeDetails);
    expect(lead.notes).toContain('Détails / 详细信息');
  });

  it('preserves Unicode and appends non-Latin notes faithfully in targeted submissions', async () => {
    const { id: templateId } = await seedTemplate(firm.id);
    const initialNotes = 'Dossier ouvert le 01/09/2026. Priorité haute ⚠️.';
    const { token, submissionId, leadId } = await seedTargeted(firm.id, templateId, {
      name: 'José-Maria de Heredia',
      email: 'jm.heredia@example.test',
      notes: initialNotes,
    });

    const targetedDetails = 'Mise à jour des statuts: ajout de la filiale japonaise (株式会社東京).\n'
      + 'Toutes les clauses sont validées par Me François 🖋️.';

    const res = await submit(token, {
      fieldValues: {
        full_name: 'José-Maria de Heredia',
        email: 'jm.heredia@example.test',
        category: 'Droit des affaires / 商业法',
        organization: 'Éditions Lemerre & Cie',
        details: targetedDetails,
      },
    });

    expect(res.status).toBe(201);

    const submission = await getSubmission(submissionId);
    expect(submission.status).toBe('completed');
    expect(submission.field_values.details).toBe(targetedDetails);

    const lead = await getLead(leadId);
    // Preserves original notes and appends new intake section with full Unicode
    expect(lead.notes).toContain(initialNotes);
    expect(lead.notes).toContain('--- Intake ---');
    expect(lead.notes).toContain(targetedDetails);
    expect(lead.organization).toBe('Éditions Lemerre & Cie');
  });

  it('serves Unicode template name and field options via GET /:token', async () => {
    const { publicToken } = await seedTemplate(firm.id);

    const res = await getForm(publicToken);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Cabinet d\'avocats Juridique ⚖️');
    expect(res.body.lawFirmName).toBe('Étude Notariale & Avocats Associés');

    const catField = res.body.fields.find((f: any) => f.key === 'category');
    expect(catField.options).toEqual([
      'Droit des affaires / 商业法',
      'Litige civil / 民事诉讼',
      'Propriété intellectuelle 💡',
    ]);
  });
});

describe('intake answer cleaning', () => {
  it('cleans whitespace-only and empty string answers on optional fields to null', async () => {
    const { publicToken } = await seedTemplate(firm.id);

    const res = await submit(publicToken, {
      fieldValues: {
        full_name: 'Valid Name',
        email: 'valid@example.test',
        category: 'Litige civil / 民事诉讼',
        phone: '   ',
        organization: '',
        details: null,
      },
    });

    expect(res.status).toBe(201);
    const submission = await getSubmission(res.body.id);
    expect(submission.field_values.phone).toBeNull();
    expect(submission.field_values.organization).toBeNull();
    expect(submission.field_values.details).toBeNull();
  });

  it('ignores undeclared keys so they do not leak into cleaned answers or lead notes', async () => {
    const { publicToken } = await seedTemplate(firm.id);

    const res = await submit(publicToken, {
      fieldValues: {
        full_name: 'Attentive Applicant',
        email: 'applicant@example.test',
        category: 'Litige civil / 民事诉讼',
        undeclared_secret_key: 'confidential_payload',
        internal_score: '99',
      },
    });

    expect(res.status).toBe(201);
    const submission = await getSubmission(res.body.id);
    expect(submission.field_values.undeclared_secret_key).toBeUndefined();
    expect(submission.field_values.internal_score).toBeUndefined();

    const lead = await getLead(submission.lead_id);
    expect(lead.notes).toBeNull();
  });
});
