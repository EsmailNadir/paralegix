import { createHash } from 'crypto';
import { withLock } from '../../../shared/database/advisoryLock';
import { and, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { createBoundedCache } from '../../../shared/utils/boundedCache';
import {
  clients,
  invoices,
  matterClients,
  users as usersTable,
} from '../../../shared/database/drizzle/schema';
import { systemQuery, tenantQuery } from '../../../shared/database/queryContext';
import { PAYMENT_METHOD_KINDS, clientSurchargeCents } from '../../stripe/processingFees';
import { cardSetupFor, completeCardPayment, confirmCardPayment, quoteCardPayment } from '../../stripe/cardPayment.service';
import { payLinkRequest } from '../../billing/shared/payLinkRequest';

const { admin } = require('../../../shared/database/firebase');
const { dayAnchor } = require('../../../shared/utils/time');
const { rowIso } = require('../../../shared/utils/dateConversion');
const { personalToday } = require('../../../shared/utils/personalDay');
const { signUserPhotoUrl } = require('../../../shared/utils/userPhoto');
const { listObjectsWithMeta } = require('../../../shared/storage/listObjects');
const { runWithConcurrency } = require('../../../shared/utils/runWithConcurrency');
const { isUuid } = require('../../../shared/utils/isUuid');
const {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  ConflictError,
} = require('../../../shared/errors/AppError');
const clientsService = require('../clients.service');
const clientsRepo = require('../clients.repository');
const usersRepo = require('../../users/users.repository');
const lawfirmsRepo = require('../../lawfirms/lawfirms.repository');
const mattersRepo = require('../../matters/matters.repository');
const matterEventsRepo = require('../../matters/matterEvents.repository');
const invoicesRepo = require('../../billing/invoices/invoices.repository');
const { deriveExpectedPayments, assertInvoiceNotVoided } = require('../../billing/shared/invoiceStatus');
const { paymentsWithSurcharge } = require('../../billing/shared/paymentOutput');
const messagingRepo = require('../../messaging/messaging.repository');
const { resignAttachments } = require('../../../shared/utils/attachmentSigning');
const invitationsRepo = require('../../invitations/invitations.repository');
const { CONTEXT_TYPES } = require('../../billing/context');
const firmBillingWindow = require('../../billing/shared/firmBillingWindow');
const { toCents, fromCents } = require('../../billing/shared/money');
const { dispositionFor } = require('../../../shared/utils/attachmentDisposition');
const messagingService = require('../../messaging/messaging.service');
const notificationsRepo = require('../../notifications/notifications.repository');
const documentViewsRepo = require('./clientDocumentViews.repository');
const { linkClientIdentityToFirm } = require('../clientIdentityLinking.service');
const {
  findLawFirmIdsForUserAssociations,
  resolveClientAssociations,
  selectActiveClientAssociation,
  invalidateClientAssociations,
} = require('./clientAssociation.resolver');
const settingsService = require('../../settings/settings.service');
const { isFirmBillingActive, enforceFeatureAccess } = require('../../../shared/plans/planEnforcement');
const { getEnabledFeatures } = require('../../../shared/plans/featureCheck');
const filesRepo = require('../../files/files.repository');
const { bucket: filesBucket, signObject, SIGNED_URL_TTL_DEFAULT } = require('../../files/files.storage');
const documentRequestsService = require('../../documentRequests/documentRequests.service');
const documentRequestUploadsRepo = require('../../documentRequests/documentRequestUploads.repository');
const eventBus = require('../../../shared/events/eventBus');
const { DOCUMENT_UPLOADED_BY_CLIENT } = require('../../../shared/events/eventTypes');
const { normalizeEmail } = require('../../../shared/utils/normalizeEmail');
import {
  beginDirectUploadBatch,
  discardDirectUploadBatch,
  settleDirectUploadBatch,
  stampDirectUploadFinalized,
} from '../../../shared/storage/directUpload';
import { releaseStorageReservations } from '../../../shared/utils/storageUsage';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

function uniq(values: any): any[] {
  return Array.from(new Set((values || []).filter(Boolean)));
}

// Timestamps arrive from Postgres as ISO strings (or Date); a plain Date parse
// covers every real input.
function toMillis(value: any) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toNumber(value: any) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// dueDate is a day-only 'YYYY-MM-DD' value. An invoice is overdue only once the
// due DAY is strictly before the client's today. Both are calendar-day strings;
// `today` is the client's (their request's zone, else their saved one), since
// the UTC today made an invoice due today overdue from 5pm Pacific.
function isOverdue(value: any, today: string) {
  if (!value) return false;
  const dueDay = String(value).slice(0, 10);
  return dueDay < today;
}

// Mirrors the firm's canonical "what date counts as due" logic
// (frontend/src/components/billingComp/utils.ts getInvoiceNextPaymentInfo): a
// payment plan's next pending/overdue installment wins, else nextPaymentDate,
// else dueDate. Both surfaces need to agree on this or the same invoice reads
// overdue to the firm and outstanding to the client (or vice versa).
function getEffectiveDueDate(invoice: any) {
  const plan = invoice.paymentPlan;
  if (plan?.enabled && Array.isArray(plan.expectedPayments) && plan.expectedPayments.length) {
    const next = plan.expectedPayments.find(
      (payment: any) => payment.status === 'pending' || payment.status === 'overdue',
    );
    if (next) return next.dueDate || null;
  }
  return invoice.nextPaymentDate || invoice.dueDate || null;
}

function serializePortalMatter(matterId: string, data: any) {
  const title = data.name || data.title || '';
  return {
    id: matterId,
    name: title,
    title,
    matterNumber: data.matterNumber || null,
    status: data.status || 'active',
    matterType: data.matterType || data.category || null,
    opposingParty: data.opposingParty || null,
    description: data.description || null,
    practiceAreaName: data.practiceAreaName || null,
    courtId: data.courtId || null,
    courtName: data.courtName || null,
    // The matter's pipeline stage (distinct from the coarse status enum). Only
    // the display name is exposed - the client has no use for the internal
    // stageId, and stageId leaks the firm's stage-tree structure for nothing.
    stageName: data.stageName || null,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
  };
}

// Invoice timestamps arrive from Postgres already shaped as ISO strings (the
// repo runs tstzToIso/dateColToIso), or as Date.
function ts(val: any) {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (val instanceof Date) return val.toISOString();
  return null;
}

function serializePortalInvoice(invoice: any, { contextType, matterId, today }: any) {
  const totalAmount = toNumber(invoice.totalAmount ?? invoice.amount);
  const amountPaid = toNumber(invoice.amountPaid);
  const totalWrittenOff = toNumber(invoice.totalWrittenOff);
  // A voided invoice was cancelled by the firm. Whatever its amounts say, the
  // client owes nothing on it and is told so.
  const isVoided = invoice.status === 'voided';
  const remainingBalance = isVoided
    ? 0
    : Math.max(0, Math.round((totalAmount - amountPaid - totalWrittenOff) * 100) / 100);

  let status = 'outstanding';
  if (isVoided) {
    status = 'voided';
  } else if (invoice.isPaid === true) {
    status = 'paid';
  } else if (remainingBalance <= 0 && (totalWrittenOff > 0 || (invoice.creditNotes || []).length > 0)) {
    status = 'credited';
  } else if (amountPaid > 0) {
    status = 'partially_paid';
  } else if (remainingBalance > 0 && isOverdue(getEffectiveDueDate(invoice), today)) {
    status = 'overdue';
  }

  return {
    id: invoice.id,
    contextType,
    entityId: invoice.entityId || matterId || invoice.clientContextId || null,
    matterId: matterId || invoice.matterId || null,
    clientContextId: invoice.clientContextId || null,
    invoiceName: invoice.invoiceName || null,
    invoiceDate: ts(invoice.invoiceDate) || ts(invoice.createdAt) || null,
    dueDate: ts(invoice.dueDate) || null,
    paidDate: ts(invoice.paidDate) || null,
    billingEmail: invoice.billingEmail || null,
    // Bill-to snapshot frozen at first external issue. The portal PDF renders
    // the same bill-to block the emailed copy carried, so a company client sees
    // the attention contact and address the invoice actually issued with rather
    // than today's roster.
    billingEmails: invoice.billingEmails || [],
    billingContactName: invoice.billingContactName || null,
    billingContactTitle: invoice.billingContactTitle || null,
    billingContactEmail: invoice.billingContactEmail || null,
    billingClientAddress: invoice.billingClientAddress || null,
    billingClientName: invoice.billingClientName || null,
    billingSnapshotAt: ts(invoice.billingSnapshotAt) || null,
    notes: invoice.notes || null,
    remitTo: invoice.remitTo || null,
    timeEntries: Array.isArray(invoice.timeEntries) ? invoice.timeEntries : [],
    flatFees: Array.isArray(invoice.flatFees) ? invoice.flatFees : [],
    expenses: Array.isArray(invoice.expenses) ? invoice.expenses : [],
    totalHours: toNumber(invoice.totalHours),
    totalAmount,
    flatFeesAmount: toNumber(invoice.flatFeesAmount),
    isPaid: invoice.isPaid === true,
    amountPaid,
    // Each payment with the processing fee the client paid on top (0 when none).
    payments: paymentsWithSurcharge(invoice.payments),
    nextPaymentDate: ts(invoice.nextPaymentDate) || null,
    createdAt: ts(invoice.createdAt) || null,
    // createdBy (the firm member's uid) is intentionally not exposed to the client
    // portal: it is internal staff identity the client has no need to see.
    creditNotes: Array.isArray(invoice.creditNotes) ? invoice.creditNotes : [],
    totalWrittenOff,
    paymentPlan: deriveExpectedPayments(invoice.paymentPlan) || null,
    status,
    amount: totalAmount,
    remainingBalance,
    stripePaymentRequested: invoice.stripePaymentRequested || false,
    stripePaymentStatus: invoice.stripePaymentStatus || null,
  };
}

function ensureMatterAccess(context: any, matterId: string) {
  if (!context.matterIds.includes(matterId)) {
    throw new ForbiddenError('Access denied: You do not have access to this matter');
  }
}

/**
 * Enforce the plan's billing contract: `can_view_billing` independently
 * controls portal authorization for invoice lists/details/PDFs, payment
 * history, checkout, and trust balance/ledger/funding. A person client's
 * association always resolves `canViewBilling: true` (the person IS the
 * billing principal), so this is a no-op for every existing person-client
 * route; only a company roster association with the flag off is refused.
 * "Hidden UI is not authorization" (the plan's own words) - this must be
 * enforced here, not left to the frontend to hide a button.
 */
function assertCanViewBilling(context: any) {
  if (!context.canViewBilling) {
    throw new ForbiddenError('Access denied: You do not have permission to view billing for this client');
  }
}

async function loadUserData(clientUserId: string, userData: any) {
  if (userData) return userData;
  const user = await usersRepo.findById(clientUserId);
  if (!user) throw new NotFoundError('User');
  return user;
}

async function findLawFirmIdsByClientEmail(email: any) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return [];

  // The clients table is the source of truth for client<->firm association.
  // `email` is a citext column (case-insensitive collation), so a direct `=`
  // comparison is index-usable and still matches regardless of matter. No need
  // to `lower(email::text)` (which defeats the index and ignores citext).
  const rows = await systemQuery('auth_identity', (executor) => executor
    .selectDistinct({ lawFirmId: clients.lawFirmId }).from(clients)
    .where(eq(clients.email, normalizedEmail)));
  return uniq(rows.map((row) => row.lawFirmId));
}

/**
 * Self-healing: if a client has a pending invite but no client record,
 * auto-accept the invite and create the association.
 */
async function tryAutoAcceptPendingInvite(lawFirmId: string, clientUserId: string, email: any) {
  if (!email) return null;
  const normalizedEmail = email.trim().toLowerCase();

  const pending = await invitationsRepo.findByEmailType(lawFirmId, normalizedEmail, 'client');
  if (!pending) return null;

  const linked = await linkClientIdentityToFirm({
    lawFirmId,
    userId: clientUserId,
    email: normalizedEmail,
    invitedBy: pending.invitedBy || null,
    matterIds: pending.matterIds || [],
  });

  // Clean up the consumed invite (token lives on the same row in Postgres).
  await invitationsRepo.deleteById(pending.id).catch(() => {});

  return linked?.clientRecord || null;
}

// Messages per page in the client's direct thread with the firm. Matches the
// group thread's page size so both read the same way.
const PORTAL_MESSAGE_PAGE_SIZE = 25;

// Firms resolved at once when shaping the client's firm list / firm summaries.
// A client on many firms otherwise starts a row read, a logo signature and a
// whole per-firm summary for every one of them simultaneously, so one portal
// dashboard load sizes its own fan-out.
const FIRM_FANOUT_CONCURRENCY = 5;

// Messages whose attachments are re-signed at once. Each message's attachments
// are themselves bounded inside resignAttachments, so without a cap here a page
// of messages multiplies the two.
const MESSAGE_ATTACHMENT_RESIGN_CONCURRENCY = 4;

// Short-TTL memoization of the resolved active-client access context. A single
// portal page load fans out to several endpoints (matters, billing, documents,
// events, settings), each of which independently re-resolves the SAME context
// (loadUserData + association resolve/self-heal + listMatterIds). Caching the
// resolved context for a few seconds collapses that burst into one resolve
// while keeping access changes fresh (the TTL is intentionally tiny). Keyed by
// (lawFirmId, uid, clientRecordId): a single uid can now resolve to a DIFFERENT
// client record in the same firm depending on which one was selected (a person
// who is also on a company roster, e.g. Jane in the acceptance identities), so
// the clientRecordId is part of the cache identity, not just an input to it.
// `userData` (the middleware-loaded user row) is per-uid and safe to cache;
// only an explicit `authEmail` override (which can change which record
// resolves) bypasses the cache so those callers always re-resolve.
const ACTIVE_CONTEXT_TTL_MS = 5000;
/**
 * Contexts held at once.
 *
 * The key is a firm, a portal user and a client record, so it grows with the
 * customer base. The short TTL did not bound it: expiry was lazy, and the sweep
 * ran only after the map had already passed 500 and removed only entries that
 * had already expired, so a burst of distinct portal users inside one TTL
 * window grew it without limit. At the ceiling the least recently used entry is
 * evicted, which costs one context resolve.
 */
const ACTIVE_CONTEXT_MAX_ENTRIES = Number(process.env.ACTIVE_CONTEXT_CACHE_MAX_ENTRIES) || 2000;

const activeAccessContextCache = createBoundedCache<any>({
  name: 'activeAccessContext',
  maxEntries: ACTIVE_CONTEXT_MAX_ENTRIES,
  ttlMs: ACTIVE_CONTEXT_TTL_MS,
});

function activeContextCacheKey(lawFirmId: string, clientUserId: string, clientRecordId: any) {
  return `${lawFirmId}::${clientUserId}::${clientRecordId || ''}`;
}

function readActiveCachedContext(key: any) {
  return activeAccessContextCache.get(key) ?? null;
}

function writeActiveCachedContext(key: any, value: any) {
  activeAccessContextCache.set(key, value);
}

