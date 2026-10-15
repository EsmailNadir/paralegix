import { getUserTimeZone } from '@/lib/utils/timezone';
import { apiFetch, publicFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { toApiError } from '@/lib/utils/apiErrors';
import { applyListSortSearch, applyListWindow } from '@/lib/utils/listQuery';
import { authenticatedHeaders } from './base.service';
import requestDeduplicator from './requestDeduplicator';
import type {
  ConvertLeadPayload,
  IntakeFormField,
  IntakeFormFieldInput,
  IntakeFormTemplate,
  Lead,
  LeadStage,
  LeadUpsertPayload,
  LatestIntakeSubmission,
} from '@/types/lead';

function asRecord(value: unknown): Record<string, any> {
  if (typeof value === 'object' && value !== null) return value as Record<string, any>;
  return {};
}

function asArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function timestampToIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

function normalizeIntakeSubmission(raw: unknown): LatestIntakeSubmission | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = asRecord(raw);
  const id = asString(record.id);
  if (!id) return null;
  const status = asString(record.status);
  return {
    id,
    status: (status === 'completed' || status === 'rejected' ? status : 'sent') as LatestIntakeSubmission['status'],
    intakeFormTemplateId: asString(record.intakeFormTemplateId) || '',
    sentToEmail: asString(record.sentToEmail),
    sentAt: timestampToIso(record.sentAt),
    openedAt: timestampToIso(record.openedAt),
    completedAt: timestampToIso(record.completedAt),
  };
}

function normalizeLead(raw: unknown): Lead {
  const record = asRecord(raw);
  const createdAt = timestampToIso(record.createdAt) || '';
  const updatedAt = timestampToIso(record.updatedAt) || createdAt;
  const lead: Lead = {
    id: asString(record.id) || '',
    name: asString(record.name) || '',
    email: asString(record.email),
    phone: asString(record.phone),
    organization: asString(record.organization),
    referralSource: asString(record.referralSource),
    notes: asString(record.notes),
    stageId: asString(record.stageId),
    stageDate: asString(record.stageDate),
    disqualifyReason: asString(record.disqualifyReason),
    convertedClientId: asString(record.convertedClientId),
    convertedMatterId: asString(record.convertedMatterId),
    convertedAt: timestampToIso(record.convertedAt),
    createdBy: asString(record.createdBy),
    createdAt,
    updatedAt,
  };
  if ('latestIntakeSubmission' in record) {
    lead.latestIntakeSubmission = normalizeIntakeSubmission(record.latestIntakeSubmission);
  }
  return lead;
}

function normalizeStage(raw: unknown): LeadStage {
  const record = asRecord(raw);
  return {
    id: asString(record.id) || '',
    practiceAreaId: asString(record.practiceAreaId),
    name: asString(record.name) || '',
    color: asString(record.color),
    sortOrder: typeof record.sortOrder === 'number' ? record.sortOrder : 0,
    isClosed: record.isClosed === true,
    parentStageId: asString(record.parentStageId),
    createdAt: timestampToIso(record.createdAt) || undefined,
    updatedAt: timestampToIso(record.updatedAt) || undefined,
  };
}

function normalizeField(raw: unknown): IntakeFormField {
  const record = asRecord(raw);
  const type = asString(record.type);
  const allowed: IntakeFormField['type'][] = ['text', 'textarea', 'email', 'phone', 'select'];
  return {
    key: asString(record.key) || '',
    label: asString(record.label) || '',
    type: allowed.includes(type as IntakeFormField['type'])
      ? (type as IntakeFormField['type'])
      : 'text',
    required: record.required === true,
    options: asArray<string>(record.options).filter(Boolean),
  };
}

function normalizeTemplate(raw: unknown): IntakeFormTemplate {
  const record = asRecord(raw);
  return {
    id: asString(record.id) || '',
    lawFirmId: asString(record.lawFirmId) || undefined,
    practiceAreaId: asString(record.practiceAreaId),
    name: asString(record.name) || '',
    publicToken: asString(record.publicToken) || '',
    fields: asArray(record.fields).map(normalizeField),
    hasAccessCode: record.hasAccessCode === true,
    isActive: record.isActive !== false,
    createdBy: asString(record.createdBy),
    createdAt: timestampToIso(record.createdAt) || undefined,
    updatedAt: timestampToIso(record.updatedAt) || undefined,
  };
}

class LeadsService {
  private apiRoot: string;

  constructor() {
    const API_ROOT = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    this.apiRoot = API_ROOT.replace(/\/$/, '');
  }

  private leadsBase(lawFirmId: string): string {
    return `${this.apiRoot}/lawfirms/${encodeURIComponent(lawFirmId)}/leads`;
  }

  private leadUrl(lawFirmId: string, leadId: string): string {
    return `${this.leadsBase(lawFirmId)}/${encodeURIComponent(leadId)}`;
  }

