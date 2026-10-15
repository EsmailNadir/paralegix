/**
 * Invoice Reminder Service (Postgres).
 *
 * Sends overdue + pre-due invoice reminders to clients based on per-firm
 * settings. Reminder state (the `reminders` row: sent count, last send,
 * pre-due stamp, the manual-send window, plus each payment-plan installment's
 * pre-due stamp) is claimed and COMMITTED before the email is sent, in a short
 * row-locked transaction (`invoicesRepo.runReminderTxn`), and given back in a
 * second one only if the mail did not go out. No transaction is open across the
 * provider call, so a slow provider cannot stall other invoice writes, and a
 * lost write after a successful send can only skip a reminder, never repeat one.
 *
 * Firm-level reminder settings (invoiceReminderEnabled / invoiceReminderDays /
 * defaultPreDueReminderDays) live under law_firms.settings; absent => disabled.
 */

const { sendInvoiceReminderEmail, sendInvoiceByEmail } = require('../../../shared/services/emailService');
const { payLinkUrl } = require('../shared/payLinkUrl');
const { payLinkRequest } = require('../shared/payLinkRequest');
const { fromCents } = require('../shared/money');
const { remindersGloballyDisabled, disabledReminderStats } = require('../../../shared/utils/reminderControl');
const { forEachFirm, getFirm } = require('../../../shared/utils/reminderHelpers');
const invoicesRepo = require('./invoices.repository');
const { assertInvoiceNotVoided } = require('../shared/invoiceStatus');
const clientsRepo = require('../../clients/clients.repository');
const { archiveSentCopy } = require('./invoiceArchive');
const { eligibleCompanyPortalUserIds } = require('../../clients/companyPortalRecipients');
const { NotFoundError } = require('../../../shared/errors/AppError');
const { zonedDayString, normalizeTimeZone, dayAnchor, toInstant } = require('../../../shared/utils/time');
const { addDays, localDateFor } = require('../../../shared/utils/localTime');
const { firmZone } = require('../../../shared/utils/personalDay');
const {
  invoiceClientRecordId,
  normalizeEmailList,
  readInvoiceSnapshot,
  resolveCurrentBillingRecipients,
  snapshotInvoiceRecipients,
} = require('../shared/billingRecipientSnapshot.service');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const { resolveContext, authorizeContext, CONTEXT_TYPES } = require('../context');
const { getAccessibleMatterIds } = require('../../../shared/utils/membership');

/**
 * Resolve the invoice's billing context, authorize the caller for a WRITE on
 * it, and load the invoice. A send is a write: it emails the client and, on a
 * first send, freezes the bill-to record. On a matter that means membership,
 * the same gate every other invoice write applies.
 */
export async function assertInvoiceSendable({ lawFirmId, matterId, clientId, invoiceId, actingUserId }: any) {
  const context = resolveContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);
  const invoice = await invoicesRepo.findById(context, invoiceId);
  if (!invoice) throw new NotFoundError('Invoice');
  return { context, invoice };
}

/**
 * Every address a reminder for this invoice should reach.
 *
 * Thin wrapper over the canonical recipient service (`billingRecipientSnapshot`)
 * so reminders cannot drift from what the send and payment-request paths use.
 * An issued invoice answers from its frozen snapshot, which is the whole point
 * of the snapshot: a roster change after billing does not redirect reminders
 * for money already invoiced. An invoice with no snapshot (never issued
 * externally, yet carrying a due date the reminder sweep picks up) falls back
 * to a live resolve.
 *
 * `cache` is an optional Map reused across one sweep so a firm with many
 * invoices for the same client resolves that client's recipients once.
 */