/**
 * Invalidate every memoized active-client context for a portal user in one
 * firm, so the next portal request re-resolves their association/matterIds
 * from scratch. Firm-side mutations that change a client's association
 * (revoke portal access, add/remove matter links, delete client, roster
 * link change) call this with the affected portal uid so a just-revoked user
 * can't keep reading the firm's data for the remainder of the TTL window.
 * Sweeps every cache entry for (lawFirmId, clientUserId) regardless of which
 * clientRecordId it was keyed on - a caller invalidating access has no way to
 * know every clientRecordId this uid may have cached a context under. No-op
 * when the client has no linked portal user (placeholder rows have no cached
 * context). Note: the cache is still process-local. On a multi-instance
 * deploy only the instance that ran the mutation drops its entry; other
 * instances fall back to the (tiny) TTL.
 */
export function invalidateAccessContext({ lawFirmId, clientUserId }: any) {
  if (!lawFirmId || !clientUserId) return;
  activeAccessContextCache.deletePrefix(`${lawFirmId}::${clientUserId}::`);
}

/**
 * Person-arm self-heal: link an unlinked `clients` row found by email, or
 * auto-accept a pending client invite, exactly as the legacy person-only
 * context resolver did - but expressed as "did we change anything in the
 * database" rather than returning a client record directly, since
 * authorization is now decided by re-resolving the association list
 * afterward (see `resolveAssociationsWithSelfHeal`), never by trusting an
 * in-memory record that may not actually be linked in the database.
 *
 * Company access is never self-healed here: the plan's "Email matching never
 * grants company access" rule means this only ever creates or links a PERSON
 * `clients` row (`clients.user_id`), never a `client_company_links` row.
 *
 * No-op (returns false) when a person `clients` row already links this uid -
 * re-linking it to the user it's already on would be pure waste.
 */
async function selfHealPersonAssociation(lawFirmId: string, clientUserId: string, clientEmail: any) {
  const existingPerson = await clientsRepo.findByUserId(lawFirmId, clientUserId);
  if (existingPerson) return false;

  if (clientEmail) {
    const byEmail = await clientsRepo.findByEmail(lawFirmId, clientEmail);
    if (byEmail) {
      const linked = await linkClientIdentityToFirm({
        lawFirmId,
        userId: clientUserId,
        email: clientEmail,
        name: byEmail.name || null,
        invitedBy: byEmail.invitedBy || null,
      }).catch(() => null);
      if (linked?.clientRecord) return true;
      // Linking failed (e.g. a transient write error): fall through to the
      // pending-invite attempt below rather than granting access to a row
      // that was never actually linked in the database. The legacy resolver
      // used to hand back a synthetic "linked" view of the byEmail row even
      // when this write failed; that let a request through against a `clients`
      // row whose `user_id` was never actually set, which the association
      // resolver (a real query, not an in-memory object) can never do. Any
      // caller that hits this path now correctly fails this one request and
      // self-heals on the next.
    }
  }

  const autoCreated = await tryAutoAcceptPendingInvite(lawFirmId, clientUserId, clientEmail);
  return !!autoCreated;
}

/**
 * Resolve every association for (lawFirmId, clientUserId), running the
 * person-arm self-heal first when needed so a freshly linked/created row
 * participates in selection on this very request rather than only becoming
 * visible once the association resolver's own cache entry expires.
 */
async function resolveAssociationsWithSelfHeal(lawFirmId: string, clientUserId: string, clientEmail: any) {
  const healed = await selfHealPersonAssociation(lawFirmId, clientUserId, clientEmail);
  if (healed) invalidateClientAssociations({ lawFirmId, userId: clientUserId });
  return resolveClientAssociations({ lawFirmId, userId: clientUserId });
}

/**
 * Resolve the matterIds/taskIds an active client association can see.
 *
 * Both reads key off `clients.id` (`clientRecordId`), which is the record the
 * portal selected for this request. Scoping by the caller's Firebase uid
 * instead would be wrong: one uid can hold several `clients` rows in a firm
 * (a personal client who is also on a company roster), and each record's
 * matters are its own.
 */
async function resolveMatterAndTaskIds({ lawFirmId, clientRecordId }: any) {
  // matterIds are resolved from the matter_clients junction, not embedded on the
  // client row. taskIds are the standalone tasks the client is linked to
  // (matter-linked tasks are covered by matterIds); they surface files shared
  // from those tasks in the portal. The two are reads over different junctions
  // with nothing between them, so they go out together - a fixed pair, so the
  // fan-out is bounded at two.
  const [matterIdsFromClient, taskIds] = clientRecordId
    ? await Promise.all([
        clientsRepo.listMatterIds(lawFirmId, clientRecordId).then(uniq),
        clientsRepo.listTaskIds(lawFirmId, clientRecordId).catch(() => []).then(uniq),
      ])
    : [[], []];

  return { matterIds: matterIdsFromClient, taskIds };
}

/**
 * The active-client-scoped portal identity resolver (organization-clients
 * plan, Phase 5). Resolves every association this uid has in the firm
 * (self-healing the person arm first when needed), applies the plan's
 * "Portal selection contract" to pick exactly one (`clientRecordId` if given,
 * else auto-select when unambiguous, else throw `CLIENT_SELECTION_REQUIRED`),
 * and resolves that association's matterIds/taskIds.
 *
 * Superset of the legacy person-only `getClientAccessContext` shape
 * (`userData`, `clientUserId`, `clientEmail`, `clientRecord`, `clientRecordId`,
 * `matterIds`, `taskIds`) plus `clientType`, `companyLinkId`,
 * `canViewBilling`, and the full resolved `associations` list so a caller can
 * report `CLIENT_SELECTION_REQUIRED` details or power a client-record switcher
 * without a second resolve.
 */
export async function getActiveClientAccessContext(
  { lawFirmId, clientUserId, userData, authEmail, clientRecordId }: any,
) {
  const cacheable = !authEmail;
  const cacheKey = activeContextCacheKey(lawFirmId, clientUserId, clientRecordId);
  if (cacheable) {
    const cached = readActiveCachedContext(cacheKey);
    if (cached) return cached;
  }

  const resolvedUserData = await loadUserData(clientUserId, userData);
  // Use email from user data, falling back to the Firebase Auth token email
  const clientEmail = normalizeEmail(resolvedUserData.email || authEmail || null);

  const associations = await resolveAssociationsWithSelfHeal(lawFirmId, clientUserId, clientEmail);
  if (associations.length === 0) {
    throw new ForbiddenError('Access denied: You are not associated with this law firm');
  }
  const active = selectActiveClientAssociation(associations, clientRecordId);

  const clientRecord = await clientsRepo.findByIdRaw(lawFirmId, active.clientRecordId);
  if (!clientRecord) throw new NotFoundError('Client record');

  const { matterIds, taskIds } = await resolveMatterAndTaskIds({
    lawFirmId,
    clientRecordId: active.clientRecordId,
    clientUserId,
    clientType: active.clientType,
  });

  const context = {
    userData: resolvedUserData,
    clientUserId,
    clientEmail,
    clientRecord,
    clientRecordId: active.clientRecordId,
    matterIds,
    taskIds,
    clientType: active.clientType,
    companyLinkId: active.companyLinkId,
    canViewBilling: active.canViewBilling,
    associations,
  };
  if (cacheable) writeActiveCachedContext(cacheKey, context);
  return context;
}

/**
 * Prove this uid has at least one association (person or company, either one)
 * with the firm, without selecting one. Used by routes whose authorization is
 * participant/conversation- or uid-scoped rather than active-client-scoped -
 * messaging (Phase 7: "authorize portal read/send through conversation
 * participation... not through which client record is currently active") and
 * the notification bell (the Portal selection contract's "UID-owned feeds...
 * remain user-scoped" carve-out). These routes must keep working for a uid
 * with MULTIPLE associations without forcing a selection that has nothing to
 * do with what they authorize.
 */
async function assertPortalFirmAssociation({ lawFirmId, clientUserId, userData }: any) {
  const resolvedUserData = await loadUserData(clientUserId, userData);
  const clientEmail = normalizeEmail(resolvedUserData.email || null);
  const associations = await resolveAssociationsWithSelfHeal(lawFirmId, clientUserId, clientEmail);
  if (associations.length === 0) {
    throw new ForbiddenError('Access denied: You are not associated with this law firm');
  }
  return { resolvedUserData, clientEmail, associations };
}

/**
 * The union of matterIds visible across every association a uid holds in one
 * firm. Used only where a route's authorization is uid/participant-scoped
 * (not active-client-scoped) but still needs to check a specific matterId,
 * e.g. tagging a portal message with a matter - the matter could belong to
 * whichever of the uid's associations, so the check must not silently prefer
 * one over the others.
 */
async function resolveMatterIdsAcrossAssociations(lawFirmId: string, associations: any[], clientUserId: string) {
  const perAssociation = await mapWithConcurrency(
    associations,
    FIRM_FANOUT_CONCURRENCY,
    async (association: any) => {
      const { matterIds } = await resolveMatterAndTaskIds({
        lawFirmId,
        clientRecordId: association.clientRecordId,
        clientUserId,
        clientType: association.clientType,
      });
      return matterIds;
    },
  );
  return uniq(perAssociation.flat());
}

/**
 * The resolved client-record associations for one uid in one firm, shaped for
 * the frontend's active-client switcher (new endpoint, organization-clients
 * plan Phase 5: `GET /lawfirm/:lawFirmId/associations`). Runs the same
 * person-arm self-heal as `getActiveClientAccessContext` so a first-time
 * portal user sees their freshly-created association immediately, without
 * forcing a selection - this is a pure listing, not an active-client resolve.
 */
export async function listPortalAssociations({ lawFirmId, clientUserId, userData }: any) {
  const resolvedUserData = await loadUserData(clientUserId, userData);
  const clientEmail = normalizeEmail(resolvedUserData.email || null);
  const associations = await resolveAssociationsWithSelfHeal(lawFirmId, clientUserId, clientEmail);

  return {
    associations: associations.map((a: any) => ({
      clientRecordId: a.clientRecordId,
      clientType: a.clientType,
      clientName: a.clientName,
      companyLinkId: a.companyLinkId,
      canViewBilling: a.canViewBilling,
    })),
  };
}

async function buildPortalMatters(context: any, lawFirmId: string) {
  if (context.matterIds.length === 0) return [];

  const matterRecords = await mattersRepo.findByIdsRaw(lawFirmId, context.matterIds).catch(() => []);

  const matters = matterRecords
    .filter(Boolean)
    .map((c: any) => serializePortalMatter(c.id, c));

  matters.sort((a: any, b: any) => {
    const updatedDelta = toMillis(b.updatedAt) - toMillis(a.updatedAt);
    if (updatedDelta !== 0) return updatedDelta;
    return toMillis(b.createdAt) - toMillis(a.createdAt);
  });

  return matters;
}

async function findMatterClientDocIds({ lawFirmId, matterId, clientUserId, clientEmail }: any) {
  // matter-clients are now `clients` rows joined to the matter via matter_clients.
  // Match this user by linked user_id (or by email for placeholder rows). The
  // returned ids are the client uuids, which is what invoice.matterClientId now
  // references in the relational model.
  const ids = new Set();
  const matterClients = await mattersRepo.listMatterClients(lawFirmId, matterId).catch(() => []);

  for (const cc of matterClients) {
    if (cc.userId && cc.userId === clientUserId) {
      ids.add(cc.id);
    } else if (clientEmail && normalizeEmail(cc.email) === clientEmail) {
      ids.add(cc.id);
    }
  }

  return ids;
}

/**
 * Batched equivalent of findMatterClientDocIds across a set of matterIds: resolves,
 * in ONE query, the client uuids on each matter that belong to this user (matched
 * by linked user_id, or by email for placeholder rows). Returns
 * Map<matterId, Set<clientId>> (same matching rules as findMatterClientDocIds,
 * just grouped so buildPortalBilling avoids a per-matter listMatterClients N+1.
 */
async function findMatterClientDocIdsForMatters({ lawFirmId, matterIds, clientUserId, clientEmail }: any) {
  const byMatter = new Map();
  const validIds = uniq(matterIds).filter((id) => isUuid(id));
  if (validIds.length === 0) return byMatter;

  const rows = await tenantQuery(matterClients, lawFirmId, ({ executor, scope }) => executor
    .select({
      matterId: matterClients.matterId,
      clientId: clients.id,
      userId: clients.userId,
      email: clients.email,
    }).from(matterClients).innerJoin(clients, and(
      eq(clients.id, matterClients.clientId), eq(clients.lawFirmId, matterClients.lawFirmId),
    )).where(and(scope, inArray(matterClients.matterId, validIds))));

  for (const r of rows) {
    const matches = (r.userId && r.userId === clientUserId)
      || (clientEmail && normalizeEmail(r.email) === clientEmail);
    if (!matches) continue;
    if (!byMatter.has(r.matterId)) byMatter.set(r.matterId, new Set());
    byMatter.get(r.matterId).add(r.clientId);
  }

  return byMatter;
}

// invoice.clientId (invoices.client_id) is a `clients.id` uuid - the explicit
// "bill to" client on a matter-context invoice - never a Firebase UID. This
// used to compare it against clientUserId (a Firebase UID), so the branch
// could never match a real invoice; it was dead code disguised as a check.
// Compare against clientRecordId (the resolved clients.id for this portal
// user) instead.
function invoiceBelongsToClient(invoice: any, { clientRecordId, clientEmail, matterClientDocIds }: any) {
  if (invoice.clientId && invoice.clientId === clientRecordId) return true;
  if (invoice.matterClientId && matterClientDocIds.has(invoice.matterClientId)) return true;

  const billingEmail = normalizeEmail(invoice.billingEmail);
  if (billingEmail && clientEmail && billingEmail === clientEmail) return true;

  return false;
}

