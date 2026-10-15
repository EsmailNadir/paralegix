const { Resend } = require('resend');
const { createHash } = require('crypto');
const { infrastructureRootSql, infrastructureSql, withDrizzleTransaction } = require('../database/infrastructureQuery');

let resend: any = null;
let emailReady = false;

const EMAIL_FROM = process.env.EMAIL_FROM || 'Paralegix <noreply@paralegix.com>';

// Per-recipient daily send cap. A single inbox can't be mail-bombed through the
// public, unauthenticated endpoints that trigger mail (e.g. signing complete/
// decline) even if every request-level rate limit is somehow bypassed. Generous
// so legitimate high-volume recipients (a firm owner receiving many client
// notifications) are never blocked. Set EMAIL_MAX_PER_RECIPIENT_PER_DAY=0 to
// disable. Backed by the shared `rate_limits` table; fails OPEN on any DB error
// so a hiccup never suppresses legitimate mail.
const EMAIL_MAX_PER_RECIPIENT_PER_DAY = Number(process.env.EMAIL_MAX_PER_RECIPIENT_PER_DAY || 100);
const EMAIL_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Coerce a `to` of one address, several, or a mix of blanks into a deduped, trimmed list. */
function normalizeRecipients(to: any): string[] {
  const list = Array.isArray(to) ? to : [to];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of list) {
    const trimmed = typeof entry === 'string' ? entry.trim() : '';
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

async function withinRecipientDailyCap(recipient: any) {
  if (!Number.isFinite(EMAIL_MAX_PER_RECIPIENT_PER_DAY) || EMAIL_MAX_PER_RECIPIENT_PER_DAY <= 0) {
    return true; // cap disabled
  }
  const address = String(recipient || '').trim().toLowerCase();
  if (!address) return true;

  const key = `email-daily:${address}`;
  try {
    // Atomic upsert mirroring pgRateLimitStore: a fresh/expired window resets to
    // 1 with a new 24h expiry; an active window increments.
    const { rows } = await infrastructureRootSql(
      `insert into rate_limits (key, hits, expires_at)
         values ($1, 1, now() + $2::bigint * interval '1 millisecond')
       on conflict (key) do update set
         hits = case when rate_limits.expires_at <= now() then 1 else rate_limits.hits + 1 end,
         expires_at = case when rate_limits.expires_at <= now()
                           then excluded.expires_at else rate_limits.expires_at end
       returning hits`,
      [key, EMAIL_CAP_WINDOW_MS],
    );
    return Number(rows[0].hits) <= EMAIL_MAX_PER_RECIPIENT_PER_DAY;
  } catch (err: any) {
    console.error('[emailService] recipient cap check failed (allowing send):', err.message);
    return true;
  }
}

const COMPANY_POSTAL_ADDRESS = process.env.COMPANY_POSTAL_ADDRESS || 'Paralegix, [physical mailing address not set]';
/**
 * Where the CAN-SPAM footer and the `List-Unsubscribe` header send a recipient.
 *
 * `/account` is the only settings route in the app that is not scoped to a law
 * firm: its layout gates on a verified sign-in alone, with no firm id, no
 * membership and no permission check, so it resolves for a firm member and for a
 * portal client alike. Every other settings page lives under
 * `/lawfirm/:lawFirmId/...` or `/client/lawfirm/:lawFirmId/...`, which cannot be
 * addressed from a constant and would wall off half the audience of the
 * client-facing mail this footer also rides on.
 */
const PREFERENCES_URL = `${(process.env.APP_URL || 'https://paralegix.com').replace(/\/+$/, '')}/account`;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@paralegix.com';

/**
 * Compliance footer markup appended to every outbound HTML email. Provides the
 * sender's physical mailing address and a way to manage email preferences or
 * contact support, satisfying CAN-SPAM/CASL requirements and aiding deliverability.
 */
function complianceFooterHtml() {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;">
<tr><td align="center" style="padding:16px 16px 32px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="padding:0 8px;text-align:center;font-size:11px;line-height:1.6;color:#9ca3af;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
    <p style="margin:0 0 6px;">${escapeHtml(COMPANY_POSTAL_ADDRESS)}</p>
    <p style="margin:0;">To stop non-essential notifications or get help, manage your <a href="${escapeHtml(PREFERENCES_URL)}" style="color:#9ca3af;text-decoration:underline;">email preferences</a> or contact <a href="mailto:${escapeHtml(SUPPORT_EMAIL)}" style="color:#9ca3af;text-decoration:underline;">${escapeHtml(SUPPORT_EMAIL)}</a>.</p>
  </td></tr>
</table>
</td></tr>
</table>`;
}

/**
 * Plain-text equivalent of the compliance footer for the text/plain part.
 */
function complianceFooterText() {
  return [
    '',
    '---',
    COMPANY_POSTAL_ADDRESS,
    `To stop non-essential notifications or get help, manage your email preferences at ${PREFERENCES_URL} or contact ${SUPPORT_EMAIL}.`,
  ].join('\n');
}

/**
 * Append the compliance footer to a full HTML email document. Inserts the footer
 * just before the closing body tag so it sits below the existing card layout.
 */
function withComplianceFooterHtml(html: any) {
  if (typeof html !== 'string' || !html) return html;
  const footer = complianceFooterHtml();
  const closingBody = html.lastIndexOf('</body>');
  if (closingBody === -1) {
    return `${html}\n${footer}`;
  }
  return `${html.slice(0, closingBody)}${footer}${html.slice(closingBody)}`;
}

/**
 * Append the compliance footer to a plain-text email body.
 */
function withComplianceFooterText(text: any) {
  if (typeof text !== 'string') return text;
  return `${text}\n${complianceFooterText()}`;
}

function initResend() {
  if (resend !== null) return;

  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.warn('[emailService] RESEND_API_KEY not set. Emails will be skipped.');
    resend = false; // sentinel: attempted but unavailable
    return;
  }

  resend = new Resend(apiKey);
  emailReady = true;
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

/**
 * Send a raw email. Returns { sent, messageId? }, plus `suppressed`, `throttled`
 * or `notConfigured` when the message was refused for that reason.
 * Never throws. Logs errors and returns { sent: false }.
 *
 * Passing `lawFirmId` + `category` opts this send into the firm-level gate: a
 * firm that has turned email notifications off suppresses every non-transactional
 * category. Per-recipient preferences are resolved by the caller, which knows
 * whether the recipient is a firm user or a portal client
 * (`shared/services/emailPreferences.js`).
 */
export async function sendEmail({ to, subject, html, text, replyTo, fromName, attachments, lawFirmId, category, idempotencyKey }: any) {
  initResend();

  if (!emailReady) {
    console.warn('[emailService] Skipping email (Resend not configured):', subject);
    return { sent: false, notConfigured: true };
  }

  if (lawFirmId && category) {
    // Required lazily rather than at module scope: emailPreferences pulls in
    // settings.repository and settings.defaults, tying emailService's module-load
    // order to theirs. Neither requires emailService back today, but many senders
    // that call sendEmail live under modules those settings files also touch
    // (billing, matters, tasks, ...), so a future addition on either side could
    // turn this into a real cycle. Keeping the require local to the call site
    // means that never bites - it only resolves once the rest of the app has
    // already finished loading.
    const { isFirmEmailEnabled, isTransactionalCategory } = require('./emailPreferences');
    if (!isTransactionalCategory(category) && !(await isFirmEmailEnabled(lawFirmId))) {
      console.warn('[emailService] Skipping email (firm disabled notifications):', subject);
      return { sent: false, suppressed: true };
    }
  }

  // Enforce the per-recipient daily cap before spending a Resend send. Applies to
  // every recipient on the message (the codebase sends single-recipient mail, but
  // guard arrays too).
  const recipients = Array.isArray(to) ? to : [to];
  for (const recipient of recipients) {
    if (!(await withinRecipientDailyCap(recipient))) {
      console.warn('[emailService] Skipping email: recipient daily cap reached:', subject);
      return { sent: false, throttled: true };
    }
  }

  try {
    const from = fromName
      ? `${fromName} via Paralegix <noreply@paralegix.com>`
      : EMAIL_FROM;

    const payload = {
      from,
      to,
      subject,
      html: withComplianceFooterHtml(html),
      text: withComplianceFooterText(text),
      headers: {
        'List-Unsubscribe': `<mailto:${SUPPORT_EMAIL}>, <${PREFERENCES_URL}>`,
      },
    };
    if (replyTo) (payload as Record<string, unknown>).reply_to = replyTo;
    if (attachments?.length) (payload as Record<string, unknown>).attachments = attachments;

    // Provider retries require identical payloads. Changed content gets a new
    // key so it does not conflict with the previously accepted email.
    const options = idempotencyKey ? {
      idempotencyKey: `${idempotencyKey}/${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`,
    } : undefined;
    const { data, error } = await resend.emails.send(payload, options);

    if (error) {
      console.error('[emailService] Resend API error:', error.message);
      return { sent: false };
    }

    return { sent: true, messageId: data.id };
  } catch (err: any) {
    console.error('[emailService] Failed to send email:', err.message);
    return { sent: false };
  }
}

/**
 * Send a client invitation email.
 *
 * @param {Object} opts
 * @param {string} opts.recipientEmail
 * @param {string} opts.lawFirmName
 * @param {string|null} opts.inviterName
 * @param {boolean} opts.isExistingUser
 * @param {string} [opts.portalUrl]  for existing users
 * @param {string} [opts.inviteUrl]  for new users
 */
export async function sendClientInvitationEmail({
  recipientEmail,
  lawFirmName,
  inviterName,
  isExistingUser,
  portalUrl,
  inviteUrl,
}: any) {
  // Guard against empty/null recipient
  if (!recipientEmail || typeof recipientEmail !== 'string' || !recipientEmail.trim()) {
    console.warn('[emailService] Skipping email: no recipient address');
    return { sent: false };
  }

  const firmName = (lawFirmName && typeof lawFirmName === 'string' && lawFirmName.trim())
    ? lawFirmName.trim()
    : 'Your Law Firm';
  const safeFirmName = escapeHtml(firmName);
  const safeInviterName = inviterName ? escapeHtml(inviterName) : null;

  const subject = isExistingUser
    ? `You've been added to ${firmName}'s client portal`
    : `${firmName} has invited you to their client portal`;

  const ctaUrl = isExistingUser ? portalUrl : inviteUrl;
  const ctaLabel = isExistingUser ? 'Go to Your Portal' : 'Get Started';

  const inviterLine = safeInviterName
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${safeInviterName} at <strong>${safeFirmName}</strong> has ${isExistingUser ? 'added you to' : 'invited you to join'} their client portal on Paralegix.</p>`
    : `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;"><strong>${safeFirmName}</strong> has ${isExistingUser ? 'added you to' : 'invited you to join'} their client portal on Paralegix.</p>`;

  const detailNote = isExistingUser
    ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#6b7280;">You can now view your matters, communicate with your legal team, and access important documents through the portal.</p>`
    : `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#6b7280;">Click the button below to get started. You'll be able to view your matters, communicate with your legal team, and access important documents.</p>`;

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
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">CLIENT PORTAL INVITATION</p>
  </td></tr>
  <tr><td style="padding:0 40px;">
    ${inviterLine}
    ${detailNote}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
    <tr><td style="border-radius:8px;background-color:#4f46e5;">
      <a href="${escapeHtml(ctaUrl || '')}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${ctaLabel}</a>
    </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This invitation was sent by ${safeFirmName} via Paralegix. If you did not expect this email, you can safely ignore it.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  // Plain text fallback
  const textInviter = inviterName
    ? `${inviterName} at ${firmName}`
    : firmName;

  const textLines = [
    subject,
    '',
    `${textInviter} has ${isExistingUser ? 'added you to' : 'invited you to join'} their client portal on Paralegix.`,
    '',
    isExistingUser
      ? 'You can now view your matters, communicate with your legal team, and access important documents.'
      : 'Click the link below to get started.',
    '',
    `${ctaLabel}: ${ctaUrl || ''}`,
    '',
    '---',
    `This invitation was sent by ${firmName} via Paralegix.`,
  ];

  const text = textLines.join('\n');

  return sendEmail({ to: recipientEmail, subject, html, text });
}

/**
 * Ask a client to fund their trust account by bank transfer: the secure Stripe
 * checkout link the firm requested. Stripe ends that link after 24 hours, so
 * the email says so.
 */
export async function sendTrustDepositRequestEmail({
  to,
  recipientName,
  lawFirmName,
  amountCents,
  checkoutUrl,
}: any) {
  const recipients = normalizeRecipients(to);
  if (recipients.length === 0) {
    console.warn('[emailService] Skipping trust deposit request email: no recipient address');
    return { sent: false };
  }
  const firmName = (lawFirmName && typeof lawFirmName === 'string' && lawFirmName.trim())
    ? lawFirmName.trim()
    : 'Your Law Firm';
  const safeFirmName = escapeHtml(firmName);
  const safeRecipientName = recipientName ? escapeHtml(recipientName) : null;
  const formattedAmount = ((Number(amountCents) || 0) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const subject = `Trust deposit requested by ${firmName}`;
  const greeting = safeRecipientName
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi ${safeRecipientName},</p>`
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
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">TRUST DEPOSIT REQUEST</p>
  </td></tr>
  <tr><td style="padding:0 40px;">
    ${greeting}
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;"><strong>${safeFirmName}</strong> has asked you to deposit <strong>$${formattedAmount}</strong> into your trust account by bank transfer.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
    <tr><td style="border-radius:8px;background-color:#4f46e5;">
      <a href="${escapeHtml(checkoutUrl || '')}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Make Deposit</a>
    </td></tr>
    </table>
    <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#9ca3af;">This link works for 24 hours. If it expires, ask ${safeFirmName} for a new one. Bank transfers take a few business days to clear.</p>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This email was sent on behalf of ${safeFirmName} via Paralegix. If you did not expect this email, you can safely ignore it.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  const text = [
    subject,
    '',
    `${firmName} has asked you to deposit $${formattedAmount} into your trust account by bank transfer.`,
    '',
    `Make Deposit: ${checkoutUrl || ''}`,
    '',
    `This link works for 24 hours. If it expires, ask ${firmName} for a new one. Bank transfers take a few business days to clear.`,
    '',
    '---',
    `This email was sent on behalf of ${firmName} via Paralegix.`,
  ].join('\n');
  return sendEmail({ to: recipients, subject, html, text });
}

/**
 * Send a payment request email to a client with a Stripe checkout link.
 *
 * @param {Object} opts
 * @param {string} opts.recipientEmail
 * @param {string|null} opts.recipientName
 * @param {string|null} opts.lawFirmName
 * @param {string} opts.invoiceNumber
 * @param {number} opts.amountDue          remaining balance in dollars
 * @param {string} opts.checkoutUrl        Stripe Checkout Session URL
 * @param {string} opts.portalUrl          client portal billing page URL (fallback)
 * @param {string|null} [opts.dueDate]     invoice due date string
 */
export async function sendPaymentRequestEmail({
  to,
  recipientName,
  lawFirmName,
  invoiceNumber,
  amountDue,
  checkoutUrl,
  portalUrl,
  dueDate,
  payLink = false,
}: any) {
  // The same hosted payment URL goes to EVERY billing recipient the invoice was
  // issued to. Stripe's customer object carries a single `email`, which is fine
  // for Stripe's own dunning, but it must not narrow Paralegix's own fan-out to
  // one address: a company's accounts-payable list is often several people.
  const recipients = normalizeRecipients(to);
  if (recipients.length === 0) {
    console.warn('[emailService] Skipping payment request email: no recipient address');
    return { sent: false };
  }

  const firmName = (lawFirmName && typeof lawFirmName === 'string' && lawFirmName.trim())
    ? lawFirmName.trim()
    : 'Your Law Firm';
  const safeFirmName = escapeHtml(firmName);
  const safeInvoiceNumber = escapeHtml(invoiceNumber || 'N/A');
  const safeRecipientName = recipientName ? escapeHtml(recipientName) : null;
  const formattedAmount = (amountDue || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const subject = `Payment Requested: Invoice #${invoiceNumber || 'N/A'} from ${firmName}`;

  const greeting = safeRecipientName
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi ${safeRecipientName},</p>`
    : '';

  const dueDateLine = dueDate
    ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#6b7280;">Due date: ${escapeHtml(String(dueDate))}</p>`
    : '';

  // A hosted Stripe invoice (an installment request) expires; the secure
  // payment link does not, and its page is where the client picks card or bank
  // transfer and sees any processing fee.
  const footnoteText = payLink
    ? 'You will choose card or bank transfer and see any processing fee before you pay.'
    : `This payment link is valid for 10 days. You can also pay anytime through your client portal: ${portalUrl || ''}`;
  const footnoteHtml = payLink
    ? escapeHtml(footnoteText)
    : `This payment link is valid for 10 days. You can also pay anytime through your <a href="${escapeHtml(portalUrl || '')}" style="color:#4f46e5;text-decoration:underline;">client portal</a>.`;

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
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">PAYMENT REQUEST</p>
  </td></tr>
  <tr><td style="padding:0 40px;">
    ${greeting}
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;"><strong>${safeFirmName}</strong> has requested a payment of <strong>$${formattedAmount}</strong> for Invoice #${safeInvoiceNumber}.</p>
    ${dueDateLine}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
    <tr><td style="border-radius:8px;background-color:#4f46e5;">
      <a href="${escapeHtml(checkoutUrl || '')}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Pay Now</a>
    </td></tr>
    </table>
    <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#9ca3af;">${footnoteHtml}</p>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This email was sent on behalf of ${safeFirmName} via Paralegix. If you did not expect this email, you can safely ignore it.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const textLines = [
    subject,
    '',
    `${firmName} has requested a payment of $${formattedAmount} for Invoice #${invoiceNumber || 'N/A'}.`,
    ...(dueDate ? [`Due date: ${dueDate}`, ''] : ['']),
    `Pay Now: ${checkoutUrl || ''}`,
    '',
    footnoteText,
    '',
    '---',
    `This email was sent on behalf of ${firmName} via Paralegix.`,
  ];

  const text = textLines.join('\n');

  return sendEmail({ to: recipients, subject, html, text });
}

/**
 * Send a member (employee) invitation email.
 *
 * @param {Object} opts
 * @param {string} opts.recipientEmail
 * @param {string} opts.lawFirmName
 * @param {string|null} opts.inviterName
 * @param {boolean} opts.isExistingUser
 * @param {string} [opts.dashboardUrl]  for existing users
 * @param {string} [opts.inviteUrl]     for new users
 */
export async function sendMemberInvitationEmail({
  recipientEmail,
  lawFirmName,
  inviterName,
  isExistingUser,
  dashboardUrl,
  inviteUrl,
}: any) {
  if (!recipientEmail || typeof recipientEmail !== 'string' || !recipientEmail.trim()) {
    console.warn('[emailService] Skipping email: no recipient address');
    return { sent: false };
  }

  const firmName = (lawFirmName && typeof lawFirmName === 'string' && lawFirmName.trim())
    ? lawFirmName.trim()
    : 'Your Law Firm';
  const safeFirmName = escapeHtml(firmName);
  const safeInviterName = inviterName ? escapeHtml(inviterName) : null;

  const subject = isExistingUser
    ? `You've been added to ${firmName} on Paralegix`
    : `${firmName} has invited you to join their team on Paralegix`;

  const ctaUrl = isExistingUser ? dashboardUrl : inviteUrl;
  const ctaLabel = isExistingUser ? 'Go to Dashboard' : 'Accept Invitation';

  const inviterLine = safeInviterName
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${safeInviterName} at <strong>${safeFirmName}</strong> has ${isExistingUser ? 'added you to' : 'invited you to join'} their team on Paralegix.</p>`
    : `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;"><strong>${safeFirmName}</strong> has ${isExistingUser ? 'added you to' : 'invited you to join'} their team on Paralegix.</p>`;

  const detailNote = isExistingUser
    ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#6b7280;">You can now access matters, tasks, billing, and more through the Paralegix dashboard.</p>`
    : `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#6b7280;">Click the button below to get started. You'll be able to manage matters, tasks, billing, and collaborate with your team.</p>`;

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
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">TEAM INVITATION</p>
  </td></tr>
  <tr><td style="padding:0 40px;">
    ${inviterLine}
    ${detailNote}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
    <tr><td style="border-radius:8px;background-color:#4f46e5;">
      <a href="${escapeHtml(ctaUrl || '')}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${ctaLabel}</a>
    </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This invitation was sent by ${safeFirmName} via Paralegix. If you did not expect this email, you can safely ignore it.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const textInviter = inviterName ? `${inviterName} at ${firmName}` : firmName;

  const textLines = [
    subject,
    '',
    `${textInviter} has ${isExistingUser ? 'added you to' : 'invited you to join'} their team on Paralegix.`,
    '',
    isExistingUser
      ? 'You can now access matters, tasks, billing, and more through the Paralegix dashboard.'
      : 'Click the link below to get started.',
    '',
    `${ctaLabel}: ${ctaUrl || ''}`,
    '',
    '---',
    `This invitation was sent by ${firmName} via Paralegix.`,
  ];

  const text = textLines.join('\n');

  return sendEmail({ to: recipientEmail, subject, html, text });
}

/**
 * Send an overdue invoice reminder to a client.
 *
 * @param {Object} opts
 * @param {string} opts.to
 * @param {string|null} opts.recipientName
 * @param {string|null} opts.lawFirmName
 * @param {string} opts.invoiceNumber
 * @param {number} opts.amountDue          remaining balance in dollars
 * @param {string|null} opts.dueDate        formatted due date string
 * @param {string|null} opts.portalUrl      client portal billing URL
 */
export async function sendInvoiceReminderEmail({
  to,
  recipientName,
  lawFirmName,
  invoiceNumber,
  amountDue,
  dueDate,
  portalUrl,
  isUpcoming = false,
  daysUntilDue = null,
}: any) {
  const recipients = normalizeRecipients(to);
  if (recipients.length === 0) {
    console.warn('[emailService] Skipping invoice reminder: no recipient address');
    return { sent: false };
  }

  const firmName = (lawFirmName && typeof lawFirmName === 'string' && lawFirmName.trim())
    ? lawFirmName.trim()
    : 'Your Law Firm';
  const formattedAmount = (amountDue || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const safeInvoiceNumber = escapeHtml(invoiceNumber || 'N/A');
  const safeFirmName = escapeHtml(firmName);
  const safeRecipientName = recipientName ? escapeHtml(recipientName) : null;

  const subject = isUpcoming
    ? `Upcoming payment: Invoice #${invoiceNumber || 'N/A'} due ${daysUntilDue === 1 ? 'tomorrow' : `in ${daysUntilDue} days`} ($${formattedAmount} due)`
    : `Reminder: Invoice #${invoiceNumber || 'N/A'} is past due ($${formattedAmount} outstanding)`;

  const headerLabel = isUpcoming ? 'UPCOMING PAYMENT' : 'PAYMENT REMINDER';
  const accentColor = isUpcoming ? '#2563eb,#3b82f6' : '#dc2626,#ef4444';

  const greeting = safeRecipientName
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi ${safeRecipientName},</p>`
    : '';

  const bodyMessage = isUpcoming
    ? `This is a reminder that Invoice #${safeInvoiceNumber} from <strong>${safeFirmName}</strong> is due <strong>${dueDate ? `on ${escapeHtml(String(dueDate))}` : 'soon'}</strong> with an outstanding balance of <strong>$${formattedAmount}</strong>.`
    : `This is a reminder that Invoice #${safeInvoiceNumber} from <strong>${safeFirmName}</strong> has an outstanding balance of <strong>$${formattedAmount}</strong>.`;

  const dueDateLine = !isUpcoming && dueDate
    ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#6b7280;">This invoice was due on <strong>${escapeHtml(String(dueDate))}</strong>.</p>`
    : '';

  const ctaBlock = portalUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
    <tr><td style="border-radius:8px;background-color:#4f46e5;">
      <a href="${escapeHtml(portalUrl)}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">View Invoice &amp; Pay</a>
    </td></tr>
    </table>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
  <tr><td style="height:4px;background:linear-gradient(90deg,${accentColor});"></td></tr>
  <tr><td style="padding:40px 40px 0;">
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;">Paralegix</h1>
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">${headerLabel}</p>
  </td></tr>
  <tr><td style="padding:0 40px;">
    ${greeting}
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${bodyMessage}</p>
    ${dueDateLine}
    ${ctaBlock}
    <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#9ca3af;">If you've already made this payment, please disregard this notice. Contact ${safeFirmName} if you have any questions.</p>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This reminder was sent on behalf of ${safeFirmName} via Paralegix.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const dueDateText = dueDate ? `due on ${dueDate}` : 'due soon';
  const text = [
    subject,
    '',
    isUpcoming
      ? `Invoice #${invoiceNumber || 'N/A'} from ${firmName} has a balance of $${formattedAmount} ${dueDateText}.`
      : `Invoice #${invoiceNumber || 'N/A'} from ${firmName} has an outstanding balance of $${formattedAmount}.`,
    ...(!isUpcoming && dueDate ? [`This invoice was due on ${dueDate}.`] : []),
    '',
    ...(portalUrl ? [`View Invoice & Pay: ${portalUrl}`, ''] : []),
    'If you\'ve already made this payment, please disregard this notice.',
    '',
    '---',
    `This reminder was sent on behalf of ${firmName} via Paralegix.`,
  ].join('\n');

  return sendEmail({ to: recipients, subject, html, text });
}

/**
 * Notify a law firm that a client payment was received via Stripe.
 *
 * @param {Object} opts
 * @param {string} opts.to                  firm member email
 * @param {string|null} opts.recipientName  firm member name
 * @param {string|null} opts.lawFirmName
 * @param {string} opts.invoiceNumber
 * @param {number} opts.amountPaid          amount in dollars
 * @param {string|null} opts.clientName
 */
export async function sendPaymentReceivedNotificationEmail({
  to,
  recipientName,
  lawFirmName,
  invoiceNumber,
  amountPaid,
  clientName,
  method,
}: any) {
  // Only Stripe-collected payments were "via Stripe" / recorded automatically; a
  // manually-recorded payment (check, wire, cash, trust) should say neither.
  const isStripe = method === 'stripe';
  const via = isStripe ? ' via Stripe' : '';
  const autoLine = isStripe ? 'The payment has been recorded automatically. ' : '';
  if (!to || typeof to !== 'string' || !to.trim()) {
    console.warn('[emailService] Skipping payment received notification: no recipient address');
    return { sent: false };
  }

  const firmName = (lawFirmName && typeof lawFirmName === 'string' && lawFirmName.trim())
    ? lawFirmName.trim()
    : 'Your Law Firm';
  const formattedAmount = (amountPaid || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const safeInvoiceNumber = escapeHtml(invoiceNumber || 'N/A');
  const safeClientName = clientName ? escapeHtml(clientName) : 'A client';
  const safeRecipientName = recipientName ? escapeHtml(recipientName) : null;

  const subject = `Payment received: Invoice #${invoiceNumber || 'N/A'} ($${formattedAmount})`;

  const greeting = safeRecipientName
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi ${safeRecipientName},</p>`
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
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">PAYMENT RECEIVED</p>
  </td></tr>
  <tr><td style="padding:0 40px 32px;">
    ${greeting}
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${safeClientName} has paid <strong>$${formattedAmount}</strong> for Invoice #${safeInvoiceNumber}${via}.</p>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#6b7280;">${autoLine}Log in to Paralegix to view the updated invoice.</p>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This notification was sent by Paralegix on behalf of ${escapeHtml(firmName)}.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    subject,
    '',
    `${clientName || 'A client'} has paid $${formattedAmount} for Invoice #${invoiceNumber || 'N/A'}${via}.`,
    '',
    `${autoLine}Log in to Paralegix to view the updated invoice.`,
  ].join('\n');

  return sendEmail({ to, subject, html, text });
}

/**
 * Client-facing payment receipt. Sent to the client's billing email on every
 * applied payment (partial or full). Gated upstream by the firm's
 * `clientPaymentEmails` setting; this function only formats and sends.
 */
export async function sendPaymentReceiptEmail({
  to,
  recipientName,
  lawFirmName,
  invoiceNumber,
  amountPaidCents,
  remainingBalanceCents,
  paymentDate,
  processingFeeCents = 0,
  processingFeeLabel = 'Processing fee',
}: any) {
  // `to` accepts an array: an invoice's frozen billing-recipient list fans the
  // receipt out to every address the invoice was issued to, not just one.
  const recipients = normalizeRecipients(to);
  if (recipients.length === 0) {
    console.warn('[emailService] Skipping payment receipt: no recipient address');
    return { sent: false };
  }

  const firmName = (lawFirmName && typeof lawFirmName === 'string' && lawFirmName.trim())
    ? lawFirmName.trim()
    : 'Your Law Firm';
  const formattedAmount = ((Number(amountPaidCents) || 0) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const remaining = Number(remainingBalanceCents);
  const hasRemaining = Number.isFinite(remaining) && remaining > 0;
  const formattedRemaining = (Math.max(0, remaining || 0) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const safeInvoiceNumber = escapeHtml(invoiceNumber || 'N/A');
  const safeFirmName = escapeHtml(firmName);
  const safeRecipientName = recipientName ? escapeHtml(recipientName) : null;
  const safePaymentDate = paymentDate ? escapeHtml(String(paymentDate)) : null;

  const subject = `Payment received: Invoice #${invoiceNumber || 'N/A'} ($${formattedAmount})`;

  const greeting = safeRecipientName
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi ${safeRecipientName},</p>`
    : '';

  const remainingLine = hasRemaining
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Remaining balance: <strong>$${formattedRemaining}</strong>.</p>`
    : `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">This invoice is now paid in full. Thank you.</p>`;

  // A processing fee the firm passed on rode on the same charge but is not
  // invoice money, so it is listed apart, under the caller's label (the credit
  // card fee or the bank transfer fee), with the total the client was charged.
  const feeCents = Math.max(0, Math.round(Number(processingFeeCents) || 0));
  const toDollars = (cents: number) => (cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const feeSentence = feeCents > 0
    ? `${processingFeeLabel}: $${toDollars(feeCents)}. Total charged: $${toDollars((Number(amountPaidCents) || 0) + feeCents)}.`
    : null;
  const feeLine = feeSentence
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${escapeHtml(feeSentence)}</p>`
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
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">PAYMENT RECEIPT</p>
  </td></tr>
  <tr><td style="padding:0 40px 32px;">
    ${greeting}
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">We received your payment of <strong>$${formattedAmount}</strong> toward Invoice #${safeInvoiceNumber}${safePaymentDate ? ` on ${safePaymentDate}` : ''}.</p>
    ${feeLine}
    ${remainingLine}
    <p style="margin:0;font-size:14px;line-height:1.6;color:#6b7280;">Thank you for your payment.</p>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This receipt was sent by ${safeFirmName} via Paralegix.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    subject,
    '',
    `We received your payment of $${formattedAmount} toward Invoice #${invoiceNumber || 'N/A'}${paymentDate ? ` on ${paymentDate}` : ''}.`,
    ...(feeSentence ? [feeSentence] : []),
    hasRemaining ? `Remaining balance: $${formattedRemaining}.` : 'This invoice is now paid in full. Thank you.',
    '',
    'Thank you for your payment.',
  ].join('\n');

  return sendEmail({ to: recipients, subject, html, text });
}

/**
 * Client-facing notice for a payment that arrived on an invoice the firm had
 * voided. It stands in for the payment receipt: the invoice is no longer
 * payable, so it never says "paid in full" and carries no pay link. Gated
 * upstream by the firm's `clientPaymentEmails` setting.
 */
export async function sendPaymentOnVoidedInvoiceEmail({
  to,
  recipientName,
  lawFirmName,
  invoiceNumber,
  amountPaidCents,
}: any) {
  const recipients = normalizeRecipients(to);
  if (recipients.length === 0) {
    console.warn('[emailService] Skipping voided-invoice payment notice: no recipient address');
    return { sent: false };
  }

  const firmName = (lawFirmName && typeof lawFirmName === 'string' && lawFirmName.trim())
    ? lawFirmName.trim()
    : 'Your Law Firm';
  const formattedAmount = ((Number(amountPaidCents) || 0) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const safeInvoiceNumber = escapeHtml(invoiceNumber || 'N/A');
  const safeFirmName = escapeHtml(firmName);
  const safeRecipientName = recipientName ? escapeHtml(recipientName) : null;

  const subject = 'We received your payment';

  const greeting = safeRecipientName
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi ${safeRecipientName},</p>`
    : '';

  const bodyLine = `We received your payment of <strong>$${formattedAmount}</strong> for Invoice #${safeInvoiceNumber}, which is no longer payable.`;
  const followUpLine = 'The firm will contact you about the funds.';

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
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">PAYMENT NOTICE</p>
  </td></tr>
  <tr><td style="padding:0 40px 32px;">
    ${greeting}
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${bodyLine}</p>
    <p style="margin:0;font-size:15px;line-height:1.6;color:#374151;">${followUpLine}</p>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This notice was sent by ${safeFirmName} via Paralegix.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    subject,
    '',
    bodyLine.replace(/<[^>]*>/g, ''),
    followUpLine,
  ].join('\n');

  return sendEmail({ to: recipients, subject, html, text });
}

/**
 * Client-facing refund / reversal notice. Sent to the client's billing email
 * when a recorded payment is refunded or returned (a Stripe refund or a lost
 * dispute). Gated upstream by the firm's `clientPaymentEmails` setting.
 */
export async function sendPaymentRefundedEmail({
  to,
  recipientName,
  lawFirmName,
  invoiceNumber,
  amountCents,
  reason,
}: any) {
  // `to` accepts an array (see sendPaymentReceiptEmail).
  const recipients = normalizeRecipients(to);
  if (recipients.length === 0) {
    console.warn('[emailService] Skipping refund notice: no recipient address');
    return { sent: false };
  }

  const firmName = (lawFirmName && typeof lawFirmName === 'string' && lawFirmName.trim())
    ? lawFirmName.trim()
    : 'Your Law Firm';
  const formattedAmount = ((Number(amountCents) || 0) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const safeInvoiceNumber = escapeHtml(invoiceNumber || 'N/A');
  const safeFirmName = escapeHtml(firmName);
  const safeRecipientName = recipientName ? escapeHtml(recipientName) : null;

  // 'dispute' reads as a returned/reversed payment; anything else is a refund.
  const isDispute = reason === 'dispute';
  const actionWord = isDispute ? 'returned' : 'refunded';
  const subject = `Payment ${actionWord}: Invoice #${invoiceNumber || 'N/A'} ($${formattedAmount})`;

  const greeting = safeRecipientName
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi ${safeRecipientName},</p>`
    : '';

  const bodyLine = isDispute
    ? `A payment of <strong>$${formattedAmount}</strong> on Invoice #${safeInvoiceNumber} was returned. The invoice balance is open again.`
    : `A payment of <strong>$${formattedAmount}</strong> on Invoice #${safeInvoiceNumber} was refunded.`;

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
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">PAYMENT ${actionWord.toUpperCase()}</p>
  </td></tr>
  <tr><td style="padding:0 40px 32px;">
    ${greeting}
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${bodyLine}</p>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#6b7280;">If you have any questions, please contact your legal team.</p>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This notice was sent by ${safeFirmName} via Paralegix.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    subject,
    '',
    bodyLine.replace(/<[^>]*>/g, ''),
    '',
    'If you have any questions, please contact your legal team.',
  ].join('\n');

  return sendEmail({ to: recipients, subject, html, text });
}

/**
 * Send a matter event reminder email.
 */
export async function sendMatterEventReminderEmail({ to, recipientName, lawFirmName, lawFirmId, eventTitle, eventType, eventDate, eventUrl, reminderType, daysUntil, matterName }: any) {
  initResend();
  if (!emailReady || !to) return { sent: false };

  const safeName = escapeHtml(recipientName || 'there');
  const safeTitle = escapeHtml(eventTitle || 'Event');
  const safeType = escapeHtml(eventType || '');
  const safeDate = escapeHtml(eventDate || '');
  const safeMatterName = matterName ? escapeHtml(matterName) : null;
  const safeFirmName = escapeHtml(lawFirmName || 'Your Law Firm');

  let subjectPrefix;
  let messageBody;
  if (reminderType === 'overdue') {
    subjectPrefix = 'Overdue';
    messageBody = `<strong>${safeTitle}</strong>${safeType ? ` (${safeType})` : ''} was scheduled for <strong>${safeDate}</strong> and is now overdue.`;
  } else if (daysUntil === 0) {
    subjectPrefix = 'Today';
    messageBody = `<strong>${safeTitle}</strong>${safeType ? ` (${safeType})` : ''} is scheduled for <strong>today</strong> (${safeDate}).`;
  } else {
    subjectPrefix = `In ${daysUntil} day${daysUntil !== 1 ? 's' : ''}`;
    messageBody = `<strong>${safeTitle}</strong>${safeType ? ` (${safeType})` : ''} is coming up in <strong>${daysUntil} day${daysUntil !== 1 ? 's' : ''}</strong> on ${safeDate}.`;
  }

  const subject = `${subjectPrefix}: ${eventTitle}${matterName ? ` (${matterName})` : ''}`;
  const greeting = `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi ${safeName},</p>`;

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px;">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">
  <tr><td style="height:4px;background:linear-gradient(90deg,#4f46e5,#6366f1);"></td></tr>
  <tr><td style="padding:40px 40px 0;">
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;">Paralegix</h1>
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">EVENT REMINDER</p>
  </td></tr>
  <tr><td style="padding:0 40px 32px;">
    ${greeting}
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${messageBody}</p>
    ${safeMatterName ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#6b7280;">Matter: <strong>${safeMatterName}</strong></p>` : ''}
    ${eventUrl ? `<p style="margin:0;"><a href="${escapeHtml(eventUrl)}" style="display:inline-block;padding:10px 24px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">View in Paralegix</a></p>` : ''}
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This reminder was sent by Paralegix on behalf of ${safeFirmName}.</p>
  </td></tr>
</table>
</td></tr></table></body></html>`;

  const text = [subject, '', `Hi ${recipientName || 'there'},`, '', messageBody.replace(/<[^>]*>/g, ''), matterName ? `Matter: ${matterName}` : '', eventUrl || ''].filter(Boolean).join('\n');

  return sendEmail({ to, subject, html, text, lawFirmId, category: 'eventReminder' });
}

/**
 * Send a task due-date reminder email.
 */
export async function sendTaskDueReminderEmail({ to, recipientName, lawFirmName, taskTitle, dueDate, taskUrl, reminderType, daysOverdue, matterName, creatorNotification, assigneeName, idempotencyKey }: any) {
  initResend();
  if (!emailReady || !to) return { sent: false };

  const safeName = escapeHtml(recipientName || 'there');
  const safeTitle = escapeHtml(taskTitle || 'Task');
  const safeDate = escapeHtml(dueDate || '');
  const safeMatterName = matterName ? escapeHtml(matterName) : null;
  const safeFirmName = escapeHtml(lawFirmName || 'Your Law Firm');
  const safeAssigneeName = assigneeName ? escapeHtml(assigneeName) : null;

  let subjectPrefix;
  let messageBody;
  if (reminderType === 'overdue') {
    subjectPrefix = `Overdue (${daysOverdue}d)`;
    if (creatorNotification && safeAssigneeName) {
      messageBody = `A task assigned to <strong>${safeAssigneeName}</strong>, <strong>${safeTitle}</strong>, was due on <strong>${safeDate}</strong> and is now <strong>${daysOverdue} day${daysOverdue !== 1 ? 's' : ''} overdue</strong>.`;
    } else {
      messageBody = `<strong>${safeTitle}</strong> was due on <strong>${safeDate}</strong> and is now <strong>${daysOverdue} day${daysOverdue !== 1 ? 's' : ''} overdue</strong>.`;
    }
  } else if (reminderType === 'due_today') {
    subjectPrefix = 'Due today';
    messageBody = `<strong>${safeTitle}</strong> is due <strong>today</strong> (${safeDate}).`;
  } else {
    subjectPrefix = 'Due tomorrow';
    messageBody = `<strong>${safeTitle}</strong> is due <strong>tomorrow</strong> (${safeDate}).`;
  }

  const subject = `${subjectPrefix}: ${taskTitle}${matterName ? ` (${matterName})` : ''}`;
  const greeting = `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi ${safeName},</p>`;

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px;">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">
  <tr><td style="height:4px;background:linear-gradient(90deg,#4f46e5,#6366f1);"></td></tr>
  <tr><td style="padding:40px 40px 0;">
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;">Paralegix</h1>
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">TASK REMINDER</p>
  </td></tr>
  <tr><td style="padding:0 40px 32px;">
    ${greeting}
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${messageBody}</p>
    ${safeMatterName ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#6b7280;">Matter: <strong>${safeMatterName}</strong></p>` : ''}
    ${taskUrl ? `<p style="margin:0;"><a href="${escapeHtml(taskUrl)}" style="display:inline-block;padding:10px 24px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">View Tasks</a></p>` : ''}
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This reminder was sent by Paralegix on behalf of ${safeFirmName}.</p>
  </td></tr>
</table>
</td></tr></table></body></html>`;

  const text = [subject, '', `Hi ${recipientName || 'there'},`, '', messageBody.replace(/<[^>]*>/g, ''), matterName ? `Matter: ${matterName}` : '', taskUrl || ''].filter(Boolean).join('\n');

  return sendEmail({ to, subject, html, text, idempotencyKey });
}

/**
 * Send an invoice to a client via email with optional PDF attachment.
 */
export async function sendInvoiceByEmail({
  to,
  recipientName,
  lawFirmName,
  invoiceNumber,
  totalAmount,
  amountPaid,
  remainingBalance,
  dueDate,
  portalUrl,
  pdfBuffer,
  pdfFileName,
}: any) {
  const recipients = normalizeRecipients(to);
  if (recipients.length === 0) {
    console.warn('[emailService] Skipping invoice email: no recipient address');
    return { sent: false };
  }

  const firmName = (lawFirmName && typeof lawFirmName === 'string' && lawFirmName.trim())
    ? lawFirmName.trim()
    : 'Your Law Firm';
  const formattedTotal = (totalAmount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const formattedBalance = (remainingBalance ?? totalAmount ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const safeInvoiceNumber = escapeHtml(invoiceNumber || 'N/A');
  const safeFirmName = escapeHtml(firmName);
  const safeRecipientName = recipientName ? escapeHtml(recipientName) : null;

  const subject = `Invoice #${invoiceNumber || 'N/A'} from ${firmName} ($${formattedBalance} due)`;

  const greeting = safeRecipientName
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi ${safeRecipientName},</p>`
    : '';

  const dueLine = dueDate
    ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#6b7280;">Due date: <strong>${escapeHtml(String(dueDate))}</strong></p>`
    : '';

  const paidLine = (amountPaid || 0) > 0
    ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#6b7280;">Amount paid to date: <strong>$${(amountPaid || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></p>`
    : '';

  const ctaBlock = portalUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
    <tr><td style="border-radius:8px;background-color:#4f46e5;">
      <a href="${escapeHtml(portalUrl)}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">View Invoice</a>
    </td></tr>
    </table>`
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
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">INVOICE</p>
  </td></tr>
  <tr><td style="padding:0 40px;">
    ${greeting}
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Please find attached Invoice #${safeInvoiceNumber} from <strong>${safeFirmName}</strong> for <strong>$${formattedBalance}</strong>.</p>
    ${dueLine}
    ${paidLine}
    ${ctaBlock}
    <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#9ca3af;">If you have any questions about this invoice, please contact ${safeFirmName} directly.</p>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This invoice was sent on behalf of ${safeFirmName} via Paralegix.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    subject,
    '',
    `Please find attached Invoice #${invoiceNumber || 'N/A'} from ${firmName} for $${formattedBalance}.`,
    ...(dueDate ? [`Due date: ${dueDate}`] : []),
    ...(amountPaid > 0 ? [`Amount paid to date: $${(amountPaid || 0).toFixed(2)}`] : []),
    '',
    ...(portalUrl ? [`View Invoice: ${portalUrl}`, ''] : []),
    `If you have any questions, please contact ${firmName} directly.`,
    '',
    '---',
    `This invoice was sent on behalf of ${firmName} via Paralegix.`,
  ].join('\n');

  const attachments = [];
  if (pdfBuffer && pdfFileName) {
    attachments.push({
      filename: pdfFileName,
      content: pdfBuffer,
    });
  }

  return sendEmail({ to: recipients, subject, html, text, fromName: firmName, attachments: attachments.length ? attachments : undefined });
}

/**
 * Send a new message notification email to a client.
 *
 * @param {Object} opts
 * @param {string} opts.recipientEmail
 * @param {string} opts.recipientName
 * @param {string} opts.lawFirmName
 * @param {string} opts.senderName
 * @param {string} [opts.messagePreview]
 * @param {string} opts.portalUrl
 */
export async function sendNewMessageNotificationEmail({
  recipientEmail,
  recipientName,
  lawFirmName,
  senderName,
  messagePreview,
  portalUrl,
}: any) {
  const safeName = escapeHtml(recipientName || 'there');
  const safeFirm = escapeHtml(lawFirmName || 'Your law firm');
  const safeSender = escapeHtml(senderName || 'Your attorney');
  const safePreview = messagePreview ? escapeHtml(messagePreview.substring(0, 200)) : '';
  const safeUrl = escapeHtml(portalUrl || '');

  const subject = `New message from ${lawFirmName || 'your law firm'}`;

  const previewBlock = safePreview
    ? `<tr><td style="padding:0 40px 24px;">
        <div style="background-color:#f9fafb;border-left:3px solid #4f46e5;border-radius:4px;padding:16px;font-size:14px;line-height:1.6;color:#374151;">${safePreview}</div>
      </td></tr>`
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
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">NEW MESSAGE</p>
  </td></tr>
  <tr><td style="padding:0 40px 24px;">
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi ${safeName},</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${safeSender} at <strong>${safeFirm}</strong> has sent you a new message in Paralegix.</p>
  </td></tr>
  ${previewBlock}
  <tr><td style="padding:0 40px 32px;">
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#6b7280;">Log in to your client portal to read the full message and reply.</p>
    <table role="presentation" cellpadding="0" cellspacing="0">
    <tr><td style="border-radius:8px;background-color:#4f46e5;">
      <a href="${safeUrl}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">View Message</a>
    </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">You're receiving this because you have messages in Paralegix. If you did not expect this, please contact your law firm.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    `Hi ${recipientName || 'there'},`,
    '',
    `${senderName || 'Your attorney'} at ${lawFirmName || 'your law firm'} has sent you a new message in Paralegix.`,
    safePreview ? `\n"${messagePreview}"\n` : '',
    'Log in to your client portal to read and reply:',
    portalUrl,
    '',
    'Paralegix',
  ].filter((l) => l !== undefined).join('\n');

  return sendEmail({ to: recipientEmail, subject, html, text });
}

/**
 * Digest email telling a client that one or more documents were shared with them
 * in the portal. Coalesced upstream (shareNotifications.service) so a burst of
 * shares produces a single email, never one per file.
 *
 * @param {Object} opts
 * @param {string} opts.recipientEmail
 * @param {string|null} opts.recipientName
 * @param {string} opts.lawFirmName
 * @param {number} opts.count            total documents shared in this digest
 * @param {Array<{name:string,isFolder?:boolean}>} opts.items  (up to a handful; overflow summarized)
 * @param {string} opts.portalUrl        deep link to the portal Documents view
 */
export async function sendFileSharedDigestEmail({
  recipientEmail,
  recipientName,
  lawFirmName,
  count,
  items,
  portalUrl,
  idempotencyKey,
}: any) {
  const safeName = escapeHtml(recipientName || 'there');
  const safeFirm = escapeHtml(lawFirmName || 'Your law firm');
  const safeUrl = escapeHtml(portalUrl || '');
  const total = Number(count) || (Array.isArray(items) ? items.length : 0);

  const noun = total === 1
    ? (items && items[0] && items[0].isFolder ? 'a folder' : 'a document')
    : `${total} new documents`;
  const subject = total === 1
    ? `${lawFirmName || 'Your law firm'} shared a document with you`
    : `${lawFirmName || 'Your law firm'} shared ${total} documents with you`;

  const NAMED = 8;
  const named = (Array.isArray(items) ? items : []).slice(0, NAMED);
  const overflow = total - named.length;
  const listRows = named
    .map((i) => `<tr><td style="padding:6px 0;font-size:14px;line-height:1.5;color:#374151;">
        ${i.isFolder ? '📁' : '📄'} ${escapeHtml(i.name || 'Document')}
      </td></tr>`)
    .join('');
  const overflowRow = overflow > 0
    ? `<tr><td style="padding:6px 0;font-size:14px;color:#6b7280;">and ${overflow} more</td></tr>`
    : '';
  const listBlock = named.length
    ? `<tr><td style="padding:0 40px 24px;">
        <div style="background-color:#f9fafb;border-left:3px solid #4f46e5;border-radius:4px;padding:12px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${listRows}${overflowRow}</table>
        </div>
      </td></tr>`
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
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">DOCUMENTS SHARED</p>
  </td></tr>
  <tr><td style="padding:0 40px 24px;">
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi ${safeName},</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;"><strong>${safeFirm}</strong> shared ${noun} with you in your Paralegix client portal.</p>
  </td></tr>
  ${listBlock}
  <tr><td style="padding:0 40px 32px;">
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#6b7280;">Log in to your client portal to view and download.</p>
    <table role="presentation" cellpadding="0" cellspacing="0">
    <tr><td style="border-radius:8px;background-color:#4f46e5;">
      <a href="${safeUrl}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">View Documents</a>
    </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">You're receiving this because a law firm shared documents with you in Paralegix. If you did not expect this, please contact your law firm.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    `Hi ${recipientName || 'there'},`,
    '',
    `${lawFirmName || 'Your law firm'} shared ${noun} with you in your Paralegix client portal.`,
    named.length ? '' : undefined,
    ...named.map((i) => `- ${i.name || 'Document'}`),
    overflow > 0 ? `- and ${overflow} more` : undefined,
    '',
    'Log in to your client portal to view and download:',
    portalUrl,
    '',
    'Paralegix',
  ].filter((l) => l !== undefined).join('\n');

  return sendEmail({ to: recipientEmail, subject, html, text, idempotencyKey });
}

/**
 * Ask a client to replenish their trust retainer after the balance fell below the
 * firm's minimum (evergreen retainer). Amounts are in dollars.
 *
 * @param {Object} opts
 * @param {string} opts.to               client email
 * @param {string|null} opts.recipientName
 * @param {string|null} opts.lawFirmName
 * @param {number} opts.balance          current trust balance (dollars)
 * @param {number} opts.minimum          configured minimum / target balance (dollars)
 * @param {number} opts.topUp            suggested amount to bring the balance back to the minimum (dollars)
 * @param {string|null} opts.portalUrl
 */
export async function sendTrustReplenishmentEmail({ to, recipientName, lawFirmName, balance, minimum, topUp, portalUrl }: any) {
  // `to` accepts an array: a company client's low-balance notice reaches every
  // billing recipient on its roster, not one linked login.
  const recipients = normalizeRecipients(to);
  if (recipients.length === 0) {
    console.warn('[emailService] Skipping trust replenishment email: no recipient address');
    return { sent: false };
  }

  const firmName = (lawFirmName && typeof lawFirmName === 'string' && lawFirmName.trim())
    ? lawFirmName.trim()
    : 'Your Law Firm';
  const fmt = (n: any) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const safeFirmName = escapeHtml(firmName);
  const safeRecipientName = recipientName ? escapeHtml(recipientName) : null;

  const subject = `Action needed: your retainer with ${firmName} is running low`;
  const greeting = safeRecipientName
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi ${safeRecipientName},</p>`
    : '';
  const topUpLine = topUp > 0
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">To continue work without interruption, please add at least <strong>$${fmt(topUp)}</strong> to bring your retainer back to <strong>$${fmt(minimum)}</strong>.</p>`
    : `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Please top up your retainer to at least <strong>$${fmt(minimum)}</strong> so work can continue without interruption.</p>`;
  const ctaBlock = portalUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
    <tr><td style="border-radius:8px;background-color:#4f46e5;">
      <a href="${escapeHtml(portalUrl)}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Replenish Retainer</a>
    </td></tr>
    </table>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
  <tr><td style="height:4px;background:linear-gradient(90deg,#d97706,#f59e0b);"></td></tr>
  <tr><td style="padding:40px 40px 0;">
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;">Paralegix</h1>
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">RETAINER LOW BALANCE</p>
  </td></tr>
  <tr><td style="padding:0 40px;">
    ${greeting}
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Your trust retainer with <strong>${safeFirmName}</strong> has a balance of <strong>$${fmt(balance)}</strong>, which is below the agreed minimum of <strong>$${fmt(minimum)}</strong>.</p>
    ${topUpLine}
    ${ctaBlock}
    <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#9ca3af;">Contact ${safeFirmName} if you have any questions about your retainer.</p>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This notice was sent on behalf of ${safeFirmName} via Paralegix.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    subject,
    '',
    `Your trust retainer with ${firmName} has a balance of $${fmt(balance)}, below the agreed minimum of $${fmt(minimum)}.`,
    topUp > 0
      ? `Please add at least $${fmt(topUp)} to bring your retainer back to $${fmt(minimum)}.`
      : `Please top up your retainer to at least $${fmt(minimum)}.`,
    '',
    ...(portalUrl ? [`Replenish Retainer: ${portalUrl}`, ''] : []),
    '---',
    `This notice was sent on behalf of ${firmName} via Paralegix.`,
  ].join('\n');

  return sendEmail({ to: recipients, subject, html, text });
}

/* ------------------------------------------------------------------------- *
 * Daily digest
 * ------------------------------------------------------------------------- */

/** App origin for digest links, without a trailing slash. */
function digestFrontendBase() {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/** Day buckets in render order, with the marker and heading each one carries. */
const DIGEST_SECTIONS = [
  { key: 'overdue', marker: '🔴', label: 'OVERDUE' },
  { key: 'today', marker: '🟠', label: 'DUE TODAY' },
  { key: 'tomorrow', marker: '🟡', label: 'TOMORROW' },
  { key: 'week', marker: '📅', label: 'REST OF THIS WEEK' },
];

/**
 * Midnight-UTC epoch for a 'YYYY-MM-DD' string, or null when it is not one.
 *
 * Day-only values are anchored to UTC rather than parsed in the server's local
 * zone, so formatting and day arithmetic can never shift a date across a
 * boundary and print the day before the one the digest actually bucketed.
 */
function digestDayMs(day: any) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || '').slice(0, 10));
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** 'YYYY-MM-DD' as e.g. "Tuesday, July 28", or '' when it is not a valid day. */
function digestLongDay(day: any) {
  const ms = digestDayMs(day);
  if (ms === null) return '';
  return new Date(ms).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

/** 'YYYY-MM-DD' as e.g. "Aug 3", or '' when it is not a valid day. */
function digestShortDay(day: any) {
  const ms = digestDayMs(day);
  if (ms === null) return '';
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

/** Whole days from `from` to `to`, or null when either is not a valid day. */
function digestDaysBetween(from: any, to: any) {
  const a = digestDayMs(from);
  const b = digestDayMs(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86400000);
}

/** Integer cents as a US dollar string, e.g. `$1,204.50`. */
function digestAmount(cents: any) {
  const value = Number(cents);
  const dollars = Number.isFinite(value) ? value / 100 : 0;
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Only absolute http(s) links are rendered. Every URL in the digest is built by
 * the digest module, so a value that is not one means the payload is malformed;
 * dropping it renders the row as plain text rather than emitting an empty or
 * relative `href`, which in a mail client resolves against the reader's own
 * webmail origin and lands them somewhere unrelated.
 */
function digestSafeUrl(url: any) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * A timestamptz as a clock time in the recipient's zone, e.g. "9:00 AM".
 *
 * Intl separates the meridiem with a narrow no-break space, which survives into
 * the message body and renders as a stray glyph in clients that lack the font;
 * it is normalised to an ordinary space. An unusable zone falls back to UTC
 * rather than throwing, since a wrong hour is still more useful than an email
 * that fails to build.
 */
function digestTimeOfDay(at: any, timezone: any) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const format = (zone: any) =>
    date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone })
      .replace(/[  ]/g, ' ');
  try {
    return format(timezone || 'UTC');
  } catch {
    return format('UTC');
  }
}

