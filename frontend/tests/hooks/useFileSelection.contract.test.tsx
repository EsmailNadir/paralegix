/**
 * Contract coverage for the file browser's selection state.
 *
 * This hook holds no network state (no fetching, no query key, no mutation of
 * its own), so most of the ten-item hook contract does not apply to it. What
 * does apply is "stale selection after a move or a delete": a selection is
 * state that outlives the rows it was made against.
 *
 * It used to hold object PATHS, which were deterministic (the parent folder
 * plus the name), so a path a rename freed could be reused by a completely
 * different row later in the same folder, and that row came back
 * phantom-selected. Ids cannot be reused that way, which makes the last case
 * below a boundary rather than a defect: the same NAME must not bring a
 * selection back.
 */
import { act, renderHook } from '@testing-library/react';

import { useFileSelection } from '@/hooks/fileHooks/useFileSelection';
import type { FileInfo } from '@/services/files.service';

let nextId = 0;

function makeFile(name: string, overrides: Partial<FileInfo> = {}): FileInfo {
  nextId += 1;
  const id = `file-${nextId}`;
  return {
    id,
    parentId: 'folder-1',
    name,
    objectPath: `lawfirmids/firm-1/objects/${id}`,
    size: 0,
    contentType: 'application/octet-stream',
    updated: '2026-01-01T00:00:00.000Z',
    signedUrl: '',
    isFolder: false,
    ...overrides,
  };
}

describe('useFileSelection contract', () => {
  it('starts with nothing selected', () => {
    const { result } = renderHook(() => useFileSelection([], 'loc-1'));

    expect(result.current.selectedCount).toBe(0);
    expect(result.current.selectedItems).toEqual([]);
    expect(result.current.allSelected).toBe(false);
  });

  it('toggle adds and removes a row from the selection', () => {
    const fileA = makeFile('a.pdf');
    const fileB = makeFile('b.pdf');
    const { result } = renderHook(
      ({ files }: { files: FileInfo[] }) => useFileSelection(files, 'loc-1'),
      { initialProps: { files: [fileA, fileB] } },
    );

    act(() => result.current.toggle(fileA));
    expect(result.current.selectedCount).toBe(1);
    expect(result.current.selectedIds.has(fileA.id)).toBe(true);

    act(() => result.current.toggle(fileA));
    expect(result.current.selectedCount).toBe(0);
  });

  it('intersects the selection with the rows currently on screen', () => {
    const fileA = makeFile('a.pdf');
    const fileB = makeFile('b.pdf');
    const { result, rerender } = renderHook(
      ({ files }: { files: FileInfo[] }) => useFileSelection(files, 'loc-1'),
      { initialProps: { files: [fileA, fileB] } },
    );

    act(() => {
      result.current.toggle(fileA);
      result.current.toggle(fileB);
    });
    expect(result.current.selectedCount).toBe(2);

    // A search narrows the rows on screen without moving the browser
    // (locationKey unchanged in this hook's contract - FileBrowser folds the
    // active query into its own locationKey separately).
    rerender({ files: [fileA] });
    expect(result.current.selectedCount).toBe(1);
    expect(result.current.selectedItems.map((f) => f.name)).toEqual(['a.pdf']);
  });

  it('toggleAll selects every visible row, and toggling again clears them', () => {
    const fileA = makeFile('a.pdf');
    const fileB = makeFile('b.pdf');
    const { result } = renderHook(() => useFileSelection([fileA, fileB], 'loc-1'));

    act(() => result.current.toggleAll());
    expect(result.current.allSelected).toBe(true);
    expect(result.current.selectedCount).toBe(2);

    act(() => result.current.toggleAll());
    expect(result.current.selectedCount).toBe(0);
  });

  it('clears the selection when the location changes', () => {
    const fileA = makeFile('a.pdf');
    const { result, rerender } = renderHook(
      ({ files, locationKey }: { files: FileInfo[]; locationKey: string }) =>
        useFileSelection(files, locationKey),
      { initialProps: { files: [fileA], locationKey: 'loc-1' } },
    );

    act(() => result.current.toggle(fileA));
    expect(result.current.selectedCount).toBe(1);

    rerender({ files: [fileA], locationKey: 'loc-2' });
    expect(result.current.selectedCount).toBe(0);
  });

  it('does not let a later row phantom-select itself by taking a freed name', () => {
    // The user selects "draft.pdf". It is deleted, and a completely different
    // document is later uploaded under the same name.
    const original = makeFile('draft.pdf');
    const { result, rerender } = renderHook(
      ({ files }: { files: FileInfo[] }) => useFileSelection(files, 'loc-1'),
      { initialProps: { files: [original] } },
    );

    act(() => result.current.toggle(original));
    expect(result.current.selectedIds.has(original.id)).toBe(true);

    // The delete resolves and the browser reloads the folder. No navigation
    // happened, so locationKey is unchanged and only the row list moved.
    rerender({ files: [] });
    expect(result.current.selectedCount).toBe(0);

    // The new document takes the freed NAME but has its own id. It was never
    // selected and must not come back pre-selected, and would have under the
    // old path-keyed selection.
    const sameName = makeFile('draft.pdf');
    rerender({ files: [sameName] });

    expect(result.current.selectedIds.has(sameName.id)).toBe(false);
    expect(result.current.selectedItems).toEqual([]);
    expect(result.current.selectedCount).toBe(0);
    expect(result.current.allSelected).toBe(false);
  });
});
