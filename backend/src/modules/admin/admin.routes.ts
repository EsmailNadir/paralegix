const express = require('express');

const { verifyToken } = require('../../shared/middleware/auth');
const { requireIsAdmin } = require('../../shared/middleware/requireIsAdmin');
const { validate } = require('../../shared/middleware/validate');
const { parseSortModel } = require('../../shared/database/pagination');
const {
  updateLawFirmSchema,
  updateUserAdminSchema,
  updatePlanSchema,
  adminCreateSubscriptionSchema,
  adminCancelSubscriptionSchema,
  adminExtendTrialSchema,
  adminApplyCouponSchema,
  adminRefundSchema,
  adminCompFirmSchema,
  adminAddWhitelistSchema,
  adminRemoveWhitelistSchema,
  adminCreateAccountSchema,
  adminListAuditEventsSchema,
  adminListLawFirmsSchema,
  adminListUsersSchema,
  adminListClientsSchema,
  lookupLawFirmsSchema,
} = require('./admin.validation');
const adminService = require('./admin.service');
const auditService = require('../audit/audit.service');
const { getOutboxHealth } = require('../../shared/events/eventOutbox');
const { logSecurityEvent } = require('../../shared/utils/securityLog');
import { handler } from '../../shared/http/handler';

const router = express.Router({ mergeParams: true });

router.use(verifyToken, requireIsAdmin);

// Every privileged admin mutation is a security-relevant event. Logging it here
// (after auth/authorization) gives a single, complete `admin.action` stream for
// the alert in infra/monitoring — these are low-volume and worth surfacing each.
// Reads are skipped: they are routine and high-volume.
const ADMIN_MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
router.use((req: any, res: any, next: any) => {
  if (ADMIN_MUTATING_METHODS.has(req.method)) {
    logSecurityEvent(req, 'admin.action', {
      method: req.method,
      path: (req.originalUrl || req.url || '').split('?')[0],
    });
  }
  next();
});

// GET /api/admin/outbox-health (diagnostic surface for the durable event outbox)
// Read-only counts of dead-letter / retryable / processing / pending rows +
// whether the worker is enabled. Admin-only (router.use requireIsAdmin).
// The route itself isn't flag-gated, but enqueue is SKIPPED when the worker is
// off (eventBus.backstopEnqueue returns early unless EVENT_OUTBOX_WORKER==='true'),
// so with the worker disabled no rows are ever written and these counts read all
// zeros. The numbers are only meaningful once EVENT_OUTBOX_WORKER=true, when the
// worker both drains and prunes the table.
router.get('/outbox-health', handler(async (req) => {
  const health = await getOutboxHealth();
  return health;
}));

// GET /api/admin/lawfirms
//
// Paging, search, sorting and the plan/billing filters are opt-in. With a `limit`
// the response carries `totalItems` (matching the filters) plus `stats` (the
// unfiltered platform counts, for the console's cards); without one the whole
// list comes back as before, which the callers that need every firm still rely on.
router.get('/lawfirms',
  validate(adminListLawFirmsSchema),
  handler(async (req, res) => {
    if (req.query.limit == null && !req.query.search) {
      const { lawFirms, truncated, ceiling } = await adminService.listLawFirms();
      // `truncated` is part of the answer, not diagnostics: the unpaged list
      // stops at `ceiling`, and a capped list looks exactly like a complete one
      // to whoever is reading it.
      res.status(200).json({ lawFirms, truncated, ceiling });
      return;
    }
    const result = await adminService.listLawFirmsPaged({
      limit: req.query.limit,
      offset: req.query.offset,
      page: req.query.page,
      search: req.query.search,
      sort: parseSortModel(req.query.sort),
      sortBy: req.query.sortBy,
      order: req.query.order,
      planId: req.query.planId,
      billingStatus: req.query.billingStatus,
    });
    res.status(200).json(result);
  })
);

