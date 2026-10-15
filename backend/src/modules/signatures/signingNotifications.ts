const {
  privilegedParameterizedQuery,
  rootQueryExecutor,
} = require('../../shared/database/queryContext');
const { sendEmail } = require('../../shared/services/emailService');
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');
import { createBoundedCache } from '../../shared/utils/boundedCache';

const signatureSql = (executor: any, text: string, params: unknown[] = []) => privilegedParameterizedQuery(
  'signature notification access is scoped by session, client, or firm identity',
  text,
  params,
  executor,
);

/**
 * Signed-copy emails in flight at once. Capped tight because each send carries
 * the whole signed PDF and base64-encodes its own copy of the buffer, so the
 * multiplier is participants x document size against container memory — and
 * because the SMTP relay is a single shared connection budget that a fifteen
 * party signing session would otherwise take over on its own.
 */
const SIGNED_COPY_EMAIL_CONCURRENCY = Number(process.env.SIGNED_COPY_EMAIL_CONCURRENCY) || 2;

// Origin used to build client-facing signing links. Falls back to FRONTEND_URL
// (set in every environment, including local dev) before the production default,
// so a deployment that only configures FRONTEND_URL still produces links that
// point at the actual app rather than production.
export const APP_URL = process.env.APP_URL || process.env.FRONTEND_URL || 'https://paralegix.com';

/** Where a logged-in portal client opens the documents waiting for their signature. */
export function portalSigningUrl(lawFirmId: string) {
  return `${APP_URL}/client/lawfirm/${lawFirmId}/signatures`;
}

/**
 * Post a system notice into a client's direct conversation with the firm.
 *
 * Goes through the messaging repository's `sendMessage`, so the conversation
 * is created or reopened (an archived thread is unarchived) and its
 * last-message fields are set exactly as for any other message. The sender is
 * nobody (`sender_user_id` null, shown as 'Paralegix'), which is what keeps the
 * notice out of every edit and delete path: those require the caller to be the
 * message's sender.
 */
export async function postFirmMessageToClient(lawFirmId: string, clientUserId: string, content: string, attachments: any[] = []) {
  const msgRepo = require('../messaging/messaging.repository');
  const eventBus = require('../../shared/events/eventBus');
  const { MESSAGE_SENT } = require('../../shared/events/eventTypes');

  const result = await msgRepo.sendMessage(lawFirmId, {
    senderId: null,
    senderType: 'firm_member',
    senderName: 'Paralegix',
    sentAsFirm: false,
    clientId: clientUserId,
    clientData: {},
    content,
    attachments,
    matterId: null,
  });

  eventBus.emit(MESSAGE_SENT, {
    lawFirmId,
    conversationId: result.conversationId,
    conversationType: 'direct',
    messageId: result.messageId,
    senderId: null,
    senderType: 'firm_member',
    senderName: 'Paralegix',
    clientName: result.clientName || '',
    matterId: null,
    mentions: [],
    messageRecipients: [],
    preview: content.trim().substring(0, 100),
  });

  return result;
}

export function escapeHtml(str: any) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The ESIGN Act / UETA electronic-signature consent statement. Single source of
// truth. Used both at completion (recorded against the participant) and on the
// generated Signature Certificate page.
export function buildConsentStatement(consentName: any) {
  return `I, ${consentName}, confirm that I am the individual named above, have reviewed this document in full, and consent to use an electronic signature. I understand that my electronic signature has the same legal effect as a handwritten signature and that I am signing voluntarily and without coercion. I acknowledge that this document may be executed and stored electronically in accordance with the ESIGN Act and the Uniform Electronic Transactions Act (UETA), and that my signature may be authenticated through electronic records including IP address, timestamp, and email address. I understand that I may request a paper copy of this document, and that I may withdraw my consent to sign electronically at any time before completing my signature, in either case at no cost to me. I confirm that I am able to access these records, which requires a current web browser and the ability to view and save PDF files.`;
}

