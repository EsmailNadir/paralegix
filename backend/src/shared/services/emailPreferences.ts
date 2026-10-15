/**
 * The single gate every non-transactional outbound email passes through.
 *
 * Three preference layers apply here, though they are not all equally real yet:
 *
 *   - the firm master switch (`law_firms.settings.emailNotificationsEnabled`) -
 *     already an accepted key on the firm settings PUT (see
 *     `settings.service.js` WRITABLE_FIRM_KEYS), but with no UI control to flip
 *     it yet.
 *   - the per-client category map (`clients.settings.notifications.emailOn*`) -
 *     written by the client portal settings page and read by the automatic
 *     client-facing senders through `shouldSendClientEmail`: the new-message
 *     notification (messaging.service), the file-share digest
 *     (files/shareNotifications.service) and the document-request notice
 *     (documentRequests.events). A company-linked person is a real `clients`
 *     row of their own (`client_company_links`), so this is the ONE map every
 *     client uid resolves through - there is no separate per-link fallback.
 *
 *     `emailOnNewInvoice` has no automatic sender to gate. The only thing that
 *     mails a client an invoice is a firm member clicking "send" on it
 *     (`invoiceReminders.service#sendInvoiceToEmail`), and silently dropping a
 *     send the sender was told went out is worse than the toggle not applying.
 *     Same reasoning for invoice reminders, which are dunning mail the firm
 *     depends on. Wire this key up if an automatic issue-time email is ever added.
 *   - the per-user category map (`users.preferences.notifications.email`)
 *     - introduced by this module. `settings.defaults.js` and
 *       `settings.validation.js` now ship a default shape and validation for it,
 *       but there is still no frontend control that writes it. Until that
 *       lands, every user effectively resolves to the shipped default (all
 *       categories enabled) since nothing stores an explicit override.
 *
 * Every outbound email carries a CAN-SPAM footer advertising an opt-out at
 * /settings, so these toggles are not cosmetic - they are the promise the
 * footer makes.
 *
 * Layering, most restrictive first: firm switch off suppresses everything
 * non-transactional for that firm; otherwise the recipient's own category
 * preference decides. Absent preferences mean enabled, matching how the in-app
 * fan-out already behaves (`notifications.service.js#filterByPreference`).
 */

const { infrastructureRootSql, infrastructureSql, withDrizzleTransaction } = require('../database/infrastructureQuery');
const { isUuid } = require('../utils/isUuid');
const { DEFAULTS } = require('../../modules/settings/settings.defaults');
const settingsRepo = require('../../modules/settings/settings.repository');

/**
 * Stable category ids. A sender passes one of these. A string that isn't one of
 * these values is not transactional (isTransactionalCategory returns false for
 * anything not in TRANSACTIONAL below), but neither resolveUserCategory nor
 * resolveClientCategory has a matching preference key for it, so it falls
 * through their default and resolves to ENABLED - it is never silently
 * suppressed, just not gate-able until a real toggle is added for it. Passing
 * one of these logs a warning (see warnIfUnknown) so a typo'd category string
 * doesn't go unnoticed indefinitely.
 */
