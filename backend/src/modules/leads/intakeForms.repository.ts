import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { intakeFormTemplates, intakeSubmissions } from '../../shared/database/drizzle/schema';
import { tenantQuery, tokenQuery, type DrizzleExecutor } from '../../shared/database/queryContext';
import { scopedDelete, scopedInsert, scopedUpdate } from '../../shared/database/scopedWrite';

const crypto = require('crypto');
const { isUuid } = require('../../shared/utils/isUuid');
const { rowIso: iso } = require('../../shared/utils/dateConversion');
const { DEFAULT_INTAKE_FORM } = require('../../shared/referenceData/defaults');

function formatTemplate(row: any, { includeAccessCodeHash = false } = {}) {
  if (!row) return null;
  const out: any = {
    id: row.id,
    lawFirmId: row.lawFirmId,
    practiceAreaId: row.practiceAreaId || null,
    name: row.name,
    publicToken: row.publicToken,
    fields: Array.isArray(row.fields) ? row.fields : [],
    hasAccessCode: Boolean(row.accessCodeHash),
    isActive: row.isActive !== false,
    createdBy: row.createdBy || null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
  if (includeAccessCodeHash) out.accessCodeHash = row.accessCodeHash || null;
  return out;
}

function formatSubmission(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    lawFirmId: row.lawFirmId,
    intakeFormTemplateId: row.intakeFormTemplateId,
    token: row.token,
    fieldValues: row.fieldValues || {},
    status: row.status,
    deliveryStatus: row.deliveryStatus,
    leadId: row.leadId || null,
    sentToEmail: row.sentToEmail || null,
    sentBy: row.sentBy || null,
    sentAt: iso(row.sentAt),
    openedAt: iso(row.openedAt),
    submittedIp: row.submittedIp || null,
    createdAt: iso(row.createdAt),
    completedAt: iso(row.completedAt),
  };
}

function mintToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function hashAccessCode(code: any) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

class IntakeFormsRepository {
  async listTemplates(lawFirmId: string) {
    const rows = await tenantQuery(intakeFormTemplates, lawFirmId, ({ executor, scope }) => executor
      .select().from(intakeFormTemplates).where(scope)
      .orderBy(asc(intakeFormTemplates.name), asc(intakeFormTemplates.createdAt)));
    return rows.map((r) => formatTemplate(r));
  }

  async getTemplateById(lawFirmId: string, templateId: string, opts: any = {}) {
    if (!isUuid(templateId)) return null;
    const rows = await tenantQuery(intakeFormTemplates, lawFirmId, ({ executor, scope }) => executor
      .select().from(intakeFormTemplates)
      .where(and(scope, eq(intakeFormTemplates.id, templateId))).limit(1));
    return rows[0] ? formatTemplate(rows[0], opts) : null;
  }

  async getTemplateByPublicToken(token: any) {
    if (!token || typeof token !== 'string') return null;
    const rows: any[] = await tokenQuery(token, (executor) => executor
      .select().from(intakeFormTemplates)
      .where(eq(intakeFormTemplates.publicToken, token))
      .limit(1));
    return rows[0] ? formatTemplate(rows[0], { includeAccessCodeHash: true }) : null;
  }

  async createTemplate(lawFirmId: string, data: any, executor?: DrizzleExecutor) {
    const rows = await scopedInsert(intakeFormTemplates, lawFirmId, {
      name: data.name,
      practiceAreaId: isUuid(data.practiceAreaId) ? data.practiceAreaId : null,
      publicToken: mintToken(),
      fields: data.fields || [],
      accessCodeHash: data.accessCodeHash || null,
      isActive: data.isActive !== false,
      createdBy: data.createdBy || null,
    }, executor);
    return formatTemplate(rows[0]);
  }

  /** Seed the default public intake form (see DEFAULT_INTAKE_FORM). */
  async createDefaultTemplate(lawFirmId: string, { createdBy }: any = {}, executor?: DrizzleExecutor) {
    return this.createTemplate(lawFirmId, {
      name: DEFAULT_INTAKE_FORM.name,
      fields: DEFAULT_INTAKE_FORM.fields,
      createdBy: createdBy || null,
    }, executor);
  }

  async updateTemplate(lawFirmId: string, templateId: string, updates: any) {
    if (!isUuid(templateId)) return null;
    const values: Record<string, unknown> = {};
    for (const field of ['name', 'practiceAreaId', 'fields', 'accessCodeHash', 'isActive', 'publicToken']) {
      if (updates[field] !== undefined) values[field] = updates[field];
    }
    if (!Object.keys(values).length) return this.getTemplateById(lawFirmId, templateId);
    const rows = await scopedUpdate(
      intakeFormTemplates, lawFirmId, eq(intakeFormTemplates.id, templateId), values,
    );
    return rows[0] ? formatTemplate(rows[0]) : null;
  }