async function resolveRecipientEmails(invoice: any, lawFirmId: string, cache?: any): Promise<string[]> {
  const snapshot = readInvoiceSnapshot(invoice);
  if (snapshot) return snapshot.emails;

  const clientId = invoiceClientRecordId(invoice);
  const override = invoice.billingEmail || null;
  const cacheKey = `${lawFirmId}:${clientId || ''}:${String(override || '').toLowerCase()}`;
  const cached = cache && cache.has(cacheKey) ? cache.get(cacheKey) : null;

  const resolved = cached || await resolveCurrentBillingRecipients({ lawFirmId, clientId, overrideEmail: override });
  if (cache && !cached) cache.set(cacheKey, resolved);

  // `clientEmail` is the address frozen onto the invoice at draft time, and it
  // is a LAST RESORT, not an addition: appending it unconditionally sent
  // reminders somewhere the send and payment-request paths deliberately do
  // not. For a company, an explicit `billingEmail` override replaces the
  // linked-client list precisely so a firm can aim one bill at one person;
  // adding the company's own general address back on undoes that. Only when
  // the resolve found nothing at all - a deleted client record - does the
  // draft-time address still have a job to do.
  //
  // The cache holds the RESOLVE, keyed by (firm, client, override), because
  // that is what those three inputs determine. `clientEmail` varies per
  // invoice, so it is applied after the lookup; caching the finished list
  // instead handed the second invoice for a client the first one's address.
  if (resolved.emails.length > 0) return resolved.emails;
  return normalizeEmailList([invoice.clientEmail]);
}

/**
 * Render a due date for an email as "July 20, 2026".
 *
 * Due dates (invoice and installment alike) are day-only 'YYYY-MM-DD' values.
 * `new Date('2026-07-20')` is UTC midnight, so formatting it in the server's
 * local zone renders the PREVIOUS day anywhere behind UTC. Anchoring at noon UTC
 * and formatting in UTC makes the exact stored day render everywhere.
 */
function formatDueDay(value: any) {
  if (!value) return null;
  const at = dayAnchor(String(value));
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Whole calendar days from today until `value`'s day: 0 = due today, 1 = due
 * tomorrow, negative = already past. "Today" is the firm's day in `timeZone`;
 * both sides are pinned to UTC midnight so the result is an exact day count
 * rather than a fraction of an elapsed interval.
 * Returns null when there is no usable day.
 */
function daysUntilDay(value: any, timeZone: string) {
  if (!value) return null;
  const due = Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(due)) return null;
  const today = Date.parse(`${localDateFor(timeZone)}T00:00:00Z`);
  return Math.round((due - today) / (1000 * 60 * 60 * 24));
}

/**
 * Whether a pre-due reminder already went out on the firm's current day.
 * Calendar days on the firm's zone, like the overdue rule: an elapsed-hours
 * test reads a pass that runs a few seconds earlier than yesterday's as "less
 * than a day" and skips the reminder. `firmToday` is `localDateFor(firmZone)`.
 */
function sentOnFirmDay(lastSentAt: any, timeZone: string, firmToday: string) {
  if (!lastSentAt) return false;
  const sentDay = zonedDayString(lastSentAt?.toDate ? lastSentAt.toDate() : lastSentAt, timeZone);
  return Boolean(sentDay) && sentDay >= firmToday;
}

/**
 * Days past due, positive when overdue. Compares calendar DAYS, both projected
 * into one zone, so the answer is a whole number that changes at midnight. The
 * previous `new Date(dueDate)` parsed a day-only string as UTC midnight and
 * subtracted the current instant, so the count sat one short until the clock
 * reached that time of day, and a threshold of [7] could fire on day eight.
 * UTC is the zone every other billing cron uses for the same comparison.
 */
