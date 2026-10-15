const crypto = require('crypto');
const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const { logger } = require('./shared/utils/logger');
const { AppError } = require('./shared/errors/AppError');
const { errorHandler } = require('./shared/middleware/errorHandler');
const { maintenanceMode } = require('./shared/middleware/maintenanceMode');
const { requestTimeout } = require('./shared/middleware/requestTimeout');
const { requestContext } = require('./shared/utils/requestContext');
const { redactSecretPath } = require('./shared/utils/redactSecretPath');
const { requireFeature } = require('./shared/plans/requireFeature');
const { requireActiveBilling } = require('./shared/plans/requireActiveBilling');
const { verifyToken } = require('./shared/middleware/auth');
const { globalApiLimiter } = require('./shared/middleware/rateLimiters');
const { SIGNING_COMPLETION_BODY_LIMIT } = require('./modules/signatures/signing.validation');

// New module routes (Phase 1: Lawfirms & RBAC)
const lawfirmsModuleRoutes = require('./modules/lawfirms/lawfirms.routes');
const membersModuleRoutes = require('./modules/lawfirms/members/members.routes');
const rolesModuleRoutes = require('./modules/lawfirms/roles/roles.routes');

// New module routes (Phase 2: Tasks)
const tasksModuleRoutes = require('./modules/tasks/tasks.routes');
const taskNotesModuleRoutes = require('./modules/tasks/notes/taskNotes.routes');
const taskSubtasksModuleRoutes = require('./modules/tasks/subtasks/taskSubtasks.routes');

// New module routes (Phase 3: Calendar)
const googleCalendarModuleRoutes = require('./modules/calendar/google/google.routes');
const googleCalendarWebhookRoutes = require('./modules/calendar/google/google.webhook.routes');
const outlookCalendarModuleRoutes = require('./modules/calendar/outlook/outlook.routes');
const calendarEventsRoutes = require('./modules/calendar/calendarEvents.routes');
const calendarFeedRoutes = require('./modules/calendar/calendarFeed.routes');
const outlookCalendarWebhookRoutes = require('./modules/calendar/outlook/outlook.webhook.routes');

// New module routes (Phase 4: Matters)
const mattersModuleRoutes = require('./modules/matters/matters.routes');
const matterCategoriesModuleRoutes = require('./modules/matters/categories/matterCategories.routes');
const matterMembersModuleRoutes = require('./modules/matters/members/matterMembers.routes');
const matterClientsModuleRoutes = require('./modules/matters/clients/matterClients.routes');
const matterNotesModuleRoutes = require('./modules/matters/notes/matterNotes.routes');
const firmNotesModuleRoutes = require('./modules/matters/notes/firmNotes.routes');
const matterContactsModuleRoutes = require('./modules/matters/contacts/matterContacts.routes');
const matterFieldDefsModuleRoutes = require('./modules/matters/fields/matterFields.routes');
const matterStagesModuleRoutes = require('./modules/matters/stages/matterStages.routes');
const matterStagePipelinesModuleRoutes = require('./modules/matters/pipelines/matterStagePipelines.routes');
const deadlineSetsModuleRoutes = require('./modules/matters/deadlineSets/deadlineSets.routes');

// New module routes (Phase 5: Billing)
const billingTimeEntriesRoutes = require('./modules/billing/timeEntries/timeEntries.routes');
const billingInvoicesRoutes = require('./modules/billing/invoices/invoices.routes');
const billingFlatFeesRoutes = require('./modules/billing/flatFees/flatFees.routes');
const billingChargeCodesRoutes = require('./modules/billing/chargeCodes/chargeCodes.routes');
const billingAnalyticsRoutes = require('./modules/billing/analytics/billingAnalytics.routes');
const billingReportsRoutes = require('./modules/billing/reports/billingReports.routes');
const billingPlansRoutes = require('./modules/billing/plans/plans.routes');
const billingWorkbenchRoutes = require('./modules/billing/shared/workbench.routes');
const billingExpensesRoutes = require('./modules/billing/expenses/expenses.routes');
const billingExpenseCategoriesRoutes = require('./modules/billing/expenseCategories/expenseCategories.routes');

// New module routes (Phase 6: Clients)
const clientsModuleRoutes = require('./modules/clients/clients.routes');
const clientNotesModuleRoutes = require('./modules/clients/notes/clientNotes.routes');
const clientPortalModuleRoutes = require('./modules/clients/portal/portal.routes');
const clientIdentityVerificationRoutes = require('./modules/identityVerification/identityVerification.routes');

// New module routes (Phase 7: Files)
const filesModuleRoutes = require('./modules/files/files.routes');

// New module routes (Phase 8: Settings)
const settingsModuleRoutes = require('./modules/settings/settings.routes');

// New module routes (Phase 9: Auth, Users, Messaging, Invitations, Practice Areas)
const authModuleRoutes = require('./modules/auth/auth.routes');
const usersModuleRoutes = require('./modules/users/users.routes');
const messagingModuleRoutes = require('./modules/messaging/messaging.routes');
const invitationsModuleRoutes = require('./modules/invitations/invitations.routes');
const invitationAcceptRoutes = require('./modules/invitations/invitationAccept.routes');
const practiceAreasModuleRoutes = require('./modules/practiceAreas/practiceAreas.routes');
const noteTypesModuleRoutes = require('./modules/noteTypes/noteTypes.routes');
const noteTemplatesModuleRoutes = require('./modules/noteTemplates/noteTemplates.routes');
const adminModuleRoutes = require('./modules/admin/admin.routes');

// New module routes (Phase 10: Stripe)
const stripeWebhookRoutes = require('./modules/stripe/stripe.webhook.routes');
const stripeModuleRoutes = require('./modules/stripe/stripe.routes');

// New module routes (Phase 11: Signatures)
const signaturesModuleRoutes = require('./modules/signatures/signatures.routes');
const signatureLinksRoutes = require('./modules/signatures/signatureLinks.routes');
const signingRoutes = require('./modules/signatures/signing.routes');
const signingTemplatesRoutes = require('./modules/signatures/signingTemplates.routes');

// New module routes (Phase 12: Trust Accounting)
const trustModuleRoutes = require('./modules/trust/trust.routes');

// New module routes (Phase 13: Courts)
const courtsModuleRoutes = require('./modules/courts/courts.routes');

// Document requests: firm-posted checklists clients fulfill by uploading documents.
const documentRequestsModuleRoutes = require('./modules/documentRequests/documentRequests.routes');

