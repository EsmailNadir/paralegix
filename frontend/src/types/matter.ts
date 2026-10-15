import type { Member } from "./member";

export interface Category {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  level: number;
  order: number;
  children?: Category[];
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
}

export interface MatterClient {
  id: string;
  userId?: string | null;
  /** Immutable after creation. Absent on very old responses; treat as 'person'. */
  clientType?: "person" | "company";
  name: string;
  email?: string;
  phone?: string;
  organization?: string;
  address?: string;
  preferredContactMethod?: string | null;
  /**
   * This client's share of the matter's invoices, in basis points
   * (10000 = 100%). Null when the matter is not configured for split billing.
   */
  billingPortionBp?: number | null;
  addedBy?: string;
  lawFirmId: string;
  matterId: string;
  createdAt?: string;      // will come back from backend as ISO
  updatedAt?: string;
}

export type Matter = {
  id: string;
  name: string;
  matterReferenceId?: string;
  matterNumber?: string;
  description?: string;
  status: 'active' | 'completed' | 'blocked' | 'closed' | 'archived';
  // Effective "payment ongoing" flag: money still expected on a functionally-done
  // matter. Derived on the backend (manual override OR outstanding invoice balance)
  // and only ever true on terminal statuses.
  paymentOngoing?: boolean;
  // The raw manual override (drives the edit toggle); distinct from the effective
  // `paymentOngoing`, which also turns on for an outstanding invoice balance.
  paymentOngoingManual?: boolean;
  outstandingBalanceCents?: number;
  lawFirmId?: string;
  practiceAreaId?: string;
  practiceAreaName?: string;
  category?: string;
  courtId?: string;
  courtName?: string;
  /**
   * The matter's clients as identifiable records, ordered by name. Carries the
   * client id, which the parallel `clientNames` / `clientUserIds` arrays can't,
   * so billing can tell WHICH client an invoice or time entry is billed to.
   * Endpoints that return the full matter_clients row supply the wider
   * `MatterClient` shape; the matter list supplies id/name/email only.
   */
  clients?: Array<Pick<MatterClient, "id" | "name"> & Partial<MatterClient>>;
  clientUserIds?: string[];
  clientNames?: string[];
  clientCount?: number;
  fileNames?: string[];
  // The primary lead (the `matters.lead_user_id` column) plus the display name
  // the API joins from `users`. `leadUserIds` carries the full set of leads,
  // derived from `matter_members` with the `lead` role.
  leadUserId?: string;
  leadUserName?: string;
  leadUserIds?: string[];
  members?: Member[];
  memberUserIds?: string[];
  // Pipeline stage (the stage a matter is in, distinct from `status`).
  stageId?: string | null;
  stageName?: string | null;
  stageColor?: string | null;
  stageIsClosed?: boolean;
  // The pipeline (matter_stage_pipelines row) the matter's stage is drawn from.
  stagePipelineId?: string | null;
  stagePipelineName?: string | null;

  // Billing preferences.
  billingMethod?: MatterBillingMethod;
  isBillable?: boolean;
  budgetCents?: number | null;
  budget?: number | null; // budget in dollars (mirror of budgetCents)
  budgetIncludesExpenses?: boolean;
  contingencyPercent?: number | null;
  billedTotalCents?: number; // total invoiced-to-date, feeds the budget burn bar

  // Key dates (day-only 'YYYY-MM-DD' strings).
  openDate?: string | null;
  closeDate?: string | null;
  statuteOfLimitationsDate?: string | null;

  // Custom field values keyed by field-def id.
  customFields?: Record<string, unknown>;

  // Legal hold.
  legalHold?: boolean;
  legalHoldReason?: string | null;
  legalHoldAt?: string | null;
  legalHoldBy?: string | null;

  createdAt: string;
  createdBy?: string;
  updatedAt: string;
  createdAtLocalDisplay?: string;
  createdAtLocalInput?: string;
  updatedAtLocalDisplay?: string;
  updatedAtLocalInput?: string;

  /**
   * How many notes the matter has. The notes themselves do NOT travel with the
   * matter - they accumulate for its whole life, and this payload is paid for by
   * every tab, so the notes panel reads its own page instead.
   */
  totalNotes?: number;
};