/**
 * The right-hand detail on a row: WHEN the reader has to deal with it.
 *
 * Anything past due is judged by how far past, and everything else by the day it
 * lands on. A timed event also carries its clock time, because the difference
 * between a 9am deposition and an all-day court date is the whole reason the row
 * is in a deadline digest; an all-day event has no meaningful time to show.
 *
 * An invoice's balance is NOT here — it goes in the row's sub-line (see
 * `digestItemSubtext`) so this column stays uniformly temporal. Under OVERDUE,
 * where every neighbouring row reads "19d late", an invoice showing only a
 * dollar figure drops the one fact that column exists to carry.
 */
function digestItemDetail(item: any, localDate: any, timezone: any) {
  const day = String(item?.day || '').slice(0, 10);
  if (day && localDate && day < localDate) {
    const late = digestDaysBetween(day, localDate);
    return late && late > 0 ? `${late}d late` : 'late';
  }

  const shortDay = digestShortDay(day);
  if (item?.kind === 'event' && item.allDay !== true && item.at) {
    const time = digestTimeOfDay(item.at, timezone);
    if (shortDay && time) return `${shortDay}, ${time}`;
    return time || shortDay;
  }
  return shortDay;
}

/**
 * The muted line under a row's title: the matter it belongs to, and for an
 * invoice its outstanding balance, so "how much" travels with the row while the
 * detail column carries "when".
 */