// Shared transactional-email card shell. `accentGradient` colors the top bar and
// `eyebrow` is the small uppercase label under the wordmark.
function renderEmailCard({ accentGradient, eyebrow, bodyHtml, footerText }: any) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
  <tr><td style="height:4px;background:${accentGradient};"></td></tr>
  <tr><td style="padding:40px 40px 0;">
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;">Paralegix</h1>
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">${eyebrow}</p>
  </td></tr>
  <tr><td style="padding:0 40px 32px;">
    ${bodyHtml}
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">${footerText}</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * Notify the sender that a document was signed (final signature collected),
 * with the signed PDF attached. Shared by the v1 and v2 completion paths.
 * `variant: 'final'` reads "completed the final signature on"; otherwise "has signed".
 */
export async function sendDocumentSignedEmail({
  to,
  signerName,
  fileName,
  signedFileName,
  attachmentBuffer,
  variant = 'signed',
}: any) {
  if (!to) return { sent: false };

  const safeSignerName = escapeHtml(signerName);
  const safeDocName = escapeHtml(fileName);
  const safeSignedDocName = escapeHtml(signedFileName);
  const subject = `Document signed: ${fileName}`;
  const action = variant === 'final'
    ? `completed the final signature on <strong>${safeDocName}</strong>`
    : `has signed <strong>${safeDocName}</strong>`;
  const actionText = variant === 'final'
    ? `${signerName} completed the final signature on ${fileName}.`
    : `${signerName} has signed ${fileName}.`;

  // The copy has to describe what was actually sent. A document too large to
  // attach still produces this notification, and telling the sender to look for
  // an attachment that is not there sends them hunting for a delivery failure
  // that did not happen.
  const bodyHtml = attachmentBuffer
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;"><strong>${safeSignerName}</strong> ${action}.</p>
    <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#6b7280;">The signed document is attached to this email and has also been saved automatically in Paralegix.</p>
    <p style="margin:0;font-size:13px;line-height:1.6;color:#9ca3af;">Attachment: <strong>${safeSignedDocName}</strong></p>`
    : `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;"><strong>${safeSignerName}</strong> ${action}.</p>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#6b7280;">The signed document has been saved automatically in Paralegix, where you can open <strong>${safeSignedDocName}</strong>.</p>`;

  const html = renderEmailCard({
    accentGradient: 'linear-gradient(90deg,#059669,#10b981)',
    eyebrow: 'DOCUMENT SIGNED',
    bodyHtml,
    footerText: 'This notification was sent by Paralegix.',
  });

  const text = attachmentBuffer
    ? [
      subject,
      '',
      `${actionText}`,
      '',
      `Attached: ${signedFileName}`,
      '',
      'The signed document has been attached to this email and saved automatically in Paralegix.',
    ].join('\n')
    : [
      subject,
      '',
      `${actionText}`,
      '',
      `The signed document (${signedFileName}) has been saved automatically in Paralegix.`,
    ].join('\n');

  return sendEmail({
    to,
    subject,
    html,
    text,
    attachments: attachmentBuffer
      ? [{ filename: signedFileName, content: attachmentBuffer.toString('base64') }]
      : undefined,
  });
}

/**
 * Email each signer a copy of the fully signed document. Only called when the
 * sender opted in at session creation (email_signers_on_complete). Failures
 * are logged per recipient and never thrown.
 */
export async function sendSignedCopyToSigners({ participants, fileName, signedFileName, attachmentBuffer, downloadUrl = null, replyTo }: any) {
  const seen = new Set();
  const recipients = (participants || []).filter((p: any) => {
    const email = (p.email || '').trim().toLowerCase();
    if (!email || seen.has(email)) return false;
    seen.add(email);
    return true;
  });
  // Nothing to hand over is not a message worth sending: an email announcing a
  // copy it neither attaches nor links to leaves the signer with no way to get
  // the document and no idea that anything is missing.
  if (recipients.length === 0) return { sent: true };
  if (!attachmentBuffer && !downloadUrl) return { sent: false };

  // A link names ONE recipient, so a call carrying one must address one. Sending
  // it to a group would hand every signer a capability minted for somebody else.
  if (downloadUrl && recipients.length > 1) {
    console.error('[signing] Refusing to send one download link to several signers');
    return { sent: false };
  }

  const safeDocName = escapeHtml(fileName);
  const safeSignedDocName = escapeHtml(signedFileName);
  const subject = `Your signed copy: ${fileName}`;

  const results = await runWithConcurrency(recipients.map((p: any) => () => {
    const recipientName = p.name || 'there';
    const safeRecipientName = escapeHtml(recipientName);
    const delivery = attachmentBuffer
      ? `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#6b7280;">All parties have signed <strong>${safeDocName}</strong>. Your copy of the completed document is attached to this email.</p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#9ca3af;">Attachment: <strong>${safeSignedDocName}</strong></p>`
      : `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#6b7280;">All parties have signed <strong>${safeDocName}</strong>. Your copy is too large to attach, so it is waiting for you here.</p>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;"><a href="${escapeHtml(downloadUrl)}" style="color:#059669;font-weight:600;">Download ${safeSignedDocName}</a></p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#9ca3af;">This link is for you alone and stops working after seven days.</p>`;
    const bodyHtml = `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi <strong>${safeRecipientName}</strong>,</p>
      ${delivery}`;

    const html = renderEmailCard({
      accentGradient: 'linear-gradient(90deg,#059669,#10b981)',
      eyebrow: 'SIGNING COMPLETE',
      bodyHtml,
      footerText: 'This notification was sent by Paralegix.',
    });

    const text = attachmentBuffer
      ? [
        subject,
        '',
        `Hi ${recipientName},`,
        '',
        `All parties have signed ${fileName}. Your copy of the completed document is attached.`,
        '',
        `Attached: ${signedFileName}`,
      ].join('\n')
      : [
        subject,
        '',
        `Hi ${recipientName},`,
        '',
        `All parties have signed ${fileName}. Your copy is too large to attach, so download it here:`,
        '',
        downloadUrl,
        '',
        'This link is for you alone and stops working after seven days.',
      ].join('\n');

    return sendEmail({
      to: p.email,
      subject,
      html,
      text,
      replyTo,
      attachments: attachmentBuffer
        ? [{ filename: signedFileName, content: attachmentBuffer.toString('base64') }]
        : undefined,
    }).catch((err: any) => console.error('[signing] Signed-copy email failed for', p.email, err.message));
  }), SIGNED_COPY_EMAIL_CONCURRENCY);
  return { sent: results.every((result: PromiseSettledResult<{ sent: boolean } | void>) => result.status === 'fulfilled' && result.value?.sent === true) };
}