async function buildPortalBilling(context: any, lawFirmId: string, page: any = {}) {
  const { limit, offset, page: pageNumber, status, today } = page;
  const invoices: any[] = [];

  if (context.matterIds.length > 0) {
    try {
      // Batched: one query loads all matter-context invoices across the client's
      // matters, one query resolves all matching matter-client uuids, replacing the
      // old per-matter findByContext + listMatterClients 2xN round-trips. Grouping
      // and ownership filtering then happen in memory, preserving the exact
      // per-matter payload the per-matter loop produced.
      const [invoicesByMatter, docIdsByMatter] = await Promise.all([
        invoicesRepo.findByMatterIds(lawFirmId, context.matterIds),
        findMatterClientDocIdsForMatters({
          lawFirmId,
          matterIds: context.matterIds,
          clientUserId: context.clientUserId,
          clientEmail: context.clientEmail,
        }),
      ]);

      for (const matterId of context.matterIds) {
        const matterInvoices = invoicesByMatter.get(matterId) || [];
        if (matterInvoices.length === 0) continue;

        const matterClientDocIds = docIdsByMatter.get(matterId) || new Set();

        matterInvoices.forEach((invoice: any) => {
          if (!invoiceBelongsToClient(invoice, {
            clientRecordId: context.clientRecordId,
            clientEmail: context.clientEmail,
            matterClientDocIds,
          })) {
            return;
          }

          invoices.push(serializePortalInvoice(invoice, {
            contextType: CONTEXT_TYPES.matter,
            matterId,
            today,
          }));
        });
      }
    } catch (err: any) {
      console.error('portal.service: failed to load matter invoices for billing:', err);
    }
  }

  try {
    const clientContext = {
      type: CONTEXT_TYPES.client,
      lawFirmId,
      entityId: context.clientRecordId,
    };
    const clientInvoices = await invoicesRepo.findByContext(clientContext);
    clientInvoices.forEach((invoice: any) => {
      invoices.push(serializePortalInvoice(invoice, {
        contextType: CONTEXT_TYPES.client,
        matterId: invoice.matterId || null,
        today,
      }));
    });
  } catch (err: any) {
    console.error(`portal.service: failed to load client-context invoices for ${context.clientRecordId}:`, err);
  }

  const deduped: any[] = [];
  const seen = new Set();
  invoices.forEach((invoice) => {
    const key = `${invoice.contextType}:${invoice.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(invoice);
  });

  deduped.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));

  // Summed in integer cents and converted once, so dollar floats never
  // accumulate into the figures the client sees.
  const summaryCents = deduped.reduce((acc, invoice) => {
    // A voided invoice was cancelled: not billed, not paid towards, not owed.
    if (invoice.status === 'voided') return acc;
    const billed = toCents(invoice.totalAmount);
    const paid = toCents(invoice.amountPaid);
    const writtenOff = toCents(invoice.totalWrittenOff);

    acc.totalBilled += billed;
    acc.totalPaid += paid;
    acc.totalOutstanding += Math.max(0, billed - paid - writtenOff);
    return acc;
  }, {
    totalBilled: 0,
    totalPaid: 0,
    totalOutstanding: 0,
  });
  const summary = {
    totalBilled: fromCents(summaryCents.totalBilled),
    totalPaid: fromCents(summaryCents.totalPaid),
    totalOutstanding: fromCents(summaryCents.totalOutstanding),
  };

  // Per-status counts for the filter chips, over EVERY invoice rather than the
  // page below them. Mirrors what the portal computed client-side, including its
  // fallback for rows whose stored status never got written.
  const statusCounts = deduped.reduce((acc, invoice) => {
    const key = invoice.status || (invoice.isPaid ? 'paid' : 'outstanding');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  // Filtering and ordering run over the derived records, matching the firm-side
  // billing reads: status here is the same value the chip counts above use, and
  // the order is soonest-payment-first, which is what the client is being asked
  // to act on.
  let visible = deduped;
  if (status) {
    visible = visible.filter(
      (invoice) => (invoice.status || (invoice.isPaid ? 'paid' : 'outstanding')) === status,
    );
  }
  visible = visible.slice().sort((a, b) => {
    const aDay = a.nextPaymentDate || a.dueDate;
    const bDay = b.nextPaymentDate || b.dueDate;
    const aTime = aDay ? new Date(aDay).getTime() : Infinity;
    const bTime = bDay ? new Date(bDay).getTime() : Infinity;
    return aTime - bTime;
  });

  // Paging is opt-in, the same contract the firm reads use: with no `limit` the
  // whole list comes back, which is what the statement tab needs (its running
  // balance is built from every invoice, its payments and its credit notes) and
  // what the dashboard summary reads.
  const { items, totalItems } = firmBillingWindow.windowList(visible, { limit, offset, page: pageNumber });

  return {
    invoices: items,
    totalItems,
    summary,
    statusCounts,
  };
}

/**
 * Of the firms this client's email appears in, the ones whose `clients` rows are
 * not already fully linked to this user.
 *
 * `linkClientIdentityToFirm` is a transaction (BEGIN, up to half a dozen
 * statements, COMMIT) and this runs on the portal's two hottest reads, so firing
 * it per firm on every request wrote to the database just to re-derive a state
 * that was already correct. A firm needs the call only when there is something
 * left to do: a placeholder or duplicate row to merge, or a linked row the link
 * would still stamp. Anything ambiguous stays in the set, so this only ever skips
 * work that provably has no effect. `selfHealPersonAssociation` skips the same
 * call for the same reason.
 */
async function findFirmIdsNeedingIdentityLink(clientEmail: any, clientUserId: string) {
  if (!clientEmail) return [];
  const rows = await systemQuery('auth_identity', (executor) => executor
    .selectDistinct({ lawFirmId: clients.lawFirmId }).from(clients).where(and(
      eq(clients.email, clientEmail),
      or(
        isNull(clients.userId),
        ne(clients.userId, clientUserId),
        eq(clients.portalInvitePending, true),
        isNull(clients.joinedAt),
        isNull(clients.name),
        isNull(clients.status),
      ),
    )));
  return rows.map((row) => row.lawFirmId);
}

/**
 * Resolve, link (self-heal), and shape the list of law firms a portal client
 * belongs to. The shared core of listMyLawFirms and listMyFirmSummaries.
 * Returns `{ resolvedUserData, clientEmail, lawFirms }` so callers can reuse the
 * loaded user data + normalized email without re-resolving them.
 */
async function resolveMyLawFirms({ clientUserId, userData }: any) {
  const resolvedUserData = await loadUserData(clientUserId, userData);
  const clientEmail = normalizeEmail(resolvedUserData.email || null);
  const discoveredFirmIds = await findLawFirmIdsByClientEmail(clientEmail);

  // Sequential on purpose: these transactions touch overlapping `clients` rows
  // for one email, so running them concurrently invites lock contention.
  // This is the person arm's legacy email self-heal only (an unambiguous
  // person record) - the company arm below is never email-matched, per the
  // organization-clients plan's "Email matching never grants company access".
  const needsLink = new Set(await findFirmIdsNeedingIdentityLink(clientEmail, clientUserId));
  for (const lawFirmId of discoveredFirmIds) {
    if (!needsLink.has(lawFirmId)) continue;
    await linkClientIdentityToFirm({
      lawFirmId,
      userId: clientUserId,
      email: clientEmail,
      name: resolvedUserData.name || null,
    }).catch(() => {});
  }

  // Company access is discovered through the central association resolver's
  // company arm (`client_company_links` off this uid's own person client),
  // never through email - a firm the client only belongs to through an
  // organization link would otherwise never surface here. This also re-covers the person arm by
  // uid, which is a harmless superset of the email-based discovery above.
  const associatedFirmIds = await findLawFirmIdsForUserAssociations(clientUserId);

  // clients table is the source of truth for the association (clientLawFirmIds is obsolete).
  const lawFirmIds = uniq([...discoveredFirmIds, ...associatedFirmIds]);
  if (lawFirmIds.length === 0) return { resolvedUserData, clientEmail, lawFirms: [] };

  const firmRecords = await mapWithConcurrency(
    lawFirmIds,
    FIRM_FANOUT_CONCURRENCY,
    (lawFirmId: string) => lawfirmsRepo.findById(lawFirmId).catch(() => null),
  );

  const lawFirms = await mapWithConcurrency(
    firmRecords.filter(Boolean),
    FIRM_FANOUT_CONCURRENCY,
    async (data: any) => {
      // billingLocked lets the portal dashboard mark a firm whose subscription
      // is inactive as unavailable (the per-firm portal routes 402 it too).
      // `features` is the firm's plan ceiling: the portal sidebar builds its nav
      // from it, so without it every client saw the trust and signing links no
      // matter what the firm pays for.
      const firm = { id: data.id, name: data.name || 'Unnamed Law Firm', logoUrl: null, address: data.address || null, city: data.city || null, state: data.state || null, zip: data.zip || null, billingLocked: !isFirmBillingActive({ plan: data.plan }), features: getEnabledFeatures(data) };
      // The shared signer verifies the object exists (a stored path whose file
      // is missing would otherwise produce a URL that 404s), caches the signed
      // URL, and yields null on failure.
      if (data.logoObjectPath) firm.logoUrl = await signUserPhotoUrl(data.logoObjectPath);
      return firm;
    },
  );

  lawFirms.sort((a: any, b: any) => a.name.localeCompare(b.name));

  return { resolvedUserData, clientEmail, lawFirms };
}

export async function listMyLawFirms({ clientUserId, userData }: any) {
  const { lawFirms } = await resolveMyLawFirms({ clientUserId, userData });
  return { lawFirms };
}

/**
 * Per-firm dashboard summary for a portal client: the same firm cards
 * listMyLawFirms returns, each enriched with `matterCount` and
 * `outstandingBalanceCents`. Collapses the old per-firm matters+billing fan-out
 * (2 requests/firm, over-fetching full lists just to read a length and a sum)
 * into one request whose counts/sums are computed in SQL.
 *
 * The numbers are derived from the SAME associations the per-firm endpoints
 * resolve through, so a client only ever sees their own firms, matters, and
 * balances:
 *   - matterCount: count of the client's accessible matters that exist.
 *   - outstandingBalanceCents: SQL sum of outstanding invoice balances scoped
 *     to this client, matching buildPortalBilling's totalOutstanding (in
 *     cents). Associations without `can_view_billing` contribute 0, so this
 *     card enforces the same billing gate the dedicated billing routes do.
 *
 * This is a cross-firm AGGREGATE read, not an active-client-scoped one - there
 * is no per-firm `clientRecordId` in the request for it to select with, and
 * forcing `CLIENT_SELECTION_REQUIRED` here would break the dashboard for Pat
 * (two companies in one firm) before they ever get a chance to choose. Instead
 * every association a uid holds in a firm contributes to that firm's one card:
 * a firm summary can legitimately represent several client records at once
 * (the plan's Phase 2 requirement), and a uid's associations in one firm never
 * overlap on the same matter, so summing is safe.
 */
export async function listMyFirmSummaries({ clientUserId, userData }: any) {
  const { lawFirms, clientEmail } = await resolveMyLawFirms({ clientUserId, userData });

  // Bounded: each summary resolves the firm's associations and, per
  // association, two aggregate queries, so a client on a dozen firms would
  // otherwise open dozens of those at once against the same pool.
  const summaries = await mapWithConcurrency(
    lawFirms,
    FIRM_FANOUT_CONCURRENCY,
    async (firm: any) => {
      try {
        const associations = await resolveClientAssociations({ lawFirmId: firm.id, userId: clientUserId });
        if (associations.length === 0) {
          return { ...firm, matterCount: 0, outstandingBalanceCents: 0 };
        }

        const perAssociation = await mapWithConcurrency(
          associations,
          FIRM_FANOUT_CONCURRENCY,
          async (association: any) => {
            const { matterIds } = await resolveMatterAndTaskIds({
              lawFirmId: firm.id,
              clientRecordId: association.clientRecordId,
              clientUserId,
              clientType: association.clientType,
            });
            // An association whose `can_view_billing` is off contributes 0,
            // never its real balance: every dedicated billing route refuses it
            // through `assertCanViewBilling`, and the dashboard card would
            // otherwise be the one place that reports an organization's
            // outstanding balance to a linked person denied its billing.
            const [matterCount, outstandingBalanceCents] = await Promise.all([
              mattersRepo.countByIds(firm.id, matterIds),
              association.canViewBilling
                ? invoicesRepo.sumOutstandingForClientPortal({
                  lawFirmId: firm.id,
                  matterIds,
                  clientRecordId: association.clientRecordId,
                  clientUserId,
                  clientEmail,
                })
                : Promise.resolve(0),
            ]);
            return { matterCount, outstandingBalanceCents };
          },
        );

        return {
          ...firm,
          matterCount: perAssociation.reduce((sum: number, p: any) => sum + p.matterCount, 0),
          outstandingBalanceCents: perAssociation.reduce((sum: number, p: any) => sum + p.outstandingBalanceCents, 0),
        };
      } catch (err: any) {
        console.error(`portal.service: failed to build firm summary for ${firm.id}:`, err);
        return { ...firm, matterCount: 0, outstandingBalanceCents: 0 };
      }
    },
  );

  return { lawFirms: summaries };
}

export async function listPortalMatters({ lawFirmId, clientUserId, userData, clientRecordId }: any) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  const matters = await buildPortalMatters(context, lawFirmId);
  return { matters };
}

export async function getPortalMatter({ lawFirmId, matterId, clientUserId, userData, clientRecordId }: any) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  ensureMatterAccess(context, matterId);

  const matterRecord = await mattersRepo.findByIdRaw(lawFirmId, matterId);
  if (!matterRecord) throw new NotFoundError('Matter');

  return { matter: serializePortalMatter(matterRecord.id, matterRecord) };
}

/**
 * The client's invoices, optionally windowed.
 *
 * `summary` and `statusCounts` always describe every invoice, so the totals and
 * the filter chips stay honest on any page. Omitting `limit` returns the complete
 * list, which is what the statement view reads: its running balance is built from
 * every invoice plus each one's payments and credit notes, so a page of invoices
 * would produce a statement that silently starts partway through the history.
 */
export async function listPortalBilling(
  { lawFirmId, clientUserId, userData, limit, offset, page, status, clientRecordId, timeZone }: any,
) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  assertCanViewBilling(context);
  const today = await personalToday({ timeZone, userId: clientUserId });
  return buildPortalBilling(context, lawFirmId, { limit, offset, page, status, today });
}

/**
 * One invoice, by id, instead of the client's whole billing history. Locates
 * the invoice's billing context cheaply via `findContextById` (id + context
 * only, no line items) so the access check runs before the full row loads,
 * then re-uses the same ownership rules `buildPortalBilling` applies per
 * context: a client-context invoice must belong to this client's own record;
 * a matter-context invoice requires matter access AND that this client is one
 * of the matter clients actually billed (or the billing email matches) -
 * otherwise a co-client on the same matter could open an invoice addressed to
 * someone else. Throws NotFoundError (never ForbiddenError) for anything
 * out of scope, so probing an id can't distinguish "not yours" from
 * "doesn't exist".
 */
export async function getPortalInvoice({ lawFirmId, invoiceId, clientUserId, userData, clientRecordId, timeZone }: any) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  const today = await personalToday({ timeZone, userId: clientUserId });
  assertCanViewBilling(context);

  const located = await invoicesRepo.findContextById(lawFirmId, invoiceId);
  if (!located) throw new NotFoundError('Invoice');

  const { type, entityId } = located.context;

  if (type === CONTEXT_TYPES.client) {
    if (!context.clientRecordId || entityId !== context.clientRecordId) {
      throw new NotFoundError('Invoice');
    }
    const invoice = await invoicesRepo.findById(located.context, invoiceId);
    if (!invoice) throw new NotFoundError('Invoice');
    return {
      invoice: serializePortalInvoice(invoice, { contextType: CONTEXT_TYPES.client, matterId: invoice.matterId || null, today }),
    };
  }

  if (type === CONTEXT_TYPES.matter) {
    ensureMatterAccess(context, entityId);
    const invoice = await invoicesRepo.findById(located.context, invoiceId);
    if (!invoice) throw new NotFoundError('Invoice');

    const matterClientDocIds = await findMatterClientDocIds({
      lawFirmId, matterId: entityId, clientUserId: context.clientUserId, clientEmail: context.clientEmail,
    });
    if (!invoiceBelongsToClient(invoice, {
      clientRecordId: context.clientRecordId,
      clientEmail: context.clientEmail,
      matterClientDocIds,
    })) {
      throw new NotFoundError('Invoice');
    }

    return {
      invoice: serializePortalInvoice(invoice, { contextType: CONTEXT_TYPES.matter, matterId: entityId, today }),
    };
  }

  throw new NotFoundError('Invoice');
}

// Client-visible matter files live in GCS under lawfirmids/{firm}/{matter}/, flagged
// by the `clientVisible` custom metadata the firm sets via the storage routes.
const FILES_BASE_FOLDER = 'lawfirmids';

/**
 * Every object under a prefix the portal needs to reason about, plus whether the
 * scan saw all of them.
 *
 * The scans below filter these down to the files shared with the client, so they
 * have to see the WHOLE prefix. This used to stop at the first 500 objects with
 * the shared-with-client filter running afterwards, which meant a busy matter
 * could hide documents the firm had deliberately shared, with nothing on screen
 * to say the list was short. Sharing a file has to mean the client can see it.
 *
 * A prefix past the scan ceiling reinstates exactly that failure, so `truncated`
 * rides along to the response rather than being dropped here: the portal can
 * then say the list is short instead of presenting it as everything.
 */

// Sign a 30-minute read URL for a client-visible matter file. Shared by the list
// path and the lazy per-document refresh endpoint so they sign identically.
function signMatterFileUrl(file: any, filename: any, contentType: any) {
  return file
    .getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 1000 * 60 * 30, // 30 minutes
      // Force-download active-content types (HTML/SVG/XML) instead of serving them
      // inline, so a client-visible upload can't render script in the portal origin.
      responseDisposition: dispositionFor(contentType, filename),
    })
    .then(([url]: any[]) => url);
}

/**
 * What a client may see, read from the tree.
 *
 * Each of these used to scan a storage prefix, read `clientVisible` off every
 * object metadata, collect the shared folders into a prefix list, and match each
 * file against it by string. The share is a column now and the per-client
 * narrowing is a table, so one recursive query answers the whole question and
 * the portal cannot disagree with the firm side about who can see what.
 */
async function listVisibleDocuments(
  lawFirmId: string,
  rootId: string,
  clientRecordId: any,
  { contextType, entityId, matterId, sourceLabel }: any,
) {
  if (!rootId || !isUuid(clientRecordId)) return { documents: [], folders: [], truncated: false };

  const rows = await filesRepo.listVisibleForClient(lawFirmId, rootId, clientRecordId);
  const folders = rows.filter((r: any) => r.kind === 'folder');
  const files = rows.filter((r: any) => r.kind === 'file');

  // The portal renders a tree from these, so each row states its own path. Every
  // row's chain comes from one query: a query per row, all at once, took a pool
  // connection per document.
  const chains = await filesRepo.ancestorsForMany(lawFirmId, rows.map((r: any) => r.id));
  const chainOf = (row: any) => chains.get(row.id) || [];

  const documents = files.map((row: any) => {
    const fromRoot = chainOf(row).slice(1).map((a: any) => a.name);
    return {
      id: row.id,
      contextType,
      entityId,
      matterId,
      name: [...fromRoot, row.name].join('/'),
      fileName: row.name,
      parentId: row.parentId,
      objectPath: row.objectPath,
      type: row.mimeType || 'application/octet-stream',
      size: row.sizeBytes,
      uploadedAt: row.createdAt,
      // Listings carry no signed URL. Only the document the client opens needs
      // one, and a URL minted at list time is already partway through its life
      // before anyone clicks it. The client asks for one on open, which
      // re-checks visibility at signing time.
      downloadUrl: '',
      sourceLabel,
    };
  });

  const folderColors = folders.map((row: any) => ({
    id: row.id,
    matterId,
    path: [...chainOf(row).slice(1).map((a: any) => a.name), row.name].join('/'),
    color: row.folderColor || null,
  }));

  documents.sort((a: any, b: any) => new Date(b.uploadedAt || 0).getTime() - new Date(a.uploadedAt || 0).getTime());
  return { documents, folders: folderColors, truncated: false };
}

async function listClientVisibleMatterFiles(lawFirmId: string, matterId: string, clientRecordId: any) {
  if (!matterId || !isUuid(matterId)) return { documents: [], folders: [], truncated: false };
  const rootId = await filesRepo.ensureScopeRoot(lawFirmId, { scope: 'matter', matterId });
  return listVisibleDocuments(lawFirmId, rootId, clientRecordId, {
    contextType: 'matter', entityId: matterId, matterId, sourceLabel: 'Matter file',
  });
}

async function listClientVisibleClientFiles(lawFirmId: string, clientId: string) {
  if (!clientId || !isUuid(clientId)) return { documents: [], folders: [], truncated: false };
  const rootId = await filesRepo.ensureScopeRoot(lawFirmId, { scope: 'client', clientId });
  return listVisibleDocuments(lawFirmId, rootId, clientId, {
    contextType: 'client', entityId: clientId, matterId: null, sourceLabel: 'Client file',
  });
}

async function listClientVisibleTaskFiles(lawFirmId: string, taskId: string, clientRecordId: any) {
  if (!taskId || !isUuid(taskId)) return { documents: [], folders: [], truncated: false };
  const rootId = await filesRepo.ensureScopeRoot(lawFirmId, { scope: 'task', taskId });
  return listVisibleDocuments(lawFirmId, rootId, clientRecordId, {
    contextType: 'task', entityId: taskId, matterId: null, sourceLabel: 'Task file',
  });
}

/**
 * Re-sign one document for a client who is opening it.
 *
 * The authorization is two questions the rows answer: does this file belong to
 * something the client is on, and is it shared with them. The old version split
 * the object path on slashes and compared the segments against the client's
 * matter, task and client ids, which was the portal entire access decision made
 * from a string.
 */
export async function refreshDocumentDownloadUrl(
  { lawFirmId, matterId, clientUserId, userData, fileId, clientRecordId }: any,
) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  if (matterId) ensureMatterAccess(context, matterId);

  const row = await filesRepo.findById(lawFirmId, fileId);
  if (!row || row.kind !== 'file') throw new NotFoundError('Document');

  // Which of the client's own associations this file sits under.
  const reachable = (row.matterId && context.matterIds.includes(row.matterId))
    || (row.taskId && (context.taskIds || []).includes(row.taskId))
    || (row.clientId && row.clientId === context.clientRecordId);
  if (!reachable) throw new NotFoundError('Document');

  // Re-checked at sign time, so a document un-shared since the list loaded
  // cannot be fetched with an id the client already holds.
  if (!(await filesRepo.visibleToClient(lawFirmId, row.id, context.clientRecordId))) {
    throw new NotFoundError('Document');
  }

  const downloadUrl = await signMatterFileUrl(
    admin.storage().bucket(process.env.GCS_BUCKET || 'lawfirms').file(row.objectPath),
    row.name,
    row.mimeType,
  );
  // Opening a document clears its "New" badge for this client (first-seen only).
  // Awaited: the service gets no CPU once the response is sent, so a write left
  // to run afterwards can stall or be lost. recordView catches its own errors,
  // so a failure still never blocks the download.
  await documentViewsRepo.recordView(lawFirmId, clientUserId, row.id);
  return { downloadUrl };
}

// Bound to a small worker pool so a client on many matters doesn't fan out an
// unbounded number of simultaneous GCS prefix scans. Results stay in input order,
// which is what the flattened document lists depend on.
const DOC_SCAN_CONCURRENCY = 5;

// Ordered, bounded map over the shared runner. The runner reports failures in a
// settled array rather than rejecting, so the first failure is re-thrown here to
// keep this helper's all-or-nothing contract for its callers.
async function mapWithConcurrency(items: any, limit: any, worker: any) {
  const settled = await runWithConcurrency(
    items.map((item: any, idx: any) => () => worker(item, idx)),
    limit,
  );
  const failure = settled.find((r: any) => r.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.map((r: any) => r.value);
}

export async function listPortalDocuments({ lawFirmId, clientUserId, userData, clientRecordId }: any) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });

  const empty = { documents: [], folders: [] };

  // Every prefix this page needs: the matters the client is on, the client's own
  // file area (which needs no matter association), and the standalone tasks they
  // are linked to (grouped under "Client files" since they have no matter). The
  // three groups scan unrelated prefixes, so they run as ONE bounded batch rather
  // than three batches waiting on each other. Thunks are built in the order the
  // results are flattened below, and the runner returns results in input order,
  // so the combined list keeps the order it had when each group ran separately.
  const scans = [
    ...context.matterIds.map((matterId: string) => () =>
      listClientVisibleMatterFiles(lawFirmId, matterId, context.clientRecordId).catch(() => empty)),
    () => listClientVisibleClientFiles(lawFirmId, context.clientRecordId).catch(() => empty),
    ...(context.taskIds || []).map((taskId: string) => () =>
      listClientVisibleTaskFiles(lawFirmId, taskId, context.clientRecordId).catch(() => empty)),
  ];

  const settled = await runWithConcurrency(scans, DOC_SCAN_CONCURRENCY);
  const failure = settled.find((r: any) => r.status === 'rejected');
  if (failure) throw failure.reason;
  const all = settled.map((r: any) => r.value);
  const documents = all.flatMap((r: any) => r.documents);
  await annotateNewFlags(lawFirmId, clientUserId, documents);
  return {
    documents,
    folders: all.flatMap((r: any) => r.folders),
    // One short scan makes the whole list short: the client has no way to tell
    // which matter came up incomplete, so the flag covers the combined list.
    truncated: all.some((r: any) => r.truncated),
  };
}

export async function listPortalMatterDocuments(
  { lawFirmId, matterId, clientUserId, userData, clientRecordId }: any,
) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  ensureMatterAccess(context, matterId);

  const matterRecord = await mattersRepo.findByIdRaw(lawFirmId, matterId);
  if (!matterRecord) throw new NotFoundError('Matter');

  const result = await listClientVisibleMatterFiles(lawFirmId, matterId, context.clientRecordId)
    .catch(() => ({ documents: [] as any[], folders: [] as any[], truncated: false }));
  await annotateNewFlags(lawFirmId, clientUserId, result.documents);
  return { documents: result.documents, folders: result.folders, truncated: !!result.truncated };
}

// ── Firm-side "what can this client see" preview ──────────────────
// Mirrors listPortalDocuments, but resolved by the firm-supplied clientId (a
// `clients` row id) instead of a portal clientUserId. A firm member can
// preview exactly what the client sees in their portal. Reuses the same GCS
// visibility predicates as the portal scans; the live portal functions are left
// untouched.

/**
 * One scope's client-visible rows, for the firm-side preview of what a client
 * sees.
 *
 * The same read the portal itself uses, so the preview cannot disagree with the
 * portal about who can see what. It adds only the two labels the preview shows:
 * whether a document is shared directly, and which folder it inherits from
 * otherwise.
 */
async function firmScanScope({ lawFirmId, rootId, contextType, entityId, matterId, clientId }: any) {
  if (!rootId || !isUuid(clientId)) return { documents: [], sharedFolders: [], truncated: false };

  const rows = await filesRepo.listVisibleForClient(lawFirmId, rootId, clientId);
  const sharedFolderRows = rows.filter((r: any) => r.kind === 'folder' && r.clientVisible);

  // One query for every row's chain, not one per row.
  const chains = await filesRepo.ancestorsForMany(lawFirmId, rows.map((r: any) => r.id));
  const chainOf = (row: any) => chains.get(row.id) || [];

  const documents = rows.filter((r: any) => r.kind === 'file').map((row: any) => {
    const fromRoot = chainOf(row).slice(1);
    // The nearest shared ancestor, which is what the preview labels a document
    // "visible via folder X" by.
    const viaFolder = row.clientVisible
      ? null
      : [...fromRoot].reverse().find((a: any) => a.clientVisible) || null;
    return {
      id: row.id,
      contextType,
      entityId,
      matterId: matterId || null,
      name: [...fromRoot.map((a: any) => a.name), row.name].join('/'),
      fileName: row.name,
      parentId: row.parentId,
      objectPath: row.objectPath,
      type: row.mimeType || 'application/octet-stream',
      size: row.sizeBytes,
      uploadedAt: row.createdAt,
      downloadUrl: '',
      sourceLabel: contextType === 'matter' ? 'Matter file' : contextType === 'task' ? 'Task file' : 'Client file',
      directlyShared: row.clientVisible,
      viaFolderPath: viaFolder ? viaFolder.name : null,
    };
  });

  const sharedFolders = sharedFolderRows.map((row: any) => ({
    id: row.id,
    contextType,
    entityId,
    matterId: matterId || null,
    relPath: [...chainOf(row).slice(1).map((a: any) => a.name), row.name].join('/'),
    name: row.name,
  }));

  return { documents, sharedFolders, truncated: false };
}

export async function listClientVisibleDocumentsForFirm({ lawFirmId, clientId }: any) {
  const client = await clientsRepo.findByIdRaw(lawFirmId, clientId);
  if (!client) throw new NotFoundError('Client');

  // Two independent junction reads, so a fixed pair goes out together.
  const [matterIds, taskIds] = await Promise.all([
    clientsRepo.listMatterIds(lawFirmId, clientId).catch(() => []).then(uniq),
    clientsRepo.listTaskIds(lawFirmId, clientId).catch(() => []).then(uniq),
  ]);

  const empty = { documents: [], sharedFolders: [] };

  // The matter, client-area and task prefixes are unrelated scans, so they run as
  // one bounded batch. Built in the order the results are flattened below, and
  // the runner preserves input order, so the combined list is unchanged.
  const scans = [
    ...matterIds.map((matterId: string) => () =>
      filesRepo.ensureScopeRoot(lawFirmId, { scope: 'matter', matterId })
        .then((rootId: string) => firmScanScope({
          lawFirmId, rootId, contextType: 'matter', entityId: matterId, matterId, clientId,
        })).catch(() => empty)),
    () => (isUuid(clientId)
      ? filesRepo.ensureScopeRoot(lawFirmId, { scope: 'client', clientId })
          .then((rootId: string) => firmScanScope({
            lawFirmId, rootId, contextType: 'client', entityId: clientId, matterId: null, clientId,
          })).catch(() => empty)
      : Promise.resolve(empty)),
    ...taskIds.map((taskId: string) => () =>
      filesRepo.ensureScopeRoot(lawFirmId, { scope: 'task', taskId })
        .then((rootId: string) => firmScanScope({
          lawFirmId, rootId, contextType: 'task', entityId: taskId, matterId: null, clientId,
        })).catch(() => empty)),
  ];

  const settled = await runWithConcurrency(scans, DOC_SCAN_CONCURRENCY);
  const failure = settled.find((r: any) => r.status === 'rejected');
  if (failure) throw failure.reason;
  const all = settled.map((r: any) => r.value);
  return {
    documents: all.flatMap((r: any) => r.documents),
    sharedFolders: all.flatMap((r: any) => r.sharedFolders),
    // The firm reads this preview as "everything the client can see", which is
    // the one place a short list is most likely to be trusted as complete.
    truncated: all.some((r: any) => r.truncated),
  };
}

/** Resolve the relational conversation for a (firm, client) pair, or null. */
async function findPortalConversation(lawFirmId: string, clientUserId: string) {
  const conversations = await messagingRepo.getConversationsByClient(clientUserId);
  return conversations.find((c: any) => c.lawFirmId === lawFirmId) || null;
}

/**
 * Resolve whether an explicit `conversationId` a portal messaging route was
 * given is a DIRECT or GROUP thread, enforcing that it belongs to the path's
 * lawFirmId (organization-clients plan Phase 7 - a company's canonical
 * conversation, and any ad-hoc group a client was added to, are GROUP
 * threads; the client's own thread with the firm is DIRECT).
 *
 * This only proves firm-scoping. Authorization beyond that is the delegate's
 * job: `messagingService.getGroupConversation`/`sendGroupMessage`/
 * `markGroupRead` already assert active participation for a group (Forbidden
 * if the caller isn't one), and the direct branch is verified by the caller
 * against `findPortalConversation`'s own clientUserId-keyed result.
 */
async function resolvePortalConversationTarget({ lawFirmId, conversationId }: any) {
  const row = await messagingRepo.loadConversationAuthRow(conversationId);
  if (!row) throw new NotFoundError('Conversation');
  if (row.law_firm_id !== lawFirmId) {
    throw new ForbiddenError('Conversation does not belong to this law firm');
  }
  return { kind: row.conversation_type === 'group' ? 'group' : 'direct' };
}

/**
 * Every conversation this portal uid participates in for one firm: their own
 * direct thread with the firm (if a person association has one) plus every
 * GROUP thread they are an active participant of - a company's canonical
 * conversation for each company association, and any ad-hoc group a firm
 * member added them to.
 *
 * Participant-membership-based, not active-client-scoped (Messaging contract,
 * organization-clients plan Phase 7): a uid who is both a personal client and
 * a company roster member (Jane in the acceptance identities) sees both
 * without switching their active client record. Each row is tagged with
 * `clientRecordId` so the frontend can group/deep-link by client record, per
 * the Portal selection contract's "UID-owned feeds" carve-out.
 */
export async function listPortalConversations({ lawFirmId, clientUserId, userData }: any) {
  const { associations } = await assertPortalFirmAssociation({ lawFirmId, clientUserId, userData });
  const personAssociation = associations.find((a: any) => a.clientType === 'person') || null;

  const [directConversation, { conversations: groups }] = await Promise.all([
    findPortalConversation(lawFirmId, clientUserId),
    messagingRepo.getGroupConversationsForUser(clientUserId, { lawFirmId }),
  ]);

  const conversations: any[] = [];
  if (directConversation) {
    conversations.push({
      conversationId: directConversation.conversationId,
      conversationType: 'direct',
      clientRecordId: personAssociation?.clientRecordId || null,
      clientType: 'person',
      title: directConversation.lawFirmName || '',
      lastMessageAt: directConversation.lastMessageAt,
      lastMessagePreview: directConversation.lastMessagePreview,
      unreadCount: Math.max(0, Math.trunc(toNumber(directConversation.unreadCountClient))),
      archivedAt: directConversation.archivedAt,
    });
  } else if (personAssociation) {
    // A person client with no direct row yet (only ever written by the first
    // message) still gets a personal thread to open. Without this entry, a
    // client who is only on group threads had no way to start one. The id is
    // the synthetic `${lawFirmId}_${uid}` key the portal's direct-thread view
    // already opens before a conversation row exists.
    conversations.push({
      conversationId: `${lawFirmId}_${clientUserId}`,
      conversationType: 'direct',
      clientRecordId: personAssociation.clientRecordId || null,
      clientType: 'person',
      title: (await messagingRepo.getLawFirmName(lawFirmId)) || '',
      lastMessageAt: null,
      lastMessagePreview: '',
      unreadCount: 0,
      archivedAt: null,
    });
  }
  for (const g of groups) {
    conversations.push({
      conversationId: g.conversationId,
      conversationType: 'group',
      clientRecordId: g.clientRecordId || null,
      // An ad-hoc group with no company binding has no clientType of its own.
      clientType: g.clientRecordId ? 'company' : null,
      title: g.title || '',
      lastMessageAt: g.lastMessageAt,
      lastMessagePreview: g.lastMessagePreview,
      unreadCount: g.unreadCount,
      archivedAt: g.archivedAt,
    });
  }

  // Archiving is firm-side only (see getClientUnreadCount) - a portal client's
  // own list still shows an archived thread, just sorted by its last activity
  // like everything else.
  conversations.sort((a, b) => {
    const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return bt - at;
  });

  return { conversations, totalItems: conversations.length };
}

/** Map a relational message entity to the portal's legacy message shape. */
function toPortalMessage(m: any) {
  return {
    id: m.messageId,
    messageId: m.messageId,
    senderId: m.senderId,
    senderType: m.senderType,
    senderName: m.senderName,
    senderPhotoUrl: m.senderPhotoUrl ?? null,
    sentAsFirm: m.sentAsFirm === true,
    content: m.content,
    attachments: m.attachments || [],
    status: m.status,
    read: m.read,
    readByClient: m.readByClient,
    readByFirm: m.readByFirm,
    matterId: m.matterId || null,
    createdAt: m.createdAt,
    timestamp: m.createdAt,
    updatedAt: m.updatedAt,
    readAt: m.readAt,
    // Edit/delete markers (content is already masked in the entity when deleted).
    editedAt: m.editedAt ?? null,
    deleted: m.deleted === true,
    deletedAt: m.deletedAt ?? null,
  };
}

/**
 * One page of a conversation the portal client can read, newest page first.
 *
 * `conversationId` is optional and picks WHICH conversation: omitted (or
 * equal to the client's own direct thread's id), this is the client's direct
 * thread with the firm, exactly as before Phase 7. Given a GROUP thread's id
 * (a company's canonical conversation, or any ad-hoc group the client is an
 * active participant of), this delegates to `messagingService.getGroupConversation`
 * so both thread shapes share the same masking/attachment-resign/history-cutoff
 * logic the firm-side and existing client-group routes already use.
 *
 * `lastMessageId` is the oldest message the client already holds, so passing it
 * walks backwards through the history the same way the group thread and the
 * firm-side reader do. `hasMore` tells the UI whether an older page exists;
 * without it a long-running matter's thread was capped at its newest messages
 * with nothing on screen to say more existed.
 */
export async function listPortalMessages({ lawFirmId, clientUserId, userData, limit, lastMessageId, conversationId }: any) {
  // Messaging authorizes by conversation participation, not active-client
  // selection (Phase 7 of the organization-clients plan) - this only needs to
  // prove SOME association with the firm, not pick one.
  await assertPortalFirmAssociation({ lawFirmId, clientUserId, userData });

  if (conversationId) {
    const target = await resolvePortalConversationTarget({ lawFirmId, conversationId });
    if (target.kind === 'group') {
      // getGroupConversation itself asserts active participation (Forbidden if
      // the caller isn't one) and applies every client-facing mask.
      const { messages, hasMore } = await messagingService.getGroupConversation({
        conversationId,
        userId: clientUserId,
        query: { limit: limit || PORTAL_MESSAGE_PAGE_SIZE, lastMessageId: lastMessageId || undefined },
      });
      return { messages: messages.map(toPortalMessage), hasMore, conversationId };
    }
    // Falls through to the direct-thread path below, which verifies this id
    // actually matches the client's own conversation.
  }

  const conversation = await findPortalConversation(lawFirmId, clientUserId);
  if (!conversation) return { messages: [], hasMore: false, conversationId: null };
  if (conversationId && conversation.conversationId !== conversationId) {
    throw new ForbiddenError('Access denied to conversation');
  }

  const { messages, hasMore } = await messagingRepo.getMessages(conversation.conversationId, {
    limit: limit || PORTAL_MESSAGE_PAGE_SIZE,
    lastMessageId: lastMessageId || null,
  });

  // "Send as firm": present firm-member messages the sender chose to send under
  // the firm identity as the firm's name + logo (client-facing; shared with the
  // group read path so both mask identically).
  await messagingService.maskSendAsFirmMessages(messages, lawFirmId);

  // Re-sign attachment URLs so the client can open their own attachments. Stored
  // URLs are stripped before persist / expire; the firm read path re-signs, the
  // portal path previously didn't (so attachment.url was undefined for clients).
  await mapWithConcurrency(messages, MESSAGE_ATTACHMENT_RESIGN_CONCURRENCY, async (m: any) => {
    if (m.attachments && m.attachments.length) m.attachments = await resignAttachments(m.attachments);
  });

  // Mark firm->client messages as read for this client (mirrors legacy behaviour).
  const unreadFirmMessageIds = messages
    .filter((m: any) => m.senderType === 'firm_member' && m.readByClient !== true)
    .map((m: any) => m.messageId);
  if (unreadFirmMessageIds.length > 0) {
    await messagingRepo.markRead(conversation.conversationId, 'client', unreadFirmMessageIds).catch(() => {});
  }

  return { messages: messages.map(toPortalMessage), hasMore, conversationId: conversation.conversationId };
}

/** Attachments one portal message may carry, and the largest single file. */
const PORTAL_ATTACHMENT_MAX_FILES = 5;
const PORTAL_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Which messaging folder this client may write attachments into.
 *
 * Resolved from the caller's own access on every call rather than taken from
 * the request. A group folder is the only one `sendGroupMessage` accepts
 * attachments from, and writing there requires ACTIVE participation, so a
 * request-supplied folder is a way into a thread the client is not in. A
 * conversation that is not a group this client participates in silently falls
 * back to their own direct thread, which is where their own files belong.
 */
async function resolvePortalAttachmentFolder(
  { lawFirmId, clientUserId, conversationId }: any,
): Promise<string> {
  if (conversationId) {
    const row = await messagingRepo.loadConversationAuthRow(conversationId);
    if (row && row.law_firm_id === lawFirmId && row.conversation_type === 'group') {
      if (!(await messagingRepo.isActiveParticipant(conversationId, clientUserId))) {
        throw new ForbiddenError('You are not a participant in this conversation');
      }
      return `group_${conversationId}`;
    }
  }
  return `${lawFirmId}_${clientUserId}`;
}

/** The storage prefix for one resolved messaging folder. */
const portalAttachmentPrefix = (lawFirmId: string, conversationId: string) =>
  `lawfirmids/${lawFirmId}/messaging/${conversationId}/`;

/**
 * Open a direct upload for message attachments from the client portal.
 *
 * The files used to arrive as multipart: five at a hundred megabytes each,
 * resident in a 512 MiB container that serves eighty concurrent requests and
 * signs documents. They now go browser to storage.
 *
 * The executable deny-list stays, and matters more here than anywhere else:
 * this is the one upload path whose caller is OUTSIDE the firm, so it is how a
 * client would deliver active content to staff.
 */
export async function beginMessageAttachmentUpload(
  { lawFirmId, clientUserId, userData, files, conversationId, origin }: any,
) {
  await assertPortalFirmAssociation({ lawFirmId, clientUserId, userData });
  const folder = await resolvePortalAttachmentFolder({ lawFirmId, clientUserId, conversationId });

  return beginDirectUploadBatch({
    lawFirmId,
    uploadedBy: clientUserId,
    files: files || [],
    maxBytes: PORTAL_ATTACHMENT_MAX_BYTES,
    maxFiles: PORTAL_ATTACHMENT_MAX_FILES,
    resolvePath: (file: any) => {
      const safeName = String(file.fileName || 'upload.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
      const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 11)}_${safeName}`;
      return `${portalAttachmentPrefix(lawFirmId, folder)}${unique}`;
    },
    origin,
    metadata: { lawFirmId, conversationId: folder, type: 'message-attachment' },
  });
}