function digestItemSubtext(item: any) {
  const parts = [];
  if (item?.matterName) parts.push(String(item.matterName));
  if (item?.kind === 'invoice') parts.push(digestAmount(item.amountCents));
  return parts.join(' · ');
}

/** Identity of a digest row, for matching the same item across two sections. */
function digestItemKey(item: any) {
  return `${item?.kind || ''}:${item?.id ?? ''}`;
}

/**
 * Build the digest's subject line.
 *
 * Overdue and due-today are the only counts worth an inbox preview — a subject
 * that leads with "9 this week" reads as noise and trains the recipient to skip
 * it. With neither, the digest is pure lookahead and says so.
 */
function digestSubject(buckets: any, totalItems: any) {
  const overdue = Number(buckets?.overdue?.total) || 0;
  const today = Number(buckets?.today?.total) || 0;

  const parts = [];
  if (overdue > 0) parts.push(`${overdue} overdue`);
  if (today > 0) parts.push(`${today} due today`);
  if (parts.length > 0) return `Your day: ${parts.join(', ')}`;

  const upcoming = Number(totalItems) || 0;
  return `Your day: ${upcoming} upcoming`;
}

/** "4 overdue · 3 today · 2 tomorrow · 9 this week", skipping empty buckets. */
function digestSummaryParts(buckets: any) {
  const labels = { overdue: 'overdue', today: 'today', tomorrow: 'tomorrow', week: 'this week' };
  const parts = [];
  for (const { key } of DIGEST_SECTIONS) {
    const total = Number(buckets?.[key]?.total) || 0;
    if (total > 0) parts.push(`${total} ${(labels as Record<string, string>)[key]}`);
  }
  return parts;
}