// GET /api/admin/lawfirms/lookup
//
// Typeahead over every firm on the platform, for admin screens that would
// otherwise render an unbounded firm dropdown. Declared before
// `/lawfirms/:lawFirmId` so "lookup" is not captured as a firm id.
//
// Responds with `{ items, hasMore }` rather than the usual `{ items, totalItems }`
// list envelope, matching the firm-scoped lookups: this backs a per-keystroke
// typeahead, and `hasMore` falls out of the limit+1 fetch the repository already
// does instead of costing a second count query.
//
// Authorization is the router-level `verifyToken, requireIsAdmin` pair applied to
// every route in this file. That is the whole gate, and it has to be: unlike every
// other lookup in the codebase this one is not firm-scoped, so there is no
// membership check underneath it to fall back on.
router.get('/lawfirms/lookup',
  validate(lookupLawFirmsSchema),
  handler(async (req) => adminService.lookupLawFirms({
    search: req.query.search,
    ids: req.query.ids
      ? String(req.query.ids).split(',').map((s) => s.trim()).filter(Boolean)
      : undefined,
    limit: req.query.limit,
  }))
);

// GET /api/admin/users
// Paging, search, sorting and filtering are opt-in, same contract as /lawfirms
// above. A paged response also carries `stats` (the unfiltered platform user
// counts and rolling signup windows), so the console's stat cards do not shrink
// to the current search. Paged rows name the firms each user belongs to.
//
// Default order is newest-signup-first, which is the question this list is
// usually opened to answer.
router.get('/users',
  validate(adminListUsersSchema),
  handler(async (req, res) => {
    if (req.query.limit == null && !req.query.search) {
      const { users, truncated, ceiling } = await adminService.listUsers();
      res.status(200).json({ users, truncated, ceiling });
      return;
    }
    const result = await adminService.listUsersPaged({
      limit: req.query.limit,
      offset: req.query.offset,
      page: req.query.page,
      search: req.query.search,
      sort: parseSortModel(req.query.sort),
      sortBy: req.query.sortBy,
      order: req.query.order,
      userType: req.query.userType,
      isAdmin: req.query.isAdmin == null ? undefined : req.query.isAdmin === 'true',
      lawFirmId: req.query.lawFirmId,
      createdAfter: req.query.createdAfter,
      createdBefore: req.query.createdBefore,
    });
    res.status(200).json(result);
  })
);

// GET /api/admin/clients
//
// The platform-wide list of client RECORDS (the `clients` table), as opposed to
// /users, which lists login accounts. Each row names the firm that owns it and
// reports whether the client ever made it into the portal.
//
// Always paged: unlike /lawfirms and /users this endpoint is new, so it has no
// unpaginated callers to keep working, and the client table is the largest of
// the three.
router.get('/clients',
  validate(adminListClientsSchema),
  handler(async (req) => adminService.listClientsPaged({
    limit: req.query.limit ?? 50,
    offset: req.query.offset,
    page: req.query.page,
    search: req.query.search,
    sort: parseSortModel(req.query.sort),
    sortBy: req.query.sortBy,
    order: req.query.order,
    lawFirmId: req.query.lawFirmId,
    status: req.query.status,
    portal: req.query.portal,
    clientType: req.query.clientType,
    createdAfter: req.query.createdAfter,
    createdBefore: req.query.createdBefore,
  }))
);

// GET /api/admin/audit-events
// Cross-firm audit log (login activity, mutations). Defaults to newest first.
// Filter by action (e.g. action=auth.login for logins), actorUid, or lawFirmId.
router.get('/audit-events',
  validate(adminListAuditEventsSchema),
  handler(async (req) => auditService.listAllAuditEvents({
    limit: req.query.limit,
    offset: req.query.offset,
    action: req.query.action,
    actorUid: req.query.actorUid,
    lawFirmId: req.query.lawFirmId,
    search: req.query.search,
  })),
);