/** Notify the sender that a signer declined to sign (session closed). */
export async function sendSigningDeclinedEmail({ to, signerName, fileName, reason }: any) {
  if (!to) return { sent: false };

  const safeSignerName = escapeHtml(signerName || 'A signer');
  const safeDocName = escapeHtml(fileName);
  const safeReason = reason ? escapeHtml(reason) : null;
  const subject = `Signing declined: ${fileName}`;
  const reasonParagraph = safeReason
    ? `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#6b7280;">Reason: ${safeReason}</p>`
    : '';

  const bodyHtml = `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;"><strong>${safeSignerName}</strong> declined to sign <strong>${safeDocName}</strong>.</p>
    ${reasonParagraph}
    <p style="margin:0;font-size:14px;line-height:1.6;color:#6b7280;">This signing request has been closed. You can start a new request if needed.</p>`;

  const html = renderEmailCard({
    accentGradient: 'linear-gradient(90deg,#dc2626,#ef4444)',
    eyebrow: 'SIGNING DECLINED',
    bodyHtml,
    footerText: 'This notification was sent by Paralegix.',
  });

  const text = [
    subject,
    '',
    `${signerName || 'A signer'} declined to sign ${fileName}.`,
    ...(reason ? ['', `Reason: ${reason}`] : []),
    '',
    'This signing request has been closed.',
  ].join('\n');

  return sendEmail({ to, subject, html, text });
}