export const EMAIL_CATEGORIES = Object.freeze({
  // Gated - the recipient can turn these off.
  //
  // `digest` is the one category with no matching key in
  // `DEFAULTS.user.notifications.email`, and it must stay that way. The digest's
  // per-user switch is `notifications.digest.enabled`; adding a second boolean
  // here would let the schedule and the channel disagree, and a user with the
  // schedule on and the channel off would receive neither the digest nor the
  // individual task reminders it suppresses. This id exists so the digest still
  // passes through the FIRM-level switch in `sendEmail`, which is firm-wide and
  // cannot contradict a per-user setting.
  DIGEST: 'digest',
  TASK_ASSIGNED: 'taskAssigned',
  TASK_DUE: 'taskDue',
  MENTION: 'mention',
  MESSAGE: 'message',
  MATTER_ADDED: 'matterAdded',
  MATTER_UPDATE: 'matterUpdate',
  INVOICE_ISSUED: 'invoiceIssued',
  INVOICE_REMINDER: 'invoiceReminder',
  INVOICE_PAID: 'invoicePaid',
  DOCUMENT_UPLOADED: 'documentUploaded',
  DOCUMENT_REQUESTED: 'documentRequested',
  FILE_SHARED: 'fileShared',
  SIGNING_COMPLETED: 'signingCompleted',
  SIGNING_DECLINED: 'signingDeclined',
  EVENT_REMINDER: 'eventReminder',

  // Transactional - never gated. See TRANSACTIONAL below.
  INVITATION: 'invitation',
  PAYMENT_RECEIPT: 'paymentReceipt',
  PAYMENT_REQUEST: 'paymentRequest',
  PAYMENT_REFUNDED: 'paymentRefunded',
  SIGNING_INVITE: 'signingInvite',
  SIGNING_COPY: 'signingCopy',
  INTAKE_FORM: 'intakeForm',
  TRUST_ALERT: 'trustAlert',
  SUBSCRIPTION_ALERT: 'subscriptionAlert',
});

const VALID_CATEGORIES = new Set(Object.values(EMAIL_CATEGORIES));

/**
 * Categories a recipient may never opt out of.
 *
 * These carry information the recipient needs to transact or to keep an account
 * working: an invitation they requested, proof of a payment they made, a document
 * they were asked to sign, an intake form a firm member explicitly sent them, notice that the firm's subscription or a trust balance
 * needs attention. Suppressing them would break the product or lose money, and
 * CAN-SPAM's opt-out requirement covers commercial messages, not transactional
 * ones. Everything else is gated.
 */
const TRANSACTIONAL = new Set([
  EMAIL_CATEGORIES.INVITATION,
  EMAIL_CATEGORIES.PAYMENT_RECEIPT,
  EMAIL_CATEGORIES.PAYMENT_REQUEST,
  EMAIL_CATEGORIES.PAYMENT_REFUNDED,
  EMAIL_CATEGORIES.SIGNING_INVITE,
  EMAIL_CATEGORIES.SIGNING_COPY,
  EMAIL_CATEGORIES.INTAKE_FORM,
  EMAIL_CATEGORIES.TRUST_ALERT,
  EMAIL_CATEGORIES.SUBSCRIPTION_ALERT,
]);

/**
 * Client-portal settings use their own legacy key names. Map onto them.
 *
 * `invoiceReminder` is deliberately NOT mapped to `emailOnNewInvoice`. That
 * checkbox is labelled "Email on new invoice" in the client portal (see
 * frontend `client/lawfirm/[lawFirmId]/settings/page.tsx`) - it promises
 * nothing about reminders on an invoice the client already has. A reminder is
 * dunning mail the firm depends on to get paid; muting it is a separate
 * decision that needs its own control, not a side effect of muting new-invoice
 * notices. Left unmapped, it resolves to enabled (see resolveClientCategory).
 */
const CLIENT_CATEGORY_KEYS = {
  [EMAIL_CATEGORIES.INVOICE_ISSUED]: 'emailOnNewInvoice',
  [EMAIL_CATEGORIES.MESSAGE]: 'emailOnNewMessage',
  [EMAIL_CATEGORIES.MATTER_UPDATE]: 'emailOnMatterUpdate',
  [EMAIL_CATEGORIES.FILE_SHARED]: 'emailOnFileShared',
};

export function isTransactionalCategory(category: any) {
  return TRANSACTIONAL.has(category);
}

// A category outside EMAIL_CATEGORIES has no stored toggle anywhere, so it
// always resolves to enabled - warn rather than throw, since a bad category
// string must never break a send path.
function warnIfUnknown(category: any, fnName: any) {
  if (category && !VALID_CATEGORIES.has(category)) {
    console.warn(`[emailPreferences] "${category}" passed to ${fnName} is not a value in EMAIL_CATEGORIES`);
  }
}