  async deleteTemplate(lawFirmId: string, templateId: string) {
    if (!isUuid(templateId)) return false;
    const rows = await scopedDelete(
      intakeFormTemplates, lawFirmId, eq(intakeFormTemplates.id, templateId),
    );
    return rows.length > 0;
  }

  async regeneratePublicToken(lawFirmId: string, templateId: string) {
    return this.updateTemplate(lawFirmId, templateId, { publicToken: mintToken() });
  }

  async getSubmissionByToken(token: any) {
    if (!token || typeof token !== 'string') return null;
    const rows: any[] = await tokenQuery(token, (executor) => executor
      .select().from(intakeSubmissions)
      .where(eq(intakeSubmissions.token, token))
      .limit(1));
    return rows[0] ? formatSubmission(rows[0]) : null;
  }

  async findOpenSubmissionForLeadTemplate(lawFirmId: string, leadId: string, templateId: string) {
    if (!isUuid(leadId) || !isUuid(templateId)) return null;
    const rows = await tenantQuery(intakeSubmissions, lawFirmId, ({ executor, scope }) => executor
      .select().from(intakeSubmissions)
      .where(and(
        scope,
        eq(intakeSubmissions.leadId, leadId),
        eq(intakeSubmissions.intakeFormTemplateId, templateId),
        eq(intakeSubmissions.status, 'sent'),
      ))
      .orderBy(desc(intakeSubmissions.createdAt))
      .limit(1));
    return rows[0] ? formatSubmission(rows[0]) : null;
  }

  async createSubmission(lawFirmId: string, data: any) {
    const rows = await scopedInsert(intakeSubmissions, lawFirmId, {
      intakeFormTemplateId: data.intakeFormTemplateId,
      token: data.token || mintToken(),
      fieldValues: data.fieldValues || {},
      status: data.status || 'sent',
      deliveryStatus: data.deliveryStatus || 'sent',
      leadId: data.leadId || null,
      sentToEmail: data.sentToEmail || null,
      sentBy: data.sentBy || null,
      sentAt: data.sentAt || null,
      openedAt: data.openedAt || null,
      submittedIp: data.submittedIp || null,
      completedAt: data.completedAt || null,
    });
    return formatSubmission(rows[0]);
  }

  async updateSubmission(lawFirmId: string, submissionId: any, updates: any) {
    if (!isUuid(submissionId)) return null;
    const values: Record<string, unknown> = {};
    for (const field of [
      'token', 'fieldValues', 'status', 'leadId', 'sentToEmail', 'sentBy',
      'sentAt', 'openedAt', 'submittedIp', 'completedAt', 'deliveryStatus',
    ]) {
      if (updates[field] !== undefined) values[field] = updates[field];
    }
    if (!Object.keys(values).length) return null;
    const rows = await scopedUpdate(
      intakeSubmissions, lawFirmId, eq(intakeSubmissions.id, submissionId), values,
    );
    return rows[0] ? formatSubmission(rows[0]) : null;
  }

  /**
   * Atomically transition a submission from 'sent' to 'completed'.
   *
   * Scoped to status = 'sent' so that if two concurrent requests attempt to
   * complete the same targeted submission, exactly one updates the row and
   * the other matches zero rows and returns null.
   */
  async claimAndCompleteSubmission(lawFirmId: string, submissionId: any, updates: any, executor?: any) {
    if (!isUuid(submissionId)) return null;
    const values: Record<string, unknown> = {
      status: 'completed',
      completedAt: updates.completedAt || new Date(),
    };
    if (updates.fieldValues !== undefined) values.fieldValues = updates.fieldValues;
    if (updates.submittedIp !== undefined) values.submittedIp = updates.submittedIp;

    const rows = await scopedUpdate(
      intakeSubmissions,
      lawFirmId,
      and(eq(intakeSubmissions.id, submissionId), eq(intakeSubmissions.status, 'sent'))!,
      values,
      executor,
    );
    return rows[0] ? formatSubmission(rows[0]) : null;
  }

  async markOpened(lawFirmId: string, submissionId: any) {
    if (!isUuid(submissionId)) return null;
    const rows = await scopedUpdate(
      intakeSubmissions,
      lawFirmId,
      and(eq(intakeSubmissions.id, submissionId), isNull(intakeSubmissions.openedAt))!,
      { openedAt: new Date() },
    );
    if (!rows.length) {
      const existing: any[] = await tenantQuery(intakeSubmissions, lawFirmId, ({ executor, scope }) => executor
        .select().from(intakeSubmissions)
        .where(and(scope, eq(intakeSubmissions.id, submissionId))).limit(1));
      return existing[0] ? formatSubmission(existing[0]) : null;
    }
    return formatSubmission(rows[0]);
  }
}

export = Object.assign(new IntakeFormsRepository(), {
  formatTemplate,
  formatSubmission,
  mintToken,
  hashAccessCode,
});