// Document request templates: firm-level reusable presets for document requests.
const documentRequestTemplatesModuleRoutes = require('./modules/documentRequests/templates/documentRequestTemplates.routes');

// Secure external file share links: authed create/list/revoke + a PUBLIC resolver.
const fileShareLinksRoutes = require('./modules/files/shareLinks.routes');
const publicShareRoutes = require('./modules/share/share.routes');
const publicPayLinkRoutes = require('./modules/stripe/payLink.routes');

// Reference-data catalog (global court_catalog + utbms_codes; copy-on-adopt)
const catalogModuleRoutes = require('./modules/catalog/catalog.routes');

// New module routes (Phase 15: Notifications)
const notificationsModuleRoutes = require('./modules/notifications/notifications.routes');

// New module routes (Phase 17: Subscriptions)
const subscriptionModuleRoutes = require('./modules/subscriptions/subscriptions.routes');
const subscriptionWebhookRoutes = require('./modules/subscriptions/subscriptions.webhook.routes');

// New module routes (Phase 18: Dashboard summary)
const dashboardModuleRoutes = require('./modules/dashboard/dashboard.routes');

// New module routes (Phase 19: Contact directory)
const contactsModuleRoutes = require('./modules/contacts/contacts.routes');

// New module routes (Phase 20: Leads pipeline + intake forms)
const leadsModuleRoutes = require('./modules/leads/leads.routes');
const leadStagesModuleRoutes = require('./modules/leads/stages/leadStages.routes');
const intakeFormsModuleRoutes = require('./modules/leads/intakeForms.routes');
const intakeRoutes = require('./modules/intake/intake.routes');

// New module routes (Phase 14: Templates)
const templateFoldersModuleRoutes = require('./modules/templates/folders/templateFolders.routes');
const templatesModuleRoutes = require('./modules/templates/templates.routes');
const wordTemplatesModuleRoutes = require('./modules/wordTemplates/wordTemplates.routes');

// Audit log (security/data-access events) + privacy/data-subject rights
const { auditMutations } = require('./modules/audit/audit.middleware');
const auditRoutes = require('./modules/audit/audit.routes');
const privacyRoutes = require('./modules/privacy/privacy.routes');

// Register event listeners
require('./modules/lawfirms/lawfirms.events');
require('./modules/lawfirms/roles/permissionCache.events');
require('./modules/tasks/tasks.events');
require('./modules/calendar/calendar.events');
require('./modules/matters/matters.events');
require('./modules/matters/notes/matterNotes.events');
require('./modules/billing/billing.events');
require('./modules/billing/plans/plans.events');
require('./modules/clients/clients.events');
require('./modules/identityVerification/identityVerification.events');
require('./modules/leads/leads.events');
require('./modules/files/files.events');
require('./modules/signatures/signatures.events');
require('./modules/documentRequests/documentRequests.events');
require('./modules/stripe/stripe.events');
require('./modules/trust/trust.events');
require('./modules/subscriptions/subscriptions.events');
require('./modules/notifications/notifications.events');
require('./modules/messaging/messaging.events');

// Durability backstop: start the event-outbox worker. No-op unless
// EVENT_OUTBOX_WORKER === 'true': keeps default behavior byte-identical.
require('./shared/events/eventOutbox').startOutboxWorker();

const app = express();
// Number of trusted reverse-proxy hops in front of the app. Bounding this keeps
// the forwarded client IP from being spoofable (which would weaken IP-keyed rate
// limiting and the IP recorded in signing audit events). Cloud Run sits behind a
// single Google front-end hop, hence the default of 1.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

function timingSafeMatch(candidate: any, expected: any) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  // crypto.timingSafeEqual THROWS on buffers of unequal length, so this guard is
  // what turns a wrong-length secret into a clean refusal instead of a 500.
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
}

/**
 * The only NODE_ENV values in which a missing CRON_SECRET may still be worked
 * around by a developer on their own machine.
 *
 * An explicit allowlist, never `!== 'production'`. NODE_ENV is set per
 * deployment, so under a negative test every name nobody thought of is on the
 * permissive side: 'staging', 'preview', a typo of 'production', and an unset
 * value most of all. Naming the two local environments puts the unknown cases
 * where they belong.
 */
const CRON_LOCAL_ENVS = new Set(['test', 'development']);

/** Loopback peers, in the forms Node reports `socket.remoteAddress`. */
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Did this request come from a process on this same machine?
 *
 * Read off `req.socket.remoteAddress`, deliberately, and NOT `req.ip`. `req.ip`
 * is derived from `X-Forwarded-For` under `app.set('trust proxy', ...)` above,
 * which makes it a value the caller writes; the socket address is the peer the
 * kernel accepted the connection from, and no header can move it. A gate
 * written against `req.ip` would be satisfied by an attacker sending
 * `X-Forwarded-For: 127.0.0.1`.
 *
 * A forwarding header is then disqualifying on its own. The point of this check
 * is "a developer at this keyboard", not "a packet that arrived on lo": a
 * request that reached a loopback socket carrying a forwarding chain was
 * relayed here by something else, whether a reverse proxy in front of the dev
 * server or an SSRF hop out of this very app, and its real origin is not this
 * machine.
 */
function isLoopbackRequest(req: any) {
  if (req.headers['x-forwarded-for'] || req.headers.forwarded) return false;
  return LOOPBACK_PEERS.has(req.socket?.remoteAddress);
}

function authorizeCronRequest(req: any, res: any, next: any) {
  const configuredSecret = process.env.CRON_SECRET;
  const bearerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice('Bearer '.length)
    : null;
  const headerSecret = typeof req.headers['x-cron-secret'] === 'string'
    ? req.headers['x-cron-secret']
    : null;

  if (configuredSecret) {
    if (
      timingSafeMatch(bearerToken, configuredSecret)
      || timingSafeMatch(headerSecret, configuredSecret)
    ) {
      return next();
    }

    return res.status(403).json({ error: 'Forbidden' });
  }

  // No secret configured. This used to accept a bare `x-cloudscheduler: true`
  // header on anything whose NODE_ENV was merely not the string 'production',
  // which made a header any caller can send the entire authorization for jobs
  // that move money (reconcile-billing, reconcile-trust-deposits,
  // trust-fee-sweep) and mail every client (reminders, digest). The container
  // defaults NODE_ENV=production, so the door only stood open where that default
  // was overridden or the app ran outside the image -- which is to say the
  // safety of the money movers rested on nobody making a deployment mistake.
  //
  // A deployed environment now always needs CRON_SECRET. What is left is a
  // developer poking their own process, and it needs BOTH an explicitly named
  // local NODE_ENV and a connection from this machine's own loopback interface.
  // The two are redundant on purpose: either one alone already closes every
  // deployment, so an environment named 'staging', or one that forgot to set
  // NODE_ENV at all, fails closed instead of open. That redundancy is also what
  // makes the remaining hatch no weaker than the secret it replaces, since a
  // caller who can already open a loopback socket on the box can read
  // CRON_SECRET out of the environment anyway.
  //
  // This is the same rule the CORS fallback below follows: when configuration is
  // missing, the default is the safe posture, not the convenient one.
  if (
    CRON_LOCAL_ENVS.has(process.env.NODE_ENV as string)
    && isLoopbackRequest(req)
    && req.headers['x-cloudscheduler'] === 'true'
  ) {
    return next();
  }

  return res.status(503).json({ error: 'Cron authorization is not configured' });
}

