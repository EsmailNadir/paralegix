import type { TemplateFolder } from "@/types/template";

/** The order folders are listed in: the firm's own ordering, then by name. */
function compareFolders(left: TemplateFolder, right: TemplateFolder) {
  if ((left.order ?? 0) !== (right.order ?? 0)) {
    return (left.order ?? 0) - (right.order ?? 0);
  }

  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
}

// Walks parent links from the given folder up to the top level. The visited set
// guards against malformed parent cycles so this can never loop forever.
export function buildFolderPath(
  folderById: Map<string, TemplateFolder>,
  folderId: string | null
): TemplateFolder[] {
  const path: TemplateFolder[] = [];
  const visited = new Set<string>();
  let cursorId = folderId;

  while (cursorId && !visited.has(cursorId)) {
    const folder = folderById.get(cursorId);
    if (!folder) break;
    path.unshift(folder);
    visited.add(cursorId);
    cursorId = folder.parentFolderId ?? null;
  }

  return path;
}

export function folderPathLabel(
  folderById: Map<string, TemplateFolder>,
  folderId: string | null
): string {
  const path = buildFolderPath(folderById, folderId);
  return path.length > 0 ? path.map((folder) => folder.name).join(" / ") : "Root";
}

/**
 * Folders bucketed by their parent id and sorted within each bucket, so a view
 * can render the library's shape without re-scanning the flat list per level.
 *
 * A folder whose parent is missing from the list is bucketed as top level so it
 * stays reachable instead of disappearing into a branch that is never rendered.
 */
export function groupFoldersByParent(
  folders: TemplateFolder[]
): Map<string | null, TemplateFolder[]> {
  const known = new Set(folders.map((folder) => folder.id));
  const buckets = new Map<string | null, TemplateFolder[]>();

  for (const folder of folders) {
    const parentId = folder.parentFolderId ?? null;
    const key = parentId && known.has(parentId) ? parentId : null;
    const bucket = buckets.get(key) ?? [];
    bucket.push(folder);
    buckets.set(key, bucket);
  }

  for (const bucket of buckets.values()) {
    bucket.sort(compareFolders);
  }

  return buckets;
}

/**
 * Whether `folderId` is `ancestorId` or sits anywhere beneath it. A null
 * ancestor is the root, which contains everything. The visited set guards
 * against malformed parent cycles.
 */
export function isFolderWithin(
  folderById: Map<string, TemplateFolder>,
  folderId: string | null,
  ancestorId: string | null
): boolean {
  if (ancestorId === null) return true;

  const visited = new Set<string>();
  let cursorId = folderId;

  while (cursorId && !visited.has(cursorId)) {
    if (cursorId === ancestorId) return true;
    visited.add(cursorId);
    cursorId = folderById.get(cursorId)?.parentFolderId ?? null;
  }

  return false;
}
