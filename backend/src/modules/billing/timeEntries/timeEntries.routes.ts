const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { heavyReadLimiter } = require('../../../shared/middleware/rateLimiters');
const { requireTimezone } = require('../../../shared/middleware/timezone');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');
const {
  createTimeEntrySchema,
  updateTimeEntrySchema,
  listFirmTimeEntriesSchema,
  bulkDeleteTimeEntriesSchema,
} = require('./timeEntries.validation');
const timeEntriesService = require('./timeEntries.service');
import { handler } from '../../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/billing/time-entries/firm
// Server-side paging/filtering/sorting. Every query param is optional, but the
// row window is bounded either way: a `limit` above MAX_PAGE_SIZE is a 400, and
// no `limit` at all is served as MAX_PAGE_SIZE rows with `truncated: true` when
// that withheld anything. `totalItems` and `summary` still cover the whole match
// set. The workbench and summary reads are unaffected: they call
// firmBilling.service directly, in process, and keep the complete list.
router.get('/firm',
  verifyToken,
  heavyReadLimiter,
  requirePermission('billing.viewTimeEntries'),
  validate(listFirmTimeEntriesSchema),
  requireTimezone,
  handler(async (req) => timeEntriesService.listFirmTimeEntries({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    page: req.query.page,
    limit: req.query.limit,
    offset: req.query.offset,
    sort: req.query.sort,
    search: req.query.search,
    context: req.query.context,
    matterId: req.query.matterId,
    clientId: req.query.clientId,
    clientScope: req.query.clientScope,
    userId: req.query.userId,
    chargeCodeId: req.query.chargeCodeId,
    billingStatus: req.query.billingStatus,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
  })),
);

// POST /api/lawfirms/:lawFirmId/billing/time-entries
router.post('/',
  verifyToken,
  requirePermission('billing.manageTimeEntries'),
  requireTimezone,
  validate(createTimeEntrySchema),
  handler(async (req) => timeEntriesService.createTimeEntry({
    lawFirmId: req.params.lawFirmId,
    matterId: req.body.matterId,
    clientId: req.body.clientId,
    actingUserId: req.user.uid,
    timeZone: req.tz,
    body: req.body,
  }), 201),
);

// GET /api/lawfirms/:lawFirmId/billing/time-entries/matter/:matterId
router.get('/matter/:matterId',
  verifyToken,
  requirePermission('billing.viewTimeEntries'),
  requireTimezone,
  handler(async (req) => timeEntriesService.listTimeEntries({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    actingUserId: req.user.uid,
    userId: req.query.userId || null,
    unbilledOnly: req.query.unbilledOnly === 'true',
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/time-entries/client/:clientId
router.get('/client/:clientId',
  verifyToken,
  requirePermission('billing.viewTimeEntries'),
  requireTimezone,
  handler(async (req) => timeEntriesService.listTimeEntries({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    actingUserId: req.user.uid,
    userId: req.query.userId || null,
    unbilledOnly: req.query.unbilledOnly === 'true',
  })),
);

// POST /api/lawfirms/:lawFirmId/billing/time-entries/bulk-delete
// One request for a whole selection, in place of one DELETE per row. Registered
// before the `/:timeEntryId` routes so "bulk-delete" is never read as an entry
// id. Per-entry outcomes: a 200 carrying `errors` reports the rows the caller
// may not delete alongside the count that went, so one billed row cannot cancel
// the other 999. The single-entry DELETE routes below are unchanged.
router.post('/bulk-delete',
  verifyToken,
  requirePermission('billing.manageTimeEntries'),
  validate(bulkDeleteTimeEntriesSchema),
  handler(async (req) => timeEntriesService.bulkDeleteTimeEntries({
    lawFirmId: req.params.lawFirmId,
    timeEntryIds: req.body.timeEntryIds,
    actingUserId: req.user.uid,
  })),
);

// POST /api/lawfirms/:lawFirmId/billing/time-entries/matter/:matterId/rerate
// POST /api/lawfirms/:lawFirmId/billing/time-entries/client/:clientId/rerate
// The stored rate on an entry is sticky; this is how a rate change reaches the
// context's unbilled work. Registered before the `/:timeEntryId` routes so
// "rerate" is never read as an entry id. No screen calls it yet.
router.post('/matter/:matterId/rerate',
  verifyToken,
  requirePermission('billing.manageTimeEntries'),
  handler(async (req) => timeEntriesService.rerateTimeEntries({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    actingUserId: req.user.uid,
  })),
);
router.post('/client/:clientId/rerate',
  verifyToken,
  requirePermission('billing.manageTimeEntries'),
  handler(async (req) => timeEntriesService.rerateTimeEntries({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    actingUserId: req.user.uid,
  })),
);

// PUT /api/lawfirms/:lawFirmId/billing/time-entries/matter/:matterId/:timeEntryId
router.put('/matter/:matterId/:timeEntryId',
  verifyToken,
  requirePermission('billing.manageTimeEntries'),
  requireTimezone,
  validate(updateTimeEntrySchema),
  handler(async (req) => timeEntriesService.updateTimeEntry({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    timeEntryId: req.params.timeEntryId,
    actingUserId: req.user.uid,
    timeZone: req.tz,
    body: req.body,
  })),
);

// PUT /api/lawfirms/:lawFirmId/billing/time-entries/client/:clientId/:timeEntryId
router.put('/client/:clientId/:timeEntryId',
  verifyToken,
  requirePermission('billing.manageTimeEntries'),
  requireTimezone,
  validate(updateTimeEntrySchema),
  handler(async (req) => timeEntriesService.updateTimeEntry({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    timeEntryId: req.params.timeEntryId,
    actingUserId: req.user.uid,
    timeZone: req.tz,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/billing/time-entries/matter/:matterId/:timeEntryId
router.delete('/matter/:matterId/:timeEntryId',
  verifyToken,
  requirePermission('billing.manageTimeEntries'),
  handler(async (req) => timeEntriesService.deleteTimeEntry({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    timeEntryId: req.params.timeEntryId,
    actingUserId: req.user.uid,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/billing/time-entries/client/:clientId/:timeEntryId
router.delete('/client/:clientId/:timeEntryId',
  verifyToken,
  requirePermission('billing.manageTimeEntries'),
  handler(async (req) => timeEntriesService.deleteTimeEntry({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    timeEntryId: req.params.timeEntryId,
    actingUserId: req.user.uid,
  })),
);

export = router;
