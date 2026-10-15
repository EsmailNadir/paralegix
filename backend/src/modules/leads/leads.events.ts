const eventBus = require('../../shared/events/eventBus');
import { and, eq, sql } from 'drizzle-orm';
import { members, roles } from '../../shared/database/drizzle/schema';
import { tenantQuery } from '../../shared/database/queryContext';
const {
  LEAD_STAGE_CHANGED,
  LEAD_CONVERTED,
  LEAD_DELETED,
  INTAKE_SUBMITTED,
} = require('../../shared/events/eventTypes');
const { createNotifications, FRONTEND_URL } = require('../notifications/notifications.service');

/**
 * Notify the firm when a public intake form is submitted. Recipients are the
 * firm owner plus anyone whose role holds `leads.view` or `leads.manage` — the
 * submitter is an anonymous public visitor, so there's no actor to exclude.
 */
eventBus.on(INTAKE_SUBMITTED, async ({ lawFirmId, leadId, templateName, leadName, isNewLead }: any) => {
  try {
    if (!lawFirmId) return;

    const rows = await tenantQuery(members, lawFirmId, ({ executor, scope }) => executor
      .selectDistinct({ userId: members.userId }).from(members)
      .leftJoin(roles, and(eq(roles.lawFirmId, members.lawFirmId), eq(roles.id, members.roleId)))
      .where(and(scope, sql`(
        ${members.isOwner} = true
        or 'leads.view' = any(coalesce(${roles.permissions}, '{}'))
        or 'leads.manage' = any(coalesce(${roles.permissions}, '{}'))
      )`)));
    const recipients = Array.from(new Set(rows.map((r) => r.userId).filter(Boolean)));
    if (!recipients.length) return;

    const label = templateName ? `"${templateName}"` : 'an intake form';
    await createNotifications(lawFirmId, recipients, {
      category: 'intakeSubmitted',
      type: 'intake_submitted',
      title: isNewLead ? 'New lead from intake form' : 'Intake form submitted',
      body: leadName
        ? `${leadName} submitted ${label}`
        : `Someone submitted ${label}`,
      entityType: null,
      entityId: leadId || null,
      matterId: null,
      actionUrl: `${FRONTEND_URL}/lawfirm/${lawFirmId}/clients`,
      createdBy: null,
    });
  } catch (err: any) {
    console.error('[leads.events] INTAKE_SUBMITTED handler error:', err.message);
  }
});

eventBus.on(LEAD_STAGE_CHANGED, ({ lawFirmId, leadId, previousStageId, stageId }: any) => {
  // Future: pipeline analytics / notifications.
});

eventBus.on(LEAD_CONVERTED, ({ lawFirmId, leadId, matterId, clientId }: any) => {
  // Future: audit trail.
});

eventBus.on(LEAD_DELETED, ({ lawFirmId, leadId }: any) => {
  // Future: cascade cleanup if needed beyond FK set-null.
});

// This module only registers listeners; it exports nothing. The empty
// export marks it as a MODULE so its top-level consts are file-scoped
// rather than colliding in the global scope with every other events file.
export {};