// GET /api/admin/lawfirms/:lawFirmId
router.get('/lawfirms/:lawFirmId', handler(async (req) => adminService.getLawFirmDetail(req.params.lawFirmId)));

// PATCH /api/admin/lawfirms/:lawFirmId/roles/:roleId
router.patch('/lawfirms/:lawFirmId/roles/:roleId', handler(async (req) => adminService.updateLawFirmRole({
  lawFirmId: req.params.lawFirmId,
  roleId: req.params.roleId,
  name: req.body.name,
  permissions: req.body.permissions,
})));

// PATCH /api/admin/lawfirms/:lawFirmId/members/:memberId/role
router.patch('/lawfirms/:lawFirmId/members/:memberId/role', handler(async (req) => adminService.updateMemberRole({
  lawFirmId: req.params.lawFirmId,
  memberId: req.params.memberId,
  roleId: req.body.roleId,
})));

// DELETE /api/admin/lawfirms/:lawFirmId/members/:memberId
router.delete('/lawfirms/:lawFirmId/members/:memberId', handler(async (req) => adminService.removeMember({
  lawFirmId: req.params.lawFirmId,
  memberId: req.params.memberId,
})));

// DELETE /api/admin/lawfirms/:lawFirmId/pending-invites/:inviteId
router.delete('/lawfirms/:lawFirmId/pending-invites/:inviteId', handler(async (req) => adminService.deletePendingInvite({
  lawFirmId: req.params.lawFirmId,
  inviteId: req.params.inviteId,
})));

// DELETE /api/admin/lawfirms/:lawFirmId/pending-client-invites/:inviteId
router.delete('/lawfirms/:lawFirmId/pending-client-invites/:inviteId', handler(async (req) => adminService.deletePendingClientInvite({
  lawFirmId: req.params.lawFirmId,
  inviteId: req.params.inviteId,
})));

// PATCH /api/admin/lawfirms/:lawFirmId
router.patch('/lawfirms/:lawFirmId',
  validate(updateLawFirmSchema),
  handler(async (req) => adminService.updateLawFirm({
    lawFirmId: req.params.lawFirmId,
    payload: req.body,
  })),
);

// PATCH /api/admin/users/:userId/admin
router.patch('/users/:userId/admin',
  validate(updateUserAdminSchema),
  handler(async (req) => adminService.updateUserAdmin({
    userId: req.params.userId,
    isAdmin: req.body.isAdmin,
  })),
);

// ── Plan Management ─────────────────────────────────────────────────────

// GET /api/admin/plans
router.get('/plans', handler(async (req) => {
  const plans = await adminService.listPlanTiers();
  return { plans };
}));

// GET /api/admin/lawfirms/:lawFirmId/plan
router.get('/lawfirms/:lawFirmId/plan', handler(async (req) => adminService.getLawFirmPlan(req.params.lawFirmId)));

// PATCH /api/admin/lawfirms/:lawFirmId/plan
router.patch('/lawfirms/:lawFirmId/plan',
  validate(updatePlanSchema),
  handler(async (req) => adminService.updateLawFirmPlan({
    lawFirmId: req.params.lawFirmId,
    payload: req.body,
    adminUserId: req.user.uid,
  }))
);

// POST /api/admin/lawfirms/:lawFirmId/storage/recount
// Recompute the firm's stored-bytes usage from the GCS bucket (fixes drift).
router.post('/lawfirms/:lawFirmId/storage/recount', handler(async (req) => adminService.recomputeStorageUsage(req.params.lawFirmId)));

// GET /api/admin/plan-usage
//
// Unpaged by design — it sweeps every firm for plan-limit breaches. `truncated`
// says the sweep stopped at `ceiling` firms, so a partial pass is not read as
// "nothing is over limit".
router.get('/plan-usage', handler(async (req) => {
  const { firms, truncated, ceiling } = await adminService.listPlanUsage();
  return { firms, truncated, ceiling };
}));

// ── Admin Subscription Management ───────────────────────────────────────