/**
 * Longest a single cron pass may hold its lock.
 *
 * Comfortably above the cron budgets in `reminderHelpers.ts` (150s, and 240s
 * for the passes that cannot resume) so a pass that legitimately
 * uses its whole budget is never cut off, and finite so a pass wedged on an
 * unresponsive third party eventually releases instead of blocking every later
 * run. It is the lease length of the pass's `lock_leases` row; the lock holds no
 * pool connection while the pass runs.
 */
const CRON_LOCK_MAX_HOLD_MS = Number(process.env.CRON_LOCK_MAX_HOLD_MS) || 600_000;

/**
 * Wrap a cron pass so only one run of it executes at a time, platform-wide.
 *
 * Cloud Scheduler is at-least-once and retries on failure or timeout, and every
 * pass here may legitimately run for its whole wall-clock budget, so a retry can
 * start while the previous attempt is still working at any instance count.
 * Overlap is not harmless here: `forEachFirm` reads a persisted
 * rotation cursor and writes it back only at the end of a pass, so two runs read
 * the same cursor, process the same firms, and the later finisher's write wins —
 * silently skipping the tail of firms the fairness mechanism exists to serve.
 * Recurring-task spawning, task reminder emails, and Google watch-channel
 * renewal each duplicate their effect the same way.
 *
 * `run` returns the body fields for a successful pass; `status` is added here so
 * every pass reports the same envelope.
 *
 * A skipped run answers **200**, deliberately. A non-2xx would make Cloud
 * Scheduler retry, which is precisely the wrong response to "someone else is
 * already doing this".
 */
function runCronPass(passName: any, run: any) {
  return (req: any, res: any, next: any) => {
    const { tryLock } = require('./shared/database/advisoryLock');
    tryLock('CRON_PASS', passName, run, { maxHoldMs: CRON_LOCK_MAX_HOLD_MS })
      .then((outcome: any) => {
        if (!outcome.acquired) {
          return res.status(200).json({ status: 'skipped', reason: 'already running', pass: passName });
        }
        return res.status(200).json({ status: 'ok', ...outcome.result });
      })
      .catch(next);
  };
}

// --- Middleware ---
// Baseline security headers (HSTS, nosniff, frameguard, referrer policy, etc.).
// CSP is disabled: this is a JSON API + signed-URL redirects, not an HTML origin,
// so a content policy adds no protection and risks breaking download/redirect
// responses. COEP is left off so cross-origin asset embedding isn't disrupted.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// Allowed browser origins. CORS_ORIGINS (comma-separated) overrides per environment;
// falls back to the production defaults when unset. Localhost is only ever added
// to that fallback outside production, so a deploy that forgets to set
// CORS_ORIGINS fails closed to prod origins instead of quietly trusting
// http://localhost with credentials.
const PROD_CORS_ORIGINS = ['https://paralegix.com', 'https://www.paralegix.com'];
const DEFAULT_CORS_ORIGINS = process.env.NODE_ENV === 'production'
  ? PROD_CORS_ORIGINS
  : [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    ...PROD_CORS_ORIGINS,
  ];
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : DEFAULT_CORS_ORIGINS;

app.use(cors({
  origin: corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-timezone'],
  // How long, in seconds, the browser may reuse a preflight answer. Every API
  // call carries Authorization, so without this the browser re-sends OPTIONS
  // before nearly every request. 7200 is Chrome's cap; Firefox caps at 86400.
  maxAge: 7200,
  // Response headers the browser lets frontend JS read cross-origin. Without
  // this, `response.headers.get(...)` returns null for anything outside the CORS
  // safelist: the rate-limit headers (so the UI can show a "try again in Ns"
  // countdown on a 429) and x-request-id (so support can be given an error id).
  exposedHeaders: [
    'Retry-After',
    'RateLimit-Limit',
    'RateLimit-Remaining',
    'RateLimit-Reset',
    'x-request-id',
    // The Word-first template fills list the tags left blank here, and the
    // downloads name their file here.
    'X-Unfilled-Fields',
    'Content-Disposition',
  ],
}));

// Stripe webhooks must receive raw body for signature verification. Mount before express.json()
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookRoutes);
app.use('/api/webhooks/stripe-subscriptions', express.raw({ type: 'application/json' }), subscriptionWebhookRoutes);

// The default ceiling on a parsed JSON body. A parsed body is held whole in
// memory as raw bytes, as a string and as the object it becomes, and this
// container has 512 MiB while serving 80 concurrent requests, so the ceiling is
// multiplied by the concurrency rather than paid once. The previous 50mb let a
// single caller claim a tenth of the container per request on any route in the
// API, including unauthenticated ones. urlencoded never carries a large payload
// at all, so it stays where it was.
const JSON_BODY_LIMIT = '2mb';
const JSON_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