export function daysPastDue(dueDate: any, now = new Date(), timeZone = 'UTC') {
  const dueDay = zonedDayString(dueDate, timeZone);
  const today = zonedDayString(now, timeZone);
  if (!dueDay || !today) return 0;
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDay}T00:00:00Z`)) / 86_400_000);
}

/**
 * Whether today's pass sends an overdue reminder.
 *
 * `firmReminderDays` are days-past-due thresholds (e.g. [7, 14, 30]), and each
 * one reached earns ONE reminder: send when the invoice has reached a threshold
 * and nothing has been sent since the day it reached the latest one. Every day
 * is a calendar day on the firm's calendar. The old rule compared elapsed
 * hours with the gap to the FIRST threshold, so it sent every day once past
 * that one, never sent the last one after the one before it, and skipped a
 * threshold when a pass ran a little earlier than the week before.
 */
function shouldSendReminder(firmReminderDays: any, dueDate: any, lastReminderSentAt: any, timeZone: string, now = new Date()) {
  if (!Array.isArray(firmReminderDays) || firmReminderDays.length === 0) return false;
  const thresholds = firmReminderDays.map(Number).filter((d) => d > 0).sort((x, y) => x - y);
  const daysPast = daysPastDue(dueDate, now, timeZone);
  const stage = thresholds.slice().reverse().find((d) => daysPast >= d);
  if (!stage) return false;
  if (!lastReminderSentAt) return true;

  const dueDay = zonedDayString(dueDate, timeZone);
  const lastSent = toInstant(lastReminderSentAt?.toDate ? lastReminderSentAt.toDate() : lastReminderSentAt);
  if (!dueDay || !lastSent) return true;
  return zonedDayString(lastSent, timeZone)! < addDays(dueDay, stage);
}

function remainingBalance(invoice: any) {
  return (Number(invoice.totalAmount) || 0) - (Number(invoice.amountPaid) || 0) - (Number(invoice.totalWrittenOff) || 0);
}

function hasOpenPaymentRequest(invoice: any) {
  return invoice.stripePaymentRequested === true &&
    !['completed', 'voided'].includes(invoice.stripePaymentStatus);
}

function hasPayLink(invoice: any) {
  return typeof invoice.payLinkToken === 'string' && invoice.payLinkToken !== '';
}

/**
 * Where the invoice email's "View Invoice" goes while a payment request is
 * open: the request's secure payment link when it has one, which needs no
 * login, else the client portal.
 */
function portalUrlFor(invoice: any, lawFirmId: string) {
  if (!hasOpenPaymentRequest(invoice)) return null;
  if (hasPayLink(invoice)) return payLinkUrl(invoice.payLinkToken);
  return `${FRONTEND_URL}/client/lawfirm/${lawFirmId}/billing`;
}

/** What a reminder asks the client to pay: the full balance, or one plan installment by its stable id. */
type ReminderAsk = 'balance' | { installmentId: string | null };

/**
 * A reminder's "View Invoice & Pay" while a payment request is open, and the
 * amount the reminder must quote when the button is the pay link.
 *
 * The request's secure payment link charges one figure: the full balance or
 * one installment (`payLinkRequest`). It goes only on a reminder asking for
 * that same figure, and that reminder quotes what the link charges, which can
 * be less than the row when the balance is lower. Every other reminder, and a
 * link with nothing left to collect, gets the client portal and keeps its own
 * amount. Otherwise an installment-3 reminder's button would charge
 * installment 2, or a full-balance reminder's button would charge one row.
 * `linkAmountDue` is in dollars, like every other amount the email receives.
 */
function reminderPayButton(invoice: any, lawFirmId: string, ask: ReminderAsk): { portalUrl: string | null; linkAmountDue: number | null } {
  if (!hasOpenPaymentRequest(invoice)) return { portalUrl: null, linkAmountDue: null };
  const portal = { portalUrl: `${FRONTEND_URL}/client/lawfirm/${lawFirmId}/billing`, linkAmountDue: null };
  if (!hasPayLink(invoice)) return portal;
  const link = payLinkRequest(invoice);
  const asksForLink = ask === 'balance'
    ? link.installmentId === null
    : ask.installmentId !== null && ask.installmentId === link.installmentId;
  if (!asksForLink || !link.isPayable) return portal;
  return { portalUrl: payLinkUrl(invoice.payLinkToken), linkAmountDue: fromCents(link.requestedCents) };
}

/** True when `value` names exactly the instant `at` (epoch milliseconds, the precision both sides carry). */
function sameInstant(value: any, at: Date) {
  if (!value) return false;
  return new Date(value?.toDate ? value.toDate() : value).getTime() === at.getTime();
}

/**
 * Send one reminder whose stamp is already committed, and give the stamp back
 * when the mail did not go out.
 *
 * The claim commits before the provider is called, so a crash or a lost write
 * after a successful send can only cost a reminder, never repeat one. A release
 * that itself fails leaves the stamp in place: the same trade, the reminder is
 * skipped until its next window rather than sent twice.
 */
async function deliverClaimed(email: any, release: () => Promise<unknown>, label: string): Promise<'sent' | 'skipped' | 'errors'> {
  let outcome: 'sent' | 'skipped' | 'errors';
  try {
    outcome = (await sendInvoiceReminderEmail(email)).sent ? 'sent' : 'skipped';
  } catch (err: any) {
    console.error(`[invoiceReminders] Reminder send failed for ${label}:`, err.message);
    outcome = 'errors';
  }
  if (outcome === 'sent') return outcome;
  try {
    await release();
  } catch (err: any) {
    console.error(`[invoiceReminders] Could not release the reminder claim for ${label}; it will not resend until its next window:`, err.message);
    return 'errors';
  }
  return outcome;
}

/**
 * Narrow candidate invoices to the ones `actingUserId` could remind one at a
 * time: a matter invoice needs the caller on that matter (the write gate of
 * `authorizeContext`), a client-context invoice is open to the firm. Membership
 * for every matter is resolved in one query. Without a user (the scheduled pass)
 * every candidate stays.
 */
async function withinCallerReach<T extends { invoice: any; context: any }>(
  lawFirmId: string, actingUserId: string | null | undefined, candidates: T[],
): Promise<T[]> {
  if (!actingUserId) return candidates;
  const matterIds = candidates
    .filter(({ context }) => context.type === CONTEXT_TYPES.matter)
    .map(({ context }) => context.entityId);
  const reachable = await getAccessibleMatterIds(lawFirmId, matterIds, actingUserId);
  return candidates.filter(({ context }) => context.type !== CONTEXT_TYPES.matter || reachable.has(context.entityId));
}

/**
 * Send overdue + pre-due invoice reminders for a specific firm (or all firms).
 * With `actingUserId` (the manual firm-wide run) only invoices that user could
 * remind individually are processed; the scheduled pass passes none and covers
 * everything.
 * @returns {{ sent: number, skipped: number, errors: number }}
 */
export async function sendOverdueReminders(lawFirmId: string, { deadline = null, actingUserId = null }: any = {}) {
  if (remindersGloballyDisabled()) return disabledReminderStats();

  const stats = { sent: 0, skipped: 0, errors: 0 };
  const recipientEmailCache = new Map();

  const coverage = await forEachFirm('invoiceReminders', async (firm: any) => {
    const fid = firm.id;
    const firmName = firm.name || null;
    const settings = firm.settings || {};
    // Whether a bill is late is decided on the FIRM's calendar, not the server's.
    // For a firm behind UTC there is a window each evening where UTC has already
    // turned over, and a threshold that reads the UTC day fires a reminder while
    // it is still the day before where the firm and the client are.
    // `firmZone` answers UTC for an unset or unrecognised zone, so one
    // firm with a typo cannot take the whole nightly pass down.
    const firmTimeZone = await firmZone(fid, settings);
    const firmToday = localDateFor(firmTimeZone);

    // ── Overdue reminders ──
    try {
      if (settings.invoiceReminderEnabled) {
        const firmReminderDays = Array.isArray(settings.invoiceReminderDays) && settings.invoiceReminderDays.length > 0
          ? settings.invoiceReminderDays
          : [7, 14, 30];

        const overdue = await withinCallerReach(fid, actingUserId, await invoicesRepo.findUnpaidByDue(fid, 'overdue', firmToday));
        for (const { invoice, context } of overdue) {
          if (invoice.reminderOptOut) { stats.skipped++; continue; }

          // CLAIM in its own short transaction (row lock only), committed before
          // the send. Two overlapping passes serialize on the row lock; the second
          // re-reads the first one's stamp and finds itself ineligible. Held in an
          // object because TypeScript does not re-widen a closure-assigned `let`.
          const claim: { at: Date | null; previousSentAt: any; email: any; invoice: any } = {
            at: null, previousSentAt: null, email: null, invoice: null,
          };
          await invoicesRepo.runReminderTxn(context, invoice.id, async (current: any) => {
            if (current.reminderOptOut) return null;
            const effectiveDue = current.nextPaymentDate || current.dueDate;
            if (!shouldSendReminder(firmReminderDays, effectiveDue, current.lastReminderSentAt || null, firmTimeZone)) return null;
            const recipientEmails = await resolveRecipientEmails(current, fid, recipientEmailCache);
            if (recipientEmails.length === 0) return null;
            const remaining = remainingBalance(current);
            if (remaining <= 0) return null;

            const at = new Date();
            const button = reminderPayButton(current, fid, 'balance');
            Object.assign(claim, {
              at,
              previousSentAt: current.lastReminderSentAt || null,
              invoice: current,
              email: {
                to: recipientEmails,
                recipientName: current.clientName || null,
                lawFirmName: firmName,
                invoiceNumber: current.invoiceName,
                amountDue: button.linkAmountDue ?? remaining,
                dueDate: formatDueDay(effectiveDue),
                portalUrl: button.portalUrl,
              },
            });
            return { lastReminderSentAt: at, reminderCount: (Number(current.reminderCount) || 0) + 1 };
          });
          const at = claim.at;
          if (!at) { stats.skipped++; continue; }

          const outcome = await deliverClaimed(claim.email, () => invoicesRepo.runReminderTxn(
            context, invoice.id,
            (current: any) => (sameInstant(current.lastReminderSentAt, at)
              ? {
                lastReminderSentAt: claim.previousSentAt,
                reminderCount: Math.max(0, (Number(current.reminderCount) || 0) - 1),
              }
              : null),
          ), `invoice ${invoice.id}`);
          stats[outcome]++;

          if (outcome === 'sent') {
            try {
              const { createNotifications } = require('../../notifications/notifications.service');
              const firmRecipients = Array.from(new Set([claim.invoice.createdBy].filter(Boolean)));
              if (firmRecipients.length) {
                await createNotifications(fid, firmRecipients, {
                  category: 'invoiceOverdue',
                  type: 'invoice_overdue',
                  title: 'Invoice overdue',
                  body: `Invoice ${claim.invoice.invoiceName || claim.invoice.invoiceNumber || ''} for ${claim.invoice.clientName || 'a client'} is overdue`,
                  entityType: 'invoice',
                  entityId: claim.invoice.id,
                  actionUrl: `${FRONTEND_URL}/lawfirm/${fid}/billing`,
                  createdBy: null,
                });
              }
            } catch (err: any) {
              console.error(`[invoiceReminders] Failed to create in-app notification for overdue invoice ${claim.invoice.id}:`, err.message);
            }
          }
        }
      }
    } catch (err: any) {
      console.error(`[invoiceReminders] Error processing overdue reminders for firm ${fid}:`, err.message);
      stats.errors++;
    }

    // ── Pre-due reminders (invoice-level + payment-plan installments) ──
    try {
      const firmDefaultPreDueDays = settings.defaultPreDueReminderDays || null;
      const upcoming = await withinCallerReach(fid, actingUserId, await invoicesRepo.findUnpaidByDue(fid, 'upcoming', firmToday));

      for (const { invoice, context } of upcoming) {
        if (invoice.reminderOptOut) continue;

        // Every reminder this invoice is due today is claimed in ONE short
        // transaction, then each is sent with no transaction open, and each one
        // that did not go out is released on its own.
        const claim: { at: Date | null; jobs: any[]; skipped: number } = { at: null, jobs: [], skipped: 0 };
        await invoicesRepo.runReminderTxn(context, invoice.id, async (current: any) => {
          if (current.reminderOptOut) return null;
          const recipientEmails = await resolveRecipientEmails(current, fid, recipientEmailCache);
          if (recipientEmails.length === 0) return null;
          const remaining = remainingBalance(current);
          if (remaining <= 0) return null;

          const at = new Date();
          const base = { to: recipientEmails, recipientName: current.clientName || null, lawFirmName: firmName, isUpcoming: true };
          const updateData: Record<string, any> = {};

          // Invoice-level pre-due reminder
          const invoicePreDays = current.preDueReminderDays ?? firmDefaultPreDueDays;
          const effectiveDue = current.nextPaymentDate || current.dueDate;
          if (invoicePreDays > 0 && effectiveDue) {
            const daysUntilDue = daysUntilDay(effectiveDue, firmTimeZone);
            if (daysUntilDue !== null && daysUntilDue > 0 && daysUntilDue <= invoicePreDays) {
              if (!sentOnFirmDay(current.preDueReminderSentAt, firmTimeZone, firmToday)) {
                updateData.preDueReminderSentAt = at;
                const button = reminderPayButton(current, fid, 'balance');
                claim.jobs.push({
                  kind: 'invoice',
                  previous: current.preDueReminderSentAt || null,
                  email: {
                    ...base,
                    portalUrl: button.portalUrl,
                    invoiceNumber: current.invoiceName,
                    amountDue: button.linkAmountDue ?? remaining,
                    dueDate: formatDueDay(effectiveDue),
                    daysUntilDue,
                  },
                });
              } else {
                claim.skipped++;
              }
            }
          }

          // Payment-plan installment pre-due reminders
          const planPreDays = current.paymentPlan?.preReminderDays;
          if (planPreDays > 0 && current.paymentPlan?.enabled && Array.isArray(current.paymentPlan.expectedPayments)) {
            const updatedPayments = [...current.paymentPlan.expectedPayments];
            let planChanged = false;
            for (let i = 0; i < updatedPayments.length; i++) {
              const inst = updatedPayments[i];
              if (inst.status !== 'pending') continue;
              const daysUntilDue = daysUntilDay(inst.dueDate, firmTimeZone);
              if (daysUntilDue === null || daysUntilDue <= 0 || daysUntilDue > planPreDays) continue;
              if (sentOnFirmDay(inst.preDueReminderSentAt, firmTimeZone, firmToday)) { claim.skipped++; continue; }
              updatedPayments[i] = { ...inst, preDueReminderSentAt: at.toISOString() };
              planChanged = true;
              const button = reminderPayButton(current, fid, { installmentId: inst.id ?? null });
              claim.jobs.push({
                kind: 'installment',
                index: i,
                installmentId: inst.id ?? null,
                previous: inst.preDueReminderSentAt || null,
                email: {
                  ...base,
                  portalUrl: button.portalUrl,
                  invoiceNumber: `${current.invoiceName} (installment ${i + 1})`,
                  amountDue: button.linkAmountDue ?? inst.amount,
                  dueDate: formatDueDay(inst.dueDate),
                  daysUntilDue,
                },
              });
            }
            if (planChanged) updateData.paymentPlan = { ...current.paymentPlan, expectedPayments: updatedPayments };
          }

          if (!claim.jobs.length) return null;
          claim.at = at;
          return updateData;
        });
        stats.skipped += claim.skipped;
        const at = claim.at;
        if (!at) continue;

        for (const job of claim.jobs) {
          const release = () => invoicesRepo.runReminderTxn(context, invoice.id, (current: any) => {
            if (job.kind === 'invoice') {
              return sameInstant(current.preDueReminderSentAt, at) ? { preDueReminderSentAt: job.previous } : null;
            }
            const payments = current.paymentPlan?.expectedPayments;
            const inst = Array.isArray(payments) ? payments[job.index] : null;
            if (!inst || (inst.id ?? null) !== job.installmentId || !sameInstant(inst.preDueReminderSentAt, at)) return null;
            const expectedPayments = [...payments];
            expectedPayments[job.index] = { ...inst, preDueReminderSentAt: job.previous };
            return { paymentPlan: { ...current.paymentPlan, expectedPayments } };
          });
          // eslint-disable-next-line no-await-in-loop -- one client's reminders, sent in order
          stats[await deliverClaimed(job.email, release, `invoice ${invoice.id} (${job.kind})`)]++;
        }
      }
    } catch (err: any) {
      console.error(`[invoiceReminders] Error processing pre-due reminders for firm ${fid}:`, err.message);
      stats.errors++;
    }
  }, { lawFirmId, deadline });

  return { ...stats, ...coverage };
}

/**
 * Send a reminder immediately for a specific invoice, bypassing threshold/timing checks.
 * @param {{ lawFirmId, invoiceId, matterId?, clientId?, actingUserId }} opts
 */
export async function sendReminderForInvoice({ lawFirmId, invoiceId, matterId, clientId, actingUserId }: any) {
  // Authorize before anything else, the kill switch included, so a caller's
  // access never depends on an operator flag.
  const context = resolveContext({ lawFirmId, matterId, clientId });
  await authorizeContext(context, actingUserId);
  if (remindersGloballyDisabled()) return { sent: false, reason: 'Reminders are disabled' };

  const firm = await getFirm(lawFirmId);
  const firmName = firm?.name || null;
  const firmTimeZone = await firmZone(lawFirmId);

  // CLAIM under the row lock and commit it before sending. The rate limit is
  // re-derived from the freshly locked `recentManualReminders`, and the claim
  // adds this send to it, so a double-click serializes on the lock and the
  // second click sees the first one's entry. The send itself holds no lock.
  const claim: { at: Date | null; reason: string | null; previousSentAt: any; email: any } = {
    at: null, reason: null, previousSentAt: null, email: null,
  };
  const claimed = await invoicesRepo.runReminderTxn(context, invoiceId, async (current: any) => {
    assertInvoiceNotVoided(current, 'send a reminder for it');
    if (current.isPaid) { claim.reason = 'Invoice is already paid'; return null; }
    if (current.reminderOptOut) { claim.reason = 'Reminders are disabled for this invoice'; return null; }

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recentSends = (current.recentManualReminders || [])
      .map((t: any) => (t?.toDate ? t.toDate().getTime() : new Date(t).getTime()))
      .filter((t: any) => t > cutoff);
    if (recentSends.length >= 3) { claim.reason = 'Unable to send reminder at this time.'; return null; }

    const recipientEmails = await resolveRecipientEmails(current, lawFirmId);
    if (recipientEmails.length === 0) { claim.reason = 'No recipient email on file'; return null; }
    const remaining = remainingBalance(current);
    if (remaining <= 0) { claim.reason = 'No outstanding balance'; return null; }

    // If a payment plan is active, remind about the next pending installment instead of the full balance
    let amountDue = remaining;
    let ask: ReminderAsk = 'balance';
    let effectiveDueDay = current.dueDate ? String(current.dueDate).slice(0, 10) : null;
    if (current.paymentPlan?.enabled && Array.isArray(current.paymentPlan.expectedPayments)) {
      const nextInstallment = current.paymentPlan.expectedPayments.find((p: any) => p.status === 'pending');
      if (nextInstallment) {
        amountDue = Number(nextInstallment.amount) || amountDue;
        ask = { installmentId: nextInstallment.id ?? null };
        if (nextInstallment.dueDate) effectiveDueDay = String(nextInstallment.dueDate).slice(0, 10);
      }
    }
    const button = reminderPayButton(current, lawFirmId, ask);
    const daysUntilDue = daysUntilDay(effectiveDueDay, firmTimeZone) ?? 0;
    const isUpcoming = daysUntilDue > 0;

    const at = new Date();
    Object.assign(claim, {
      at,
      previousSentAt: current.lastReminderSentAt || null,
      email: {
        to: recipientEmails,
        recipientName: current.clientName || null,
        lawFirmName: firmName,
        invoiceNumber: current.invoiceName,
        amountDue: button.linkAmountDue ?? amountDue,
        dueDate: formatDueDay(effectiveDueDay),
        portalUrl: button.portalUrl,
        isUpcoming,
        daysUntilDue: isUpcoming ? daysUntilDue : null,
      },
    });
    return {
      lastReminderSentAt: at,
      reminderCount: (Number(current.reminderCount) || 0) + 1,
      recentManualReminders: [...recentSends.map((t: any) => new Date(t).toISOString()), at.toISOString()].slice(-10),
    };
  });

  if (!claimed) throw new NotFoundError('Invoice');
  const at = claim.at;
  if (!at) return { sent: false, reason: claim.reason || undefined };

  const outcome = await deliverClaimed(claim.email, () => invoicesRepo.runReminderTxn(context, invoiceId, (current: any) => (
    sameInstant(current.lastReminderSentAt, at)
      ? {
        lastReminderSentAt: claim.previousSentAt,
        reminderCount: Math.max(0, (Number(current.reminderCount) || 0) - 1),
        recentManualReminders: (current.recentManualReminders || []).filter((t: any) => !sameInstant(t, at)),
      }
      : null
  )), `invoice ${invoiceId}`);

  return outcome === 'sent' ? { sent: true } : { sent: false };
}

/**
 * Send an invoice to a specific email address with an optional PDF attachment.
 */
export async function sendInvoiceToEmail({ lawFirmId, invoiceId, matterId, clientId, actingUserId, recipientEmail, recipientName, pdfBuffer, pdfFileName }: any) {
  const { invoice } = await assertInvoiceSendable({ lawFirmId, matterId, clientId, invoiceId, actingUserId });
  // Unlocked read, deliberately: void is terminal, so this can only be stale in
  // the direction of letting through an invoice voided a moment later.
  assertInvoiceNotVoided(invoice, 'email it to the client');

  // Emailing the invoice IS its first external issue, so this is where the
  // bill-to record freezes. Snapshot-once: a resend reads back the record the
  // first send wrote rather than re-resolving today's roster.
  //
  // Additive, as before: whatever address the sender typed goes out alongside
  // the resolved billing recipients, so filling in a one-off address can never
  // silently stop the client's own copy. On a first send the typed address is
  // frozen with the rest, because it is genuinely part of who was billed.
  const snapshot = await snapshotInvoiceRecipients({
    lawFirmId,
    invoice,
    invoiceId,
    action: 'email this invoice to',
    extraEmails: [recipientEmail],
    // Not a hard failure: this path returns a `{ sent: false, reason }` result
    // rather than throwing, and the caller's UI renders that reason.
    requireRecipients: false,
  });
  // `clientEmail` is the draft-time address, and it is a fallback rather than a
  // fourth recipient. Appending it always meant the mail reached an address the
  // snapshot just froze the invoice as NOT having been billed to, so the frozen
  // record and the delivery disagreed. It applies only when nothing else
  // resolved, which is the deleted-client-record case it was written for.
  const resolvedTo = normalizeEmailList([recipientEmail, ...snapshot.emails]);
  const to = resolvedTo.length > 0 ? resolvedTo : normalizeEmailList([invoice.clientEmail]);
  if (to.length === 0) return { sent: false, reason: 'No recipient email address' };

  const firm = await getFirm(lawFirmId);
  const firmName = firm?.name || null;

  const totalAmount = Number(invoice.totalAmount) || 0;
  const amountPaid = Number(invoice.amountPaid) || 0;
  const totalWrittenOff = Number(invoice.totalWrittenOff) || 0;
  const remaining = totalAmount - amountPaid - totalWrittenOff;

  // `dueDate` is a day-only column, so it arrives as a raw '2026-07-20' string.
  // Without this the client is mailed that instead of a readable date.
  const dueDate = formatDueDay(invoice.dueDate);

  const result = await sendInvoiceByEmail({
    to,
    recipientName: recipientName || invoice.clientName || null,
    lawFirmName: firmName,
    invoiceNumber: invoice.invoiceNumber || invoice.invoiceName,
    totalAmount,
    amountPaid,
    remainingBalance: remaining,
    dueDate,
    portalUrl: portalUrlFor(invoice, lawFirmId),
    pdfBuffer: pdfBuffer || null,
    pdfFileName: pdfFileName || null,
  });

  // Keep the attachment the client just received. Only on a successful send: an
  // email that never went out is not a record of what anyone was billed.
  // Archiving is best-effort and deliberately not awaited into the result, since
  // the mail has already left and a storage failure must not report it as failed.
  if (result.sent) {
    if (pdfBuffer) {
      await archiveSentCopy({
        lawFirmId,
        invoiceId,
        pdfBuffer,
        sentAt: new Date(),
        recipientEmail: to.join(', '),
      });
    }

    const clientRecordId = invoiceClientRecordId(invoice);
    const clientRecord = clientRecordId ? await clientsRepo.findById(lawFirmId, clientRecordId) : null;
    // A COMPANY never carries `clients.user_id` (`clients_company_no_user_id_check`),
    // so reading the bill-to client's own uid resolved to null for every
    // organization invoice and the bell notification was silently skipped -
    // the people who CAN see the invoice were the only client-facing audience
    // never told about it. Its people are reached through their links instead,
    // narrowed to `can_view_billing` because the notification points at a
    // billing route that refuses anyone without it.
    const portalUserIds = clientRecord?.clientType === 'company'
      ? await eligibleCompanyPortalUserIds(lawFirmId, clientRecordId, 'invoiceIssued', { requireBillingAccess: true })
      : (clientRecord?.userId ? [clientRecord.userId] : []);
    if (portalUserIds.length) {
      try {
        const { createNotifications } = require('../../notifications/notifications.service');
        await createNotifications(lawFirmId, portalUserIds, {
          category: 'invoiceIssued',
          type: 'invoice_issued',
          title: 'New invoice issued',
          body: `Invoice ${invoice.invoiceNumber || invoice.invoiceName || ''} is ready to view`,
          entityType: 'invoice',
          entityId: invoiceId,
          // Carry the client record so a reader who holds several associations
          // lands on the one this invoice belongs to instead of being asked to
          // pick (the portal's CLIENT_SELECTION_REQUIRED state).
          actionUrl: clientRecordId
            ? `${FRONTEND_URL}/client/lawfirm/${lawFirmId}/billing?clientRecordId=${clientRecordId}`
            : `${FRONTEND_URL}/client/lawfirm/${lawFirmId}/billing`,
          createdBy: null,
        });
      } catch (err: any) {
        console.error(`[invoiceReminders] Failed to create portal notification for issued invoice ${invoiceId}:`, err.message);
      }
    }
  }

  return { sent: result.sent, to };
}