// Small TTL cache: firm names rarely change, and getLawFirmName is called once
// per reminder/notification (the reminder cron would otherwise re-query law_firms
// for every session in the batch).
// One entry per firm, previously bounded only by a TTL that never fired for a
// firm that did not send another signature.
const _firmNameCache = createBoundedCache<string>({
  name: 'signingFirmName',
  maxEntries: 2000,
  ttlMs: 5 * 60 * 1000,
});
export async function getLawFirmName(lawFirmId: string) {
  if (!lawFirmId) return 'your law firm';
  const cached = _firmNameCache.get(lawFirmId);
  if (cached !== undefined) return cached;
  let name = 'your law firm';
  try {
    const { rows } = await signatureSql(rootQueryExecutor, `select name from law_firms where id = $1 limit 1`, [lawFirmId]);
    if (rows[0]?.name) name = rows[0].name;
  } catch {
    // fall through to default
  }
  _firmNameCache.set(lawFirmId, name);
  return name;
}

export async function loadSenderProfile(reqUser: any) {
  let profileEmail = reqUser?.email || null;
  let profileName = reqUser?.name || null;

  if (!profileEmail || !profileName) {
    try {
      const { rows } = await signatureSql(rootQueryExecutor, `select name, email from users where id = $1 limit 1`, [reqUser.uid]);
      if (rows[0]) {
        if (!profileEmail) profileEmail = rows[0].email || null;
        if (!profileName) profileName = rows[0].name || null;
      }
    } catch {
      // use what we have
    }
  }

  return {
    senderName: profileName || profileEmail || 'Someone',
    senderEmail: profileEmail || null,
  };
}

export async function sendSigningInviteEmail({
  to,
  recipientName,
  senderName,
  lawFirmName,
  fileName,
  signingLink,
  message,
  replyTo,
  roleLabel,
}: any) {
  if (!to) return { sent: false };

  const safeName = escapeHtml(recipientName || 'there');
  const safeFileName = escapeHtml(fileName);
  const safeSenderName = escapeHtml(senderName);
  const safeLawFirmName = escapeHtml(lawFirmName);
  const safeRole = roleLabel ? escapeHtml(roleLabel) : null;
  const safeMessage = message ? escapeHtml(message) : null;
  const subject = `${senderName} sent you a document to sign`;

  const roleCopy = safeRole ? ` as ${safeRole}` : '';
  const messageParagraph = safeMessage
    ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#6b7280;">${safeMessage}</p>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
  <tr><td style="height:4px;background:linear-gradient(90deg,#4f46e5,#6366f1);"></td></tr>
  <tr><td style="padding:40px 40px 0;">
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;">Paralegix</h1>
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">DOCUMENT SIGNING REQUEST</p>
  </td></tr>
  <tr><td style="padding:0 40px;">
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi ${safeName},</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${safeSenderName} from ${safeLawFirmName} has sent you a document to sign${roleCopy}: <strong>${safeFileName}</strong></p>
    ${messageParagraph}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
    <tr><td style="border-radius:8px;background-color:#4f46e5;">
      <a href="${escapeHtml(signingLink)}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Sign Document</a>
    </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This email was sent by ${safeLawFirmName} via Paralegix. If you did not expect this email, you can safely ignore it.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const textLines = [
    subject,
    '',
    `Hi ${recipientName || 'there'},`,
    '',
    `${senderName} from ${lawFirmName} has sent you a document to sign${roleLabel ? ` as ${roleLabel}` : ''}: ${fileName}`,
    ...(message ? ['', message] : []),
    '',
    `Sign Document: ${signingLink}`,
    '',
    '---',
    `This email was sent by ${lawFirmName} via Paralegix.`,
  ];

  return sendEmail({
    to,
    subject,
    html,
    text: textLines.join('\n'),
    replyTo: replyTo || undefined,
    fromName: senderName,
  });
}