// The routes whose bodies are legitimately a different size from the default.
// Each is mounted AHEAD of the default parser: body-parser compares the declared
// length against its limit before reading the stream, so an oversized body is
// refused with 413 while it is still arriving rather than after it has been
// buffered and parsed. Once one of these has parsed a request, the default
// parser below sees `req._body` and leaves it alone.
//
const JSON_BODY_LIMIT_OVERRIDES = [
  // A signer submits consent plus their own field values, each signature image
  // capped in bytes and in pixels by the route's own validation. TIGHTER than
  // the default: this is the most exposed unauthenticated write in the product.
  {
    match: /^\/api\/signing\/[^/]+\/complete\/?$/,
    limit: SIGNING_COMPLETION_BODY_LIMIT,
  },
  // PDF export sends filled HTML, which the service caps at 1 MB, so it gets the
  // default ceiling back rather than the editor's 50 MB below. Listed first
  // because the first matching entry wins, and the templates pattern matches
  // this path too. Without it, a caller could make the API read 50 MB bodies
  // before the route's size check, rate limit or per-person cap could refuse
  // them.
  {
    match: /^\/api\/lawfirms\/[^/]+\/templates\/[^/]+\/export-pdf\/?$/,
    limit: JSON_BODY_LIMIT,
  },
  // The Word-first library's html export: its service caps the html at 2 MB,
  // so it keeps the default ceiling. Listed before the editor entry below,
  // whose pattern matches this path too.
  {
    match: /^\/api\/lawfirms\/[^/]+\/word-templates\/export\/?$/,
    limit: JSON_BODY_LIMIT,
  },
  // The Word-first editor POSTs and PUTs the whole html body, capped at 5 MB
  // by its service, plus the JSON around it.
  {
    match: /^\/api\/lawfirms\/[^/]+\/word-templates(\/[^/]+)?\/?$/,
    limit: '6mb',
  },
  // The template editor PUTs the whole template body, and an image the author
  // pasted is still a `data:` URL at that point: templates.service extracts it
  // to storage on the way in. Kept at the previous global ceiling so nothing
  // that worked before stops working.
  {
    match: /^\/api\/lawfirms\/[^/]+\/templates(\/|$)/,
    limit: '50mb',
  },
].map((override) => ({ match: override.match, parse: express.json({ limit: override.limit }) }));

app.use((req: any, res: any, next: any) => {
  const path = req.url.split('?')[0];
  const override = JSON_BODY_LIMIT_OVERRIDES.find((entry) => entry.match.test(path));
  if (!override) return next();
  return override.parse(req, res, next);
});
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(maintenanceMode);

// Match a `/lawfirms/<uuid>` segment anywhere in the URL so the request log can
// carry the firm scope even before route params are resolved.
const LOG_LAWFIRM_ID_RE = /\/lawfirms\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

// Routine successful reads dominate request volume but are rarely needed after
// the fact, so none are logged by default; writes, redirects, client errors,
// and server errors are always kept. Tune with LOG_SUCCESS_SAMPLE_RATE
// (1 = log every successful read, 0 = log none, the default in every environment).
const SUCCESS_READ_SAMPLE_RATE = (() => {
  const raw = process.env.LOG_SUCCESS_SAMPLE_RATE;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return 0;
})();
const SAMPLED_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// The URL a request log line names. The full original URL, because a mounted
// router rewrites `req.url` to its own remainder, with a public link's bearer
// token (`/api/pay/<token>`, and the share and intake links) replaced by
// `:token`: the token alone opens the link, and log readers must not be able to.
function loggedUrl(req: any): string {
  return redactSecretPath(String(req.originalUrl || req.url || ''));
}

// Structured request logging. Mounted early so every request gets a request id
// (req.id) and a child logger (req.log). Request bodies are never logged. Actor
// and firm scope are read at response time, once route middleware has populated
// req.user and req.params.
app.use(pinoHttp({
  logger,
  // Reuse an inbound request id if a proxy set one, otherwise mint a uuid so
  // every log line for a request can be correlated.
  genReqId(req: any) {
    const headerId = req.headers['x-request-id'];
    if (typeof headerId === 'string' && headerId) return headerId;
    return crypto.randomUUID();
  },
  // Health probes fire constantly (Cloud Run, CI, uptime checks) and carry no
  // diagnostic value, so they are dropped before ingestion. Calendar push
  // webhooks (Google/Outlook) can be high-frequency per connected user and are
  // routine sync pings, so they are dropped too; sync failures still surface
  // because handler/error logs emit independently of this completion line.
  // Stripe webhooks and cron stay logged: they are rare and billing/ops-critical.
  autoLogging: {
    ignore(req: any) {
      const path = (req.originalUrl || req.url || '').split('?')[0];
      if (path === '/api/health') return true;
      if (path.startsWith('/api/webhooks/google-calendar')) return true;
      if (path.startsWith('/api/webhooks/outlook-calendar')) return true;
      return false;
    },
  },
  // Translate the HTTP outcome into a log level so Cloud Logging severity is
  // meaningful: server/uncaught errors are ERROR, client errors WARNING, and
  // successful or redirect responses INFO. Lets alerts target warn+ without
  // inspecting bodies. Fast successful reads are additionally sampled by
  // demoting the unselected ones to 'silent' (see SUCCESS_READ_SAMPLE_RATE).
  customLogLevel(req: any, res: any, err: any) {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    if (
      SUCCESS_READ_SAMPLE_RATE < 1
      && res.statusCode < 300
      && SAMPLED_READ_METHODS.has(req.method)
      && Math.random() >= SUCCESS_READ_SAMPLE_RATE
    ) {
      return 'silent';
    }
    return 'info';
  },
  // Render a readable one-line summary as the log "message". Without these the
  // entry text is a generic "request completed"; with them it reads e.g.
  // "GET /api/lawfirms/<id>/matters 200".
  // Every URL written here goes through `loggedUrl`, so a public link's token
  // never reaches the logs.
  customSuccessMessage(req: any, res: any) {
    return `${req.method} ${loggedUrl(req)} ${res.statusCode}`;
  },
  customErrorMessage(req: any, res: any, err: any) {
    const detail = err && err.message ? ` - ${err.message}` : '';
    return `${req.method} ${loggedUrl(req)} ${res.statusCode}${detail}`;
  },
  // Extra fields attached to the completed-request log. Evaluated at response
  // time, so req.user and req.params reflect what the route middleware set.
  customProps(req: any) {
    const lawFirmMatch = LOG_LAWFIRM_ID_RE.exec(req.originalUrl || req.url || '');
    const lawFirmId = (req.params && req.params.lawFirmId)
      || (lawFirmMatch ? lawFirmMatch[1] : null);
    return {
      requestId: req.id,
      actorUid: req.user && req.user.uid ? req.user.uid : null,
      lawFirmId: lawFirmId || null,
    };
  },
  // Trim the auto-serialized request/response objects: keep correlation-useful
  // fields, drop noisy header dumps. Sensitive headers are also redacted by the
  // logger config as a backstop.
  serializers: {
    req(req: any) {
      return { id: req.id, method: req.method, url: loggedUrl(req) };
    },
    res(res: any) {
      return { statusCode: res.statusCode };
    },
  },
}));

