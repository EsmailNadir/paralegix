const eventBus = require('../../shared/events/eventBus');
const { financialRootSql, financialSql, withDrizzleTransaction } = require('../../shared/database/financialQuery');
const { isUuid } = require('../../shared/utils/isUuid');
const {
  TRUST_LOW_BALANCE, TRUST_DEPOSIT_REVERSAL_FAILED, TRUST_DEPOSIT_RECEIVED, TRUST_DEPOSIT_FAILED,
  TRUST_DEPOSIT_POSTING_FAILED,
} = require('../../shared/events/eventTypes');
const { createNotifications, FRONTEND_URL } = require('../notifications/notifications.service');
const { sendTrustReplenishmentEmail } = require('../../shared/services/emailService');
const { formatDollarsFromCents: formatCurrency } = require('../billing/shared/money');
const { resolveCurrentBillingRecipients } = require('../billing/shared/billingRecipientSnapshot.service');
const { eligibleCompanyPortalUserIds } = require('../clients/companyPortalRecipients');

/**
 * When a client's trust balance drops below the threshold, post a system message
 * to the client's portal conversation asking them to replenish their retainer.
 * Uses the Postgres conversations/messages model (system sender; counts toward
 * the client's unread via read_by_client=false).
 */
eventBus.on(TRUST_LOW_BALANCE, async ({ lawFirmId, clientId, clientName, balanceCents, thresholdCents, eventId }: any) => {
  // Resolve the client's portal user + email and the firm name once; each channel
  // below is best-effort and isolated so one failure never blocks the others.
  let clientUserId = null;
  let clientType = 'person';
  let resolvedClientName = clientName || null;
  let firmName = null;
  // Every address the replenishment ask should reach. A person client is their
  // own billing recipient; a company's are the roster links flagged
  // `is_email_recipient`, which is why this is a list rather than one column.
  let clientEmails: string[] = [];
  // Company portal logins that should see the in-app alert, one per
  // portal-enabled roster link.
  let portalUserIds: string[] = [];
  try {
    if (isUuid(clientId)) {
      const { rows } = await financialRootSql(
        `select user_id, email, name, client_type from clients where law_firm_id = $1 and id = $2 limit 1`,
        [lawFirmId, clientId]
      );
      clientUserId = rows[0]?.user_id || null;
      clientType = rows[0]?.client_type === 'company' ? 'company' : 'person';
      resolvedClientName = resolvedClientName || rows[0]?.name || null;

      const recipients = await resolveCurrentBillingRecipients({ lawFirmId, clientId });
      clientEmails = recipients.emails.length
        ? recipients.emails
        // A company with no billing recipient still has a `clients.email` in
        // some firms' data; fall back to it rather than telling nobody.
        : (rows[0]?.email ? [rows[0].email] : []);

      // Only the company arm needs this list. A person client is reached
      // through their own direct portal conversation below, keyed on
      // `clients.user_id`.
      //
      // `requireBillingAccess`: the alert states the company's trust balance
      // and its minimum, and links to the trust page. Both the figure and the
      // page are refused to a link without `can_view_billing`
      // (`assertCanViewBilling` guards the balance and ledger routes), so
      // fanning the alert out to every linked person would disclose the
      // balance to exactly the people denied it and hand them a link that
      // answers 403.
      if (clientType === 'company') {
        portalUserIds = await eligibleCompanyPortalUserIds(
          lawFirmId, clientId, 'trustLowBalance', { requireBillingAccess: true },
        );
      }
    }
    const firm = await financialRootSql('select name from law_firms where id = $1 limit 1', [lawFirmId]);
    firmName = firm.rows[0]?.name || null;
  } catch (err) {
    console.error('trust.events: failed to resolve low-balance recipients:', err);
  }

  const topUpCents = Math.max(0, (Number(thresholdCents) || 0) - (Number(balanceCents) || 0));

  // ── Client portal message (system sender) ──
  if (clientUserId) {
    try {
      const messageContent = `Your trust account balance is now ${formatCurrency(balanceCents)}. ` +
        `Please contact your legal team to replenish your retainer to ensure continued service.`;

      await withDrizzleTransaction(async (conn: any) => {
        const existing = await financialSql(conn,
          `select id from conversations where law_firm_id = $1 and client_id = $2 limit 1 for update`,
          [lawFirmId, clientUserId]
        );
        let convId;
        if (existing.rows[0]) {
          convId = existing.rows[0].id;
          await financialSql(conn,
            `update conversations set last_message_at = now(), updated_at = now() where id = $1`,
            [convId]
          );
        } else {
          const ins = await financialSql(conn,
            `insert into conversations (law_firm_id, client_id, last_message_at)
             values ($1,$2, now()) returning id`,
            [lawFirmId, clientUserId]
          );
          convId = ins.rows[0].id;
        }
        await financialSql(conn,
          `insert into messages (conversation_id, law_firm_id, sender_user_id, sender_type, sender_name,
              content, status, read, read_by_client, read_by_firm)
           values ($1,$2,null,'firm_member','Trust Account Alert',$3,'sent',false,false,true)`,
          [convId, lawFirmId, messageContent]
        );
      });
    } catch (err) {
      console.error('trust.events: failed to post low balance portal message:', err);
    }
  }

  // ── In-app alert for a company's portal-enabled roster ──
  //
  // A company has no `clients.user_id`, so the direct-conversation branch above
  // can never reach it. Its people are reached through the bell instead, one
  // notification per portal-enabled linked person. The bell rather than the
  // company's canonical conversation, deliberately: this alert is addressed to
  // each person who can act on it, and a thread post would also be a message
  // from the firm that nobody wrote. Uncategorised, matching the firm-side trust
  // alerts below: a retainer running dry is not a muteable nicety. A linked
  // person can still opt out explicitly (see eligibleCompanyPortalUserIds).
  if (clientType === 'company' && portalUserIds.length) {
    try {
      await createNotifications(lawFirmId, portalUserIds, {
        eventId: eventId ? `trust-low-balance:${eventId}` : undefined,
        type: 'trust_low_balance',
        title: 'Retainer balance is low',
        body: `${resolvedClientName || 'Your organization'}'s trust balance is now ${formatCurrency(balanceCents)}, `
          + `below the ${formatCurrency(thresholdCents)} minimum. Please contact your legal team to replenish the retainer.`,
        actionUrl: `${FRONTEND_URL}/client/lawfirm/${lawFirmId}/trust?clientRecordId=${clientId}`,
      });
    } catch (err) {
      console.error('trust.events: failed to notify company roster of low balance:', err);
    }
  }

  // ── Email the client asking them to replenish the retainer ──
  if (clientEmails.length) {
    try {
      await sendTrustReplenishmentEmail({
        to: clientEmails,
        recipientName: resolvedClientName,
        lawFirmName: firmName,
        balance: (Number(balanceCents) || 0) / 100,
        minimum: (Number(thresholdCents) || 0) / 100,
        topUp: topUpCents / 100,
        // Carry the client record so a recipient who represents several clients
        // lands on the right one rather than being asked to pick.
        portalUrl: isUuid(clientId)
          ? `${FRONTEND_URL}/client/lawfirm/${lawFirmId}/billing?clientRecordId=${clientId}`
          : `${FRONTEND_URL}/client/lawfirm/${lawFirmId}/billing`,
      });
    } catch (err) {
      console.error('trust.events: failed to email low balance alert:', err);
    }
  }

  // ── Notify the firm's trust managers in-app ──
  try {
    const { rows } = await financialRootSql(
      `select distinct m.user_id
         from members m
         left join roles r on r.law_firm_id = m.law_firm_id and r.id = m.role_id
        where m.law_firm_id = $1
          and (m.is_owner = true or 'trust.manage' = any(coalesce(r.permissions, '{}')))`,
      [lawFirmId],
    );
    const recipients = rows.map((x: any) => x.user_id).filter(Boolean);
    if (recipients.length) {
      await createNotifications(lawFirmId, recipients, {
        eventId: eventId ? `trust-low-balance:${eventId}` : undefined,
        type: 'trust_low_balance',
        title: 'Retainer balance is low',
        body: `${resolvedClientName || 'A client'}'s trust balance is now ${formatCurrency(balanceCents)}, `
          + `below the ${formatCurrency(thresholdCents)} minimum. The client has been asked to replenish their retainer.`,
        actionUrl: `${FRONTEND_URL}/lawfirm/${lawFirmId}/trust`,
      });
    }
  } catch (err) {
    console.error('trust.events: failed to send firm low-balance notification:', err);
  }
});

