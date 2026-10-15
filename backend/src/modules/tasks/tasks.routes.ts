const express = require('express');
const router = express.Router({ mergeParams: true });
const { verifyToken } = require('../../shared/middleware/auth');
const { requireTimezone } = require('../../shared/middleware/timezone');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const { parseSortModel, parseIdList } = require('../../shared/database/pagination');
const {
  listTasksSchema,
  listTaskIdsSchema,
  lookupTasksSchema,
  createTaskSchema,
  updateTaskSchema,
  bulkDeleteSchema,
  bulkStatusSchema,
  bulkMatterSchema,
} = require('./tasks.validation');
const tasksService = require('./tasks.service');
import { handler } from '../../shared/http/handler';

// ── LIST ROUTES (must be before /:taskId wildcard) ───────────

// GET /api/lawfirms/:lawFirmId/tasks (List all tasks for firm)
router.get('/',
  verifyToken,
  requirePermission('tasks.view'),
  validate(listTasksSchema),
  requireTimezone,
  handler(async (req) => {
    const { page, limit, status, assignee, matterId, clientId, priority, search, sortBy, order, sort, dueFrom, dueTo, includeSpanning } = req.query;
    const result = await tasksService.listLawFirmTasks({
      lawFirmId: req.params.lawFirmId,
      userId: req.user.uid,
      timezone: req.tz,
      page, limit, status, assignee, matterId, clientId, priority, search,
      sortBy, order, sort: parseSortModel(sort), dueFrom, dueTo, includeSpanning: includeSpanning === 'true',
    });
    return result;
  })
);

// GET /api/lawfirms/:lawFirmId/tasks/ids
//
// Every task id matching the given filters, unpaginated. Backs "select all" in the
// tasks grid, which means every task behind the current filters rather than the
// page on screen. Answers `{ ids, totalItems, truncated, limit }`: `truncated` says
// the match set was larger than `limit` and the selection was capped, so the UI can
// say so instead of implying it selected everything.
router.get('/ids',
  verifyToken,
  requirePermission('tasks.view'),
  validate(listTaskIdsSchema),
  handler(async (req) => {
    const { status, assignee, matterId, clientId, priority, search, dueFrom, dueTo } = req.query;
    const result = await tasksService.listTaskIds({
      lawFirmId: req.params.lawFirmId,
      userId: req.user.uid,
      status, assignee, matterId, clientId, priority, search, dueFrom, dueTo,
    });
    return result;
  })
);

// GET /api/lawfirms/:lawFirmId/tasks/status-counts
//
// Firm-wide task totals per status. A caller showing these alongside a
// date-windowed task list cannot derive them from that list, which only covers
// the days on screen. Not time-aware: the answer is counts, never a formatted date.
router.get('/status-counts',
  verifyToken,
  requirePermission('tasks.view'),
  handler(async (req) => tasksService.getTaskStatusCounts({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
  }))
);

// GET /api/lawfirms/:lawFirmId/tasks/lookup
//
// Responds with `{ items, hasMore }` rather than the usual `{ tasks, totalTasks }`
// list envelope. This endpoint backs a typeahead that fires on every keystroke, and
// a total would add a second count query to each one; `hasMore` instead falls out
// of the limit+1 row fetch the repository already does. Deliberate deviation, not
// an oversight.
router.get('/lookup',
  verifyToken,
  requirePermission('tasks.view'),
  validate(lookupTasksSchema),
  handler(async (req) => tasksService.lookupTasks({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    search: req.query.search,
    exactName: req.query.exactName,
    ids: parseIdList(req.query.ids),
    clientId: req.query.clientId,
    matterId: req.query.matterId,
    limit: req.query.limit,
  }))
);

// GET /api/lawfirms/:lawFirmId/tasks/matter/:matterId (List tasks for a matter)
router.get('/matter/:matterId',
  verifyToken,
  requirePermission('tasks.view'),
  requireTimezone,
  handler(async (req) => tasksService.listMatterTasks({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    userId: req.user.uid,
    timezone: req.tz,
  }))
);

// GET /api/lawfirms/:lawFirmId/tasks/my-assignments (My assigned tasks)
router.get('/my-assignments',
  verifyToken,
  requirePermission('tasks.view'),
  requireTimezone,
  handler(async (req) => tasksService.getMyAssignments({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    timezone: req.tz,
  }))
);

// GET /api/lawfirms/:lawFirmId/tasks/analytics (Task analytics)
router.get('/analytics',
  verifyToken,
  requirePermission('tasks.view'),
  requireTimezone,
  handler(async (req) => tasksService.getTaskAnalytics({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    timezone: req.tz,
    dateRange: req.query.dateRange || 'all',
  }))
);

