const express = require('express');
const router = express.Router({ mergeParams: true });
const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');
const {
  createSubtaskSchema,
  updateSubtaskSchema,
  reorderSubtasksSchema,
} = require('./taskSubtasks.validation');
const taskSubtasksService = require('./taskSubtasks.service');
import { handler } from '../../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/tasks/:taskId/subtasks (List subtasks)
router.get('/:taskId/subtasks',
  verifyToken,
  requirePermission('tasks.view'),
  handler(async (req) => taskSubtasksService.listSubtasks({
    lawFirmId: req.params.lawFirmId,
    taskId: req.params.taskId,
    userId: req.user.uid,
  }))
);

// POST /api/lawfirms/:lawFirmId/tasks/:taskId/subtasks/reorder (Reorder subtasks)
router.post('/:taskId/subtasks/reorder',
  verifyToken,
  requirePermission('tasks.update'),
  validate(reorderSubtasksSchema),
  handler(async (req) => taskSubtasksService.reorderSubtasks({
    lawFirmId: req.params.lawFirmId,
    taskId: req.params.taskId,
    userId: req.user.uid,
    subtaskIds: req.body.subtaskIds,
  }))
);

// POST /api/lawfirms/:lawFirmId/tasks/:taskId/subtasks (Create a subtask)
router.post('/:taskId/subtasks',
  verifyToken,
  requirePermission('tasks.update'),
  validate(createSubtaskSchema),
  handler(async (req) => taskSubtasksService.createSubtask({
    lawFirmId: req.params.lawFirmId,
    taskId: req.params.taskId,
    userId: req.user.uid,
    title: req.body.title,
    assigneeUserId: req.body.assigneeUserId,
    sortOrder: req.body.sortOrder,
  }), 201)
);

// PUT /api/lawfirms/:lawFirmId/tasks/:taskId/subtasks/:subtaskId (Update a subtask)
router.put('/:taskId/subtasks/:subtaskId',
  verifyToken,
  requirePermission('tasks.update'),
  validate(updateSubtaskSchema),
  handler(async (req) => taskSubtasksService.updateSubtask({
    lawFirmId: req.params.lawFirmId,
    taskId: req.params.taskId,
    subtaskId: req.params.subtaskId,
    userId: req.user.uid,
    title: req.body.title,
    isCompleted: req.body.isCompleted,
    assigneeUserId: req.body.assigneeUserId,
    sortOrder: req.body.sortOrder,
  }))
);

// DELETE /api/lawfirms/:lawFirmId/tasks/:taskId/subtasks/:subtaskId (Delete a subtask)
router.delete('/:taskId/subtasks/:subtaskId',
  verifyToken,
  requirePermission('tasks.update'),
  handler(async (req) => taskSubtasksService.deleteSubtask({
    lawFirmId: req.params.lawFirmId,
    taskId: req.params.taskId,
    subtaskId: req.params.subtaskId,
    userId: req.user.uid,
  }))
);

export = router;