/**
 * Decide one user category from an already-loaded `users.preferences`
 * blob. Pure - no IO - so the fan-out can load preferences once and ask many
 * times. A null/absent category is un-gateable and always enabled.
 *
 * Fallback order when there is no explicit stored value: the shipped default
 * for that category (`DEFAULTS.user.notifications.email.<category>`, absent
 * for now - see the module header) and, failing that, enabled.
 */
export function resolveUserCategory(preferences: any, category: any) {
  if (!category) return true;
  warnIfUnknown(category, 'resolveUserCategory');
  if (isTransactionalCategory(category)) return true;
  const stored = preferences?.notifications?.email;
  if (stored && category in stored) return stored[category] !== false;
  const shippedDefault = DEFAULTS.user?.notifications?.email?.[category];
  return shippedDefault !== false;
}

/**
 * Decide one client category from an already-loaded `clients.settings` blob.
 * Unmapped categories are enabled: a client has no toggle for them, so there is
 * no opt-out to honor.
 */
export function resolveClientCategory(settings: any, category: any) {
  if (!category) return true;
  warnIfUnknown(category, 'resolveClientCategory');
  if (isTransactionalCategory(category)) return true;
  const key = (CLIENT_CATEGORY_KEYS as Record<string, string | undefined>)[category];
  if (!key) return true;
  const stored = settings?.notifications;
  if (stored && key in stored) return stored[key] !== false;
  return DEFAULTS.client.notifications[key] !== false;
}

/**
 * Firm master switch. Absent means enabled. Any DB failure (or a malformed id)
 * fails OPEN so an outage never silently suppresses mail the firm is expecting
 * - the same posture as the per-recipient send cap in emailService.
 */
export async function isFirmEmailEnabled(lawFirmId: string) {
  if (!lawFirmId || !isUuid(lawFirmId)) return true;
  try {
    const { rows } = await infrastructureRootSql(
      `select settings from law_firms where id = $1 limit 1`,
      [lawFirmId]
    );
    const settings = rows[0]?.settings || {};
    return settings.emailNotificationsEnabled !== false;
  } catch (err: any) {
    console.error('[emailPreferences] firm switch lookup failed (allowing send):', err.message);
    return true;
  }
}

/**
 * One user's category decision. Delegates the read to the settings repository
 * (`settingsRepo.getUserSettings`) rather than re-issuing its SQL, so there is
 * one place that knows the `users.preferences` shape. Fails open.
 */
export async function isUserEmailCategoryEnabled(userId: string, category: any) {
  if (!userId || !category) return true;
  if (isTransactionalCategory(category)) return true;
  try {
    const preferences = await settingsRepo.getUserSettings(userId);
    return resolveUserCategory(preferences, category);
  } catch (err: any) {
    console.error('[emailPreferences] user preference lookup failed (allowing send):', err.message);
    return true;
  }
}

/**
 * One client's category decision, loading their settings. A missing client row
 * (bad id, wrong firm, deleted client) is treated the same as "no stored
 * preference" - enabled - never as an implicit opt-out. Fails open on a
 * malformed id or a DB error too.
 */
export async function isClientEmailCategoryEnabled(lawFirmId: string, clientId: string, category: any) {
  if (!lawFirmId || !clientId || !category) return true;
  if (isTransactionalCategory(category)) return true;
  if (!isUuid(lawFirmId) || !isUuid(clientId)) return true;
  try {
    const { rows } = await infrastructureRootSql(
      `select settings from clients where law_firm_id = $1 and id = $2 limit 1`,
      [lawFirmId, clientId]
    );
    if (!rows[0]) return true;
    return resolveClientCategory(rows[0].settings || {}, category);
  } catch (err: any) {
    console.error('[emailPreferences] client preference lookup failed (allowing send):', err.message);
    return true;
  }
}

/**
 * Same decision as `isClientEmailCategoryEnabled`, but keyed on the client's
 * PORTAL USER ID rather than their `clients` row id.
 *
 * Most automatic client-facing senders only ever hold the portal uid (it is what
 * the conversation, the share buffer, and the request payload carry), so without
 * this they would each have to re-derive the row id before they could ask about a
 * preference. Fails open on a missing row or a DB error, exactly like the by-id
 * variant.
 *
 * A company-linked person is a real `clients` row of their own
 * (`client_company_links`), so this one lookup covers every uid - a standalone
 * person client and a company-linked one alike. A uid resolving to more than
 * one row (shouldn't normally happen) ties to the oldest, mirroring the
 * by-id variant's tie-break.
 */
