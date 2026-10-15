const { NotFoundError, ForbiddenError } = require('../../../shared/errors/AppError');
const { dayAnchor } = require('../../../shared/utils/time');
const { resolveContext, authorizeContext, CONTEXT_TYPES, MODE_READ } = require('../context');
const expensesRepo = require('./expenses.repository');
const invoicesRepo = require('../invoices/invoices.repository');
const billingReads = require('../shared/billingReads');
const { assertBillingCodeInFirm } = require('../shared/billingCodeGuard');
const usersRepo = require('../../users/users.repository');

/**
 * Anchor a day-only 'YYYY-MM-DD' string at noon UTC before constructing a Date,
 * so downstream formatting/serialization never rolls the date back a day for a
 * server or client running behind UTC. `new Date('2026-07-20')` is UTC midnight,
 * which is the previous day everywhere west of UTC. Uses the same `dayAnchor`
 * as every other day-only value.
 */
function dayOnlyToDate(value: any) {
  if (!value) return null;
  return dayAnchor(String(value));
}

function formatExpense(expense: any) {
  return {
    id: expense.id,
    description: expense.description || '',
    amount: expense.amount || 0,
    date: expense.date || null,
    category: expense.category || '',
    expenseCategoryId: expense.expenseCategoryId || null,
    vendor: expense.vendor || '',
    billable: expense.billable !== false,
    receiptUrl: expense.receiptUrl || null,
    userId: expense.userId || null,
    userName: expense.userName || null,
    createdBy: expense.createdBy || null,
    contextType: expense.contextType || null,
    entityId: expense.entityId || null,
    matterId: expense.matterId || null,
    clientContextId: expense.clientContextId || null,
    clientId: expense.clientId || null,
    createdAt: expense.createdAt || null,
    updatedAt: expense.updatedAt || null,
  };
}

/**
 * Create an expense for a matter or client context.
 */
export async function createExpense({ lawFirmId, matterId, clientId, actingUserId, body }: any) {
  const resolvedContext = resolveContext({
    lawFirmId,
    context: body.context,
    matterId: matterId || body.matterId,
    clientId: clientId || body.clientId,
  });
  await authorizeContext(resolvedContext, actingUserId);
  await assertBillingCodeInFirm('expense', lawFirmId, body.expenseCategoryId || null, 'expenseCategoryId');

  // Resolve the acting user's display name. Names are no longer denormalized
  // onto the members row (they live on the users table), so the name is read
  // from the users record regardless of firm-member status.
  const actingUser = await usersRepo.findById(actingUserId);
  const userName = actingUser?.name || '';

  const expenseData = {
    lawFirmId,
    contextType: resolvedContext.type,
    entityId: resolvedContext.entityId,
    matterId: resolvedContext.type === CONTEXT_TYPES.matter ? resolvedContext.entityId : null,
    clientContextId: resolvedContext.type === CONTEXT_TYPES.client ? resolvedContext.entityId : null,
    clientId: resolvedContext.type === CONTEXT_TYPES.client ? resolvedContext.entityId : null,
    description: (body.description || '').trim(),
    amount: parseFloat(body.amount) || 0,
    date: dayOnlyToDate(body.date),
    category: (body.category || '').trim(),
    expenseCategoryId: body.expenseCategoryId || null,
    vendor: (body.vendor || '').trim(),
    billable: body.billable !== false,
    receiptUrl: body.receiptUrl || null,
    userId: actingUserId,
    userName,
    createdBy: actingUserId,
  };

  const expense = await expensesRepo.create(resolvedContext, expenseData);

  return {
    message: 'Expense created successfully',
    expenseId: expense.id,
    expense: formatExpense(expense),
  };
}

/**
 * List expenses for a matter or client context.
 */
export async function listExpenses({ lawFirmId, matterId, clientId, actingUserId }: any) {
  const resolvedContext = resolveContext({ lawFirmId, matterId, clientId });
  await authorizeContext(resolvedContext, actingUserId, MODE_READ);

  // One query against the line items instead of loading every invoice in the
  // context and walking its graph. Same definition — the graph's line items are
  // these rows. See `billedSourceIds`.
  const [expenses, billedExpenseIds] = await Promise.all([
    expensesRepo.findAll(resolvedContext),
    billingReads.billedSourceIds(resolvedContext, 'expense'),
  ]);

  return {
    expenses: expenses.map((expense: any) => ({
      ...formatExpense(expense),
      isBilled: billedExpenseIds.has(expense.id),
    })),
  };
}

/**
 * Update an expense.
 */
export async function updateExpense({ lawFirmId, matterId, clientId, expenseId, actingUserId, body }: any) {
  const resolvedContext = resolveContext({ lawFirmId, matterId, clientId });
  await authorizeContext(resolvedContext, actingUserId);

  const existing = await expensesRepo.findById(resolvedContext, expenseId);
  if (!existing) {
    throw new NotFoundError('Expense');
  }

  // An invoiced expense exists on the invoice as a line-item snapshot. Editing the
  // fields that snapshot was built from would diverge the firm's records from the
  // client's issued invoice, which is the same reason deleteExpense blocks
  // outright. Descriptive fields (description, category, vendor, receipt) stay
  // editable: they do not change what was charged.
  const FROZEN_ONCE_BILLED = ['amount', 'date', 'billable'];
  const attemptedFrozenEdits = FROZEN_ONCE_BILLED.filter((field) => body[field] !== undefined);
  if (attemptedFrozenEdits.length > 0
      && await billingReads.isSourceBilled(resolvedContext, 'expense', [existing.id])) {
    throw new ForbiddenError('Cannot change the amount, date, or billable flag of an expense that has been billed on an invoice');
  }

  const updateData: Record<string, any> = {};
  if (body.description !== undefined) updateData.description = body.description.trim();
  if (body.amount !== undefined) updateData.amount = parseFloat(body.amount) || 0;
  if (body.date !== undefined) {
    updateData.date = dayOnlyToDate(body.date);
  }
  if (body.category !== undefined) updateData.category = (body.category || '').trim();
  if (body.expenseCategoryId !== undefined) {
    await assertBillingCodeInFirm('expense', lawFirmId, body.expenseCategoryId || null, 'expenseCategoryId');
    updateData.expenseCategoryId = body.expenseCategoryId || null;
  }
  if (body.vendor !== undefined) updateData.vendor = (body.vendor || '').trim();
  if (body.billable !== undefined) updateData.billable = body.billable;
  if (body.receiptUrl !== undefined) updateData.receiptUrl = body.receiptUrl || null;

  const updated = await expensesRepo.update(resolvedContext, expenseId, updateData);
  return { message: 'Expense updated successfully', expense: formatExpense(updated) };
}

/**
 * Delete an expense.
 */
export async function deleteExpense({ lawFirmId, matterId, clientId, expenseId, actingUserId }: any) {
  const resolvedContext = resolveContext({ lawFirmId, matterId, clientId });
  await authorizeContext(resolvedContext, actingUserId);

  const existing = await expensesRepo.findById(resolvedContext, expenseId);
  if (!existing) {
    throw new NotFoundError('Expense');
  }

  // Block deletion of a billed expense: it lives on an issued invoice as a line
  // item, so removing the source would diverge the firm's records from the
  // client's invoice. The source `is_billed` column is not maintained, so the
  // authoritative signal is an invoice line item pointing back at this expense.
  if (await billingReads.isSourceBilled(resolvedContext, 'expense', [existing.id])) {
    throw new ForbiddenError('Cannot delete a billed expense');
  }

  await expensesRepo.delete(resolvedContext, expenseId);
  return { message: 'Expense deleted successfully', expenseId };
}