/**
 * Verify what the client uploaded and hand back attachment descriptors.
 *
 * The association and the folder are resolved AGAIN here rather than trusted
 * from the request: this route is reachable on its own, and skipping either
 * would let an outsider record attachments against a firm they have no
 * relationship with, or a client record them into a thread they are not in.
 */
export async function finishMessageAttachmentUpload(
  { lawFirmId, clientUserId, userData, uploads, conversationId }: any,
) {
  await assertPortalFirmAssociation({ lawFirmId, clientUserId, userData });
  const folder = await resolvePortalAttachmentFolder({ lawFirmId, clientUserId, conversationId });
  const prefix = portalAttachmentPrefix(lawFirmId, folder);

  const list = Array.isArray(uploads) ? uploads : [];
  // No more than init would open. The array is the caller's, and each entry
  // costs a storage settle and a signed url.
  if (list.length > PORTAL_ATTACHMENT_MAX_FILES) {
    throw new ValidationError({ uploads: [`Attach at most ${PORTAL_ATTACHMENT_MAX_FILES} files at once.`] });
  }
  // The paths are echoed back by the client. Unchecked, an attachment could be
  // recorded against any object in the bucket.
  for (const upload of list) {
    const objectPath = String(upload?.objectPath || '');
    if (!objectPath.startsWith(prefix) || objectPath.slice(prefix.length).includes('/')) {
      throw new ValidationError({ uploads: ['That upload does not belong to this conversation'] });
    }
  }

  const bucket = admin.storage().bucket(process.env.GCS_BUCKET || 'lawfirms');

  const { results: attachments, failures } = await settleDirectUploadBatch({
    lawFirmId,
    uploadedBy: clientUserId,
    uploads: list,
    maxBytes: PORTAL_ATTACHMENT_MAX_BYTES,
    onSettled: async (settled: any, index: number) => {
      const originalName = String(list[index]?.fileName || 'upload.bin').slice(0, 255);
      // The stamp is what send checks, and charging only the call that wrote it
      // keeps a repeated finalize of the same object from billing twice.
      const firstFinalize = await stampDirectUploadFinalized(settled.objectPath, { originalName });
      const [signedUrl] = await bucket.file(settled.objectPath).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + 1000 * 60 * 60, // 1 hour
        responseDisposition: dispositionFor(settled.contentType, originalName),
      });
      return {
        id: `${Date.now()}_${index}`,
        name: originalName,
        url: signedUrl,
        objectPath: settled.objectPath,
        mimeType: settled.contentType,
        size: settled.size,
        chargedBytes: firstFinalize ? settled.size : 0,
      };
    },
  });

  return { attachments, failures };
}