// ── BULK OPS (must be before /:taskId wildcard) ──────────────

// POST /api/lawfirms/:lawFirmId/tasks/bulk-delete
router.post('/bulk-delete',
  verifyToken,
  requirePermission('tasks.delete'),
  validate(bulkDeleteSchema),
  handler(async (req) => tasksService.bulkDelete({
    lawFirmId: req.params.lawFirmId,
    taskIds: req.body.taskIds,
    userId: req.user.uid,
  }))
);

// POST /api/lawfirms/:lawFirmId/tasks/bulk-status
router.post('/bulk-status',
  verifyToken,
  requirePermission('tasks.update'),
  requireTimezone,
  validate(bulkStatusSchema),
  handler(async (req) => tasksService.bulkStatus({
    lawFirmId: req.params.lawFirmId,
    taskIds: req.body.taskIds,
    status: req.body.status,
    userId: req.user.uid,
    timezone: req.tz,
  }))
);

// POST /api/lawfirms/:lawFirmId/tasks/bulk-matter
router.post('/bulk-matter',
  verifyToken,
  requirePermission('tasks.update'),
  requireTimezone,
  validate(bulkMatterSchema),
  handler(async (req) => tasksService.bulkMatter({
    lawFirmId: req.params.lawFirmId,
    taskIds: req.body.taskIds,
    matterId: req.body.matterId,
    userId: req.user.uid,
    timezone: req.tz,
  }))
);

// ── CRUD (wildcard :taskId routes last) ──────────────────────

// POST /api/lawfirms/:lawFirmId/tasks (Create task)
router.post('/',
  verifyToken,
  requirePermission('tasks.create'),
  requireTimezone,
  validate(createTaskSchema),
  handler(async (req) => {
    // Server-owned fields are spread FIRST and the trusted, route-derived
    // values applied AFTER, so a `lawFirmId` (or any other reserved key) that
    // survives validation in the body can never override the URL's tenant.
    // `validate()`'s write-back merges the parsed body over the RAW one rather
    // than replacing it, so an unknown key zod stripped from the parsed body
    // is still sitting in `req.body` afterwards; the older `{ lawFirmId:
    // req.params.lawFirmId, ...req.body }` order let that surviving key win.
    const result = await tasksService.createTask({
      ...req.body,
      lawFirmId: req.params.lawFirmId,
      userId: req.user.uid,
      timezone: req.tz,
    });
    return result;
  }, 201)
);

// GET /api/lawfirms/:lawFirmId/tasks/:taskId (Get single task)
router.get('/:taskId',
  verifyToken,
  requirePermission('tasks.view'),
  requireTimezone,
  handler(async (req) => tasksService.getTask({
    lawFirmId: req.params.lawFirmId,
    taskId: req.params.taskId,
    userId: req.user.uid,
    timezone: req.tz,
  }))
);

// GET /api/lawfirms/:lawFirmId/tasks/:taskId/dependencies (Get dependency graph)
router.get('/:taskId/dependencies',
  verifyToken,
  requirePermission('tasks.view'),
  requireTimezone,
  handler(async (req) => tasksService.getTaskDependencyGraph({
    lawFirmId: req.params.lawFirmId,
    taskId: req.params.taskId,
    userId: req.user.uid,
    timezone: req.tz,
  }))
);

// PUT /api/lawfirms/:lawFirmId/tasks/:taskId (Update task)
router.put('/:taskId',
  verifyToken,
  requirePermission('tasks.update'),
  requireTimezone,
  validate(updateTaskSchema),
  handler(async (req) => {
    // Same ordering fix as the create route above: the URL identifies which
    // task and firm are being edited, so a `taskId`/`lawFirmId` surviving in
    // the body must never be able to redirect the write elsewhere.
    const result = await tasksService.updateTask({
      ...req.body,
      lawFirmId: req.params.lawFirmId,
      taskId: req.params.taskId,
      userId: req.user.uid,
      timezone: req.tz,
    });
    return result;
  })
);

// DELETE /api/lawfirms/:lawFirmId/tasks/:taskId (Delete task)
router.delete('/:taskId',
  verifyToken,
  requirePermission('tasks.delete'),
  handler(async (req) => tasksService.deleteTask({
    lawFirmId: req.params.lawFirmId,
    taskId: req.params.taskId,
    userId: req.user.uid,
  }))
);

export = router;
