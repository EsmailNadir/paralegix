import type { FileInfo } from '@/services/files.service';

/**
 * One step in the trail from a scope's root to the folder on screen.
 *
 * The browser navigates by id: the tree lives in each row's `parent_id`, so
 * opening a folder is "show me the children of this id" rather than "append this
 * name to where I am standing". The name is carried alongside only because the
 * breadcrumb renders it.
 *
 * This file used to hold the rules for turning a row on screen into the storage
 * path that addressed it, and they were subtle enough to get wrong at every call
 * site: a search hit had to be addressed from its own folder rather than the one
 * being browsed, and a folder had to carry a `.folder` marker suffix. Neither
 * exists now, because a row is addressed by its id wherever it was found.
 */
export interface FolderCrumb {
  id: string;
  name: string;
}

/**
 * Rows in display order: folders first, then files, each alphabetical.
 */
export function sortFileRows(files: FileInfo[]): FileInfo[] {
  return [...files].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