/**
 * A clawed-back electronic deposit (ACH return / dispute) could not be reversed
 * automatically — the funds were already disbursed, or the entry had been
 * reconciled. The ledger correctly refused to go negative or corrupt a
 * reconciliation, so a human must correct it. Raise an in-app notification to the
 * firm's trust managers (owners + anyone with `trust.manage`) so the overstated
 * balance is not missed. No category => this critical alert cannot be muted.
 */
eventBus.on(TRUST_DEPOSIT_REVERSAL_FAILED, async ({ lawFirmId, trustTransactionId, amountCents, reason }: any) => {
  try {
    if (!lawFirmId) return;
    const { rows } = await financialRootSql(
      `select distinct m.user_id
         from members m
         left join roles r on r.law_firm_id = m.law_firm_id and r.id = m.role_id
        where m.law_firm_id = $1
          and (m.is_owner = true or 'trust.manage' = any(coalesce(r.permissions, '{}')))`,
      [lawFirmId],
    );
    const recipients = rows.map((x: any) => x.user_id).filter(Boolean);
    if (!recipients.length) return;

    // No entityType: the notifications table restricts entity_type to
    // task/matter/invoice/message/note. Navigation is via actionUrl to the trust
    // page instead. The trust transaction id is included in the body for reference.
    await createNotifications(lawFirmId, recipients, {
      type: 'trust_reversal_failed',
      title: 'Trust deposit clawback needs attention',
      body: `A returned or disputed trust deposit of ${formatCurrency(amountCents)} could not be `
        + `reversed automatically (${reason}). The client's trust balance may be overstated. `
        + `Review and correct it manually (transaction ${trustTransactionId}).`,
      actionUrl: `${FRONTEND_URL}/lawfirm/${lawFirmId}/trust`,
    });
  } catch (err) {
    console.error('trust.events: failed to send reversal-failed alert:', err);
  }
});

