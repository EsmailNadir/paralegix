import type { ClientSettings } from './preferences';

export type ClientStatus = 'active' | 'archived' | 'inactive';
export type PreferredContactMethod = 'email' | 'phone' | 'sms' | 'portal';
/**
 * `clients.client_type`, immutable after the row is created (enforced by a DB
 * trigger). A `person` client is optionally linked to one portal user directly
 * (`clients.userId`); a `company` client never carries a `userId` of its own.
 * Its roster people are Person clients in their own right, so their portal
 * identity is their own client record's (see `CompanyRosterContact` below).
 */
export type ClientType = 'person' | 'company';
/**
 * A company roster contact's portal-invite lifecycle, derived client-side from
 * `CompanyRosterContact.userId` / `portalInvitePending`. The backend exposes no
 * separate "revoked" flag. A link that once had access and lost it (via
 * `DELETE .../portal-access`) looks identical to one that was never invited.
 */
export type ClientContactPortalStatus = 'linked' | 'pending' | 'none';

/**
 * A PERSON client's own related contact - a guardian, an assistant, etc.
 * Unchanged by the organization-clients migration.
 *
 * The person is a row in the firm-wide contact directory; this is the link to
 * one client. `id` is the LINK id (what the client-contact endpoints address);
 * `contactId` is the directory record. `relationship` and `isPrimary` belong to
 * the link, everything from `name` down is the shared contact, so editing a
 * phone number here corrects it on every matter that person appears on too.
 *
 * `isEmailRecipient` and `canViewBilling` are stored preferences on the link.
 * They are shown and edited here and authorize nothing: the portal's billing
 * gate is `client_company_links.can_view_billing`, a different relationship
 * entirely. There are no portal identity fields, because a person client's own
 * related contact is a directory entry and never has a portal login; the five
 * columns that pretended otherwise went with backend migration 0261.
 */
export interface PersonRelatedContact {
  id: string;
  contactId: string;
  /** Never present on this variant; distinguishes it from `CompanyRosterContact`. */
  personClientId?: undefined;
  clientId?: string;
  lawFirmId?: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  organization?: string | null;
  relationship?: string | null;
  notes?: string | null;
  isPrimary?: boolean;
  isEmailRecipient?: boolean;
  canViewBilling?: boolean;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * One person linked to a COMPANY client's roster (organization-clients plan).
 *
 * The person is a real, standalone Person `clients` row now (their own
 * matters, billing, and portal identity), linked to the company through
 * `client_company_links`. `id` is the LINK id (what the client-contact
 * endpoints address); `personClientId` is that person's own `clients.id`,
 * for navigating to or editing their record directly. Unlike
 * `PersonRelatedContact`, name/email/phone are NOT editable through this
 * link - they belong to the linked person's own client record - and there is
 * no `title`/`organization`/`notes`, since a Person client has none.
 *
 * The linked person's own portal identity/invite lifecycle is exposed here
 * read-only (`userId`/`invitedAt`/`joinedAt`) but managed through the
 * ordinary client portal-invite flow on their own client page, not through
 * this link - the roster-specific invite/resend/revoke endpoints are gone.
 */
export interface CompanyRosterContact {
  id: string;
  /** Never present on this variant; distinguishes it from `PersonRelatedContact`. */
  contactId?: undefined;
  personClientId: string;
  clientId?: string;
  lawFirmId?: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  /** The linked person's own client status. */
  status?: ClientStatus;
  relationship?: string | null;
  isPrimary?: boolean;
  isEmailRecipient?: boolean;
  canViewBilling?: boolean;
  /** The linked person's own portal login uid, or null if they have no portal access. */
  userId?: string | null;
  /** A targeted portal invite is outstanding, awaiting acceptance. */
  portalInvitePending?: boolean;
  invitedAt?: string | null;
  joinedAt?: string | null;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * A Person client's membership in a company. The flags belong to this link,
 * not to the person's own client record, so they can differ per company.
 */
export interface ClientCompanyRelationship {
  /** The `client_company_links` row id. */
  id: string;
  companyClientId: string;
  companyName: string;
  relationship?: string | null;
  isPrimary: boolean;
  isEmailRecipient: boolean;
  canViewBilling: boolean;
  /**
   * How many people the company has flagged "Receives emails", this person
   * included. Supplied by the server because this listing only holds the
   * viewed person's own links, so the rest of the company's roster is not
   * otherwise visible here - and without it, clearing this person's flag
   * could silently leave the company with nobody to send its invoices to.
   */
  companyEmailRecipientCount: number;
}

/**
 * One person attached to a client's Contacts tab - either a PERSON client's
 * own related contact, or a COMPANY client's linked roster person. Tell the
 * two apart by the presence of `personClientId` (company) vs `contactId`
 * (person); which one a given list holds is decided entirely by the owning
 * client's own `clientType`, never mixed within one response.
 */
export type ClientContact = PersonRelatedContact | CompanyRosterContact;

/**
 * Type guard for `ClientContact`. Both variants declare every discriminant
 * key (one as the real value, the other as `undefined`), so plain truthiness
 * narrowing on the union is not reliably inferred everywhere it's checked -
 * use this (or its `isPersonRelatedContact` counterpart) instead of
 * re-deriving the check inline.
 */
export function isCompanyRosterContact(contact: ClientContact): contact is CompanyRosterContact {
  return Boolean(contact.personClientId);
}

/** See `isCompanyRosterContact`. */
export function isPersonRelatedContact(contact: ClientContact): contact is PersonRelatedContact {
  return !contact.personClientId;
}

export interface ClientBillingRates {
  defaultRate?: number | null;
  memberRates?: Record<string, number>;
}

export interface Client {
  id: string;
  userId?: string | null;
  lawFirmId?: string;
  /** Immutable after creation. Absent on very old responses; treat as 'person'. */
  clientType?: ClientType;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  organization?: string | null;
  address?: string | null;
  status?: ClientStatus;
  preferredContactMethod?: PreferredContactMethod | null;
  matterIds?: string[];
  /**
   * Open task count for this client, aggregated server-side on the list
   * endpoint. Absent on responses that don't compute it.
   */
  taskCount?: number;
  /**
   * Roster contact count (`contact_clients` links), aggregated server-side on
   * the paged list endpoint only. Meaningful mainly for a company client
   * (its people), but computed for every row; absent on responses that don't
   * compute it.
   */
  contactCount?: number;
  /** Actual company memberships, aggregated for the paged firm-client list. */
  companyNames?: string[];
  billingRates?: ClientBillingRates;
  invitedBy?: string;
  invitedAt?: string;
  invitationSentAt?: string;
  joinedAt?: string | null;
  portalInvitePending?: boolean;
  createdAt?: string;
  updatedAt?: string;
  settings?: ClientSettings;
}
