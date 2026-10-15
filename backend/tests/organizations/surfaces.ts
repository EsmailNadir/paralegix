/**
 * The table the organization batteries are driven over.
 *
 * One row per surface, one body per invariant. Adding an endpoint is one row;
 * adding a rule is one `it` that immediately applies everywhere. That is what
 * makes covering 66 client-scoped routes and 33 portal routes affordable instead
 * of 300 hand-written near-duplicates.
 *
 * `money` is the important field. It marks a surface whose response STATES the
 * client's money: a balance, a total, an invoice, a ledger figure. Those are
 * exactly the values `assertCanViewBilling` refuses to serve a link without the
 * flag, so a surface that leaks one is the same disclosure through a different
 * door. Only those rows run the I3 case.
 *
 * `skip` records a deliberate exemption with a reason. A skipped cell with no
 * reason is a bug in the table, not a passing test.
 */
export type Invariant = 'I1' | 'I2' | 'I3' | 'I4';

export interface PortalSurface {
  name: string;
  /** Path under /api/client-portal, given the firm and the client record to act as. */
  path: (lawFirmId: string, clientRecordId: string) => string;
  /** True when the response states the client's money. Drives the I3 case. */
  money: boolean;
  skip?: Partial<Record<Invariant, string>>;
  /**
   * The part of a 200 body that belongs to the record asked about, when the
   * response also carries rows the caller owns regardless of that record. I2
   * asserts on this instead of the whole body.
   */
  recordRows?: (body: unknown) => unknown[];
}

const portal = (lawFirmId: string, suffix: string, clientRecordId: string) =>
  `/api/client-portal/lawfirm/${lawFirmId}/${suffix}`
  + `${suffix.includes('?') ? '&' : '?'}clientRecordId=${clientRecordId}`;

/**
 * Client-facing surfaces. A portal caller selects WHICH client record it is
 * acting as through `?clientRecordId=`, read by `readClientRecordId` in
 * portal.routes.ts, so a roster person asking for the organization's record is
 * the whole vector for I2 and I3.
 */
export const PORTAL_SURFACES: PortalSurface[] = [
  {
    name: 'associations',
    path: (f, c) => portal(f, 'associations', c),
    money: false,
    // Lists which records this user may act as. It is the mechanism the other
    // rows depend on, not a consumer of it, so widening does not apply.
    skip: { I2: 'the endpoint that reports widening; it cannot also be widened' },
  },
  { name: 'matters', path: (f, c) => portal(f, 'matters', c), money: false },
  { name: 'billing', path: (f, c) => portal(f, 'billing', c), money: true },
  { name: 'documents', path: (f, c) => portal(f, 'documents', c), money: false },
  { name: 'document requests', path: (f, c) => portal(f, 'document-requests', c), money: false },
  {
    name: 'conversations',
    path: (f, c) => portal(f, 'messages/conversations', c),
    money: false,
    // A UID-owned feed: every person client is offered their own personal
    // thread whatever record they act as. Only group threads are the
    // organization's.
    recordRows: (body) => ((body as { conversations?: Array<{ conversationType?: string }> })?.conversations ?? [])
      .filter((c) => c.conversationType === 'group'),
  },
  { name: 'events', path: (f, c) => portal(f, 'events', c), money: false },
  { name: 'trust balance', path: (f, c) => portal(f, 'trust/balance', c), money: true },
  { name: 'trust ledger', path: (f, c) => portal(f, 'trust/ledger', c), money: true },
  { name: 'notifications', path: (f, c) => portal(f, 'notifications', c), money: false },
  { name: 'dashboard', path: (f, c) => portal(f, 'dashboard', c), money: true },
  {
    name: 'settings',
    path: (f, c) => portal(f, 'settings', c),
    money: false,
    // Settings belong to the signed-in person, not to the record they are
    // viewing, so there is nothing to widen or to gate on billing access.
    skip: {
      I2: 'settings are per portal user, not per client record',
      I3: 'carries no money',
    },
  },
];

export interface FirmSurface {
  name: string;
  /** Path given the firm and the CLIENT the request is scoped to. */
  path: (lawFirmId: string, clientId: string) => string;
  /** True when the response states the client's money. */
  money: boolean;
  skip?: Partial<Record<Invariant, string>>;
  /**
   * The part of a 200 body that belongs to the record asked about, when the
   * response also carries rows the caller owns regardless of that record. I2
   * asserts on this instead of the whole body.
   */
  recordRows?: (body: unknown) => unknown[];
}

/**
 * Firm-side surfaces: the staff view of a client, not the client's own portal.
 *
 * This half matters more than its size suggests. Mutating
 * `resolveBillingEffectiveClientIds` to drop its `can_view_billing` filter left
 * the entire PORTAL battery green, because the portal gates on
 * `assertCanViewBilling(context)` and never reaches the widening helpers. Those
 * helpers are reached from here and from the notification paths, and they are
 * where the be459ec0 bugs lived.
 *
 * The questions differ from the portal's. A firm member is not a roster member,
 * so I2 and I3 do not apply: staff see their clients' money by firm permission,
 * not by `can_view_billing`, which is a portal-link flag. What matters here is
 * that an organization is a first-class client (I1) and that another firm is
 * refused (tenancy).
 */
export const FIRM_SURFACES: FirmSurface[] = [
  {
    name: 'client detail',
    path: (f, c) => `/api/lawfirms/${f}/clients/${c}`,
    money: false,
  },
  {
    name: 'client matters',
    path: (f, c) => `/api/lawfirms/${f}/clients/${c}/matters`,
    money: false,
  },
  {
    name: 'client tasks',
    path: (f, c) => `/api/lawfirms/${f}/clients/${c}/tasks`,
    money: false,
  },
  {
    name: 'client contacts',
    path: (f, c) => `/api/lawfirms/${f}/clients/${c}/contacts`,
    money: false,
  },
  {
    name: 'client events',
    path: (f, c) => `/api/lawfirms/${f}/clients/${c}/events`,
    money: false,
  },
  {
    name: 'company relationships',
    path: (f, c) => `/api/lawfirms/${f}/clients/${c}/company-relationships`,
    money: false,
  },
  {
    name: 'client billing rates',
    path: (f, c) => `/api/lawfirms/${f}/clients/${c}/billing-rates`,
    money: true,
  },
  {
    name: 'client invoices',
    path: (f, c) => `/api/lawfirms/${f}/billing/invoices/client/${c}`,
    money: true,
  },
  {
    name: 'client unbilled summary',
    path: (f, c) => `/api/lawfirms/${f}/billing/invoices/client/${c}/unbilled-summary`,
    money: true,
  },
  {
    name: 'client time entries',
    path: (f, c) => `/api/lawfirms/${f}/billing/time-entries/client/${c}`,
    money: true,
  },
  {
    name: 'client trust ledger',
    path: (f, c) => `/api/lawfirms/${f}/trust/clients/${c}/ledger`,
    money: true,
  },
  {
    name: 'client trust balance',
    path: (f, c) => `/api/lawfirms/${f}/trust/clients/${c}/balance`,
    money: true,
  },
];