/**
 * Cancel message attachment uploads the client abandoned: free the quota they
 * hold at once, and remove any partial bytes they left.
 *
 * The association and the folder are resolved again, as at finalize. An object
 * is removed only when it sits directly under that folder and no saved message
 * names it; `discardDirectUploadBatch` adds the rest (this client's stamp, the
 * same reservation, and that reservation still live). A sent attachment is the
 * firm's record of what it received, and a client cannot take it back here.
 */
export async function cancelMessageAttachmentUpload(
  { lawFirmId, clientUserId, userData, uploads, conversationId }: any,
) {
  await assertPortalFirmAssociation({ lawFirmId, clientUserId, userData });
  const folder = await resolvePortalAttachmentFolder({ lawFirmId, clientUserId, conversationId });
  const prefix = portalAttachmentPrefix(lawFirmId, folder);

  const list = Array.isArray(uploads) ? uploads : [];
  if (list.length > PORTAL_ATTACHMENT_MAX_FILES) {
    throw new ValidationError({ uploads: [`Attach at most ${PORTAL_ATTACHMENT_MAX_FILES} files at once.`] });
  }

  return discardDirectUploadBatch({
    lawFirmId,
    uploadedBy: clientUserId,
    uploads: list,
    mayDeleteObject: async (objectPath: string) => objectPath.startsWith(prefix)
      && !objectPath.slice(prefix.length).includes('/')
      && !(await messagingRepo.isAttachmentObjectReferenced(lawFirmId, objectPath)),
  });
}