/** One item row: linked title, muted sub-line, right-aligned detail. */
function digestRowHtml(item: any, localDate: any, accentColor: any, timezone: any) {
  const title = escapeHtml(item?.title || 'Untitled');
  const url = digestSafeUrl(item?.url);
  const titleHtml = url
    ? `<a href="${escapeHtml(url)}" style="color:${accentColor};text-decoration:none;font-weight:600;">${title}</a>`
    : `<span style="color:#111827;font-weight:600;">${title}</span>`;
  const subtext = digestItemSubtext(item);
  const matter = subtext
    ? `<div style="margin:2px 0 0;font-size:12px;line-height:1.4;color:#9ca3af;">${escapeHtml(subtext)}</div>`
    : '';
  const detail = escapeHtml(digestItemDetail(item, localDate, timezone));

  return `<tr>
  <td style="padding:10px 12px 10px 0;border-bottom:1px solid #f3f4f6;font-size:14px;line-height:1.4;">
    ${titleHtml}${matter}
  </td>
  <td align="right" valign="top" style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:12px;line-height:1.4;color:#6b7280;white-space:nowrap;">${detail}</td>
</tr>`;
}

/**
 * A day bucket: heading, rows, and the overflow link when it was truncated.
 *
 * Rows already printed in the critical block are dropped here rather than
 * repeated verbatim under a second heading, and are replaced by a muted count.
 * The heading still shows `bucket.total`, which includes them: the counts are
 * what the subject line and the summary are built from, so a bucket that hid a
 * row must still say how many items the day actually holds.
 */
