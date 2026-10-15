const crypto = require('crypto');
const intakeFormsRepo = require('../leads/intakeForms.repository');
const leadsRepo = require('../leads/leads.repository');
const leadStagesRepo = require('../leads/stages/leadStages.repository');
const lawfirmsRepo = require('../lawfirms/lawfirms.repository');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../shared/errors/AppError');
const { normalizeEmail } = require('../../shared/utils/normalizeEmail');
const eventBus = require('../../shared/events/eventBus');
const { INTAKE_SUBMITTED } = require('../../shared/events/eventTypes');

function hashesEqual(a: any, b: any) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function formPayload(template: any, submission: any, lead: any, lawFirmName: any) {
  return {
    name: template.name,
    lawFirmName: lawFirmName || null,
    fields: template.fields || [],
    prefill: submission
      ? {
          name: lead?.name || null,
          email: submission.sentToEmail || lead?.email || null,
        }
      : null,
  };
}

/**
 * Resolve a public intake token against either a pre-created submission
 * (targeted send) or a template public_token (generic embed). Submissions
 * win when both could match, since that token space is per-recipient.
 */
export async function resolveToken(token: any) {
  if (!token || typeof token !== 'string') return null;

  const submission = await intakeFormsRepo.getSubmissionByToken(token);
  if (submission) {
    const template = await intakeFormsRepo.getTemplateById(
      submission.lawFirmId,
      submission.intakeFormTemplateId,
      { includeAccessCodeHash: true },
    );
    if (!template) return null;
    let lead = null;
    if (submission.leadId) {
      lead = await leadsRepo.getById(submission.lawFirmId, submission.leadId);
    }
    return { template, submission, lead, kind: 'submission' as const };
  }

  const template = await intakeFormsRepo.getTemplateByPublicToken(token);
  if (!template || !template.isActive) return null;
  return { template, submission: null, lead: null, kind: 'template' as const };
}

export async function getIntakeForm(token: any) {
  const resolved = await resolveToken(token);
  if (!resolved) throw new NotFoundError('Intake form');

  const { template, submission, lead } = resolved;
  const lawFirm = await lawfirmsRepo.findById(template.lawFirmId);
  const lawFirmName = lawFirm?.name || null;

  if (submission && submission.status === 'completed') {
    return { alreadyCompleted: true, name: template.name, lawFirmName };
  }

  // Do not stamp opened_at until the recipient can actually see the form.
  // Access-code-gated templates mark opened only after a successful verify.
  if (template.accessCodeHash) {
    return { requiresAccessCode: true, name: template.name, lawFirmName };
  }

  if (submission && !submission.openedAt) {
    await intakeFormsRepo.markOpened(submission.lawFirmId, submission.id);
  }

  return formPayload(template, submission, lead, lawFirmName);
}

export async function verifyAccessCode({ token, code }: any) {
  if (!code || typeof code !== 'string') {
    throw new ValidationError('Access code is required');
  }

  const resolved = await resolveToken(token);
  if (!resolved) throw new NotFoundError('Intake form');

  const { template, submission, lead } = resolved;
  if (!template.accessCodeHash) {
    throw new ValidationError('This form does not require an access code');
  }

  const submittedHash = intakeFormsRepo.hashAccessCode(code.trim());
  if (!hashesEqual(submittedHash, template.accessCodeHash)) {
    throw new ForbiddenError('Incorrect access code');
  }

  const lawFirm = await lawfirmsRepo.findById(template.lawFirmId);
  const lawFirmName = lawFirm?.name || null;

  // Return the unlocked form payload so the client can render without a
  // second round-trip.
  //
  // Brute-force control is `intakeGateLimiter`, which is keyed on the form TOKEN
  // at 5/min, not on the caller's address: an address-keyed cap is defeated by
  // rotating addresses, which is the whole attack. There is deliberately no
  // durable lock like signing's. Signing's counter lives on
  // `signature_participants`, so locking one participant denies one person;
  // this code lives on the TEMPLATE and is shared by every recipient, so a
  // durable lock would let a stranger hard-lock a firm's whole lead pipeline.
  // If one is ever wanted, it belongs on `intake_submissions`, the true
  // per-recipient analogue. The access code itself now has an 8 character
  // minimum, because no rate limit a real prospect will tolerate defends a
  // 4 digit code.
  if (submission && submission.status === 'completed') {
    return { verified: true, alreadyCompleted: true, name: template.name, lawFirmName };
  }
  if (submission && !submission.openedAt) {
    await intakeFormsRepo.markOpened(submission.lawFirmId, submission.id);
  }
  return { verified: true, ...formPayload(template, submission, lead, lawFirmName) };
}

function validateFieldValues(fields: any[], fieldValues: any) {
  const values = fieldValues && typeof fieldValues === 'object' ? fieldValues : {};
  const errors: Record<string, string[]> = {};
  const cleaned: Record<string, any> = {};

  for (const field of fields || []) {
    const key = field.key;
    if (!key) continue;
    const raw = values[key];
    const str = raw == null ? '' : String(raw).trim();

    if (field.required && !str) {
      errors[key] = [`${field.label || key} is required`];
      continue;
    }
    if (!str) {
      cleaned[key] = null;
      continue;
    }

    if (field.type === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)) {
        errors[key] = ['Enter a valid email address'];
        continue;
      }
    }
    if (field.type === 'select' && Array.isArray(field.options) && field.options.length) {
      if (!field.options.includes(str)) {
        errors[key] = ['Choose one of the available options'];
        continue;
      }
    }
    cleaned[key] = str;
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return cleaned;
}