// Make the route and request id readable from anywhere below, without threading
// them through every call. Mounted after the logger so req.id already exists,
// and ahead of every route so the database layer can tag its slow-query lines
// with the feature that issued them.
app.use(requestContext());

// Append-only audit trail of mutating requests (records on response finish, after
// the route's verifyToken has populated req.user). Skips health/cron/webhooks.
app.use(auditMutations);

// Every request gets a deadline. Mounted after the logger so a timed-out request
// still carries its request id into the error envelope, and ahead of every route
// so no handler can escape it. Routes whose length is set by their payload
// exempt themselves; see the middleware.
app.use(requestTimeout());

// Health check (used by Cloud Run and CI).
//
// PURE LIVENESS, DELIBERATELY. It never touches the pool, so it proves the
// process booted and routes — and nothing else. It cannot see pool exhaustion,
// which is the exact failure the connection budget guards against, and it cannot
// see a database outage. Nothing warms the pool at boot and nothing gates
// readiness on a DB probe either, so a fresh instance can take traffic and fail
// its first query.
//
// The Cloud Run probe stays on this shallow one on purpose: a database blip
// should not convince Cloud Run to kill otherwise-healthy instances and turn a
// recoverable dependency failure into an outage. Use the deep variant below when
// a human wants to know whether the database is actually reachable.
app.get('/api/health', (req: any, res: any) => res.status(200).json({ status: 'ok' }));

// Deep probe: for humans and for rollout verification, never for the Cloud Run
// health check. Reports pool saturation alongside reachability, since "the
// database is up" and "this instance can get a connection to it" are different
// questions and only the second one explains a stalled request. Gated behind
// the same cron secret as the scheduler endpoints below: it exposes raw
// driver error text and pool internals on failure, which is meant for an
// operator's eyes, not an anonymous caller's.
app.get('/api/health/deep', authorizeCronRequest, async (req: any, res: any) => {
  const { infrastructureRootSql } = require('./shared/database/infrastructureQuery');
  const { pool } = require('./shared/database/db');
  const startedAt = Date.now();
  try {
    await infrastructureRootSql('select 1');
    res.status(200).json({
      status: 'ok',
      database: 'reachable',
      latencyMs: Date.now() - startedAt,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: pool.options?.max },
    });
  } catch (err: any) {
    res.status(503).json({
      status: 'degraded',
      database: 'unreachable',
      latencyMs: Date.now() - startedAt,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: pool.options?.max },
      error: err.message,
    });
  }
});

// Cron endpoints (called by Cloud Scheduler)
app.post('/api/cron/reminders', authorizeCronRequest, runCronPass('reminders', async () => {
  const { sendOverdueReminders } = require('./modules/billing/invoices/invoiceReminders.service');
  const { applyAutoLateFees } = require('./modules/billing/invoices/lateFees.service');
  const { sendMatterEventReminders } = require('./modules/matters/matterEventReminders.service');
  const { sendClientEventReminders } = require('./modules/clients/clientEvents.reminders');
  const { sendSigningReminders } = require('./modules/signatures/signingReminders.service');
  const { sendTaskReminders } = require('./modules/tasks/taskReminders.service');
  const { processRecurringTasks } = require('./modules/tasks/taskRecurrence.service');
  const notificationsRepo = require('./modules/notifications/notifications.repository');
  const { cronDeadline } = require('./shared/utils/reminderHelpers');
  // ONE budget for the whole request, shared by every per-firm pass below.
  // Each pass walks the firms it can before the deadline, records where it
  // stopped, and reports `truncated` — so a platform that has outgrown a single
  // request degrades into "each firm served every few runs" instead of the
  // request being killed mid-pass and the same tail of firms never being
  // reached at all.
  const deadline = cronDeadline();
  const invoiceStats = await sendOverdueReminders(undefined, { deadline });
  const lateFeeStats = await applyAutoLateFees(undefined, { deadline });
  const stats = await sendMatterEventReminders(undefined, { deadline });
  const clientEventStats = await sendClientEventReminders(undefined, { deadline });
  const signingStats = await sendSigningReminders();
  const taskStats = await sendTaskReminders(undefined, { deadline });
  // Spawn the next occurrence of completed recurring tasks. Runs after the
  // reminder passes so a task completed today is reminded on its own due date
  // before its successor is created.
  const recurrenceStats = await processRecurringTasks(undefined, { deadline });
  // Retention: nothing else ever deletes notifications, so without this pass
  // the table only grows. Read items age out first; anything unread is kept
  // far longer but not forever. Batched, so a large backlog is worked down
  // over successive runs instead of in one long-running delete.
  const notificationsPurged = await notificationsRepo.purgeOld();
  // Backstop for share digests whose in-process debounce timer died with the
  // instance that scheduled it (every deploy, every scale-in). Sending is
  // claim-protected, so this cannot race a live timer into a double-send.
  const shareDigestFlush = await require('./modules/files/shareNotifications.service')
    .flushExpiredDebounces()
    .catch((err: any) => ({ failed: err.message }));
  return {
    invoiceReminders: invoiceStats,
    lateFees: lateFeeStats,
    matterEventReminders: stats,
    clientEventReminders: clientEventStats,
    signingReminders: signingStats,
    taskReminders: taskStats,
    taskRecurrence: recurrenceStats,
    notificationsPurged,
    shareDigestFlush,
    // True when any pass ran out of budget before covering every firm. The
    // scheduler's own logs make this visible without reading per-pass detail.
    truncated: [invoiceStats, lateFeeStats, stats, clientEventStats, taskStats, recurrenceStats].some((s) => s?.truncated),
  };
}));

// Daily digest. Runs HOURLY, not daily: each recipient picks a delivery hour in
// their own timezone, so a single daily fire could only ever serve one zone.
// Each pass sends to the recipients whose local clock has just reached their
// configured hour; the `digest_sends` primary key makes a re-fire a no-op.
app.post('/api/cron/digest', authorizeCronRequest, runCronPass('digest', async () => {
  const { sendDailyDigests } = require('./modules/notifications/digest/digest.service');
  const digestRepo = require('./modules/notifications/digest/digest.repository');
  const { cronDeadline } = require('./shared/utils/reminderHelpers');
  const deadline = cronDeadline();
  const digestStats = await sendDailyDigests(undefined, { deadline });
  const purged = await digestRepo.purgeOldDigestSends();
  return {
    digest: digestStats,
    digestSendsPurged: purged,
    truncated: Boolean(digestStats?.truncated),
  };
}));