function digestSectionHtml(section: any, bucket: any, localDate: any, timezone: any, skipKeys: any) {
  const shown = Array.isArray(bucket?.shown) ? bucket.shown : [];
  if (shown.length === 0) return '';

  const skip = skipKeys instanceof Set ? skipKeys : new Set();
  const visible = shown.filter((item: any) => !skip.has(digestItemKey(item)));
  const suppressed = shown.length - visible.length;

  const total = Number(bucket?.total) || shown.length;
  const rowsHtml = visible.length > 0
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${visible.map((item: any) => digestRowHtml(item, localDate, '#4f46e5', timezone)).join('\n')}
  </table>`
    : '';
  const suppressedHtml = suppressed > 0
    ? `<p style="margin:${visible.length > 0 ? '10px' : '0'} 0 0;font-size:12px;line-height:1.4;color:#9ca3af;">${suppressed} ${suppressed === 1 ? 'item' : 'items'} shown above under Critical deadlines.</p>`
    : '';

  const moreUrl = digestSafeUrl(bucket?.moreUrl);
  const more = Number(bucket?.more) || 0;
  const moreHtml = more > 0 && moreUrl
    ? `<p style="margin:10px 0 0;font-size:13px;"><a href="${escapeHtml(moreUrl)}" style="color:#4f46e5;text-decoration:none;font-weight:600;">+ ${more} more &rarr;</a></p>`
    : '';

  return `<tr><td style="padding:24px 40px 0;">
  <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:0.05em;color:#6b7280;">${section.marker} ${section.label} (${total})</p>
  ${rowsHtml}${suppressedHtml}${moreHtml}
</td></tr>`;
}

/**
 * The critical block: statute dates and court dates, led with and never
 * truncated. Rendered on its own red-tinted card so it cannot be mistaken for
 * one of the ordinary day buckets below it.
 */
function digestCriticalHtml(bucket: any, localDate: any, timezone: any) {
  const shown = Array.isArray(bucket?.shown) ? bucket.shown : [];
  if (shown.length === 0) return '';

  const rows = shown.map((item: any) => digestRowHtml(item, localDate, '#b91c1c', timezone)).join('\n');

  return `<tr><td style="padding:24px 40px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border-left:3px solid #dc2626;border-radius:6px;">
    <tr><td style="padding:16px 18px;">
      <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:0.05em;color:#b91c1c;">&#9878; CRITICAL DEADLINES</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${rows}
      </table>
    </td></tr>
  </table>
</td></tr>`;
}

/** Plain-text form of one item: its line, then its URL on a line of its own. */
function digestRowText(item: any, localDate: any, timezone: any) {
  const detail = digestItemDetail(item, localDate, timezone);
  const subtext = digestItemSubtext(item);
  const label = [
    item?.title || 'Untitled',
    subtext ? `(${subtext})` : '',
    detail ? `- ${detail}` : '',
  ].filter(Boolean).join(' ');

  const url = digestSafeUrl(item?.url);
  return url ? [`- ${label}`, `  ${url}`] : [`- ${label}`];
}

/**
 * Render the daily digest into `{ subject, html, text }`.
 *
 * Split out from the sender so the markup can be produced — and inspected — with
 * no mail transport, no database and no network involved.
 *
 * Every interpolated value is user-controlled (matter names, task titles, the
 * firm's own name) and this email is delivered to an external inbox, so the HTML
 * side escapes without exception. The text side deliberately does not: entity
 * encoding in a text/plain part shows up literally as `&amp;`.
 *
 * @param {object} opts
 * @param {string|null} opts.recipientName
 * @param {string} opts.lawFirmId
 * @param {string|null} opts.lawFirmName
 * @param {string} opts.localDate  recipient's local day, 'YYYY-MM-DD'
 * @param {string} opts.timezone   IANA zone the digest was bucketed in
 * @param {object} opts.buckets    `{ critical, overdue, today, tomorrow, week }`,
 *   each `{ shown, more, total, moreUrl }` with `url` already on every shown item
 * @param {number} opts.totalItems count across the day buckets before truncation
 */
export function buildDailyDigestEmail({ recipientName, lawFirmId, lawFirmName, localDate, timezone, buckets, totalItems }: any) {
  const base = digestFrontendBase();
  const firmId = String(lawFirmId || '');
  const dashboardUrl = `${base}/lawfirm/${encodeURIComponent(firmId)}`;
  const settingsUrl = `${dashboardUrl}/notifications`;

  const name = recipientName || 'there';
  const firmName = lawFirmName || 'Your Law Firm';
  const zone = timezone || 'UTC';
  const dateLine = digestLongDay(localDate);

  const subject = digestSubject(buckets, totalItems);
  const summaryParts = digestSummaryParts(buckets);
  const summary = summaryParts.length > 0 ? `${name} — ${summaryParts.join(' · ')}` : name;

  // Critical items are a parallel collection: each one also belongs to a day
  // bucket. Printing it in both places produces the identical line twice under
  // two headings, so the day bucket renders a note in its place.
  const criticalShownItems = Array.isArray(buckets?.critical?.shown) ? buckets.critical.shown : [];
  const criticalKeys = new Set(criticalShownItems.map(digestItemKey));

  const sectionsHtml = DIGEST_SECTIONS
    .map((section) => digestSectionHtml(section, buckets?.[section.key], localDate, zone, criticalKeys))
    .join('\n');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px;">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">
  <tr><td style="height:4px;background:linear-gradient(90deg,#4f46e5,#6366f1);"></td></tr>
  <tr><td style="padding:40px 40px 0;">
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;">Paralegix</h1>
    <p style="margin:0 0 20px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">DAILY DIGEST</p>
    ${dateLine ? `<p style="margin:0 0 4px;font-size:17px;font-weight:600;color:#111827;">${escapeHtml(dateLine)}</p>` : ''}
    <p style="margin:0;font-size:14px;line-height:1.6;color:#6b7280;">Hi ${escapeHtml(summary)}</p>
  </td></tr>
${digestCriticalHtml(buckets?.critical, localDate, zone)}
${sectionsHtml}
  <tr><td style="padding:32px 40px 36px;">
    <table role="presentation" cellpadding="0" cellspacing="0">
      <tr><td style="border-radius:6px;background:#4f46e5;">
        <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;color:#fff;text-decoration:none;">Open your dashboard</a>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#9ca3af;text-align:center;">This digest was sent by Paralegix on behalf of ${escapeHtml(firmName)}. Deadlines were calculated in the ${escapeHtml(zone)} time zone.</p>
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;"><a href="${escapeHtml(settingsUrl)}" style="color:#6b7280;text-decoration:underline;">Digest settings</a></p>
  </td></tr>
</table>
</td></tr></table>
</body>
</html>`;

  const lines = [subject, ''];
  if (dateLine) lines.push(dateLine);
  lines.push(`Hi ${summary}`, '');

  if (criticalShownItems.length > 0) {
    lines.push('CRITICAL DEADLINES');
    for (const item of criticalShownItems) lines.push(...digestRowText(item, localDate, zone));
    lines.push('');
  }

  for (const section of DIGEST_SECTIONS) {
    const bucket = buckets?.[section.key];
    const shown = Array.isArray(bucket?.shown) ? bucket.shown : [];
    if (shown.length === 0) continue;

    const visible = shown.filter((item: any) => !criticalKeys.has(digestItemKey(item)));
    const suppressed = shown.length - visible.length;

    lines.push(`${section.label} (${Number(bucket?.total) || shown.length})`);
    for (const item of visible) lines.push(...digestRowText(item, localDate, zone));
    if (suppressed > 0) {
      lines.push(`(${suppressed} ${suppressed === 1 ? 'item' : 'items'} shown above under Critical deadlines)`);
    }

    const moreUrl = digestSafeUrl(bucket?.moreUrl);
    const more = Number(bucket?.more) || 0;
    if (more > 0 && moreUrl) lines.push(`+ ${more} more: ${moreUrl}`);
    lines.push('');
  }

  lines.push(
    `Open your dashboard: ${dashboardUrl}`,
    '',
    `This digest was sent by Paralegix on behalf of ${firmName}. Deadlines were calculated in the ${zone} time zone.`,
    `Digest settings: ${settingsUrl}`,
  );

  return { subject, html, text: lines.join('\n') };
}

