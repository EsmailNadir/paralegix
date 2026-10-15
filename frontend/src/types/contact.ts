/**
 * The firm-wide contact directory: the canonical record for every non-client
 * person or organization the firm deals with (opposing counsel, judges,
 * experts, adjusters). Matters point at these through `MatterContact` rather
 * than holding their own copy.
 *
 * Distinct from `Client` (which has billing rates and a portal login) and from
 * `ClientContact` (the people at one client).
 */

export type ContactType = "person" | "company";

/**
 * What a contact usually IS, independent of any one matter. Wider than
 * `MatterContactRole`, which is what they are ON a given matter.
 */
export type ContactCategory =
  | "opposing_counsel"
  | "opposing_party"
  | "co_counsel"
  | "judge"
  | "witness"
  | "expert"
  | "adjuster"
  | "court_clerk"
  | "mediator"
  | "guardian_ad_litem"
  | "court_reporter"
  | "vendor"
  | "other";

export interface Contact {
  id: string;
  contactType: ContactType;
  name: string;
  category: ContactCategory;
  organization?: string | null;
  title?: string | null;
  barNumber?: string | null;
  email?: string | null;
  phone?: string | null;
  phoneAlt?: string | null;
  fax?: string | null;
  website?: string | null;
  address?: string | null;
  courtId?: string | null;
  notes?: string | null;
  tags: string[];
  isArchived: boolean;
  /** Scoped to the single matter it was created for; excluded from the shared directory and pickers by default. */
  oneTime: boolean;
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  /** Joined on the list and detail reads only. */
  matterCount?: number;
  courtName?: string | null;
}

/** A matter this contact appears on, and the role they play there. */
export interface ContactMatterLink {
  linkId: string;
  matterId: string;
  matterName: string;
  matterNumber?: string | null;
  matterStatus?: string | null;
  role: string;
  notes?: string | null;
  linkedAt?: string | null;
}

/** Create/update payload. `null` explicitly CLEARS a field; `undefined` leaves it. */
export interface ContactUpsertPayload {
  name?: string;
  contactType?: ContactType;
  category?: ContactCategory;
  organization?: string | null;
  title?: string | null;
  barNumber?: string | null;
  email?: string | null;
  phone?: string | null;
  phoneAlt?: string | null;
  fax?: string | null;
  website?: string | null;
  address?: string | null;
  courtId?: string | null;
  notes?: string | null;
  tags?: string[];
  isArchived?: boolean;
  oneTime?: boolean;
}