function pickLeadFieldsFromValues(fieldValues: any, fields: any[] = []) {
  // Prefer well-known keys, then fall back to the first field of each type.
  const byType = (type: string) => {
    const def = (fields || []).find((f: any) => f.type === type && fieldValues?.[f.key]);
    return def ? String(fieldValues[def.key]).trim() : null;
  };

  const email = normalizeEmail(fieldValues.email)
    || normalizeEmail(byType('email'))
    || null;
  const name = (fieldValues.name || fieldValues.full_name || '').trim()
    || byType('text')
    || null;
  const phone = (fieldValues.phone || fieldValues.phone_number || '').trim()
    || byType('phone')
    || null;
  const organization = (fieldValues.organization || fieldValues.company || '').trim() || null;
  const notesParts = [];
  if (fieldValues.notes) notesParts.push(String(fieldValues.notes));
  if (fieldValues.message) notesParts.push(String(fieldValues.message));
  // Capture remaining text/textarea answers into notes so nothing is lost.
  for (const field of fields || []) {
    if (!field?.key) continue;
    if (['name', 'full_name', 'email', 'phone', 'phone_number', 'organization', 'company', 'notes', 'message'].includes(field.key)) continue;
    if (field.type !== 'text' && field.type !== 'textarea') continue;
    const val = fieldValues[field.key];
    if (val == null || String(val).trim() === '') continue;
    notesParts.push(`${field.label || field.key}: ${String(val).trim()}`);
  }
  return {
    email,
    name,
    phone,
    organization,
    notes: notesParts.length ? notesParts.join('\n\n') : null,
  };
}

/**
 * Apply submitted values onto an existing lead — only fill blanks so a
 * targeted send doesn't overwrite firm-entered data with empty answers.
 */
async function applyValuesToLead(lawFirmId: string, leadId: string, fieldValues: any, fields: any[] = []) {
  const lead = await leadsRepo.getById(lawFirmId, leadId);
  if (!lead) return null;
  const picked = pickLeadFieldsFromValues(fieldValues, fields);
  const updates: Record<string, any> = {};
  if (!lead.email && picked.email) updates.email = picked.email;
  if (!lead.phone && picked.phone) updates.phone = picked.phone;
  if (!lead.organization && picked.organization) updates.organization = picked.organization;
  if (picked.notes) {
    updates.notes = lead.notes
      ? `${lead.notes}\n\n--- Intake ---\n${picked.notes}`
      : picked.notes;
  }
  if (!Object.keys(updates).length) return lead;
  return leadsRepo.update(lawFirmId, leadId, updates);
}

export async function submitIntake({ token, fieldValues, accessCode, ip }: any) {
  const resolved = await resolveToken(token);
  if (!resolved) throw new NotFoundError('Intake form');

  const { template, submission } = resolved;
  if (!template.isActive && !submission) {
    throw new NotFoundError('Intake form');
  }

  if (template.accessCodeHash) {
    if (!accessCode || typeof accessCode !== 'string') {
      throw new ValidationError({ accessCode: ['Access code is required'] });
    }
    const submittedHash = intakeFormsRepo.hashAccessCode(accessCode.trim());
    if (!hashesEqual(submittedHash, template.accessCodeHash)) {
      throw new ForbiddenError('Incorrect access code');
    }
  }

  if (submission && submission.status === 'completed') {
    throw new ValidationError('This form has already been submitted');
  }

  const cleaned = validateFieldValues(template.fields || [], fieldValues);
  const lawFirmId = template.lawFirmId;
  const now = new Date();

  if (submission) {
    // Targeted send: atomically claim and complete the submission row where status is still 'sent'.
    // If two requests race on the same token, exactly one transitions the status; the other receives
    // null and is refused with a clean 400.
    const updated = await intakeFormsRepo.claimAndCompleteSubmission(lawFirmId, submission.id, {
      fieldValues: cleaned,
      status: 'completed',
      completedAt: now,
      submittedIp: ip || null,
    });
    if (!updated) {
      throw new ValidationError('This form has already been submitted');
    }
    if (submission.leadId) {
      await applyValuesToLead(lawFirmId, submission.leadId, cleaned, template.fields || []);
    }
    eventBus.emit(INTAKE_SUBMITTED, {
      lawFirmId, leadId: submission.leadId || null, submissionId: updated.id,
      templateName: template.name, isNewLead: false,
    });
    return updated;
  }

  // Generic embed: find-or-create lead by email, then insert a completed submission.
  const picked = pickLeadFieldsFromValues(cleaned, template.fields || []);
  if (!picked.email) {
    throw new ValidationError({ email: ['An email address is required'] });
  }

  let lead = await leadsRepo.findByEmail(lawFirmId, picked.email);
  let isNewLead = false;
  if (!lead) {
    const defaultStage = await leadStagesRepo.getDefaultOpenStage(lawFirmId);
    lead = await leadsRepo.create(lawFirmId, {
      name: picked.name || picked.email,
      email: picked.email,
      phone: picked.phone,
      organization: picked.organization,
      notes: picked.notes,
      stageId: defaultStage?.id || null,
    });
    isNewLead = true;
  } else {
    await applyValuesToLead(lawFirmId, lead.id, cleaned, template.fields || []);
  }

  const created = await intakeFormsRepo.createSubmission(lawFirmId, {
    intakeFormTemplateId: template.id,
    token: intakeFormsRepo.mintToken(),
    fieldValues: cleaned,
    status: 'completed',
    leadId: lead.id,
    sentToEmail: picked.email,
    completedAt: now,
    submittedIp: ip || null,
  });

  eventBus.emit(INTAKE_SUBMITTED, {
    lawFirmId, leadId: lead.id, submissionId: created.id,
    templateName: template.name, leadName: lead.name, isNewLead,
  });

  return created;
}