/**
 * Send one recipient's daily digest: everything overdue and due soon in their
 * own local day, in a single message that replaces the per-item reminder blast.
 *
 * Assembled by `modules/notifications/digest`, which hands over buckets whose
 * items already carry their deep links; this function renders them and never
 * builds a URL for an item itself.
 */
export async function sendDailyDigestEmail({ to, recipientName, lawFirmId, lawFirmName, localDate, timezone, buckets, totalItems }: any) {
  initResend();
  if (!emailReady || !to) return { sent: false };

  const { subject, html, text } = buildDailyDigestEmail({
    recipientName, lawFirmId, lawFirmName, localDate, timezone, buckets, totalItems,
  });

  return sendEmail({ to, subject, html, text, lawFirmId, category: 'digest' });
}

/**
 * Email a lead a link to fill out an intake form (targeted send).
 */
export async function sendIntakeFormEmail({
  to,
  firmName,
  formName,
  recipientName,
  link,
  lawFirmId,
}: any) {
  if (!to || typeof to !== 'string' || !to.trim()) {
    console.warn('[emailService] Skipping intake form email: no recipient address');
    return { sent: false };
  }

  const safeFirm = escapeHtml((firmName && String(firmName).trim()) || 'Your Law Firm');
  const safeForm = escapeHtml((formName && String(formName).trim()) || 'Intake Form');
  const safeName = recipientName ? escapeHtml(String(recipientName).trim()) : null;
  const greeting = safeName ? `Hi ${safeName},` : 'Hello,';

  const subject = `${(firmName && String(firmName).trim()) || 'Your law firm'} — please complete ${
    (formName && String(formName).trim()) || 'an intake form'
  }`;

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
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">INTAKE FORM</p>
  </td></tr>
  <tr><td style="padding:0 40px;">
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${greeting}</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;"><strong>${safeFirm}</strong> has asked you to complete <strong>${safeForm}</strong>.</p>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#6b7280;">Click the button below to open the form. It only takes a few minutes.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
    <tr><td style="border-radius:8px;background-color:#4f46e5;">
      <a href="${escapeHtml(link || '')}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Open Form</a>
    </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This message was sent by ${safeFirm} via Paralegix. If you did not expect this email, you can safely ignore it.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    subject,
    '',
    greeting.replace(/<[^>]+>/g, ''),
    '',
    `${(firmName && String(firmName).trim()) || 'Your law firm'} has asked you to complete ${(formName && String(formName).trim()) || 'an intake form'}.`,
    '',
    `Open Form: ${link || ''}`,
    '',
    '---',
    `This message was sent by ${(firmName && String(firmName).trim()) || 'Your law firm'} via Paralegix.`,
  ].join('\n');

  // Required lazily for the same load-order reason as in sendEmail.
  const { EMAIL_CATEGORIES } = require('./emailPreferences');
  return sendEmail({ to, subject, html, text, lawFirmId, category: EMAIL_CATEGORIES.INTAKE_FORM });
}
