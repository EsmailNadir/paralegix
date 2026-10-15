/**
 * Subscription event listeners. Alert the firm's owners/admins when their
 * Paralegix subscription needs attention (a failed charge or an ending trial):
 * an in-app notification plus an email to firm admins. Firm-side only; not gated
 * by any client-facing setting. Every listener is async, isolated, and swallows
 * its own errors so a notification failure never affects webhook processing.
 */

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { members, roles } from '../../shared/database/drizzle/schema';
import { tenantQuery } from '../../shared/database/queryContext';
import { runWithConcurrency } from '../../shared/utils/runWithConcurrency';
const eventBus = require('../../shared/events/eventBus');
const {
  SUBSCRIPTION_PAYMENT_FAILED,
  SUBSCRIPTION_TRIAL_ENDING,
} = require('../../shared/events/eventTypes');
const lawfirmsRepo = require('../lawfirms/lawfirms.repository');
const usersRepo = require('../users/users.repository');
const { createNotifications, FRONTEND_URL } = require('../notifications/notifications.service');
const { sendEmail } = require('../../shared/services/emailService');

// Owners + admin/partner members of a firm (user ids), for in-app notifications.
async function getFirmAdminUserIds(lawFirmId: string) {
  const rows = await tenantQuery(
    members,
    lawFirmId,
    ({ executor, scope }) => executor
      .selectDistinct({ userId: members.userId })
      .from(members)
      .leftJoin(roles, and(eq(roles.id, members.roleId), eq(roles.lawFirmId, members.lawFirmId)))
      .where(and(
        scope,
        or(eq(members.isOwner, true), inArray(sql`lower(${roles.name})`, ['admin', 'owner', 'partner'])),
      )),
  );
  return rows.map((row) => row.userId).filter(Boolean);
}
// Send a plain firm-admin alert email to every admin recipient. Best-effort.
async function emailFirmAdmins(lawFirmId: string, firmName: any, subject: any, message: any, ctaUrl: any) {
  const admins = await usersRepo.getFirmAdminRecipients(lawFirmId);
  if (!admins.length) return;
  const safeMessage = message;
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
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;letter-spacing:0.05em;">SUBSCRIPTION</p>
  </td></tr>
  <tr><td style="padding:0 40px 32px;">
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${safeMessage}</p>
    <p style="margin:0;"><a href="${ctaUrl}" style="display:inline-block;padding:10px 24px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Manage subscription</a></p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  const text = [subject, '', safeMessage.replace(/<[^>]*>/g, ''), '', ctaUrl].join('\n');
  // Three admins at a time: each send runs its own recipient-cap check against
  // the shared pool. The first failure still rejects, as the caller expects.
  const sends = await runWithConcurrency(
    admins.map(({ email }: any) => () => sendEmail({ to: email, subject, html, text })),
    3,
  );
  const failedSend = sends.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failedSend) throw failedSend.reason;
}
/**
 * A subscription charge failed: the firm is now past_due. Alert owners/admins so
 * they can update the payment method before access is restricted.
 */
eventBus.on(SUBSCRIPTION_PAYMENT_FAILED, async ({ lawFirmId }: any) => {
  try {
    if (!lawFirmId) return;
    const recipients = await getFirmAdminUserIds(lawFirmId);
    const ctaUrl = `${FRONTEND_URL}/lawfirm/${lawFirmId}/settings/billing`;
    const body = 'A subscription payment failed and your account is now past due. '
      + 'Update your payment method to avoid an interruption in service.';

    if (recipients.length) {
      await createNotifications(lawFirmId, recipients, {
        type: 'subscription_payment_failed',
        title: 'Subscription payment failed',
        body,
        actionUrl: ctaUrl,
      });
    }

    const firm = await lawfirmsRepo.findById(lawFirmId);
    await emailFirmAdmins(lawFirmId, firm?.name || null, 'Your Paralegix subscription payment failed', body, ctaUrl);
  } catch (err: any) {
    console.error('subscriptions.events: SUBSCRIPTION_PAYMENT_FAILED handler error:', err?.message || err);
  }
});

/**
 * A subscription trial is ending soon. Remind owners/admins so they can confirm a
 * payment method before the trial converts.
 */
eventBus.on(SUBSCRIPTION_TRIAL_ENDING, async ({ lawFirmId, trialEnd }: any) => {
  try {
    if (!lawFirmId) return;
    const recipients = await getFirmAdminUserIds(lawFirmId);
    const ctaUrl = `${FRONTEND_URL}/lawfirm/${lawFirmId}/settings/billing`;
    const endDate = trialEnd ? String(trialEnd).split('T')[0] : null;
    const body = `Your Paralegix free trial is ending${endDate ? ` on ${endDate}` : ' soon'}. `
      + 'Confirm your payment method to keep your plan active.';

    if (recipients.length) {
      await createNotifications(lawFirmId, recipients, {
        type: 'subscription_trial_ending',
        title: 'Trial ending soon',
        body,
        actionUrl: ctaUrl,
      });
    }

    const firm = await lawfirmsRepo.findById(lawFirmId);
    await emailFirmAdmins(lawFirmId, firm?.name || null, 'Your Paralegix trial is ending soon', body, ctaUrl);
  } catch (err: any) {
    console.error('subscriptions.events: SUBSCRIPTION_TRIAL_ENDING handler error:', err?.message || err);
  }
});

// This module only registers listeners; it exports nothing. The empty
// export marks it as a MODULE so its top-level consts are file-scoped
// rather than colliding in the global scope with every other events file.
export {};