// POST /api/admin/lawfirms/:lawFirmId/subscription/create
router.post('/lawfirms/:lawFirmId/subscription/create',
  validate(adminCreateSubscriptionSchema),
  handler(async (req) => adminService.adminCreateSubscription({
    lawFirmId: req.params.lawFirmId,
    planId: req.body.planId,
    interval: req.body.interval,
    skipTrial: req.body.skipTrial,
    coupon: req.body.coupon,
    adminUserId: req.user.uid,
  }))
);

// POST /api/admin/lawfirms/:lawFirmId/subscription/cancel
router.post('/lawfirms/:lawFirmId/subscription/cancel',
  validate(adminCancelSubscriptionSchema),
  handler(async (req) => adminService.adminCancelSubscription({
    lawFirmId: req.params.lawFirmId,
    immediate: req.body.immediate,
    reason: req.body.reason,
  }))
);

// POST /api/admin/lawfirms/:lawFirmId/subscription/extend-trial
router.post('/lawfirms/:lawFirmId/subscription/extend-trial',
  validate(adminExtendTrialSchema),
  handler(async (req) => adminService.adminExtendTrial({
    lawFirmId: req.params.lawFirmId,
    days: req.body.days,
  }))
);

// POST /api/admin/lawfirms/:lawFirmId/subscription/apply-coupon
router.post('/lawfirms/:lawFirmId/subscription/apply-coupon',
  validate(adminApplyCouponSchema),
  handler(async (req) => adminService.adminApplyCoupon({
    lawFirmId: req.params.lawFirmId,
    couponId: req.body.couponId,
  }))
);

// POST /api/admin/lawfirms/:lawFirmId/subscription/refund
router.post('/lawfirms/:lawFirmId/subscription/refund',
  validate(adminRefundSchema),
  handler(async (req) => adminService.adminRefund({
    lawFirmId: req.params.lawFirmId,
    amount: req.body.amount,
    full: req.body.full,
    reason: req.body.reason,
  }))
);

// POST /api/admin/lawfirms/:lawFirmId/subscription/comp
router.post('/lawfirms/:lawFirmId/subscription/comp',
  validate(adminCompFirmSchema),
  handler(async (req) => adminService.adminCompFirm({
    lawFirmId: req.params.lawFirmId,
    planId: req.body.planId,
    reason: req.body.reason,
    adminUserId: req.user.uid,
  }))
);

// GET /api/admin/lawfirms/:lawFirmId/subscription/invoices
router.get('/lawfirms/:lawFirmId/subscription/invoices', handler(async (req) => adminService.adminListSubscriptionInvoices({
  lawFirmId: req.params.lawFirmId,
})));

// ── Test tooling: verification whitelist ────────────────────────────────

// GET /api/admin/whitelist
router.get('/whitelist', handler(async (req) => adminService.listWhitelist()));

// POST /api/admin/whitelist
router.post('/whitelist',
  validate(adminAddWhitelistSchema),
  handler(async (req) => adminService.addToWhitelist({
    email: req.body.email,
    note: req.body.note,
    adminUserId: req.user.uid,
  }), 201)
);

// DELETE /api/admin/whitelist  (email in body — addresses don't sit cleanly in a path)
router.delete('/whitelist',
  validate(adminRemoveWhitelistSchema),
  handler(async (req) => adminService.removeFromWhitelist({ email: req.body.email }))
);

// ── Test tooling: account / firm creation ───────────────────────────────

// POST /api/admin/test-accounts
router.post('/test-accounts',
  validate(adminCreateAccountSchema),
  handler(async (req) => adminService.adminCreateAccount({
    kind: req.body.kind,
    email: req.body.email,
    password: req.body.password,
    name: req.body.name,
    firmName: req.body.firmName,
    lawFirmId: req.body.lawFirmId,
    roleId: req.body.roleId,
    adminUserId: req.user.uid,
  }), 201)
);

export = router;