// clientId here is always participant.clientUserId - a Firebase uid (the
// signature_participants.client_user_id column), never a clients.id - and it
// flows straight into postFirmMessageToClient's own clientUserId param, so
// name it that way rather than the generic "clientId".
//
// The message links to the portal's own signing page, never to a
// `/signature?token=` URL. A participant token is a bearer credential that
// signs without logging in, and a conversation is readable by more than its
// signer (firm members, and a co-client added later with history visible).
// The portal page lists the request only to the logged-in client it is bound to.
//
// `reminder` swaps the opening line for the reminder copy the caller supplies
// in `message` (which carries any "expiring soon" wording). On a first request
// `message` is the sender's own note and follows the opening line.
async function sendPortalSigningMessage({
  lawFirmId,
  clientUserId,
  fileName,
  roleLabel,
  message,
  reminder = false,
}: any) {
  if (!lawFirmId || !clientUserId) return { sent: false };

  const role = roleLabel ? ` as ${roleLabel}` : '';
  const note = typeof message === 'string' ? message.trim() : '';
  const opening = reminder
    ? (note || `Reminder: your signature is still needed on "${fileName}"${role}.`)
    : `Please sign "${fileName}"${role}.`;
  const body = !reminder && note ? `\n\n${note}` : '';
  const messageContent = `${opening}${body}\n\n[Review and sign](${portalSigningUrl(lawFirmId)})`;

  await postFirmMessageToClient(lawFirmId, clientUserId, messageContent);
  return { sent: true };
}

async function sendPortalStatusMessage({
  lawFirmId,
  clientUserId,
  content,
}: any) {
  if (!lawFirmId || !clientUserId || !content) return { sent: false };

  // No separate preview any more. The conversation list derives its own from
  // the newest message, so a caller that wanted a shorter summary line than the
  // message body no longer has anywhere to put one, and the body IS the summary.
  await postFirmMessageToClient(lawFirmId, clientUserId, content);
  return { sent: true };
}

export async function sendSigningCancelledEmail({
  to,
  recipientName,
  senderName,
  lawFirmName,
  fileName,
  roleLabel,
  replyTo,
}: any) {
  if (!to) return { sent: false };

  const safeName = escapeHtml(recipientName || 'there');
  const safeFileName = escapeHtml(fileName);
  const safeSenderName = escapeHtml(senderName);
  const safeLawFirmName = escapeHtml(lawFirmName);
  const safeRole = roleLabel ? escapeHtml(roleLabel) : null;
  const subject = `Signing cancelled: ${fileName}`;

  const roleCopy = safeRole ? ` for ${safeRole}` : '';
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
  <tr><td style="height:4px;background:linear-gradient(90deg,#dc2626,#ef4444);"></td></tr>
  <tr><td style="padding:40px 40px 0;">
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;">Paralegix</h1>
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">SIGNING CANCELLED</p>
  </td></tr>
  <tr><td style="padding:0 40px 32px;">
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi ${safeName},</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${safeSenderName} from ${safeLawFirmName} has cancelled the signing request for <strong>${safeFileName}</strong>${roleCopy}.</p>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#6b7280;">You do not need to take any further action unless you receive a new request.</p>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This email was sent by ${safeLawFirmName} via Paralegix.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    subject,
    '',
    `Hi ${recipientName || 'there'},`,
    '',
    `${senderName} from ${lawFirmName} has cancelled the signing request for ${fileName}${roleLabel ? ` (${roleLabel})` : ''}.`,
    'You do not need to take any further action unless you receive a new request.',
    '',
    '---',
    `This email was sent by ${lawFirmName} via Paralegix.`,
  ].join('\n');

  return sendEmail({
    to,
    subject,
    html,
    text,
    replyTo: replyTo || undefined,
    fromName: senderName,
  });
}