export async function isClientEmailCategoryEnabledByUserId(lawFirmId: string, clientUserId: string, category: any) {
  if (!lawFirmId || !clientUserId || !category) return true;
  if (isTransactionalCategory(category)) return true;
  if (!isUuid(lawFirmId)) return true;
  try {
    const { rows } = await infrastructureRootSql(
      `select settings from clients where law_firm_id = $1 and user_id = $2
        order by created_at asc limit 1`,
      [lawFirmId, clientUserId]
    );
    if (!rows[0]) return true;
    return resolveClientCategory(rows[0].settings || {}, category);
  } catch (err: any) {
    console.error('[emailPreferences] client preference lookup by user id failed (allowing send):', err.message);
    return true;
  }
}

/**
 * The one call an automatic client-facing sender makes before it mails a client:
 * the firm master switch AND the client's own category toggle, in that order.
 *
 * Identify the client by whichever id the caller happens to hold — `clientId`
 * (the `clients` row id) or `clientUserId` (their portal uid). Supplying neither
 * still applies the firm switch, which is the correct floor for a send to an
 * address with no client record behind it.
 *
 * Only for mail the SYSTEM decides to send. A firm member who explicitly clicks
 * "email this to the client" must not have that send silently dropped — they
 * would be told it went out. Gate automatic senders here; leave deliberate ones
 * alone.
 */
export async function shouldSendClientEmail({ lawFirmId, clientId = null, clientUserId = null, category }: any) {
  if (isTransactionalCategory(category)) return true;
  if (!(await isFirmEmailEnabled(lawFirmId))) return false;
  if (clientId) return isClientEmailCategoryEnabled(lawFirmId, clientId, category);
  if (clientUserId) return isClientEmailCategoryEnabledByUserId(lawFirmId, clientUserId, category);
  return true;
}

/**
 * Batch-load stored preferences for many users in a single query, mirroring
 * `settings.service.js#getNotificationPrefsForUsers`. Callers that need to
 * gate several categories across a per-firm/per-recipient walk should call
 * this ONCE per recipient set and then run the pure `resolveUserCategory` per
 * decision, instead of calling `isUserEmailCategoryEnabled` in a loop (which
 * would issue one query per recipient per category).
 *
 * Delegates to `settingsRepo.getPreferencesForUsers` - no SQL of its own. Does
 * NOT fail open itself (a caller doing its own batching needs to see the real
 * error); `filterEmailRecipientsByPreference` below wraps it for the fan-out
 * case that does want fail-open behavior.
 */
export async function getEmailPrefsForUsers(userIds: string[]) {
  const ids = Array.from(new Set((userIds || []).filter(Boolean)));
  if (!ids.length) return new Map();
  return settingsRepo.getPreferencesForUsers(ids);
}

/**
 * Batched filter for a fan-out: a single query covering all recipients, then a
 * pure decision each. Mirrors `notifications.service.js#filterByPreference` so
 * the in-app and email paths behave the same way. Fails open on a DB error
 * (returns every input id, not just the ones successfully looked up).
 *
 * The result is deduplicated and drops falsy ids, so it is NOT positionally
 * aligned with `userIds` - callers must join back to their own records by id,
 * not by index.
 */
export async function filterEmailRecipientsByPreference(userIds: string[], category: any) {
  const ids = Array.from(new Set((userIds || []).filter(Boolean)));
  if (!ids.length || !category) return ids;
  if (isTransactionalCategory(category)) return ids;
  try {
    const prefs = await getEmailPrefsForUsers(ids);
    return ids.filter((id) => resolveUserCategory(prefs.get(id) || {}, category));
  } catch (err: any) {
    console.error('[emailPreferences] batched preference lookup failed (allowing all):', err.message);
    return ids;
  }
}
