const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../shared/middleware/auth');
const { requireTimezone } = require('../../shared/middleware/timezone');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const { parseSortModel, parseIdList } = require('../../shared/database/pagination');
const { resolveCalendarRange } = require('../../shared/utils/calendarRange');

const {
  createMatterSchema,
  listAllMatterEventsSchema,
  listMatterEventsSchema,
  listMattersSchema,
  listMatterIdsSchema,
  lookupMattersSchema,
  updateMatterSchema,
  setLegalHoldSchema,
  bulkDeleteSchema,
  bulkUpdateStatusSchema,
  bulkUpdatePracticeAreaSchema,
  updatePracticeAreaSchema,
  conflictCheckSchema,
} = require('./matters.validation');
const { createMatterEventSchema, updateMatterEventSchema, cancelMatterEventSchema, postponeMatterEventSchema } = require('./matterEvents.validation');
const { applyDeadlineSetSchema } = require('./deadlineSets/deadlineSets.validation');
const mattersService = require('./matters.service');
const matterEventsService = require('./matterEvents.service');
const deadlineSetsService = require('./deadlineSets/deadlineSets.service');
const matterActivityService = require('./activity/matterActivity.service');
import { handler } from '../../shared/http/handler';

// ── STRING-LITERAL ROUTES (before /:matterId wildcard) ──────────

// GET /api/lawfirms/:lawFirmId/matters
router.get('/',
  verifyToken,
  requirePermission('matters.view'),
  validate(listMattersSchema),
  requireTimezone,
  handler(async (req) => {
    const {
      page, limit, offset, status, paymentOngoing, practiceAreaId, leadUserId, clientId, category, search, sortBy, order, sort,
    } = req.query;
    const result = await mattersService.listLawFirmMatters({
      lawFirmId: req.params.lawFirmId,
      userId: req.user.uid,
      timezone: req.tz,
      page, limit, offset, status, practiceAreaId, leadUserId, clientId, category, search,
      paymentOngoing: paymentOngoing === 'true',
      sortBy, order, sort: parseSortModel(sort),
    });
    return result;
  }),
);

// GET /api/lawfirms/:lawFirmId/matters/ids
//
// Every matter id matching the given filters, unpaginated. Backs "select all" in
// the matters grid, which means every matter behind the current filters rather
// than the page on screen. Answers `{ ids, totalItems, truncated, limit }`:
// `truncated` says the match set was larger than `limit` and the selection was
// capped, so the UI can say so instead of implying it selected everything.
router.get('/ids',
  verifyToken,
  requirePermission('matters.view'),
  validate(listMatterIdsSchema),
  handler(async (req) => {
    const { status, paymentOngoing, practiceAreaId, leadUserId, clientId, category, search } = req.query;
    const result = await mattersService.listMatterIds({
      lawFirmId: req.params.lawFirmId,
      userId: req.user.uid,
      status, practiceAreaId, leadUserId, clientId, category, search,
      paymentOngoing: paymentOngoing === 'true',
    });
    return result;
  }),
);

// GET /api/lawfirms/:lawFirmId/matters/lookup
//
// Responds with `{ items, hasMore }` rather than the usual `{ items, totalItems }`
// list envelope. This endpoint backs a typeahead that fires on every keystroke, and
// `totalItems` would add a second count query to each one; `hasMore` instead falls
// out of the limit+1 row fetch the repository already does. Deliberate deviation,
// not an oversight.
router.get('/lookup',
  verifyToken,
  requirePermission('matters.view'),
  validate(lookupMattersSchema),
  handler(async (req) => mattersService.lookupMatters({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    search: req.query.search,
    exactName: req.query.exactName,
    ids: parseIdList(req.query.ids),
    clientId: req.query.clientId,
    full: req.query.full === 'true',
    limit: req.query.limit,
  })),
);

// POST /api/lawfirms/:lawFirmId/matters
router.post('/',
  verifyToken,
  requirePermission('matters.create'),
  requireTimezone,
  validate(createMatterSchema),
  handler(async (req) => mattersService.createMatter({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
    timezone: req.tz,
  }), 201),
);

// POST /api/lawfirms/:lawFirmId/matters/bulk-delete
router.post('/bulk-delete',
  verifyToken,
  requirePermission('matters.delete'),
  validate(bulkDeleteSchema),
  handler(async (req) => mattersService.bulkDelete({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    member: req.member,
    matterIds: req.body.matterIds,
  })),
);

// POST /api/lawfirms/:lawFirmId/matters/bulk-update-status
router.post('/bulk-update-status',
  verifyToken,
  requirePermission('matters.update'),
  validate(bulkUpdateStatusSchema),
  handler(async (req) => mattersService.bulkUpdateStatus({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    member: req.member,
    matterIds: req.body.matterIds,
    status: req.body.status,
  })),
);