export async function sendSignerConfirmationEmail({
  to,
  recipientName,
  fileName,
  completedCount,
  totalParticipants,
  replyTo,
}: any) {
  if (!to) return { sent: false };

  const safeName = escapeHtml(recipientName || 'there');
  const safeFileName = escapeHtml(fileName);
  const subject = `Signature confirmed: ${fileName}`;
  const progressCopy = totalParticipants > 1
    ? `${completedCount} of ${totalParticipants} signatures collected.`
    : 'Your signature has been recorded.';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
  <tr><td style="height:4px;background:linear-gradient(90deg,#059669,#10b981);"></td></tr>
  <tr><td style="padding:40px 40px 0;">
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;">Paralegix</h1>
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">SIGNATURE CONFIRMED</p>
  </td></tr>
  <tr><td style="padding:0 40px 32px;">
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi ${safeName},</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Your signature on <strong>${safeFileName}</strong> has been recorded.</p>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#6b7280;">${escapeHtml(progressCopy)}</p>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This confirmation was sent by Paralegix.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    subject,
    '',
    `Hi ${recipientName || 'there'},`,
    '',
    `Your signature on ${fileName} has been recorded.`,
    progressCopy,
    '',
    'This confirmation was sent by Paralegix.',
  ].join('\n');

  return sendEmail({
    to,
    subject,
    html,
    text,
    replyTo: replyTo || undefined,
    fromName: 'Paralegix',
  });
}

/**
 * Tell everyone still waiting on a session that it has ended.
 *
 * `declinedBy` is the participant whose decline ended it. When present, portal
 * signers are told the request was DECLINED rather than cancelled, and a portal
 * decliner gets a notice of their own in their thread confirming it.
 */
export async function sendCancellationNotifications({
  sessionData,
  senderName,
  senderEmail,
  declinedBy = null,
}: any) {
  if (!sessionData) return { sent: 0, skipped: 0, errors: 0 };

  const lawFirmName = await getLawFirmName(sessionData.lawFirmId);
  const pendingParticipants = Array.isArray(sessionData.participants)
    ? sessionData.participants.filter((participant: any) => !['completed', 'cancelled', 'declined'].includes(participant.status))
    : [];

  if (declinedBy?.deliveryMethod === 'portal' && declinedBy.clientUserId) {
    try {
      await sendPortalStatusMessage({
        lawFirmId: sessionData.lawFirmId,
        clientUserId: declinedBy.clientUserId,
        content: `You declined to sign "${sessionData.fileName}". ${lawFirmName} has been notified, and the signing request is now closed.`,
      });
    } catch (err: any) {
      console.error('[signing] Failed to post the decline notice to the decliner:', err.message);
    }
  }

  if (pendingParticipants.length === 0) {
    // After a decline with nobody left waiting, the only person this fallback
    // could reach is a signer who already acted, and "cancelled" would be the
    // wrong word for what happened. The firm hears of the decline separately.
    if (declinedBy) return { sent: 0, skipped: 1, errors: 0 };
    // Every session carries participant rows, so the recipient is the first
    // participant. There is no session-level recipient copy to fall back to.
    const fallbackEmail = sessionData.participants?.[0]?.email || null;
    if (!fallbackEmail) return { sent: 0, skipped: 1, errors: 0 };
    const result = await sendSigningCancelledEmail({
      to: fallbackEmail,
      recipientName: sessionData.recipientName || sessionData.signerName || null,
      senderName: senderName || sessionData.notifyName || 'Someone',
      lawFirmName,
      fileName: sessionData.fileName,
      roleLabel: 'Signer',
      replyTo: senderEmail || sessionData.notifyEmail || undefined,
    });
    return { sent: result.sent ? 1 : 0, skipped: result.sent ? 0 : 1, errors: 0 };
  }

  const summary = { sent: 0, skipped: 0, errors: 0 };

  for (const participant of pendingParticipants) {
    try {
      let result: { sent: boolean; skipped?: boolean } = { sent: false, skipped: false };

      if (participant.deliveryMethod === 'portal' && participant.clientUserId) {
        const request = participant.roleLabel
          ? `The signing request for "${sessionData.fileName}" as ${participant.roleLabel}`
          : `The signing request for "${sessionData.fileName}"`;
        result = await sendPortalStatusMessage({
          lawFirmId: sessionData.lawFirmId,
          clientUserId: participant.clientUserId,
          content: declinedBy
            ? `${request} was declined by another signer and is now closed. You do not need to take any further action.`
            : `${request} has been cancelled.`,
        });
      } else if (participant.deliveryMethod === 'internal_dashboard') {
        result = { sent: false, skipped: true };
      } else {
        result = await sendSigningCancelledEmail({
          to: participant.email,
          recipientName: participant.name,
          senderName: senderName || sessionData.notifyName || 'Someone',
          lawFirmName,
          fileName: sessionData.fileName,
          roleLabel: participant.roleLabel,
          replyTo: senderEmail || sessionData.notifyEmail || undefined,
        });
      }

      if (result.sent) summary.sent += 1;
      else summary.skipped += 1;
    } catch (error) {
      summary.errors += 1;
    }
  }

  return summary;
}

