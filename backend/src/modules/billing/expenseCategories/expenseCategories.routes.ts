const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');
const {
  createExpenseCategorySchema,
  updateExpenseCategorySchema,
  reorderExpenseCategoriesSchema,
} = require('./expenseCategories.validation');
const expenseCategoriesService = require('./expenseCategories.service');
import { handler } from '../../../shared/http/handler';

// PUT /api/lawfirms/:lawFirmId/billing/expense-categories/reorder
// (must be before /:expenseCategoryId to avoid route conflict)
router.put('/reorder',
  verifyToken,
  requirePermission('billing.manageRates'),
  validate(reorderExpenseCategoriesSchema),
  handler(async (req) => expenseCategoriesService.reorderExpenseCategories({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/expense-categories
router.get('/',
  verifyToken,
  requirePermission('billing.viewRates'),
  handler(async (req) => expenseCategoriesService.listExpenseCategories({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    includeInactive: req.query.includeInactive === 'true',
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/expense-categories/:expenseCategoryId
router.get('/:expenseCategoryId',
  verifyToken,
  requirePermission('billing.viewRates'),
  handler(async (req) => expenseCategoriesService.getExpenseCategory({
    lawFirmId: req.params.lawFirmId,
    expenseCategoryId: req.params.expenseCategoryId,
    actingUserId: req.user.uid,
  })),
);

// POST /api/lawfirms/:lawFirmId/billing/expense-categories
router.post('/',
  verifyToken,
  requirePermission('billing.manageRates'),
  validate(createExpenseCategorySchema),
  handler(async (req) => expenseCategoriesService.createExpenseCategory({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    body: req.body,
  }), 201),
);

// PUT /api/lawfirms/:lawFirmId/billing/expense-categories/:expenseCategoryId
router.put('/:expenseCategoryId',
  verifyToken,
  requirePermission('billing.manageRates'),
  validate(updateExpenseCategorySchema),
  handler(async (req) => expenseCategoriesService.updateExpenseCategory({
    lawFirmId: req.params.lawFirmId,
    expenseCategoryId: req.params.expenseCategoryId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/billing/expense-categories/:expenseCategoryId
router.delete('/:expenseCategoryId',
  verifyToken,
  requirePermission('billing.manageRates'),
  handler(async (req) => expenseCategoriesService.deleteExpenseCategory({
    lawFirmId: req.params.lawFirmId,
    expenseCategoryId: req.params.expenseCategoryId,
    actingUserId: req.user.uid,
  })),
);

export = router;