app.post('/api/cron/calendar-watch', authorizeCronRequest, runCronPass('calendar-watch', async () => {
  const { renewExpiringChannels, retryUnstoppedWatchChannels } = require('./modules/calendar/google/google.service');
  const { renewExpiringSubscriptions } = require('./modules/calendar/outlook/outlook.service');
  const { retryFailedWebhooks } = require('./modules/calendar/shared/calendarWebhookRetry');
  const { retryFailedOutbound } = require('./modules/calendar/shared/calendarOutboundRetry');
  const { cronDeadline } = require('./shared/utils/reminderHelpers');
  // ONE budget for the whole request, shared by every pass below. Each pass is a
  // serial walk of provider round trips with no natural ceiling, so without this
  // the request runs until the platform kills it — mid-channel, with nothing
  // recorded. Every pass here works off a due-set that survives the run, so a
  // pass that stops early defers its remainder to the next run rather than
  // losing it.
  const deadline = cronDeadline();
  const googleRenewal = await renewExpiringChannels({ deadline });
  const outlookRenewal = await renewExpiringSubscriptions({ deadline });
  // Channels a previous stop attempt failed to shut off. Google keeps pushing to
  // those until they are stopped or their ttl runs out, so retrying is what keeps
  // the live-channel count from growing on every failed renewal.
  const unstoppedChannels = await retryUnstoppedWatchChannels({ deadline });
  // Durable retry of webhook notifications that failed to process: re-runs the
  // (idempotent) incremental sync with exponential backoff instead of dropping.
  const webhookRetry = await retryFailedWebhooks({ deadline });
  const outboundRetry = await retryFailedOutbound({ deadline });
  return {
    googleRenewal,
    outlookRenewal,
    unstoppedChannels,
    webhookRetry,
    outboundRetry,
    truncated: [googleRenewal, outlookRenewal, unstoppedChannels, webhookRetry, outboundRetry].some((s) => s?.truncated),
  };
}));

// Retry trust-deposit ACH processing fees that were accrued but never charged —
// because the up-front card charge failed (decline/SCA) or the firm had no
// subscription customer at settlement. Without this sweep the platform silently
// eats those fees. Idempotent: only touches status='accrued' rows.
app.post('/api/cron/trust-fee-sweep', authorizeCronRequest, runCronPass('trust-fee-sweep', async () => {
  const { sweepAccruedTrustFees } = require('./modules/stripe/stripe.service');
  const { cronDeadline } = require('./shared/utils/reminderHelpers');
  // Row-capped already, but each row is a serial card charge, so the cap alone
  // does not bound how long the request takes. Fees not reached stay accrued.
  const summary = await sweepAccruedTrustFees({ deadline: cronDeadline() });
  return { trustFeeSweep: summary, truncated: Boolean(summary?.truncated) };
}));

// Reconcile firm billing state against Stripe so a missed/failed subscription
// webhook can't leave a firm with indefinite free access (or stuck locked after a
// payment recovered). Only rewrites firms whose status actually diverged.
app.post('/api/cron/reconcile-billing', authorizeCronRequest, runCronPass('reconcile-billing', async () => {
  const { reconcileBillingStatuses } = require('./modules/subscriptions/subscriptions.service');
  const { cronDeadline, NON_RESUMABLE_CRON_BUDGET_MS } = require('./shared/utils/reminderHelpers');
  // One serial Stripe retrieve per subscribed firm, so the firm cap does not
  // bound the request's duration on its own. The longer budget is because the
  // sweep restarts from the oldest firm every run: stopping sooner would drop
  // more of the newest firms for good rather than defer them.
  const summary = await reconcileBillingStatuses({ deadline: cronDeadline(NON_RESUMABLE_CRON_BUDGET_MS) });
  return { billingReconciliation: summary, truncated: Boolean(summary?.truncated) };
}));

// Reconcile ACH trust deposits against Stripe so a webhook that was claimed but not
// processed (a crash after the idempotency claim committed) can't leave settled
// client funds sitting in the IOLTA with no ledger entry. Idempotent; only posts
// deposits with no existing ledger row (including-void lookup avoids resurrecting a
// clawed-back deposit).
app.post('/api/cron/reconcile-trust-deposits', authorizeCronRequest, runCronPass('reconcile-trust-deposits', async () => {
  const { reconcileStripeTrustDeposits } = require('./modules/stripe/stripe.service');
  const { cronDeadline, NON_RESUMABLE_CRON_BUDGET_MS } = require('./shared/utils/reminderHelpers');
  // Auto-paginates every payment intent in the window, not just the trust ones,
  // so this is the pass most likely to outlive a single request. Stripe pages
  // newest-first, so a truncated scan still covers the most recent deposits.
  const summary = await reconcileStripeTrustDeposits({ dryRun: false, deadline: cronDeadline(NON_RESUMABLE_CRON_BUDGET_MS) });
  return { trustDepositReconciliation: summary, truncated: Boolean(summary?.truncated) };
}));