/**
 * Discard attachments the client uploaded and removed from the composer
 * without sending: delete the objects and give their bytes back to the firm.
 *
 * The association and the folder are resolved again, as at finalize.
 * `discardUnsentAttachments` deletes only the client's own finalized objects in
 * that folder that no message names, so the firm's uploads in the same direct
 * thread, and anything already sent, stay.
 */
export async function discardMessageAttachmentUploads(
  { lawFirmId, clientUserId, userData, objectPaths, conversationId }: any,
) {
  await assertPortalFirmAssociation({ lawFirmId, clientUserId, userData });
  const folder = await resolvePortalAttachmentFolder({ lawFirmId, clientUserId, conversationId });

  return messagingService.discardUnsentAttachments({
    lawFirmId,
    userId: clientUserId,
    prefix: portalAttachmentPrefix(lawFirmId, folder),
    objectPaths,
  });
}

/** Documents one portal upload-init may open, and the largest single file. */
const PORTAL_DOCUMENT_MAX_FILES = 10;
const PORTAL_DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Documents one portal upload-finalize (or cancel) may name.
 *
 * Larger than the per-init cap on purpose. A selection of more than ten files
 * is opened as several inits of ten, and finalized in ONE call, because the
 * finish is what tells the firm (`DOCUMENT_UPLOADED_BY_CLIENT`) and records a
 * request item's fulfilment: one finalize per init would announce one upload
 * several times. It still has a ceiling, since the array is the caller's and
 * each entry costs a storage settle.
 */
export const PORTAL_DOCUMENT_MAX_FINALIZE = 50;

/**
 * Open a direct upload for client documents into a matter or client file area.
 *
 * These write a file ROW, unlike message attachments, so the row is claimed here
 * before any byte exists. That row is then the authorization: finalize looks it
 * up by id and checks it sits in the scope this caller was granted, so naming
 * another client's row finds nothing rather than yielding a signed url for it.
 *
 * A row claimed for an upload that then fails admission is removed again. Left
 * behind, each holds its name in the folder until the sweeper finds it, and the
 * user's retry lands as "receipt (1).pdf".
 */
async function beginClientDocumentUpload(
  { lawFirmId, matterId, clientId, clientUserId, files, origin, extraMetadata = {} }: any,
) {
  // Before anything is created. `ensureScopeRoot` writes a folder row, so
  // validating after it would leave one behind for a request that was never
  // valid, and the empty-selection case would report a refusal over a side
  // effect it had already had.
  const declaredFiles = Array.isArray(files) ? files : [];
  if (declaredFiles.length === 0) {
    throw new ValidationError({ files: ['No files provided'] });
  }

  const rootId = await filesRepo.ensureScopeRoot(lawFirmId, matterId
    ? { scope: 'matter', matterId }
    : { scope: 'client', clientId });

  const claimed: any[] = [];
  try {
    // The ROW claims the name and the database decides it. Two clients
    // uploading `receipt.pdf` at once both see a free path if storage is probed
    // instead, and the second PUT replaces the first.
    for (const file of declaredFiles) {
      // eslint-disable-next-line no-await-in-loop -- each row may retry a name
      claimed.push(await filesRepo.createFile(lawFirmId, {
        parentId: rootId,
        name: file?.fileName || 'upload.bin',
        mimeType: file?.contentType || 'application/octet-stream',
        uploadedBy: clientUserId,
        // The uploading client keeps seeing what they sent. Set at insert rather
        // than patched afterwards, so there is no window where a client's own
        // upload is invisible to them.
        clientVisible: true,
      }));
    }

    const opened = await beginDirectUploadBatch({
      lawFirmId,
      uploadedBy: clientUserId,
      files: declaredFiles,
      maxBytes: PORTAL_DOCUMENT_MAX_BYTES,
      maxFiles: PORTAL_DOCUMENT_MAX_FILES,
      resolvePath: (_file: any, index: number) => claimed[index].objectPath,
      origin,
      metadata: {
        uploadedBy: clientUserId,
        uploadedByClient: 'true',
        lawFirmId,
        ...(matterId ? { matterId } : {}),
        ...(clientId ? { clientId } : {}),
        ...extraMetadata,
      },
    });

    // Each upload carries its `reservationId` from the batch; finalize and
    // cancel take it back.
    return {
      uploads: opened.uploads.map((upload: any, i: number) => ({
        ...upload, fileId: claimed[i].id,
      })),
      reservedBytes: opened.reservedBytes,
    };
  } catch (err) {
    await filesRepo.hardDelete(claimed.map((row: any) => row.id)).catch((cleanupErr: any) =>
      console.error('portal upload: claimed row cleanup failed', cleanupErr?.message));
    throw err;
  }
}

/**
 * Verify what the client uploaded and stamp the rows that were claimed.
 *
 * The row is checked against the scope this request was authorized for before
 * anything is stamped or signed. Without that a client could name a row in a
 * matter they have no access to and be handed a download url for it.
 */
async function finishClientDocumentUpload(
  { lawFirmId, matterId, clientId, clientUserId, uploads }: any,
) {
  const list = Array.isArray(uploads) ? uploads : [];
  // Several inits' worth, so one selection is announced once, but bounded: the
  // array is the caller's, so without a ceiling it decides how much work one
  // finalize does.
  if (list.length > PORTAL_DOCUMENT_MAX_FINALIZE) {
    throw new ValidationError({ uploads: [`Upload at most ${PORTAL_DOCUMENT_MAX_FINALIZE} files at once.`] });
  }

  // Every row in one query. A lookup per upload, all at once, took a pool
  // connection per file.
  const found = await filesRepo.findManyByIds(lawFirmId, list.map((upload: any) => upload?.fileId));
  const foundById = new Map<string, any>(found.map((row: any) => [row.id, row]));
  const rows = list.map((upload: any) => foundById.get(upload?.fileId) || null);

  const settleable = list.filter((_upload: any, i: number) => {
    const row = rows[i];
    if (!row || row.parentId == null || row.deletedAt || row.uploadedBy !== clientUserId) return false;
    // The row's own scope has to be the one this request was authorized for.
    if (matterId) return String(row.matterId) === String(matterId);
    return String(row.clientId) === String(clientId);
  });
  const settleableRows = rows.filter((row: any, i: number) => settleable.includes(list[i]));

  const completed = settleableRows.filter((row: any) => row.finalizedAt).map((row: any) => ({
    fileId: row.id, name: row.name, objectPath: row.objectPath, mimeType: row.mimeType,
    size: row.sizeBytes, chargedBytes: 0,
  }));
  const pending = settleable.map((upload: any, i: number) => ({ upload, row: settleableRows[i] }))
    .filter(({ row }: any) => !row.finalizedAt);
  const { results, failures } = await settleDirectUploadBatch({
    lawFirmId,
    uploadedBy: clientUserId,
    // The ROW names the object. The body's path is ignored: taking it let a
    // client finalize one row with the bytes of a different upload of theirs.
    uploads: pending.map(({ upload, row }: any) => ({
      objectPath: row.objectPath, fileName: upload.fileName, reservationId: upload.reservationId,
    })),
    maxBytes: PORTAL_DOCUMENT_MAX_BYTES,
    onSettled: async (settled: any, index: number) => {
      const row = pending[index].row;
      const stamped = await filesRepo.finalize(lawFirmId, row.id, {
        sizeBytes: settled.size,
        mimeType: settled.contentType,
      });
      return {
        fileId: stamped.id,
        name: stamped.name,
        objectPath: settled.objectPath,
        mimeType: settled.contentType,
        size: settled.size,
        // Charged for the CHANGE in stored bytes, read under the row lock by
        // the stamp itself, so a retried finalize is charged nothing.
        chargedBytes: settled.size - stamped.previouslyCounted,
      };
    },
  });

  // The settle above deleted the reservations of the uploads it settled. The
  // rest (a row that was not found or not in scope) end here too: each is
  // scoped to this caller, so naming someone else's releases nothing, and one
  // already gone is a no-op.
  await releaseStorageReservations({
    lawFirmId, createdBy: clientUserId, reservationIds: list.map((upload: any) => upload?.reservationId),
  });

  return { documents: [...completed, ...results], failures };
}

/**
 * Cancel client document uploads: free the quota they hold and the rows they
 * claimed, at once.
 *
 * A row is removed only when it is in the scope this request was authorized
 * for, still unfinalized, and was claimed by this client; its object is the one
 * the row names. A document that already landed is never touched, and neither
 * is another client's upload into the same matter.
 */
async function cancelClientDocumentUpload(
  { lawFirmId, matterId, clientId, clientUserId, uploads }: any,
) {
  const list = Array.isArray(uploads) ? uploads : [];
  if (list.length > PORTAL_DOCUMENT_MAX_FINALIZE) {
    throw new ValidationError({ uploads: [`Cancel at most ${PORTAL_DOCUMENT_MAX_FINALIZE} files at once.`] });
  }

  await releaseStorageReservations({
    lawFirmId, createdBy: clientUserId, reservationIds: list.map((upload: any) => upload?.reservationId),
  });

  const found = await filesRepo.findManyByIds(lawFirmId, list.map((upload: any) => upload?.fileId));
  const inScope = found.filter((row: any) => row.parentId != null && (matterId
    ? String(row.matterId) === String(matterId)
    : String(row.clientId) === String(clientId)));
  const removed = await filesRepo.deleteUnfinalizedUploads(
    lawFirmId, inScope.map((row: any) => row.id), clientUserId,
  );

  // Best effort: the upload may have written some bytes or none, and an object
  // with no row naming it is reachable by no listing and counted by nothing.
  await Promise.all(removed.map((row: any) => filesBucket.file(row.objectPath).delete()
    .catch((err: any) => {
      if (err?.code !== 404) console.error('portal upload cancel: object delete failed', row.objectPath, err?.message);
    })));

  return { cancelled: removed.length };
}

/**
 * Free client upload into a matter: the client picks one of their matters and
 * uploads documents, which land in the matter's file area visible to the firm.
 */
/**
 * Open a free client upload into one of their matters.
 *
 * The documents used to arrive as multipart: ten files at a hundred megabytes
 * each, resident in a 512 MiB container that serves eighty concurrent requests
 * and signs documents.
 */
export async function beginMatterDocumentUpload(
  { lawFirmId, clientUserId, userData, matterId, files, clientRecordId, origin }: any,
) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  ensureMatterAccess(context, matterId);

  return beginClientDocumentUpload({ lawFirmId, matterId, clientUserId, files, origin });
}

/**
 * Save the documents the client uploaded into their matter.
 *
 * The access check runs again rather than being trusted from init: this route is
 * reachable on its own, so skipping it would let a client stamp rows in a matter
 * they were refused a moment earlier.
 */
export async function finishMatterDocumentUpload(
  { lawFirmId, clientUserId, userData, matterId, uploads, clientRecordId }: any,
) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  ensureMatterAccess(context, matterId);

  const { documents, failures } = await finishClientDocumentUpload({
    lawFirmId, matterId, clientUserId, uploads,
  });

  // Only when something actually landed. Announcing an upload of nothing sends
  // the firm to a matter to look at a document that is not there.
  if (documents.length > 0) {
    eventBus.emit(DOCUMENT_UPLOADED_BY_CLIENT, {
      lawFirmId,
      matterId,
      clientName: context.clientRecord?.name || '',
      fileCount: documents.length,
      requestTitle: null,
    });
  }

  return { documents, failures };
}

/**
 * Cancel a free client upload into one of their matters. The matter access is
 * checked again, as at finalize, because this route stands alone.
 */
export async function cancelMatterDocumentUpload(
  { lawFirmId, clientUserId, userData, matterId, uploads, clientRecordId }: any,
) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  ensureMatterAccess(context, matterId);

  return cancelClientDocumentUpload({ lawFirmId, matterId, clientUserId, uploads });
}

/**
 * Fulfill a document-request checklist item: verify the request is addressed to
 * this client, file the uploaded document(s) into the request's matter, record
 * each as a fulfillment (flipping the item to received), and notify the firm.
 */
/**
 * Open an upload that fulfils a document-request checklist item.
 *
 * The request has to be addressed to THIS client and not cancelled, checked
 * before a session url exists: once one is minted the bytes reach storage
 * whatever happens afterwards.
 */
export async function beginRequestItemUpload(
  { lawFirmId, clientUserId, userData, requestId, itemId, files, clientRecordId, origin, actionKey }: any,
) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  const clientId = context.clientRecordId;
  const target = await documentRequestsService.getClientRequestTarget({ lawFirmId, clientId, requestId });
  if (target.status === 'cancelled') throw new ValidationError('This request has been cancelled');
  if (target.matterId) ensureMatterAccess(context, target.matterId);
  await documentRequestsService.assertClientRequestItem({ lawFirmId, clientId, requestId, itemId });

  const open = () => beginClientDocumentUpload({
    lawFirmId,
    matterId: target.matterId,
    clientId,
    clientUserId,
    files,
    origin,
    extraMetadata: { documentRequestId: requestId, documentRequestItemId: itemId },
  });
  if (actionKey === undefined) return open();
  if (!isUuid(actionKey)) throw new ValidationError('Upload action key must be a UUID');
  const requestHash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return withLock('HOUSEKEEPING', `document-upload:${lawFirmId}:${itemId}:${clientUserId}:${actionKey}`, async () => {
    const existing = await documentRequestUploadsRepo.findAction(lawFirmId, itemId, clientUserId, actionKey);
    if (existing.length) {
      if (existing.length !== files.length || existing.some(({ receipt }: any) => receipt.requestHash !== requestHash)) {
        throw new ConflictError('This upload action was already used for a different selection');
      }
      if (existing.some(({ file }: any) => file.deletedAt)) throw new ConflictError('This upload was removed. Select the files again.');
      if (existing.some(({ receipt, file }: any) => !file.finalizedAt && Date.now() - receipt.createdAt.getTime() > 6 * 24 * 60 * 60 * 1000)) {
        throw new ConflictError('This upload has expired. Select the files again.');
      }
      return {
        uploads: existing.map(({ receipt, file }: any) => ({
          uploadUrl: file.finalizedAt ? '' : receipt.uploadUrl, objectPath: file.objectPath,
          fileId: file.id, fileName: files[receipt.position].fileName,
          contentType: files[receipt.position].contentType || 'application/octet-stream',
          declaredSize: files[receipt.position].size, reservationId: receipt.reservationId,
          ...(file.finalizedAt ? { isFinalized: true } : {}),
        })),
        reservedBytes: 0,
      };
    }
    const opened = await open();
    try {
      await documentRequestUploadsRepo.saveAction(lawFirmId, itemId, clientUserId, actionKey, requestHash, opened.uploads);
    } catch (err) {
      await cancelClientDocumentUpload({ lawFirmId, matterId: target.matterId, clientId, clientUserId, uploads: opened.uploads });
      throw err;
    }
    return opened;
  }, { lockTimeoutMs: 30000, maxHoldMs: 120000 });
}

