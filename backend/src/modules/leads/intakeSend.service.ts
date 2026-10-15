const intakeFormsRepo = require('./intakeForms.repository');
const leadsRepo = require('./leads.repository');
const lawfirmsRepo = require('../lawfirms/lawfirms.repository');
const { assertLawFirmMembership } = require('../../shared/utils/membership');
const { AppError, NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const { normalizeEmail } = require('../../shared/utils/normalizeEmail');
const eventBus = require('../../shared/events/eventBus');
const { INTAKE_SENT } = require('../../shared/events/eventTypes');
const { sendIntakeFormEmail } = require('../../shared/services/emailService');

const APP_URL = (process.env.APP_URL || 'https://paralegix.com').replace(/\/+$/, '');

export async function sendIntakeForm({
  lawFirmId, leadId, intakeFormTemplateId, email, sentByUserId,
}: any) {
  await assertLawFirmMembership(lawFirmId, sentByUserId);

  const lead = await leadsRepo.getById(lawFirmId, leadId);
  if (!lead) throw new NotFoundError('Lead');

  const template = await intakeFormsRepo.getTemplateById(lawFirmId, intakeFormTemplateId);
  if (!template) throw new NotFoundError('Intake form');
  if (!template.isActive) throw new ValidationError('This intake form is inactive');

  const toEmail = normalizeEmail(email) || normalizeEmail(lead.email);
  if (!toEmail) {
    throw new ValidationError({ email: ['An email address is required to send the intake form'] });
  }

  // Resend: reuse an uncompleted submission for the same lead+template.
  let submission = await intakeFormsRepo.findOpenSubmissionForLeadTemplate(
    lawFirmId, leadId, intakeFormTemplateId,
  );

  if (!submission) {
    submission = await intakeFormsRepo.createSubmission(lawFirmId, {
      intakeFormTemplateId,
      token: intakeFormsRepo.mintToken(),
      status: 'sent',
      deliveryStatus: 'pending',
      leadId,
      sentToEmail: toEmail,
      sentBy: sentByUserId,
    });
  }

  // A resend to the same person retains their link. A replacement recipient's
  // new token becomes authoritative only after the provider accepts the email.
  const replacementRecipient = normalizeEmail(submission.sentToEmail) !== toEmail;
  const token = replacementRecipient ? intakeFormsRepo.mintToken() : submission.token;

  const firm = await lawfirmsRepo.findById(lawFirmId);
  const firmName = firm?.name || 'Your law firm';
  const link = `${APP_URL}/intake/${token}`;

  const result = await sendIntakeFormEmail({
    to: toEmail,
    firmName,
    formName: template.name,
    recipientName: lead.name,
    link,
    lawFirmId,
  });

  if (!result.sent) {
    // A submission already delivered keeps its status: the earlier email and
    // its link still work, so one failed extra attempt does not undo that.
    if (submission.deliveryStatus !== 'sent') {
      await intakeFormsRepo.updateSubmission(lawFirmId, submission.id, { deliveryStatus: 'failed' });
    }
    if (result.throttled) {
      throw new AppError(
        'The email limit for this recipient has been reached. Try again later.', 429, 'INTAKE_DELIVERY_FAILED',
      );
    }
    if (result.notConfigured) {
      throw new AppError(
        'Email delivery is not configured on this server, so the intake email was not sent.',
        503, 'EMAIL_NOT_CONFIGURED',
      );
    }
    throw new AppError('The intake email could not be sent. Please try again.', 503, 'INTAKE_DELIVERY_FAILED');
  }

  submission = await intakeFormsRepo.updateSubmission(lawFirmId, submission.id, {
    token,
    sentToEmail: toEmail,
    sentBy: sentByUserId,
    sentAt: new Date(),
    deliveryStatus: 'sent',
    ...(replacementRecipient ? { openedAt: null } : {}),
  });

  eventBus.emit(INTAKE_SENT, {
    lawFirmId,
    leadId,
    submissionId: submission.id,
    templateId: intakeFormTemplateId,
    sentByUserId,
  });

  return {
    message: 'Intake form sent successfully',
    submission,
  };
}