// Housekeeping sweeps that used to run on `setInterval` timers inside the
// modules that own them. Those never actually ran on schedule: under Cloud Run's
// request-based CPU allocation a background timer only gets CPU while a request
// is in flight, and at min-instances=0 no instance survives a 24-hour interval,
// so the daily sweeps effectively never fired and their 30-second boot
// companions ran on every cold start of every instance instead. Cloud Scheduler
// guarantees a request, and therefore CPU.
//
// Daily cadence suits the first four. `recoverStuckFinalizations` wants the
// reminders cadence or better: it backs a user-facing promise that a signed
// document which failed to persist becomes downloadable within minutes.
app.post('/api/cron/housekeeping', authorizeCronRequest, runCronPass('housekeeping', async () => {
  const templatesRoutes = require('./modules/templates/templates.routes');
  const invitationsRoutes = require('./modules/invitations/invitations.routes');
  const signingRoutes = require('./modules/signatures/signing.routes');
  const lawfirmsService = require('./modules/lawfirms/lawfirms.service');
  const { purgeUnverifiedAccounts } = require('./modules/users/unverifiedAccounts.service');
  const { runCleanupSweep } = require('./shared/events/eventOutbox');
  const { sweepDestroyedFiles } = require('./modules/files/files.sweeper');

  // Each sweep is isolated: one failing must not stop the rest, and every one of
  // them already logs its own errors.
  const results: Record<string, any> = {};
  const run = async (name: any, fn: any) => {
    try { results[name] = (await fn()) ?? 'ok'; }
    catch (err: any) { results[name] = `failed: ${err.message}`; }
  };

  await run('templatesGc', () => templatesRoutes.sweepOrphanedTemplateObjects());
  await run('invitationsExpiry', () => invitationsRoutes.sweepExpiredInvitations());
  await run('signingExpiredUploads', () => signingRoutes.cleanupExpiredUploads());
  await run('signingExpiredSessions', () => signingRoutes.cleanupExpiredSessions());
  await run('signingSettledWorkspaces', () => signingRoutes.sweepSettledWorkspaces());
  // Three minutes of the pass's budget, so the passes after it still run.
  await run('signingFinalizeRecovery', () => signingRoutes.recoverStuckFinalizations({
    deadline: Date.now() + 3 * 60 * 1000,
  }));
  // The outbox's own retention sweep, moved off its 1-hour setInterval for the
  // same reason. No-op when the worker is disabled.
  await run('outboxRetention', () => runCleanupSweep());
  // Hard-purges any soft-deleted firm whose retention window has cleared. The
  // window and what it protects are in docs/features/lawfirms-rbac-plans.md.
  await run('firmPurge', () => lawfirmsService.purgeEligibleFirms());
  // Signup writes the users row before the address is proven, so an account
  // created with someone else's email would otherwise occupy it forever.
  await run('unverifiedAccounts', () => purgeUnverifiedAccounts());
  await run('accountErasures', () => require('./modules/privacy/privacy.service').recoverPendingAccountErasures());
  // Destroys documents whose retention window has cleared, and the rows a
  // browser tab closed mid-upload left claimed. Without it a firm keeps paying
  // for storage they deleted.
  await run('filesSweep', () => sweepDestroyedFiles());

  return { housekeeping: results };
}));

// Drains the durable signing queue: preparation hashes and finalization seals.
//
// This one is DIFFERENT from every cron pass above, and the difference is the
// point. The passes above visit many firms and do a little for each; this holds
// an open request while a single document is hashed or sealed, because Cloud
// Run stops scheduling CPU once a response is sent and there is no such thing
// as finishing the work afterwards.
//
// So it gets its own budget, and ONE budget for everything the request does.
// `drainSigningJobs` stops with five minutes to spare inside a 25-minute
// window, well under Cloud Run's 3600-second request ceiling, and leaves
// whatever it did not reach queued with its attempt counts intact. The export
// drain that follows works to the same deadline rather than starting a fresh
// one: two budgets stacked to 50 minutes inside a scheduler attempt that gives
// up at 30, and the retry then overlapped a drain still inside a job. Copying
// the ordinary cron helper's shorter budget here would cut jobs off partway on
// every run and burn an attempt each time.
//
// The scheduler for this runs every minute with a 30-minute HTTP attempt
// deadline. Its default attempt deadline is far shorter than the work, and a
// scheduler that gives up mid-drain retries a job the drain is still inside.
// Provisioning that schedule is deployment work, not something this file does.
//
// It also does NOT go through `runCronPass`. That helper's CRON_PASS lease
// expires after CRON_LOCK_MAX_HOLD_MS (10 minutes), far short of a 25-minute
// drain, so it could not exclude a second drain anyway. Mutual exclusion here is
// per JOB, through the job's own lease,
// which is both stronger and cheaper: two instances may drain at once and still
// cannot be inside the same job.
app.post('/api/cron/signing-jobs', authorizeCronRequest, (req: any, res: any, next: any) => {
  // Required for their side effect: registering the handlers for a `prepare` and
  // a `finalize` job. Nothing else in this process would have loaded them, and a
  // job whose kind nothing handles fails permanently rather than waiting.
  require('./modules/signatures/signingSources');
  require('./modules/signatures/signingFinalize');
  const { drainSigningJobs, DRAIN_BUDGET_MS } = require('./modules/signatures/signingJobs');
  const { auditOneArtifact } = require('./modules/signatures/signingAudit');
  const { drainExportJobs, sweepExpiredExports } = require('./modules/files/zipExportJobs');
  const owner = `${process.env.K_REVISION || 'local'}:${process.pid}`;
  const deadline = Date.now() + DRAIN_BUDGET_MS;
  drainSigningJobs({ owner, deadline })
    // ONE sampled artifact per run, fully re-read from storage. Production
    // verification resumes the same saved hash state it signed with, so a
    // defect in the resume path is invisible to it: the same wrong answer twice
    // agrees with itself. This is the only reader that recomputes from nothing.
    // It never fails the drain, because an audit that can break the drain is
    // one that gets turned off.
    .then(async (report: any) => ({
      signingJobs: report,
      // Folder exports drain here too, and share the same per-instance transfer
      // slot. A separate schedule would be a second drain competing for one
      // budget, and there is nothing else to give an export a request: Cloud Run
      // stops scheduling CPU the moment a response is sent, so an export
      // created and left to finish "in the background" never finishes.
      exportJobs: await drainExportJobs({ owner, deadline })
        .catch((err: any) => ({ error: err.message })),
      // Finished archives are temporary. Without this they accumulate as
      // storage nobody can see or delete.
      expiredExports: await sweepExpiredExports().catch((err: any) => ({ error: err.message })),
      audit: await auditOneArtifact().catch((err: any) => ({ error: err.message })),
    }))
    .then((body: any) => res.status(200).json({ status: 'ok', ...body }))
    .catch(next);
});

// Coarse per-IP backstop across every route below. Mounted here (after the
// health, cron, and Stripe-webhook handlers registered above, which it therefore
// never sees) so those stay unthrottled; the limiter additionally skips the
// calendar webhooks mounted further down. It only stops volumetric abuse from a
// single source and leaves normal app traffic untouched. See rateLimiters.js.
app.use(globalApiLimiter);