  private stagesUrl(lawFirmId: string): string {
    return `${this.apiRoot}/lawfirms/${encodeURIComponent(lawFirmId)}/lead-stages`;
  }

  private intakeFormsUrl(lawFirmId: string): string {
    return `${this.apiRoot}/lawfirms/${encodeURIComponent(lawFirmId)}/intake-forms`;
  }

  private async authHeaders(extra: Record<string, string> = {}) {
    return authenticatedHeaders(extra);
  }

  // ─── Leads ───────────────────────────────────────────────────────────────

  async listLeadsPaged(
    lawFirmId: string,
    params: {
      page?: number;
      limit?: number;
      offset?: number;
      search?: string;
      stageId?: string;
      sortBy?: string;
      order?: 'asc' | 'desc';
      sort?: Array<{ field: string; sort: 'asc' | 'desc' }>;
    } = {},
  ): Promise<{ leads: Lead[]; totalItems: number }> {
    const url = new URL(this.leadsBase(lawFirmId));
    applyListWindow(url, params, { maxLimit: 500 });
    if (params.stageId) url.searchParams.set('stageId', params.stageId);
    applyListSortSearch(url, params);

    const response = await requestDeduplicator.execute<{ leads?: unknown[]; totalItems?: number }>(
      url.toString(),
      {
        method: 'GET',
        headers: await this.authHeaders({ 'X-Timezone': getUserTimeZone() }),
      },
    );

    const leads = asArray(response?.leads).map(normalizeLead).filter((l) => Boolean(l.id));
    return { leads, totalItems: response?.totalItems ?? leads.length };
  }

  async getLead(lawFirmId: string, leadId: string): Promise<Lead> {
    const response = await requestDeduplicator.execute<{ lead?: unknown }>(
      this.leadUrl(lawFirmId, leadId),
      { method: 'GET', headers: await this.authHeaders() },
    );
    const record = asRecord(response);
    return normalizeLead(record.lead ?? record);
  }