export async function sendParticipantInvitation({
  participant,
  publicToken,
  lawFirmId,
  senderName,
  senderEmail,
  fileName,
  message,
  // Lets a reminder send swap in reminder-flavored copy (and its own `type`
  // for icon/filter purposes) without also getting the default "Signature
  // requested" notification alongside it.
  notificationOverride,
  // A reminder or resend rather than the first request. Changes the portal
  // thread wording; email copy is driven by `message` alone.
  reminder = false,
}: any) {
  if (!participant) return { sent: false, skipped: true };

  const signingLink = `${APP_URL}/signature?token=${publicToken}`;
  const lawFirmName = await getLawFirmName(lawFirmId);
  const notifyType = notificationOverride?.type || 'signing_requested';
  const notifyTitle = notificationOverride?.title || 'Signature requested';
  const notifyBody = notificationOverride?.body || `${senderName || 'Someone'} requested your signature on "${fileName}"`;

  if (participant.deliveryMethod === 'portal' && participant.clientUserId) {
    // Callers run this after the session is committed, so a thread that cannot
    // be written is a delivery failure to report, not an error that undoes the
    // operation around it.
    let messageRes: { sent: boolean };
    try {
      messageRes = await sendPortalSigningMessage({
        lawFirmId,
        clientUserId: participant.clientUserId,
        fileName,
        roleLabel: participant.roleLabel,
        message,
        reminder,
      });
    } catch (err: any) {
      console.error('[signing] Failed to post the signing request to the portal thread:', err.message);
      return { sent: false };
    }
    try {
      const { createNotifications } = require('../notifications/notifications.service');
      await createNotifications(lawFirmId, [participant.clientUserId], {
        category: 'signingRequested',
        type: notifyType,
        title: notifyTitle,
        body: notifyBody,
        entityType: null,
        entityId: null,
        // The portal page, not the bearer link, for the reason the thread
        // message gives: the client opens it logged in.
        actionUrl: portalSigningUrl(lawFirmId),
        createdBy: null,
      });
    } catch (err: any) {
      console.error('[signing] Failed to create in-app notification for portal participant:', err.message);
    }
    return messageRes;
  }

  if (participant.deliveryMethod === 'internal_dashboard') {
    const targetUserId = participant.memberUserId;
    if (targetUserId && lawFirmId) {
      try {
        const { createNotifications } = require('../notifications/notifications.service');
        const actionUrl = `${APP_URL}/lawfirm/${lawFirmId}/signatures`;
        await createNotifications(lawFirmId, [targetUserId], {
          category: 'signingRequested',
          type: notifyType,
          title: notifyTitle,
          body: notifyBody,
          entityType: null,
          entityId: null,
          actionUrl,
          createdBy: null,
        });
      } catch (err: any) {
        console.error('[signing] Failed to create in-app notification for internal_dashboard participant:', err.message);
      }
    }
    return { sent: true };
  }

  if (participant.deliveryMethod === 'in_person') {
    return { sent: true, skipped: true };
  }

  if (participant.deliveryMethod === 'copy_link') {
    return { sent: true, skipped: true, signingLink };
  }

  return sendSigningInviteEmail({
    to: participant.email,
    recipientName: participant.name,
    senderName,
    lawFirmName,
    fileName,
    signingLink,
    message,
    replyTo: senderEmail,
    roleLabel: participant.roleLabel,
  });
}