// POST /api/lawfirms/:lawFirmId/matters/bulk-update-practice-area
router.post('/bulk-update-practice-area',
  verifyToken,
  requirePermission('matters.update'),
  validate(bulkUpdatePracticeAreaSchema),
  handler(async (req) => mattersService.bulkUpdatePracticeArea({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    member: req.member,
    matterIds: req.body.matterIds,
    practiceAreaId: req.body.practiceAreaId,
  })),
);

// POST /api/lawfirms/:lawFirmId/matters/conflict-check (conflict-of-interest lookup, read-only)
router.post('/conflict-check',
  verifyToken,
  requirePermission('matters.view'),
  validate(conflictCheckSchema),
  handler(async (req) => mattersService.checkConflicts({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    names: req.body.names,
    emails: req.body.emails,
    organizations: req.body.organizations,
    excludeClientIds: req.body.excludeClientIds,
  })),
);

// GET /api/lawfirms/:lawFirmId/matters/events (all events across all matters, for calendar)
router.get('/events',
  verifyToken,
  requirePermission('matters.view'),
  validate(listAllMatterEventsSchema),
  requireTimezone,
  handler(async (req) => matterEventsService.listAllMatterEvents({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    timezone: req.tz,
    range: resolveCalendarRange({ from: req.query.from, to: req.query.to, timezone: req.tz }),
  })),
);

// ── PARAMETERIZED ROUTES (after string literals) ──────────────

// GET /api/lawfirms/:lawFirmId/matters/:matterId
router.get('/:matterId',
  verifyToken,
  requirePermission('matters.view'),
  requireTimezone,
  handler(async (req) => mattersService.getMatter({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    userId: req.user.uid,
    timezone: req.tz,
  })),
);