// --- Routes ---
// New module routes (mounted first so they take priority for migrated endpoints)
app.use('/api/lawfirms', [lawfirmsModuleRoutes, rolesModuleRoutes, membersModuleRoutes]);
// Billing gate for the firm workspace: blocks the per-firm data routes below when
// the subscription is not in an access-granting state (incomplete/past_due/
// canceled), returning 402 BILLING_INACTIVE. Exempts /subscriptions (to pay) and
// /invitations (to accept). Firm detail/roles/members above stay reachable so the
// frontend can load the firm and render the lock screen.
//
// `verifyToken` runs FIRST. The routers mounted above apply auth per-route rather
// than via `router.use`, so a path they don't match (e.g. /api/lawfirms/<id>/matters)
// used to reach this gate unauthenticated — and a locked firm answered 402 with its
// billing status, making the gate an anonymous oracle for firm existence and
// subscription state. Every route below this mount authenticates anyway, and
// verifyToken short-circuits its repeat pass on the same token, so this costs
// nothing.
app.use('/api/lawfirms/:lawFirmId', verifyToken, requireActiveBilling);
app.use('/api/lawfirms/:lawFirmId/tasks', [taskNotesModuleRoutes, taskSubtasksModuleRoutes, tasksModuleRoutes]);
app.use('/api/lawfirms/:lawFirmId/matters', [matterCategoriesModuleRoutes, matterNotesModuleRoutes, matterMembersModuleRoutes, matterClientsModuleRoutes, matterContactsModuleRoutes, mattersModuleRoutes]);
app.use('/api/lawfirms/:lawFirmId/notes', firmNotesModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/matter-field-defs', matterFieldDefsModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/matter-stages', matterStagesModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/matter-stage-pipelines', matterStagePipelinesModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/deadline-sets', deadlineSetsModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/clients', [clientNotesModuleRoutes, clientIdentityVerificationRoutes, clientsModuleRoutes]);
app.use('/api/lawfirms/:lawFirmId/contacts', contactsModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/lead-stages', leadStagesModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/leads', leadsModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/intake-forms', intakeFormsModuleRoutes);
app.use('/api/client-portal', clientPortalModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/billing/time-entries', billingTimeEntriesRoutes);
app.use('/api/lawfirms/:lawFirmId/billing/invoices', billingInvoicesRoutes);
app.use('/api/lawfirms/:lawFirmId/billing/flat-fees', verifyToken, requireFeature('flatFees'), billingFlatFeesRoutes);
app.use('/api/lawfirms/:lawFirmId/billing/expenses', billingExpensesRoutes);
app.use('/api/lawfirms/:lawFirmId/billing/expense-categories', billingExpenseCategoriesRoutes);
app.use('/api/lawfirms/:lawFirmId/billing/charge-codes', billingChargeCodesRoutes);
app.use('/api/lawfirms/:lawFirmId/billing/analytics', verifyToken, requireFeature('analytics'), billingAnalyticsRoutes);
app.use('/api/lawfirms/:lawFirmId/billing/reports', billingReportsRoutes);
app.use('/api/lawfirms/:lawFirmId/billing/plans', billingPlansRoutes);
app.use('/api/lawfirms/:lawFirmId/billing', billingWorkbenchRoutes);
app.use('/api/lawfirms/:lawFirmId/files', filesModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/file-share-links', verifyToken, requireFeature('fileSharing'), fileShareLinksRoutes);
app.use('/api/lawfirms/:lawFirmId/document-requests', documentRequestsModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/document-request-templates', documentRequestTemplatesModuleRoutes);
app.use('/api', settingsModuleRoutes);
app.use('/api/google-calendar-sync', googleCalendarModuleRoutes);
app.use('/api/webhooks/google-calendar', googleCalendarWebhookRoutes);
app.use('/api/outlook-calendar-sync', outlookCalendarModuleRoutes);
app.use('/api/webhooks/outlook-calendar', outlookCalendarWebhookRoutes);
app.use('/api/lawfirms/:lawFirmId/calendar-events', calendarEventsRoutes);
app.use('/api/lawfirms/:lawFirmId/calendar-feed', calendarFeedRoutes);
app.use('/api/auth', authModuleRoutes);
app.use('/api/admin', adminModuleRoutes);
app.use('/api', usersModuleRoutes);
app.use('/api', privacyRoutes);
// The messaging router mounts at `/api` and carries the full firm path on each
// route, so its plan gate has to be a separate mount that matches the firm-scoped
// prefix. It runs as bare middleware (no router of its own) and falls through to
// the router below once the feature check passes. Firm members and portal clients
// share these endpoints, so both are gated by the firm's flag.
app.use('/api/lawfirms/:lawFirmId/messaging', verifyToken, requireFeature('messaging'));
app.use('/api', messagingModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/invitations', invitationsModuleRoutes);
app.use('/api/invitations', invitationAcceptRoutes);
app.use('/api/lawfirms/:lawFirmId/practice-areas', practiceAreasModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/note-types', noteTypesModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/note-templates', noteTemplatesModuleRoutes);
app.use('/api/stripe', stripeModuleRoutes);
app.use('/api/signatures', signaturesModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/signature-links', verifyToken, requireFeature('documentSigning'), signatureLinksRoutes);
app.use('/api/lawfirms/:lawFirmId/signing-templates', verifyToken, requireFeature('documentSigning'), signingTemplatesRoutes);
app.use('/api/signing', signingRoutes);
app.use('/api/intake', intakeRoutes);
app.use('/api/share', publicShareRoutes);
app.use('/api/pay', publicPayLinkRoutes);
app.use('/api/lawfirms/:lawFirmId/trust', verifyToken, requireFeature('trustAccounting'), trustModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/courts', courtsModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/catalog', catalogModuleRoutes);
// Both template routers share one mount: two separate `app.use` lines on the
// same path ran the auth + plan gate twice for every request the second router
// handled.
app.use('/api/lawfirms/:lawFirmId/templates', verifyToken, requireFeature('templates'), [templateFoldersModuleRoutes, templatesModuleRoutes]);
// The Word-first template library: its own table and routes, beside the two
// template experiences above.
app.use('/api/lawfirms/:lawFirmId/word-templates', verifyToken, requireFeature('templates'), wordTemplatesModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/notifications', notificationsModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/subscriptions', subscriptionModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/dashboard-summary', dashboardModuleRoutes);
app.use('/api/lawfirms/:lawFirmId/audit-events', auditRoutes);

// Unmatched route. Without this, Express's default finalhandler answers with an
// HTML body, so a mistyped or retired endpoint is the one response in the API that
// does not carry the `{ error, code, requestId }` envelope every client parses.
// The method/path are deliberately NOT echoed back: they are caller-controlled,
// and the request log already carries both against this response's requestId.
app.use((req: any, res: any, next: any) => {
  next(new AppError('The requested endpoint does not exist.', 404, 'ROUTE_NOT_FOUND'));
});

// --- Centralized error handler (must be last) ---
app.use(errorHandler);

// The default body ceiling travels with the app so a route declaring its own
// override can be asserted against it rather than against a copied literal.
export = Object.assign(app, { JSON_BODY_LIMIT, JSON_BODY_LIMIT_BYTES });