export type MatterBillingMethod = 'hourly' | 'flat' | 'contingency' | 'pro_bono';

export type MatterContactRole =
  | 'opposing_counsel' | 'opposing_party' | 'co_counsel' | 'judge' | 'witness'
  | 'expert' | 'adjuster' | 'court_clerk' | 'mediator' | 'guardian_ad_litem' | 'other';

/**
 * A directory contact as it appears on one matter: the link's own fields (the
 * role played here, the matter-specific note, the display order) flattened onto
 * the shared contact record it points at.
 *
 * `id` is the LINK id - what the per-matter endpoints address. `contactId` is
 * the directory record, which is what a caller follows to the contact page.
 * Everything from `name` down is shared with every other matter this contact is
 * on and is edited through the contacts module, not from here.
 */
export interface MatterContact {
  id: string;
  matterId?: string;
  contactId: string;
  role: MatterContactRole;
  /** The matter-specific note; the contact's own note is `contactNotes`. */
  notes?: string | null;
  sortOrder?: number;

  name: string;
  contactType?: 'person' | 'company';
  category?: string;
  organization?: string | null;
  title?: string | null;
  barNumber?: string | null;
  email?: string | null;
  phone?: string | null;
  phoneAlt?: string | null;
  fax?: string | null;
  website?: string | null;
  address?: string | null;
  contactNotes?: string | null;
  isArchived?: boolean;
  oneTime?: boolean;
  courtId?: string | null;

  createdAt?: string;
  updatedAt?: string;
}

export interface MatterActivity {
  id: string;
  matterId?: string;
  activityType: string;
  actorUserId?: string | null;
  actorName?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type MatterFieldType =
  | 'text' | 'textarea' | 'number' | 'currency' | 'date'
  | 'select' | 'multiselect' | 'checkbox' | 'url' | 'email' | 'phone';

export interface MatterFieldOption {
  label: string;
  value: string;
}

export interface MatterFieldDef {
  id: string;
  practiceAreaId?: string | null;
  label: string;
  fieldType: MatterFieldType;
  options: MatterFieldOption[];
  helpText?: string | null;
  required: boolean;
  sortOrder: number;
  archived: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface MatterStage {
  id: string;
  pipelineId: string;
  name: string;
  color?: string | null;
  sortOrder: number;
  isClosed: boolean;
  parentStageId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** A named, optionally practice-area-scoped stage pipeline a matter can be assigned to. */
export interface MatterStagePipeline {
  id: string;
  practiceAreaId?: string | null;
  name: string;
  isDefault: boolean;
  stages: MatterStage[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ConflictCheckRecord {
  id: string;
  performedBy?: string | null;
  performedByName?: string | null;
  queryName?: string | null;
  queryEmail?: string | null;
  queryOrganization?: string | null;
  resultCount: number;
  results: ConflictCheckResult[];
  createdAt: string;
}

/**
 * One match from a conflict-of-interest check.
 *
 * A match can be a client the firm acts for or a contact from the firm-wide
 * directory (opposing counsel, an opposing party, an expert) - `partyType` says
 * which, and `partyName` names them either way. `clientId`/`clientName` are
 * populated only for client matches, and remain on records written before
 * contacts were searched at all.
 */
export interface ConflictCheckResult {
  matchType?: string;
  matchValue?: string;
  searchValue?: string;
  partyType?: 'client' | 'contact';
  partyName?: string;
  clientId?: string;
  clientName?: string;
  contactId?: string;
  contactCategory?: string;
  matterId?: string;
  matterName?: string;
  source?: string;
}