// PUT /api/lawfirms/:lawFirmId/matters/:matterId
router.put('/:matterId',
  verifyToken,
  requirePermission('matters.update'),
  requireTimezone,
  validate(updateMatterSchema),
  handler(async (req) => mattersService.updateMatter({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    userId: req.user.uid,
    member: req.member,
    body: req.body,
    timezone: req.tz,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/matters/:matterId
router.delete('/:matterId',
  verifyToken,
  requirePermission('matters.delete'),
  handler(async (req) => mattersService.deleteMatter({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    userId: req.user.uid,
    member: req.member,
  })),
);

// PATCH /api/lawfirms/:lawFirmId/matters/:matterId/legal-hold
router.patch('/:matterId/legal-hold',
  verifyToken,
  requirePermission('matters.update'),
  validate(setLegalHoldSchema),
  requireTimezone,
  handler(async (req) => mattersService.setLegalHold({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    userId: req.user.uid,
    member: req.member,
    legalHold: req.body.legalHold,
    reason: req.body.reason,
    timezone: req.tz,
  })),
);

// POST /api/lawfirms/:lawFirmId/matters/:matterId/update-practice-area
router.post('/:matterId/update-practice-area',
  verifyToken,
  requirePermission('matters.update'),
  validate(updatePracticeAreaSchema),
  handler(async (req) => mattersService.updatePracticeArea({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    userId: req.user.uid,
    member: req.member,
    practiceAreaId: req.body.practiceAreaId,
  })),
);

// GET /api/lawfirms/:lawFirmId/matters/:matterId/activity (matter activity feed)
router.get('/:matterId/activity',
  verifyToken,
  requirePermission('matters.view'),
  handler(async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    // Repeatable ?type=a&type=b, for the timeline's "Notes only" style
    // filters. Express parses a single instance as a bare string.
    const activityTypes = req.query.type
      ? (Array.isArray(req.query.type) ? req.query.type : [req.query.type])
      : undefined;
    const result = await matterActivityService.listActivity({
      lawFirmId: req.params.lawFirmId,
      matterId: req.params.matterId,
      userId: req.user.uid,
      limit,
      offset,
      activityTypes,
    });
    return result;
  }),
);

// GET /api/lawfirms/:lawFirmId/matters/:matterId/conflict-checks (recorded checks)
router.get('/:matterId/conflict-checks',
  verifyToken,
  requirePermission('matters.view'),
  handler(async (req) => mattersService.listConflictChecks({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    userId: req.user.uid,
  })),
);

// POST /api/lawfirms/:lawFirmId/matters/:matterId/conflict-checks/run (re-run + record)
router.post('/:matterId/conflict-checks/run',
  verifyToken,
  requirePermission('matters.update'),
  handler(async (req) => mattersService.rerunConflictCheck({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    userId: req.user.uid,
  })),
);

// ── Matter Events (deadlines / important dates) ──────────────

// GET /api/lawfirms/:lawFirmId/matters/:matterId/events/graph
// The dependency graph: every event on the matter, id/title/status/date/dependsOn
// only. Declared before the list route so `/events/graph` is not swallowed by it.
router.get('/:matterId/events/graph',
  verifyToken,
  requirePermission('matters.view'),
  requireTimezone,
  handler(async (req) => matterEventsService.listMatterEventGraph({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    userId: req.user.uid,
    timezone: req.tz,
  })),
);

// GET /api/lawfirms/:lawFirmId/matters/:matterId/events
router.get('/:matterId/events',
  verifyToken,
  requirePermission('matters.view'),
  validate(listMatterEventsSchema),
  requireTimezone,
  handler(async (req) => matterEventsService.listMatterEvents({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    userId: req.user.uid,
    timezone: req.tz,
    status: req.query.status,
    page: req.query.page,
    limit: req.query.limit,
    offset: req.query.offset,
  })),
);

// POST /api/lawfirms/:lawFirmId/matters/:matterId/events
router.post('/:matterId/events',
  verifyToken,
  requirePermission('matters.update'),
  validate(createMatterEventSchema),
  requireTimezone,
  handler(async (req) => {
    // Server-owned fields spread FIRST, trusted route-derived values applied
    // AFTER: `validate()`'s write-back merges the parsed body over the raw
    // one, so a `lawFirmId`/`matterId` the schema doesn't declare (and so
    // strips from the parsed body) still sits on `req.body` afterwards. The
    // old `{ lawFirmId: req.params.lawFirmId, ...req.body }` order let that
    // surviving key redirect the write to a matter/firm outside the URL.
    const result = await matterEventsService.createMatterEvent({
      ...req.body,
      lawFirmId: req.params.lawFirmId,
      matterId: req.params.matterId,
      userId: req.user.uid,
      timezone: req.tz,
    });
    return result;
  }, 201),
);

// POST /api/lawfirms/:lawFirmId/matters/:matterId/deadline-sets/:templateId/apply
// Materialize a deadline-set template onto this matter from a chosen anchor date.
router.post('/:matterId/deadline-sets/:templateId/apply',
  verifyToken,
  requirePermission('matters.update'),
  validate(applyDeadlineSetSchema),
  requireTimezone,
  handler(async (req) => deadlineSetsService.applyDeadlineSet({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    templateId: req.params.templateId,
    actingUserId: req.user.uid,
    timezone: req.tz,
    anchorDate: req.body.anchorDate,
  }), 201),
);

// DELETE /api/lawfirms/:lawFirmId/matters/:matterId/events/recurrence/:groupId
router.delete('/:matterId/events/recurrence/:groupId',
  verifyToken,
  requirePermission('matters.update'),
  handler(async (req) => matterEventsService.deleteRecurrenceGroup({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    groupId: req.params.groupId,
    userId: req.user.uid,
  })),
);

// POST /api/lawfirms/:lawFirmId/matters/:matterId/events/:eventId/cancel
router.post('/:matterId/events/:eventId/cancel',
  verifyToken,
  requirePermission('matters.update'),
  validate(cancelMatterEventSchema),
  requireTimezone,
  handler(async (req) => matterEventsService.cancelMatterEvent({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    eventId: req.params.eventId,
    userId: req.user.uid,
    timezone: req.tz,
    reason: req.body.reason,
  })),
);

// POST /api/lawfirms/:lawFirmId/matters/:matterId/events/:eventId/postpone
router.post('/:matterId/events/:eventId/postpone',
  verifyToken,
  requirePermission('matters.update'),
  validate(postponeMatterEventSchema),
  requireTimezone,
  handler(async (req) => matterEventsService.postponeMatterEvent({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    eventId: req.params.eventId,
    userId: req.user.uid,
    timezone: req.tz,
    newDate: req.body.newDate,
    reason: req.body.reason,
  })),
);

// PUT /api/lawfirms/:lawFirmId/matters/:matterId/events/:eventId
router.put('/:matterId/events/:eventId',
  verifyToken,
  requirePermission('matters.update'),
  validate(updateMatterEventSchema),
  requireTimezone,
  handler(async (req) => {
    // Same ordering fix as the create route above: the URL identifies which
    // event, matter and firm are being edited.
    const result = await matterEventsService.updateMatterEvent({
      ...req.body,
      lawFirmId: req.params.lawFirmId,
      matterId: req.params.matterId,
      eventId: req.params.eventId,
      userId: req.user.uid,
      timezone: req.tz,
    });
    return result;
  }),
);

// DELETE /api/lawfirms/:lawFirmId/matters/:matterId/events/:eventId
router.delete('/:matterId/events/:eventId',
  verifyToken,
  requirePermission('matters.update'),
  handler(async (req) => matterEventsService.deleteMatterEvent({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    eventId: req.params.eventId,
    userId: req.user.uid,
  })),
);

export = router;
