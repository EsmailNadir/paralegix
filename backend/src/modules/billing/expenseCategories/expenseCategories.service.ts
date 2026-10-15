const { assertLawFirmMembership } = require('../../../shared/utils/membership');
const { NotFoundError, ValidationError } = require('../../../shared/errors/AppError');
const expenseCategoriesRepo = require('./expenseCategories.repository');
const { DEFAULT_EXPENSE_CATEGORIES } = require('../../../shared/referenceData/defaults');

/**
 * Seed default expense categories if the collection is empty.
 */
async function seedDefaults(lawFirmId: string, actingUserId: string) {
  const existing = await expenseCategoriesRepo.findAll(lawFirmId);
  if (existing.length > 0) return;

  await expenseCategoriesRepo.createManyIfAbsent(
    lawFirmId,
    DEFAULT_EXPENSE_CATEGORIES.map((cat: any, i: number) => ({
      code: cat.code,
      name: cat.name,
      isDefault: true,
      isActive: true,
      order: i + 1,
      createdBy: actingUserId,
    })),
  );
}

/**
 * List expense categories for a law firm.
 * Lazy-seeds defaults if collection is empty.
 * Optionally include inactive categories.
 */
export async function listExpenseCategories({ lawFirmId, actingUserId, includeInactive }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  // Lazy-seed defaults if collection is empty
  let categories = await expenseCategoriesRepo.findAll(lawFirmId);
  if (categories.length === 0) {
    await seedDefaults(lawFirmId, actingUserId);
    categories = await expenseCategoriesRepo.findAll(lawFirmId);
  }

  if (!includeInactive) {
    categories = categories.filter((ec: any) => ec.isActive === true);
  }

  // Sort by order, then by code
  categories.sort((a: any, b: any) => {
    if (a.order !== b.order) return a.order - b.order;
    return (a.code || '').localeCompare(b.code || '');
  });

  return { expenseCategories: categories };
}

/**
 * Get a single expense category by ID.
 */
export async function getExpenseCategory({ lawFirmId, expenseCategoryId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const category = await expenseCategoriesRepo.findById(lawFirmId, expenseCategoryId);
  if (!category) {
    throw new NotFoundError('Expense category');
  }

  return category;
}

/**
 * Create an expense category.
 */
export async function createExpenseCategory({ lawFirmId, actingUserId, body }: any) {
  const { code, name } = body;

  await assertLawFirmMembership(lawFirmId, actingUserId);

  // Check uniqueness
  const existing = await expenseCategoriesRepo.findByCode(lawFirmId, code);
  if (existing.length > 0) {
    throw new ValidationError('Expense category code already exists');
  }

  const nextOrder = (await expenseCategoriesRepo.getMaxOrder(lawFirmId)) + 1;

  const category = await expenseCategoriesRepo.create(lawFirmId, {
    lawFirmId,
    code: code.toUpperCase(),
    name: name.trim(),
    isDefault: false,
    isActive: true,
    order: nextOrder,
    createdBy: actingUserId,
  });

  return { message: 'Expense category created successfully', expenseCategoryId: category.id };
}

/**
 * Update an expense category.
 */
export async function updateExpenseCategory({ lawFirmId, expenseCategoryId, actingUserId, body }: any) {
  const { code, name, isActive } = body;

  await assertLawFirmMembership(lawFirmId, actingUserId);

  const existing = await expenseCategoriesRepo.findById(lawFirmId, expenseCategoryId);
  if (!existing) {
    throw new NotFoundError('Expense category');
  }

  const updateData: Record<string, any> = {};

  if (code !== undefined) {
    const upperCode = code.toUpperCase();
    // Check uniqueness excluding this document
    const dupes = await expenseCategoriesRepo.findByCode(lawFirmId, upperCode);
    const conflicts = dupes.filter((d: any) => d.id !== expenseCategoryId);
    if (conflicts.length > 0) {
      throw new ValidationError('Expense category code already exists');
    }
    updateData.code = upperCode;
  }

  if (name !== undefined) updateData.name = name.trim();
  if (isActive !== undefined) updateData.isActive = isActive;

  await expenseCategoriesRepo.update(lawFirmId, expenseCategoryId, updateData);
  return { message: 'Expense category updated successfully' };
}

/**
 * Delete an expense category.
 * Fails if the category is referenced by any expense. Suggests deactivating instead.
 */
export async function deleteExpenseCategory({ lawFirmId, expenseCategoryId, actingUserId }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);

  const existing = await expenseCategoriesRepo.findById(lawFirmId, expenseCategoryId);
  if (!existing) {
    throw new NotFoundError('Expense category');
  }

  // Check if any expenses reference this category (single relational query).
  if (await expenseCategoriesRepo.isInUse(lawFirmId, expenseCategoryId)) {
    throw new ValidationError('Cannot delete expense category. It is being used in expenses. Please deactivate it instead.');
  }

  await expenseCategoriesRepo.delete(lawFirmId, expenseCategoryId);
  return { message: 'Expense category deleted successfully' };
}

/**
 * Reorder expense categories.
 */
export async function reorderExpenseCategories({ lawFirmId, actingUserId, body }: any) {
  const { expenseCategoryIds } = body;

  await assertLawFirmMembership(lawFirmId, actingUserId);
  await expenseCategoriesRepo.reorder(lawFirmId, expenseCategoryIds);
  return { message: 'Expense categories reordered successfully' };
}
