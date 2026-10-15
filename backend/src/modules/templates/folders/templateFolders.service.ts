const templateFoldersRepo = require('./templateFolders.repository');
const { NotFoundError, ConflictError, ValidationError } = require('../../../shared/errors/AppError');
const { ts } = require('../templateTime');

const normalizeParentFolderId = (value: any) => value || null;

function formatFolder(doc: any) {
  return {
    id: doc.id,
    name: doc.name,
    color: doc.color || null,
    parentFolderId: normalizeParentFolderId(doc.parentFolderId),
    order: doc.order ?? 0,
    createdAt: ts(doc.createdAt),
  };
}

function isSameParent(left: any, right: any) {
  return normalizeParentFolderId(left) === normalizeParentFolderId(right);
}

function findSiblingNameConflict({ folders, parentFolderId, name, excludeId = null }: any) {
  const normalizedName = name.trim().toLowerCase();

  return folders.find((folder: any) => (
    folder.id !== excludeId &&
    isSameParent(folder.parentFolderId, parentFolderId) &&
    folder.name?.trim?.().toLowerCase?.() === normalizedName
  )) || null;
}

function ensureParentExists(folders: any, parentFolderId: any) {
  if (!parentFolderId) return null;

  const parent = folders.find((folder: any) => folder.id === parentFolderId) || null;
  if (!parent) throw new NotFoundError('Parent folder');
  return parent;
}

function ensureNoCycle(folders: any, folderId: any, nextParentFolderId: any) {
  if (!nextParentFolderId) return;
  if (nextParentFolderId === folderId) {
    throw new ValidationError([
      { path: 'parentFolderId', message: 'A folder cannot be its own parent' },
    ]);
  }

  const byId = new Map(folders.map((folder: any) => [folder.id, folder]));
  // Guard against a parent chain that already contains a cycle (possible via
  // racing move requests); without it this walk would spin forever and pin the
  // event loop.
  const visited = new Set();
  let cursor = nextParentFolderId;

  while (cursor) {
    if (cursor === folderId) {
      throw new ValidationError([
        { path: 'parentFolderId', message: 'A folder cannot be moved inside one of its descendants' },
      ]);
    }
    if (visited.has(cursor)) return;
    visited.add(cursor);

    cursor = normalizeParentFolderId((byId.get(cursor) as any)?.parentFolderId);
  }
}

function getNextSiblingOrder(folders: any, parentFolderId: any, excludeId = null) {
  const siblingOrders = folders
    .filter((folder: any) => folder.id !== excludeId && isSameParent(folder.parentFolderId, parentFolderId))
    .map((folder: any) => folder.order ?? 0);

  return siblingOrders.length > 0 ? Math.max(...siblingOrders) + 1 : 0;
}

/**
 * List all template folders for a law firm.
 */
export async function listFolders({ lawFirmId }: any) {
  const docs = await templateFoldersRepo.listByLawFirm(lawFirmId);
  const folders = docs.map(formatFolder);
  return { folders, totalFolders: folders.length };
}

/**
 * Create a new template folder.
 */
export async function createFolder({ lawFirmId, name, color, parentFolderId }: any) {
  const all = await templateFoldersRepo.listByLawFirm(lawFirmId);
  const trimmedName = name.trim();
  const normalizedParentFolderId = normalizeParentFolderId(parentFolderId);

  ensureParentExists(all, normalizedParentFolderId);

  const existing = findSiblingNameConflict({
    folders: all,
    parentFolderId: normalizedParentFolderId,
    name: trimmedName,
  });
  if (existing) throw new ConflictError('A folder with that name already exists here');

  const created = await templateFoldersRepo.create(lawFirmId, {
    name: trimmedName,
    color: color || null,
    parentFolderId: normalizedParentFolderId,
    order: getNextSiblingOrder(all, normalizedParentFolderId),
  });

  return { message: 'Folder created successfully', folderId: created.id, folder: formatFolder(created) };
}

/**
 * Update a template folder.
 */
export async function updateFolder({ lawFirmId, folderId, name, color, parentFolderId }: any) {
  const existing = await templateFoldersRepo.findById(lawFirmId, folderId);
  if (!existing) throw new NotFoundError('Folder');

  const all = await templateFoldersRepo.listByLawFirm(lawFirmId);
  const nextParentFolderId =
    parentFolderId !== undefined
      ? normalizeParentFolderId(parentFolderId)
      : normalizeParentFolderId(existing.parentFolderId);
  const nextName = name !== undefined ? name.trim() : existing.name;

  ensureParentExists(all, nextParentFolderId);
  ensureNoCycle(all, folderId, nextParentFolderId);

  const updates: Record<string, any> = {};
  const parentChanged = parentFolderId !== undefined && nextParentFolderId !== normalizeParentFolderId(existing.parentFolderId);
  const nameChanged = name !== undefined && nextName !== existing.name;

  if (nameChanged || parentChanged) {
    const dupe = findSiblingNameConflict({
      folders: all,
      parentFolderId: nextParentFolderId,
      name: nextName,
      excludeId: folderId,
    });
    if (dupe) throw new ConflictError('A folder with that name already exists here');
  }

  if (name !== undefined) {
    updates.name = nextName;
  }
  if (color !== undefined) updates.color = color || null;
  if (parentFolderId !== undefined) {
    updates.parentFolderId = nextParentFolderId;
  }
  if (parentChanged) {
    updates.order = getNextSiblingOrder(all, nextParentFolderId, folderId);
  }

  const updated = await templateFoldersRepo.update(lawFirmId, folderId, updates);
  const folder = formatFolder({ ...existing, ...updated });

  return { message: 'Folder updated successfully', folder };
}

/**
 * Delete a template folder. Reparents direct children and moves templates up one level.
 */
export async function deleteFolder({ lawFirmId, folderId }: any) {
  const existing = await templateFoldersRepo.findById(lawFirmId, folderId);
  if (!existing) throw new NotFoundError('Folder');

  const allFolders = await templateFoldersRepo.listByLawFirm(lawFirmId);
  const destinationParentFolderId = normalizeParentFolderId(existing.parentFolderId);
  const childOrderStart = getNextSiblingOrder(allFolders, destinationParentFolderId, folderId);

  // Reparent templates + child folders up one level (to the deleted folder's
  // parent, or null if it was top-level) and delete the folder, all in one
  // transaction. Replaces the previous per-row UPDATE loop. Child folders keep
  // their relative order but are renumbered to slot after the destination's
  // existing siblings, matching the old getNextSiblingOrder incrementing loop.
  const { movedTemplateCount, reparentedFolderCount } = await templateFoldersRepo.deleteWithReparent(
    lawFirmId,
    folderId,
    destinationParentFolderId,
    childOrderStart,
  );

  return {
    message: 'Folder deleted successfully',
    folderId,
    movedTemplateCount,
    reparentedFolderCount,
  };
}
