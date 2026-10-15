/**
 * Lead pipeline types - prospect records that sit outside the clients table
 * until converted into a client + matter.
 */

export type IntakeSubmissionStatus = 'sent' | 'completed' | 'rejected';

export type IntakeFieldType = 'text' | 'textarea' | 'email' | 'phone' | 'select';

export interface IntakeFormField {
  key: string;
  label: string;
  type: IntakeFieldType;
  required?: boolean;
  options?: string[];
}

/** A field as sent on save: a missing key tells the backend to derive one from the label. */
export type IntakeFormFieldInput = Omit<IntakeFormField, 'key'> & { key?: string };

/** Latest intake submission attached to a lead (from getById with intake status). */
export interface LatestIntakeSubmission {
  id: string;
  status: IntakeSubmissionStatus;
  deliveryStatus?: 'pending' | 'sent' | 'failed';
  intakeFormTemplateId: string;
  sentToEmail: string | null;
  sentAt: string | null;
  openedAt: string | null;
  completedAt: string | null;
}

export interface Lead {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  organization: string | null;
  referralSource: string | null;
  notes: string | null;
  stageId: string | null;
  /** Date associated with the lead's current stage, e.g. a scheduled consultation or follow-up. 'YYYY-MM-DD'. */
  stageDate: string | null;
  disqualifyReason: string | null;
  convertedClientId: string | null;
  convertedMatterId: string | null;
  convertedAt: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present on get-by-id responses that join the latest submission. */
  latestIntakeSubmission?: LatestIntakeSubmission | null;
}

/** Same shape as MatterStage - branching pipeline via parentStageId. */
export interface LeadStage {
  id: string;
  practiceAreaId?: string | null;
  name: string;
  color?: string | null;
  sortOrder: number;
  isClosed: boolean;
  parentStageId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface IntakeFormTemplate {
  id: string;
  lawFirmId?: string;
  practiceAreaId?: string | null;
  name: string;
  publicToken: string;
  fields: IntakeFormField[];
  /** True when an access code is set; the hash itself is never returned to the firm UI. */
  hasAccessCode?: boolean;
  isActive: boolean;
  createdBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface LeadUpsertPayload {
  name: string;
  email?: string | null;
  phone?: string | null;
  organization?: string | null;
  referralSource?: string | null;
  notes?: string | null;
  stageId?: string | null;
  stageDate?: string | null;
  disqualifyReason?: string | null;
}

export interface ConvertLeadPayload {
  /** Defaults to true server-side when omitted. Set false to convert to a client only. */
  createMatter?: boolean;
  /**
   * Defaults to 'person' server-side when omitted. 'company' converts into the
   * organization named by `organizationClientId` or `organizationName`, falling
   * back to the lead's own `organization` field.
   */
  clientType?: "person" | "company";
  /** An existing organization client to convert into; the lead joins its roster. */
  organizationClientId?: string;
  /** A new organization's name; an existing one with this name is reused. */
  organizationName?: string;
  /** Required unless createMatter is false. */
  name?: string;
  matterNumber?: string;
  description?: string;
  practiceAreaId?: string;
  category?: string;
  courtId?: string;
  leadUserId?: string;
  leadUserIds?: string[];
}
