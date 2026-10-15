import type { DrizzleExecutor } from '../../../shared/database/queryContext';
const categoriesRepo = require('./matterCategories.repository');
const { assertLawFirmMembership } = require('../../../shared/utils/membership');

function badRequest(msg: any) { return Object.assign(new Error(msg), { statusCode: 400 }); }
function notFound(msg: any) { return Object.assign(new Error(msg), { statusCode: 404 }); }

async function buildCategoryPath(lawFirmId: string, parentId: any, transaction?: DrizzleExecutor) {
  if (!parentId) return null;
  const parent = await categoriesRepo.findById(lawFirmId, parentId, transaction);
  if (!parent) throw notFound('Parent category not found');
  return parent.path || parent.name;
}

async function calculateCategoryLevel(lawFirmId: string, parentId: any, transaction?: DrizzleExecutor) {
  if (!parentId) return 0;
  const parent = await categoriesRepo.findById(lawFirmId, parentId, transaction);
  if (!parent) throw notFound('Parent category not found');
  return (parent.level || 0) + 1;
}

/**
 * List categories as a flat list sorted by level then name.
 */
export async function listCategories({ lawFirmId, userId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  const categories = (await categoriesRepo.findAll(lawFirmId)).sort((a: any, b: any) => {
    if (a.level !== b.level) return a.level - b.level;
    return a.name.localeCompare(b.name);
  });

  return { categories };
}

/**
 * List categories as a nested tree structure.
 */
export async function listCategoriesTree({ lawFirmId, userId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  const all = await categoriesRepo.findAll(lawFirmId);
  const categoryMap = new Map();
  const rootCategories: any[] = [];

  all.forEach((c: any) => categoryMap.set(c.id, { ...c, children: [] }));

  categoryMap.forEach((category) => {
    if (category.parentId && categoryMap.has(category.parentId)) {
      categoryMap.get(category.parentId).children.push(category);
    } else {
      rootCategories.push(category);
    }
  });

  function sortTree(cats: any) {
    cats.sort((a: any, b: any) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.name.localeCompare(b.name);
    });
    cats.forEach((cat: any) => { if (cat.children.length > 0) sortTree(cat.children); });
  }
  sortTree(rootCategories);

  return { categories: rootCategories };
}

/**
 * Create a new category.
 */
export async function createCategory({ lawFirmId, userId, body }: any) {
  const { name, parentId } = body;
  await assertLawFirmMembership(lawFirmId, userId);
  return categoriesRepo.withCategoryTreeTransaction(lawFirmId, async (transaction: DrizzleExecutor) => {
    const trimmedName = name.trim();
    const normalizedParentId = parentId || null;

    const existing = await categoriesRepo.findByNameAndParent(lawFirmId, trimmedName, normalizedParentId, transaction);
    if (existing.length) throw badRequest('A category with this name already exists at this level');

    const level = await calculateCategoryLevel(lawFirmId, normalizedParentId, transaction);
    const parentPath = await buildCategoryPath(lawFirmId, normalizedParentId, transaction);
    const fullPath = parentPath ? `${parentPath} > ${trimmedName}` : trimmedName;

    const siblings = await categoriesRepo.findChildren(lawFirmId, normalizedParentId, transaction);
    const order = siblings.length ? Math.max(...siblings.map((s: any) => s.order || 0)) + 1 : 0;

    const category = await categoriesRepo.create(lawFirmId, {
      name: trimmedName,
      parentId: normalizedParentId,
      path: fullPath,
      level,
      order,
      createdBy: userId,
    }, transaction);

    return { message: 'Category created successfully', category };
  });
}

/**
 * Update a category (name, parent, order).
 */
export async function updateCategory({ lawFirmId, categoryId, userId, body }: any) {
  const { name, parentId, order } = body;
  await assertLawFirmMembership(lawFirmId, userId);
  return categoriesRepo.withCategoryTreeTransaction(lawFirmId, async (transaction: DrizzleExecutor) => {
    const current = await categoriesRepo.findById(lawFirmId, categoryId, transaction);
    if (!current) throw notFound('Category not found');

    const patch: Record<string, any> = {};

    if ((name !== undefined && name.trim() !== current.name) || parentId !== undefined) {
      const trimmedName = name !== undefined ? name.trim() : current.name;
      const checkParentId = parentId !== undefined ? (parentId || null) : (current.parentId || null);
      const existing = await categoriesRepo.findByNameAndParent(lawFirmId, trimmedName, checkParentId, transaction);
      if (existing.some((c: any) => c.id !== categoryId)) {
        throw badRequest('A category with this name already exists at this level');
      }
      if (trimmedName !== current.name) patch.name = trimmedName;
    }

    let needsPathRecalc = false;
    if (parentId !== undefined) {
      const newParentId = parentId || null;
      if (newParentId === categoryId) throw badRequest('A category cannot be its own parent');

      let ancestorId = newParentId;
      const ancestors = new Set<string>();
      while (ancestorId) {
        if (ancestorId === categoryId || ancestors.has(ancestorId)) throw badRequest('Cannot move category: would create circular reference');
        ancestors.add(ancestorId);
        // eslint-disable-next-line no-await-in-loop
        const ancestor = await categoriesRepo.findById(lawFirmId, ancestorId, transaction);
        if (!ancestor) throw notFound('Parent category not found');
        ancestorId = ancestor.parentId || null;
      }

      if (newParentId !== (current.parentId || null)) {
        patch.parentId = newParentId;
        needsPathRecalc = true;
      }
    }

    if (order !== undefined) patch.order = order;

    const pathChanges = new Map<string, string>();
    if (needsPathRecalc || (name !== undefined && name.trim() !== current.name)) {
      const finalParentId = patch.parentId !== undefined ? patch.parentId : (current.parentId || null);
      const finalName = patch.name || current.name;
      const level = await calculateCategoryLevel(lawFirmId, finalParentId, transaction);
      const parentPath = await buildCategoryPath(lawFirmId, finalParentId, transaction);
      const fullPath = parentPath ? `${parentPath} > ${finalName}` : finalName;

      patch.level = level;
      patch.path = fullPath;
      pathChanges.set(current.path || current.name, fullPath);

      const visited = new Set<string>([categoryId]);
      async function rewriteChildren(parent: string, path: string, depth: number): Promise<void> {
        const children = await categoriesRepo.findChildren(lawFirmId, parent, transaction);
        for (const desc of children) {
          if (visited.has(desc.id)) throw badRequest('Cannot update a circular category tree');
          visited.add(desc.id);
          const childPath = `${path} > ${desc.name}`;
          pathChanges.set(desc.path || desc.name, childPath);
          await categoriesRepo.update(lawFirmId, desc.id, { path: childPath, level: depth + 1 }, transaction);
          await rewriteChildren(desc.id, childPath, depth + 1);
        }
      }
      await rewriteChildren(categoryId, fullPath, level);
    }

    const category = await categoriesRepo.update(lawFirmId, categoryId, patch, transaction);
    await categoriesRepo.rewriteMatterCategoryPaths(lawFirmId, pathChanges, transaction);
    return { message: 'Category updated successfully', category };
  });
}

/**
 * Delete a category (only if no children and not in use by matters).
 */
export async function deleteCategory({ lawFirmId, categoryId, userId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  return categoriesRepo.withCategoryTreeTransaction(lawFirmId, async (transaction: DrizzleExecutor) => {
    const children = await categoriesRepo.findChildren(lawFirmId, categoryId, transaction);
    if (children.length) {
      throw badRequest('Cannot delete category: it has subcategories. Please delete or move subcategories first.');
    }

    const category = await categoriesRepo.findById(lawFirmId, categoryId, transaction);
    if (!category) throw notFound('Category not found');

    const categoryPath = category.path || category.name;
    if (await categoriesRepo.matterUsesCategory(lawFirmId, categoryPath, transaction)) {
      throw badRequest('Cannot delete category: it is in use by one or more matters.');
    }

    await categoriesRepo.remove(lawFirmId, categoryId, transaction);
    return { message: 'Category deleted successfully' };
  });
}