/**
 * Record the fulfilment once the documents have landed.
 *
 * The request is resolved again here, for the same reason the matter access is:
 * this route stands alone, and a cancelled or re-addressed request must not be
 * fulfilled by a session opened before it changed.
 */
export async function finishRequestItemUpload(
  { lawFirmId, clientUserId, userData, requestId, itemId, uploads, clientRecordId }: any,
) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  const clientId = context.clientRecordId;
  const target = await documentRequestsService.getClientRequestTarget({ lawFirmId, clientId, requestId });
  if (target.status === 'cancelled') throw new ValidationError('This request has been cancelled');
  if (target.matterId) ensureMatterAccess(context, target.matterId);
  await documentRequestsService.assertClientRequestItem({ lawFirmId, clientId, requestId, itemId });

  const { documents, failures } = await finishClientDocumentUpload({
    lawFirmId,
    matterId: target.matterId,
    clientId,
    clientUserId,
    uploads,
  });

  // The checklist line only moves to "received" for documents that landed. A
  // fulfilment recorded over nothing tells the firm the client has answered.
  if (documents.length > 0) {
    await documentRequestsService.recordFulfillment({
      lawFirmId,
      clientId,
      requestId,
      itemId,
      files: documents.map((d: any) => ({ fileId: d.fileId })),
      uploadedBy: clientUserId,
    });

    eventBus.emit(DOCUMENT_UPLOADED_BY_CLIENT, {
      lawFirmId,
      matterId: target.matterId,
      clientName: context.clientRecord?.name || '',
      fileCount: documents.length,
      eventId: createHash('sha256').update(`${itemId}:${documents.map((d: any) => d.fileId).sort().join(',')}`).digest('hex'),
      requestTitle: target.title,
    });
  }

  return { documents, failures, requestId, itemId };
}

/**
 * Cancel an upload that was meant to fulfil a checklist item.
 *
 * The request must still be addressed to this client, which is what scopes the
 * rows that can be reached. A cancelled request does not block it: freeing an
 * abandoned upload is exactly what a client should be able to do after the
 * firm withdrew the request.
 */
export async function cancelRequestItemUpload(
  { lawFirmId, clientUserId, userData, requestId, uploads, clientRecordId }: any,
) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  const clientId = context.clientRecordId;
  const target = await documentRequestsService.getClientRequestTarget({ lawFirmId, clientId, requestId });
  if (target.matterId) ensureMatterAccess(context, target.matterId);

  return cancelClientDocumentUpload({
    lawFirmId, matterId: target.matterId, clientId, clientUserId, uploads,
  });
}

/**
 * Portal read: the document requests addressed to this client, optionally scoped
 * to one matter. Delegates identity resolution to getActiveClientAccessContext.
 */
export async function listPortalDocumentRequests(
  { lawFirmId, clientUserId, userData, matterId = null, clientRecordId }: any,
) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  if (matterId) ensureMatterAccess(context, matterId);
  return documentRequestsService.listClientRequests({ lawFirmId, clientId: context.clientRecordId, matterId });
}

/**
 * Portal read: mint a short-lived signed URL for a file attached to a
 * checklist item, so the client can preview or download it. Works for a file
 * the client uploaded themselves as well as one the firm attached.
 */
export async function getPortalRequestFulfillmentUrl(
  { lawFirmId, clientUserId, userData, requestId, itemId, fulfillmentId, clientRecordId }: any,
) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  const { objectPath, fileName } = await documentRequestsService.getClientFulfillmentFile({
    lawFirmId, clientId: context.clientRecordId, requestId, itemId, fulfillmentId,
  });

  const file = filesBucket.file(objectPath);
  const [metadata] = await file.getMetadata().catch(() => [null]);
  if (!metadata) throw new NotFoundError('File');

  const signedUrl = await signObject(objectPath, metadata.contentType, fileName, SIGNED_URL_TTL_DEFAULT);
  return {
    signedUrl,
    fileName,
    contentType: metadata.contentType || 'application/octet-stream',
    size: Number(metadata.size) || 0,
  };
}

/** Portal write: remove a file the client uploaded themselves against an item. */
export async function deletePortalRequestFulfillment(
  { lawFirmId, clientUserId, userData, requestId, itemId, fulfillmentId, clientRecordId }: any,
) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  return documentRequestsService.deleteClientFulfillment({
    lawFirmId, clientId: context.clientRecordId, clientUserId, requestId, itemId, fulfillmentId,
  });
}

/**
 * Send a message into a conversation the portal client can write to.
 *
 * `body.conversationId` is optional and picks WHICH conversation, mirroring
 * `listPortalMessages`: omitted, this sends into the client's own direct
 * thread with the firm (unchanged contract). Given a GROUP thread's id (a
 * company's canonical conversation, or an ad-hoc group), this delegates to
 * `messagingService.sendGroupMessage` - which has no `matterId` tagging of
 * its own (group matter scope is set on the conversation, not per message),
 * so `body.matterId` is only honored on the direct-thread path.
 */
export async function sendPortalMessage({ lawFirmId, clientUserId, userData, body }: any) {
  // Messaging authorizes by conversation participation, not active-client
  // selection (Phase 7) - prove SOME association, don't force a selection.
  const { associations } = await assertPortalFirmAssociation({ lawFirmId, clientUserId, userData });

  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];

  if (!content && attachments.length === 0) {
    throw new ValidationError({ content: ['Message content or at least one attachment is required'] });
  }

  const conversationId = body.conversationId || null;
  if (conversationId) {
    const target = await resolvePortalConversationTarget({ lawFirmId, conversationId });
    if (target.kind === 'group') {
      // sendGroupMessage itself asserts active participation (Forbidden if
      // the caller isn't one).
      const result = await messagingService.sendGroupMessage({
        conversationId, userId: clientUserId, body: { content, attachments },
      });
      return { message: 'Message sent successfully', messageId: result.messageId, conversationId: result.conversationId };
    }
    // Falls through to the direct-thread path below.
  }

  const matterId = body.matterId || null;
  if (matterId) {
    // The tagged matter could belong to whichever of the uid's associations in
    // this firm (e.g. Jane's personal matter vs. an Acme matter), so the check
    // unions matterIds across all of them rather than picking one.
    const matterIds = await resolveMatterIdsAcrossAssociations(lawFirmId, associations, clientUserId);
    if (!matterIds.includes(matterId)) {
      throw new ForbiddenError('Access denied: You do not have access to this matter');
    }
  }

  // Delegate to the messaging service. It lazily upserts the (firm, client)
  // conversation, inserts the message and bumps last-message metadata.
  const result = await messagingService.sendMessage({
    lawFirmId,
    userId: clientUserId,
    body: { clientId: clientUserId, content, matterId, attachments },
  });

  return {
    message: 'Message sent successfully',
    messageId: result.messageId,
    conversationId: result.conversationId,
  };
}

export async function getPortalUnreadCount({ clientUserId, userData }: any) {
  await loadUserData(clientUserId, userData);

  // Unread counts are derived per-conversation from message read flags. Direct
  // threads are one per firm; group threads (a company's canonical conversation
  // per company association, plus any ad-hoc group) are read alongside them so a
  // company-roster-only client - who may have no direct thread at all - isn't
  // undercounted here. This mirrors messagingService.getClientUnreadCount, which
  // the portal sidebar badge itself already reads (direct + group); this
  // aggregate additionally breaks the total down per firm for the dashboard's
  // per-firm badges, so it stays a separate read rather than delegating to that.
  const [directConversations, { conversations: groupConversations }] = await Promise.all([
    messagingRepo.getConversationsByClient(clientUserId),
    messagingRepo.getGroupConversationsForUser(clientUserId),
  ]);

  let totalUnread = 0;
  const unreadByFirm: Record<string, any> = {};

  for (const conv of directConversations) {
    const unread = Math.max(0, Math.trunc(toNumber(conv.unreadCountClient)));
    unreadByFirm[conv.lawFirmId] = (unreadByFirm[conv.lawFirmId] || 0) + unread;
    totalUnread += unread;
  }
  for (const conv of groupConversations) {
    const unread = Math.max(0, Math.trunc(toNumber(conv.unreadCount)));
    unreadByFirm[conv.lawFirmId] = (unreadByFirm[conv.lawFirmId] || 0) + unread;
    totalUnread += unread;
  }

  return {
    totalUnread,
    unreadByFirm,
  };
}

// The portal agenda shows what is coming up, not the matter's whole schedule. The
// ceiling is reported so the page can say the list is partial rather than implying
// it is complete.
const PORTAL_EVENT_LIMIT = 500;

export async function listPortalEvents(
  { lawFirmId, clientUserId, userData, matterId = null, clientRecordId, timeZone }: any,
) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  if (matterId) ensureMatterAccess(context, matterId);
  const todayAnchorIso = dayAnchor(await personalToday({ timeZone, userId: clientUserId })).toISOString();

  // One matter's agenda is read as one matter, not as the firm-wide list narrowed
  // afterwards: the ceiling applies to whatever set is queried, so a client with a
  // busy schedule elsewhere would otherwise see a matter's events pushed out of it.
  const matterIds = matterId ? [matterId] : context.matterIds;

  // Only client-visible, non-cancelled, upcoming matter events across the client's
  // matters, filtered + date-ordered + capped in a single SQL query (was a
  // per-matter N+1). One row beyond the ceiling is read purely to tell a full page
  // apart from a genuinely truncated one, then discarded.
  const rows = await matterEventsRepo.findUpcomingVisibleForMatters(
    lawFirmId, matterIds, new Date().toISOString(), { limit: PORTAL_EVENT_LIMIT + 1, todayAnchorIso, clientRecordId: matterId ? null : context.clientRecordId }
  );
  const truncated = rows.length > PORTAL_EVENT_LIMIT;
  const events = (truncated ? rows.slice(0, PORTAL_EVENT_LIMIT) : rows).map((e: any) => ({
    id: e.id,
    matterId: e.matterId,
    clientId: e.clientId || null,
    type: e.type || null,
    title: e.title || null,
    date: e.date,
    // True when the event is a day, not a moment: `date` is its noon-UTC anchor.
    allDay: e.allDay === true,
    description: e.clientDescription || null,
    endsAt: rowIso(e.endsAt),
    timeZone: e.timeZone || null,
    location: e.location || e.locationName || null,
  }));
  return { events, totalEvents: events.length, truncated };
}

export async function getClientDashboard({ lawFirmId, clientUserId, userData, clientRecordId, timeZone }: any) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  const today = await personalToday({ timeZone, userId: clientUserId });
  // The dashboard is a combined matters+billing view, not a dedicated billing
  // route: a company roster user without canViewBilling still gets their
  // matters, just with billing data omitted rather than the whole dashboard
  // refused. "Hidden UI is not authorization" cuts the other way too - the
  // backend must not SEND the billing data at all, not just expect the
  // frontend to hide it.
  const [matters, billing] = await Promise.all([
    buildPortalMatters(context, lawFirmId),
    context.canViewBilling
      ? buildPortalBilling(context, lawFirmId, { today })
      : Promise.resolve({ invoices: [], summary: { totalBilled: 0, totalPaid: 0, totalOutstanding: 0 } }),
  ]);

  let profile: any = {
    id: context.clientRecordId,
    userId: context.clientUserId,
    email: context.userData.email || null,
    matterIds: context.matterIds,
  };

  if (context.clientRecord) {
    // The access context already loaded + authorized this client row, so enrich it
    // directly, avoiding the redundant getClientOrThrow re-fetch getClient would run.
    const enriched = await clientsService
      .enrichClientWithUserData(context.clientRecord)
      .catch(() => null);
    const src = enriched || context.clientRecord;
    // Whitelist display-safe fields only. The raw client row carries firm-internal
    // columns (billing_rates, stripe_customer_id, invited_by,
    // settings) that must never be exposed to the portal client.
    profile = {
      id: src.id ?? profile.id,
      userId: src.userId ?? profile.userId,
      name: src.name || null,
      email: src.email || profile.email,
      phone: src.phone || null,
      organization: src.organization || null,
      address: src.address || null,
      preferredContactMethod: src.preferredContactMethod || null,
      status: src.status || null,
      matterIds: context.matterIds,
    };
  }

  // `notes` are firm-internal annotations (no client_visible flag, authored
  // only by firm members) and must never be returned to the portal. Always [].
  return {
    profile,
    notes: [],
    matters,
    invoices: billing.invoices,
    billingSummary: billing.summary,
  };
}

/**
 * The invoice a portal client may pay online, with the billing context it lives
 * in. Shared by the pay link and the payment options quote, so both answer the
 * same caller about the same invoice.
 */
async function resolvePortalPayableInvoice(
  { lawFirmId, invoiceId, clientUserId, userData, clientRecordId }: any,
) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  assertCanViewBilling(context);

  if (!isUuid(invoiceId)) throw new NotFoundError('Invoice');

  // Resolve the invoice's context in one query (was a per-matter findById loop),
  // then load + ownership-verify it once. The invoice must belong to one of the
  // client's accessible matters, or be a direct invoice on the client's own record.
  const rows = await tenantQuery(invoices, lawFirmId, ({ executor, scope }) => executor
    .select({ matterId: invoices.matterId, clientContextId: invoices.clientContextId })
    .from(invoices).where(and(scope, eq(invoices.id, invoiceId))).limit(1));
  if (!rows.length) throw new NotFoundError('Invoice');

  const { matterId: invoiceMatterId, clientContextId: invoiceClientId } = rows[0];

  let foundInvoice = null;
  let foundContextType = null;
  let foundEntityId = null;

  if (invoiceMatterId) {
    // Matter invoice: caller must have access to that matter and own the invoice.
    if (context.matterIds.includes(invoiceMatterId)) {
      const invoice = await invoicesRepo.findById(
        { type: CONTEXT_TYPES.matter, lawFirmId, entityId: invoiceMatterId },
        invoiceId,
      );
      if (invoice) {
        const matterClientDocIds = await findMatterClientDocIds({
          lawFirmId,
          matterId: invoiceMatterId,
          clientUserId: context.clientUserId,
          clientEmail: context.clientEmail,
        });
        if (invoiceBelongsToClient(invoice, {
          clientRecordId: context.clientRecordId,
          clientEmail: context.clientEmail,
          matterClientDocIds,
        })) {
          foundInvoice = invoice;
          foundContextType = CONTEXT_TYPES.matter;
          foundEntityId = invoiceMatterId;
        }
      }
    }
  } else if (invoiceClientId && invoiceClientId === context.clientRecordId) {
    // Client-direct invoice on this client's own record.
    const invoice = await invoicesRepo.findById(
      { type: CONTEXT_TYPES.client, lawFirmId, entityId: context.clientRecordId },
      invoiceId,
    );
    if (invoice) {
      foundInvoice = invoice;
      foundContextType = CONTEXT_TYPES.client;
      foundEntityId = context.clientRecordId;
    }
  }

  if (!foundInvoice) throw new NotFoundError('Invoice');
  // Refused here, ahead of the Stripe configuration check, so the answer does
  // not depend on the environment.
  assertInvoiceNotVoided(foundInvoice, 'pay it online');

  return { context, invoice: foundInvoice, contextType: foundContextType, entityId: foundEntityId };
}

