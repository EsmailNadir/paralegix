/**
 * Tell the firm when a client verifies their identity. Recipients are the
 * firm owner and every member whose role can view clients, the same people who
 * can open the client record the notification links to.
 *
 * Idempotent under an outbox re-dispatch: the notification is keyed on the
 * verification id, so a second dispatch collapses into the first.
 */
import { and, eq, sql } from 'drizzle-orm';
import eventBus from '../../shared/events/eventBus';
import { CLIENT_IDENTITY_VERIFIED } from '../../shared/events/eventTypes';
import { members, roles } from '../../shared/database/drizzle/schema';
import { tenantQuery } from '../../shared/database/queryContext';
import { createNotifications, FRONTEND_URL } from '../notifications/notifications.service';

eventBus.on(CLIENT_IDENTITY_VERIFIED, async (payload: any) => {
  try {
    const { lawFirmId, clientId, verificationId, clientName, issuer, nameMatchesRecord } = payload || {};
    if (!lawFirmId || !clientId) return;

    const rows = await tenantQuery(members, lawFirmId, ({ executor, scope }) => executor
      .selectDistinct({ userId: members.userId }).from(members)
      .leftJoin(roles, and(eq(roles.lawFirmId, members.lawFirmId), eq(roles.id, members.roleId)))
      .where(and(scope, sql`(
        ${members.isOwner} = true
        or 'clients.view' = any(coalesce(${roles.permissions}, '{}'))
      )`)));
    const recipients = Array.from(new Set(rows.map((r) => r.userId).filter(Boolean)));
    if (!recipients.length) return;

    const who = clientName || 'A client';
    const source = issuer ? `an ID issued by ${issuer}` : 'their ID';
    const body = nameMatchesRecord === false
      ? `Verified with ${source}. The name on the ID differs from the client record.`
      : `Verified with ${source}.`;

    await createNotifications(lawFirmId, recipients, {
      type: 'client_identity_verified',
      eventId: verificationId ? `client-identity-verified:${verificationId}` : undefined,
      title: `${who} verified their identity`,
      body,
      actionUrl: `${FRONTEND_URL}/lawfirm/${lawFirmId}/clients/${clientId}`,
      createdBy: null,
    });
  } catch (err: any) {
    console.error('identityVerification.events CLIENT_IDENTITY_VERIFIED failed:', err?.message);
  }
});