  async createLead(
    lawFirmId: string,
    payload: LeadUpsertPayload,
  ): Promise<{ message: string; leadId: string; lead: Lead }> {
    const url = this.leadsBase(lawFirmId);
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to create lead', { method: 'POST', url });
    }
    const body = await response.json();
    return {
      message: body.message || 'Lead created successfully',
      leadId: body.leadId || body.lead?.id,
      lead: normalizeLead(body.lead),
    };
  }

  async updateLead(
    lawFirmId: string,
    leadId: string,
    payload: Partial<LeadUpsertPayload>,
  ): Promise<{ message: string; lead: Lead }> {
    const url = this.leadUrl(lawFirmId, leadId);
    const response = await apiFetch(url, {
      method: 'PUT',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to update lead', { method: 'PUT', url });
    }
    const body = await response.json();
    return {
      message: body.message || 'Lead updated successfully',
      lead: normalizeLead(body.lead),
    };
  }

  async deleteLead(lawFirmId: string, leadId: string): Promise<{ message: string }> {
    const url = this.leadUrl(lawFirmId, leadId);
    const response = await apiFetch(url, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to delete lead', { method: 'DELETE', url });
    }
    return response.json();
  }

  async convertLead(
    lawFirmId: string,
    leadId: string,
    payload: ConvertLeadPayload,
  ): Promise<{ message: string; matterId: string | null; clientId: string | null; lead: Lead }> {
    const url = `${this.leadUrl(lawFirmId, leadId)}/convert`;
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to convert lead', { method: 'POST', url });
    }
    const body = await response.json();
    return {
      message: body.message || 'Lead converted successfully',
      matterId: body.matterId,
      clientId: body.clientId ?? null,
      lead: normalizeLead(body.lead),
    };
  }

  async sendIntakeForm(
    lawFirmId: string,
    leadId: string,
    payload: { intakeFormTemplateId: string; email?: string },
  ): Promise<{ message: string }> {
    const url = `${this.leadUrl(lawFirmId, leadId)}/send-intake-form`;
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to send intake form', { method: 'POST', url });
    }
    return response.json();
  }

  // ─── Lead stages ─────────────────────────────────────────────────────────

  async listStages(lawFirmId: string): Promise<LeadStage[]> {
    const response = await requestDeduplicator.execute<{ stages?: unknown[] }>(
      this.stagesUrl(lawFirmId),
      { method: 'GET', headers: await this.authHeaders() },
    );
    return asArray(response?.stages).map(normalizeStage).filter((s) => Boolean(s.id));
  }

  async createStage(
    lawFirmId: string,
    stage: Partial<LeadStage>,
  ): Promise<{ stage: LeadStage }> {
    const url = this.stagesUrl(lawFirmId);
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(stage),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to create lead stage', { method: 'POST', url });
    }
    const body = await response.json();
    return { stage: normalizeStage(body.stage) };
  }

  async updateStage(
    lawFirmId: string,
    stageId: string,
    stage: Partial<LeadStage>,
  ): Promise<{ stage: LeadStage }> {
    const url = `${this.stagesUrl(lawFirmId)}/${encodeURIComponent(stageId)}`;
    const response = await apiFetch(url, {
      method: 'PUT',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(stage),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to update lead stage', { method: 'PUT', url });
    }
    const body = await response.json();
    return { stage: normalizeStage(body.stage) };
  }

  async deleteStage(lawFirmId: string, stageId: string): Promise<{ message: string }> {
    const url = `${this.stagesUrl(lawFirmId)}/${encodeURIComponent(stageId)}`;
    const response = await apiFetch(url, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to delete lead stage', { method: 'DELETE', url });
    }
    return response.json();
  }

  async reorderStages(
    lawFirmId: string,
    stageIds: string[],
  ): Promise<{ stages: LeadStage[] }> {
    const url = `${this.stagesUrl(lawFirmId)}/reorder`;
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ stageIds }),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to reorder lead stages', { method: 'POST', url });
    }
    const body = await response.json();
    return { stages: asArray(body.stages).map(normalizeStage) };
  }

  // ─── Intake form templates (firm) ────────────────────────────────────────

  async listIntakeForms(lawFirmId: string): Promise<IntakeFormTemplate[]> {
    const response = await requestDeduplicator.execute<{ templates?: unknown[] }>(
      this.intakeFormsUrl(lawFirmId),
      { method: 'GET', headers: await this.authHeaders() },
    );
    return asArray(response?.templates).map(normalizeTemplate).filter((t) => Boolean(t.id));
  }

  async createIntakeForm(
    lawFirmId: string,
    payload: {
      name: string;
      practiceAreaId?: string | null;
      fields?: IntakeFormFieldInput[];
      accessCode?: string | null;
      isActive?: boolean;
    },
  ): Promise<{ template: IntakeFormTemplate }> {
    const url = this.intakeFormsUrl(lawFirmId);
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to create intake form', { method: 'POST', url });
    }
    const body = await response.json();
    return { template: normalizeTemplate(body.template) };
  }

  async updateIntakeForm(
    lawFirmId: string,
    templateId: string,
    payload: {
      name?: string;
      practiceAreaId?: string | null;
      fields?: IntakeFormFieldInput[];
      accessCode?: string | null;
      isActive?: boolean;
    },
  ): Promise<{ template: IntakeFormTemplate }> {
    const url = `${this.intakeFormsUrl(lawFirmId)}/${encodeURIComponent(templateId)}`;
    const response = await apiFetch(url, {
      method: 'PUT',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to update intake form', { method: 'PUT', url });
    }
    const body = await response.json();
    return { template: normalizeTemplate(body.template) };
  }

  async deleteIntakeForm(lawFirmId: string, templateId: string): Promise<{ message: string }> {
    const url = `${this.intakeFormsUrl(lawFirmId)}/${encodeURIComponent(templateId)}`;
    const response = await apiFetch(url, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to delete intake form', { method: 'DELETE', url });
    }
    return response.json();
  }

  async regenerateIntakeFormToken(
    lawFirmId: string,
    templateId: string,
  ): Promise<{ template: IntakeFormTemplate }> {
    const url = `${this.intakeFormsUrl(lawFirmId)}/${encodeURIComponent(templateId)}/regenerate-token`;
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to regenerate token', { method: 'POST', url });
    }
    const body = await response.json();
    return { template: normalizeTemplate(body.template) };
  }

  // ─── Public intake (no auth) ─────────────────────────────────────────────

  async getPublicIntakeForm(token: string): Promise<Record<string, unknown>> {
    const url = `${this.apiRoot}/intake/${encodeURIComponent(token)}`;
    const response = await publicFetch(url);
    if (!response.ok) {
      throw await toApiError(response, 'Failed to load intake form', { method: 'GET', url });
    }
    return response.json();
  }

  async verifyPublicIntakeAccessCode(
    token: string,
    code: string,
  ): Promise<Record<string, unknown>> {
    const url = `${this.apiRoot}/intake/${encodeURIComponent(token)}/verify-access-code`;
    const response = await publicFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Incorrect access code', { method: 'POST', url });
    }
    return response.json();
  }

  async submitPublicIntakeForm(
    token: string,
    payload: { fieldValues: Record<string, string>; accessCode?: string },
  ): Promise<{ id: string }> {
    const url = `${this.apiRoot}/intake/${encodeURIComponent(token)}/submit`;
    const response = await publicFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw await toApiError(response, 'Failed to submit intake form', { method: 'POST', url });
    }
    return response.json();
  }
}

const leadsService = new LeadsService();
export default leadsService;