/**
 * A client funded their trust account (an ACH deposit cleared). Notify the firm's
 * trust managers (owners + anyone with `trust.manage`) in-app so incoming client
 * funds are visible. No category => not muteable. Best-effort + isolated.
 */
eventBus.on(TRUST_DEPOSIT_RECEIVED, async ({ lawFirmId, amountCents }: any) => {
  try {
    if (!lawFirmId) return;
    const { rows } = await financialRootSql(
      `select distinct m.user_id
         from members m
         left join roles r on r.law_firm_id = m.law_firm_id and r.id = m.role_id
        where m.law_firm_id = $1
          and (m.is_owner = true or 'trust.manage' = any(coalesce(r.permissions, '{}')))`,
      [lawFirmId],
    );
    const recipients = rows.map((x: any) => x.user_id).filter(Boolean);
    if (!recipients.length) return;

    // No entityType: the notifications table restricts entity_type to
    // task/matter/invoice/message/note. Navigation is via actionUrl to trust.
    await createNotifications(lawFirmId, recipients, {
      type: 'trust_deposit_received',
      title: 'Trust deposit received',
      body: `A client funded trust with ${formatCurrency(amountCents)}.`,
      actionUrl: `${FRONTEND_URL}/lawfirm/${lawFirmId}/trust`,
    });
  } catch (err) {
    console.error('trust.events: failed to send trust deposit alert:', err);
  }
});