export async function getPaymentCheckoutUrl(
  { lawFirmId, invoiceId, clientUserId, userData, clientRecordId, method = null }: any,
) {
  const { context, contextType, entityId } = await resolvePortalPayableInvoice({
    lawFirmId, invoiceId, clientUserId, userData, clientRecordId,
  });
  // Refused here, before any Stripe work. A missing method is left to the
  // checkout, which refuses it.
  if (method != null && !PAYMENT_METHOD_KINDS.includes(method)) {
    throw new ValidationError({ method: ['Choose card or bank transfer'] });
  }
  const stripeService = require('../../stripe/stripe.service');

  return stripeService.getClientCheckoutUrl({
    lawFirmId,
    invoiceId,
    contextType,
    entityId,
    clientId: context.clientRecordId,
    clientUserId: context.clientUserId,
    clientEmail: context.clientEmail || context.userData?.email,
    clientName: context.userData?.name || context.userData?.displayName,
    method,
  });
}

/**
 * What paying this invoice online costs by each method, for the portal's
 * method chooser: the amount the payment request asks for (the full balance,
 * or one installment capped at it) and who pays each fee on this invoice.
 * Touches no Stripe object.
 */
export async function getPaymentOptions(
  { lawFirmId, invoiceId, clientUserId, userData, clientRecordId }: any,
) {
  const { invoice } = await resolvePortalPayableInvoice({
    lawFirmId, invoiceId, clientUserId, userData, clientRecordId,
  });
  const requested = payLinkRequest(invoice);
  // An installment request whose row was paid another way or left the plan has
  // nothing to collect; the checkout refuses it the same way.
  if (requested.installmentId && !requested.isPayable) {
    throw new ValidationError({ invoice: ['This installment is no longer due. Please refresh the page.'] });
  }
  const invoiceCents = requested.requestedCents;
  return {
    invoiceCents,
    // How a card payment is taken: hosted checkout, or the card form when the
    // client pays a card fee that depends on the card.
    card: await cardSetupFor(lawFirmId, invoice, invoiceCents),
    methods: PAYMENT_METHOD_KINDS.map((method) => {
      // A card fee depends on the card, so the card option shows no fee and
      // the card form shows the exact amount once the card is entered.
      if (method === 'card') return { method, feeCents: 0, totalCents: invoiceCents };
      const feeCents = invoice.isBankFeePassedOn ? clientSurchargeCents('bank', invoiceCents) : 0;
      return { method, feeCents, totalCents: invoiceCents + feeCents };
    }),
  };
}

/** What the card the client entered pays on this invoice. Creates nothing in Stripe. */
export async function quotePortalCard(
  { lawFirmId, invoiceId, clientUserId, userData, clientRecordId, confirmationTokenId }: any,
) {
  const { invoice } = await resolvePortalPayableInvoice({ lawFirmId, invoiceId, clientUserId, userData, clientRecordId });
  return quoteCardPayment({ lawFirmId, invoice, confirmationTokenId });
}

/** Charge the card for the total the client was shown, returning to their billing page. */
export async function confirmPortalCard(
  { lawFirmId, invoiceId, clientUserId, userData, clientRecordId, confirmationTokenId, expectedTotalCents }: any,
) {
  const { context, contextType, entityId } = await resolvePortalPayableInvoice({
    lawFirmId, invoiceId, clientUserId, userData, clientRecordId,
  });
  return confirmCardPayment({
    lawFirmId,
    invoiceId,
    context: { type: contextType, lawFirmId, entityId },
    confirmationTokenId,
    expectedTotalCents,
    clientId: context.clientRecordId,
    clientUserId: context.clientUserId,
    payLinkToken: null,
    // Where hosted checkout returns a portal client after paying.
    returnUrl: `${FRONTEND_URL}/client/lawfirm/${lawFirmId}/billing?payment=success`,
  });
}

/** Record a card payment after the client's bank verified it. */
export async function completePortalCard(
  { lawFirmId, invoiceId, clientUserId, userData, clientRecordId, paymentIntentId }: any,
) {
  const { invoice } = await resolvePortalPayableInvoice({ lawFirmId, invoiceId, clientUserId, userData, clientRecordId });
  return completeCardPayment({ lawFirmId, invoice, paymentIntentId });
}

// ── Trust Accounting (client-facing) ──────────────────────────────

/**
 * Apply a firm's plan ceiling to a portal read.
 *
 * The firm-side routers gate these features with `requireFeature`, which resolves
 * the caller as a MEMBER and therefore no-ops for a portal client. Without this,
 * a firm on a plan without trust accounting kept serving its clients ledger data
 * through the portal that the firm itself could no longer open.
 *
 * Call AFTER the access context resolves: the 403 names which features the firm's
 * plan includes, so it must only ever be answered to a client of that firm.
 */
async function assertPortalFeature(lawFirmId: string, feature: string) {
  await enforceFeatureAccess(lawFirmId, feature);
}

export async function getPortalTrustBalance({ lawFirmId, clientUserId, userData, clientRecordId }: any) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  assertCanViewBilling(context);
  await assertPortalFeature(lawFirmId, 'trustAccounting');
  const trustService = require('../../trust/trust.service');
  return trustService.getClientBalanceForPortal({
    lawFirmId,
    clientId: context.clientRecordId,
  });
}

export async function getPortalTrustLedger(
  { lawFirmId, clientUserId, userData, limit, offset, clientRecordId }: any,
) {
  const context = await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  assertCanViewBilling(context);
  await assertPortalFeature(lawFirmId, 'trustAccounting');
  const trustService = require('../../trust/trust.service');
  const result = await trustService.getClientLedgerForPortal({
    lawFirmId,
    clientId: context.clientRecordId,
    limit,
    offset,
  });

  // Filter out internal fields clients shouldn't see
  const transactions = (result.transactions || []).map((txn: any) => ({
    id: txn.id,
    type: txn.type,
    amountCents: txn.amountCents,
    date: txn.date,
    description: txn.description || '',
    status: txn.status,
    clientBalanceAfter: txn.clientBalanceAfter,
    createdAt: txn.createdAt,
  }));

  // Surface totalItems so the client UI can paginate the (potentially >100-row)
  // ledger. Without it the portal silently truncated at the repo's default page.
  return { transactions, totalItems: result.totalItems };
}

/**
 * Mark a conversation read for the portal client. `body.conversationId` picks
 * WHICH one, mirroring listPortalMessages/sendPortalMessage: omitted, this is
 * the client's own direct thread and `messageIds` marks those specific
 * messages read (unchanged contract). Given a GROUP thread's id, this
 * advances that thread's per-participant read cursor instead - group read
 * state is a cursor (`conversation_participants.last_read_at`), not
 * per-message flags, so `messageIds` (meaningful only for the direct thread)
 * is accepted but not used on this path.
 */
export async function markPortalMessagesRead({ lawFirmId, clientUserId, userData, body }: any) {
  // Prove SOME association with this firm before anything reads a caller-supplied
  // id, matching listPortalMessages and sendPortalMessage.
  //
  // This handler used to skip the check entirely. Nothing leaked and nothing was
  // written, because the conversation is resolved from the caller's own uid, but
  // `resolvePortalConversationTarget` below runs FIRST on the id the caller sent
  // and answers differently per case: 404 when no such conversation exists, 403
  // when it belongs to a different firm, and a fall-through 200 when it belongs
  // to the firm in the URL. That is a conversation-id existence and tenancy
  // oracle for a portal client with no association to the firm at all. The
  // router-level gate does not cover it: that only resolves an association when
  // the firm's billing is inactive or the portal feature is off, so for a healthy
  // firm the handler was reachable by any signed-in portal client naming any
  // firm id.
  await assertPortalFirmAssociation({ lawFirmId, clientUserId, userData });

  const { messageIds, conversationId } = body;

  if (conversationId) {
    const target = await resolvePortalConversationTarget({ lawFirmId, conversationId });
    if (target.kind === 'group') {
      // markGroupRead itself asserts active participation (Forbidden if the
      // caller isn't one).
      return messagingService.markGroupRead({ conversationId, userId: clientUserId });
    }
  }

  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return { message: 'No messages to mark', markedCount: 0 };
  }
  // Resolve the relational conversation uuid for this (firm, client) pair; the
  // legacy `${lawFirmId}_${clientUserId}` string id is no longer the key.
  const conversation = await findPortalConversation(lawFirmId, clientUserId);
  if (!conversation) {
    return { message: 'No messages to mark', markedCount: 0 };
  }
  if (conversationId && conversation.conversationId !== conversationId) {
    throw new ForbiddenError('Access denied to conversation');
  }
  return messagingService.markRead({
    userId: clientUserId,
    body: { conversationId: conversation.conversationId, messageIds },
  });
}

// ── Portal settings (the client's OWN notification/communication/portal prefs) ──
// Scoped to the authenticated client's resolved active association.
// getActiveClientAccessContext throws if they aren't associated with the firm
// (or requires a selection when ambiguous), and the settings target is derived
// from the RESOLVED association (never a client-supplied id), so a portal user
// can only read/write their own settings.
//
// Storage (post client_company_links migration): preferences always live on
// the PERSON's own `clients.settings`, never on the active association's
// `clientRecordId` - for a company association that id is the COMPANY's
// clients row, which is shared across everyone linked to it. A company-linked
// uid always has its own standalone Person `clients` row now (that's how the
// company arm of association resolution finds it in the first place), so
// `clientsRepo.findByUserId` reliably resolves it regardless of which
// association is currently active. This intentionally means a person linked
// to N companies shares one settings blob across all of them - the same
// simplification `clientAssociation.resolver.ts`'s `portalSettings` field
// already makes for reads.
export async function getPortalSettings({ lawFirmId, clientUserId, userData, clientRecordId }: any) {
  await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  const personClient = await clientsRepo.findByUserId(lawFirmId, clientUserId);
  if (!personClient) throw new NotFoundError('Client record');
  const settings = await settingsService.getClientSettings({
    lawFirmId,
    clientId: personClient.id,
  });
  return { settings };
}

export async function updatePortalSettings({ lawFirmId, clientUserId, userData, body, clientRecordId }: any) {
  await getActiveClientAccessContext({ lawFirmId, clientUserId, userData, clientRecordId });
  const personClient = await clientsRepo.findByUserId(lawFirmId, clientUserId);
  if (!personClient) throw new NotFoundError('Client record');
  const settings = (body && body.settings) ? body.settings : (body || {});
  await settingsService.updateClientSettings({
    lawFirmId,
    clientId: personClient.id,
    settings,
  });
  return { message: 'Settings updated' };
}

// ── Client-facing in-app notifications (the portal bell) ─────────────
// The `notifications` table is shared with the firm side; these read/write only
// the calling client's own rows (user_id = the portal client's uid). This is a
// UID-owned feed (the Portal selection contract's carve-out: "UID-owned feeds
// such as notifications remain user-scoped"), so it only needs to prove SOME
// association with the firm, not select one active client record.

function formatClientNotification(n: any) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    read: n.read || false,
    entityType: n.entityType || null,
    matterId: n.matterId || null,
    actionUrl: n.actionUrl || null,
    createdAt: n.createdAt || null,
  };
}

export async function listClientNotifications({ lawFirmId, clientUserId, userData, unreadOnly, limit, before, beforeId }: any) {
  await assertPortalFirmAssociation({ lawFirmId, clientUserId, userData });
  const capped = Math.min(Number(limit) || 30, 100);
  const [raw, unreadCount] = await Promise.all([
    notificationsRepo.findForUser(lawFirmId, clientUserId, {
      unreadOnly: unreadOnly === true || unreadOnly === 'true',
      limit: capped,
      before: before || null,
      beforeId: beforeId || null,
    }),
    notificationsRepo.countUnread(lawFirmId, clientUserId),
  ]);
  const last = raw[raw.length - 1];
  const hasMore = raw.length === capped;
  return {
    notifications: raw.map(formatClientNotification),
    unreadCount,
    // Composite cursor matching the (created_at desc, id desc) sort, so rows
    // sharing a timestamp can't be skipped across a page boundary. `cursorAt`
    // is the microsecond-precise render of the column; `createdAt` is the
    // millisecond display value and truncating it skipped rows. See CURSOR_AT
    // in notifications.repository.
    nextBefore: hasMore ? last.cursorAt : null,
    nextBeforeId: hasMore ? last.id : null,
  };
}

export async function markClientNotificationRead({ lawFirmId, clientUserId, userData, notificationId }: any) {
  await assertPortalFirmAssociation({ lawFirmId, clientUserId, userData });
  await notificationsRepo.markRead(lawFirmId, clientUserId, notificationId);
  return { message: 'Notification marked as read' };
}

export async function markAllClientNotificationsRead({ lawFirmId, clientUserId, userData }: any) {
  await assertPortalFirmAssociation({ lawFirmId, clientUserId, userData });
  const updated = await notificationsRepo.markAllRead(lawFirmId, clientUserId);
  return { message: 'All notifications marked as read', updated };
}

/**
 * Stamp an `isNew` flag on each document the client hasn't opened yet. A document
 * is "new" until the client downloads it (recorded via refreshDocumentDownloadUrl).
 * Folders are never badged. Best-effort: any failure leaves everything unbadged.
 */
async function annotateNewFlags(lawFirmId: string, clientUserId: string, documents: any) {
  if (!Array.isArray(documents) || !documents.length || !clientUserId) return documents;
  try {
    const ids = documents.map((d) => d.id).filter(Boolean);
    const seen = await documentViewsRepo.getSeenFileIds(lawFirmId, clientUserId, ids);
    for (const d of documents) d.isNew = !!d.id && !seen.has(d.id);
  } catch (err: any) {
    console.error('portal.service: annotateNewFlags failed:', err.message);
  }
  return documents;
}

/**
 * Drop every memoized portal access context. Exported for the in-process test
 * suite for the same reason as `__resetAssociationCaches`: a spec grants or
 * revokes access and asserts within milliseconds, well inside the TTL that makes
 * this cache correct in production. No production caller.
 */
export function __resetAccessContextCache(): void {
  activeAccessContextCache.clear();
}
