const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');
const { createExpenseSchema, updateExpenseSchema } = require('./expenses.validation');
const expensesService = require('./expenses.service');
import { handler } from '../../../shared/http/handler';

// POST /api/lawfirms/:lawFirmId/billing/expenses
router.post('/',
  verifyToken,
  requirePermission('billing.manageExpenses'),
  validate(createExpenseSchema),
  handler(async (req) => expensesService.createExpense({
    lawFirmId: req.params.lawFirmId,
    matterId: req.body.matterId,
    clientId: req.body.clientId,
    actingUserId: req.user.uid,
    body: req.body,
  }), 201),
);

// GET /api/lawfirms/:lawFirmId/billing/expenses/matter/:matterId
router.get('/matter/:matterId',
  verifyToken,
  requirePermission('billing.viewExpenses'),
  handler(async (req) => expensesService.listExpenses({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    actingUserId: req.user.uid,
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/expenses/client/:clientId
router.get('/client/:clientId',
  verifyToken,
  requirePermission('billing.viewExpenses'),
  handler(async (req) => expensesService.listExpenses({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    actingUserId: req.user.uid,
  })),
);

// PUT /api/lawfirms/:lawFirmId/billing/expenses/matter/:matterId/:expenseId
router.put('/matter/:matterId/:expenseId',
  verifyToken,
  requirePermission('billing.manageExpenses'),
  validate(updateExpenseSchema),
  handler(async (req) => expensesService.updateExpense({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    expenseId: req.params.expenseId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// PUT /api/lawfirms/:lawFirmId/billing/expenses/client/:clientId/:expenseId
router.put('/client/:clientId/:expenseId',
  verifyToken,
  requirePermission('billing.manageExpenses'),
  validate(updateExpenseSchema),
  handler(async (req) => expensesService.updateExpense({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    expenseId: req.params.expenseId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/billing/expenses/matter/:matterId/:expenseId
router.delete('/matter/:matterId/:expenseId',
  verifyToken,
  requirePermission('billing.manageExpenses'),
  handler(async (req) => expensesService.deleteExpense({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    expenseId: req.params.expenseId,
    actingUserId: req.user.uid,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/billing/expenses/client/:clientId/:expenseId
router.delete('/client/:clientId/:expenseId',
  verifyToken,
  requirePermission('billing.manageExpenses'),
  handler(async (req) => expensesService.deleteExpense({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    expenseId: req.params.expenseId,
    actingUserId: req.user.uid,
  })),
);

export = router;