/**
 * A client's ACH trust deposit failed at the bank (insufficient funds, a closed
 * account) after they completed checkout. Nothing reached the ledger, but the
 * client may believe the retainer is paid. Tell the firm's trust managers (owners
 * + anyone with `trust.manage`) so someone asks the client to pay again. No
 * category => not muteable. Best-effort + isolated.
 */
eventBus.on(TRUST_DEPOSIT_FAILED, async ({ lawFirmId, clientId, amountCents, reason }: any) => {
  try {
    if (!isUuid(lawFirmId)) return;
    const { rows } = await financialRootSql(
      `select distinct m.user_id
         from members m
         left join roles r on r.law_firm_id = m.law_firm_id and r.id = m.role_id
        where m.law_firm_id = $1
          and (m.is_owner = true or 'trust.manage' = any(coalesce(r.permissions, '{}')))`,
      [lawFirmId],
    );
    const recipients = rows.map((x: any) => x.user_id).filter(Boolean);
    if (!recipients.length) return;

    let clientName: string | null = null;
    if (isUuid(clientId)) {
      const client = await financialRootSql(
        'select name from clients where law_firm_id = $1 and id = $2',
        [lawFirmId, clientId],
      );
      clientName = client.rows[0]?.name || null;
    }

    await createNotifications(lawFirmId, recipients, {
      type: 'trust_deposit_failed',
      title: 'Trust deposit failed',
      body: `A trust deposit of ${formatCurrency(amountCents)}${clientName ? ` from ${clientName}` : ''} `
        + `failed at the bank${reason ? ` (${reason})` : ''}. The funds did not arrive; `
        + 'ask the client to pay again.',
      actionUrl: `${FRONTEND_URL}/lawfirm/${lawFirmId}/trust`,
    });
  } catch (err) {
    console.error('trust.events: failed to send deposit-failed alert:', err);
  }
});

/**
 * A Stripe deposit settled (the money is in the trust account) but posting it to
 * the ledger failed. Until a person acts, the IOLTA holds client money the books
 * do not show. The webhook still fails so Stripe retries, and every retry emits
 * this again, so the notification is keyed on the payment intent: one alert per
 * deposit, not one per retry. No category => this critical alert cannot be muted.
 */
eventBus.on(TRUST_DEPOSIT_POSTING_FAILED, async ({ lawFirmId, amountCents, paymentIntentId, alertKey, error }: any) => {
  try {
    if (!isUuid(lawFirmId)) return;
    const { rows } = await financialRootSql(
      `select distinct m.user_id
         from members m
         left join roles r on r.law_firm_id = m.law_firm_id and r.id = m.role_id
        where m.law_firm_id = $1
          and (m.is_owner = true or 'trust.manage' = any(coalesce(r.permissions, '{}')))`,
      [lawFirmId],
    );
    const recipients = rows.map((x: any) => x.user_id).filter(Boolean);
    if (!recipients.length) return;

    const cause = String(error || 'an unexpected error').replace(/\.$/, '');
    await createNotifications(lawFirmId, recipients, {
      // `alertKey` separates a failed re-credit after a won dispute from a failed
      // first posting of the same payment, so one cannot silence the other.
      eventId: `trust-deposit-posting-failed:${alertKey || paymentIntentId}`,
      type: 'trust_deposit_posting_failed',
      title: 'Trust deposit received but not recorded',
      body: `A trust deposit of ${formatCurrency(amountCents)} has settled into the trust account but `
        + `could not be recorded in the ledger: ${cause}. Fix the cause or record it manually; `
        + `Stripe keeps retrying it (payment ${paymentIntentId}).`,
      actionUrl: `${FRONTEND_URL}/lawfirm/${lawFirmId}/trust`,
    });
  } catch (err) {
    console.error('trust.events: failed to send deposit-posting-failed alert:', err);
  }
});

// This module only registers listeners; it exports nothing. The empty
// export marks it as a MODULE so its top-level consts are file-scoped
// rather than colliding in the global scope with every other events file.
export {};
